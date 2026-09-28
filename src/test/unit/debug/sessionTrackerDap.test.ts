// The session tracker's view of a debug adapter, driven by scripted DAP
// messages through the adapter tracker VS Code would install: capabilities,
// the running and stopped states, the output ring, the end of the session,
// waiting for a stop with a deadline and an abort, and a new session caught
// by name, as the cortex-west backend's second session is.

import { strict as assert } from 'assert';
import * as vscode from 'vscode';
import {
  adapterTrackerFor, debugSessionsFor, endDebugSessionForTests, findWorkbenchSession, onWorkbenchSessionChange, OUTPUT_RING_LINES,
  outputAfter, outputTail, resetDebugSessionTrackingForTests, startDebugSessionTracking, trackDebugSessionForTests,
  waitForNewWorkbenchSession, waitForStop, workbenchDebugSessions,
} from '../../../debug/sessionTracker';

const vscodeStub = require('vscode') as Record<string, any>;

const NAME = 'Zephyr Workbench Debug [primary]';

function session(id: string, options: { type?: string; name?: string; configuration?: Record<string, unknown>; folder?: string } = {}): vscode.DebugSession {
  const name = options.name ?? NAME;
  return {
    id,
    type: options.type ?? 'cppdbg',
    name,
    configuration: { name, ...(options.configuration ?? {}) },
    workspaceFolder: { uri: { fsPath: options.folder ?? '/work/app' } },
    customRequest: async () => undefined,
  } as unknown as vscode.DebugSession;
}

function tracker(s: vscode.DebugSession): Required<Pick<vscode.DebugAdapterTracker, 'onDidSendMessage' | 'onExit'>> {
  const created = adapterTrackerFor(s);
  assert.ok(created, 'a Workbench session gets a tracker');
  return created as Required<Pick<vscode.DebugAdapterTracker, 'onDidSendMessage' | 'onExit'>>;
}

const event = (name: string, body: Record<string, unknown> = {}) => ({ type: 'event', event: name, body });
const response = (command: string, body?: unknown, success = true) => ({ type: 'response', command, success, body });

