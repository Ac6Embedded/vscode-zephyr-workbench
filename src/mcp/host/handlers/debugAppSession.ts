// What every debug_app action shares: which session a call means, and how a
// session is shown to the agent. A session_id is "<windowId>.dbg-<id>", so the
// bridge sends a call carrying one to the window that runs the session.

import * as vscode from 'vscode';
import { readPanelStateFromConfig } from '../../../debug/backends/backendState';
import { serverOutputTail } from '../../../debug/backends/serverRegistry';
import { ZW_RUNNER_KEY } from '../../../debug/backends/types';
import { FrameView, stackFrames, threadList } from '../../../debug/dapRequests';
import {
  debugSessionsFor, DebugStop, findWorkbenchSession, isSessionOf, outputTail, TrackedDebugSession, workbenchDebugSessions,
} from '../../../debug/sessionTracker';
import { ZephyrApplication } from '../../../models/ZephyrApplication';
import { getSelectedWorkspaceApplicationPath } from '../../../utils/zephyr/workspaceApplications';
import { normalizeForCompare } from '../../core/argSafety';
import { McpToolError } from '../../core/errors';
import { logSafe } from '../../core/redact';
import { ToolContext } from '../../core/toolSpec';
import { SESSION_ID_PATTERN } from '../../bridge/ownerWindow';
import { HostDeps } from './deps';

export type Ctx = ToolContext<HostDeps>;

export const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
export const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function invalid(message: string, hint?: string, details?: Record<string, unknown>): McpToolError {
  return new McpToolError('INVALID_ARGUMENT', message, { ...(hint ? { hint } : {}), ...(details ? { details } : {}) });
}

export function boolArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value !== undefined && typeof value !== 'boolean') {
    throw invalid(`${key} must be true or false.`);
  }
  return value;
}

export function stringArgs(args: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    if (args[key] !== undefined && typeof args[key] !== 'string') {
      throw invalid(`${key} must be a string.`);
    }
  }
}

/** Seconds a wait may last: wait_sec, else the workbench setting. */
export function waitSecOf(args: Record<string, unknown>, fallback: number): number {
  const value = args.wait_sec;
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalid('wait_sec must be a number of seconds, 0 or more.');
  }
  return value;
}

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The id of this window; tests without one share a fixed id. */
export function windowIdOf(ctx: Ctx): string {
  return ctx.deps.windowId ?? 'local';
}

export function sessionIdOf(ctx: Ctx, tracked: TrackedDebugSession): string {
  return `${windowIdOf(ctx)}.${tracked.shortId}`;
}

export type SessionBackend = 'cppdbg' | 'cortex-west' | 'cortex-native';

/** The cortex-west backend runs as a cortex-debug session carrying the token of its west debug server. */
export function backendOfSession(tracked: TrackedDebugSession): SessionBackend {
  return tracked.type === 'cppdbg' ? 'cppdbg' : tracked.serverToken ? 'cortex-west' : 'cortex-native';
}

/** The west runner of a session, when its configuration says. */
export function runnerOfSession(tracked: TrackedDebugSession): string | undefined {
  try {
    const configuration = tracked.session.configuration;
    if (tracked.type === 'cortex-debug' && tracked.serverToken) {
      // The cortex-west provider builds this configuration afresh, naming the runner only here.
      const runner = configuration?.[ZW_RUNNER_KEY];
      return typeof runner === 'string' && runner.length > 0 ? runner : undefined;
    }
    if (tracked.type === 'cortex-debug') {
      return readPanelStateFromConfig(configuration).runnerName;
    }
    return typeof configuration?.debugServerArgs === 'string' ? readPanelStateFromConfig(configuration).runnerName : undefined;
  } catch {
    return undefined;
  }
}

/** The application a session debugs, among those of the window. */
export async function appOfSession(ctx: Ctx, tracked: TrackedDebugSession): Promise<ZephyrApplication | undefined> {
  let apps: ZephyrApplication[];
  try {
    apps = await ctx.deps.services.listApplications();
  } catch {
    return undefined;
  }
  const matches = apps.filter(app => isSessionOf(tracked, app));
  if (matches.length > 1) {
    // A legacy name fits every application of its west workspace with that
    // configuration; the launch debugged the selected one.
    const selected = matches.find(app => {
      const chosen = selectedWorkspaceApplication(app.appWorkspaceFolder);
      return chosen !== undefined && normalizeForCompare(chosen) === normalizeForCompare(app.appRootPath);
    });
    if (selected) {
      return selected;
    }
  }
  return matches[0];
}

