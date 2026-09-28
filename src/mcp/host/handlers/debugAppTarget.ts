// debug_app actions on the target of a running session: control (continue,
// pause, steps, restart), inspect (frames, variables, registers, memory, a
// decoded Cortex-M fault, threads) and gdb (one checked gdb command). All go
// through DAP requests of the session, so the user's debugger view and the
// agent see the same target.

import * as fs from 'fs';
import { decodeCortexMFault, FAULT_BLOCK_LENGTH, FAULT_BLOCK_START, faultDecodingSupport, faultWordsFromBytes } from '../../../debug/cortexMFault';
import {
  defaultBudget, evaluateExpression, FrameView, GdbExec, hexAddress, localsOf, MemoryRead, parseAddress, readRegisters, readTargetMemory,
  runConsoleCommand, stackFrames, threadList,
} from '../../../debug/dapRequests';
import { ALLOWED_GDB_COMMANDS, checkGdbCommand, checkGdbExpression, sideEffectReason } from '../../../debug/gdbCommandPolicy';
import { TrackedDebugSession, waitForStop, WaitOutcome } from '../../../debug/sessionTracker';
import { normalizeForCompare } from '../../core/argSafety';
import { McpToolError } from '../../core/errors';
import { logSafe } from '../../core/redact';
import {
  DEBUG_CONTROL_COMMANDS, DEBUG_INSPECT_PARTS, DEBUG_MEMORY_MAX_BYTES, DebugControlCommand, DebugInspectPart,
} from '../../core/tools/debugApp';
import { ConfirmSubject } from '../confirmations';
import {
  appOfSession, assertAlive, boolArg, Ctx, frameOut, invalid, messageOf, nextFor, num, resolveSession, runnerOfSession,
  sessionIdOf, stopOut, str, stringArgs, threadOf, topFrame, waitSecOf,
} from './debugAppSession';
import { remainingWaitMs } from './progress';

/** The DAP request of each step command. */
const STEP_REQUESTS: Readonly<Record<string, string>> = { step_over: 'next', step_into: 'stepIn', step_out: 'stepOut' };

/**
 * How cppdbg resets the target, whose adapter has no restart request: the
 * monitor command of each runner's gdb server. J-Link halts after its reset
 * on its own, and takes no "halt" argument.
 */
export const MONITOR_RESET: Readonly<Record<string, string>> = {
  openocd: 'monitor reset halt',
  pyocd: 'monitor reset halt',
  linkserver: 'monitor reset halt',
  jlink: 'monitor reset',
};

const MAX_FRAMES = 32;
const OUTPUT_MAX_CHARS = 20000;

function targetRunning(ctx: Ctx, tracked: TrackedDebugSession, what: string): McpToolError {
  const starting = tracked.state === 'starting';
  return new McpToolError('TARGET_RUNNING', starting
    ? `The session "${tracked.name}" is still starting, so it cannot ${what} yet.`
    : `The target of "${tracked.name}" is running, so it cannot ${what}.`, {
    hint: starting
      ? 'Call debug_app with action "status" in a few seconds.'
      : `Call debug_app with action "control" and command "pause" first (session_id ${JSON.stringify(sessionIdOf(ctx, tracked))}), or wait for a breakpoint with command "continue" and wait_for_stop true.`,
  });
}

async function request(tracked: TrackedDebugSession, command: string, args?: Record<string, unknown>): Promise<any> {
  try {
    return await tracked.session.customRequest(command, args);
  } catch (error) {
    throw new McpToolError('INTERNAL', `The debug adapter refused the ${command} request: ${messageOf(error)}`, {
      hint: 'Call debug_app with action "status" to see the state of the session and what the adapter printed.',
    });
  }
}

/** The state after a command, waiting for a stop when asked. */
async function settle(ctx: Ctx, tracked: TrackedDebugSession, wait: boolean, afterStop: number, waitSec: number): Promise<{ waited?: WaitOutcome }> {
  if (tracked.stopCount > afterStop) {
    return { waited: 'stopped' };
  }
  if (!wait) {
    return {};
  }
  const tick = setInterval(() => ctx.progress({
    progress: Math.round((Date.now() - ctx.startedAt) / 1000), message: `Waiting for "${tracked.name}" to stop`,
  }), 5000);
  try {
    return { waited: await waitForStop(tracked, { afterStop, deadline: Date.now() + remainingWaitMs(ctx, waitSec), signal: ctx.signal }) };
  } finally {
    clearInterval(tick);
  }
}

