// The debug sessions of Workbench debug configurations, followed from VS
// Code's session events from activation on, so a session the user started
// with F5 is known as well as one an agent started. Sessions are matched to an
// application and build configuration by the launch configuration name, whose
// grammar debugConfigNames.ts owns.
//
// A debug adapter tracker on the two adapter types a Workbench entry runs as
// also records what the adapter says: its capabilities, whether the target
// runs or is stopped and why, and the last lines of its output. That is what
// lets an agent wait for a breakpoint and read what gdb printed. The
// cortex-west backend runs as a second, cortex-debug session the provider
// starts itself; it keeps the entry's name, so it is matched the same way.

import * as vscode from 'vscode';
import {
  extractDebugBuildConfigName,
  extractDebugDomainName,
  extractWorkspaceApplicationPathFromDebugConfigName,
  ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME,
} from '../utils/debugTools/debugConfigNames';
import { ZW_SERVER_TOKEN_KEY } from './backends/types';

/** Debug types a Workbench debug configuration runs as. */
export const WORKBENCH_DEBUG_TYPES: ReadonlySet<string> = new Set(['cppdbg', 'cortex-debug']);

export type DebugSessionState = 'starting' | 'running' | 'stopped' | 'terminated';

/** A stopped event of the adapter. */
export interface DebugStop {
  reason: string;
  threadId?: number;
  description?: string;
  text?: string;
  allThreadsStopped?: boolean;
  hitBreakpointIds?: number[];
  at: number;
  /** 1 for the first stop of the session, then counting up. */
  seq: number;
}

/** An output event of the adapter: gdb's console, the program, the adapter itself. */
export interface DebugOutputLine {
  seq: number;
  category: string;
  text: string;
  at: number;
}

export interface TrackedDebugSession {
  session: vscode.DebugSession;
  /** The launch configuration name, "Zephyr Workbench Debug ..." for ours. */
  name: string;
  type: string;
  /** Folder of the launch.json the configuration came from, when VS Code says. */
  workspaceFolder?: string;
  /** The build configuration named in the entry name, when there is one. */
  configName?: string;
  domain?: string;
  /** For a west workspace application: its path relative to the west workspace. */
  appRelPath?: string;
  startedAt: number;
  /** "dbg-<id>", unique among the sessions of this window and stable for the session. */
  shortId: string;
  /** Set on the cortex-debug session of the cortex-west backend: the key of its west debug server. */
  serverToken?: string;
  state: DebugSessionState;
  /** The body of the adapter's initialize response. */
  capabilities?: Record<string, unknown>;
  lastStop?: DebugStop;
  /** How many stopped events the session has had. */
  stopCount: number;
  /** The last lines of output, oldest first. */
  output: DebugOutputLine[];
  /** How many output events the session has had. */
  outputCount: number;
  exitCode?: number;
  endedAt?: number;
}

/** Lines of adapter output kept per session. */
export const OUTPUT_RING_LINES = 300;
const OUTPUT_LINE_MAX_CHARS = 2000;
/** Ended sessions remembered, to tell an ended session_id from an unknown one. */
const ENDED_KEPT = 20;

const sessions = new Map<string, TrackedDebugSession>();
const ended: TrackedDebugSession[] = [];
/** Wakes whoever waits on a session: for a stop, the end, or new output. */
const changeListeners = new Map<string, Set<() => void>>();
type SessionEvent = { kind: 'started' | 'ended'; tracked: TrackedDebugSession };
const sessionListeners = new Set<(event: SessionEvent) => void>();

/** True for a launch configuration name the Debug Manager writes. */
export function isWorkbenchDebugName(name: string): boolean {
  return name === ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME || name.startsWith(`${ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME} `)
    || name.startsWith(`${ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME}:`);
}

function isWorkbenchSession(session: vscode.DebugSession): boolean {
  const name = session.configuration?.name ?? session.name;
  return WORKBENCH_DEBUG_TYPES.has(session.type) && typeof name === 'string' && isWorkbenchDebugName(name);
}

