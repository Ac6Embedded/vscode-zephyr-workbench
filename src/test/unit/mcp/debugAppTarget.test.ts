// debug_app on the host side, for the actions on the target of a running
// session: control, inspect and gdb. A session is a fake that answers
// scripted DAP requests the way cppdbg and cortex-debug 1.12 do (a Registers
// scope, readMemory, read-memory, read-registers, execute-command, gdb text
// arriving as output events), so no adapter, gdb or board is ever used.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { resetDebugSessionTrackingForTests } from '../../../debug/sessionTracker';
import { findTool, TOOL_CATALOG } from '../../../mcp/core/catalog';
import { McpToolError } from '../../../mcp/core/errors';
import { ConfirmCategory, permissionForCategories, ToolContext } from '../../../mcp/core/toolSpec';
import { AskAnswer, Confirmations, ConfirmSubject } from '../../../mcp/host/confirmations';
import { debugApp } from '../../../mcp/host/handlers/debugApp';
import { HostDeps } from '../../../mcp/host/handlers/deps';
import { HostServices } from '../../../mcp/host/services';
import { JobManager } from '../../../mcp/jobs/jobManager';
import { DebugFixture, makeDebugFixture } from '../debugTestFixture';
import { FakeDebugSession, fakeDebugSession, FakeSessionOptions, frame } from './debugSessionFake';
import { useUiGuard } from './uiGuard';

interface Harness {
  f: DebugFixture;
  deps: HostDeps;
  asked: string[];
  /** The detail of each dialog, in the same order as asked. */
  details: string[];
  answers: AskAnswer[];
  confirmActions: ConfirmCategory[];
  subjects: ConfirmSubject[];
}

let h: Harness;

