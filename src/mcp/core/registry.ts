// One record per live VS Code window, written by the extension host and read by
// the bridge. Lessons taken from the prior art: a reader must never trust a
// record (stale files outlive crashes), and a reader must never delete one
// either, because on a shared home the record may belong to another host.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DIR_MODE, FILE_MODE, McpPaths } from './paths';

export const REGISTRY_SCHEMA = 1;

export interface WindowRecord {
  schema: number;
  windowId: string;
  pid: number;
  platform: NodeJS.Platform;
  hostname: string;
  /** Absent while the window is dormant, which is the `auto` listener state. */
  port?: number;
  /**
   * Informational only. A reader must connect to 127.0.0.1:<port> and never to
   * this value, or a planted record could send the token somewhere else.
   */
  url?: string;
  token?: string;
  /** Names of the tools this window exposes, so the bridge lists exactly those. */
  tools?: string[];
  workspaceFolders: string[];
  workspaceFile?: string | null;
  appRoots: string[];
  westWorkspaces: string[];
  ide: { name: string; version: string; uriScheme: string; remoteName?: string | null };
  nodeExecPath: string;
  extensionVersion: string;
  catalogVersion: string;
  startedAt: string;
  focusedAt: string;
  heartbeatAt: string;
  /**
   * Set when the window closed or started reloading. The record stays for a
   * short while so a bridge waits for the window to come back rather than
   * sending the call to some other window.
   */
  closingAt?: string;
  /** Why this window can never serve, such as an extension host too old for the server. */
  unsupported?: string;
}

/** How long a closing record keeps routing calls to its window. */
export const CLOSING_GRACE_MS = 30_000;

export function isClosing(record: WindowRecord, now = Date.now(), graceMs = CLOSING_GRACE_MS): boolean {
  if (typeof record.closingAt !== 'string') {
    return false;
  }
  const at = Date.parse(record.closingAt);
  return !Number.isNaN(at) && now - at < graceMs;
}

/** Heartbeats come every 30 seconds, so a live window's is never older than this. */
const CRASH_GRACE_MS = 60_000;

/**
 * A window whose extension host died without closing, such as a crash that
 * VS Code restarts: its pid is gone but its heartbeat is recent. It is treated
 * like a closing window, because the restarted host brings the same id back.
 */
export function isRecentlyCrashed(record: WindowRecord, now = Date.now()): boolean {
  if (record.closingAt !== undefined || isPidAlive(record) !== false) {
    return false;
  }
  const beat = Date.parse(record.heartbeatAt);
  return !Number.isNaN(beat) && now - beat < CRASH_GRACE_MS;
}

/** A record with no port is published but not listening. */
export function isListening(record: WindowRecord): boolean {
  return isValidPort(record.port) && !!record.token;
}

/** The only endpoint a reader may use, derived from the port alone. */
export function endpointOf(record: WindowRecord): { mcp: string; health: string } {
  return {
    mcp: `http://127.0.0.1:${record.port}/mcp`,
    health: `http://127.0.0.1:${record.port}/health`,
  };
}

/** Window ids become file names, so they are restricted to a safe alphabet. */
export const WINDOW_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536;
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string');

const isOptionalString = (value: unknown) => value === undefined || typeof value === 'string';

/** Every field a reader relies on, checked, because a record is untrusted input. */
export function isWindowRecord(value: unknown): value is WindowRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const r = value as Partial<WindowRecord>;
  return typeof r.schema === 'number'
    // A windowId like "../../.profile" would otherwise let a record steer a
    // path join, such as the bridge's wake marker, outside the directory.
    && typeof r.windowId === 'string' && WINDOW_ID_PATTERN.test(r.windowId)
    && typeof r.pid === 'number'
    && (r.port === undefined || isValidPort(r.port))
    && isOptionalString(r.token)
    && isStringArray(r.workspaceFolders)
    && isStringArray(r.appRoots)
    && isStringArray(r.westWorkspaces)
    && isOptionalString(r.focusedAt)
    && isOptionalString(r.closingAt)
    && isOptionalString(r.unsupported)
    && (r.tools === undefined || isStringArray(r.tools));
}

