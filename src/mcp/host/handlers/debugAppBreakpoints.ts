// debug_app action breakpoint: breakpoints go through VS Code's own list,
// so the user sees each one in the editor and the debugger applies it to
// every session, running or started later. The ones an agent added are
// remembered for this window and removed when the last Workbench session
// ends, so they never pile up in the user's saved breakpoints. VS Code keeps
// breakpoints across a reload or an extension host restart, so where each
// agent breakpoint is goes to the workspace state too, and its new id is
// claimed again after the restart.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { checkGdbExpression, sideEffectReason } from '../../../debug/gdbCommandPolicy';
import { onWorkbenchSessionChange, TrackedDebugSession, workbenchDebugSessions } from '../../../debug/sessionTracker';
import { assertInside } from '../../core/argSafety';
import { McpToolError } from '../../core/errors';
import { logSafe } from '../../core/redact';
import { Ctx, invalid, resolveSession, sessionIdOf, str } from './debugAppSession';

/** Ids of the breakpoints agents added in this window. */
const agentBreakpoints = new Set<string>();
/** Set by stop with keep_breakpoints: the end of the last session leaves them. */
let keepOnEnd = false;
let cleanupHooked = false;

/** The waits of this module, shortened by the tests. */
export const agentBreakpointTiming = {
  /** How long after activation a stored breakpoint may still appear in VS Code's list. */
  claimWindowMs: 10000,
  /** How long an add waits for the running session to answer for the new breakpoints. */
  verifyWaitMs: 1500,
  verifyPollMs: 100,
};

/** Where an agent breakpoint is: its id changes across a reload, its place does not. */
type StoredBreakpoint = { kind: 'source'; path: string; line: number } | { kind: 'function'; function: string };

const STORE_KEY = 'zephyr-workbench.mcp.agentBreakpoints';
let store: vscode.Memento | undefined;
/** Stored breakpoints of an earlier activation not found in VS Code's list yet. */
let unclaimed: StoredBreakpoint[] = [];
let watching: vscode.Disposable | undefined;
let claimTimer: NodeJS.Timeout | undefined;

function placeOf(bp: vscode.Breakpoint): StoredBreakpoint | undefined {
  if (isSource(bp)) {
    return { kind: 'source', path: bp.location.uri.fsPath, line: bp.location.range.start.line + 1 };
  }
  return isFunction(bp) ? { kind: 'function', function: bp.functionName } : undefined;
}

function isStoredBreakpoint(value: unknown): value is StoredBreakpoint {
  const entry = value as StoredBreakpoint | undefined;
  return entry?.kind === 'source' ? typeof entry.path === 'string' && typeof entry.line === 'number'
    : entry?.kind === 'function' && typeof entry.function === 'string';
}

function isAt(bp: vscode.Breakpoint, place: StoredBreakpoint): boolean {
  return place.kind === 'function'
    ? isFunction(bp) && bp.functionName === place.function
    : isSource(bp) && sameFile(bp.location.uri.fsPath, place.path) && bp.location.range.start.line === place.line - 1;
}

/** Write where the agent's breakpoints are, so a restarted extension host knows them again. */
function persist(): void {
  if (!store) {
    return;
  }
  const places = [
    ...vscode.debug.breakpoints.filter(bp => agentBreakpoints.has(bp.id)).map(placeOf).filter((place): place is StoredBreakpoint => !!place),
    ...unclaimed,
  ];
  void Promise.resolve(store.update(STORE_KEY, places.length > 0 ? places : undefined)).catch(() => undefined);
}

/** Take back the breakpoints of the list that sit where a stored agent breakpoint was. */
function claim(list: readonly vscode.Breakpoint[]): void {
  for (const bp of list) {
    if (unclaimed.length === 0) {
      return;
    }
    const index = agentBreakpoints.has(bp.id) ? -1 : unclaimed.findIndex(place => isAt(bp, place));
    if (index >= 0) {
      agentBreakpoints.add(bp.id);
      unclaimed.splice(index, 1);
    }
  }
}

/** Follow VS Code's list: a stored breakpoint appearing is claimed, one the user deletes is forgotten. */
function watchBreakpoints(): void {
  if (watching || !store) {
    return;
  }
  watching = vscode.debug.onDidChangeBreakpoints(event => {
    claim(event.added);
    for (const bp of event.removed) {
      agentBreakpoints.delete(bp.id);
    }
    persist();
  });
}

/**
 * Once per activation: read where the agent's breakpoints were before a
 * reload or an extension host restart, and claim them again as they appear
 * in VS Code's list, which fills in shortly after activation. Those still
 * missing after a while were deleted by the user and are forgotten.
 */
