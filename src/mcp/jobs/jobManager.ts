// Long actions run as jobs: bounded wait, then a handle.
//
// Every agent kills a tool call on a timeout (Codex, Cline and Roo default to
// 60 seconds), so an action waits a little under that and then hands back a
// job id. The runner is injected, which keeps this module vscode-free and
// fully unit testable.

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isInside, normalizeForCompare } from '../core/argSafety';
import { McpToolError } from '../core/errors';
import { JobLog } from './jobLog';
import { conflictOf, JobResource } from './jobConflicts';
import { isJobId, pruneJobRecords, readJobRecord, writeJobRecord } from './jobRecords';
import { Diagnostic, MemoryRegion, parseBuildOutput } from './diagnosticsParser';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type JobKind = 'build' | 'flash' | 'run' | 'clean' | 'west' | 'install' | 'task';

export interface JobSink {
  /** Raw output chunk from the process, before any cleaning. */
  onData(chunk: string): void;
}

export interface JobRunResult {
  exitCode?: number;
  /** What the job produced beyond its output. Returned to the agent as `result`. */
  extra?: Record<string, unknown>;
}

export interface JobSpec {
  kind: JobKind;
  /** Resource this job owns for its lifetime, normally the build directory. */
  lockKey: string;
  /** Identical requests attach to a running job instead of starting a second one. */
  requestKey: string;
  appPath?: string;
  configName?: string;
  buildDir?: string;
  /** The west workspace the job uses. Only read, unless `writes` names it. */
  westWorkspace?: string;
  /** The Python environment the job uses. Only read, unless `writes` names it. */
  venvPath?: string;
  /**
   * What the job changes; everything else it names is only read. A build or
   * a deletion writes its build folder without saying so. Two working jobs
   * that share a resource one of them writes never run together.
   */
  writes?: ReadonlyArray<JobResource>;
  /**
   * Whether the output is parsed for compiler diagnostics and memory usage.
   * Defaults to true for builds and tasks, which is where a compiler runs.
   */
  parse?: boolean;
  /** The command line, already redacted, shown to the user and the agent. */
  command: string;
  run(sink: JobSink, signal: AbortSignal): Promise<JobRunResult>;
  /** The next step once the job has finished, in place of the generic one. */
  next?(view: JobView): string;
}

export interface WaitOptions {
  /** Stop waiting (not the job) when the caller goes away. */
  signal?: AbortSignal;
  /** Heartbeat period for `tick`. */
  everyMs?: number;
  tick?(job: JobState): void;
}

export interface JobView {
  job_id: string;
  kind: JobKind;
  status: JobStatus;
  attached?: boolean;
  exit_code?: number;
  app_path?: string;
  config_name?: string;
  build_dir?: string;
  command: string;
  started_at: string;
  ended_at?: string;
  duration_ms: number;
  diagnostics?: { errors: number; warnings: number; items: Diagnostic[]; truncated: boolean };
  memory?: MemoryRegion[];
  log: { path: string; bytes: number; tail: string };
  /** What the job produced beyond its output, from the runner's `extra`. */
  result?: Record<string, unknown>;
  /** Set only on a view read back from the job's record, after a restart. */
  persisted?: boolean;
  next: string;
}

export interface JobState {
  id: string;
  spec: JobSpec;
  status: JobStatus;
  exitCode?: number;
  result?: Record<string, unknown>;
  startedAt: number;
  endedAt?: number;
  log: JobLog;
  controller: AbortController;
  buffer: string;
  done: Promise<void>;
  waiters: Set<() => void>;
}

/**
 * A finished job known only from its record, because the extension host
 * restarted since it ran or it aged out of memory. It answers status, log and
 * cancel, and nothing else.
 */
export interface PersistedJob {
  persisted: true;
  id: string;
  /** The stored view, marked `persisted`. */
  view: JobView;
  /** The job's log, read from disk. */
  log: JobLog;
}

export function isPersisted(job: JobState | PersistedJob): job is PersistedJob {
  return (job as PersistedJob).persisted === true;
}

export interface JobManagerOptions {
  /** Where the log for a job id lives. */
  logPathFor(jobId: string): string;
  /**
   * Where the record of a finished job lives, next to its log. Without it
   * nothing is recorded and a job is forgotten with the extension host.
   */
  recordPathFor?(jobId: string): string;
  /** Fired when a job starts, is cancelled, or ends. Drives the status bar. */
  onDidChange?(): void;
  /**
   * Asked before a new job starts, and throws to refuse it: while a folder
   * change restarts the extension host, a job started would be killed.
   */
  admit?(spec: JobSpec): void;
  /** Injected so tests need no timers. */
  now?(): number;
  maxRetained?: number;
  /** Cheap counter so ids are unique without Date.now in the hot path. */
  idSeed?: number;
  /**
   * The window id. Every job id starts with it (`<windowId>.<kind>-...`), so a
   * bridge can send a job call to the window that owns the job, and ids never
   * repeat across windows.
   */
  windowId?: string;
}

