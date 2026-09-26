// Finds the right VS Code window and talks to it.
//
// The bridge never deletes a window record, even one that looks dead: on a
// shared or network home the record may belong to another machine. It only
// skips what it cannot reach.

import * as fs from 'fs';
import * as http from 'http';
import { McpToolError } from '../core/errors';
import { FILE_MODE, DIR_MODE, getMcpPaths } from '../core/paths';
import { endpointOf, isClosing, isListening, isPidAlive, isRecentlyCrashed, readWindowRecords, WindowRecord } from '../core/registry';
import { describeCandidates, RoutingMode, scoreWindow, selectWindow } from '../core/routing';
import { BridgeLog } from './log';

export interface BridgeOptions {
  home?: string;
  pinnedWindowId?: string;
  workspace?: string;
  routing: RoutingMode;
}

export function readOptions(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): BridgeOptions {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    home: env.ZW_MCP_HOME || undefined,
    pinnedWindowId: flag('window') ?? (env.ZW_MCP_WINDOW || undefined),
    workspace: flag('workspace') ?? (env.ZW_MCP_WORKSPACE || cwd),
    routing: env.ZW_MCP_ROUTING === 'strict' ? 'strict' : 'nearest',
  };
}

/**
 * Records whose process is not known to be dead, plus windows that closed a
 * moment ago and may be reloading. Synchronous, no network.
 */
export function liveRecords(options: BridgeOptions, now = Date.now()): WindowRecord[] {
  return readWindowRecords(getMcpPaths(options.home))
    .filter(record => isGoneForNow(record, now) || (record.closingAt === undefined && isPidAlive(record) !== false));
}

/** Closed or crashed a moment ago, and likely to come back under the same id. */
function isGoneForNow(record: WindowRecord, now = Date.now()): boolean {
  return isClosing(record, now) || isRecentlyCrashed(record, now);
}

/**
 * The tools to advertise, from what the live windows publish. Undefined means
 * no window says, so the whole catalog is shown and the window decides per call.
 * A union, so two windows with different permissions never make the list flap.
 */
export function advertisedToolNames(records: readonly WindowRecord[]): Set<string> | undefined {
  const declared = records.filter(record => Array.isArray(record.tools));
  if (declared.length === 0) {
    return undefined;
  }
  return new Set(declared.flatMap(record => record.tools as string[]));
}

export interface ResolveOptions {
  /** A path from the call's arguments, preferred over the workspace. */
  target?: string;
  /** Only read-only calls may fall back to the most recently focused window. */
  readOnly: boolean;
  /**
   * The call acts on the machine and names no folder, so any window can serve
   * it: the only window even when the agent's folder is unrelated, else the
   * most recently focused one. A pin, strict routing and a lock still apply.
   */
  machineScope?: boolean;
  /**
   * The arguments the tool routes by (routeOfCall), which the hints tell the
   * agent to pass when no window can be chosen. Defaults to app_path.
   */
  routeBy?: readonly string[];
  /** Skip the health probe for a record the caller already holds a working connection to. */
  isKnownGood?(record: WindowRecord): boolean;
  /**
   * Only this window will do: the window that owns a job, or the window a
   * retry must go back to. Never substituted by another.
   */
  lockTo?: string;
  /**
   * Set when the lock is a job's window. Jobs live in memory, so a window
   * that closed or reloaded can never answer for one: that is reported at
   * once as JOB_NOT_FOUND instead of being waited for.
   */
  jobId?: string;
}

/** How a hint tells the agent to name a folder with each routing argument. */
const NAMING_A_FOLDER: Record<string, string> = {
  app_path: "app_path set to the application's absolute path (call list_apps to see them)",
  west_workspace: 'west_workspace set to the west workspace root, one of the west_workspaces[].path values get_status returns',
  path: 'path set to the absolute path of the file',
};

/**
 * What the agent can do so that a call picks a window: pass one of the
 * arguments this tool routes by, or set ZW_MCP_WORKSPACE.
 */
export function namingHint(routeBy: readonly string[] = ['app_path']): string {
  const ways = routeBy.map(key => NAMING_A_FOLDER[key] ?? `${key} set to an absolute path`);
  return ways.length > 0
    ? `Call again with ${ways.join(', or with ')}. Or set ZW_MCP_WORKSPACE for this agent to the folder it works on.`
    : 'Set ZW_MCP_WORKSPACE for this agent to the folder it works on.';
}

export interface Resolution {
  record?: WindowRecord;
  /** Every record read, for the advertised tool list. */
  records: WindowRecord[];
  /** Present when nothing could be chosen. */
  problem?: McpToolError;
  /** The chosen window may be back shortly (reloading, busy), so waiting is worthwhile. */
  waitable?: boolean;
}