export function initAgentBreakpoints(memento: vscode.Memento): vscode.Disposable {
  store = memento;
  const stored = memento.get<unknown>(STORE_KEY);
  unclaimed = Array.isArray(stored) ? stored.filter(isStoredBreakpoint) : [];
  if (unclaimed.length === 0) {
    return { dispose: () => undefined };
  }
  watchBreakpoints();
  claim(vscode.debug.breakpoints);
  // They go when the last session ends, as they would have before the restart.
  ensureBreakpointCleanup();
  claimTimer = setTimeout(() => {
    claimTimer = undefined;
    unclaimed = [];
    persist();
  }, agentBreakpointTiming.claimWindowMs);
  claimTimer.unref?.();
  return { dispose: stopWatching };
}

function stopWatching(): void {
  if (claimTimer) {
    clearTimeout(claimTimer);
    claimTimer = undefined;
  }
  watching?.dispose();
  watching = undefined;
}

/** Remove the breakpoints agents added that are still set, and forget them. Returns how many went. */
export function removeAgentBreakpoints(): number {
  claim(vscode.debug.breakpoints);
  const present = vscode.debug.breakpoints.filter(bp => agentBreakpoints.has(bp.id));
  if (present.length > 0) {
    vscode.debug.removeBreakpoints(present);
  }
  agentBreakpoints.clear();
  unclaimed = [];
  persist();
  return present.length;
}

/** How many of the breakpoints agents added are set now. */
export function agentBreakpointCount(): number {
  claim(vscode.debug.breakpoints);
  return vscode.debug.breakpoints.filter(bp => agentBreakpoints.has(bp.id)).length;
}

/** Stop with keep_breakpoints true: the next end of the last session keeps them; false: it removes them. */
export function keepAgentBreakpointsOnEnd(keep: boolean): void {
  keepOnEnd = keep;
}

/** Once per window: remove the agent's breakpoints when the last Workbench session ends. */
export function ensureBreakpointCleanup(): void {
  watchBreakpoints();
  if (cleanupHooked) {
    return;
  }
  cleanupHooked = true;
  onWorkbenchSessionChange(event => {
    if (event.kind !== 'ended' || workbenchDebugSessions().length > 0) {
      return;
    }
    if (keepOnEnd) {
      keepOnEnd = false;
      return;
    }
    removeAgentBreakpoints();
  });
}

/** For tests: forget the agent's breakpoints, the keep flag and the store, as a new activation would, leaving what the store holds. */
export function resetAgentBreakpointsForTests(): void {
  agentBreakpoints.clear();
  keepOnEnd = false;
  store = undefined;
  unclaimed = [];
  stopWatching();
}

/** For tests: the ids agents added. */
export function agentBreakpointIdsForTests(): string[] {
  return [...agentBreakpoints];
}

interface BreakpointRequest {
  function?: string;
  path?: string;
  line?: number;
  condition?: string;
  hit_condition?: string;
  log_message?: string;
}

const BREAKPOINT_KEYS = new Set(['function', 'path', 'line', 'condition', 'hit_condition', 'log_message']);

function sameFile(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}

function isSource(bp: vscode.Breakpoint): bp is vscode.SourceBreakpoint {
  return (bp as vscode.SourceBreakpoint).location !== undefined;
}

function isFunction(bp: vscode.Breakpoint): bp is vscode.FunctionBreakpoint {
  return typeof (bp as vscode.FunctionBreakpoint).functionName === 'string';
}

/**
 * The arguments gdb's dprintf evaluates in a log message. Cortex-Debug
 * appends the message to -dprintf-insert as it is, and gdb's MI splits it
 * into words, a quoted word being one: the first is the format, and each
 * word after it is an expression gdb evaluates on every hit, braces or not.
 * A quoted word counts without its quotes, as MI hands it to dprintf. Words
 * with no name or number in them cannot read or change anything.
 */
export function dprintfArguments(message: string): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < message.length) {
    if (/\s/.test(message[i])) {
      i++;
      continue;
    }
    let word = '';
    if (message[i] === '"') {
      i++;
      while (i < message.length && message[i] !== '"') {
        word += message[i] === '\\' && i + 1 < message.length ? message[i++] + message[i++] : message[i++];
      }
      i++;
    } else {
      while (i < message.length && !/\s/.test(message[i])) {
        word += message[i++];
      }
    }
    words.push(word);
  }
  return words.slice(1).filter(word => /[\w$]/.test(word));
}

