// End to end: the built stdio bridge finds a window through its record, passes
// the HTTP guards, reaches the real SDK handler, and returns a real tool result.
// Only the tool bodies are stubbed, because they need a running VS Code; every
// hop between the agent and a tool body is the production code.
//
// Needs `out/bridge.cjs`, so it skips itself when the extension is not built.

import { strict as assert } from 'assert';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TOOL_CATALOG } from '../../../mcp/core/catalog';
import { getMcpPaths } from '../../../mcp/core/paths';
import { markOwnWindowRecordClosing, writeWindowRecord, WindowRecord } from '../../../mcp/core/registry';
import { ToolHandler } from '../../../mcp/core/toolSpec';
import { startHttpServer, RunningServer } from '../../../mcp/host/httpServer';
import { buildMcpServer } from '../../../mcp/host/sdkAdapter';
import { loadSdk } from '../../../mcp/host/sdkLoader';
import { McpToolError } from '../../../mcp/core/errors';

const BRIDGE = path.resolve(__dirname, '../../../../out/bridge.cjs');

interface Host {
  server: RunningServer;
  close(): Promise<void>;
  calls: string[];
}

async function startHost(handlers: Record<string, ToolHandler<unknown>>, windowId = 'e2e-window'): Promise<Host> {
  const sdk = await loadSdk();
  const calls: string[] = [];
  const tools = TOOL_CATALOG
    .filter(meta => handlers[meta.name])
    .map(meta => ({ meta, handler: handlers[meta.name] }));
  const handler = sdk.server.createMcpHandler(
    () => buildMcpServer({ sdk, version: 'test', tools, deps: {}, onCall: e => calls.push(e.tool) }),
    { legacy: 'stateless', responseMode: 'auto' },
  );
  const server = await startHttpServer({
    fetch: request => handler.fetch(request, {}),
    health: () => ({ windowId }),
    log: () => undefined,
  });
  return {
    server,
    calls,
    close: async () => { await handler.close(); await server.close(); },
  };
}

function record(home: string, over: Partial<WindowRecord>): void {
  writeWindowRecord(getMcpPaths(home), {
    schema: 1,
    windowId: 'e2e-window',
    pid: process.pid,
    platform: process.platform,
    hostname: os.hostname(),
    workspaceFolders: ['/e2e/ws'],
    appRoots: ['/e2e/ws/app'],
    westWorkspaces: [],
    ide: { name: 'test', version: '0', uriScheme: 'vscode' },
    nodeExecPath: process.execPath,
    extensionVersion: 'test',
    catalogVersion: '1',
    startedAt: new Date().toISOString(),
    focusedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    ...over,
  });
}

/** A tiny line-oriented JSON-RPC client over the bridge's stdio. */
class BridgeClient {
  private buffer = '';
  private readonly waiting = new Map<number, (message: Record<string, unknown>) => void>();
  readonly notifications: Record<string, unknown>[] = [];
  private nextId = 1;

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) { continue; }
        const message = JSON.parse(line) as Record<string, unknown>;
        if (typeof message.id === 'number' && this.waiting.has(message.id)) {
          this.waiting.get(message.id)?.(message);
          this.waiting.delete(message.id);
        } else {
          this.notifications.push(message);
        }
      }
    });
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      this.waiting.set(id, message => { clearTimeout(timer); resolve(message); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async handshake(): Promise<Record<string, unknown>> {
    const reply = await this.request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' },
    });
    this.notify('notifications/initialized');
    return reply;
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

function toolNames(reply: Record<string, unknown>): string[] {
  return ((reply.result as { tools: { name: string }[] }).tools ?? []).map(t => t.name).sort();
}

function errorCode(reply: Record<string, unknown>): string | undefined {
  if ((reply.result as { isError?: boolean } | undefined)?.isError !== true) {
    return undefined;
  }
  return (parseText(reply).error as { code?: string } | undefined)?.code;
}

function spawnBridge(home: string, workspace: string): BridgeClient {
  const child = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, ZW_MCP_HOME: home, ZW_MCP_WORKSPACE: workspace },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new BridgeClient(child);
}

