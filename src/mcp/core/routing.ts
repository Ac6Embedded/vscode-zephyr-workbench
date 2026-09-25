// Which VS Code window should serve this call. Every agent config is static and
// identical, so routing is what makes one registration work across projects and
// across several open windows.

import { isInside, normalizeForCompare } from './argSafety';
import { WindowRecord } from './registry';
import { isMachineScope, routeByOf, ToolMeta } from './toolSpec';

export type RoutingMode = 'nearest' | 'strict';

/**
 * The folder a call routes by: the first of the tool's routing arguments that
 * holds a path. Only those count. Other `path`-like arguments exist
 * (query_devicetree's `path` is a devicetree node path) and must never steer
 * routing.
 */
export function routingTargetOf(meta: ToolMeta, args: Record<string, unknown> | undefined): string | undefined {
  for (const key of routeByOf(meta)) {
    const value = args?.[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/** How the bridge routes one call. */
export interface CallRoute {
  /** The folder the call's routing arguments name, if any. */
  target?: string;
  /** The call acts on the machine and names no folder, so any window can serve it. */
  machineScope: boolean;
  /** The routing arguments the tool takes, in order: what a hint may tell the agent to pass. */
  routeBy: readonly string[];
}

export function routeOfCall(meta: ToolMeta, args: Record<string, unknown> | undefined): CallRoute {
  const target = routingTargetOf(meta, args);
  const shape = meta.inputSchema.shape as Record<string, unknown>;
  return {
    target,
    machineScope: !target && isMachineScope(meta, args ?? {}),
    routeBy: routeByOf(meta).filter(key => key in shape),
  };
}

export interface ScoredWindow {
  record: WindowRecord;
  score: number;
  /** The folder that matched, for the ambiguity message. */
  matchedPath?: string;
}

/**
 * Score one window against a target directory.
 *
 * 3 plus the matched length: the target is inside a folder this window owns.
 *   That is the normal case, and the longest match wins so a nested app beats
 *   the west workspace that contains it.
 * 2 plus the matched length: a folder this window owns is inside the target.
 *   That covers an agent started at a monorepo root above the app.
 * 0: no relationship.
 */
export function scoreWindow(record: WindowRecord, target: string, platform: NodeJS.Platform = process.platform): ScoredWindow {
  const candidates = [...record.appRoots, ...record.workspaceFolders, ...record.westWorkspaces];
  let best = 0;
  let matchedPath: string | undefined;
  for (const candidate of candidates) {
    const length = normalizeForCompare(candidate, platform).length;
    if (isInside(target, candidate, platform)) {
      const score = 3 + length / 10000;
      if (score > best) {
        best = score;
        matchedPath = candidate;
      }
    } else if (isInside(candidate, target, platform)) {
      const score = 2 + length / 10000;
      if (score > best) {
        best = score;
        matchedPath = candidate;
      }
    }
  }
  return { record, score: best, matchedPath };
}

function focusTime(record: WindowRecord): number {
  const t = Date.parse(record.focusedAt);
  return Number.isNaN(t) ? 0 : t;
}

export interface SelectOptions {
  /** Explicit pin from --window or ZW_MCP_WINDOW. A stale pin is ignored, never fatal. */
  pinnedWindowId?: string;
  /** Directory to route by: a call's app_path, else the workspace, else cwd. */
  target?: string;
  mode?: RoutingMode;
  /** Read-only calls may fall back to the focused window; mutating calls may not. */
  allowFocusFallback?: boolean;
  /**
   * The call acts on the machine rather than on a folder, such as installing a
   * toolchain, so any window can serve it: with no path match it falls back to
   * the most recently focused window, like a read.
   */
  machineScope?: boolean;
  platform?: NodeJS.Platform;
}

export interface SelectResult {
  chosen?: WindowRecord;
  /** Populated when nothing could be chosen unambiguously. */
  candidates: WindowRecord[];
  reason: 'pinned' | 'path' | 'single' | 'focused' | 'none' | 'ambiguous';
  /**
   * For a 'path' choice: 3 or more when the target is inside the chosen
   * window's folders, between 2 and 3 when a window folder is inside the target.
   */
  score?: number;
}

/** Pick the window to serve a call. Pure, so it is fully unit testable. */
export function selectWindow(records: WindowRecord[], options: SelectOptions = {}): SelectResult {
  const platform = options.platform ?? process.platform;
  const anyWindowWillDo = options.allowFocusFallback === true || options.machineScope === true;
  const live = records.slice();
  if (live.length === 0) {
    return { candidates: [], reason: 'none' };
  }

  if (options.pinnedWindowId) {
    const pinned = live.find(r => r.windowId === options.pinnedWindowId);
    if (pinned) {
      return { chosen: pinned, candidates: live, reason: 'pinned' };
    }
    // Fall through deliberately: a stale pin must not strand the agent.
  }

  if (options.target) {
    const scored = live
      .map(r => scoreWindow(r, options.target as string, platform))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score || focusTime(b.record) - focusTime(a.record));
    if (scored.length > 0) {
      const top = scored[0];
      // Score below 3 means "a window's folder is inside the target", not "the
      // target is inside a window". An agent started at "/" or $HOME matches
      // every window that way, so the longest folder winning is a guess. That
      // is acceptable for a read, never for a build.
      const containmentMatches = scored.filter(s => s.score >= 2 && s.score < 3);
      if (top.score < 3 && containmentMatches.length > 1 && !anyWindowWillDo) {
        return { candidates: containmentMatches.map(s => s.record), reason: 'ambiguous' };
      }
      const tied = scored.filter(s => s.score === top.score);
      if (tied.length === 1 || focusTime(top.record) !== focusTime(tied[1].record)) {
        return { chosen: top.record, candidates: live, reason: 'path', score: top.score };
      }
      return { chosen: top.record, candidates: tied.map(s => s.record), reason: 'path', score: top.score };
    }
  }

  if (live.length === 1 && options.mode !== 'strict') {
    return { chosen: live[0], candidates: live, reason: 'single' };
  }

  if (anyWindowWillDo && options.mode !== 'strict') {
    const focused = live.slice().sort((a, b) => focusTime(b) - focusTime(a))[0];
    return { chosen: focused, candidates: live, reason: 'focused' };
  }

  return { candidates: live, reason: 'ambiguous' };
}

/** The message shown when several windows are open and none matched. */
export function describeCandidates(records: WindowRecord[]): string {
  return records
    .map(r => `${r.windowId} (${r.workspaceFolders.join(', ') || 'no folder'})`)
    .join('; ');
}
