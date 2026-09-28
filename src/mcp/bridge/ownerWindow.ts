// The window a call belongs to, read from the handle it carries. A job and a
// debug session live in the memory of the window that started them, so a
// call naming one must go to that window and no other. Both handles start
// with the window id: `<windowId>.<kind>-<suffix>` for a job,
// `<windowId>.dbg-<suffix>` for a debug session.

import { McpToolError } from '../core/errors';
import { WINDOW_ID_PATTERN, WindowRecord } from '../core/registry';

/** A debug_app session_id: the window id, then the session's short id. */
export const SESSION_ID_PATTERN = /^([A-Za-z0-9_-]{1,64})\.(dbg-[a-z0-9]{1,40})$/;

/** A job id starts with the id of the window that ran it: `<windowId>.<kind>-<suffix>`. */
export function jobWindowOf(args: Record<string, unknown> | undefined): string | undefined {
  const jobId = args?.job_id;
  if (typeof jobId !== 'string') {
    return undefined;
  }
  const windowId = jobId.split('.')[0];
  return jobId.includes('.') && WINDOW_ID_PATTERN.test(windowId) ? windowId : undefined;
}

/** The window of a debug session_id, or undefined for anything else. */
export function sessionWindowOf(args: Record<string, unknown> | undefined): string | undefined {
  const sessionId = args?.session_id;
  if (typeof sessionId !== 'string') {
    return undefined;
  }
  const match = SESSION_ID_PATTERN.exec(sessionId);
  return match && WINDOW_ID_PATTERN.test(match[1]) ? match[1] : undefined;
}

/**
 * A session lives only as long as its window: when that window is gone, the
 * session ended with it, which is said at once instead of waiting for a
 * window that cannot answer for it.
 */
export function sessionWindowGone(records: readonly WindowRecord[], args: Record<string, unknown> | undefined): McpToolError | undefined {
  const windowId = sessionWindowOf(args);
  if (!windowId || records.some(record => record.windowId === windowId)) {
    return undefined;
  }
  return new McpToolError('SESSION_NOT_FOUND', `The VS Code window that ran the debug session ${String(args?.session_id)} is closed, so the session has ended.`, {
    hint: 'Call debug_app with action "status" to see the running sessions, or start a new one with action "start".',
  });
}
