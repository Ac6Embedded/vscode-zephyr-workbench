import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';
import { classifyUpstreamError } from '../../../mcp/bridge/classify';
import { BridgeLog } from '../../../mcp/bridge/log';
import { answerFromPersistedJob, errorCodeOf, orPersistedJob, readPersistedJob } from '../../../mcp/bridge/persistedJobs';
import { ConnectionPool } from '../../../mcp/bridge/pool';
import { anySignal, CALL_ID_META_KEY, eventAnswers, StreamWatch } from '../../../mcp/bridge/streamWatch';
import { advertisedToolNames, BridgeOptions, readOptions, resolveWindow } from '../../../mcp/bridge/upstream';
import { findTool } from '../../../mcp/core/catalog';
import { McpToolError } from '../../../mcp/core/errors';
import { getMcpPaths } from '../../../mcp/core/paths';
import { isWindowRecord, WindowRecord, writeWindowRecord } from '../../../mcp/core/registry';
import { routeOfCall } from '../../../mcp/core/routing';

function named(name: string, fields: Record<string, unknown>): Error {
  const error = new Error(String(fields.message ?? name));
  error.name = name;
  return Object.assign(error, fields);
}

function rec(windowId: string, port: number, token: string, tools?: string[]): WindowRecord {
  return {
    schema: 1, windowId, pid: 1, platform: process.platform, hostname: 'h', port, token,
    workspaceFolders: [], appRoots: [], westWorkspaces: [],
    ide: { name: 't', version: '0', uriScheme: 'vscode' }, nodeExecPath: '', extensionVersion: '0',
    catalogVersion: '0', startedAt: '', focusedAt: '', heartbeatAt: '',
    ...(tools ? { tools } : {}),
  };
}

describe('mcp/bridge/classify', () => {
  it('treats a refused connection and a rejected token as never delivered', () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    assert.equal(classifyUpstreamError(refused), 'not-delivered');
    assert.equal(classifyUpstreamError(named('SdkHttpError', { data: { status: 401 } })), 'not-delivered');
    assert.equal(classifyUpstreamError(named('SdkHttpError', { data: { status: 404 } })), 'not-delivered');
    assert.equal(classifyUpstreamError(named('SdkError', { code: 'ERA_NEGOTIATION_FAILED' })), 'not-delivered');
  });

  it('treats a connection cut mid-call as interrupted, because the tool may have run', () => {
    const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } });
    assert.equal(classifyUpstreamError(reset), 'interrupted');
    assert.equal(classifyUpstreamError(new TypeError('fetch failed')), 'interrupted');
    assert.equal(classifyUpstreamError(named('ProtocolError', { code: -32000, message: 'Connection closed' })), 'interrupted');
    assert.equal(classifyUpstreamError(named('SdkHttpError', { data: { status: 500 } })), 'interrupted');
  });

  it('recognises a tool the window does not offer', () => {
    assert.equal(classifyUpstreamError(named('ProtocolError', { code: -32602, message: 'Tool build_app not found' })), 'tool-missing');
    // Any other invalid-params error is the agent's mistake, not a missing tool.
    assert.equal(classifyUpstreamError(named('ProtocolError', { code: -32602, message: 'Invalid arguments' })), 'other');
  });

  it('recognises the errors SDK 2.0 actually throws', () => {
    assert.equal(classifyUpstreamError(new SdkError(SdkErrorCode.RequestTimeout, 'Request timed out')), 'timeout');
    assert.equal(classifyUpstreamError(new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed')), 'interrupted');
    assert.equal(classifyUpstreamError(new SdkError(SdkErrorCode.EraNegotiationFailed, 'probe failed')), 'not-delivered');
    const closedDuringDispatch = new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'Error POSTing to endpoint: ',
      { status: 499, statusText: '', text: '' } as never);
    assert.equal(classifyUpstreamError(closedDuringDispatch), 'interrupted', 'the tool may have run');
  });

  it('recognises a timeout and leaves everything else alone', () => {
    assert.equal(classifyUpstreamError(named('ProtocolError', { code: -32001, message: 'Request timed out' })), 'timeout');
    assert.equal(classifyUpstreamError(new Error('boom')), 'other');
    assert.equal(classifyUpstreamError(undefined), 'other');
  });
});