const DPRINTF_NOTE = ' Cortex-Debug passes the message to gdb\'s dprintf, which evaluates each word after the first as an expression.';

/**
 * Why a log message is refused, else undefined. cppdbg evaluates each
 * {expression} in it, and cortex-debug hands the whole text to gdb's
 * dprintf, so $_shell and a second line are refused anywhere in it, and each
 * braced part and each dprintf argument is checked as an expression.
 */
function logMessageRefusal(message: string): string | undefined {
  if (/[\x00-\x1f\x7f]/.test(message)) {
    return 'The text holds a newline or a control character.';
  }
  if (/\$_shell\b/.test(message)) {
    return '$_shell runs a command on the host.';
  }
  const parts = [...[...message.matchAll(/\{([^{}]*)\}/g)].map(part => part[1]), ...dprintfArguments(message)];
  for (const part of parts) {
    const screened = checkGdbExpression(part);
    if (!screened.ok) {
      return `"${logSafe(part, 60)}": ${screened.reason}`;
    }
  }
  return undefined;
}

/** A breakpoint request checked on its own, before anything is added. */
async function checkRequest(raw: unknown, index: number, roots: string[]): Promise<BreakpointRequest> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid(`add[${index}] must be an object with function, or path and line.`);
  }
  const request = raw as Record<string, unknown>;
  const unknown = Object.keys(request).filter(key => !BREAKPOINT_KEYS.has(key));
  if (unknown.length > 0) {
    throw invalid(`add[${index}] does not take ${unknown.join(', ')}.`);
  }
  for (const key of ['function', 'path', 'condition', 'hit_condition', 'log_message']) {
    if (request[key] !== undefined && (typeof request[key] !== 'string' || (request[key] as string).trim().length === 0)) {
      throw invalid(`add[${index}].${key} must be a non-empty string.`);
    }
  }
  // gdb evaluates these on every hit, on the host, where $_shell would run a command.
  for (const key of ['condition', 'hit_condition']) {
    if (request[key] !== undefined) {
      const screened = checkGdbExpression(request[key] as string);
      if (!screened.ok) {
        throw invalid(`add[${index}].${key}: ${screened.reason}`, 'Pass a C expression, such as count > 3.');
      }
      // Cortex-Debug wraps the condition in "..." without escaping it, so a quote would end it early.
      if ((request[key] as string).includes('"')) {
        throw invalid(`add[${index}].${key} holds a double quote: string literals are not supported there.`,
          'Compare numbers or single characters instead, such as name[0] == \'A\'.');
      }
    }
  }
  if (request.log_message !== undefined) {
    const reason = logMessageRefusal(request.log_message as string);
    if (reason) {
      throw invalid(`add[${index}].log_message: ${reason}`, 'Pass text with C expressions in braces, such as count is {count}.');
    }
  }
  // gdb evaluates the condition, each {expression} of the message and each
  // dprintf argument after its format on every hit, and adding asks no one.
  const message = String(request.log_message ?? '');
  const evaluated = [
    ...(request.condition !== undefined ? [['condition', request.condition as string]] : []),
    ...[...message.matchAll(/\{([^{}]*)\}/g)].map(part => ['log_message', part[1]]),
    ...(message ? dprintfArguments(message).map(word => ['log_message', word, DPRINTF_NOTE]) : []),
  ];
  for (const [key, expression, note] of evaluated) {
    const reason = sideEffectReason(expression);
    if (reason) {
      throw invalid(`add[${index}].${key} "${logSafe(expression, 200)}" would change the target on every hit (${reason}); it may only read.${note ?? ''}`,
        'Stop at the breakpoint instead, then use debug_app with action "gdb", such as set var x = 1, which asks the user first.');
    }
  }
  const fn = str(request.function);
  const file = str(request.path);
  const line = request.line;
  if (fn !== undefined && (file !== undefined || line !== undefined)) {
    throw invalid(`add[${index}] takes function, or path with line, not both.`);
  }
  if (fn === undefined && file === undefined) {
    throw invalid(`add[${index}] needs function, or path with line.`);
  }
  if (fn !== undefined && !/^[A-Za-z_][\w:.<>~]*$/.test(fn)) {
    throw invalid(`add[${index}].function "${logSafe(fn, 100)}" is not a function name.`);
  }
  if (file !== undefined) {
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
      throw invalid(`add[${index}] needs line, a whole number from 1, with path.`);
    }
    if (!path.isAbsolute(file)) {
      throw invalid(`add[${index}].path must be absolute, not "${logSafe(file, 300)}".`);
    }
    assertInside(file, roots, `add[${index}].path`);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw invalid(`add[${index}].path "${logSafe(file, 300)}" is not an existing file.`);
    }
  }
  return {
    ...(fn !== undefined ? { function: fn } : {}),
    ...(file !== undefined ? { path: file, line: line as number } : {}),
    ...(request.condition !== undefined ? { condition: request.condition as string } : {}),
    ...(request.hit_condition !== undefined ? { hit_condition: request.hit_condition as string } : {}),
    ...(request.log_message !== undefined ? { log_message: request.log_message as string } : {}),
  };
}

