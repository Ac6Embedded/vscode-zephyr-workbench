// The stdio bridge every agent launches.
//
// Why a bridge at all: agents read their config once at session start, and the
// window's port and token are ephemeral and per window. Putting either in a
// config file would break on every reload. The bridge keeps every config static
// and routes each call to the right window instead.
//
// It always completes the handshake and always answers tools/list, even with no
// VS Code window open, so the agent sees a working server that reports a
// precise reason rather than a failed connection.

// Must be first: this redirects console output away from stdout, which is the
// JSON-RPC channel.
import './stdoutGuard';

import { randomUUID } from 'crypto';
import { SERVER_NAME, SERVER_TITLE, serverInstructions, TOOL_CATALOG } from '../core/catalog';
import { McpToolError } from '../core/errors';
import { getMcpPaths } from '../core/paths';
import { endpointOf, isListening, WINDOW_ID_PATTERN, WindowRecord } from '../core/registry';
import { routeOfCall } from '../core/routing';
import { FORWARDED_CLIENT_META_KEY, ToolMeta } from '../core/toolSpec';
import { classifyUpstreamError } from './classify';
import { BridgeLog } from './log';
import { orPersistedJob } from './persistedJobs';
import { ConnectionPool } from './pool';
import { anySignal, CALL_ID_META_KEY, StreamWatch } from './streamWatch';
import {
  advertisedToolNames, BridgeOptions, liveRecords, readinessOf, readOptions, ResolveOptions, resolveWindowPatiently, wake,
} from './upstream';

// Replaced at bundle time with the extension version.
declare const __ZW_BRIDGE_VERSION__: string | undefined;
const VERSION = typeof __ZW_BRIDGE_VERSION__ === 'string' ? __ZW_BRIDGE_VERSION__ : '0.0.0-dev';

/** A call with no answer and no progress for this long is given up on. */
const CALL_IDLE_TIMEOUT_MS = 10 * 60_000;
/** A hard ceiling, above the longest wait_sec (1500 s) plus the build's own wrap-up. */
const CALL_MAX_TIMEOUT_MS = 30 * 60_000;
/** Per window, for a merged read across every window. */
const FAN_OUT_TIMEOUT_MS = 60_000;
const CLIENT_INFO_KEY = 'io.modelcontextprotocol/clientInfo';

/** A job id starts with the id of the window that ran it: `<windowId>.<kind>-<suffix>`. */
function jobWindowOf(args: Record<string, unknown> | undefined): string | undefined {
  const jobId = args?.job_id;
  if (typeof jobId !== 'string') {
    return undefined;
  }
  const windowId = jobId.split('.')[0];
  return jobId.includes('.') && WINDOW_ID_PATTERN.test(windowId) ? windowId : undefined;
}

function failure(error: McpToolError) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: error.toBody() }) }],
    isError: true as const,
  };
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface RequestContext {
  mcpReq?: {
    signal?: AbortSignal;
    _meta?: Record<string, unknown>;
    envelope?: Record<string, unknown>;
    notify?(notification: unknown): Promise<void>;
  };
}

