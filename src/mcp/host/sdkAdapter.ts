// The only file that knows both the tool catalog and the MCP SDK. Keeping the
// boundary here is what makes the documented fallback to SDK 1.30.0 a small
// change rather than a rewrite.

import { SERVER_NAME, SERVER_TITLE, serverInstructions } from '../core/catalog';
import { McpToolError, toToolError } from '../core/errors';
import { logSafe } from '../core/redact';
import { AuditBag, FORWARDED_CLIENT_META_KEY, ToolHandler, ToolMeta } from '../core/toolSpec';
import { AuditEntry } from './auditLog';
import { LoadedSdk } from './sdkLoader';

export interface RegisteredTool<D> {
  meta: ToolMeta;
  handler: ToolHandler<D>;
}

export interface BuildServerOptions<D> {
  sdk: LoadedSdk;
  version: string;
  tools: readonly RegisteredTool<D>[];
  deps: D;
  /** Called for every call, for the audit log. */
  onCall?(event: AuditEntry): void;
}

const CLIENT_INFO_KEY = 'io.modelcontextprotocol/clientInfo';

/** Agent-supplied text ends up in a terminal header and the audit log. */
function cleanLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 64);
  return cleaned || undefined;
}

/**
 * Who is calling. The bridge forwards the agent's own identity in `_meta`,
 * because the envelope only names the bridge. A client that connects directly
 * in the 2026 era is named by its envelope.
 */
export function callerOf(request: { _meta?: unknown; envelope?: unknown } | undefined): { name?: string; version?: string; instance?: string } {
  const meta = request?._meta as Record<string, unknown> | undefined;
  const envelope = request?.envelope as Record<string, unknown> | undefined;
  const info = (meta?.[FORWARDED_CLIENT_META_KEY] ?? envelope?.[CLIENT_INFO_KEY] ?? meta?.[CLIENT_INFO_KEY]) as
    { name?: unknown; version?: unknown; instance?: unknown } | undefined;
  return { name: cleanLabel(info?.name), version: cleanLabel(info?.version), instance: cleanLabel(info?.instance) };
}

/** Text content plus structuredContent, which is what every client understands. */
function ok(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value ?? {}) }],
    structuredContent: (value ?? {}) as Record<string, unknown>,
  };
}

function fail(error: McpToolError) {
  const body = { error: error.toBody() };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body) }],
    isError: true as const,
  };
}

/**
 * Build a fresh McpServer. `createMcpHandler` calls its factory once per HTTP
 * request, so this must stay cheap and all real state must be closed over.
 */
export function buildMcpServer<D>(options: BuildServerOptions<D>) {
  const { McpServer } = options.sdk.server;
  const server = new McpServer(
    { name: SERVER_NAME, title: SERVER_TITLE, version: options.version },
    {
      capabilities: { tools: { listChanged: true } },
      // Only the tools this window serves, so a hidden one is never named.
      instructions: serverInstructions(options.tools.map(tool => tool.meta.name)),
    },
  );

  for (const { meta, handler } of options.tools) {
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: meta.inputSchema,
        ...(meta.outputSchema ? { outputSchema: meta.outputSchema } : {}),
        annotations: meta.annotations,
        ...(meta.maxResultChars
          ? { _meta: { 'anthropic/maxResultSizeChars': meta.maxResultChars } }
          : {}),
      },
      async (args: unknown, ctx: unknown) => {
        const started = Date.now();
        const request = (ctx as { mcpReq?: Record<string, unknown> } | undefined)?.mcpReq;
        const clientInfo = callerOf(request);
        const progressToken = (request?._meta as Record<string, unknown> | undefined)?.progressToken;

        const audit: AuditBag = {};
        const callArgs = (args ?? {}) as Record<string, unknown>;
        const record = (entry: Pick<AuditEntry, 'ok' | 'error'>) => options.onCall?.({
          tool: meta.name, client: clientInfo.name, ms: Date.now() - started, args: callArgs,
          confirmation: audit.confirmation, confirmCategory: audit.confirmCategory, jobId: audit.jobId, target: audit.target,
          ...entry,
        });
        try {
          const value = await handler(callArgs, {
            signal: (request?.signal as AbortSignal) ?? new AbortController().signal,
            client: clientInfo,
            deps: options.deps,
            tool: meta,
            startedAt: started,
            audit,
            progress: report => {
              if (progressToken === undefined || typeof request?.notify !== 'function') {
                return;
              }
              void (request.notify as (n: unknown) => Promise<void>)({
                method: 'notifications/progress',
                params: { progressToken, ...report },
              }).catch(() => undefined);
            },
          });
          record({ ok: true });
          return ok(value);
        } catch (error) {
          const toolError = toToolError(error);
          record({ ok: false, error: `${toolError.code}: ${logSafe(toolError.message)}` });
          return fail(toolError);
        }
      },
    );
  }

  return server;
}