function parseText(result: Record<string, unknown>): Record<string, unknown> {
  const content = (result.result as { content?: { text: string }[] })?.content ?? [];
  return JSON.parse(content[0]?.text ?? '{}');
}

describe('mcp end to end: agent, bridge, HTTP guards, SDK, tool', function () {
  this.timeout(30000);

  before(function () {
    if (!fs.existsSync(BRIDGE)) {
      this.skip();
    }
  });

  it('routes a tool call through the bridge to the right window and back', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-e2e-'));
    const host = await startHost({
      list_apps: async () => ({ apps: [{ app_path: '/e2e/ws/app', name: 'app', configs: [] }] }),
    });
    record(home, { port: host.server.port, url: host.server.url, token: host.server.token });
    const bridge = spawnBridge(home, '/e2e/ws/app');
    try {
      const init = await bridge.handshake();
      assert.equal((init.result as { serverInfo: { name: string } }).serverInfo.name, 'zephyr-workbench');

      const reply = await bridge.request('tools/call', { name: 'list_apps', arguments: {} });
      const body = parseText(reply);
      assert.deepEqual((body.apps as { app_path: string }[]).map(a => a.app_path), ['/e2e/ws/app']);
      assert.deepEqual(host.calls, ['list_apps'], 'the call must have reached the host handler');
    } finally {
      bridge.close();
      await host.close();
    }
  });

  it('carries a structured tool error from the host back to the agent', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-e2e-'));
    const host = await startHost({
      get_build_info: async () => {
        throw new McpToolError('NOT_BUILT', 'nothing built yet', { hint: 'Call build_app first.' });
      },
    });
    record(home, { port: host.server.port, url: host.server.url, token: host.server.token });
    const bridge = spawnBridge(home, '/e2e/ws/app');
    try {
      await bridge.handshake();
      const reply = await bridge.request('tools/call', { name: 'get_build_info', arguments: {} });
      assert.equal((reply.result as { isError?: boolean }).isError, true);
      const error = parseText(reply).error as { code: string; hint: string };
      assert.equal(error.code, 'NOT_BUILT');
      assert.equal(error.hint, 'Call build_app first.');
    } finally {
      bridge.close();
      await host.close();
    }
  });

  it('refuses a window whose token does not match, rather than trusting the record', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-e2e-'));
    const host = await startHost({ list_apps: async () => ({ apps: [] }) });
    // A stale or forged record: right port, wrong token.
    record(home, { port: host.server.port, url: host.server.url, token: 'not-the-token' });
    const bridge = spawnBridge(home, '/e2e/ws/app');
    try {
      await bridge.handshake();
      // The bridge waits about five seconds for a window that might be reloading.
      const reply = await bridge.request('tools/call', { name: 'list_apps', arguments: {} }, 25000);
      assert.equal((reply.result as { isError?: boolean }).isError, true);
      assert.equal((parseText(reply).error as { code: string }).code, 'WORKBENCH_NOT_RUNNING');
      assert.deepEqual(host.calls, [], 'no call may reach the host with a bad token');
    } finally {
      bridge.close();
      await host.close();
    }
  });

  it('wakes a dormant window, which is how auto mode serves a hand-configured agent', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-e2e-'));
    const paths = getMcpPaths(home);
    // Dormant: published, but no port and no token.
    record(home, {});
    let host: Host | undefined;
    // Play the part of the extension: watch for the wake marker, then listen.
    const watcher = setInterval(async () => {
      if (host || !fs.existsSync(paths.wakeMarker('e2e-window'))) { return; }
      fs.unlinkSync(paths.wakeMarker('e2e-window'));
      host = await startHost({ list_apps: async () => ({ apps: [{ app_path: '/e2e/ws/app' }] }) });
      record(home, { port: host.server.port, url: host.server.url, token: host.server.token });
    }, 100);
    const bridge = spawnBridge(home, '/e2e/ws/app');
    try {
      await bridge.handshake();
      const reply = await bridge.request('tools/call', { name: 'list_apps', arguments: {} }, 20000);
      assert.notEqual((reply.result as { isError?: boolean }).isError, true, JSON.stringify(reply));
      assert.ok(host, 'the bridge must have written a wake marker');
    } finally {
      clearInterval(watcher);
      bridge.close();
      await host?.close();
    }
  });

  it('reconnects after the window restarts on a new port and token', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-e2e-'));
    let host = await startHost({ get_status: async () => ({ generation: 1 }) });
    record(home, { port: host.server.port, url: host.server.url, token: host.server.token });
    const bridge = spawnBridge(home, '/e2e/ws/app');
    try {
      await bridge.handshake();
      assert.equal(parseText(await bridge.request('tools/call', { name: 'get_status', arguments: {} })).generation, 1);

      // A window reload: new server, new port, new token, rewritten record.
      await host.close();
      host = await startHost({ get_status: async () => ({ generation: 2 }) });
      record(home, { port: host.server.port, url: host.server.url, token: host.server.token });

      // get_status is read-only, so the bridge may reconnect and retry it.
      const second = parseText(await bridge.request('tools/call', { name: 'get_status', arguments: {} }));
      assert.equal(second.generation, 2, 'the agent should not need to restart after a window reload');
    } finally {
      bridge.close();
      await host.close();
    }
  });

  it('keeps one connection per window and routes each call by its app_path', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-e2e-'));
    const hostA = await startHost({ list_apps: async () => ({ window: 'A' }) }, 'window-a');
    const hostB = await startHost({ list_apps: async () => ({ window: 'B' }) }, 'window-b');
    record(home, {
      windowId: 'window-a', port: hostA.server.port, token: hostA.server.token,
      workspaceFolders: ['/e2e/a'], appRoots: ['/e2e/a/app'],
    });
    record(home, {
      windowId: 'window-b', port: hostB.server.port, token: hostB.server.token,
      workspaceFolders: ['/e2e/b'], appRoots: ['/e2e/b/app'],
    });
    const bridge = spawnBridge(home, '/e2e/a');
    try {
      await bridge.handshake();
      const call = async (args: Record<string, unknown>) =>
        parseText(await bridge.request('tools/call', { name: 'list_apps', arguments: args })).window;
      assert.equal(await call({}), 'A', 'no path: the agent working directory decides');
      assert.equal(await call({ app_path: '/e2e/b/app' }), 'B', 'a path argument routes to the window that owns it');
      assert.equal(await call({}), 'A', 'window A must still be connected after a call to B');
    } finally {
      bridge.close();
      await hostA.close();
      await hostB.close();
    }
  });

  it('never routes a build by focus when the agent is above several windows', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-e2e-'));
    let builds = 0;
    const hostA = await startHost({ list_apps: async () => ({ window: 'A' }), build_app: async () => { builds++; return {}; } }, 'window-a');
    const hostB = await startHost({ list_apps: async () => ({ window: 'B' }), build_app: async () => { builds++; return {}; } }, 'window-b');
    record(home, { windowId: 'window-a', port: hostA.server.port, token: hostA.server.token, workspaceFolders: ['/e2e/root/a'], appRoots: [] });
    record(home, { windowId: 'window-b', port: hostB.server.port, token: hostB.server.token, workspaceFolders: ['/e2e/root/b'], appRoots: [] });
    const bridge = spawnBridge(home, '/e2e/root');
    try {
      await bridge.handshake();
      const read = await bridge.request('tools/call', { name: 'list_apps', arguments: {} });
      assert.equal(errorCode(read), undefined, 'a read may fall back to the focused window');
      const build = await bridge.request('tools/call', { name: 'build_app', arguments: {} });
      assert.equal(errorCode(build), 'AMBIGUOUS_WINDOW');
      assert.equal(builds, 0, 'no window may have been asked to build');
    } finally {
      bridge.close();
      await hostA.close();
      await hostB.close();
    }
  });

  it('does not repeat a build when the window drops the connection during it', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-e2e-'));
    let builds = 0;
    const host: Host = await startHost({
      build_app: async () => {
        builds++;
        // The window reloads mid-build: every connection is cut.
        setTimeout(() => void host.close(), 50);
        return new Promise(() => undefined);
      },
    });
    record(home, { port: host.server.port, token: host.server.token });
    const bridge = spawnBridge(home, '/e2e/ws/app');
    try {
      await bridge.handshake();
      const reply = await bridge.request('tools/call', { name: 'build_app', arguments: {} }, 20000);
      assert.equal(errorCode(reply), 'WORKBENCH_NOT_RUNNING');
      assert.match(JSON.stringify(parseText(reply)), /job/, 'the hint must point at the job tool');
      assert.equal(builds, 1, 'a build that may have started must never be sent twice');
    } finally {
      bridge.close();
    }
  });

  it('advertises only the tools the window publishes', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-e2e-'));
    const host = await startHost({ get_status: async () => ({}), list_apps: async () => ({}) });
    record(home, { port: host.server.port, token: host.server.token, tools: ['get_status', 'list_apps'] });
    const bridge = spawnBridge(home, '/e2e/ws/app');
    try {
      await bridge.handshake();
      assert.deepEqual(toolNames(await bridge.request('tools/list')), ['get_status', 'list_apps']);
    } finally {
      bridge.close();
      await host.close();
    }
  });

  it('answers TOOL_DISABLED when the window hides a tool the bridge still lists', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-e2e-'));
    const host = await startHost({ list_apps: async () => ({}) });
    // An older window that does not publish its tool list.
    record(home, { port: host.server.port, token: host.server.token });
    const bridge = spawnBridge(home, '/e2e/ws/app');
    try {
      await bridge.handshake();
      const reply = await bridge.request('tools/call', { name: 'build_app', arguments: {} });
      assert.equal(errorCode(reply), 'TOOL_DISABLED');
      assert.equal((parseText(reply).error as { retryable: boolean }).retryable, false);
    } finally {
      bridge.close();
      await host.close();
    }
  });

  it('tells the window which agent is calling, not just "the bridge"', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-e2e-'));
    const host = await startHost({ get_status: async (_args, ctx) => ({ caller: ctx.client.name }) });
    record(home, { port: host.server.port, token: host.server.token });
    const bridge = spawnBridge(home, '/e2e/ws/app');
    try {
      await bridge.handshake();
      const reply = await bridge.request('tools/call', { name: 'get_status', arguments: {} });
      assert.equal(parseText(reply).caller, 'e2e');
    } finally {
      bridge.close();
      await host.close();
    }
  });

  it('merges a read across every window when asked, without starting dormant ones', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-e2e-'));
    const hostA = await startHost({ get_status: async args => ({ window: 'A', saw_all_windows: 'all_windows' in args }) }, 'window-a');
    const hostB = await startHost({ get_status: async () => ({ window: 'B' }) }, 'window-b');
    record(home, { windowId: 'window-a', port: hostA.server.port, token: hostA.server.token, workspaceFolders: ['/e2e/a'] });
    record(home, { windowId: 'window-b', port: hostB.server.port, token: hostB.server.token, workspaceFolders: ['/e2e/b'] });
    record(home, { windowId: 'window-c', workspaceFolders: ['/e2e/c'] });
    const bridge = spawnBridge(home, '/e2e/a');
    try {
      await bridge.handshake();
      const reply = await bridge.request('tools/call', { name: 'get_status', arguments: { all_windows: true } });
      const windows = (parseText(reply).windows as { window_id: string; state: string; result?: Record<string, unknown> }[])
        .sort((x, y) => x.window_id.localeCompare(y.window_id));
      assert.deepEqual(windows.map(w => [w.window_id, w.state]), [['window-a', 'ok'], ['window-b', 'ok'], ['window-c', 'dormant']]);
      assert.equal(windows[0].result?.window, 'A');
      assert.equal(windows[0].result?.saw_all_windows, false, 'each window answers for itself only');
      assert.ok(!fs.existsSync(getMcpPaths(home).wakeMarker('window-c')), 'a dormant window must not be woken');
    } finally {
      bridge.close();
      await hostA.close();
      await hostB.close();
    }
  });

  it('answers quickly when the window stops in the middle of a call that already sent progress', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-e2e-'));
    let builds = 0;
    const host: Host = await startHost({
      build_app: async (_args, ctx) => {
        builds++;
        // One heartbeat turns the answer into an event stream, then the window goes away.
        setTimeout(() => ctx.progress({ progress: 1, message: '[1/10] Building' }), 100);
        setTimeout(() => void host.close(), 800);
        return new Promise(() => undefined);
      },
    });
    record(home, { port: host.server.port, token: host.server.token });
    const bridge = spawnBridge(home, '/e2e/ws/app');
    try {
      await bridge.handshake();
      const started = Date.now();
      const reply = await bridge.request('tools/call', { name: 'build_app', arguments: {} }, 20000);
      assert.ok(Date.now() - started < 12000, 'the agent must not wait for the full request timeout');
      assert.equal(errorCode(reply), 'WORKBENCH_NOT_RUNNING');
      assert.equal(builds, 1, 'a build that may have started must never be sent twice');
    } finally {
      bridge.close();
    }
  });

  it('sends a job call to the window that owns the job, wherever the agent runs', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-e2e-'));
    const hostA = await startHost({ job: async args => ({ window: 'A', job_id: args.job_id }) }, 'window-a');
    const hostB = await startHost({ job: async args => ({ window: 'B', job_id: args.job_id }) }, 'window-b');
    record(home, { windowId: 'window-a', port: hostA.server.port, token: hostA.server.token, workspaceFolders: ['/e2e/a'], appRoots: [] });
    record(home, { windowId: 'window-b', port: hostB.server.port, token: hostB.server.token, workspaceFolders: ['/e2e/b'], appRoots: [] });
    const bridge = spawnBridge(home, '/e2e/a');
    try {
      await bridge.handshake();
      const reply = await bridge.request('tools/call', { name: 'job', arguments: { action: 'status', job_id: 'window-b.build-1-abcdef' } });
      assert.equal(parseText(reply).window, 'B');
      const gone = await bridge.request('tools/call', { name: 'job', arguments: { action: 'status', job_id: 'window-z.build-1-abcdef' } }, 20000);
      assert.equal(errorCode(gone), 'JOB_NOT_FOUND', 'a job of a closed window must never be answered by another window');
    } finally {
      bridge.close();
      await hostA.close();
      await hostB.close();
    }
  });

  it('waits for a reloading window instead of building in the only other one', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-e2e-'));
    let bBuilds = 0;
    const hostB = await startHost({ build_app: async () => { bBuilds++; return {}; } }, 'window-b');
    record(home, { windowId: 'window-b', port: hostB.server.port, token: hostB.server.token, workspaceFolders: ['/e2e/b'], appRoots: ['/e2e/b/app'] });
    // Window A was just closed or is reloading: its record says so.
    record(home, { windowId: 'window-a', port: 1, token: 't', workspaceFolders: ['/e2e/a'], appRoots: ['/e2e/a/app'] });
    markOwnWindowRecordClosing(getMcpPaths(home), 'window-a', process.pid);
    const bridge = spawnBridge(home, '/e2e/a');
    let hostA: Host | undefined;
    try {
      await bridge.handshake();
      const stillGone = await bridge.request('tools/call', { name: 'build_app', arguments: {} }, 25000);
      assert.equal(errorCode(stillGone), 'WORKBENCH_NOT_RUNNING');
      assert.equal(bBuilds, 0, 'the build must never run in an unrelated window');

      // The reload completes during the wait: the same window id comes back.
      markOwnWindowRecordClosing(getMcpPaths(home), 'window-a', process.pid);
      let aBuilds = 0;
      setTimeout(async () => {
        hostA = await startHost({ build_app: async () => { aBuilds++; return {}; } }, 'window-a');
        record(home, { windowId: 'window-a', port: hostA.server.port, token: hostA.server.token, workspaceFolders: ['/e2e/a'], appRoots: ['/e2e/a/app'] });
      }, 1500);
      await bridge.request('tools/call', { name: 'build_app', arguments: {} }, 25000);
      assert.equal(aBuilds, 1, 'the call must reach the window once it is back');
      assert.equal(bBuilds, 0);
    } finally {
      bridge.close();
      await hostB.close();
      await hostA?.close();
    }
  });

  it('never routes by a devicetree node path', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-e2e-'));
    const hostA = await startHost({ query_devicetree: async () => ({ window: 'A' }) }, 'window-a');
    const hostB = await startHost({ query_devicetree: async () => ({ window: 'B' }) }, 'window-b');
    const later = new Date(Date.now() + 60_000).toISOString();
    record(home, { windowId: 'window-a', port: hostA.server.port, token: hostA.server.token, workspaceFolders: ['/e2e/a'], appRoots: [] });
    record(home, { windowId: 'window-b', port: hostB.server.port, token: hostB.server.token, workspaceFolders: ['/e2e/b'], appRoots: [], focusedAt: later });
    const bridge = spawnBridge(home, '/e2e/a');
    try {
      await bridge.handshake();
      for (const node of ['/soc/uart@40011000', '/']) {
        const reply = await bridge.request('tools/call', { name: 'query_devicetree', arguments: { path: node } });
        assert.equal(parseText(reply).window, 'A', `${node} must not steer routing away from the agent's own window`);
      }
    } finally {
      bridge.close();
      await hostA.close();
      await hostB.close();
    }
  });

  it('asks for app_path rather than building in the only window when it is unrelated', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-e2e-'));
    let builds = 0;
    const host = await startHost({ build_app: async () => { builds++; return {}; }, list_apps: async () => ({ ok: true }) }, 'window-b');
    record(home, { windowId: 'window-b', port: host.server.port, token: host.server.token, workspaceFolders: ['/e2e/b'], appRoots: ['/e2e/b/app'] });
    const bridge = spawnBridge(home, '/somewhere/else');
    try {
      await bridge.handshake();
      const build = await bridge.request('tools/call', { name: 'build_app', arguments: {} });
      assert.equal(errorCode(build), 'AMBIGUOUS_WINDOW');
      assert.equal(builds, 0);
      const read = await bridge.request('tools/call', { name: 'list_apps', arguments: {} });
      assert.equal(errorCode(read), undefined, 'reads still reach the only window');
      await bridge.request('tools/call', { name: 'build_app', arguments: { app_path: '/e2e/b/app' } });
      assert.equal(builds, 1, 'naming the application routes the build');
    } finally {
      bridge.close();
      await host.close();
    }
  });

  it('sends a machine-wide action to the only window, even from an unrelated folder', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-e2e-'));
    const seen: string[] = [];
    const host = await startHost({
      manage_toolchain: async args => { seen.push(`manage_toolchain:${String(args.action)}`); return { ok: true }; },
      remove_or_delete: async args => { seen.push(`remove_or_delete:${String(args.what)}`); return { ok: true }; },
    }, 'window-b');
    record(home, { windowId: 'window-b', port: host.server.port, token: host.server.token, workspaceFolders: ['/e2e/b'], appRoots: ['/e2e/b/app'] });
    const bridge = spawnBridge(home, '/somewhere/else');
    try {
      await bridge.handshake();
      const install = await bridge.request('tools/call', { name: 'manage_toolchain', arguments: { action: 'install', family: 'zephyr_sdk' } });
      assert.equal(errorCode(install), undefined, 'a toolchain install is not about any folder');
      const unregister = await bridge.request('tools/call', { name: 'remove_or_delete', arguments: { what: 'toolchain', path: '/opt/sdk' } });
      assert.equal(errorCode(unregister), undefined);
      const folder = await bridge.request('tools/call', { name: 'remove_or_delete', arguments: { what: 'build_folder', config_name: 'primary' } });
      assert.equal(errorCode(folder), 'AMBIGUOUS_WINDOW', 'deleting a build folder is about a folder, so it still needs one');
      assert.deepEqual(seen, ['manage_toolchain:install', 'remove_or_delete:toolchain']);
    } finally {
      bridge.close();
      await host.close();
    }
  });

  it('routes a new application by the west workspace it goes into', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-e2e-'));
    const hostA = await startHost({ manage_app: async () => ({ window: 'A' }) }, 'window-a');
    const hostB = await startHost({ manage_app: async () => ({ window: 'B' }) }, 'window-b');
    record(home, { windowId: 'window-a', port: hostA.server.port, token: hostA.server.token, workspaceFolders: ['/e2e/a'], westWorkspaces: ['/e2e/a/zephyrproject'] });
    record(home, { windowId: 'window-b', port: hostB.server.port, token: hostB.server.token, workspaceFolders: ['/e2e/b'], westWorkspaces: ['/e2e/b/zephyrproject'] });
    const bridge = spawnBridge(home, '/somewhere/else');
    try {
      await bridge.handshake();
      const reply = await bridge.request('tools/call', {
        name: 'manage_app', arguments: { action: 'create', west_workspace: '/e2e/b/zephyrproject', template: '/e2e/b/zephyrproject/zephyr/samples/hello_world' },
      });
      assert.equal(parseText(reply).window, 'B');
    } finally {
      bridge.close();
      await hostA.close();
      await hostB.close();
    }
  });

  it('answers a job of a window that restarted from the record the job left', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-e2e-'));
    const paths = getMcpPaths(home);
    const jobId = 'window-z.west-1-abcdef';
    fs.mkdirSync(paths.jobDir('window-z'), { recursive: true });
    fs.writeFileSync(paths.jobLog('window-z', jobId), 'west init\nwest update\ndone\n');
    fs.writeFileSync(paths.jobRecord('window-z', jobId), JSON.stringify({
      job_id: jobId, kind: 'west', status: 'succeeded', exit_code: 0, command: 'west update',
      started_at: new Date().toISOString(), duration_ms: 1, log: { path: paths.jobLog('window-z', jobId), bytes: 22, tail: 'done' },
      result: { path: '/e2e/b/zephyrproject', restart_pending: true }, next: 'Call get_status.',
    }));
    const bridge = spawnBridge(home, '/somewhere/else');
    try {
      await bridge.handshake();
      const reply = await bridge.request('tools/call', { name: 'job', arguments: { action: 'status', job_id: jobId } }, 20000);
      const view = parseText(reply);
      assert.equal(view.status, 'succeeded');
      assert.equal(view.persisted, true);
      assert.deepEqual(view.result, { path: '/e2e/b/zephyrproject', restart_pending: true });
    } finally {
      bridge.close();
    }
  });

  it('answers from a capable window when another one is too old for the server', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-e2e-'));
    const host = await startHost({ list_apps: async () => ({ window: 'B' }) }, 'window-b');
    const later = new Date(Date.now() + 60_000).toISOString();
    record(home, { windowId: 'window-a', workspaceFolders: ['/e2e/a'], unsupported: 'VS Code 1.89 is too old.', focusedAt: later });
    record(home, { windowId: 'window-b', port: host.server.port, token: host.server.token, workspaceFolders: ['/e2e/b'] });
    const bridge = spawnBridge(home, '/somewhere/else');
    try {
      await bridge.handshake();
      const reply = await bridge.request('tools/call', { name: 'list_apps', arguments: {} });
      assert.equal(parseText(reply).window, 'B');
    } finally {
      bridge.close();
      await host.close();
    }
  });

  it('waits for a window whose extension host just crashed, instead of building elsewhere', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-e2e-'));
    let bBuilds = 0;
    const hostB = await startHost({ build_app: async () => { bBuilds++; return {}; } }, 'window-b');
    record(home, { windowId: 'window-b', port: hostB.server.port, token: hostB.server.token, workspaceFolders: ['/e2e/b'], appRoots: ['/e2e/b/app'] });
    // A pid that cannot exist, and a heartbeat from a moment ago.
    record(home, { windowId: 'window-a', pid: 2 ** 22 + 12345, port: 1, token: 't', workspaceFolders: ['/e2e/a'], appRoots: ['/e2e/a/app'] });
    const bridge = spawnBridge(home, '/e2e/a');
    try {
      await bridge.handshake();
      const reply = await bridge.request('tools/call', { name: 'build_app', arguments: {} }, 25000);
      assert.equal(errorCode(reply), 'WORKBENCH_NOT_RUNNING');
      assert.equal(bBuilds, 0);
    } finally {
      bridge.close();
      await hostB.close();
    }
  });
});