export type Readiness = 'ready' | 'dormant' | 'closing' | 'stalled' | 'foreign' | 'unsupported';

/** What state a window is in, probing it only when it claims to listen. */
export async function readinessOf(record: WindowRecord, isKnownGood?: (record: WindowRecord) => boolean): Promise<Readiness> {
  if (record.unsupported) {
    return 'unsupported';
  }
  if (isGoneForNow(record)) {
    return 'closing';
  }
  if (!isListening(record)) {
    return 'dormant';
  }
  if (isKnownGood?.(record) || await probeRecord(record)) {
    return 'ready';
  }
  // Not answering. A local window that is alive is busy or restarting its
  // server; anything else is a record this bridge cannot use.
  return isPidAlive(record) === true ? 'stalled' : 'foreign';
}

const foldersOf = (record: WindowRecord) => record.workspaceFolders.join(', ') || record.windowId;

function judge(record: WindowRecord, state: Readiness, records: WindowRecord[]): Resolution {
  switch (state) {
    case 'ready':
    case 'dormant':
      return { record, records };
    case 'closing':
      return {
        records, waitable: true,
        problem: new McpToolError('WORKBENCH_NOT_RUNNING', `The VS Code window for ${foldersOf(record)} is reloading or closing.`, {
          hint: 'Retry in a few seconds. Nothing was started.',
        }),
      };
    case 'stalled':
      return {
        records, waitable: true,
        problem: new McpToolError('WORKBENCH_NOT_RUNNING', `The VS Code window for ${foldersOf(record)} is not answering.`, {
          hint: 'It may be busy or restarting its MCP server. Retry in a few seconds. Nothing was started.',
        }),
      };
    case 'unsupported':
      return {
        records,
        problem: new McpToolError('WORKBENCH_NOT_RUNNING', record.unsupported as string, {
          hint: 'Update VS Code, then reload the window.',
          // Retrying cannot help: only an update can.
          retryable: false,
        }),
      };
    default:
      return {
        records,
        problem: new McpToolError('WORKBENCH_NOT_RUNNING', `The VS Code window ${record.windowId} cannot be reached from here.`),
      };
  }
}

/**
 * Pick a window and confirm it can serve. A chosen window that is reloading or
 * busy is waited for, never swapped for another window: a build meant for one
 * application must not run in a different one because its window blinked.
 */