export function ensureDirs(paths: McpPaths): void {
  for (const dir of [paths.home, paths.windowsDir, paths.wakeDir, paths.locksDir, paths.jobsDir, paths.logsDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }
}

/** Write atomically: a reader must never see a half-written record. */
export function writeWindowRecord(paths: McpPaths, record: WindowRecord): void {
  ensureDirs(paths);
  const target = paths.windowRecord(record.windowId);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: FILE_MODE });
  fs.renameSync(tmp, target);
}

export function removeWindowRecord(paths: McpPaths, windowId: string): void {
  if (!WINDOW_ID_PATTERN.test(windowId)) {
    return;
  }
  try {
    fs.unlinkSync(paths.windowRecord(windowId));
  } catch {
    // Already gone, which is the desired end state.
  }
}

/**
 * On window close or reload: keep the record for a short grace period with no
 * port or token, so bridges wait for this window instead of routing to another.
 * The window id survives a reload, so the new record simply replaces this one.
 */
export function markOwnWindowRecordClosing(paths: McpPaths, windowId: string, pid: number, now = new Date()): void {
  if (!WINDOW_ID_PATTERN.test(windowId)) {
    return;
  }
  try {
    const current = JSON.parse(fs.readFileSync(paths.windowRecord(windowId), 'utf8')) as WindowRecord;
    if (current.pid !== pid) {
      return;
    }
    const closing: WindowRecord = { ...current, closingAt: now.toISOString() };
    delete closing.port;
    delete closing.url;
    delete closing.token;
    writeWindowRecord(paths, closing);
  } catch {
    // Missing or unreadable: nothing of ours to mark.
  }
}

/**
 * Remove the record only if this process still owns it. Two windows that
 * somehow share an id must not delete each other's record on close.
 */
export function removeOwnWindowRecord(paths: McpPaths, windowId: string, pid: number): void {
  if (!WINDOW_ID_PATTERN.test(windowId)) {
    return;
  }
  try {
    const current = JSON.parse(fs.readFileSync(paths.windowRecord(windowId), 'utf8')) as Partial<WindowRecord>;
    if (current.pid === pid) {
      fs.unlinkSync(paths.windowRecord(windowId));
    }
  } catch {
    // Missing or unreadable: nothing of ours to remove.
  }
}

export function readWindowRecords(paths: McpPaths): WindowRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(paths.windowsDir);
  } catch {
    return [];
  }
  const records: WindowRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(paths.windowsDir, name), 'utf8'));
      // Ignore a newer schema rather than guessing at its shape.
      if (isWindowRecord(parsed) && parsed.schema <= REGISTRY_SCHEMA) {
        records.push(parsed);
      }
    } catch {
      // Unreadable or malformed: treat as absent.
    }
  }
  return records;
}

/**
 * Cheap liveness. Only meaningful when the record was written by this same
 * machine, because a pid from another host would match a local process by
 * coincidence. EPERM means the process exists under another user.
 */
export function isPidAlive(record: WindowRecord, platform = process.platform, hostname = os.hostname()): boolean | undefined {
  if (record.platform !== platform || record.hostname !== hostname) {
    return undefined;
  }
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function isHeartbeatStale(record: WindowRecord, maxAgeMs: number, now: number): boolean {
  const beat = Date.parse(record.heartbeatAt);
  return Number.isNaN(beat) ? true : now - beat > maxAgeMs;
}

/**
 * Remove records this machine is sure are dead. Only the writing side calls
 * this, and only for records whose pid it can actually judge.
 */
export function pruneDeadRecords(paths: McpPaths, now: number, maxHeartbeatAgeMs = 5 * 60 * 1000): string[] {
  const removed: string[] = [];
  for (const record of readWindowRecords(paths)) {
    const alive = isPidAlive(record);
    if (alive === false && isHeartbeatStale(record, maxHeartbeatAgeMs, now)) {
      removeWindowRecord(paths, record.windowId);
      removed.push(record.windowId);
    }
  }
  return removed;
}