/** How long a restart sent without wait_for_stop waits for the adapter to answer or the target to stop. */
const RESTART_ANSWER_MS = 2000;

/**
 * Send the DAP restart request without waiting on its answer alone:
 * cortex-debug 1.12.1 answers only a restart that failed, and never one that
 * worked, so the stop after the reset counts as the answer too. A refusal
 * that comes is reported; `answered` is false when the stop, the end of the
 * session or the deadline came first.
 */
async function restartByRequest(ctx: Ctx, tracked: TrackedDebugSession, mark: number, wait: boolean, waitSec: number): Promise<{ answered: boolean; waited: WaitOutcome }> {
  let answered = false;
  let refusal: unknown;
  const stopWaiting = new AbortController();
  const onAbort = () => stopWaiting.abort();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  // Caught here, so an answer that never comes, or comes after the call, is never an unhandled rejection.
  void Promise.resolve(tracked.session.customRequest('restart', {})).then(
    () => { answered = true; },
    error => { answered = true; refusal = error ?? 'no reason given'; },
  ).finally(() => stopWaiting.abort());
  const tick = setInterval(() => ctx.progress({
    progress: Math.round((Date.now() - ctx.startedAt) / 1000), message: `Waiting for "${tracked.name}" to restart`,
  }), 5000);
  let waited: WaitOutcome;
  try {
    waited = await waitForStop(tracked, {
      afterStop: mark, deadline: Date.now() + (wait ? remainingWaitMs(ctx, waitSec) : RESTART_ANSWER_MS), signal: stopWaiting.signal,
    });
  } finally {
    clearInterval(tick);
    ctx.signal.removeEventListener('abort', onAbort);
  }
  if (refusal !== undefined) {
    throw new McpToolError('INTERNAL', `The debug adapter refused the restart request: ${messageOf(refusal)}`, {
      hint: 'Call debug_app with action "status" to see the state of the session and what the adapter printed.',
    });
  }
  return { answered: waited === 'aborted' && answered && !ctx.signal.aborted, waited };
}

// control