/** A short id from VS Code's session id, made unique among the live and remembered sessions. */
function shortIdFor(sessionId: string): string {
  const base = `dbg-${(sessionId.toLowerCase().replace(/[^a-z0-9]/g, '') || 'session').slice(0, 8)}`;
  const taken = new Set([...sessions.values(), ...ended].map(tracked => tracked.shortId));
  if (!taken.has(base)) {
    return base;
  }
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}${n}`)) {
      return `${base}${n}`;
    }
  }
}

function notify(tracked: TrackedDebugSession): void {
  for (const listener of [...(changeListeners.get(tracked.session.id) ?? [])]) {
    listener();
  }
}

function emit(event: SessionEvent): void {
  for (const listener of [...sessionListeners]) {
    try {
      listener(event);
    } catch {
      // A listener's failure must not stop the others, nor the tracking.
    }
  }
}

/** The record of a Workbench session, made on first sight: the adapter tracker can come before the start event. */
function track(session: vscode.DebugSession, now: number): TrackedDebugSession | undefined {
  if (!isWorkbenchSession(session)) {
    return undefined;
  }
  const known = sessions.get(session.id);
  if (known) {
    return known;
  }
  const name: string = session.configuration?.name ?? session.name;
  const token = session.configuration?.[ZW_SERVER_TOKEN_KEY];
  const tracked: TrackedDebugSession = {
    session,
    name,
    type: session.type,
    workspaceFolder: session.workspaceFolder?.uri.fsPath,
    configName: extractDebugBuildConfigName(name),
    domain: extractDebugDomainName(name),
    appRelPath: extractWorkspaceApplicationPathFromDebugConfigName(name),
    startedAt: now,
    shortId: shortIdFor(session.id),
    ...(typeof token === 'string' ? { serverToken: token } : {}),
    state: 'starting',
    stopCount: 0,
    output: [],
    outputCount: 0,
  };
  sessions.set(session.id, tracked);
  emit({ kind: 'started', tracked });
  return tracked;
}

function end(sessionId: string, now: number): void {
  const tracked = sessions.get(sessionId);
  if (!tracked) {
    return;
  }
  sessions.delete(sessionId);
  runRequests.delete(sessionId);
  tracked.state = 'terminated';
  tracked.endedAt = now;
  ended.push(tracked);
  if (ended.length > ENDED_KEPT) {
    ended.shift();
  }
  notify(tracked);
  changeListeners.delete(sessionId);
  emit({ kind: 'ended', tracked });
}

/** The requests after whose answer the target runs, until its next stop. */
const RUN_REQUESTS: ReadonlySet<string> = new Set(['continue', 'next', 'stepIn', 'stepOut', 'stepBack', 'reverseContinue', 'goto']);

/**
 * By session id, then request seq: the stop count when a run request was
 * sent. An adapter can send the stopped event of a short step before its
 * answer to the step (cortex-debug parses gdb's "^running" and "*stopped" of
 * one read in the same pass), and that answer must not mark the stopped
 * target as running again. VS Code applies the same rule to its own view.
 */
const runRequests = new Map<string, Map<number, number>>();

/** Record one message VS Code sent the adapter. Exported for the tests, which script DAP traffic. */
export function recordClientMessage(tracked: TrackedDebugSession, message: any): void {
  if (message?.type !== 'request' || typeof message.seq !== 'number' || !RUN_REQUESTS.has(message.command)) {
    return;
  }
  const id = tracked.session.id;
  let pending = runRequests.get(id);
  if (!pending) {
    pending = new Map();
    runRequests.set(id, pending);
  }
  pending.set(message.seq, tracked.stopCount);
}

/** Record one message the adapter sent. Exported for the tests, which script DAP traffic. */
export function recordAdapterMessage(tracked: TrackedDebugSession, message: any, now = Date.now()): void {
  if (!message || typeof message !== 'object') {
    return;
  }
  if (message.type === 'response') {
    // The stop count when its request was sent, undefined for a request not seen.
    const pending = runRequests.get(tracked.session.id);
    const stopsBefore = typeof message.request_seq === 'number' ? pending?.get(message.request_seq) : undefined;
    if (stopsBefore !== undefined) {
      pending?.delete(message.request_seq);
    }
    if (message.success === false) {
      return;
    }
    switch (message.command) {
      case 'initialize':
        tracked.capabilities = message.body && typeof message.body === 'object' ? message.body : {};
        break;
      case 'configurationDone':
        if (tracked.state === 'starting') {
          tracked.state = 'running';
        }
        break;
      // Answering one of these means the target runs again: the adapter
      // sends no continued event for a request of the client. Unless it
      // already stopped again after the request was sent.
      case 'continue':
      case 'next':
      case 'stepIn':
      case 'stepOut':
      case 'stepBack':
      case 'reverseContinue':
      case 'goto':
        if (tracked.state !== 'terminated' && (stopsBefore === undefined || tracked.stopCount === stopsBefore)) {
          tracked.state = 'running';
        }
        break;
      default:
        return;
    }
    notify(tracked);
    return;
  }
  if (message.type !== 'event') {
    return;
  }
  const body = message.body && typeof message.body === 'object' ? message.body : {};
  switch (message.event) {
    case 'stopped': {
      if (tracked.state === 'terminated') {
        return;
      }
      tracked.stopCount += 1;
      tracked.state = 'stopped';
      tracked.lastStop = {
        reason: typeof body.reason === 'string' ? body.reason : 'unknown',
        ...(typeof body.threadId === 'number' ? { threadId: body.threadId } : {}),
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
        ...(typeof body.text === 'string' ? { text: body.text } : {}),
        ...(typeof body.allThreadsStopped === 'boolean' ? { allThreadsStopped: body.allThreadsStopped } : {}),
        ...(Array.isArray(body.hitBreakpointIds) ? { hitBreakpointIds: body.hitBreakpointIds.filter((id: unknown) => typeof id === 'number') } : {}),
        at: now,
        seq: tracked.stopCount,
      };
      break;
    }
    case 'continued':
      if (tracked.state !== 'terminated') {
        tracked.state = 'running';
      }
      break;
    case 'output': {
      if (typeof body.output !== 'string' || body.category === 'telemetry') {
        return;
      }
      tracked.outputCount += 1;
      tracked.output.push({
        seq: tracked.outputCount,
        category: typeof body.category === 'string' ? body.category : 'console',
        text: body.output.length > OUTPUT_LINE_MAX_CHARS ? `${body.output.slice(0, OUTPUT_LINE_MAX_CHARS)}...` : body.output,
        at: now,
      });
      if (tracked.output.length > OUTPUT_RING_LINES) {
        tracked.output.splice(0, tracked.output.length - OUTPUT_RING_LINES);
      }
      break;
    }
    case 'exited':
      if (typeof body.exitCode === 'number') {
        tracked.exitCode = body.exitCode;
      }
      break;
    case 'terminated':
      tracked.state = 'terminated';
      break;
    default:
      return;
  }
  notify(tracked);
}

/** The tracker of one session's adapter traffic, or undefined for a session that is not a Workbench one. */
export function adapterTrackerFor(session: vscode.DebugSession): vscode.DebugAdapterTracker | undefined {
  if (!isWorkbenchSession(session)) {
    return undefined;
  }
  const record = () => sessions.get(session.id) ?? track(session, Date.now());
  // Made now, so the initialize response that comes first is not missed.
  record();
  return {
    onWillReceiveMessage: message => {
      const tracked = sessions.get(session.id);
      if (tracked) {
        recordClientMessage(tracked, message);
      }
    },
    onDidSendMessage: message => {
      const tracked = record();
      if (tracked) {
        recordAdapterMessage(tracked, message);
      }
    },
    onExit: code => {
      const tracked = sessions.get(session.id);
      if (tracked) {
        if (typeof code === 'number') {
          tracked.exitCode = code;
        }
        tracked.state = 'terminated';
        notify(tracked);
      }
    },
  };
}

/** Start following sessions. Called once at activation. */
export function startDebugSessionTracking(context: vscode.ExtensionContext): void {
  const factory: vscode.DebugAdapterTrackerFactory = { createDebugAdapterTracker: session => adapterTrackerFor(session) };
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession(session => {
      const tracked = track(session, Date.now());
      if (tracked) {
        // A session VS Code reports as started without any adapter traffic seen yet.
        notify(tracked);
      }
    }),
    vscode.debug.onDidTerminateDebugSession(session => end(session.id, Date.now())),
    ...[...WORKBENCH_DEBUG_TYPES].map(type => vscode.debug.registerDebugAdapterTrackerFactory(type, factory)),
  );
}

/** Every Workbench debug session running now, oldest first. */
export function workbenchDebugSessions(): TrackedDebugSession[] {
  return [...sessions.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** A running session by its short id, else undefined; `ended` says whether it ran in this window and ended. */
export function findWorkbenchSession(shortId: string): { tracked?: TrackedDebugSession; ended?: TrackedDebugSession } {
  const tracked = [...sessions.values()].find(entry => entry.shortId === shortId);
  if (tracked) {
    return { tracked };
  }
  const gone = ended.find(entry => entry.shortId === shortId);
  return gone ? { ended: gone } : {};
}

/** Be told when a Workbench session starts or ends. */
export function onWorkbenchSessionChange(listener: (event: SessionEvent) => void): { dispose(): void } {
  sessionListeners.add(listener);
  return { dispose: () => sessionListeners.delete(listener) };
}

/** Be told whenever something is recorded for this session. */
function onSessionChange(tracked: TrackedDebugSession, listener: () => void): () => void {
  const id = tracked.session.id;
  let set = changeListeners.get(id);
  if (!set) {
    set = new Set();
    changeListeners.set(id, set);
  }
  set.add(listener);
  return () => set?.delete(listener);
}

export type WaitOutcome = 'stopped' | 'terminated' | 'timeout' | 'aborted';

/**
 * Wait until the session stops after its stop number `afterStop`, or ends,
 * whichever comes first, within the deadline (a Date.now() time).
 */
export function waitForStop(tracked: TrackedDebugSession, options: { afterStop: number; deadline: number; signal?: AbortSignal }): Promise<WaitOutcome> {
  const check = (): WaitOutcome | undefined => {
    if (tracked.stopCount > options.afterStop) {
      return 'stopped';
    }
    if (tracked.state === 'terminated') {
      return 'terminated';
    }
    return undefined;
  };
  return waitFor(tracked, check, options);
}

/** Wait until `check` answers, re-checked whenever the session records something. */
function waitFor<T>(tracked: TrackedDebugSession, check: () => T | undefined, options: { deadline: number; signal?: AbortSignal }): Promise<T | 'timeout' | 'aborted'> {
  const now = check();
  if (now !== undefined) {
    return Promise.resolve(now);
  }
  if (options.signal?.aborted) {
    return Promise.resolve('aborted');
  }
  return new Promise(resolve => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: T | 'timeout' | 'aborted') => {
      unsubscribe();
      if (timer) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish('aborted');
    const unsubscribe = onSessionChange(tracked, () => {
      const value = check();
      if (value !== undefined) {
        finish(value);
      }
    });
    timer = setTimeout(() => finish('timeout'), Math.max(0, options.deadline - Date.now()));
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wait for a Workbench session accepted by `match` to start, among those not
 * running yet when the wait began. Subscribe before launching, so a session
 * that starts at once is not missed.
 */
export function waitForNewWorkbenchSession(
  match: (tracked: TrackedDebugSession) => boolean, options: { deadline: number; signal?: AbortSignal },
): { session: Promise<TrackedDebugSession | undefined>; cancel(): void } {
  const before = new Set(sessions.keys());
  let cancel: () => void = () => undefined;
  const session = new Promise<TrackedDebugSession | undefined>(resolve => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: TrackedDebugSession | undefined) => {
      subscription.dispose();
      if (timer) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(undefined);
    cancel = () => finish(undefined);
    const subscription = onWorkbenchSessionChange(event => {
      if (event.kind === 'started' && !before.has(event.tracked.session.id) && match(event.tracked)) {
        finish(event.tracked);
      }
    });
    timer = setTimeout(() => finish(undefined), Math.max(0, options.deadline - Date.now()));
    if (options.signal?.aborted) {
      finish(undefined);
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true });
    }
  });
  return { session, cancel: () => cancel() };
}

/**
 * The output recorded after output number `after`, waiting until it has been
 * quiet for `quietMs` (at most until `deadline`), for the text a command made
 * gdb print after its response.
 */
export async function outputAfter(tracked: TrackedDebugSession, after: number, options: { quietMs: number; deadline: number }): Promise<DebugOutputLine[]> {
  for (;;) {
    const seen = tracked.outputCount;
    const remaining = options.deadline - Date.now();
    if (remaining <= 0 || tracked.state === 'terminated') {
      break;
    }
    const outcome = await waitFor(tracked, () => (tracked.outputCount > seen ? true : undefined), {
      deadline: Date.now() + Math.min(options.quietMs, remaining),
    });
    if (outcome !== true) {
      break;
    }
  }
  return tracked.output.filter(line => line.seq > after);
}

/** The last `lines` lines of output of a session, as one text. */
export function outputTail(tracked: TrackedDebugSession, lines = 30): string {
  return tracked.output.map(line => line.text).join('').split(/\r?\n/).filter(line => line.length > 0).slice(-lines).join('\n');
}

/** Structural subset of ZephyrApplication the matching needs. */
export interface SessionAppRef {
  appRootPath: string;
  appName: string;
  isWestWorkspaceApplication: boolean;
  appWorkspaceFolder: { uri: { fsPath: string } };
  /** Its build configurations, which narrow the legacy names it adopts. */
  buildConfigs?: ReadonlyArray<{ name: string }>;
}

const sameFolder = (a: string | undefined, b: string): boolean => {
  if (!a) {
    return false;
  }
  const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return process.platform === 'win32' || process.platform === 'darwin'
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
};

/** Whether a tracked session debugs this application. */
export function isSessionOf(tracked: TrackedDebugSession, app: SessionAppRef): boolean {
  const folder = app.appWorkspaceFolder.uri.fsPath;
  if (tracked.workspaceFolder !== undefined && !sameFolder(tracked.workspaceFolder, folder)) {
    return false;
  }
  if (app.isWestWorkspaceApplication) {
    if (tracked.appRelPath === undefined) {
      // A legacy entry of the shared launch.json, named as a freestanding
      // one: it launches the selected application of the workspace, which
      // may be this one, so it counts as this application's when it has a
      // configuration of that name. Over-matching only refuses a flash or a
      // second session on a probe that may be held.
      return tracked.workspaceFolder !== undefined && tracked.configName !== undefined
        && (app.buildConfigs === undefined || app.buildConfigs.some(config => config.name === tracked.configName));
    }
    const rel = app.appRootPath.slice(folder.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
    return tracked.appRelPath === (rel.length > 0 ? rel : app.appName);
  }
  return tracked.appRelPath === undefined;
}

/**
 * The Workbench sessions debugging this application, and this build
 * configuration when one is given. A west workspace shares one launch.json, so
 * its applications are told apart by the path the entry name carries.
 */
export function debugSessionsFor(app: SessionAppRef, configName?: string): TrackedDebugSession[] {
  return workbenchDebugSessions().filter(tracked =>
    isSessionOf(tracked, app) && (configName === undefined || tracked.configName === configName));
}

/** For tests: forget every session. */
export function resetDebugSessionTrackingForTests(): void {
  sessions.clear();
  runRequests.clear();
  ended.length = 0;
  changeListeners.clear();
}

/** For tests: record a session as if VS Code had started it. */
export function trackDebugSessionForTests(session: vscode.DebugSession, now = Date.now()): TrackedDebugSession | undefined {
  return track(session, now);
}

/** For tests: end a session as if VS Code had terminated it. */
export function endDebugSessionForTests(sessionId: string, now = Date.now()): void {
  end(sessionId, now);
}