describe('mcp/bridge/pool', () => {
  const fakeClient = () => ({ closed: false, async close() { this.closed = true; } });

  it('connects once per window even under concurrent calls', async () => {
    let connects = 0;
    const pool = new ConnectionPool(async () => { connects++; return fakeClient(); });
    const record = rec('w1', 1000, 't');
    const [a, b] = await Promise.all([pool.get(record), pool.get(record)]);
    assert.equal(a, b);
    assert.equal(connects, 1);
    assert.equal(pool.isKnownGood(record), true);
  });

  it('reconnects when the window comes back on a new port or token', async () => {
    const pool = new ConnectionPool(async () => fakeClient());
    const first = await pool.get(rec('w1', 1000, 't1'));
    const second = await pool.get(rec('w1', 1001, 't2'));
    assert.notEqual(first, second);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(first.closed, true, 'the stale connection must be closed');
  });

  it('only drops the connection that failed, never a newer one', async () => {
    const pool = new ConnectionPool(async () => fakeClient());
    const stale = await pool.get(rec('w1', 1000, 't1'));
    const fresh = await pool.get(rec('w1', 1001, 't2'));
    pool.drop('w1', stale);
    assert.equal(pool.isKnownGood(rec('w1', 1001, 't2')), true);
    pool.drop('w1', fresh);
    assert.equal(pool.size, 0);
  });

  it('keeps windows independent', async () => {
    const pool = new ConnectionPool(async () => fakeClient());
    const a = await pool.get(rec('a', 1000, 't'));
    await pool.get(rec('b', 1001, 't'));
    pool.drop('b');
    assert.equal(pool.isKnownGood(rec('a', 1000, 't')), true);
    assert.equal(a.closed, false);
  });

  it('lets calls in flight finish before closing a connection that failed for another call', async () => {
    const pool = new ConnectionPool(async () => fakeClient());
    const record = rec('w1', 1000, 't');
    const first = await pool.acquire(record);
    const second = await pool.acquire(record);
    pool.drop('w1', first.client);
    first.release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(second.client.closed, false, 'the other call is still using it');
    assert.equal(pool.isKnownGood(record), false, 'new calls get a fresh connection');
    second.release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(second.client.closed, true);
  });

  it('forgets a failed connect so the next call tries again', async () => {
    let attempts = 0;
    const pool = new ConnectionPool(async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('refused');
      }
      return fakeClient();
    });
    await assert.rejects(pool.get(rec('w1', 1000, 't')));
    await new Promise(resolve => setImmediate(resolve));
    await pool.get(rec('w1', 1000, 't'));
    assert.equal(attempts, 2);
  });
});

describe('mcp/bridge/upstream', () => {
  it('advertises the union of what the windows publish', () => {
    assert.equal(advertisedToolNames([rec('a', 1, 't')]), undefined, 'no window says: show the whole catalog');
    const names = advertisedToolNames([rec('a', 1, 't', ['get_status']), rec('b', 2, 't', ['list_apps']), rec('c', 3, 't')]);
    assert.deepEqual([...(names ?? [])].sort(), ['get_status', 'list_apps']);
  });

  it('reads the pin, workspace and routing from flags and the environment', () => {
    const options = readOptions(['--window', 'abc'], { ZW_MCP_ROUTING: 'strict', ZW_MCP_HOME: '/h' }, '/cwd');
    assert.deepEqual(options, { home: '/h', pinnedWindowId: 'abc', workspace: '/cwd', routing: 'strict' });
    assert.equal(readOptions([], { ZW_MCP_WORKSPACE: '/ws' }, '/cwd').workspace, '/ws');
    assert.equal(readOptions([], { ZW_MCP_WINDOW: '' }, '/cwd').pinnedWindowId, undefined, 'an empty pin is no pin');
  });
});