/**
 * The source and Zephyr directories a build used, from its CMakeCache.txt. For
 * sysbuild the top-level source is Zephyr's share/sysbuild; each image's own
 * source directory is then taken from the "-- Application:" lines in the log.
 */
function cacheDirsOf(buildDir: string | undefined): { sourceDir?: string; zephyrBase?: string } {
  if (!buildDir) {
    return {};
  }
  try {
    const cache = fs.readFileSync(path.join(buildDir, 'CMakeCache.txt'), 'utf8');
    const entry = (name: string) => new RegExp(`^${name}:[A-Z]+=(.*)$`, 'm').exec(cache)?.[1]?.trim() || undefined;
    return { sourceDir: entry('CMAKE_HOME_DIRECTORY'), zephyrBase: entry('ZEPHYR_BASE') };
  } catch {
    return {};
  }
}

const rank: Record<JobStatus, number> = { queued: 0, running: 1, succeeded: 2, failed: 2, cancelled: 2 };

export function isTerminal(status: JobStatus): boolean {
  return rank[status] === 2;
}

/**
 * True until the job's runner has settled. A cancelled job counts as working
 * while its process tree is still exiting, because it may still be writing.
 */
export function isWorking(job: JobState): boolean {
  return !isTerminal(job.status) || job.endedAt === undefined;
}

const RESOURCE_NOUN: Record<JobResource, string> = {
  build_dir: 'build directory',
  west_workspace: 'west workspace',
  venv: 'Python environment',
};

/** What a lock key stands for, to name it in a refusal. */
function lockedResource(spec: JobSpec): JobResource {
  const is = (value: string | undefined) => !!value && normalizeForCompare(value) === normalizeForCompare(spec.lockKey);
  if (!spec.buildDir && is(spec.westWorkspace)) {
    return 'west_workspace';
  }
  if (!spec.buildDir && is(spec.venvPath)) {
    return 'venv';
  }
  return 'build_dir';
}

export class JobManager {
  private readonly jobs = new Map<string, JobState>();
  private readonly byLock = new Map<string, string>();
  private counter: number;

