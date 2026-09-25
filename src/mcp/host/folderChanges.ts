// Workspace folder changes an agent asks for, applied so the answer still
// gets out.
//
// Adding the first folder, removing the first one, or turning a single-folder
// window into a multi-root workspace restarts every extension of the window,
// this one included, which would kill the MCP server in the middle of the call
// that asked. Such a change is answered first and applied a moment later, once
// no job of this window is running (and no new one may start while it lands),
// and the window keeps its id across the restart so the job ids an agent holds
// still resolve.

import * as vscode from 'vscode';
import { normalizeForCompare } from '../core/argSafety';
import { McpToolError } from '../core/errors';
import { isTerminal, JobState } from '../jobs/jobManager';
import { forgetWindowHandoff, rememberWindowHandoff } from './registryWriter';

export interface FolderChange {
  add?: string[];
  remove?: string[];
}

export interface FolderChangeOutcome {
  /** The folders are as asked by the time this returns. */
  applied: boolean;
  /** Scheduled instead: it restarts this window's extensions when it lands. */
  restart_pending: boolean;
  /** Jobs of this window the scheduled change waits for, other than the caller's own. */
  waiting_for_jobs?: string[];
}

/** Left for get_status in the extension host that comes back after the change. */
export interface RestartNote {
  at: string;
  reason: string;
  added: string[];
  removed: string[];
  job_id?: string;
}

export interface PendingFolderChange {
  add: string[];
  remove: string[];
  reason: string;
  job_id?: string;
  requested_at: string;
}

/** The workspace as the scheduler sees it. Injected so tests need no VS Code. */
export interface FolderWorkspace {
  /** Workspace folder paths, in order. */
  folders(): string[];
  /** True for a saved or untitled multi-root workspace. */
  hasWorkspaceFile(): boolean;
  /** One vscode.workspace.updateWorkspaceFolders call. False when VS Code refused it. */
  update(start: number, deleteCount: number, add: string[]): boolean;
  onDidChange(listener: () => void): { dispose(): void };
}

export interface SchedulerClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface FolderChangeSchedulerOptions {
  context: vscode.ExtensionContext;
  windowId: string;
  /** This window's jobs: a change that restarts the host waits until none runs. */
  jobs: { list(): ReadonlyArray<Pick<JobState, 'id' | 'status' | 'endedAt'>> };
  log(line: string): void;
  workspace?: FolderWorkspace;
  clock?: SchedulerClock;
}

interface CurrentFolders {
  workspaceFile: boolean;
  folders: string[];
}

interface FolderUpdate {
  start: number;
  deleteCount: number;
  add: string[];
}

interface Scheduled extends PendingFolderChange {
  /** Not applied before this, so the answer to the call that asked is sent first. */
  notBefore: number;
  since: number;
}

const NOTES_KEY = 'zephyr-workbench.mcp.restartNotes';
/** How long VS Code gets to confirm a change applied at once. */
const APPLY_TIMEOUT_MS = 20_000;
/** Time for the MCP answer to reach the agent before the extension host goes down. */
const ANSWER_GRACE_MS = 2_500;
const JOB_POLL_MS = 2_000;
const JOB_WAIT_LIMIT_MS = 30 * 60_000;
const NOTE_TTL_MS = 15 * 60_000;
/** Still running this long after a change meant to restart it: the host was not restarted. */
const NO_RESTART_MS = 30_000;

const same = (a: string, b: string) => normalizeForCompare(a) === normalizeForCompare(b);
const indexIn = (folders: readonly string[], folder: string) => folders.findIndex(f => same(f, folder));
const distinct = (folders: readonly string[]) => folders.filter((folder, i) => indexIn(folders, folder) === i);

/** What a change really does: the folders to add that are not there yet, and the ones to remove that are. */
function effectiveChange(change: FolderChange, folders: readonly string[]): { add: string[]; remove: string[] } {
  return {
    add: distinct(change.add ?? []).filter(folder => indexIn(folders, folder) < 0),
    remove: distinct(change.remove ?? []).filter(folder => indexIn(folders, folder) >= 0),
  };
}