function selectedWorkspaceApplication(folder: vscode.WorkspaceFolder): string | undefined {
  try {
    return getSelectedWorkspaceApplicationPath(folder);
  } catch {
    return undefined;
  }
}

const STATUS_HINT = 'Call debug_app with action "status" to see the sessions running in this window and their session_id.';

/** The session a call means: session_id, else the one session of app_path and config_name, else of the window. */
export async function resolveSession(ctx: Ctx, args: Record<string, unknown>): Promise<TrackedDebugSession> {
  stringArgs(args, ['session_id', 'app_path', 'config_name']);
  const sessionId = str(args.session_id);
  if (sessionId !== undefined) {
    const match = SESSION_ID_PATTERN.exec(sessionId);
    if (!match) {
      throw new McpToolError('SESSION_NOT_FOUND', `"${logSafe(sessionId, 100)}" is not a debug session id, which looks like "<window>.dbg-<id>".`, { hint: STATUS_HINT });
    }
    if (match[1] !== windowIdOf(ctx)) {
      throw new McpToolError('SESSION_NOT_FOUND', `The debug session ${sessionId} belongs to another VS Code window, which did not answer.`, { hint: STATUS_HINT });
    }
    const found = findWorkbenchSession(match[2]);
    if (found.tracked && found.tracked.state !== 'terminated') {
      return found.tracked;
    }
    const gone = found.tracked ?? found.ended;
    if (gone) {
      throw new McpToolError('SESSION_NOT_FOUND', `The debug session ${sessionId} ("${gone.name}") has ended.`, {
        hint: `${STATUS_HINT} Start it again with action "start".`,
        details: {
          ...(gone.endedAt ? { ended_at: new Date(gone.endedAt).toISOString() } : {}),
          ...(gone.exitCode !== undefined ? { exit_code: gone.exitCode } : {}),
          ...(gone.output.length > 0 ? { output_tail: outputTail(gone, 15) } : {}),
        },
      });
    }
    throw new McpToolError('SESSION_NOT_FOUND', `No debug session ${sessionId} runs in this window.`, { hint: STATUS_HINT });
  }

  let candidates: TrackedDebugSession[];
  let scope = 'this window';
  if (args.app_path !== undefined || args.config_name !== undefined) {
    const app = await ctx.deps.services.resolveApp(str(args.app_path));
    const config = args.config_name !== undefined ? ctx.deps.services.resolveConfig(app, str(args.config_name)) : undefined;
    candidates = debugSessionsFor(app, config?.name);
    scope = config ? `"${config.name}" of ${app.appRootPath}` : app.appRootPath;
  } else {
    candidates = workbenchDebugSessions();
  }
  candidates = candidates.filter(tracked => tracked.state !== 'terminated');
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (candidates.length === 0) {
    throw new McpToolError('SESSION_NOT_FOUND', `No Workbench debug session runs for ${scope}.`, {
      hint: 'Call debug_app with action "start" to start one.',
    });
  }
  throw invalid(`${candidates.length} Workbench debug sessions run for ${scope}, so session_id is required.`,
    'Pass session_id, one of details.sessions.',
    { sessions: candidates.map(tracked => ({ session_id: sessionIdOf(ctx, tracked), name: tracked.name, state: tracked.state })) });
}

/** A session that is gone or going refuses anything but status. */
export function assertAlive(ctx: Ctx, tracked: TrackedDebugSession): void {
  if (tracked.state === 'terminated') {
    throw new McpToolError('SESSION_NOT_FOUND', `The debug session ${sessionIdOf(ctx, tracked)} ("${tracked.name}") has ended.`, {
      hint: `${STATUS_HINT} Start it again with action "start".`,
    });
  }
}