export async function control(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  stringArgs(args, ['command']);
  const command = str(args.command);
  if (!command || !(DEBUG_CONTROL_COMMANDS as readonly string[]).includes(command)) {
    throw invalid(`command must be one of ${DEBUG_CONTROL_COMMANDS.join(', ')}.`);
  }
  const threadArg = args.thread_id !== undefined ? num(args.thread_id) : undefined;
  if (args.thread_id !== undefined && (threadArg === undefined || !Number.isInteger(threadArg))) {
    throw invalid('thread_id must be a whole number, as the threads or the stop return it.');
  }
  const wait = boolArg(args, 'wait_for_stop') ?? command !== 'continue';
  const waitSec = waitSecOf(args, ctx.deps.defaultWaitSeconds);
  const tracked = await resolveSession(ctx, args);
  assertAlive(ctx, tracked);
  if (tracked.state === 'starting') {
    throw targetRunning(ctx, tracked, command.replace('_', ' '));
  }

  const mark = tracked.stopCount;
  // Asked only once the state allows the command: a running target may not answer threads.
  const thread = async () => (await threadOf(tracked, threadArg)) ?? 1;
  let note: string | undefined;
  let waitAfter = wait;
  // Set when the restart request already waited, in place of settle's wait.
  let restartWaited: WaitOutcome | undefined;
  switch (command as DebugControlCommand) {
    case 'continue':
      if (tracked.state === 'running') {
        note = 'The target was already running.';
      } else {
        await request(tracked, 'continue', { threadId: await thread() });
      }
      break;
    case 'pause':
      if (tracked.state === 'stopped') {
        note = 'The target was already stopped.';
        waitAfter = false;
      } else {
        await request(tracked, 'pause', { threadId: await thread() });
      }
      break;
    case 'step_over':
    case 'step_into':
    case 'step_out':
      if (tracked.state !== 'stopped') {
        throw targetRunning(ctx, tracked, command.replace('_', ' '));
      }
      await request(tracked, STEP_REQUESTS[command], { threadId: await thread() });
      break;
    case 'restart': {
      if (tracked.capabilities?.supportsRestartRequest === true) {
        const sent = await restartByRequest(ctx, tracked, mark, wait, waitSec);
        if (!sent.answered) {
          waitAfter = false;
          if (sent.waited === 'timeout') {
            note = 'The debug adapter has not answered the restart request, and the target has not stopped yet.';
            restartWaited = wait ? 'timeout' : undefined;
          } else {
            restartWaited = sent.waited;
          }
        }
        break;
      }
      const runner = runnerOfSession(tracked);
      const reset = tracked.type === 'cppdbg' && runner ? MONITOR_RESET[runner] : undefined;
      if (!reset) {
        throw invalid(`The debug adapter of "${tracked.name}" cannot restart the program${runner ? `, and the ${runner} gdb server has no monitor reset to do it` : ''}.`,
          'Call debug_app with action "stop", then action "start" again.');
      }
      if (tracked.state !== 'stopped') {
        throw targetRunning(ctx, tracked, 'restart');
      }
      const frame = await topFrame(tracked);
      try {
        await runConsoleCommand(tracked, reset, { ...(frame ? { frameId: frame.id } : {}) });
        // gdb still holds the registers of before the reset.
        await runConsoleCommand(tracked, 'maintenance flush register-cache', { quietMs: 50, maxWaitMs: 300 }).catch(() => undefined);
      } catch (error) {
        throw new McpToolError('INTERNAL', `The ${runner} gdb server refused "${reset}": ${messageOf(error)}`, {
          hint: 'Call debug_app with action "stop", then action "start" again.',
        });
      }
      // The reset halts the core without a stopped event, so there is nothing to wait for.
      note = `Reset with "${reset}": the core is halted at its reset handler. The VS Code call stack view updates at the next step or stop.`;
      waitAfter = false;
      break;
    }
  }

  const { waited } = restartWaited !== undefined ? { waited: restartWaited } : await settle(ctx, tracked, waitAfter, mark, waitSec);
  const frame = await topFrame(tracked);
  return {
    action: 'control',
    command,
    session_id: sessionIdOf(ctx, tracked),
    state: tracked.state,
    ...(tracked.state === 'stopped' && tracked.lastStop ? { stop: stopOut(tracked.lastStop, frame) } : {}),
    ...(tracked.state === 'stopped' && !tracked.lastStop && frame ? { frame: frameOut(frame) } : {}),
    ...(waited ? { waited } : {}),
    ...(note ? { note } : {}),
    next: waited === 'timeout'
      ? `The target still runs after wait_sec. Wait more with command "continue" and wait_for_stop true, or pause it with command "pause". ${nextFor(ctx, tracked)}`
      : nextFor(ctx, tracked),
  };
}

// inspect

function hexDump(bytes: number[]): string {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    lines.push(bytes.slice(offset, offset + 16).map(byte => byte.toString(16).padStart(2, '0')).join(' '));
  }
  return lines.join('\n');
}

const MEMORY_LITERAL = /^\s*(0x[0-9a-fA-F]{1,16}|\d{1,16})\s*$/;

/** Refuse an expression gdb must not see, naming the argument it came in. */
function screenExpression(text: string, argument: string): void {
  const screened = checkGdbExpression(text);
  if (!screened.ok) {
    throw invalid(`${argument}: ${screened.reason}`, 'Pass a C expression, such as my_struct.field, *ptr or &buffer.');
  }
}

/** The address of inspect's memory argument: a number as it is, else an expression gdb evaluates in the frame. */
async function memoryAddress(tracked: TrackedDebugSession, text: string, frameId: number | undefined): Promise<number> {
  const literal = MEMORY_LITERAL.exec(text);
  if (literal) {
    return literal[1].toLowerCase().startsWith('0x') ? parseInt(literal[1], 16) : Number(literal[1]);
  }
  const body = await tracked.session.customRequest('evaluate', { expression: text, context: 'watch', ...(frameId !== undefined ? { frameId } : {}) });
  const address = (typeof body?.memoryReference === 'string' ? parseAddress(body.memoryReference) : undefined)
    ?? (typeof body?.result === 'string' ? parseAddress(body.result) : undefined);
  if (address === undefined) {
    throw new Error(`"${text}" evaluates to ${JSON.stringify(body?.result ?? '')}, which is not an address.`);
  }
  return address;
}

