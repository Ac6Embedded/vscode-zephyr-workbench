// debug_app on the host side, for the actions that manage sessions: start,
// stop, status and breakpoint, with the session id rules they share. The
// real handler, confirmation gate, job manager, debug setup and session
// tracker run on a freestanding application whose build is on disk; VS Code's
// debugger is stood in for by the vscode stub, and a started session is a
// scripted fake, so no adapter, gdb, probe or board is ever used.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  endDebugSessionForTests, resetDebugSessionTrackingForTests, workbenchDebugSessions,
} from '../../../debug/sessionTracker';
import { findTool, TOOL_CATALOG } from '../../../mcp/core/catalog';
import { McpToolError } from '../../../mcp/core/errors';
import { ConfirmCategory, permissionForCategories, ToolContext } from '../../../mcp/core/toolSpec';
import { AskAnswer, Confirmations, ConfirmSubject } from '../../../mcp/host/confirmations';
import { configureDebug } from '../../../mcp/host/handlers/configureDebug';
import { CPPTOOLS_EXTENSION_ID, debugApp, debugLaunchHost } from '../../../mcp/host/handlers/debugApp';
import {
  agentBreakpointIdsForTests, agentBreakpointTiming, initAgentBreakpoints, resetAgentBreakpointsForTests,
} from '../../../mcp/host/handlers/debugAppBreakpoints';
import { HostDeps } from '../../../mcp/host/handlers/deps';
import { HostServices } from '../../../mcp/host/services';
import { JobManager } from '../../../mcp/jobs/jobManager';
import { DebugFixture, makeDebugFixture } from '../debugTestFixture';
import { FakeDebugSession, fakeDebugSession, frame } from './debugSessionFake';
import { useUiGuard } from './uiGuard';

const vscodeStub = require('vscode') as Record<string, any>;

const PRIMARY = 'Zephyr Workbench Debug [primary]';

interface Harness {
  f: DebugFixture;
  deps: HostDeps;
  jobs: JobManager;
  asked: string[];
  /** The detail of each dialog, in the same order as asked. */
  details: string[];
  answers: AskAnswer[];
  confirmActions: ConfirmCategory[];
  subjects: ConfirmSubject[];
  extensions: Set<string>;
  launches: { folder: unknown; target: unknown }[];
  /** What a launch does: start a fake session, or nothing. */
  onLaunch?: (target: unknown) => FakeDebugSession | undefined;
  launchResult: boolean;
  sessions: FakeDebugSession[];
  breakpoints: vscode.Breakpoint[];
  stopped: string[];
}

let h: Harness;

function harness(options: Parameters<typeof makeDebugFixture>[0] = {}): Harness {
  const f = makeDebugFixture(options);
  const services = new HostServices(vscode.Uri.file(os.tmpdir()));
  services.listApplications = async () => [f.app()];
  services.knownRoots = async () => [f.root];
  services.debugToolsManifest = () => ({ debug_tools: [] }) as never;
  services.debugToolsStatus = async () => [];
  const jobs = new JobManager({ logPathFor: id => path.join(f.root, `${id}.log`) });
  const state = {
    f, jobs, asked: [], details: [], answers: [], confirmActions: [], subjects: [], extensions: new Set([CPPTOOLS_EXTENSION_ID]),
    launches: [], launchResult: true, sessions: [], breakpoints: [], stopped: [],
  } as unknown as Harness;
  const confirmations = new Confirmations({
    permission: tool => permissionForCategories(tool, state.confirmActions),
    waitMs: () => 2000,
    log: { recordConfirmation: () => undefined },
    ask: async (message, detail) => {
      state.asked.push(message);
      state.details.push(detail);
      return state.answers.shift();
    },
  });
  const require = confirmations.require.bind(confirmations);
  confirmations.require = ((ctx, args, subject, opts) => {
    state.subjects.push(subject);
    return require(ctx, args, subject, opts);
  }) as typeof confirmations.require;
  state.deps = {
    windowId: 'w1',
    services, jobs, confirmations,
    defaultWaitSeconds: 1,
    revealTerminal: 'never',
    permissionOf: tool => permissionForCategories(tool, state.confirmActions),
    kconfig: {} as HostDeps['kconfig'],
    extensionContext: {} as HostDeps['extensionContext'],
    folders: {} as HostDeps['folders'],
    refreshViews: async () => undefined,
    servedTools: () => new Set(TOOL_CATALOG.map(tool => tool.name)),
  };
  h = state;
  return state;
}

function ctx(tool = 'debug_app'): ToolContext<HostDeps> {
  return {
    signal: new AbortController().signal,
    progress: () => undefined,
    client: { name: 'test-agent', version: '1', instance: 'agent-1' },
    deps: h.deps,
    tool: findTool(tool)!,
    startedAt: Date.now(),
    audit: {},
  };
}

const call = (args: Record<string, unknown>) => debugApp(args, ctx()) as Promise<any>;

async function errorOf(promise: Promise<unknown>): Promise<McpToolError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof McpToolError, `expected an McpToolError, got ${String(error)}`);
    return error;
  }
  throw new Error('expected the call to fail');
}

/** Write the Debug Manager's entry of primary, as configure_debug apply does. */
async function applyEntry(extra: Record<string, unknown> = {}): Promise<any> {
  return configureDebug({ action: 'apply', ...extra }, ctx('configure_debug'));
}

/** A running Workbench session of the fixture's application. */
function running(options: Partial<Parameters<typeof fakeDebugSession>[0]> = {}): FakeDebugSession {
  const fake = fakeDebugSession({
    folder: h.f.appRoot,
    handlers: { stackTrace: () => ({ stackFrames: [frame(1000, 'main', path.join(h.f.appRoot, 'src', 'main.c'), 12)] }), threads: () => ({ threads: [{ id: 1, name: 'main' }] }) },
    ...options,
  });
  h.sessions.push(fake);
  return fake;
}