function harness(): Harness {
  const f = makeDebugFixture();
  const services = new HostServices(vscode.Uri.file(os.tmpdir()));
  services.listApplications = async () => [f.app()];
  services.knownRoots = async () => [f.root];
  const state = { f, asked: [], details: [], answers: [], confirmActions: [], subjects: [] } as unknown as Harness;
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
    services,
    jobs: new JobManager({ logPathFor: id => path.join(f.root, `${id}.log`) }),
    confirmations,
    defaultWaitSeconds: 2,
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

function ctx(): ToolContext<HostDeps> {
  return {
    signal: new AbortController().signal,
    progress: () => undefined,
    client: { name: 'test-agent', version: '1', instance: 'agent-1' },
    deps: h.deps,
    tool: findTool('debug_app')!,
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

const MAIN_C = () => path.join(h.f.appRoot, 'src', 'main.c');
const OPENOCD_ARGS = 'debugserver --build-dir "${workspaceFolder}/build/primary" --runner openocd --gdb-port 3333';

/** A session of the fixture's application, with the frames and threads every inspect reads. */
function session(options: Partial<FakeSessionOptions> = {}): FakeDebugSession {
  return fakeDebugSession({
    folder: h.f.appRoot,
    configuration: { debugServerArgs: OPENOCD_ARGS },
    ...options,
    handlers: {
      threads: () => ({ threads: [{ id: 1, name: 'main' }, { id: 2, name: 'sysworkq' }] }),
      stackTrace: args => ({
        stackFrames: args.threadId === 2
          ? [frame(2000, 'k_sem_take', path.join(h.f.appRoot, 'src', 'work.c'), 40)]
          : [frame(1000, 'fault_here', MAIN_C(), 7), frame(1001, 'main', MAIN_C(), 20), frame(1002, 'bg_thread_main')].slice(0, args.levels),
      }),
      ...(options.handlers ?? {}),
    },
  });
}

/** The fault block: CFSR PRECISERR|BFARVALID, HFSR FORCED, BFAR 0x40001234. */
const FAULT_BYTES = [0x00, 0x82, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0, 0, 0, 0, 0, 0, 0, 0, 0x34, 0x12, 0x00, 0x40];

describe('debug_app target actions', () => {
  useUiGuard();

  beforeEach(() => resetDebugSessionTrackingForTests());
  afterEach(() => {
    resetDebugSessionTrackingForTests();
    h?.f.restore();
  });

  describe('control', () => {
    it('continues a stopped target without waiting by default', async () => {
      harness();
      const fake = session({ state: 'stopped', threadId: 3, handlers: { continue: () => ({ allThreadsContinued: true }) } });
      const result = await call({ action: 'control', command: 'continue' });
      assert.deepEqual(fake.requests.find(r => r.command === 'continue')?.args, { threadId: 3 });
      assert.equal(result.state, 'running');
      assert.equal(result.waited, undefined);
      assert.match(result.next, /The target runs/);
    });

    it('continues and waits for the breakpoint with wait_for_stop', async () => {
      harness();
      const fake = session({ state: 'stopped', handlers: { continue: (_args, f) => f.stop('breakpoint', 1, 20) } });
      const result = await call({ action: 'control', command: 'continue', wait_for_stop: true, wait_sec: 5 });
      assert.equal(fake.tracked.stopCount, 2);
      assert.equal(result.waited, 'stopped');
      assert.equal(result.state, 'stopped');
      assert.deepEqual(result.stop.frame, { function: 'fault_here', file: MAIN_C(), line: 7 });
    });

    it('reports a target still running when wait_sec runs out', async () => {
      harness();
      session({ state: 'stopped', handlers: { continue: () => undefined } });
      const result = await call({ action: 'control', command: 'continue', wait_for_stop: true, wait_sec: 0 });
      assert.equal(result.waited, 'timeout');
      assert.equal(result.state, 'running');
      assert.match(result.next, /still runs after wait_sec/);
    });

    for (const [command, request] of [['step_over', 'next'], ['step_into', 'stepIn'], ['step_out', 'stepOut']]) {
      it(`${command} sends ${request} on the thread that stopped and waits for the step`, async () => {
        harness();
        const fake = session({ state: 'stopped', threadId: 1, handlers: { [request]: (_args, f) => f.stop('step', 1, 10) } });
        const result = await call({ action: 'control', command });
        assert.deepEqual(fake.requests.find(r => r.command === request)?.args, { threadId: 1 });
        assert.equal(result.waited, 'stopped');
        assert.equal(result.stop.reason, 'step');
      });
    }

    it('takes thread_id for a step', async () => {
      harness();
      const fake = session({ state: 'stopped', threadId: 1, handlers: { next: (_args, f) => f.stop('step', 2, 5) } });
      await call({ action: 'control', command: 'step_over', thread_id: 2 });
      assert.deepEqual(fake.requests.find(r => r.command === 'next')?.args, { threadId: 2 });
    });

    it('refuses a step while the target runs with TARGET_RUNNING, pointing at pause', async () => {
      harness();
      const fake = session();
      const error = await errorOf(call({ action: 'control', command: 'step_over' }));
      assert.equal(error.code, 'TARGET_RUNNING');
      assert.match(error.hint ?? '', /debug_app with action "control" and command "pause"/);
      assert.deepEqual(fake.requests, []);
    });

    it('pauses a running target and waits for it to stop', async () => {
      harness();
      const fake = session({ handlers: { pause: (_args, f) => f.stop('pause', 1, 10) } });
      const result = await call({ action: 'control', command: 'pause' });
      assert.ok(fake.requests.some(r => r.command === 'pause'));
      assert.equal(result.state, 'stopped');
      assert.equal(result.stop.reason, 'pause');
      // Already stopped: nothing is sent.
      const again = await call({ action: 'control', command: 'pause' });
      assert.equal(again.note, 'The target was already stopped.');
      assert.equal(fake.requests.filter(r => r.command === 'pause').length, 1);
    });

    it('restarts with the restart request when the adapter has one (cortex-debug)', async () => {
      harness();
      const fake = session({
        type: 'cortex-debug', configuration: {}, state: 'stopped', capabilities: { supportsRestartRequest: true },
        handlers: { restart: (_args, f) => f.stop('entry', 1, 10) },
      });
      const result = await call({ action: 'control', command: 'restart' });
      assert.ok(fake.requests.some(r => r.command === 'restart'));
      assert.equal(result.waited, 'stopped');
      assert.equal(result.stop.reason, 'entry');
    });

    it('does not wait on the restart answer that cortex-debug never sends: the stop after the reset answers', async () => {
      harness();
      const fake = session({
        type: 'cortex-debug', configuration: {}, state: 'stopped', capabilities: { supportsRestartRequest: true },
        handlers: {
          restart: (_args, f) => {
            f.stop('entry', 1, 10);
            return new Promise(() => undefined);
          },
        },
      });
      const result = await call({ action: 'control', command: 'restart', wait_sec: 5 });
      assert.ok(fake.requests.some(r => r.command === 'restart'));
      assert.equal(result.waited, 'stopped');
      assert.equal(result.state, 'stopped');
      assert.equal(result.stop.reason, 'entry');
    });

    it('reports a restart neither answered nor stopped as a timeout within wait_sec', async () => {
      harness();
      session({
        type: 'cortex-debug', configuration: {}, state: 'stopped', capabilities: { supportsRestartRequest: true },
        handlers: { restart: () => new Promise(() => undefined) },
      });
      const started = Date.now();
      const result = await call({ action: 'control', command: 'restart', wait_sec: 1 });
      assert.ok(Date.now() - started < 3000, 'the call ends at wait_sec');
      assert.equal(result.waited, 'timeout');
      assert.match(result.note, /has not answered the restart request/);
    });

    it('turns a refused restart request into INTERNAL', async () => {
      harness();
      session({
        type: 'cortex-debug', configuration: {}, state: 'stopped', capabilities: { supportsRestartRequest: true },
        handlers: { restart: () => { throw new Error('Could not restart/reset: no target'); } },
      });
      const error = await errorOf(call({ action: 'control', command: 'restart', wait_sec: 5 }));
      assert.equal(error.code, 'INTERNAL');
      assert.match(error.message, /refused the restart request: Could not restart\/reset/);
    });

    it('keeps the target stopped when the step\'s stop comes before the answer to the step', async () => {
      harness();
      session({
        state: 'stopped',
        handlers: {
          next: (_args, f) => {
            // cortex-debug sends the stopped event of a short step before answering it.
            f.stop('step', 1);
            return {};
          },
          scopes: () => ({ scopes: [] }),
        },
      });
      const result = await call({ action: 'control', command: 'step_over' });
      assert.equal(result.state, 'stopped');
      assert.equal(result.waited, 'stopped');
      assert.equal(result.stop.reason, 'step');
      const inspected = await call({ action: 'inspect', include: ['backtrace'] });
      assert.equal(inspected.backtrace[0].function, 'fault_here');
    });

    it('restarts a cppdbg session with the monitor reset of its runner', async () => {
      harness();
      const fake = session({ state: 'stopped', handlers: { evaluate: () => ({ result: '' }) } });
      const result = await call({ action: 'control', command: 'restart' });
      const sent = fake.requests.filter(r => r.command === 'evaluate').map(r => r.args);
      assert.deepEqual(sent[0], { expression: '-exec monitor reset halt', context: 'repl', frameId: 1000 });
      assert.equal(sent[1].expression, '-exec maintenance flush register-cache');
      assert.equal(result.state, 'stopped');
      assert.match(result.note, /monitor reset halt/);
    });

    it('uses J-Link\'s own monitor reset', async () => {
      harness();
      const fake = session({ state: 'stopped', configuration: { debugServerArgs: OPENOCD_ARGS.replace('openocd', 'jlink') }, handlers: { evaluate: () => ({}) } });
      await call({ action: 'control', command: 'restart' });
      assert.equal(fake.requests.find(r => r.command === 'evaluate')?.args.expression, '-exec monitor reset');
    });

    it('refuses to restart a cppdbg session whose gdb server has no monitor reset', async () => {
      harness();
      session({ state: 'stopped', configuration: { debugServerArgs: OPENOCD_ARGS.replace('openocd', 'stlink_gdbserver') } });
      const error = await errorOf(call({ action: 'control', command: 'restart' }));
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.match(error.hint ?? '', /action "stop", then action "start"/);
    });

    it('refuses a bad command, and turns an adapter refusal into INTERNAL', async () => {
      harness();
      session({ state: 'stopped', handlers: { next: () => { throw new Error('Cannot step now'); } } });
      assert.equal((await errorOf(call({ action: 'control', command: 'jump' }))).code, 'INVALID_ARGUMENT');
      const refused = await errorOf(call({ action: 'control', command: 'step_over' }));
      assert.equal(refused.code, 'INTERNAL');
      assert.match(refused.message, /Cannot step now/);
    });
  });

  describe('inspect', () => {
    it('refuses a running target with TARGET_RUNNING, pointing at pause', async () => {
      harness();
      session();
      const error = await errorOf(call({ action: 'inspect' }));
      assert.equal(error.code, 'TARGET_RUNNING');
      assert.match(error.hint ?? '', /command "pause"/);
    });

    it('reads the backtrace and the locals of the frame by default, expanding structures to depth', async () => {
      harness();
      const fake = session({
        state: 'stopped',
        handlers: {
          scopes: args => ({ scopes: args.frameId === 1000
            ? [{ name: 'Locals', variablesReference: 10 }, { name: 'Registers', variablesReference: 20 }, { name: 'Global', variablesReference: 30 }]
            : [] }),
          variables: args => ({
            10: { variables: [{ name: 'count', value: '3', type: 'int', variablesReference: 0 }, { name: 'cfg', value: '{...}', type: 'struct cfg', variablesReference: 11 }] },
            11: { variables: [{ name: 'speed', value: '115200', variablesReference: 0 }, { name: 'inner', value: '{...}', variablesReference: 12 }] },
            12: { variables: [{ name: 'deep', value: '1', variablesReference: 0 }] },
          } as Record<number, unknown>)[args.variablesReference],
        },
      });
      const result = await call({ action: 'inspect' });
      assert.deepEqual(result.backtrace.map((f: { function: string }) => f.function), ['fault_here', 'main', 'bg_thread_main']);
      assert.deepEqual(result.backtrace[1], { index: 1, function: 'main', file: MAIN_C(), line: 20 });
      assert.deepEqual(result.at, { function: 'fault_here', file: MAIN_C(), line: 7 });
      assert.deepEqual(result.locals, [{
        scope: 'Locals',
        variables: [
          { name: 'count', value: '3', type: 'int' },
          { name: 'cfg', value: '{...}', type: 'struct cfg', children: [{ name: 'speed', value: '115200' }, { name: 'inner', value: '{...}' }] },
        ],
      }]);
      assert.ok(!fake.requests.some(r => r.command === 'variables' && r.args.variablesReference === 30), 'globals are not read as locals');
      assert.equal(fake.requests.find(r => r.command === 'stackTrace')?.args.levels, 32);
      // depth 2 goes one level further.
      const deeper = await call({ action: 'inspect', include: ['locals'], depth: 2 });
      assert.deepEqual(deeper.locals[0].variables[1].children[1].children, [{ name: 'deep', value: '1' }]);
      assert.equal(deeper.backtrace, undefined);
    });

    it('reads another frame and another thread', async () => {
      harness();
      const fake = session({ state: 'stopped', handlers: { scopes: () => ({ scopes: [{ name: 'Locals', variablesReference: 10 }] }), variables: () => ({ variables: [] }) } });
      const result = await call({ action: 'inspect', frame: 1, include: ['locals'] });
      assert.equal(result.at.function, 'main');
      assert.equal(fake.requests.find(r => r.command === 'scopes')?.args.frameId, 1001);
      const other = await call({ action: 'inspect', thread_id: 2, include: ['backtrace'] });
      assert.equal(other.thread_id, 2);
      assert.equal(other.backtrace[0].function, 'k_sem_take');
      assert.equal((await errorOf(call({ action: 'inspect', frame: 9 }))).code, 'INVALID_ARGUMENT');
    });

    it('reads the registers from a Registers scope with groups (cppdbg)', async () => {
      harness();
      session({
        state: 'stopped',
        handlers: {
          scopes: () => ({ scopes: [{ name: 'Locals', variablesReference: 10 }, { name: 'Registers', variablesReference: 20 }] }),
          variables: args => ({
            20: { variables: [{ name: 'CPU', value: '', variablesReference: 21 }] },
            21: { variables: [{ name: 'r0', value: '0x00000001', variablesReference: 0 }, { name: 'pc', value: '0x08000abc', variablesReference: 0 }] },
          } as Record<number, unknown>)[args.variablesReference],
        },
      });
      const result = await call({ action: 'inspect', include: ['registers'] });
      assert.deepEqual(result.registers, {
        via: 'Registers scope',
        registers: [{ name: 'r0', value: '0x00000001', group: 'CPU' }, { name: 'pc', value: '0x08000abc', group: 'CPU' }],
      });
    });

    it('reads the registers with read-register-list and read-registers (cortex-debug)', async () => {
      harness();
      const fake = session({
        type: 'cortex-debug', configuration: {}, state: 'stopped',
        handlers: {
          scopes: () => ({ scopes: [{ name: 'Local', variablesReference: 10 }] }),
          'read-register-list': () => ['r0', 'r1', '', 'sp'],
          'read-registers': () => [{ number: '0', value: '0x1' }, { number: '1', value: '0x2' }, { number: '3', value: '0x20001000' }],
        },
      });
      const result = await call({ action: 'inspect', include: ['registers'] });
      assert.deepEqual(result.registers, {
        via: 'read-registers',
        registers: [{ name: 'r0', value: '0x1' }, { name: 'r1', value: '0x2' }, { name: 'sp', value: '0x20001000' }],
      });
      assert.deepEqual(fake.requests.find(r => r.command === 'read-registers')?.args, { hex: true });
    });

    it('reads the registers with info registers when there is nothing else (cppdbg)', async () => {
      harness();
      session({
        state: 'stopped',
        handlers: {
          scopes: () => ({ scopes: [] }),
          evaluate: (args, f) => {
            assert.equal(args.expression, '-exec info registers');
            assert.equal(args.context, 'repl');
            f.print('r0             0x0                 0\n');
            f.print('pc             0x8000abc           0x8000abc <main+12>\n', 30);
            return { result: '' };
          },
        },
      });
      const result = await call({ action: 'inspect', include: ['registers'] });
      assert.deepEqual(result.registers, { via: 'info registers', registers: [{ name: 'r0', value: '0x0' }, { name: 'pc', value: '0x8000abc' }] });
    });

    it('reads memory with readMemory, at an address or an expression', async () => {
      harness();
      const fake = session({
        state: 'stopped', capabilities: { supportsReadMemoryRequest: true },
        handlers: {
          readMemory: args => ({ address: args.memoryReference, data: Buffer.from(Array.from({ length: args.count }, (_, i) => i)).toString('base64') }),
          evaluate: args => ({ result: '(uint8_t *) 0x20000100 <buffer>', ...(args.expression === '&buffer' ? {} : {}) }),
        },
      });
      const result = await call({ action: 'inspect', memory: { address: '0x20000000', length: 20 } });
      assert.deepEqual(result.memory, {
        address: '0x20000000', length: 20, via: 'readMemory',
        hex: '00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f\n10 11 12 13',
      });
      assert.equal(result.backtrace, undefined, 'memory alone reads nothing else');
      assert.deepEqual(fake.requests.find(r => r.command === 'readMemory')?.args, { memoryReference: '0x20000000', offset: 0, count: 20 });
      const byExpression = await call({ action: 'inspect', memory: { address: '&buffer', length: 4 } });
      assert.equal(byExpression.memory.address, '0x20000100');
      assert.equal(fake.requests.filter(r => r.command === 'evaluate')[0].args.context, 'watch');
    });

    it('reads memory with cortex-debug\'s read-memory when readMemory is not advertised', async () => {
      harness();
      const fake = session({
        type: 'cortex-debug', configuration: {}, state: 'stopped',
        handlers: { 'read-memory': args => ({ startAddress: args.address, endAddress: '0x20000004', bytes: [0xde, 0xad, 0xbe, 0xef] }) },
      });
      const result = await call({ action: 'inspect', memory: { address: '536870912', length: 4 } });
      assert.deepEqual(result.memory, { address: '0x20000000', length: 4, via: 'read-memory', hex: 'de ad be ef' });
      assert.deepEqual(fake.requests.find(r => r.command === 'read-memory')?.args, { address: '0x20000000', length: 4 });
    });

    it('reads memory with gdb x through the adapter as the last way', async () => {
      harness();
      session({
        state: 'stopped',
        handlers: {
          evaluate: (args, f) => {
            assert.equal(args.expression, '-exec x/4xb 0x20000000');
            f.print('0x20000000 <buf>:\t0x01\t0x02\t0x03\t0x04\n');
            return {};
          },
        },
      });
      const result = await call({ action: 'inspect', memory: { address: '0x20000000', length: 4 } });
      assert.deepEqual(result.memory, { address: '0x20000000', length: 4, via: 'gdb x', hex: '01 02 03 04' });
    });

    it('decodes the Cortex-M fault registers of a Cortex-M build, with the backtrace', async () => {
      harness();
      fs.appendFileSync(path.join(h.f.appRoot, 'build', 'primary', 'zephyr', '.config'), 'CONFIG_CPU_CORTEX_M=y\n');
      const fake = session({
        state: 'stopped', capabilities: { supportsReadMemoryRequest: true },
        handlers: { readMemory: args => ({ address: args.memoryReference, data: Buffer.from(FAULT_BYTES).toString('base64') }) },
      });
      const result = await call({ action: 'inspect', include: ['fault'] });
      assert.deepEqual(fake.requests.find(r => r.command === 'readMemory')?.args, { memoryReference: '0xe000ed28', offset: 0, count: 20 });
      assert.equal(result.fault.decoded, true);
      assert.equal(result.fault.cfsr, '0x00008200');
      assert.equal(result.fault.hfsr, '0x40000000');
      assert.deepEqual(result.fault.bits.map((b: { bit: string }) => b.bit), ['PRECISERR', 'BFARVALID', 'FORCED']);
      assert.equal(result.fault.bus_fault_address, '0x40001234');
      assert.equal(result.fault.backtrace[0].function, 'fault_here');
    });

    it('lets gdb read outside the gdb server\'s memory map once, when pyOCD\'s map leaves out the SCB', async () => {
      harness();
      fs.appendFileSync(path.join(h.f.appRoot, 'build', 'primary', 'zephyr', '.config'), 'CONFIG_CPU_CORTEX_M=y\n');
      let lifted = false;
      const fake = session({
        state: 'stopped', capabilities: { supportsReadMemoryRequest: true },
        configuration: { debugServerArgs: OPENOCD_ARGS.replace('openocd', 'pyocd') },
        handlers: {
          readMemory: args => {
            if (!lifted) {
              throw new Error(`Cannot access memory at address ${args.memoryReference}`);
            }
            return { address: args.memoryReference, data: Buffer.from(FAULT_BYTES).toString('base64') };
          },
          evaluate: (args, f) => {
            if (String(args.expression).includes('inaccessible-by-default off')) {
              lifted = true;
            } else {
              f.print('Cannot access memory at address 0xe000ed28\n');
            }
            return { result: '' };
          },
        },
      });
      const result = await call({ action: 'inspect', include: ['fault'] });
      assert.equal(result.errors, undefined);
      assert.equal(result.fault.decoded, true);
      assert.equal(result.fault.cfsr, '0x00008200');
      await call({ action: 'inspect', include: ['fault'] });
      const lifts = fake.requests.filter(r => r.command === 'evaluate' && String(r.args.expression).includes('inaccessible-by-default off'));
      assert.equal(lifts.length, 1, 'gdb is told once per session');
      assert.equal(lifts[0].args.expression, '-exec set mem inaccessible-by-default off');
    });

    it('says fault decoding covers Cortex-M only for another build', async () => {
      harness();
      const fake = session({ state: 'stopped' });
      const result = await call({ action: 'inspect', include: ['fault'] });
      assert.equal(result.fault.decoded, false);
      assert.match(result.fault.reason, /Cortex-M cores only/);
      assert.ok(!fake.requests.some(r => r.command === 'readMemory'));
    });

    it('lists the threads', async () => {
      harness();
      session({ state: 'stopped' });
      const result = await call({ action: 'inspect', include: ['threads'] });
      assert.deepEqual(result.threads, [{ id: 1, name: 'main' }, { id: 2, name: 'sysworkq' }]);
    });

    it('evaluates each expression on its own, reporting a failure for it alone', async () => {
      harness();
      session({
        state: 'stopped',
        handlers: {
          evaluate: args => {
            if (args.expression === 'nope') {
              throw new Error('No symbol "nope" in current context.');
            }
            return { result: '{...}', type: 'struct cfg', variablesReference: 11 };
          },
          variables: () => ({ variables: [{ name: 'speed', value: '9600', variablesReference: 0 }] }),
        },
      });
      const result = await call({ action: 'inspect', expressions: ['cfg', 'nope'] });
      assert.deepEqual(result.expressions, [
        { expression: 'cfg', value: '{...}', type: 'struct cfg', children: [{ name: 'speed', value: '9600' }] },
        { expression: 'nope', error: 'No symbol "nope" in current context.' },
      ]);
      assert.equal(result.errors, undefined);
    });

    it('reports a part that fails in errors, and still answers the others', async () => {
      harness();
      session({ state: 'stopped', handlers: { scopes: () => { throw new Error('scopes failed'); } } });
      const result = await call({ action: 'inspect', include: ['backtrace', 'locals', 'threads'] });
      assert.equal(result.errors.locals, 'scopes failed');
      assert.equal(result.backtrace.length, 3);
      assert.equal(result.threads.length, 2);
    });

    it('refuses $_shell in an expression or a memory address before anything reaches the adapter', async () => {
      harness();
      const fake = session({ state: 'stopped', capabilities: { supportsReadMemoryRequest: true }, handlers: { evaluate: () => ({ result: '0' }) } });
      for (const args of [
        { expressions: ['$_shell("calc")'] },
        { expressions: ['counter', 'x + $_shell("calc")'] },
        { memory: { address: '$_shell("calc")', length: 4 } },
        { expressions: ['-exec shell calc'] },
      ]) {
        const error = await errorOf(call({ action: 'inspect', ...args }));
        assert.equal(error.code, 'INVALID_ARGUMENT', JSON.stringify(args));
        assert.match(error.message, /expressions|memory\.address/);
      }
      assert.ok(!fake.requests.some(r => r.command === 'evaluate' || r.command === 'readMemory'), 'nothing was evaluated');
    });

    // gdb evaluates a watch expression in full, and inspect asks no one.
    it('refuses an expression or an address that would write or call, before evaluating anything', async () => {
      harness();
      h.confirmActions = ['hardware'];
      const fake = session({ state: 'stopped', handlers: { evaluate: () => ({ result: '0x20000000', variablesReference: 0 }) } });
      const writes: Record<string, unknown>[] = [
        ...['g_state = 3', 'x++', '--x', 'a += 1', 'sys_reboot(0)'].map(expression => ({ expressions: ['cfg', expression] })),
        { memory: { address: 'reset_fn()', length: 4 } },
      ];
      for (const args of writes) {
        const error = await errorOf(call({ action: 'inspect', ...args }));
        assert.equal(error.code, 'INVALID_ARGUMENT', JSON.stringify(args));
        assert.match(error.message, /would change the target/);
        assert.match(error.hint ?? '', /action "gdb"/);
      }
      assert.deepEqual(h.asked, []);
      assert.equal(fake.requests.filter(r => r.command === 'evaluate').length, 0);
      const reads = ['a == b', 'a <= b', 'a != b', 'sizeof(x)', '(int)x', '*ptr', 'arr[1].f', '"a=b"'];
      await call({ action: 'inspect', expressions: reads });
      await call({ action: 'inspect', memory: { address: '&buffer', length: 4 } });
      // The memory read itself then falls back to a gdb x command, which the fake leaves unanswered.
      const evaluated = fake.requests.filter(r => r.command === 'evaluate').map(r => (r.args as { expression: string }).expression);
      assert.deepEqual(evaluated.filter(expression => !expression.startsWith('-exec ')), [...reads, '&buffer']);
    });

    it('refuses bad arguments', async () => {
      harness();
      session({ state: 'stopped' });
      for (const args of [{ include: ['stack'] }, { memory: { address: '0x0', length: 5000 } }, { memory: { address: 1, length: 4 } }, { depth: 4 }, { frame: -1 }, { expressions: [''] }]) {
        assert.equal((await errorOf(call({ action: 'inspect', ...args }))).code, 'INVALID_ARGUMENT', JSON.stringify(args));
      }
    });
  });

  describe('gdb', () => {
    it('refuses a command outside the allowlist before asking, naming the allowed ones', async () => {
      harness();
      h.confirmActions = ['hardware'];
      const fake = session({ state: 'stopped' });
      const error = await errorOf(call({ action: 'gdb', text: 'shell rm -rf /' }));
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.match(error.hint ?? '', /info, print/);
      assert.deepEqual(h.asked, []);
      assert.deepEqual(fake.requests, []);
    });

    it('refuses a monitor command that reaches the host before asking', async () => {
      harness();
      h.confirmActions = ['hardware'];
      const fake = session({ state: 'stopped', configuration: { debugServerArgs: OPENOCD_ARGS.replace('openocd', 'pyocd') } });
      for (const text of ['monitor !calc', 'mon $__import__(\'os\')', 'monitor savemem 0x0 4 C:/x.bat', 'monitor script C:/x.tcl']) {
        const error = await errorOf(call({ action: 'gdb', text }));
        assert.equal(error.code, 'INVALID_ARGUMENT', text);
      }
      assert.deepEqual(h.subjects, []);
      assert.deepEqual(h.asked, []);
      assert.deepEqual(fake.requests, []);
    });

    it('names the runner of a cortex-west session in the dialog', async () => {
      harness();
      h.confirmActions = ['hardware'];
      h.answers.push('allow');
      session({
        type: 'cortex-debug', state: 'stopped', configuration: { servertype: 'external', __zwServerToken: 'token-1', __zwRunner: 'pyocd' },
        handlers: { 'execute-command': () => ({}) },
      });
      await call({ action: 'gdb', text: 'monitor reset halt' });
      assert.equal(h.subjects[0].runner, 'pyocd');
    });

    it('runs a command through cppdbg with -exec, capturing what gdb printed', async () => {
      harness();
      h.confirmActions = ['hardware'];
      h.answers.push('allow');
      const fake = session({
        state: 'stopped',
        handlers: {
          evaluate: (_args, f) => {
            f.print('r0             0x0                 0\n');
            f.print('pc             0x8000abc           0x8000abc <main+12>\n', 40);
            return { result: '', variablesReference: 0 };
          },
        },
      });
      const result = await call({ action: 'gdb', text: 'info registers' });
      assert.deepEqual(fake.requests.find(r => r.command === 'evaluate')?.args, { expression: '-exec info registers', context: 'repl', frameId: 1000 });
      assert.equal(result.ok, true);
      assert.equal(result.output, 'r0             0x0                 0\npc             0x8000abc           0x8000abc <main+12>\n');
      assert.deepEqual(result.response, { result: '', variablesReference: 0 });
      assert.deepEqual(result.confirmation, { category: 'hardware', outcome: 'allowed' });
      const subject = h.subjects[0] as ConfirmSubject & { text?: string };
      assert.match(subject.scope, /^gdb:/);
      assert.equal(subject.text, 'info registers');
      assert.equal(subject.sessionText, 'gdb commands on this application');
      assert.match(h.details[0], /Allow for This Session stops asking this agent before gdb commands on this application until the MCP server restarts\./);
      assert.match(h.asked[0], /run the gdb command "info registers" in the debug session "Zephyr Workbench Debug \[primary\]"/);
    });

    it('runs a command through cortex-debug\'s execute-command', async () => {
      harness();
      const fake = session({
        type: 'cortex-debug', configuration: {}, state: 'stopped',
        handlers: {
          'execute-command': (_args, f) => {
            f.print('Resetting target\n', 20, 'stdout');
            return { resultClass: 'done', results: [] };
          },
        },
      });
      const result = await call({ action: 'gdb', text: 'monitor reset halt' });
      assert.deepEqual(fake.requests.find(r => r.command === 'execute-command')?.args, { command: 'monitor reset halt' });
      assert.equal(result.output, 'Resetting target\n');
      assert.deepEqual(result.response, { resultClass: 'done', results: [] });
    });

    it('lets Allow for This Session cover the gdb commands on this application, under a scope of their own', async () => {
      harness();
      h.confirmActions = ['hardware'];
      h.answers.push('session');
      session({ state: 'stopped', handlers: { evaluate: () => ({ result: '' }) } });
      await call({ action: 'gdb', text: 'bt' });
      const second = await call({ action: 'gdb', text: 'p/x $pc' });
      assert.equal(h.asked.length, 1, 'the session approval covers gdb commands on this application');
      assert.deepEqual(second.confirmation, { category: 'hardware', outcome: 'remembered' });
      // Not the scope of a start or a flash of this application, which would ask.
      assert.equal(h.subjects[0].scope.split(':')[0], 'gdb');
      assert.equal(h.subjects[0].scope, h.subjects[1].scope);
    });

    it('refuses a command other than monitor while the target runs, and lets monitor through', async () => {
      harness();
      const fake = session({ handlers: { evaluate: () => ({ result: '' }) } });
      const error = await errorOf(call({ action: 'gdb', text: 'bt' }));
      assert.equal(error.code, 'TARGET_RUNNING');
      const monitor = await call({ action: 'gdb', text: 'monitor halt' });
      assert.equal(monitor.ok, true);
      assert.equal(fake.requests.find(r => r.command === 'evaluate')?.args.frameId, undefined, 'no frame while running');
    });

    it('returns gdb\'s refusal as the answer, since the command did run', async () => {
      harness();
      session({ state: 'stopped', handlers: { evaluate: () => { throw new Error('No symbol table is loaded.'); } } });
      const result = await call({ action: 'gdb', text: 'p nothing' });
      assert.equal(result.ok, false);
      assert.equal(result.error, 'No symbol table is loaded.');
    });
  });
});