/** Sessions whose gdb was told to read outside the memory map of its gdb server. */
const memoryMapLifted = new WeakSet<TrackedDebugSession>();

/**
 * Read target memory. pyOCD sends gdb a memory map of flash and RAM only for
 * most targets, and gdb then refuses the SCB and the peripherals, so on
 * "Cannot access memory" gdb is told once per session to read outside the
 * map, as cortex-debug does for its own pyOCD server, and the read is tried
 * again. This is an internal command, not one of the agent's.
 */
async function readMemoryOf(tracked: TrackedDebugSession, address: number, length: number, gdbExec: GdbExec): Promise<MemoryRead> {
  try {
    return await readTargetMemory(tracked.session, tracked.capabilities, address, length, gdbExec);
  } catch (error) {
    if (memoryMapLifted.has(tracked) || !/Cannot access memory/i.test(messageOf(error))) {
      throw error;
    }
    memoryMapLifted.add(tracked);
    try {
      await gdbExec('set mem inaccessible-by-default off');
    } catch {
      throw error;
    }
    return readTargetMemory(tracked.session, tracked.capabilities, address, length, gdbExec);
  }
}

/** Whether the build of the session targets a Cortex-M core with fault registers, from its .config. */
async function faultSupport(ctx: Ctx, tracked: TrackedDebugSession) {
  const app = await appOfSession(ctx, tracked);
  const config = app && tracked.configName ? app.getBuildConfiguration(tracked.configName) : undefined;
  if (!app || !config) {
    return faultDecodingSupport(undefined);
  }
  let text: string | undefined;
  try {
    const file = ctx.deps.services.artifactPaths(app, config, tracked.domain).dotConfigPath;
    text = file ? fs.readFileSync(file, 'utf8') : undefined;
  } catch {
    text = undefined;
  }
  return faultDecodingSupport(text);
}