/**
 * Whether VS Code restarts every extension of the window, this one included,
 * to make the change: always in an empty or single-folder window, where adding
 * a folder enters an untitled multi-root workspace, and in a workspace when
 * the first folder changes. A change that changes nothing restarts nothing.
 */
export function folderChangeRestartsHost(change: FolderChange, current: CurrentFolders): boolean {
  const { add, remove } = effectiveChange(change, current.folders);
  if (add.length === 0 && remove.length === 0) {
    return false;
  }
  if (!current.workspaceFile) {
    return true;
  }
  // Folders are added at the end, which is index 0 only in an empty workspace.
  return (add.length > 0 && current.folders.length === 0) || remove.some(folder => same(folder, current.folders[0]));
}

/**
 * The updateWorkspaceFolders calls for a change, in order. VS Code takes one
 * call at a time, each confirmed by onDidChangeWorkspaceFolders, and the call
 * that restarts the extension host must come last, or the ones after it are lost.
 */
function planFolderUpdates(change: FolderChange, current: CurrentFolders): FolderUpdate[] {
  const { add, remove } = effectiveChange(change, current.folders);
  const indexes = remove.map(folder => indexIn(current.folders, folder)).sort((a, b) => b - a);
  const updates: FolderUpdate[] = [];
  // The last folders first, so the indexes still to remove stay valid.
  for (const index of indexes.filter(i => i > 0)) {
    updates.push({ start: index, deleteCount: 1, add: [] });
  }
  const remaining = current.folders.length - updates.length;
  if (!indexes.includes(0)) {
    if (add.length > 0) {
      updates.push({ start: remaining, deleteCount: 0, add });
    }
    return updates;
  }
  if (!current.workspaceFile) {
    // A single-folder window: replacing its folder is one call, which enters
    // a workspace holding the new folders.
    updates.push({ start: 0, deleteCount: 1, add });
    return updates;
  }
  if (add.length > 0) {
    updates.push({ start: remaining, deleteCount: 0, add });
  }
  updates.push({ start: 0, deleteCount: 1, add: [] });
  return updates;
}

function resultingFolders(folders: readonly string[], change: { add: string[]; remove: string[] }): string[] {
  return [...folders.filter(folder => indexIn(change.remove, folder) < 0), ...change.add];
}

const vscodeWorkspace: FolderWorkspace = {
  folders: () => (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
  hasWorkspaceFile: () => vscode.workspace.workspaceFile !== undefined,
  update: (start, deleteCount, add) =>
    vscode.workspace.updateWorkspaceFolders(start, deleteCount, ...add.map(folder => ({ uri: vscode.Uri.file(folder) }))),
  onDidChange: listener => vscode.workspace.onDidChangeWorkspaceFolders(() => listener()),
};

const systemClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
};

export class FolderChangeScheduler implements vscode.Disposable {
  private readonly workspace: FolderWorkspace;
  private readonly clock: SchedulerClock;
  private queue: Scheduled[] = [];
  private timer: unknown;
  private waitLogged = false;
  /** Folder changes one after another: VS Code refuses a call while the previous one is unconfirmed. */
  private serial: Promise<unknown> = Promise.resolve();
  private disposed = false;
  /**
   * Set from the moment a change that restarts the host is applied, once no
   * job runs, until it is clear the host was not restarted after all.
   */
  private restarting = false;