describe('mcp/bridge/streamWatch', () => {
  it('recognises the event that carries the answer, and only that one', () => {
    assert.equal(eventAnswers('event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{}}', 7), true);
    assert.equal(eventAnswers('data: {"jsonrpc":"2.0","id":7,"error":{"code":1}}', 7), true);
    assert.equal(eventAnswers('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}', 7), false);
    assert.equal(eventAnswers('data: {"jsonrpc":"2.0","id":8,"result":{}}', 7), false);
    assert.equal(eventAnswers(': keep-alive', 7), false);
  });

  it('combines abort signals', () => {
    const a = new AbortController();
    const b = new AbortController();
    const both = anySignal([a.signal, undefined, b.signal]);
    assert.equal(both.aborted, false);
    b.abort();
    assert.equal(both.aborted, true);
  });
});

describe('mcp/core/registry validation', () => {
  it('rejects records a reader would choke on', () => {
    const good = rec('w1', 1000, 't');
    assert.equal(isWindowRecord(good), true);
    assert.equal(isWindowRecord({ ...good, westWorkspaces: undefined }), false);
    assert.equal(isWindowRecord({ ...good, workspaceFolders: [1] }), false);
    assert.equal(isWindowRecord({ ...good, token: 5 }), false);
    assert.equal(isWindowRecord({ ...good, windowId: '../x' }), false);
  });
});

describe('mcp/bridge/streamWatch aborts', () => {
  const sseResponse = (signal?: AbortSignal) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n'));
      signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: { [CALL_ID_META_KEY]: 'c1' } } });

  async function drain(response: Response): Promise<void> {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        if ((await reader.read()).done) { return; }
      }
    } catch {
      // Expected: the stream errors.
    }
  }

  it('does not report a stream the caller aborted on purpose as a lost window', async () => {
    const watch = new StreamWatch();
    let lost = false;
    watch.watch('c1', () => { lost = true; });
    const controller = new AbortController();
    const fetcher = watch.wrap(async (_input, init) => sseResponse(init?.signal ?? undefined));
    const response = await fetcher('http://127.0.0.1/mcp', { method: 'POST', body, signal: controller.signal });
    const drained = drain(response);
    controller.abort();
    await drained;
    assert.equal(lost, false, 'a timeout or a cancel has its own error');
  });

  it('reports a stream that ends without the answer', async () => {
    const watch = new StreamWatch();
    let lost = false;
    watch.watch('c1', () => { lost = true; });
    const fetcher = watch.wrap(async () => new Response('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n',
      { headers: { 'content-type': 'text/event-stream' } }));
    await drain(await fetcher('http://127.0.0.1/mcp', { method: 'POST', body }));
    assert.equal(lost, true);
  });
});