/** The breakpoint of VS Code's list at the same place, if one is already set there. */
function existingAt(request: BreakpointRequest): vscode.Breakpoint | undefined {
  return vscode.debug.breakpoints.find(bp => (request.function !== undefined
    ? isFunction(bp) && bp.functionName === request.function
    : isSource(bp) && sameFile(bp.location.uri.fsPath, request.path as string) && bp.location.range.start.line === (request.line as number) - 1));
}

function toBreakpoint(request: BreakpointRequest): vscode.Breakpoint {
  if (request.function !== undefined) {
    return new vscode.FunctionBreakpoint(request.function, true, request.condition, request.hit_condition, request.log_message);
  }
  const location = new vscode.Location(vscode.Uri.file(request.path as string), new vscode.Position((request.line as number) - 1, 0));
  return new vscode.SourceBreakpoint(location, true, request.condition, request.hit_condition, request.log_message);
}

/** One breakpoint as the agent sees it, with what the running session made of it. */
async function breakpointOut(bp: vscode.Breakpoint, tracked: TrackedDebugSession | undefined) {
  const where = isSource(bp)
    ? { kind: 'source', path: bp.location.uri.fsPath, line: bp.location.range.start.line + 1 }
    : isFunction(bp) ? { kind: 'function', function: bp.functionName } : { kind: 'other' };
  let session: Record<string, unknown> | undefined;
  const reader = tracked?.session as { getDebugProtocolBreakpoint?: (bp: vscode.Breakpoint) => Thenable<any> } | undefined;
  if (tracked && typeof reader?.getDebugProtocolBreakpoint === 'function') {
    try {
      const dap = await reader.getDebugProtocolBreakpoint(bp);
      if (dap) {
        session = {
          verified: dap.verified === true,
          ...(typeof dap.line === 'number' ? { line: dap.line } : {}),
          ...(typeof dap.message === 'string' && dap.message ? { message: dap.message } : {}),
        };
      }
    } catch {
      // The session may be ending: the breakpoint is shown without it.
    }
  }
  return {
    id: bp.id,
    ...where,
    enabled: bp.enabled,
    ...(bp.condition ? { condition: bp.condition } : {}),
    ...(bp.hitCondition ? { hit_condition: bp.hitCondition } : {}),
    ...(bp.logMessage ? { log_message: bp.logMessage } : {}),
    added_by_agent: agentBreakpoints.has(bp.id),
    ...(session ? { in_session: session } : {}),
  };
}

/** The session whose view of the breakpoints is shown: the one named, else the only one running. */
async function sessionForList(ctx: Ctx, args: Record<string, unknown>): Promise<TrackedDebugSession | undefined> {
  if (args.session_id !== undefined || args.app_path !== undefined || args.config_name !== undefined) {
    try {
      return await resolveSession(ctx, args);
    } catch (error) {
      // An unknown session_id is the agent's mistake; no session for an application is not.
      if (args.session_id !== undefined) {
        throw error;
      }
      return undefined;
    }
  }
  const running = workbenchDebugSessions().filter(tracked => tracked.state !== 'terminated');
  return running.length === 1 ? running[0] : undefined;
}