  constructor(private readonly options: FolderChangeSchedulerOptions) {
    this.workspace = options.workspace ?? vscodeWorkspace;
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Add or remove workspace folders. A change that keeps the extension host
   * running is applied now, bounded to 20 seconds. One that restarts it is
   * only scheduled: it lands at least 2.5 seconds later, once no job of this
   * window runs, so the caller can answer and every job can finish first.
   */
  async apply(change: FolderChange, opts: { reason: string; jobId?: string }): Promise<FolderChangeOutcome> {
    const current = this.current();
    const effective = effectiveChange(change, current.folders);
    if (effective.add.length === 0 && effective.remove.length === 0) {
      return { applied: true, restart_pending: false };
    }
    if (!folderChangeRestartsHost(effective, current)) {
      const applied = await this.exclusive(() => this.run(planFolderUpdates(effective, this.current())));
      if (!applied) {
        this.options.log(`VS Code did not confirm the folder change (${describe(effective)}) for ${opts.reason}.`);
      }
      return { applied, restart_pending: false };
    }
    const now = this.clock.now();
    this.queue.push({
      ...effective,
      reason: opts.reason,
      ...(opts.jobId ? { job_id: opts.jobId } : {}),
      requested_at: new Date(now).toISOString(),
      notBefore: now + ANSWER_GRACE_MS,
      since: now,
    });
    this.options.log(`Scheduled the folder change (${describe(effective)}) for ${opts.reason}: it restarts the extensions of this window.`);
    this.arm(ANSWER_GRACE_MS);
    const waiting = this.runningJobs().filter(id => id !== opts.jobId);
    return { applied: false, restart_pending: true, ...(waiting.length > 0 ? { waiting_for_jobs: waiting } : {}) };
  }

  /** Changes scheduled and not applied yet. */
  pending(): PendingFolderChange[] {
    return this.queue.map(({ add, remove, reason, job_id, requested_at }) =>
      ({ add: [...add], remove: [...remove], reason, ...(job_id ? { job_id } : {}), requested_at }));
  }

  /**
   * Throw BUSY while a change that restarts this window's extensions is being
   * applied: the restart would kill a job started now. The job manager asks
   * this before every new job.
   */
  refuseJobStart(): void {
    if (this.restarting && !this.disposed) {
      throw new McpToolError('BUSY', 'This VS Code window is applying a folder change that restarts its extensions, which would stop a job started now.', {
        hint: 'Retry in a few seconds, once the window is back. Call get_status to see the change it made.',
      });
    }
  }

  /** Why this window's extensions restarted in the last 15 minutes, when a scheduled folder change did it. */
  restartNotice(): RestartNote | undefined {
    const note = this.readNotes()[this.options.windowId];
    return note && Date.parse(note.at) + NOTE_TTL_MS > this.clock.now() ? note : undefined;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.queue = [];
  }

  private current(): CurrentFolders {
    return { workspaceFile: this.workspace.hasWorkspaceFile(), folders: this.workspace.folders() };
  }

  private runningJobs(): string[] {
    // A cancelled job counts until its process has exited.
    return this.options.jobs.list().filter(job => !isTerminal(job.status) || job.endedAt === undefined).map(job => job.id);
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(work);
    this.serial = next.catch(() => undefined);
    return next;
  }

  private arm(ms: number): void {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
    }
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.tick().catch(error =>
        this.options.log(`The scheduled folder change failed: ${error instanceof Error ? error.message : String(error)}`));
    }, ms);
  }

  private async tick(): Promise<void> {
    if (this.disposed || this.queue.length === 0) {
      return;
    }
    const now = this.clock.now();
    const notBefore = Math.max(...this.queue.map(entry => entry.notBefore));
    if (now < notBefore) {
      this.arm(notBefore - now);
      return;
    }
    const running = this.runningJobs();
    if (running.length > 0) {
      const since = Math.min(...this.queue.map(entry => entry.since));
      if (now - since >= JOB_WAIT_LIMIT_MS) {
        this.options.log(`Gave up on the folder change (${describe(merge(this.queue))}) after 30 minutes: `
          + `job(s) ${running.join(', ')} still running, and applying it would restart the extensions under them.`);
        this.queue = [];
        this.waitLogged = false;
        return;
      }
      if (!this.waitLogged) {
        this.options.log(`The folder change waits for job(s) ${running.join(', ')} to finish.`);
        this.waitLogged = true;
      }
      this.arm(JOB_POLL_MS);
      return;
    }
    const batch = this.queue.splice(0);
    this.waitLogged = false;
    await this.exclusive(() => this.applyScheduled(batch));
  }

  /** Apply every scheduled change in one go: the first to land would restart the host and drop the rest. */
  private async applyScheduled(batch: Scheduled[]): Promise<void> {
    if (this.disposed) {
      return;
    }
    const current = this.current();
    const effective = effectiveChange(merge(batch), current.folders);
    if (effective.add.length === 0 && effective.remove.length === 0) {
      return;
    }
    // The folders may have changed since it was scheduled, so ask again.
    const restarts = folderChangeRestartsHost(effective, current);
    const { context, windowId } = this.options;
    if (restarts) {
      // A job may have started while this change waited its turn. The
      // restart would kill it, so the change goes back to waiting for it.
      if (this.runningJobs().length > 0) {
        this.queue.unshift(...batch);
        this.arm(JOB_POLL_MS);
        return;
      }
      // In the same tick as that check: no job starts from here on.
      this.restarting = true;
    }
    let applied = false;
    try {
      if (restarts) {
        await rememberWindowHandoff(context, windowId, resultingFolders(current.folders, effective));
        const jobId = [...batch].reverse().find(entry => entry.job_id)?.job_id;
        await this.saveNote({
          at: new Date(this.clock.now()).toISOString(),
          reason: distinct(batch.map(entry => entry.reason)).join('; '),
          added: effective.add,
          removed: effective.remove,
          ...(jobId ? { job_id: jobId } : {}),
        });
      }
      this.options.log(`Applying the folder change (${describe(effective)})${restarts ? ': the extensions of this window restart now' : ''}.`);
      applied = await this.run(planFolderUpdates(effective, current));
    } finally {
      if (!applied) {
        // Refused, unconfirmed or failed: this host keeps running, and so may jobs.
        this.restarting = false;
      }
    }
    if (!applied) {
      this.options.log(`VS Code did not confirm the folder change (${describe(effective)}).`);
    }
    if (restarts) {
      // Still running well after the change: VS Code did not restart this
      // host, so the handoff and the note would only mislead another window.
      this.clock.setTimeout(() => {
        this.restarting = false;
        if (!this.disposed) {
          void forgetWindowHandoff(context, windowId).then(() => this.forgetNote(), () => undefined);
        }
      }, NO_RESTART_MS);
    }
  }

  /** Make the calls one by one, each confirmed, within one 20 second budget. */
  private async run(updates: FolderUpdate[]): Promise<boolean> {
    const deadline = this.clock.now() + APPLY_TIMEOUT_MS;
    for (const update of updates) {
      let settle: (landed: boolean) => void = () => undefined;
      const landed = new Promise<boolean>(resolve => { settle = resolve; });
      const listener = this.workspace.onDidChange(() => settle(true));
      const timer = this.clock.setTimeout(() => settle(false), Math.max(0, deadline - this.clock.now()));
      try {
        if (!this.workspace.update(update.start, update.deleteCount, update.add) || !await landed) {
          return false;
        }
      } finally {
        listener.dispose();
        this.clock.clearTimeout(timer);
      }
    }
    return true;
  }

  private readNotes(): Record<string, RestartNote> {
    const stored = this.options.context.globalState.get<unknown>(NOTES_KEY);
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, RestartNote> : {};
  }

  /** User-wide state, like the handoff: the host that reads it has a new workspace state. */
  private async saveNote(note: RestartNote): Promise<void> {
    const now = this.clock.now();
    const notes = Object.fromEntries(Object.entries(this.readNotes())
      .filter(([, kept]) => typeof kept?.at === 'string' && Date.parse(kept.at) + NOTE_TTL_MS > now));
    await this.options.context.globalState.update(NOTES_KEY, { ...notes, [this.options.windowId]: note });
  }

  private async forgetNote(): Promise<void> {
    const notes = this.readNotes();
    if (notes[this.options.windowId]) {
      delete notes[this.options.windowId];
      await this.options.context.globalState.update(NOTES_KEY, Object.keys(notes).length > 0 ? notes : undefined);
    }
  }
}

function merge(entries: readonly { add: string[]; remove: string[] }[]): { add: string[]; remove: string[] } {
  return { add: distinct(entries.flatMap(entry => entry.add)), remove: distinct(entries.flatMap(entry => entry.remove)) };
}

function describe(change: { add: string[]; remove: string[] }): string {
  return [
    ...(change.add.length > 0 ? [`add ${change.add.join(', ')}`] : []),
    ...(change.remove.length > 0 ? [`remove ${change.remove.join(', ')}`] : []),
  ].join('; ');
}