describe('mcp/bridge/upstream routing of calls on the machine', () => {
  let home: string;
  const log = new BridgeLog();
  const options = (over: Partial<BridgeOptions> = {}): BridgeOptions =>
    ({ home, workspace: path.join(os.tmpdir(), 'zw-unrelated-agent-folder'), routing: 'nearest', ...over });
  const resolve = (opts: BridgeOptions, readOnly: boolean, machineScope?: boolean) =>
    resolveWindow(opts, log, { readOnly, machineScope, isKnownGood: () => true });
  /** A call of a catalog tool, routed as the bridge routes it. */
  const call = (opts: BridgeOptions, tool: string, args: Record<string, unknown>) => {
    const meta = findTool(tool)!;
    return resolveWindow(opts, log, { readOnly: meta.annotations.readOnlyHint === true, ...routeOfCall(meta, args), isKnownGood: () => true });
  };

  // Records this process owns, so they count as live windows.
  function publish(windowId: string, folder: string, focusedAt: string): void {
    writeWindowRecord(getMcpPaths(home), {
      ...rec(windowId, 40000, 't'),
      pid: process.pid, hostname: os.hostname(), workspaceFolders: [folder], appRoots: [folder], focusedAt,
      heartbeatAt: new Date().toISOString(),
    });
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-mcp-routing-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('sends a call on the machine to the only window even from an unrelated folder', async () => {
    publish('w1', '/ws/one', '2026-09-22T10:00:00.000Z');
    const mutating = await resolve(options(), false);
    assert.equal(mutating.problem?.code, 'AMBIGUOUS_WINDOW', 'a build from an unrelated folder is still refused');
    const machine = await resolve(options(), false, true);
    assert.equal(machine.record?.windowId, 'w1');
  });

  it('sends a call on the machine to the most recently focused of several windows', async () => {
    publish('w1', '/ws/one', '2026-09-22T12:00:00.000Z');
    publish('w2', '/ws/two', '2026-09-22T10:00:00.000Z');
    assert.equal((await resolve(options(), false)).problem?.code, 'AMBIGUOUS_WINDOW');
    assert.equal((await resolve(options(), false, true)).record?.windowId, 'w1');
  });

  it('hands the user a wizard in the only window even from an unrelated folder', async () => {
    publish('w1', '/ws/one', '2026-09-22T10:00:00.000Z');
    for (const target of ['add_application', 'add_west_workspace', 'add_toolchain']) {
      assert.equal((await call(options(), 'open_in_workbench', { target })).record?.windowId, 'w1', target);
    }
    assert.equal((await call(options(), 'open_in_workbench', { target: 'dashboard' })).problem?.code, 'AMBIGUOUS_WINDOW',
      'a view of an application still needs one');
  });

  it('tells the agent to pass the argument the tool routes by, which then picks the window', async () => {
    publish('w1', '/ws/one', '2026-09-22T12:00:00.000Z');
    const single = await call(options(), 'manage_west_workspace', { action: 'update' });
    assert.equal(single.problem?.code, 'AMBIGUOUS_WINDOW');
    assert.match(single.problem?.hint ?? '', /west_workspace set to the west workspace root/);
    assert.doesNotMatch(single.problem?.hint ?? '', /app_path/, 'manage_west_workspace takes no app_path');
    assert.match(single.problem?.hint ?? '', /ZW_MCP_WORKSPACE/);
    const followed = await call(options(), 'manage_west_workspace', { action: 'update', west_workspace: '/ws/one' });
    assert.equal(followed.record?.windowId, 'w1', 'following the hint routes the call');
    const pinned = await call(options({ pinnedWindowId: 'gone' }), 'manage_west_workspace', { action: 'update' });
    assert.equal(pinned.problem?.code, 'WORKBENCH_NOT_RUNNING');
    assert.match(pinned.problem?.hint ?? '', /pass west_workspace with a folder of that window/);

    publish('w2', '/ws/two', '2026-09-22T10:00:00.000Z');
    const several = await call(options(), 'manage_west_workspace', { action: 'update' });
    assert.equal(several.problem?.code, 'AMBIGUOUS_WINDOW');
    assert.match(several.problem?.hint ?? '', /west_workspace set to/);
    assert.doesNotMatch(several.problem?.hint ?? '', /app_path/);

    // An application tool still asks for app_path.
    const build = await call(options(), 'build_app', {});
    assert.match(build.problem?.hint ?? '', /app_path set to the application's absolute path \(call list_apps/);
    assert.doesNotMatch(build.problem?.hint ?? '', /west_workspace/);
  });

  it('keeps an agent pinned to a window that is gone from acting elsewhere', async () => {
    publish('w1', '/ws/one', '2026-09-22T12:00:00.000Z');
    const pinned = await resolve(options({ pinnedWindowId: 'gone' }), false, true);
    assert.equal(pinned.problem?.code, 'WORKBENCH_NOT_RUNNING');
    assert.equal(pinned.waitable, true);
  });

  it('keeps strict routing strict', async () => {
    publish('w1', '/ws/one', '2026-09-22T12:00:00.000Z');
    assert.equal((await resolve(options({ routing: 'strict' }), false, true)).problem?.code, 'AMBIGUOUS_WINDOW');
  });
});

describe('mcp/bridge/persistedJobs', () => {
  let home: string;
  const jobId = 'w1.install-1-abc123';
  const view = {
    job_id: jobId, kind: 'install', status: 'succeeded', exit_code: 0, command: 'install',
    started_at: '2026-09-22T10:00:00.000Z', ended_at: '2026-09-22T10:01:00.000Z', duration_ms: 60000,
    log: { path: '', bytes: 0, tail: 'done' }, next: 'Finished.',
  };
  const saveRecord = (value: unknown, id = jobId) => {
    const paths = getMcpPaths(home);
    fs.mkdirSync(paths.jobDir('w1'), { recursive: true });
    fs.writeFileSync(paths.jobRecord('w1', id), JSON.stringify(value));
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-mcp-jobs-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('answers status and cancel from the saved result, marked as persisted', () => {
    saveRecord(view);
    const paths = getMcpPaths(home);
    assert.deepEqual(answerFromPersistedJob(paths, jobId, { action: 'status', job_id: jobId }), { ...view, persisted: true });
    const cancelled = answerFromPersistedJob(paths, jobId, { action: 'cancel', job_id: jobId });
    assert.equal(cancelled?.status, 'succeeded', 'a finished job stays as it ended');
  });

  it('pages and filters the log next to the saved result', () => {
    saveRecord(view);
    const paths = getMcpPaths(home);
    fs.writeFileSync(paths.jobLog('w1', jobId), 'one\ntwo error\nthree\nfour\n');
    const page = answerFromPersistedJob(paths, jobId, { action: 'log', job_id: jobId, offset: 4, max_chars: 3 });
    assert.equal(page?.text, 'two');
    assert.equal(page?.next_offset, 7);
    assert.equal(page?.persisted, true);
    const grep = answerFromPersistedJob(paths, jobId, { action: 'log', job_id: jobId, grep: 'ERROR', context_lines: 1 });
    assert.equal(grep?.text, 'one\ntwo error\nthree');
    assert.throws(() => answerFromPersistedJob(paths, jobId, { action: 'log', job_id: jobId, grep: ' ' }),
      (error: unknown) => error instanceof McpToolError && error.code === 'INVALID_ARGUMENT');
  });

  it('answers nothing without a saved result, or for a record of another job', () => {
    const paths = getMcpPaths(home);
    assert.equal(answerFromPersistedJob(paths, jobId, { action: 'status' }), undefined);
    saveRecord({ ...view, job_id: 'w1.build-2-def456' });
    assert.equal(readPersistedJob(paths, jobId), undefined);
    saveRecord([view]);
    assert.equal(readPersistedJob(paths, jobId), undefined);
  });

  it('never reads outside the jobs folder, whatever the agent sends', () => {
    const paths = getMcpPaths(home);
    fs.writeFileSync(path.join(home, 'secret.json'), JSON.stringify({ job_id: 'w1.x/../../../secret' }));
    assert.equal(readPersistedJob(paths, 'w1.x/../../../secret'), undefined);
    assert.equal(readPersistedJob(paths, '../w1.x'), undefined);
  });

  it('steps in only when the window could not answer, and only with a saved result', () => {
    const paths = getMcpPaths(home);
    const refused = (code: string) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code } }) }] });
    const args = { action: 'status', job_id: jobId };
    const gone = refused('JOB_NOT_FOUND');
    assert.equal(orPersistedJob(paths, args, gone), gone, 'no saved result: JOB_NOT_FOUND stays');
    saveRecord(view);
    const answered = orPersistedJob(paths, args, gone) as { structuredContent?: Record<string, unknown>; isError?: boolean };
    assert.equal(answered.isError, undefined);
    assert.equal(answered.structuredContent?.persisted, true);
    assert.equal((orPersistedJob(paths, args, refused('WORKBENCH_NOT_RUNNING')) as typeof answered).structuredContent?.status, 'succeeded');
    const denied = refused('USER_DENIED');
    assert.equal(orPersistedJob(paths, args, denied), denied, 'any other error is passed on');
    const live = { content: [{ type: 'text', text: '{}' }], structuredContent: { status: 'running' } };
    assert.equal(orPersistedJob(paths, args, live), live, 'a window that answered is never second-guessed');
    const badGrep = orPersistedJob(paths, { action: 'log', job_id: jobId, grep: ' ' }, gone);
    assert.equal(errorCodeOf(badGrep), 'INVALID_ARGUMENT');
  });

  it('reads the error code of a failed result', () => {
    const failed = { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'JOB_NOT_FOUND' } }) }] };
    assert.equal(errorCodeOf(failed), 'JOB_NOT_FOUND');
    assert.equal(errorCodeOf({ content: [{ type: 'text', text: '{}' }] }), undefined, 'a success has no code');
    assert.equal(errorCodeOf({ isError: true, content: [{ type: 'text', text: 'not json' }] }), undefined);
  });
});