export async function breakpoint(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  ensureBreakpointCleanup();
  claim(vscode.debug.breakpoints);
  if (args.add !== undefined && !Array.isArray(args.add)) {
    throw invalid('add must be a list of breakpoints.');
  }
  if (args.remove !== undefined && (!Array.isArray(args.remove) || args.remove.some(id => typeof id !== 'string'))) {
    throw invalid('remove must be a list of breakpoint ids.');
  }
  if (args.clear !== undefined && typeof args.clear !== 'boolean') {
    throw invalid('clear must be true or false.');
  }
  const addList = (args.add as unknown[] | undefined) ?? [];
  const removeIds = (args.remove as string[] | undefined) ?? [];
  const tracked = await sessionForList(ctx, args);

  // Every request is checked before anything changes, so a bad one changes nothing.
  const roots = addList.length > 0 ? await ctx.deps.services.knownRoots() : [];
  const requests: BreakpointRequest[] = [];
  for (let index = 0; index < addList.length; index++) {
    requests.push(await checkRequest(addList[index], index, roots));
  }
  const all = vscode.debug.breakpoints;
  const toRemove: vscode.Breakpoint[] = [];
  for (const id of removeIds) {
    const found = all.find(bp => bp.id === id);
    if (!found) {
      throw invalid(`No breakpoint has the id "${logSafe(id, 80)}".`, 'Pass ids the breakpoint action returned; call debug_app with action "breakpoint" alone to list them.');
    }
    if (!agentBreakpoints.has(id)) {
      throw new McpToolError('INVALID_ARGUMENT', `The breakpoint "${id}" was set by the user, and only the user removes their own breakpoints.`, {
        hint: 'Ask the user to remove it in VS Code, or disable it there, if it is in the way.',
      });
    }
    toRemove.push(found);
  }

  let cleared = 0;
  if (args.clear === true) {
    cleared = removeAgentBreakpoints();
  }
  const removed = toRemove.filter(bp => vscode.debug.breakpoints.includes(bp));
  if (removed.length > 0) {
    vscode.debug.removeBreakpoints(removed);
    for (const bp of removed) {
      agentBreakpoints.delete(bp.id);
    }
  }

  const added: vscode.Breakpoint[] = [];
  const alreadySet: { index: number; id: string }[] = [];
  requests.forEach((request, index) => {
    const existing = existingAt(request);
    if (existing) {
      alreadySet.push({ index, id: existing.id });
      return;
    }
    added.push(toBreakpoint(request));
  });
  if (added.length > 0) {
    vscode.debug.addBreakpoints(added);
    for (const bp of added) {
      agentBreakpoints.add(bp.id);
    }
  }
  if (added.length > 0 || removed.length > 0) {
    persist();
  }
  if (tracked && added.length > 0) {
    await waitForSessionView(tracked, added);
  }

  const list = await Promise.all(vscode.debug.breakpoints.map(bp => breakpointOut(bp, tracked)));
  const unverified = list.filter(bp => bp.added_by_agent && bp.in_session && bp.in_session.verified === false);
  const addedIds = new Set(added.map(bp => bp.id));
  const unanswered = tracked ? list.filter(bp => addedIds.has(bp.id) && !bp.in_session).length : 0;
  return {
    action: 'breakpoint',
    ...(tracked ? { session_id: sessionIdOf(ctx, tracked) } : {}),
    added: added.map(bp => bp.id),
    ...(alreadySet.length > 0 ? { already_set: alreadySet } : {}),
    removed: removed.map(bp => bp.id),
    ...(args.clear === true ? { cleared } : {}),
    breakpoints: list,
    next: unverified.length > 0
      ? `${unverified.length} of the agent's breakpoints are not verified by the session: the line may hold no code, or the build may not match the source. Check in_session.message.`
      : unanswered > 0
        ? `The session has not confirmed ${unanswered} new breakpoint${unanswered === 1 ? '' : 's'} yet: call debug_app with action "breakpoint" alone to see in_session before continuing.`
        : tracked
          ? 'Wait for a breakpoint with debug_app action "control", command "continue" and wait_for_stop true.'
          : 'No session runs: the breakpoints apply when one starts. Call debug_app with action "start".',
  };
}

/**
 * Wait a little for the session to answer for new breakpoints: VS Code sends
 * them to the adapter after addBreakpoints returns, so right after the add
 * the session has no view of them yet, and an unverified one would go unseen.
 */
async function waitForSessionView(tracked: TrackedDebugSession, added: vscode.Breakpoint[]): Promise<void> {
  const reader = tracked.session as { getDebugProtocolBreakpoint?: (bp: vscode.Breakpoint) => Thenable<any> };
  if (typeof reader.getDebugProtocolBreakpoint !== 'function') {
    return;
  }
  const deadline = Date.now() + agentBreakpointTiming.verifyWaitMs;
  for (;;) {
    if (tracked.state === 'terminated') {
      return;
    }
    let waiting = 0;
    for (const bp of added) {
      try {
        if (!(await reader.getDebugProtocolBreakpoint(bp))) {
          waiting += 1;
        }
      } catch {
        // The session may be ending: the list shows the breakpoints without it.
        return;
      }
    }
    const left = deadline - Date.now();
    if (waiting === 0 || left <= 0) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(agentBreakpointTiming.verifyPollMs, left)));
  }
}