export async function inspect(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  const include = args.include;
  if (include !== undefined && (!Array.isArray(include) || include.some(part => !(DEBUG_INSPECT_PARTS as readonly unknown[]).includes(part)))) {
    throw invalid(`include takes ${DEBUG_INSPECT_PARTS.join(', ')}.`);
  }
  const expressions = args.expressions;
  if (expressions !== undefined && (!Array.isArray(expressions) || expressions.some(item => typeof item !== 'string' || item.trim().length === 0))) {
    throw invalid('expressions must be a list of non-empty C expressions.');
  }
  const memory = args.memory as { address?: unknown; length?: unknown } | undefined;
  if (memory !== undefined && (typeof memory !== 'object' || memory === null || typeof memory.address !== 'string'
    || typeof memory.length !== 'number' || !Number.isInteger(memory.length) || memory.length < 1 || memory.length > DEBUG_MEMORY_MAX_BYTES)) {
    throw invalid(`memory takes address, a number or an expression, and length, from 1 to ${DEBUG_MEMORY_MAX_BYTES} bytes.`);
  }
  // gdb evaluates these on the host, where $_shell would run a command: the
  // whole call is refused before anything reaches the adapter.
  for (const expression of (expressions as string[] | undefined) ?? []) {
    screenExpression(expression, 'expressions');
  }
  if (memory !== undefined && !MEMORY_LITERAL.test(memory.address as string)) {
    screenExpression(memory.address as string, 'memory.address');
  }
  // gdb evaluates these in full, and inspect asks no one, so it only reads.
  for (const expression of [...((expressions as string[] | undefined) ?? []), ...(memory ? [memory.address as string] : [])]) {
    const reason = sideEffectReason(expression);
    if (reason) {
      throw invalid(`"${logSafe(expression, 200)}" would change the target (${reason}), and inspect only reads.`,
        'Use debug_app with action "gdb" instead, such as set var x = 1 or print f(), which asks the user first.');
    }
  }
  const depth = args.depth === undefined ? 1 : num(args.depth);
  if (depth === undefined || !Number.isInteger(depth) || depth < 0 || depth > 3) {
    throw invalid('depth must be 0, 1, 2 or 3.');
  }
  const frameIndex = args.frame === undefined ? 0 : num(args.frame);
  if (frameIndex === undefined || !Number.isInteger(frameIndex) || frameIndex < 0) {
    throw invalid('frame must be a whole number from 0, the innermost frame.');
  }
  const threadArg = args.thread_id !== undefined ? num(args.thread_id) : undefined;
  if (args.thread_id !== undefined && (threadArg === undefined || !Number.isInteger(threadArg))) {
    throw invalid('thread_id must be a whole number, as the threads or the stop return it.');
  }
  const parts = new Set<DebugInspectPart>((include as DebugInspectPart[] | undefined)
    ?? (expressions !== undefined || memory !== undefined ? [] : ['backtrace', 'locals']));

  const tracked = await resolveSession(ctx, args);
  assertAlive(ctx, tracked);
  if (tracked.state !== 'stopped') {
    throw targetRunning(ctx, tracked, 'be read');
  }
  const session = tracked.session;
  const threadId = await threadOf(tracked, threadArg);
  if (threadId === undefined) {
    throw new McpToolError('INTERNAL', `The debug adapter of "${tracked.name}" reports no thread to read.`, {
      hint: 'Call debug_app with action "status" to see what the adapter printed.',
    });
  }
  let frames: FrameView[];
  try {
    frames = await stackFrames(session, threadId, MAX_FRAMES);
  } catch (error) {
    throw new McpToolError('INTERNAL', `The call stack of thread ${threadId} could not be read: ${messageOf(error)}`, {
      hint: 'Pass thread_id, one of the threads that include ["threads"] returns.',
    });
  }
  const frame = frames[frameIndex];
  if (!frame && frameIndex > 0) {
    throw invalid(`Thread ${threadId} has ${frames.length} frames, so there is no frame ${frameIndex}.`, 'Pass frame from 0 to the last index of the backtrace.');
  }
  const frameId = frame?.id;
  const gdbExec: GdbExec = command => runConsoleCommand(tracked, command, { ...(frameId !== undefined ? { frameId } : {}) });
  const budget = defaultBudget();
  const backtrace = frames.map(entry => ({ index: entry.index, ...frameOut(entry) }));

  const result: Record<string, unknown> = {
    action: 'inspect',
    session_id: sessionIdOf(ctx, tracked),
    state: tracked.state,
    thread_id: threadId,
    frame: frameIndex,
    ...(frame ? { at: frameOut(frame) } : {}),
  };
  const errors: Record<string, string> = {};
  const part = async (name: string, read: () => Promise<unknown>) => {
    try {
      result[name] = await read();
    } catch (error) {
      errors[name] = messageOf(error);
    }
  };

  if (parts.has('backtrace')) {
    result.backtrace = backtrace;
  }
  if (parts.has('locals')) {
    await part('locals', async () => {
      if (frameId === undefined) {
        throw new Error('The thread has no frame to read.');
      }
      return localsOf(session, frameId, depth, budget);
    });
  }
  if (parts.has('registers')) {
    await part('registers', () => readRegisters(session, frameId, gdbExec));
  }
  if (parts.has('fault')) {
    await part('fault', async () => {
      const support = await faultSupport(ctx, tracked);
      if (!support.supported) {
        return { decoded: false, reason: support.reason };
      }
      const read = await readMemoryOf(tracked, FAULT_BLOCK_START, FAULT_BLOCK_LENGTH, gdbExec);
      return {
        decoded: true,
        ...decodeCortexMFault(faultWordsFromBytes(read.bytes)),
        read_via: read.via,
        ...(parts.has('backtrace') ? {} : { backtrace }),
      };
    });
  }
  if (parts.has('threads')) {
    await part('threads', () => threadList(session));
  }
  if (expressions !== undefined) {
    const out = [];
    for (const expression of expressions as string[]) {
      out.push(await evaluateExpression(session, expression, frameId, depth, budget));
    }
    result.expressions = out;
  }
  if (memory !== undefined) {
    await part('memory', async () => {
      const address = await memoryAddress(tracked, memory.address as string, frameId);
      const read = await readMemoryOf(tracked, address, memory.length as number, gdbExec);
      return {
        address: hexAddress(read.address),
        length: read.bytes.length,
        hex: hexDump(read.bytes),
        via: read.via,
        ...(read.unreadable ? { unreadable_bytes: read.unreadable } : {}),
      };
    });
  }
  if (budget.items <= 0) {
    result.truncated = 'The variables were cut at 400 in this answer: read fewer with depth 0, or name what you need in expressions.';
  }
  if (Object.keys(errors).length > 0) {
    result.errors = errors;
  }
  result.next = nextFor(ctx, tracked);
  return result;
}