  constructor(private readonly options: JobManagerOptions) {
    this.counter = options.idSeed ?? 0;
    if (options.recordPathFor) {
      try {
        // Every record of a window shares one folder; any id names it.
        pruneJobRecords(path.dirname(options.recordPathFor('probe')), this.now());
      } catch {
        // Old records are only clutter. They must never stop the server.
      }
    }
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private nextId(kind: JobKind): string {
    this.counter += 1;
    // Random as well as counted: the window id survives a reload, and a
    // restarted counter must not reissue an id an agent still holds.
    const id = `${kind}-${this.counter.toString(36)}-${randomBytes(3).toString('hex')}`;
    return this.options.windowId ? `${this.options.windowId}.${id}` : id;
  }

  /** A job already running for this exact request, if any. */
  findAttachable(spec: JobSpec): JobState | undefined {
    const holder = this.byLock.get(spec.lockKey);
    if (!holder) {
      return undefined;
    }
    const existing = this.jobs.get(holder);
    if (!existing || isTerminal(existing.status)) {
      return undefined;
    }
    return existing.spec.requestKey === spec.requestKey ? existing : undefined;
  }

  /**
   * Start a job, or attach to the identical one already running.
   * Throws BUSY when a working job holds the same lock, or shares a build
   * folder, west workspace or Python environment that one of the two writes,
   * naming it so the agent can poll instead of retrying blindly.
   */
  start(spec: JobSpec): { job: JobState; attached: boolean } {
    const attachable = this.findAttachable(spec);
    if (attachable) {
      return { job: attachable, attached: true };
    }
    this.options.admit?.(spec);
    // A cancelled job whose process tree is still exiting still counts, or a
    // second build could start in a directory the first is still writing to.
    for (const holder of this.list()) {
      const shared = isWorking(holder) ? conflictOf(spec, holder.spec) : undefined;
      if (!shared) {
        continue;
      }
      const noun = RESOURCE_NOUN[shared === 'lock' ? lockedResource(spec) : shared];
      const stopping = holder.status === 'cancelled';
      throw new McpToolError('BUSY',
        stopping
          ? `A cancelled ${holder.spec.kind} job (job_id "${holder.id}") is still stopping in this ${noun}.`
          : `A ${holder.spec.kind} job is already running for this ${noun} (job_id "${holder.id}").`, {
          hint: stopping
            ? 'Wait a few seconds for it to exit, then retry.'
            : `Poll it with job {"action": "status", "job_id": "${holder.id}"} or stop it with job {"action": "cancel"}.`,
          details: { job_id: holder.id, kind: holder.spec.kind, status: holder.status },
        });
    }

    const id = this.nextId(spec.kind);
    const controller = new AbortController();
    const log = new JobLog(this.options.logPathFor(id));
    log.open();

    let settle: () => void = () => undefined;
    const done = new Promise<void>(resolve => { settle = resolve; });

    const state: JobState = {
      id, spec, status: 'running', startedAt: this.now(), log, controller,
      buffer: '', done, waiters: new Set(),
    };
    this.jobs.set(id, state);
    this.byLock.set(spec.lockKey, id);
    this.options.onDidChange?.();

    const sink: JobSink = {
      onData: chunk => {
        state.log.append(chunk);
        // Kept in memory only for parsing; the log file is the real record.
        state.buffer = (state.buffer + chunk).slice(-512 * 1024);
      },
    };

    void spec.run(sink, controller.signal)
      .then(result => {
        state.exitCode = result.exitCode;
        state.result = result.extra;
        // Cancelled, or failed by failRunning: a late result changes neither.
        if (!isTerminal(state.status)) {
          state.status = result.exitCode === 0 ? 'succeeded' : 'failed';
        }
      })
      .catch(error => {
        if (!isTerminal(state.status)) {
          state.status = 'failed';
        }
        state.log.append(`\n${error instanceof Error ? error.message : String(error)}\n`);
      })
      .finally(() => {
        state.endedAt = this.now();
        state.log.close();
        if (this.byLock.get(spec.lockKey) === id) {
          this.byLock.delete(spec.lockKey);
        }
        this.persist(state);
        settle();
        for (const wake of state.waiters) {
          wake();
        }
        state.waiters.clear();
        this.prune();
        this.options.onDidChange?.();
      });

    return { job: state, attached: false };
  }

  /**
   * A job by id. One no longer in memory, because the extension host
   * restarted or it aged out, is read back from its record.
   */
  get(jobId: string): JobState | PersistedJob {
    const job = this.jobs.get(jobId) ?? this.readPersisted(jobId);
    if (!job) {
      throw new McpToolError('JOB_NOT_FOUND',
        `No job "${jobId}". It may have expired, or the VS Code window may have been reloaded.`, {
          hint: 'Call job with action "status" and no job_id to list recent jobs.',
        });
    }
    return job;
  }

  private readPersisted(jobId: string): PersistedJob | undefined {
    // The id comes from the agent, so it is checked before it names a file.
    if (!this.options.recordPathFor || !isJobId(jobId)) {
      return undefined;
    }
    const view = readJobRecord(this.options.recordPathFor(jobId), jobId);
    return view && {
      persisted: true,
      id: jobId,
      view: { ...view, persisted: true },
      // The log next to the record, never a path the record names.
      log: new JobLog(this.options.logPathFor(jobId)),
    };
  }

  /** Record a finished job, so it can still be answered after a restart. */
  private persist(job: JobState): void {
    const target = this.options.recordPathFor?.(job.id);
    if (!target) {
      return;
    }
    try {
      writeJobRecord(target, this.view(job));
    } catch {
      // A record only helps after a restart. It must never fail the job.
    }
  }

  list(): JobState[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Jobs still working in `dir`, in a folder inside it, or in a folder that
   * contains it. Locks are keyed on exact paths, so deleting <app>/build must
   * look here to find a build running in <app>/build/primary, and the other
   * way round. A cancelled job counts until its process has exited.
   */
  runningOverlapping(dir: string): JobState[] {
    return this.list().filter(job => {
      const folder = job.spec.buildDir;
      return isWorking(job) && !!folder && (isInside(folder, dir) || isInside(dir, folder));
    });
  }

  /**
   * Wait up to `ms` for the job to finish. Resolves early when it does, or
   * when `signal` aborts because the client gave up on the call.
   * A timeout is not a failure: the caller returns the handle instead.
   */
  async wait(job: JobState, ms: number, options: WaitOptions = {}): Promise<void> {
    if (isTerminal(job.status) || ms <= 0 || options.signal?.aborted) {
      return;
    }
    await new Promise<void>(resolve => {
      let pulse: NodeJS.Timeout | undefined;
      const finish = () => {
        clearTimeout(timer);
        if (pulse) {
          clearInterval(pulse);
        }
        job.waiters.delete(finish);
        options.signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      if (options.tick && options.everyMs) {
        // Keeps the agent's own idle timers alive during a long build, and
        // tells the user what the build is doing right now.
        const tick = options.tick;
        pulse = setInterval(() => tick(job), options.everyMs);
      }
      job.waiters.add(finish);
      options.signal?.addEventListener('abort', finish, { once: true });
    });
  }

  /** The last non-empty line of a job's output, for a progress message. */
  lastLine(job: JobState, maxChars = 120): string {
    const lines = job.buffer.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '').trim();
      if (line) {
        return line.length > maxChars ? `${line.slice(0, maxChars)}...` : line;
      }
    }
    return '';
  }

  /**
   * Cancel a job and its process tree. Aborting the MCP request does NOT come
   * here: a dropped connection must never kill a ten-minute build.
   */
  cancel(jobId: string): JobView {
    const job = this.get(jobId);
    if (isPersisted(job)) {
      // Recorded only once finished, so there is nothing left to stop.
      return job.view;
    }
    if (!isTerminal(job.status)) {
      job.status = 'cancelled';
      job.controller.abort();
      this.options.onDidChange?.();
    }
    return this.view(job);
  }

  view(job: JobState, options: {
    attached?: boolean; tailLines?: number;
    /** Overrides the job's own `parse`. */
    parse?: boolean;
    /** Cap on diagnostics. The default keeps a result compact; get_diagnostics asks for all. */
    maxDiagnostics?: number;
  } = {}): JobView {
    const parse = options.parse ?? job.spec.parse ?? (job.spec.kind === 'build' || job.spec.kind === 'task');
    const cache = parse ? cacheDirsOf(job.spec.buildDir) : {};
    const parsed = !parse ? undefined : parseBuildOutput(job.buffer, {
      buildDir: job.spec.buildDir,
      // Before the first configure there is no cache: the application is the source.
      sourceDir: cache.sourceDir ?? job.spec.appPath,
      zephyrBase: cache.zephyrBase,
      maxDiagnostics: options.maxDiagnostics,
    });
    const ended = job.endedAt;
    const view: JobView = {
      job_id: job.id,
      kind: job.spec.kind,
      status: job.status,
      ...(options.attached ? { attached: true } : {}),
      ...(job.exitCode === undefined ? {} : { exit_code: job.exitCode }),
      ...(job.spec.appPath ? { app_path: job.spec.appPath } : {}),
      ...(job.spec.configName ? { config_name: job.spec.configName } : {}),
      ...(job.spec.buildDir ? { build_dir: job.spec.buildDir } : {}),
      command: job.spec.command,
      started_at: new Date(job.startedAt).toISOString(),
      ...(ended ? { ended_at: new Date(ended).toISOString() } : {}),
      duration_ms: (ended ?? this.now()) - job.startedAt,
      ...(parsed && (parsed.diagnostics.length > 0 || parsed.errors > 0)
        ? { diagnostics: { errors: parsed.errors, warnings: parsed.warnings, items: parsed.diagnostics, truncated: parsed.truncated } }
        : {}),
      ...(parsed && parsed.memory.length > 0 ? { memory: parsed.memory } : {}),
      log: { path: job.log.filePath, bytes: job.log.size, tail: job.log.tail(options.tailLines ?? 40) },
      ...(job.result ? { result: job.result } : {}),
      next: isTerminal(job.status)
        ? `Finished. If the tail is not enough, call job {"action": "log", "job_id": "${job.id}"}, optionally with a grep pattern.`
        : `Still running. Call job {"action": "status", "job_id": "${job.id}"} until status is not running.`,
    };
    if (isTerminal(job.status) && job.spec.next) {
      try {
        view.next = job.spec.next(view);
      } catch {
        // A broken hint keeps the generic one rather than failing the call.
      }
    }
    return view;
  }

  /** Terminal jobs beyond the retention limit are forgotten, newest kept. */
  private prune(): void {
    const max = this.options.maxRetained ?? 50;
    const terminal = this.list().filter(j => isTerminal(j.status));
    for (const job of terminal.slice(max)) {
      this.jobs.delete(job.id);
    }
  }

  /**
   * Mark every running job failed, and record it. Used when the window closes
   * or the extension host restarts, which adding a workspace folder can cause.
   */
  failRunning(reason: string): void {
    for (const job of this.jobs.values()) {
      // A cancelled job still stopping is recorded too, and stays cancelled.
      if (isWorking(job)) {
        // Abort first: the runner's abort listener kills the process tree.
        // Build shells are spawned detached, in their own process group, so
        // without this they would outlive the window and keep writing.
        job.controller.abort();
        if (!isTerminal(job.status)) {
          job.status = 'failed';
        }
        job.endedAt = this.now();
        job.log.append(`\n${reason}\n`);
        job.log.close();
        this.persist(job);
      }
    }
    this.byLock.clear();
    this.options.onDidChange?.();
  }
}