export async function resolveWindow(options: BridgeOptions, log: BridgeLog, resolve: ResolveOptions): Promise<Resolution> {
  const all = liveRecords(options);

  if (resolve.lockTo) {
    const locked = all.find(record => record.windowId === resolve.lockTo);
    const state = locked ? await readinessOf(locked, resolve.isKnownGood) : undefined;
    if (resolve.jobId && (!locked || state === 'closing')) {
      return {
        records: all,
        problem: new McpToolError('JOB_NOT_FOUND', `The VS Code window that ran ${resolve.jobId} closed or reloaded, so the job is gone.`, {
          hint: `Its log stays at ${getMcpPaths(options.home).jobLog(resolve.lockTo, resolve.jobId)}. Start the action again if it is still needed.`,
        }),
      };
    }
    if (!locked || !state) {
      return {
        records: all, waitable: true,
        problem: new McpToolError('WORKBENCH_NOT_RUNNING', `The VS Code window ${resolve.lockTo} is not running.`, {
          hint: 'If it is reloading, retry in a few seconds.',
        }),
      };
    }
    return judge(locked, state, all);
  }

  // A window that can never serve is left out of the choice, so another
  // window can answer; it is reported only when nothing else could.
  const unsupported = all.filter(record => record.unsupported);
  let candidates = all.filter(record => !record.unsupported);
  if (candidates.length === 0 && unsupported.length > 0) {
    return judge(unsupported[0], 'unsupported', all);
  }
  const target = resolve.target ?? options.workspace;
  for (;;) {
    if (candidates.length === 0) {
      return {
        records: all,
        problem: new McpToolError('WORKBENCH_NOT_RUNNING', 'No VS Code window is running Zephyr Workbench.', {
          hint: 'Open your Zephyr application folder in VS Code with Zephyr Workbench installed, and check that the zephyr-workbench.mcp.enabled setting is not "off". Nothing was started.',
        }),
      };
    }
    const selected = selectWindow(candidates, {
      pinnedWindowId: options.pinnedWindowId,
      target,
      mode: options.routing,
      allowFocusFallback: resolve.readOnly,
      machineScope: resolve.machineScope,
    });
    if (!selected.chosen) {
      return {
        records: all,
        problem: new McpToolError('AMBIGUOUS_WINDOW',
          `Several VS Code windows run Zephyr Workbench and none clearly contains "${target ?? ''}".`, {
            hint: `${namingHint(resolve.routeBy)} Windows: ${describeCandidates(selected.candidates)}`,
            details: { windows: selected.candidates.map(r => ({ window_id: r.windowId, folders: r.workspaceFolders })) },
          }),
      };
    }
    // An agent pinned to a window (started from its terminal, or registered
    // for it) must not have its builds sent elsewhere while that window is
    // gone, unless the call names a path inside another window.
    const pinnedElsewhere = options.pinnedWindowId !== undefined && selected.reason !== 'pinned';
    if (!resolve.readOnly && pinnedElsewhere && !(selected.reason === 'path' && (selected.score ?? 0) >= 3)) {
      const routeBy = resolve.routeBy ?? ['app_path'];
      return {
        records: all, waitable: true,
        problem: new McpToolError('WORKBENCH_NOT_RUNNING', `The VS Code window this agent belongs to (${options.pinnedWindowId}) is not running.`, {
          hint: `If it is reloading, retry in a few seconds.${routeBy.length > 0
            ? ` To use another window, pass ${routeBy.join(' or ')} with a folder of that window.` : ''}`,
        }),
      };
    }
    // A build must never land in an unrelated window just because it is the
    // only one open. With no path linking the call to that window, the agent
    // is asked to name the application or west workspace instead. A call on
    // the machine, such as a toolchain install, has no folder to name.
    if (!resolve.readOnly && !resolve.machineScope && selected.reason === 'single' && target
      && scoreWindow(selected.chosen, target).score === 0) {
      return {
        records: all,
        problem: new McpToolError('AMBIGUOUS_WINDOW',
          `No VS Code window has "${target}" open, so it is not clear which folder this call is for.`, {
            hint: namingHint(resolve.routeBy),
            details: { windows: [{ window_id: selected.chosen.windowId, folders: selected.chosen.workspaceFolders }] },
          }),
      };
    }
    const state = await readinessOf(selected.chosen, resolve.isKnownGood);
    if (state === 'foreign') {
      log.debug(`skipping ${selected.chosen.windowId}: it does not answer and is not a process on this machine`);
      candidates = candidates.filter(record => record !== selected.chosen);
      continue;
    }
    log.debug(`routing to window ${selected.chosen.windowId} (${selected.reason}, ${state})`);
    return judge(selected.chosen, state, all);
  }
}

/**
 * Resolve, and while the chosen window is reloading or busy, keep trying for
 * a few seconds. That is what a window reload looks like from here, and the
 * new record arrives shortly after.
 */
export async function resolveWindowPatiently(
  options: BridgeOptions, log: BridgeLog, resolve: ResolveOptions, waitMs = 8000, stepMs = 500,
): Promise<Resolution> {
  const deadline = Date.now() + waitMs;
  let resolution = await resolveWindow(options, log, resolve);
  while (resolution.waitable && Date.now() < deadline) {
    await new Promise(done => setTimeout(done, stepMs));
    resolution = await resolveWindow(options, log, resolve);
  }
  return resolution;
}

/** An authenticated health check that must name the same window. */
export async function probeRecord(record: WindowRecord, timeoutMs = 700): Promise<boolean> {
  if (!isListening(record)) {
    return false;
  }
  return new Promise(resolve => {
    const request = http.request(endpointOf(record).health, {
      method: 'GET',
      headers: { authorization: `Bearer ${record.token}` },
      timeout: timeoutMs,
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          resolve(response.statusCode === 200 && JSON.parse(body).windowId === record.windowId);
        } catch {
          resolve(false);
        }
      });
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.end();
  });
}

/** Ask a dormant window to start listening, then wait for it. */
export async function wake(
  record: WindowRecord, options: BridgeOptions, log: BridgeLog, waitMs = 6000, stepMs = 500,
): Promise<WindowRecord | undefined> {
  const paths = getMcpPaths(options.home);
  try {
    fs.mkdirSync(paths.wakeDir, { recursive: true, mode: DIR_MODE });
    fs.writeFileSync(paths.wakeMarker(record.windowId), String(process.pid), { mode: FILE_MODE });
    log.info(`asked window ${record.windowId} to start its MCP server`);
  } catch (error) {
    log.error(`could not write a wake marker: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  // The window polls for the marker, so give it a few seconds.
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise(done => setTimeout(done, stepMs));
    const refreshed = readWindowRecords(paths).find(r => r.windowId === record.windowId);
    if (refreshed && isListening(refreshed) && await probeRecord(refreshed)) {
      return refreshed;
    }
  }
  return undefined;
}