async function main(): Promise<void> {
  const options: BridgeOptions = readOptions(process.argv.slice(2));
  const paths = getMcpPaths(options.home);
  const log = new BridgeLog(`${paths.logsDir}/bridge.log`);
  log.debug(`starting ${VERSION}, workspace=${options.workspace ?? ''} routing=${options.routing}`);

  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const { McpServer } = await import('@modelcontextprotocol/server');
  const { serveStdio } = await import('@modelcontextprotocol/server/stdio');

  type UpstreamClient = InstanceType<typeof Client>;
  type Server = InstanceType<typeof McpServer>;
  type Registered = ReturnType<Server['registerTool']>;

  const streams = new StreamWatch();
  const pool = new ConnectionPool<UpstreamClient>(async record => {
    const client = new Client({ name: 'zephyr-workbench-bridge', version: VERSION }, {
      // The SDK defaults to the legacy era; `auto` is required so the bridge
      // works whether the host speaks the 2025 or the 2026 protocol.
      versionNegotiation: { mode: 'auto' },
    });
    const transport = new StreamableHTTPClientTransport(new URL(endpointOf(record).mcp), {
      requestInit: { headers: { Authorization: `Bearer ${record.token}` } },
      fetch: streams.wrap(globalThis.fetch.bind(globalThis)),
    });
    await client.connect(transport);
    log.info(`connected to window ${record.windowId} on port ${record.port}`);
    return client;
  });

  // Tools are all registered once; the advertised set follows what the live
  // windows publish, so an agent does not see tools the user switched off.
  const registered = new Map<string, Registered>();
  let advertisedKey: string | undefined;
  const syncTools = (records: WindowRecord[]) => {
    if (records.length === 0) {
      // Keep the last known list while no window is up, such as mid-reload,
      // rather than flapping to the full catalog and back.
      return;
    }
    const names = advertisedToolNames(records);
    const key = names ? [...names].sort().join(',') : '*';
    if (key === advertisedKey) {
      return;
    }
    advertisedKey = key;
    for (const [name, tool] of registered) {
      const wanted = !names || names.has(name);
      if (wanted !== tool.enabled) {
        try {
          if (wanted) {
            tool.enable();
          } else {
            tool.disable();
          }
        } catch (error) {
          log.debug(`could not update tool ${name}: ${messageOf(error)}`);
        }
      }
    }
  };

  /** The window for one call, woken if it is dormant. */
  const resolveUpstream = async (route: Omit<ResolveOptions, 'isKnownGood'>): Promise<WindowRecord | McpToolError> => {
    const resolution = await resolveWindowPatiently(options, log, {
      ...route,
      isKnownGood: record => pool.isKnownGood(record),
    });
    syncTools(resolution.records);
    if (!resolution.record) {
      return resolution.problem ?? new McpToolError('WORKBENCH_NOT_RUNNING', 'No VS Code window is available.');
    }
    if (isListening(resolution.record)) {
      return resolution.record;
    }
    const woken = await wake(resolution.record, options, log);
    return woken ?? new McpToolError('WORKBENCH_NOT_RUNNING', 'The VS Code window did not start its MCP server in time.', {
      hint: 'Check that zephyr-workbench.mcp.enabled is not "off", or start the server from the AI Manager in VS Code, then retry.',
    });
  };

  const agentOf = (server: Server, ctx: RequestContext) =>
    (ctx.mcpReq?.envelope?.[CLIENT_INFO_KEY] as { name?: string; version?: string } | undefined)
      ?? server.server.getClientVersion();
  // One id per bridge process, which is one agent session: what an approval
  // "for this session" in VS Code is tied to.
  const instance = randomUUID();
  const forwardedMeta = (agent: { name?: string; version?: string } | undefined) =>
    ({ [FORWARDED_CLIENT_META_KEY]: { name: agent?.name, version: agent?.version, instance } });

  /**
   * `all_windows`: ask every running window and merge the answers. Only for
   * read-only tools. A dormant window is listed, not started, because a
   * status question should not open a listener in every window.
   */
  const fanOut = async (server: Server, meta: ToolMeta, args: Record<string, unknown>, ctx: RequestContext) => {
    const records = liveRecords(options);
    syncTools(records);
    const rest = { ...args };
    delete rest.all_windows;
    const windows = await Promise.all(records.map(async record => {
      const base = { window_id: record.windowId, workspace_folders: record.workspaceFolders };
      const state = await readinessOf(record, known => pool.isKnownGood(known));
      if (state === 'dormant') {
        return {
          ...base, state,
          note: 'Its MCP server is not started. Call again without all_windows, with an app_path from that window, to start it.',
        };
      }
      if (state !== 'ready') {
        return { ...base, state: state === 'foreign' ? 'unreachable' : state };
      }
      let lease: Awaited<ReturnType<typeof pool.acquire>> | undefined;
      try {
        lease = await pool.acquire(record);
        const result = await lease.client.callTool(
          { name: meta.name, arguments: rest, _meta: forwardedMeta(agentOf(server, ctx)) },
          { signal: ctx.mcpReq?.signal, timeout: FAN_OUT_TIMEOUT_MS },
        ) as { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] };
        const text = result.content?.find(item => item.type === 'text')?.text;
        const body = result.structuredContent ?? (text ? JSON.parse(text) : undefined);
        return result.isError ? { ...base, state: 'error', ...(body as object) } : { ...base, state: 'ok', result: body };
      } catch (error) {
        const kind = classifyUpstreamError(error);
        if (lease && (kind === 'not-delivered' || kind === 'interrupted')) {
          pool.drop(record.windowId, lease.client);
        }
        return { ...base, state: 'error', error: messageOf(error) };
      } finally {
        lease?.release();
      }
    }));
    const value = { windows };
    return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value };
  };

  const forward = async (server: Server, meta: ToolMeta, args: Record<string, unknown>, ctx: RequestContext) => {
    const request = ctx.mcpReq;
    const signal = request?.signal;
    // Reading a job's status or log is harmless wherever it lands; only
    // cancel changes anything.
    const readOnly = meta.annotations.readOnlyHint === true || (meta.name === 'job' && args.action !== 'cancel');
    // Acting on the machine, such as installing a toolchain: with no folder
    // named, any window can serve it.
    const { target, machineScope, routeBy } = routeOfCall(meta, args);
    const progressToken = request?._meta?.progressToken;
    const agent = agentOf(server, ctx);
    // A job lives in the window that ran it; no other window can answer for it.
    const jobWindow = jobWindowOf(args);
    let lockTo = jobWindow;

    // Two attempts at most. The second only happens when the first provably
    // did not run the tool, or when the tool is read-only, and it goes back to
    // the same window: a retry must never land somewhere else.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const record = await resolveUpstream({
        target, readOnly, machineScope, routeBy, lockTo,
        jobId: attempt === 1 && jobWindow ? String(args.job_id) : undefined,
      });
      if (record instanceof McpToolError) {
        return failure(record);
      }
      lockTo = record.windowId;

      let lease: Awaited<ReturnType<typeof pool.acquire>>;
      try {
        lease = await pool.acquire(record);
      } catch (error) {
        log.debug(`connect to ${record.windowId} failed: ${messageOf(error)}`);
        if (attempt === 1 && !signal?.aborted) {
          continue;
        }
        return failure(new McpToolError('WORKBENCH_NOT_RUNNING', `Could not connect to the VS Code window: ${messageOf(error)}`, {
          hint: 'The window may be reloading. Retry in a few seconds.',
        }));
      }

      // Aborted when the window's answer stream ends without the answer,
      // which is how a reload or crash in the middle of a call shows up.
      const callId = randomUUID();
      const lost = new AbortController();
      const unwatch = streams.watch(callId, () => lost.abort());
      try {
        return await lease.client.callTool({
          name: meta.name,
          arguments: args,
          _meta: { ...forwardedMeta(agent), [CALL_ID_META_KEY]: callId },
        }, {
          signal: anySignal([signal, lost.signal]),
          timeout: CALL_IDLE_TIMEOUT_MS,
          maxTotalTimeout: CALL_MAX_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
          onprogress: progress => {
            if (progressToken === undefined || typeof request?.notify !== 'function') {
              return;
            }
            void request.notify({
              method: 'notifications/progress',
              params: { ...progress, progressToken },
            }).catch(() => undefined);
          },
        });
      } catch (error) {
        if (signal?.aborted) {
          // The agent cancelled. Nothing to retry and nobody to answer.
          throw error;
        }
        const kind = lost.signal.aborted ? 'interrupted' : classifyUpstreamError(error);
        log.debug(`call ${meta.name} to ${record.windowId} failed (${kind}): ${messageOf(error)}`);
        switch (kind) {
          case 'tool-missing':
            return failure(new McpToolError('TOOL_DISABLED', `The VS Code window does not offer ${meta.name}.`, {
              hint: 'It is hidden by the zephyr-workbench.mcp.toolset or disabledTools setting in that window. Ask the user to enable it in the AI Manager.',
            }));
          case 'timeout':
            return failure(new McpToolError('TIMEOUT', `${meta.name} did not answer in time.`, {
              hint: 'Call job with action "status" to see whether a job is still running.',
            }));
          case 'not-delivered':
            pool.drop(record.windowId, lease.client);
            if (attempt === 1) {
              continue;
            }
            return failure(new McpToolError('WORKBENCH_NOT_RUNNING', `The VS Code window refused the call: ${messageOf(error)}`, {
              hint: 'The window may be reloading. Retry in a few seconds.',
            }));
          case 'interrupted':
            pool.drop(record.windowId, lease.client);
            if (readOnly && attempt === 1) {
              continue;
            }
            return failure(new McpToolError('WORKBENCH_NOT_RUNNING', `The VS Code window stopped answering during ${meta.name}.`, {
              hint: 'The window may have reloaded. Call job with action "status" to check whether the action ran before retrying it.',
            }));
          default:
            return failure(new McpToolError('INTERNAL', messageOf(error)));
        }
      } finally {
        unwatch();
        lease.release();
      }
    }
    return failure(new McpToolError('WORKBENCH_NOT_RUNNING', 'No VS Code window answered.'));
  };

  const callTool = async (server: Server, meta: ToolMeta, args: Record<string, unknown>, ctx: RequestContext) => {
    if (args.all_windows === true && meta.annotations.readOnlyHint === true) {
      return fanOut(server, meta, args, ctx);
    }
    const result = await forward(server, meta, args, ctx);
    // The window that ran the job may be gone or restarted, which forgets
    // every job; a finished one left its result on disk.
    return meta.name === 'job' && jobWindowOf(args) ? orPersistedJob(paths, args, result, line => log.debug(line)) : result;
  };

  // Show only what the windows already publish from the very first
  // tools/list, without waiting for a call.
  const initialNames = advertisedToolNames(liveRecords(options));

  const handle = serveStdio(() => {
    const server = new McpServer(
      { name: SERVER_NAME, title: SERVER_TITLE, version: VERSION },
      {
        capabilities: { tools: { listChanged: true } },
        // The tools the windows publish, so a tool the user hid is never named.
        instructions: serverInstructions(initialNames ?? TOOL_CATALOG.map(tool => tool.name)),
      },
    );
    registered.clear();
    for (const meta of TOOL_CATALOG) {
      const tool = server.registerTool(meta.name, {
        title: meta.title,
        description: meta.description,
        inputSchema: meta.inputSchema,
        annotations: meta.annotations,
        ...(meta.maxResultChars ? { _meta: { 'anthropic/maxResultSizeChars': meta.maxResultChars } } : {}),
      }, (args: Record<string, unknown>, ctx: unknown) => callTool(server, meta, args ?? {}, (ctx ?? {}) as RequestContext));
      if (initialNames && !initialNames.has(meta.name)) {
        tool.disable();
      }
      registered.set(meta.name, tool);
    }
    advertisedKey = initialNames ? [...initialNames].sort().join(',') : '*';
    return server;
  }, { legacy: 'serve' });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    // Bounded: a hung upstream must not keep the agent waiting on exit.
    const exit = setTimeout(() => process.exit(0), 1000);
    void Promise.allSettled([pool.closeAll(), handle.close()]).finally(() => {
      clearTimeout(exit);
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Exit promptly when the host closes the pipe, as the spec requires.
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
}

main().catch(error => {
  process.stderr.write(`[zephyr-workbench-mcp] fatal ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