// gdb

export async function gdb(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  stringArgs(args, ['text']);
  const text = str(args.text);
  if (text === undefined) {
    throw invalid('gdb needs text, one gdb command.');
  }
  const policy = checkGdbCommand(text);
  if (!policy.ok) {
    throw invalid(`${policy.reason} The gdb action runs one command that reads the target or talks to the gdb server.`,
      `Pass one command of: ${ALLOWED_GDB_COMMANDS.join(', ')}.`, { allowed: [...ALLOWED_GDB_COMMANDS] });
  }
  const tracked = await resolveSession(ctx, args);
  assertAlive(ctx, tracked);
  // gdb answers a command while the target runs only when it goes to the gdb server.
  if (tracked.state !== 'stopped' && policy.kind !== 'monitor') {
    throw targetRunning(ctx, tracked, `run "${logSafe(policy.command, 60)}"`);
  }

  const app = await appOfSession(ctx, tracked);
  const config = app && tracked.configName ? app.getBuildConfiguration(tracked.configName) : undefined;
  const runner = runnerOfSession(tracked);
  // The command is part of the subject, so an answer given late to one
  // command is never taken for another; Allow for This Session covers gdb
  // commands on this application only, not starting a session or flashing.
  const subject: ConfirmSubject & { text: string; session: string } = {
    summary: `run the gdb command "${logSafe(policy.command, 200)}" in the debug session "${tracked.name}"`,
    ...(app ? { appPath: app.appRootPath } : {}),
    ...(tracked.configName ? { configName: tracked.configName } : {}),
    ...(config?.boardIdentifier ? { board: config.boardIdentifier } : {}),
    ...(runner ? { runner } : {}),
    scope: `gdb:${app ? normalizeForCompare(app.appRootPath) : tracked.name}`,
    sessionText: 'gdb commands on this application',
    // The summary shortens a long command; the dialog still shows all of it.
    ...(policy.command.length > 200 ? { lines: [`Command: ${policy.command}`] } : {}),
    text: policy.command,
    session: tracked.name,
  };
  const outcome = await ctx.deps.confirmations.require(ctx, args, subject);
  // Read again: the dialog may have stayed open for a while.
  assertAlive(ctx, tracked);
  if (tracked.state !== 'stopped' && policy.kind !== 'monitor') {
    throw targetRunning(ctx, tracked, `run "${logSafe(policy.command, 60)}"`);
  }

  const frame = await topFrame(tracked);
  let body: unknown;
  let output = '';
  let error: string | undefined;
  try {
    ({ body, output } = await runConsoleCommand(tracked, policy.command, { ...(frame ? { frameId: frame.id } : {}), quietMs: 300, maxWaitMs: 3000 }));
  } catch (failure) {
    error = messageOf(failure);
  }
  const clipped = output.length > OUTPUT_MAX_CHARS ? `${output.slice(0, OUTPUT_MAX_CHARS)}\n... (cut at ${OUTPUT_MAX_CHARS} characters)` : output;
  return {
    action: 'gdb',
    session_id: sessionIdOf(ctx, tracked),
    command: policy.command,
    adapter: tracked.type,
    ok: error === undefined,
    ...(error !== undefined ? { error } : {}),
    output: clipped,
    ...(body !== undefined ? { response: body } : {}),
    state: tracked.state,
    ...(outcome === 'not-required' || outcome === 'not-asked' ? {} : { confirmation: { category: ctx.audit.confirmCategory, outcome } }),
    next: error !== undefined
      ? 'gdb refused the command; the error says why. Check the command, or read the target with debug_app action "inspect".'
      : nextFor(ctx, tracked),
  };
}