describe('debug/sessionTracker adapter tracking', () => {
  beforeEach(() => resetDebugSessionTrackingForTests());
  afterEach(() => resetDebugSessionTrackingForTests());

  it('gives no tracker to a session that is not a Workbench one', () => {
    assert.equal(adapterTrackerFor(session('a', { name: 'My node app' })), undefined);
    assert.equal(adapterTrackerFor(session('b', { type: 'node' })), undefined);
    assert.deepEqual(workbenchDebugSessions(), []);
  });

  it('follows starting, running, stopped and terminated from the adapter messages', () => {
    const s = session('4f1c2a9e-0000-4000-8000-000000000001');
    const t = tracker(s);
    const tracked = workbenchDebugSessions()[0];
    assert.equal(tracked.state, 'starting');
    assert.equal(tracked.shortId, 'dbg-4f1c2a9e');

    t.onDidSendMessage(response('initialize', { supportsReadMemoryRequest: true, supportsRestartRequest: false }));
    assert.deepEqual(tracked.capabilities, { supportsReadMemoryRequest: true, supportsRestartRequest: false });
    t.onDidSendMessage(response('configurationDone'));
    assert.equal(tracked.state, 'running');

    t.onDidSendMessage(event('stopped', {
      reason: 'breakpoint', threadId: 3, description: 'Paused on breakpoint', text: 'bp 1', allThreadsStopped: true, hitBreakpointIds: [1, 'x', 2],
    }));
    assert.equal(tracked.state, 'stopped');
    assert.equal(tracked.stopCount, 1);
    assert.deepEqual({ ...tracked.lastStop, at: 0 }, {
      reason: 'breakpoint', threadId: 3, description: 'Paused on breakpoint', text: 'bp 1', allThreadsStopped: true, hitBreakpointIds: [1, 2], at: 0, seq: 1,
    });

    // A step answered means the target runs until its stop.
    t.onDidSendMessage(response('next'));
    assert.equal(tracked.state, 'running');
    t.onDidSendMessage(event('stopped', { reason: 'step', threadId: 3 }));
    assert.equal(tracked.stopCount, 2);
    t.onDidSendMessage(event('continued', { threadId: 3 }));
    assert.equal(tracked.state, 'running');
    // A refused request changes nothing.
    t.onDidSendMessage(event('stopped', { reason: 'pause', threadId: 3 }));
    t.onDidSendMessage(response('continue', undefined, false));
    assert.equal(tracked.state, 'stopped');

    t.onDidSendMessage(event('exited', { exitCode: 0 }));
    t.onDidSendMessage(event('terminated'));
    assert.equal(tracked.state, 'terminated');
    assert.equal(tracked.exitCode, 0);
    // A stop after the end is not believed.
    t.onDidSendMessage(event('stopped', { reason: 'pause' }));
    assert.equal(tracked.state, 'terminated');
    assert.equal(tracked.stopCount, 3);
  });

  describe('a stop that comes before the answer to its step', () => {
    const request = (seq: number, command: string) => ({ type: 'request', seq, command, arguments: { threadId: 1 } });
    const answer = (seq: number, command: string) => ({ type: 'response', request_seq: seq, command, success: true });
    const stoppedSession = () => {
      const t = adapterTrackerFor(session('s-step')) as Required<vscode.DebugAdapterTracker>;
      const tracked = workbenchDebugSessions()[0];
      t.onDidSendMessage(response('configurationDone'));
      t.onDidSendMessage(event('stopped', { reason: 'entry', threadId: 1 }));
      return { t, tracked };
    };

    it('keeps the target stopped when the step\'s stop comes first, as cortex-debug sends it', () => {
      const { t, tracked } = stoppedSession();
      t.onWillReceiveMessage(request(7, 'next'));
      t.onDidSendMessage(event('stopped', { reason: 'step', threadId: 1 }));
      t.onDidSendMessage(answer(7, 'next'));
      assert.equal(tracked.state, 'stopped');
      assert.equal(tracked.stopCount, 2);
      assert.equal(tracked.lastStop?.reason, 'step');
    });

    it('still runs between the answer and the stop in the usual order', () => {
      const { t, tracked } = stoppedSession();
      t.onWillReceiveMessage(request(8, 'next'));
      t.onDidSendMessage(answer(8, 'next'));
      assert.equal(tracked.state, 'running');
      t.onDidSendMessage(event('stopped', { reason: 'step', threadId: 1 }));
      assert.equal(tracked.state, 'stopped');
      // A later continue is followed on its own seq.
      t.onWillReceiveMessage(request(9, 'continue'));
      t.onDidSendMessage(answer(9, 'continue'));
      assert.equal(tracked.state, 'running');
    });

    it('counts an answer to a request it did not see as running, and forgets a refused one', () => {
      const { t, tracked } = stoppedSession();
      t.onDidSendMessage(answer(40, 'continue'));
      assert.equal(tracked.state, 'running');
      t.onDidSendMessage(event('stopped', { reason: 'pause', threadId: 1 }));
      t.onWillReceiveMessage(request(41, 'stepIn'));
      t.onDidSendMessage({ type: 'response', request_seq: 41, command: 'stepIn', success: false, message: 'busy' });
      assert.equal(tracked.state, 'stopped');
    });
  });

  it('marks the session terminated when the adapter exits', () => {
    const t = tracker(session('s1'));
    t.onExit(1, undefined);
    const tracked = workbenchDebugSessions()[0];
    assert.equal(tracked.state, 'terminated');
    assert.equal(tracked.exitCode, 1);
  });

  it('keeps a bounded ring of output, without telemetry', () => {
    const t = tracker(session('s1'));
    const tracked = workbenchDebugSessions()[0];
    t.onDidSendMessage(event('output', { category: 'telemetry', output: 'secret' }));
    for (let i = 0; i < OUTPUT_RING_LINES + 20; i++) {
      t.onDidSendMessage(event('output', { category: i % 2 ? 'stdout' : 'console', output: `line ${i}\n` }));
    }
    assert.equal(tracked.output.length, OUTPUT_RING_LINES);
    assert.equal(tracked.outputCount, OUTPUT_RING_LINES + 20);
    assert.equal(tracked.output[0].text, 'line 20\n');
    assert.ok(!tracked.output.some(line => line.text === 'secret'));
    assert.equal(outputTail(tracked, 2), `line ${OUTPUT_RING_LINES + 18}\nline ${OUTPUT_RING_LINES + 19}`);
    t.onDidSendMessage(event('output', { output: 'x'.repeat(5000) }));
    assert.ok(tracked.output[tracked.output.length - 1].text.length < 2100, 'a huge line is cut');
  });

  it('records the server token of the cortex-west session, and catches it by name when it starts', async () => {
    const deadline = Date.now() + 2000;
    const watcher = waitForNewWorkbenchSession(tracked => tracked.name === NAME && tracked.type === 'cortex-debug', { deadline });
    // The zephyr-workbench session never runs; the provider starts this one instead.
    trackDebugSessionForTests(session('other', { name: 'Zephyr Workbench Debug [secondary]', type: 'cortex-debug' }));
    trackDebugSessionForTests(session('cortex', { type: 'cortex-debug', configuration: { servertype: 'external', __zwServerToken: 'token-1' } }));
    const found = await watcher.session;
    assert.ok(found);
    assert.equal(found.session.id, 'cortex');
    assert.equal(found.serverToken, 'token-1');
  });

  it('ignores a session that already ran before the wait, and gives up at the deadline or on abort', async () => {
    trackDebugSessionForTests(session('old'));
    const late = waitForNewWorkbenchSession(() => true, { deadline: Date.now() + 30 });
    assert.equal(await late.session, undefined);
    const controller = new AbortController();
    const aborted = waitForNewWorkbenchSession(() => true, { deadline: Date.now() + 5000, signal: controller.signal });
    controller.abort();
    assert.equal(await aborted.session, undefined);
    const cancelled = waitForNewWorkbenchSession(() => true, { deadline: Date.now() + 5000 });
    cancelled.cancel();
    assert.equal(await cancelled.session, undefined);
  });

  describe('waiting for a stop', () => {
    it('answers at once for a stop that already came after the mark', async () => {
      const t = tracker(session('s1'));
      t.onDidSendMessage(event('stopped', { reason: 'entry', threadId: 1 }));
      const tracked = workbenchDebugSessions()[0];
      assert.equal(await waitForStop(tracked, { afterStop: 0, deadline: Date.now() }), 'stopped');
    });

    it('waits for the next stop after the mark', async () => {
      const t = tracker(session('s1'));
      const tracked = workbenchDebugSessions()[0];
      t.onDidSendMessage(event('stopped', { reason: 'entry', threadId: 1 }));
      const waiting = waitForStop(tracked, { afterStop: tracked.stopCount, deadline: Date.now() + 2000 });
      setTimeout(() => t.onDidSendMessage(event('stopped', { reason: 'breakpoint', threadId: 1 })), 20);
      assert.equal(await waiting, 'stopped');
      assert.equal(tracked.lastStop?.reason, 'breakpoint');
    });

    it('answers terminated when the session ends first', async () => {
      tracker(session('s1'));
      const tracked = workbenchDebugSessions()[0];
      const waiting = waitForStop(tracked, { afterStop: 0, deadline: Date.now() + 2000 });
      setTimeout(() => endDebugSessionForTests('s1'), 20);
      assert.equal(await waiting, 'terminated');
      assert.deepEqual(workbenchDebugSessions(), []);
    });

    it('answers timeout at the deadline, and aborted when the caller goes', async () => {
      tracker(session('s1'));
      const tracked = workbenchDebugSessions()[0];
      const started = Date.now();
      assert.equal(await waitForStop(tracked, { afterStop: 0, deadline: started + 40 }), 'timeout');
      assert.ok(Date.now() - started >= 30);
      const controller = new AbortController();
      const waiting = waitForStop(tracked, { afterStop: 0, deadline: Date.now() + 5000, signal: controller.signal });
      setTimeout(() => controller.abort(), 10);
      assert.equal(await waiting, 'aborted');
    });
  });

  it('collects the output that follows a mark until it has been quiet', async () => {
    const t = tracker(session('s1'));
    const tracked = workbenchDebugSessions()[0];
    t.onDidSendMessage(event('output', { category: 'console', output: 'before\n' }));
    const mark = tracked.outputCount;
    setTimeout(() => t.onDidSendMessage(event('output', { category: 'console', output: 'r0 0x1\n' })), 10);
    setTimeout(() => t.onDidSendMessage(event('output', { category: 'console', output: 'r1 0x2\n' })), 40);
    const lines = await outputAfter(tracked, mark, { quietMs: 80, deadline: Date.now() + 1000 });
    assert.deepEqual(lines.map(line => line.text), ['r0 0x1\n', 'r1 0x2\n']);
  });

  it('gives each session a short id of its own, and remembers ended ones', () => {
    trackDebugSessionForTests(session('abcdef12-1'));
    trackDebugSessionForTests(session('abcdef12-2'));
    const [first, second] = workbenchDebugSessions();
    assert.equal(first.shortId, 'dbg-abcdef12');
    assert.equal(second.shortId, 'dbg-abcdef122');
    endDebugSessionForTests('abcdef12-1');
    assert.equal(findWorkbenchSession('dbg-abcdef12').ended?.name, NAME);
    assert.equal(findWorkbenchSession('dbg-abcdef122').tracked?.session.id, 'abcdef12-2');
    assert.deepEqual(findWorkbenchSession('dbg-nothing'), {});
  });

  it('tells listeners when a session starts and ends', () => {
    const events: string[] = [];
    const subscription = onWorkbenchSessionChange(change => events.push(`${change.kind} ${change.tracked.session.id}`));
    trackDebugSessionForTests(session('s1'));
    trackDebugSessionForTests(session('s1'));
    endDebugSessionForTests('s1');
    subscription.dispose();
    trackDebugSessionForTests(session('s2'));
    assert.deepEqual(events, ['started s1', 'ended s1']);
  });

  it('keeps matching sessions to applications as before', () => {
    trackDebugSessionForTests(session('s1', { folder: '/work/app' }));
    trackDebugSessionForTests(session('s2', { folder: '/work/other' }));
    const app = { appRootPath: '/work/app', appName: 'app', isWestWorkspaceApplication: false, appWorkspaceFolder: { uri: { fsPath: '/work/app' } } };
    assert.deepEqual(debugSessionsFor(app).map(tracked => tracked.session.id), ['s1']);
    assert.deepEqual(debugSessionsFor(app, 'secondary'), []);
  });

  it('counts a legacy freestanding-named session of a west workspace for its applications with that configuration', () => {
    trackDebugSessionForTests(session('legacy', { folder: '/work/ws' }));
    trackDebugSessionForTests(session('other-app', { folder: '/work/ws', name: 'Zephyr Workbench Debug: apps/hello [primary]' }));
    const west = (root: string, configs: string[]) => ({
      appRootPath: root, appName: root.split('/').pop() as string, isWestWorkspaceApplication: true,
      appWorkspaceFolder: { uri: { fsPath: '/work/ws' } }, buildConfigs: configs.map(name => ({ name })),
    });
    assert.deepEqual(debugSessionsFor(west('/work/ws/apps/blinky', ['primary']), 'primary').map(tracked => tracked.session.id), ['legacy']);
    assert.deepEqual(debugSessionsFor(west('/work/ws/apps/blinky', ['release']), 'primary'), [], 'no configuration of that name');
    assert.deepEqual(debugSessionsFor(west('/work/ws/apps/hello', ['primary'])).map(tracked => tracked.session.id).sort(), ['legacy', 'other-app']);
    const freestanding = { appRootPath: '/work/app', appName: 'app', isWestWorkspaceApplication: false, appWorkspaceFolder: { uri: { fsPath: '/work/app' } } };
    assert.deepEqual(debugSessionsFor(freestanding), [], 'a freestanding application in another folder');
  });

  it('registers a tracker factory for both adapter types at activation', () => {
    const saved = { ...vscodeStub.debug };
    const types: string[] = [];
    vscodeStub.debug.registerDebugAdapterTrackerFactory = (type: string) => {
      types.push(type);
      return { dispose() {} };
    };
    try {
      const context = { subscriptions: [] as unknown[] } as unknown as vscode.ExtensionContext;
      startDebugSessionTracking(context);
      assert.deepEqual(types.sort(), ['cortex-debug', 'cppdbg']);
      assert.equal(context.subscriptions.length, 4);
    } finally {
      Object.assign(vscodeStub.debug, saved);
    }
  });
});