/** The thread a request goes to: the argument, else the thread that stopped, else the first thread. */
export async function threadOf(tracked: TrackedDebugSession, argument: number | undefined): Promise<number | undefined> {
  if (argument !== undefined) {
    return argument;
  }
  if (tracked.lastStop?.threadId !== undefined) {
    return tracked.lastStop.threadId;
  }
  try {
    return (await threadList(tracked.session))[0]?.id;
  } catch {
    return undefined;
  }
}

export function frameOut(frame: FrameView) {
  return {
    function: frame.function,
    ...(frame.file ? { file: frame.file } : {}),
    ...(frame.line !== undefined ? { line: frame.line } : {}),
    ...(frame.address ? { address: frame.address } : {}),
  };
}

/** Where a stopped session is: its innermost frame, or undefined when it cannot be read. */
export async function topFrame(tracked: TrackedDebugSession): Promise<FrameView | undefined> {
  if (tracked.state !== 'stopped') {
    return undefined;
  }
  const threadId = await threadOf(tracked, undefined);
  if (threadId === undefined) {
    return undefined;
  }
  try {
    return (await stackFrames(tracked.session, threadId, 1))[0];
  } catch {
    return undefined;
  }
}

export function stopOut(stop: DebugStop | undefined, frame: FrameView | undefined) {
  if (!stop) {
    return undefined;
  }
  return {
    reason: stop.reason,
    ...(stop.threadId !== undefined ? { thread_id: stop.threadId } : {}),
    ...(stop.description ? { description: stop.description } : {}),
    ...(stop.text ? { text: stop.text } : {}),
    ...(stop.hitBreakpointIds && stop.hitBreakpointIds.length > 0 ? { hit_breakpoint_ids: stop.hitBreakpointIds } : {}),
    at: new Date(stop.at).toISOString(),
    ...(frame ? { frame: frameOut(frame) } : {}),
  };
}

/** How a session is shown: its handle, what it debugs, its state and where it stopped. */
export async function sessionOut(ctx: Ctx, tracked: TrackedDebugSession, options: { app?: ZephyrApplication; outputLines?: number } = {}) {
  const app = options.app ?? await appOfSession(ctx, tracked);
  const frame = await topFrame(tracked);
  const runner = runnerOfSession(tracked);
  const server = options.outputLines && tracked.serverToken ? serverOutputTail({ token: tracked.serverToken }) : undefined;
  const output = options.outputLines ? outputTail(tracked, options.outputLines) : '';
  return {
    session_id: sessionIdOf(ctx, tracked),
    name: tracked.name,
    type: tracked.type,
    backend: backendOfSession(tracked),
    ...(app ? { app_path: app.appRootPath } : {}),
    ...(tracked.configName ? { config_name: tracked.configName } : {}),
    ...(tracked.domain ? { domain: tracked.domain } : {}),
    ...(runner ? { runner } : {}),
    state: tracked.state,
    ...(tracked.lastStop && tracked.state === 'stopped' ? { stop: stopOut(tracked.lastStop, frame) } : {}),
    ...(tracked.lastStop && tracked.state !== 'stopped' ? { last_stop: stopOut(tracked.lastStop, undefined) } : {}),
    started_at: new Date(tracked.startedAt).toISOString(),
    ...(tracked.exitCode !== undefined ? { exit_code: tracked.exitCode } : {}),
    ...(output ? { output_tail: output } : {}),
    ...(server ? { server_output_tail: server.split('\n').slice(-(options.outputLines ?? 20)).join('\n') } : {}),
  };
}

/** The next step an agent can take, from the state of the session. */
export function nextFor(ctx: Ctx, tracked: TrackedDebugSession): string {
  const id = JSON.stringify(sessionIdOf(ctx, tracked));
  switch (tracked.state) {
    case 'stopped':
      return `The target is stopped. Read it with debug_app {"action": "inspect", "session_id": ${id}}, step or continue with action "control", or set breakpoints with action "breakpoint".`;
    case 'running':
      return `The target runs. Set a breakpoint with debug_app {"action": "breakpoint", "add": [...]} and wait for it with {"action": "control", "command": "continue", "session_id": ${id}, "wait_for_stop": true}, or stop it with command "pause".`;
    case 'starting':
      return `The session is still starting. Call debug_app with action "status" and session_id ${id} in a few seconds.`;
    default:
      return 'The session has ended. Call debug_app with action "start" to debug again.';
  }
}