describe('debug_app sessions', () => {
  useUiGuard();

  const saved: Record<string, unknown> = {};
  beforeEach(() => {
    resetDebugSessionTrackingForTests();
    resetAgentBreakpointsForTests();
    saved.getExtension = vscodeStub.extensions.getExtension;
    saved.executeTask = vscodeStub.tasks.executeTask;
    saved.debug = { ...vscodeStub.debug };
    saved.minSessionWaitMs = debugLaunchHost.minSessionWaitMs;
    saved.stopWaitMs = debugLaunchHost.stopWaitMs;
    saved.cortexWestGraceMs = debugLaunchHost.cortexWestGraceMs;
    saved.timing = { ...agentBreakpointTiming };
    debugLaunchHost.minSessionWaitMs = 300;
    debugLaunchHost.stopWaitMs = 300;
    debugLaunchHost.cortexWestGraceMs = 150;
    agentBreakpointTiming.verifyWaitMs = 60;
    agentBreakpointTiming.verifyPollMs = 10;
    vscodeStub.extensions.getExtension = (id: string) => (h?.extensions.has(id) ? { id } : undefined);
    vscodeStub.tasks.executeTask = async () => {
      throw new Error('no task may start');
    };
    vscodeStub.debug.startDebugging = async (folder: unknown, target: unknown) => {
      h.launches.push({ folder, target });
      h.onLaunch?.(target);
      return h.launchResult;
    };
    vscodeStub.debug.stopDebugging = async (session: vscode.DebugSession) => {
      h.stopped.push(session.id);
      setTimeout(() => endDebugSessionForTests(session.id), 5);
    };
    vscodeStub.debug.breakpoints = [];
    Object.defineProperty(vscodeStub.debug, 'breakpoints', { configurable: true, enumerable: true, get: () => h?.breakpoints ?? [] });
    vscodeStub.debug.addBreakpoints = (list: vscode.Breakpoint[]) => {
      h.breakpoints = [...h.breakpoints, ...list];
    };
    vscodeStub.debug.removeBreakpoints = (list: vscode.Breakpoint[]) => {
      h.breakpoints = h.breakpoints.filter(bp => !list.includes(bp));
    };
  });
  afterEach(() => {
    vscodeStub.extensions.getExtension = saved.getExtension;
    vscodeStub.tasks.executeTask = saved.executeTask;
    Object.defineProperty(vscodeStub.debug, 'breakpoints', { configurable: true, enumerable: true, writable: true, value: [] });
    Object.assign(vscodeStub.debug, saved.debug as Record<string, unknown>);
    debugLaunchHost.minSessionWaitMs = saved.minSessionWaitMs as number;
    debugLaunchHost.stopWaitMs = saved.stopWaitMs as number;
    debugLaunchHost.cortexWestGraceMs = saved.cortexWestGraceMs as number;
    Object.assign(agentBreakpointTiming, saved.timing);
    resetDebugSessionTrackingForTests();
    resetAgentBreakpointsForTests();
    h?.f.restore();
  });

  describe('routing', () => {
    it('refuses an unknown action and an argument another action takes', async () => {
      harness();
      assert.equal((await errorOf(call({ action: 'launch' }))).code, 'INVALID_ARGUMENT');
      const misplaced = await errorOf(call({ action: 'status', command: 'continue' }));
      assert.match(misplaced.message, /does not take command/);
      assert.match((await errorOf(call({ action: 'start', session_id: 'w1.dbg-1' }))).message, /does not take session_id/);
      assert.match((await errorOf(call({ action: 'inspect', text: 'bt' }))).message, /does not take text/);
      assert.match((await errorOf(call({ action: 'gdb', include: ['locals'] }))).message, /does not take include/);
      assert.match((await errorOf(call({ action: 'breakpoint', keep_breakpoints: true }))).message, /does not take keep_breakpoints/);
      assert.match((await errorOf(call({ action: 'stop', wait_for_stop: true }))).message, /does not take wait_for_stop/);
    });
  });

  describe('which session a call means', () => {
    it('is SESSION_NOT_FOUND with nothing running, pointing at start', async () => {
      harness();
      const error = await errorOf(call({ action: 'inspect' }));
      assert.equal(error.code, 'SESSION_NOT_FOUND');
      assert.match(error.hint ?? '', /debug_app with action "start"/);
    });

    it('takes the only session when session_id is omitted', async () => {
      harness();
      const fake = running({ state: 'stopped' });
      const result = await call({ action: 'status' });
      assert.equal(result.sessions.length, 1);
      assert.equal(result.sessions[0].session_id, `w1.${fake.tracked.shortId}`);
      assert.match(result.sessions[0].session_id, /^w1\.dbg-[a-z0-9]+$/);
      const stopped = await call({ action: 'control', command: 'pause' });
      assert.equal(stopped.session_id, result.sessions[0].session_id);
    });

    it('asks for session_id when several run, listing them', async () => {
      harness();
      running();
      running({ name: 'Zephyr Workbench Debug [other]' });
      const error = await errorOf(call({ action: 'inspect' }));
      assert.equal(error.code, 'INVALID_ARGUMENT');
      const sessions = error.details?.sessions as { session_id: string; name: string }[];
      assert.deepEqual(sessions.map(entry => entry.name), [PRIMARY, 'Zephyr Workbench Debug [other]']);
      assert.ok(sessions.every(entry => entry.session_id.startsWith('w1.dbg-')));
      // app_path and config_name narrow it to one.
      const narrowed = await call({ action: 'status', app_path: h.f.appRoot, config_name: 'primary' });
      assert.deepEqual(narrowed.sessions.map((entry: { name: string }) => entry.name), [PRIMARY]);
      assert.equal((await call({ action: 'control', command: 'continue', app_path: h.f.appRoot, config_name: 'primary' })).state, 'running');
    });

    it('is SESSION_NOT_FOUND for an unknown, ended, foreign or malformed session_id, pointing at status', async () => {
      harness();
      const fake = running();
      const id = `w1.${fake.tracked.shortId}`;
      for (const sessionId of ['w1.dbg-nothing', 'w2.dbg-abc', 'not-an-id']) {
        const error = await errorOf(call({ action: 'inspect', session_id: sessionId }));
        assert.equal(error.code, 'SESSION_NOT_FOUND', sessionId);
        assert.match(error.hint ?? '', /debug_app with action "status"/, sessionId);
      }
      endDebugSessionForTests(fake.session.id);
      const ended = await errorOf(call({ action: 'control', command: 'pause', session_id: id }));
      assert.equal(ended.code, 'SESSION_NOT_FOUND');
      assert.match(ended.message, /has ended/);
    });
  });

  describe('start', () => {
    it('launches an existing entry by name, and waits for the first stop', async () => {
      harness();
      h.confirmActions = ['hardware'];
      h.answers.push('allow');
      await applyEntry();
      h.onLaunch = () => {
        const fake = running();
        fake.stop('breakpoint', 1, 20);
        return fake;
      };
      const result = await call({ action: 'start', name: PRIMARY, wait_sec: 5 });
      assert.equal(h.launches.length, 1);
      // A freestanding application launches by name, as the Debug button does.
      assert.equal(h.launches[0].target, PRIMARY);
      assert.equal((h.launches[0].folder as vscode.WorkspaceFolder).uri.fsPath, h.f.appRoot);
      assert.match(result.session_id, /^w1\.dbg-/);
      assert.equal(result.name, PRIMARY);
      assert.equal(result.backend, 'cppdbg');
      assert.equal(result.app_path, h.f.appRoot);
      assert.equal(result.config_name, 'primary');
      assert.equal(result.state, 'stopped');
      assert.equal(result.stop.reason, 'breakpoint');
      assert.equal(result.stop.thread_id, 1);
      assert.deepEqual(result.stop.frame, { function: 'main', file: path.join(h.f.appRoot, 'src', 'main.c'), line: 12 });
      assert.equal(result.created_entry, false);
      assert.deepEqual(result.confirmation, { category: 'hardware', outcome: 'allowed' });
      assert.match(result.next, /"action": "inspect"/);
    });

    it('launches the entry of app_path and config_name, reporting a target still running at the deadline', async () => {
      harness();
      await applyEntry();
      h.onLaunch = () => running();
      const result = await call({ action: 'start', app_path: h.f.appRoot, config_name: 'primary', wait_sec: 0 });
      assert.equal(result.state, 'running');
      assert.equal(result.waited, 'timeout');
      assert.equal(result.stop, undefined);
      // Without asking: hardware is not set to Ask here.
      assert.deepEqual(h.asked, []);
      assert.equal(result.confirmation, undefined);
    });

    it('does not wait for a stop with wait_for_stop false', async () => {
      harness();
      await applyEntry();
      h.onLaunch = () => running();
      const started = Date.now();
      const result = await call({ action: 'start', wait_for_stop: false, wait_sec: 5 });
      assert.equal(result.state, 'running');
      assert.equal(result.waited, undefined);
      assert.ok(Date.now() - started < 2000);
    });

    it('creates a missing entry with the Debug Manager defaults once the user agreed, and says so', async () => {
      harness();
      h.confirmActions = ['hardware', 'settings'];
      h.answers.push('allow');
      h.onLaunch = () => running({ state: 'stopped' });
      assert.ok(!fs.existsSync(h.f.launchJsonPath));
      const result = await call({ action: 'start' });
      assert.equal(result.created_entry, true);
      assert.equal(h.asked.length, 1, 'only start asks: its dialog covers writing the entry');
      assert.match(h.asked[0], /start debugging "Zephyr Workbench Debug \[primary\]" on the board nrf52840dk\/nrf52840 with jlink \(flashes the board first\), after writing its debug configuration/);
      const written = h.f.readLaunchJson().configurations;
      assert.deepEqual(written.map((entry: { name: string }) => entry.name), [PRIMARY]);
      assert.equal(written[0].type, 'cppdbg');
      assert.equal(result.state, 'stopped');
    });

    it('writes nothing when the user declines', async () => {
      harness();
      h.confirmActions = ['hardware'];
      h.answers.push(undefined);
      const error = await errorOf(call({ action: 'start' }));
      assert.equal(error.code, 'USER_DENIED');
      assert.ok(!fs.existsSync(h.f.launchJsonPath));
      assert.equal(h.launches.length, 0);
    });

    it('refuses with the setup error when the defaults cannot make an entry, pointing at configure_debug', async () => {
      harness({ primary: { runners: ['nrfutil'], debugRunner: 'nrfutil' } });
      h.confirmActions = ['hardware'];
      const error = await errorOf(call({ action: 'start' }));
      assert.equal(error.code, 'RUNNER_UNKNOWN');
      assert.match(error.message, /has no debug configuration, and the Debug Manager defaults cannot make one/);
      assert.match(error.hint ?? '', /configure_debug with action "apply" and config_name "primary"/);
      assert.deepEqual(h.asked, []);
      assert.ok(!fs.existsSync(h.f.launchJsonPath));
    });

    it('is NOT_BUILT for a configuration never built, pointing at build_app', async () => {
      harness({ builtPrimary: false });
      const error = await errorOf(call({ action: 'start' }));
      assert.equal(error.code, 'NOT_BUILT');
      assert.match(error.hint ?? '', /build_app/);
    });

    it('is DEPENDENCY_MISSING without the adapter extension, before asking', async () => {
      harness();
      h.confirmActions = ['hardware'];
      h.extensions.clear();
      await applyEntry();
      const error = await errorOf(call({ action: 'start' }));
      assert.equal(error.code, 'DEPENDENCY_MISSING');
      assert.match(error.hint ?? '', /ms-vscode\.cpptools/);
      assert.deepEqual(h.asked, []);
      assert.equal(h.launches.length, 0);
    });

    it('returns the running session of the entry without asking or launching again', async () => {
      harness();
      h.confirmActions = ['hardware'];
      await applyEntry();
      const fake = running({ state: 'stopped' });
      const result = await call({ action: 'start' });
      assert.equal(result.already_running, true);
      assert.equal(result.session_id, `w1.${fake.tracked.shortId}`);
      assert.equal(result.state, 'stopped');
      assert.deepEqual(h.asked, []);
      assert.equal(h.launches.length, 0);
    });

    it('is BUSY while an agent flash of the application runs, pointing at job status', async () => {
      harness();
      h.confirmActions = ['hardware'];
      await applyEntry();
      let release: () => void = () => undefined;
      const { job } = h.jobs.start({
        kind: 'flash', lockKey: 'flash:jlink:default', requestKey: 'flash:x', appPath: h.f.appRoot, configName: 'primary', command: 'west flash',
        run: () => new Promise(resolve => {
          release = () => resolve({ exitCode: 0 });
        }),
      });
      const error = await errorOf(call({ action: 'start' }));
      assert.equal(error.code, 'BUSY');
      assert.match(error.hint ?? '', new RegExp(`"action": "status", "job_id": "${job.id}"`));
      assert.deepEqual(h.asked, []);
      release();
      await job.done;
    });

    it('is BUSY while any job writes the build folder, such as a command that builds', async () => {
      harness();
      await applyEntry();
      let release: () => void = () => undefined;
      const { job } = h.jobs.start({
        kind: 'run', lockKey: 'command:abc', requestKey: 'command:abc', appPath: h.f.appRoot, configName: 'primary',
        buildDir: path.join(h.f.appRoot, 'build', 'primary'), writes: ['build_dir'], command: 'west build -p always',
        run: () => new Promise(resolve => {
          release = () => resolve({ exitCode: 0 });
        }),
      });
      const error = await errorOf(call({ action: 'start' }));
      assert.equal(error.code, 'BUSY');
      assert.match(error.message, /A run job works in the build folder of primary/);
      assert.equal(h.launches.length, 0);
      release();
      await job.done;
    });

    it('is BUSY while a flash of another application runs on the same board or an unknown one, not on another board', async () => {
      harness();
      await applyEntry();
      const real = h.f.app();
      const otherRoot = path.join(h.f.root, 'other');
      const otherOn = (board: string) => Object.create(real, {
        appRootPath: { value: otherRoot },
        buildConfigs: { value: [{ name: 'primary', boardIdentifier: board }] },
      });
      let other = otherOn('nrf52840dk/nrf52840');
      h.deps.services.listApplications = async () => [real, other];
      let release: () => void = () => undefined;
      const { job } = h.jobs.start({
        kind: 'flash', lockKey: 'flash:probe:default', requestKey: 'flash:other', appPath: otherRoot, configName: 'primary', command: 'west flash',
        run: () => new Promise(resolve => {
          release = () => resolve({ exitCode: 0 });
        }),
      });
      const sameBoard = await errorOf(call({ action: 'start', app_path: h.f.appRoot }));
      assert.equal(sameBoard.code, 'BUSY');
      assert.match(sameBoard.message, /A flash of primary of another application on the same board is running/);
      assert.match(sameBoard.hint ?? '', new RegExp(`"job_id": "${job.id}"`));

      // Unknown when the application is gone from the window: refused, to be safe.
      h.deps.services.listApplications = async () => [real];
      const unknown = await errorOf(call({ action: 'start', app_path: h.f.appRoot }));
      assert.equal(unknown.code, 'BUSY');
      assert.match(unknown.message, /on a board that may be this one/);

      other = otherOn('frdm_mcxa344');
      h.deps.services.listApplications = async () => [real, other];
      h.onLaunch = () => running({ state: 'stopped' });
      const started = await call({ action: 'start', app_path: h.f.appRoot });
      assert.equal(started.state, 'stopped');
      release();
      await job.done;
    });

    it('refuses before asking when the dialog could not show the gdb server command whole, and starts when nobody is asked', async () => {
      harness();
      h.confirmActions = ['hardware'];
      await applyEntry({ runner_args: `--tool-opt=${'x'.repeat(2100)}` });
      h.onLaunch = () => running({ state: 'stopped' });
      const error = await errorOf(call({ action: 'start' }));
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.match(error.message, /cannot show the whole "gdb server" line/);
      assert.match(error.hint ?? '', /configure_debug action "apply" and runner_args/);
      assert.deepEqual([h.asked, h.launches], [[], []]);
      h.confirmActions = [];
      assert.equal((await call({ action: 'start' })).state, 'stopped');
    });

    it('asks with the gdb and the server command in the dialog, scoped to debugging this application', async () => {
      harness();
      h.confirmActions = ['hardware'];
      h.answers.push('session');
      await applyEntry();
      h.onLaunch = () => running({ state: 'stopped' });
      const result = await call({ action: 'start' });
      assert.deepEqual(result.confirmation, { category: 'hardware', outcome: 'allowed-session' });
      const subject = h.subjects.find(entry => entry.summary.startsWith('start debugging')) as ConfirmSubject & { mode?: string };
      assert.equal(subject.appPath, h.f.appRoot);
      assert.equal(subject.configName, 'primary');
      assert.equal(subject.board, 'nrf52840dk/nrf52840');
      assert.equal(subject.runner, 'jlink');
      assert.match(subject.scope, /^debug:/);
      assert.equal(subject.sessionText, 'starting debug sessions of this application');
      assert.match(h.details[0], /Allow for This Session stops asking this agent before starting debug sessions of this application until the MCP server restarts\./);
      assert.doesNotMatch(h.details[0], /flash, debug and serial send/, 'the dialog promises only what the grant covers');
      assert.deepEqual(subject.lines?.[0], `gdb: ${h.f.gdb}`);
      assert.match(subject.lines?.[1] ?? '', /^gdb server: .*debugserver .*--runner jlink/);
      assert.equal(subject.mode, 'program');
      assert.ok(h.details[0].includes(`gdb: ${h.f.gdb}`), 'the dialog names the gdb');
      assert.match(h.details[0], /\ngdb server: .*debugserver/);

      // Allow for This Session covers starting it again, and nothing else.
      endDebugSessionForTests(h.sessions[0].session.id);
      await call({ action: 'start' });
      assert.equal(h.asked.length, 1);
    });

    it('says an attach entry attaches without flashing', async () => {
      harness();
      h.confirmActions = ['hardware'];
      h.answers.push('allow');
      await applyEntry({ mode: 'attach' });
      h.onLaunch = () => running({ state: 'stopped' });
      await call({ action: 'start' });
      assert.match(h.asked[0], /\(attaches without flashing\)/);
    });

    it('catches the separate cortex-debug session the cortex-west backend starts, by its name', async () => {
      harness();
      h.extensions.add('marus25.cortex-debug');
      await applyEntry({ backend: 'cortex-west' });
      // The zephyr-workbench session never runs, so startDebugging says false.
      h.launchResult = false;
      h.onLaunch = () => {
        setTimeout(() => {
          const fake = running({ type: 'cortex-debug', configuration: { servertype: 'external', __zwServerToken: 'token-1', __zwRunner: 'openocd' } });
          fake.stop('entry', 1, 10);
        }, 20);
        return undefined;
      };
      const result = await call({ action: 'start', wait_sec: 5 });
      assert.equal(result.type, 'cortex-debug');
      assert.equal(result.backend, 'cortex-west');
      assert.equal(result.state, 'stopped');
      assert.equal(result.stop.reason, 'entry');
      assert.equal(result.runner, 'openocd', 'the runner the provider stamped on the session');
    });

    it('catches the cortex-debug session started within the cortex-west launch, as the provider does it', async () => {
      harness();
      h.extensions.add('marus25.cortex-debug');
      await applyEntry({ backend: 'cortex-west' });
      h.launchResult = false;
      h.onLaunch = () => {
        const fake = running({ type: 'cortex-debug', configuration: { servertype: 'external', __zwServerToken: 'token-2' } });
        fake.stop('entry', 1, 10);
        return fake;
      };
      const result = await call({ action: 'start', wait_sec: 5 });
      assert.equal(result.backend, 'cortex-west');
      assert.equal(result.state, 'stopped');
    });

    it('fails at once when the cortex-west launch returned without its cortex-debug session', async () => {
      harness();
      h.extensions.add('marus25.cortex-debug');
      await applyEntry({ backend: 'cortex-west' });
      h.launchResult = false;
      debugLaunchHost.minSessionWaitMs = 30000;
      const started = Date.now();
      const error = await errorOf(call({ action: 'start', wait_sec: 30 }));
      assert.ok(Date.now() - started < 2000, `waited ${Date.now() - started} ms`);
      assert.equal(error.code, 'INTERNAL');
      assert.match(error.message, /did not start its Cortex-Debug session/);
    });

    it('still waits for a cortex-west launch that has not returned, and then reports a TIMEOUT', async () => {
      harness();
      h.extensions.add('marus25.cortex-debug');
      await applyEntry({ backend: 'cortex-west' });
      vscodeStub.debug.startDebugging = () => new Promise(() => undefined);
      const error = await errorOf(call({ action: 'start', wait_sec: 0 }));
      assert.equal(error.code, 'TIMEOUT');
      assert.match(error.hint ?? '', /still be building/);
    });

    it('is INTERNAL when VS Code does not start a cppdbg session', async () => {
      harness();
      await applyEntry();
      h.launchResult = false;
      const error = await errorOf(call({ action: 'start' }));
      assert.equal(error.code, 'INTERNAL');
      assert.match(error.message, /did not start/);
    });

    it('is TIMEOUT when no session appears in time', async () => {
      harness();
      await applyEntry();
      const error = await errorOf(call({ action: 'start', wait_sec: 0 }));
      assert.equal(error.code, 'TIMEOUT');
      assert.match(error.hint ?? '', /debug_app with action "status"/);
    });

    it('refuses name together with config_name, and an unknown name', async () => {
      harness();
      await applyEntry();
      assert.equal((await errorOf(call({ action: 'start', name: PRIMARY, config_name: 'primary' }))).code, 'INVALID_ARGUMENT');
      const unknown = await errorOf(call({ action: 'start', name: 'Zephyr Workbench Debug [nope]' }));
      assert.equal(unknown.code, 'INVALID_ARGUMENT');
      assert.deepEqual(unknown.details?.names, [PRIMARY]);
    });

    // The core preset, the default, does not serve remove_or_delete.
    it('names remove_or_delete for an entry of a removed configuration only when the window serves it', async () => {
      harness();
      await applyEntry();
      const launch = h.f.readLaunchJson();
      launch.configurations.push({ ...launch.configurations[0], name: 'Zephyr Workbench Debug [gone]' });
      h.f.writeLaunchJson(launch);
      const served = await errorOf(call({ action: 'start', name: 'Zephyr Workbench Debug [gone]' }));
      assert.equal(served.code, 'CONFIG_NOT_FOUND');
      assert.match(served.hint ?? '', /^Remove it with remove_or_delete and what "debug_config", then call configure_debug/);
      h.deps.servedTools = () => new Set(TOOL_CATALOG.map(tool => tool.name).filter(name => name !== 'remove_or_delete'));
      const unserved = await errorOf(call({ action: 'start', name: 'Zephyr Workbench Debug [gone]' }));
      assert.equal(unserved.code, 'CONFIG_NOT_FOUND');
      assert.match(unserved.hint ?? '', /^Ask the user to delete it from \.vscode\/launch\.json, or to allow remove_or_delete in the AI Manager, then call configure_debug/);
      assert.deepEqual(h.asked, []);
    });

    it('launches the legacy freestanding-named entry of a west workspace application under its own name, and finds it running', async () => {
      harness();
      await applyEntry();
      // The fixture application seen as one of a west workspace whose shared
      // launch.json, at the folder above, still holds the legacy entry.
      const real = h.f.app();
      const folder = { uri: vscode.Uri.file(h.f.root), name: 'ws', index: 0 };
      const westApp = Object.create(real, {
        isWestWorkspaceApplication: { value: true },
        appWorkspaceFolder: { value: folder },
      });
      fs.mkdirSync(path.join(h.f.root, '.vscode'), { recursive: true });
      fs.copyFileSync(h.f.launchJsonPath, path.join(h.f.root, '.vscode', 'launch.json'));
      h.deps.services.listApplications = async () => [westApp];
      const canonical = 'Zephyr Workbench Debug: app [primary]';
      const savedSelect = debugLaunchHost.selectApplication;
      debugLaunchHost.selectApplication = async () => undefined;
      try {
        h.onLaunch = target => running({ folder: h.f.root, name: (target as { name: string }).name });
        const started = await call({ action: 'start', config_name: 'primary', wait_for_stop: false, wait_sec: 5 });
        assert.equal((h.launches[0].target as { name: string }).name, canonical);
        assert.equal(started.name, canonical);
        const again = await call({ action: 'start', config_name: 'primary' });
        assert.equal(again.already_running, true);
        assert.equal(h.launches.length, 1);

        // One the user started from the legacy entry itself is found too.
        resetDebugSessionTrackingForTests();
        running({ folder: h.f.root, name: PRIMARY });
        assert.equal((await call({ action: 'start', config_name: 'primary' })).already_running, true);
        assert.equal((await call({ action: 'status', app_path: real.appRootPath, config_name: 'primary' })).sessions.length, 1);
        assert.equal(h.launches.length, 1);
      } finally {
        debugLaunchHost.selectApplication = savedSelect;
      }
    });

    it('does not take a legacy-named session of the selected application for one of another application of the workspace', async () => {
      harness();
      await applyEntry();
      const real = h.f.app();
      const folder = { uri: vscode.Uri.file(h.f.root), name: 'ws', index: 0 };
      const inWorkspace = (root: string) => Object.create(real, {
        appRootPath: { value: root },
        appName: { value: path.basename(root) },
        isWestWorkspaceApplication: { value: true },
        appWorkspaceFolder: { value: folder },
      });
      const selected = inWorkspace(real.appRootPath);
      const otherRoot = path.join(h.f.root, 'other');
      fs.mkdirSync(otherRoot, { recursive: true });
      const other = inWorkspace(otherRoot);
      fs.mkdirSync(path.join(h.f.root, '.vscode'), { recursive: true });
      fs.copyFileSync(h.f.launchJsonPath, path.join(h.f.root, '.vscode', 'launch.json'));
      h.deps.services.listApplications = async () => [selected, other];
      h.deps.services.resolveApp = async (requested?: string) => (requested && path.resolve(requested) === otherRoot ? other : selected);
      const savedConfig = vscodeStub.workspace.getConfiguration;
      vscodeStub.workspace.getConfiguration = () => ({
        get: (key: string) => (key === 'westWorkspace.selectedApplication' ? real.appRootPath : undefined),
        update: async () => undefined,
      });
      try {
        // The user started the legacy entry: it debugs the selected application.
        const theirs = running({ folder: h.f.root, name: PRIMARY });
        const error = await errorOf(call({ action: 'start', app_path: otherRoot, config_name: 'primary' }));
        assert.equal(error.code, 'BUSY');
        assert.match(error.message, /legacy entry "Zephyr Workbench Debug \[primary\]" debugs/);
        const sessionId = `w1.${theirs.tracked.shortId}`;
        assert.ok(error.hint?.includes(JSON.stringify({ action: 'stop', session_id: sessionId })), error.hint);
        assert.equal(h.launches.length, 0);
        // For the selected application it is the running session.
        assert.equal((await call({ action: 'start', app_path: real.appRootPath, config_name: 'primary' })).already_running, true);
      } finally {
        vscodeStub.workspace.getConfiguration = savedConfig;
      }
    });
  });

  describe('stop', () => {
    it('stops the session, waits for its end and removes the agent breakpoints', async () => {
      harness();
      const fake = running({ state: 'stopped' });
      await call({ action: 'breakpoint', add: [{ function: 'main' }] });
      const user = new vscode.FunctionBreakpoint('user_fn');
      h.breakpoints.push(user);
      const result = await call({ action: 'stop' });
      assert.deepEqual(h.stopped, [fake.session.id]);
      assert.equal(result.state, 'terminated');
      assert.equal(result.breakpoints_removed, 1);
      assert.deepEqual(h.breakpoints, [user], 'the user\'s breakpoint stays');
      assert.deepEqual(workbenchDebugSessions(), []);
      assert.match(result.next, /hardware action "flash"/);
    });

    it('leaves the agent breakpoints while another session runs, and removes them when the last one ends', async () => {
      harness();
      const first = running();
      const second = running({ name: 'Zephyr Workbench Debug [other]' });
      await call({ action: 'breakpoint', add: [{ function: 'main' }] });
      // An earlier stop that kept them does not decide for this one.
      const kept = await call({ action: 'stop', session_id: `w1.${first.tracked.shortId}`, keep_breakpoints: true });
      assert.equal(kept.breakpoints_kept, true);
      const third = running({ name: 'Zephyr Workbench Debug [third]' });
      const result = await call({ action: 'stop', session_id: `w1.${second.tracked.shortId}` });
      assert.equal(result.state, 'terminated');
      assert.equal(result.breakpoints_removed, 0);
      assert.match(result.breakpoints_note, /stay while another Workbench session runs/);
      assert.equal(h.breakpoints.length, 1, 'the session still running keeps them');
      endDebugSessionForTests(third.session.id);
      assert.deepEqual(h.breakpoints, [], 'gone with the last session');
    });

    it('keeps the agent breakpoints with keep_breakpoints, even when the last session ends', async () => {
      harness();
      running();
      await call({ action: 'breakpoint', add: [{ function: 'main' }] });
      const result = await call({ action: 'stop', keep_breakpoints: true });
      assert.equal(result.breakpoints_kept, true);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(h.breakpoints.length, 1);
      assert.equal(agentBreakpointIdsForTests().length, 1);
    });
  });

  describe('status', () => {
    it('lists every Workbench session with its state, stop, frame and output', async () => {
      harness();
      const first = running({ state: 'stopped' });
      first.print('Reading symbols\n');
      const second = running({ name: 'Zephyr Workbench Debug [other]', type: 'cortex-debug' });
      const result = await call({ action: 'status' });
      assert.equal(result.sessions.length, 2);
      const [a, b] = result.sessions;
      assert.equal(a.session_id, `w1.${first.tracked.shortId}`);
      assert.equal(a.state, 'stopped');
      assert.equal(a.app_path, h.f.appRoot);
      assert.equal(a.config_name, 'primary');
      assert.equal(a.stop.frame.function, 'main');
      assert.equal(a.output_tail, 'Reading symbols');
      assert.match(a.started_at, /^\d{4}-/);
      assert.equal(b.session_id, `w1.${second.tracked.shortId}`);
      assert.equal(b.state, 'running');
      assert.equal(b.backend, 'cortex-native');
      assert.equal(b.stop, undefined);
    });

    it('gives an empty list and the way to start one', async () => {
      harness();
      const result = await call({ action: 'status' });
      assert.deepEqual(result.sessions, []);
      assert.match(result.next, /debug_app with action "start"/);
    });
  });

  describe('breakpoint', () => {
    it('adds function and source breakpoints through VS Code, and lists all of them', async () => {
      harness();
      const main = path.join(h.f.appRoot, 'src', 'main.c');
      const user = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(main), new vscode.Position(0, 0)));
      h.breakpoints.push(user);
      const result = await call({
        action: 'breakpoint',
        add: [
          { function: 'k_panic_handler', condition: 'reason == 3' },
          { path: main, line: 5, hit_condition: '>= 2' },
          { path: main, line: 7, log_message: 'count is {count}' },
        ],
      });
      assert.equal(result.added.length, 3);
      assert.equal(result.session_id, undefined);
      assert.match(result.next, /No session runs/);
      const byId = new Map(result.breakpoints.map((bp: { id: string }) => [bp.id, bp]));
      const fn = byId.get(result.added[0]) as any;
      assert.deepEqual({ kind: fn.kind, function: fn.function, condition: fn.condition, added_by_agent: fn.added_by_agent },
        { kind: 'function', function: 'k_panic_handler', condition: 'reason == 3', added_by_agent: true });
      const src = byId.get(result.added[1]) as any;
      assert.deepEqual({ kind: src.kind, path: src.path, line: src.line, hit: src.hit_condition }, { kind: 'source', path: main, line: 5, hit: '>= 2' });
      assert.equal((byId.get(result.added[2]) as any).log_message, 'count is {count}');
      const theirs = byId.get(user.id) as any;
      assert.equal(theirs.added_by_agent, false);
      assert.equal(theirs.line, 1);
      assert.equal(h.breakpoints.length, 4);

      // The same place again is not added twice.
      const again = await call({ action: 'breakpoint', add: [{ path: main, line: 5 }] });
      assert.deepEqual(again.added, []);
      assert.deepEqual(again.already_set, [{ index: 0, id: result.added[1] }]);
    });

    it('shows what the running session made of each breakpoint', async () => {
      harness();
      const fake = running({ dapBreakpoints: {} });
      const result = await call({ action: 'breakpoint', add: [{ function: 'main' }, { function: 'nowhere' }] });
      assert.equal(result.session_id, `w1.${fake.tracked.shortId}`);
      const [ok, bad] = result.added;
      // Answered by id, now that the ids are known.
      (fake.session as any).getDebugProtocolBreakpoint = async (bp: vscode.Breakpoint) => (bp.id === ok
        ? { verified: true, line: 12 }
        : { verified: false, message: 'No symbol "nowhere" in current context.' });
      const listed = await call({ action: 'breakpoint' });
      const byId = new Map(listed.breakpoints.map((bp: { id: string }) => [bp.id, bp]));
      assert.deepEqual((byId.get(ok) as any).in_session, { verified: true, line: 12 });
      assert.deepEqual((byId.get(bad) as any).in_session, { verified: false, message: 'No symbol "nowhere" in current context.' });
      assert.match(listed.next, /1 of the agent's breakpoints are not verified/);
    });

    it('removes the agent breakpoints by id or all at once, never the user\'s', async () => {
      harness();
      const user = new vscode.FunctionBreakpoint('user_fn');
      h.breakpoints.push(user);
      const added = await call({ action: 'breakpoint', add: [{ function: 'a' }, { function: 'b' }, { function: 'c' }] });
      const removed = await call({ action: 'breakpoint', remove: [added.added[0]] });
      assert.deepEqual(removed.removed, [added.added[0]]);
      assert.equal(h.breakpoints.length, 3);
      const refused = await errorOf(call({ action: 'breakpoint', remove: [user.id] }));
      assert.equal(refused.code, 'INVALID_ARGUMENT');
      assert.match(refused.message, /set by the user/);
      assert.equal((await errorOf(call({ action: 'breakpoint', remove: ['nope'] }))).code, 'INVALID_ARGUMENT');
      const cleared = await call({ action: 'breakpoint', clear: true });
      assert.equal(cleared.cleared, 2);
      assert.deepEqual(h.breakpoints, [user]);
      assert.deepEqual(cleared.breakpoints.map((bp: { id: string }) => bp.id), [user.id]);
    });

    it('checks every breakpoint before adding any', async () => {
      harness();
      const main = path.join(h.f.appRoot, 'src', 'main.c');
      const outside = path.join(os.tmpdir(), 'zw-outside.c');
      fs.writeFileSync(outside, '');
      const cases: [Record<string, unknown>, string, RegExp][] = [
        [{ path: main }, 'INVALID_ARGUMENT', /needs line/],
        [{ path: 'src/main.c', line: 1 }, 'INVALID_ARGUMENT', /absolute/],
        [{ path: path.join(h.f.appRoot, 'src', 'nope.c'), line: 1 }, 'INVALID_ARGUMENT', /not an existing file/],
        [{ path: outside, line: 1 }, 'PATH_OUTSIDE_WORKSPACE', /outside/],
        [{ function: 'main', path: main, line: 1 }, 'INVALID_ARGUMENT', /not both/],
        [{}, 'INVALID_ARGUMENT', /needs function/],
        [{ function: 'main; shell' }, 'INVALID_ARGUMENT', /not a function name/],
        [{ function: 'main', colour: 'red' }, 'INVALID_ARGUMENT', /does not take colour/],
        // gdb evaluates these on every hit, and adding a breakpoint asks no one.
        [{ function: 'main', condition: 'count = 3' }, 'INVALID_ARGUMENT', /condition .*would change the target/],
        [{ function: 'main', condition: 'log_and_reset()' }, 'INVALID_ARGUMENT', /condition .*function call/],
        [{ path: main, line: 1, log_message: 'hits {hits++}' }, 'INVALID_ARGUMENT', /log_message "hits\+\+" would change the target/],
      ];
      for (const [bad, code, message] of cases) {
        const error = await errorOf(call({ action: 'breakpoint', add: [{ function: 'fine' }, bad] }));
        assert.equal(error.code, code, JSON.stringify(bad));
        assert.match(error.message, message, JSON.stringify(bad));
      }
      assert.deepEqual(h.breakpoints, [], 'nothing was added');
    });

    it('refuses $_shell in a condition or a log message, which gdb evaluates on the host', async () => {
      harness();
      for (const bad of [
        { function: 'main', condition: '$_shell("calc")==0' },
        { function: 'main', hit_condition: '$_shell("calc")' },
        { function: 'main', log_message: 'x={$_shell("calc")}' },
        { function: 'main', log_message: '"%d", $_shell("calc")' },
        { function: 'main', log_message: 'x={-exec shell calc}' },
        { function: 'main', condition: 'a == 1\nshell calc' },
      ]) {
        const error = await errorOf(call({ action: 'breakpoint', add: [bad] }));
        assert.equal(error.code, 'INVALID_ARGUMENT', JSON.stringify(bad));
        assert.match(error.message, /condition|hit_condition|log_message/);
      }
      assert.deepEqual(h.breakpoints, [], 'nothing was added');
    });

    it('checks what gdb\'s dprintf evaluates in a log message, and refuses a double quote in a condition', async () => {
      harness();
      const main = path.join(h.f.appRoot, 'src', 'main.c');
      const cases: [Record<string, unknown>, RegExp][] = [
        // Cortex-Debug appends the message to dprintf-insert: each word after the format is an argument.
        [{ path: main, line: 1, log_message: '"%d", f()' }, /log_message "f\(\)" would change the target .*function call.*dprintf/],
        [{ path: main, line: 1, log_message: 'n=%d reset_counters()' }, /log_message "reset_counters\(\)" would change/],
        [{ path: main, line: 1, log_message: '"%d" "reset()"' }, /log_message "reset\(\)" would change/],
        [{ path: main, line: 1, log_message: 'hits x=1' }, /log_message "x=1" would change/],
        [{ path: main, line: 1, log_message: '"%d" -foo' }, /log_message: "-foo": .*gdb command/],
        [{ function: 'main', condition: 'name == "x"' }, /condition holds a double quote/],
        [{ function: 'main', hit_condition: '"5"' }, /hit_condition holds a double quote/],
      ];
      for (const [bad, message] of cases) {
        const error = await errorOf(call({ action: 'breakpoint', add: [bad] }));
        assert.equal(error.code, 'INVALID_ARGUMENT', JSON.stringify(bad));
        assert.match(error.message, message, JSON.stringify(bad));
      }
      assert.deepEqual(h.breakpoints, [], 'nothing was added');
      // Text that only reads still passes, with its words and braces.
      const fine = await call({
        action: 'breakpoint',
        add: [{ path: main, line: 2, log_message: 'x = {x} (count is {count})' }, { path: main, line: 3, log_message: '"%d items" count' }, { function: 'main', condition: "name[0] == 'A'" }],
      });
      assert.equal(fine.added.length, 3);
    });

    it('waits a little for the session to answer for new breakpoints, and reports an unverified one in the same call', async () => {
      harness();
      const fake = running();
      const asked = new Map<string, number>();
      (fake.session as any).getDebugProtocolBreakpoint = async (bp: vscode.Breakpoint) => {
        const count = (asked.get(bp.id) ?? 0) + 1;
        asked.set(bp.id, count);
        if (count <= 2) {
          return undefined;
        }
        return (bp as vscode.FunctionBreakpoint).functionName === 'nowhere'
          ? { verified: false, message: 'No symbol "nowhere" in current context.' }
          : { verified: true, line: 12 };
      };
      const result = await call({ action: 'breakpoint', add: [{ function: 'main' }, { function: 'nowhere' }] });
      const byId = new Map(result.breakpoints.map((bp: { id: string }) => [bp.id, bp]));
      assert.deepEqual((byId.get(result.added[1]) as any).in_session, { verified: false, message: 'No symbol "nowhere" in current context.' });
      assert.deepEqual((byId.get(result.added[0]) as any).in_session, { verified: true, line: 12 });
      assert.match(result.next, /1 of the agent's breakpoints are not verified/);
    });

    it('does not claim new breakpoints are ready when the session has not answered for them', async () => {
      harness();
      running({ dapBreakpoints: {} });
      const started = Date.now();
      const result = await call({ action: 'breakpoint', add: [{ function: 'main' }] });
      assert.ok(Date.now() - started < 1000);
      assert.equal(result.breakpoints[0].in_session, undefined);
      assert.match(result.next, /has not confirmed 1 new breakpoint yet: call debug_app with action "breakpoint" alone/);
    });

    describe('across a reload of the extension host', () => {
      const memento = () => {
        const data = new Map<string, unknown>();
        return { data, get: (key: string) => data.get(key), update: async (key: string, value: unknown) => { data.set(key, value); }, keys: () => [...data.keys()] } as unknown as vscode.Memento & { data: Map<string, unknown> };
      };
      const STORE = 'zephyr-workbench.mcp.agentBreakpoints';

      /** What VS Code hands a new extension host: the same breakpoints, with new ids. */
      function reload(state: vscode.Memento): void {
        resetAgentBreakpointsForTests();
        h.breakpoints = h.breakpoints.map(bp => (bp instanceof vscode.FunctionBreakpoint
          ? new vscode.FunctionBreakpoint(bp.functionName, bp.enabled, bp.condition)
          : new vscode.SourceBreakpoint((bp as vscode.SourceBreakpoint).location, bp.enabled, bp.condition)));
        initAgentBreakpoints(state);
      }

      it('keeps the agent\'s breakpoints its own, so remove and clear still work', async () => {
        harness();
        const state = memento();
        initAgentBreakpoints(state);
        const main = path.join(h.f.appRoot, 'src', 'main.c');
        const added = await call({ action: 'breakpoint', add: [{ function: 'main' }, { path: main, line: 5 }] });
        const user = new vscode.FunctionBreakpoint('user_fn');
        h.breakpoints.push(user);
        assert.equal((state.data.get(STORE) as unknown[]).length, 2);

        reload(state);
        const listed = await call({ action: 'breakpoint' });
        const mine = listed.breakpoints.filter((bp: { added_by_agent: boolean }) => bp.added_by_agent);
        assert.equal(mine.length, 2);
        assert.ok(!mine.some((bp: { id: string }) => added.added.includes(bp.id)), 'the ids are new');
        assert.equal(listed.breakpoints.find((bp: { function?: string }) => bp.function === 'user_fn').added_by_agent, false);

        const removed = await call({ action: 'breakpoint', remove: [mine[0].id] });
        assert.deepEqual(removed.removed, [mine[0].id]);
        assert.equal((state.data.get(STORE) as unknown[]).length, 1);
        const cleared = await call({ action: 'breakpoint', clear: true });
        assert.equal(cleared.cleared, 1);
        assert.equal(h.breakpoints.length, 1);
        assert.equal((h.breakpoints[0] as vscode.FunctionBreakpoint).functionName, 'user_fn');
        assert.equal(state.data.get(STORE), undefined);
      });

      it('forgets a stored breakpoint the user deleted, and never takes a user breakpoint elsewhere', async () => {
        harness();
        agentBreakpointTiming.claimWindowMs = 30;
        const state = memento();
        initAgentBreakpoints(state);
        await call({ action: 'breakpoint', add: [{ function: 'main' }, { function: 'gone' }] });
        // The user deletes "gone" while no extension host runs, and sets one elsewhere.
        h.breakpoints = h.breakpoints.filter(bp => (bp as vscode.FunctionBreakpoint).functionName !== 'gone');
        h.breakpoints.push(new vscode.FunctionBreakpoint('user_fn'));
        reload(state);
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.deepEqual(state.data.get(STORE), [{ kind: 'function', function: 'main' }]);
        const listed = await call({ action: 'breakpoint' });
        assert.deepEqual(listed.breakpoints.map((bp: { function: string; added_by_agent: boolean }) => [bp.function, bp.added_by_agent]),
          [['main', true], ['user_fn', false]]);
        // A user breakpoint set later where "gone" was is the user's.
        h.breakpoints.push(new vscode.FunctionBreakpoint('gone'));
        const again = await call({ action: 'breakpoint' });
        assert.equal(again.breakpoints.find((bp: { function: string }) => bp.function === 'gone').added_by_agent, false);
      });

      it('removes the claimed breakpoints when the last session ends, and empties the store', async () => {
        harness();
        const state = memento();
        initAgentBreakpoints(state);
        await call({ action: 'breakpoint', add: [{ function: 'main' }] });
        reload(state);
        const fake = running();
        endDebugSessionForTests(fake.session.id);
        assert.deepEqual(h.breakpoints, []);
        assert.equal(state.data.get(STORE), undefined);
      });
    });

    it('removes the agent breakpoints when the last Workbench session ends', async () => {
      harness();
      const first = running();
      const second = running({ name: 'Zephyr Workbench Debug [other]' });
      await call({ action: 'breakpoint', add: [{ function: 'main' }] });
      endDebugSessionForTests(first.session.id);
      assert.equal(h.breakpoints.length, 1, 'a session still runs');
      endDebugSessionForTests(second.session.id);
      assert.deepEqual(h.breakpoints, []);
    });
  });
});
