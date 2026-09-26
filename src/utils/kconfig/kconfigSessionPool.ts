// Keeps kconfig_server.py sessions warm for callers without a UI, such as the MCP
// server, one per build image directory.
//
// A session costs a full Kconfig parse to start (about a second) and around 110 MB
// while it lives, and it serves one request at a time. So the pool is small and
// least-recently-used, idle sessions stop on their own, every use of a session holds
// its lock, and a session whose build inputs changed is reloaded or restarted before
// it answers. It never shares a session with the Kconfig Manager panel, whose edit
// journal and webview would fall out of step with requests it did not send.
//
// Free of any `vscode` dependency so it is unit tested with an injected starter.

import * as fs from 'fs';
import * as path from 'path';
import type { KconfigLaunchSpec } from './kconfigEnvExtractor';
import { KconfigServerError } from './kconfigServerClient';
import { startKconfigServer, type StartKconfigServerOptions } from './kconfigSession';

/** The part of KconfigServerClient the pool and its callers use. */
export interface PoolClient {
  readonly state: string;
  readonly recentStderr: string[];
  call<T = any>(method: string, params?: any, timeoutMs?: number): Promise<T>;
  dispose(): Promise<void>;
}

export interface PooledSession {
  client: PoolClient;
  spec: KconfigLaunchSpec;
  /** True when this use had to start the server and parse the Kconfig tree. */
  cold: boolean;
}

export interface KconfigSessionPoolOptions {
  serverScriptPath: string;
  /** Live sessions kept at once. Defaults to 2. */
  maxSessions?: number;
  /** A session unused for this long is stopped. Defaults to 10 minutes. */
  idleMs?: number;
  /** Lifecycle lines only (start, reload, stop), never the server's own output. */
  log?: (line: string) => void;
  now?: () => number;
  /** Replaced in tests. */
  start?: (o: StartKconfigServerOptions) => Promise<{ client: PoolClient; spec: KconfigLaunchSpec }>;
}

interface Fingerprint {
  /** build.ninja, edt.pickle and the Kconfig source list: a change needs a new parse. */
  inputs: string;
  /** The merged .config: a change only needs a reload. */
  config: string;
}

interface Entry {
  key: string;
  dir: string;
  session?: { client: PoolClient; spec: KconfigLaunchSpec };
  fp?: Fingerprint;
  lock: Promise<void>;
  users: number;
  /** Order of the last use, for least-recently-used eviction; a counter, so two uses in one millisecond still rank. */
  lastUsed: number;
  idleTimer?: NodeJS.Timeout;
  /** When the session was found crashed and restarted, for the restart budget. */
  crashRestarts: number[];
  /**
   * Set when the crash budget refused a restart: until then every use is refused. The
   * refusal stops the crashed session, so without this the next use would find no
   * session at all and start one straight away.
   */
  blockedUntil?: number;
  generation: number;
}

const DEFAULT_MAX = 2;
const DEFAULT_IDLE_MS = 10 * 60_000;
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASH_RESTARTS = 3;

function statKey(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

/** The files whose change makes a loaded session stale, as the build sees them. */
export function sessionFingerprint(dir: string): Fingerprint {
  return {
    inputs: [
      statKey(path.join(dir, 'build.ninja')),
      statKey(path.join(dir, 'zephyr', 'edt.pickle')),
      statKey(path.join(dir, 'zephyr', 'kconfig', 'sources.txt')),
    ].join('|'),
    config: statKey(path.join(dir, 'zephyr', '.config')),
  };
}

function normalizeKey(dir: string): string {
  const resolved = path.resolve(dir);
  return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

/** Whether the normalized key `key` is the folder `folderKey` or lies inside it. */
function isWithin(key: string, folderKey: string): boolean {
  return key === folderKey || key.startsWith(folderKey.endsWith(path.sep) ? folderKey : folderKey + path.sep);
}

export class KconfigSessionPool {
  private readonly entries = new Map<string, Entry>();
  private readonly max: number;
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly start: NonNullable<KconfigSessionPoolOptions['start']>;
  /** Bumped by closeAll, so a use that was running then stops its session when done. */
  private generation = 0;
  private uses = 0;
  /** Folders being deleted (normalized keys): no session may run inside them meanwhile. */
  private readonly closedFolders: string[] = [];
  /** Sessions being stopped, so a caller about to delete their folder can wait for the exit. */
  private readonly stopping = new Map<Promise<void>, string>();

  constructor(private readonly options: KconfigSessionPoolOptions) {
    this.max = Math.max(1, options.maxSessions ?? DEFAULT_MAX);
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.now = options.now ?? Date.now;
    this.start = options.start ?? startKconfigServer;
  }

  /** How many sessions are running, for tests and diagnostics. */
  get size(): number {
    return [...this.entries.values()].filter(entry => entry.session).length;
  }

  /**
   * Run `fn` with the session of one build image directory, holding its lock for the
   * whole of `fn`. `onStart` is called before a session has to be started, which is
   * the slow case worth telling the caller about.
   */
  async use<T>(
    dir: string,
    options: { venvPath?: string; onStart?: () => void },
    fn: (session: PooledSession) => Promise<T>,
  ): Promise<T> {
    const key = normalizeKey(dir);
    this.assertOpen(key, dir);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key, dir, lock: Promise.resolve(), users: 0, lastUsed: ++this.uses, crashRestarts: [], generation: this.generation,
      };
      this.entries.set(key, entry);
    }
    entry.users++;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    const release = await this.acquire(entry);
    try {
      const cold = await this.ensureFresh(entry, options);
      const session = entry.session as { client: PoolClient; spec: KconfigLaunchSpec };
      return await fn({ client: session.client, spec: session.spec, cold });
    } finally {
      release();
      entry.users--;
      entry.lastUsed = ++this.uses;
      if (entry.generation !== this.generation) {
        // The pool was closed while this use ran: nothing may keep the session alive.
        await this.stopSession(entry, 'the pool was closed');
      } else if (this.isClosed(entry.key)) {
        // Its folder is being deleted: closeWithin is waiting for this use to end.
        await this.stopSession(entry, 'its build folder is being deleted');
      } else {
        this.scheduleIdle(entry);
        await this.trim();
      }
    }
  }

  /** Stop every session. The pool stays usable: the next use starts a fresh one. */
  async closeAll(): Promise<void> {
    this.generation++;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map(entry => {
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = undefined;
      }
      return entry.users === 0 ? this.stopSession(entry, 'the MCP server stopped') : Promise.resolve();
    }));
  }

  /** Build image directories under `folder` whose session is serving a call right now. */
  inUseWithin(folder: string): string[] {
    const folderKey = normalizeKey(folder);
    return [...this.entries.values()]
      .filter(entry => entry.users > 0 && isWithin(entry.key, folderKey))
      .map(entry => entry.dir);
  }

  /**
   * Stop every session inside `folder`, and refuse to start one there until the returned
   * function is called. A server runs with its working directory in the build folder
   * (the `cd` of build.ninja's menuconfig rule), and Windows cannot delete a folder a
   * process is running in, so a caller deleting build output calls this first. A use
   * that is running is waited for, and resolves only once every server has exited.
   */
  async closeWithin(folder: string): Promise<() => void> {
    const folderKey = normalizeKey(folder);
    this.closedFolders.push(folderKey);
    let reopened = false;
    const reopen = () => {
      if (!reopened) {
        reopened = true;
        this.closedFolders.splice(this.closedFolders.indexOf(folderKey), 1);
      }
    };
    try {
      const inside = [...this.entries.values()].filter(entry => isWithin(entry.key, folderKey));
      await Promise.all(inside.map(async entry => {
        // Every use already let in is on this chain; new ones are refused by the fence.
        await entry.lock;
        if (entry.idleTimer) {
          clearTimeout(entry.idleTimer);
          entry.idleTimer = undefined;
        }
        if (this.entries.get(entry.key) === entry) {
          this.entries.delete(entry.key);
        }
        await this.stopSession(entry, 'its build folder is being deleted');
      }));
      // Sessions an idle timer or the size limit was already stopping.
      await Promise.all([...this.stopping].filter(([, key]) => isWithin(key, folderKey)).map(([done]) => done));
    } catch (error) {
      reopen();
      throw error;
    }
    return reopen;
  }

  private isClosed(key: string): boolean {
    return this.closedFolders.some(folderKey => isWithin(key, folderKey));
  }

  private assertOpen(key: string, dir: string): void {
    if (this.isClosed(key)) {
      throw new KconfigServerError(`The build folder of ${dir} is being deleted, so its Kconfig tree cannot be loaded now.`, 'closing');
    }
  }

  private acquire(entry: Entry): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const previous = entry.lock;
    entry.lock = previous.then(() => held);
    return previous.then(() => release);
  }

  /** Make the entry's session current; returns true when it had to be started. */
  private async ensureFresh(entry: Entry, options: { venvPath?: string; onStart?: () => void }): Promise<boolean> {
    if (entry.blockedUntil !== undefined) {
      if (this.now() < entry.blockedUntil) {
        throw this.crashLoopError(entry);
      }
      entry.blockedUntil = undefined;
    }
    const fp = sessionFingerprint(entry.dir);
    const session = entry.session;
    if (session && session.client.state === 'ready' && entry.fp && entry.fp.inputs === fp.inputs) {
      if (entry.fp.config === fp.config) {
        return false;
      }
      // Only the merged .config changed (a build ran): reloading it is far cheaper
      // than parsing the Kconfig tree again.
      try {
        await session.client.call('load_config', { path: session.spec.configPath, replace: true });
        entry.fp = fp;
        this.options.log?.(`Kconfig session reloaded ${session.spec.configPath}.`);
        return false;
      } catch {
        await this.stopSession(entry, 'reloading .config failed');
      }
    } else if (session) {
      const crashed = session.client.state !== 'ready';
      await this.stopSession(entry, crashed ? 'the server had stopped' : 'the build was reconfigured');
      if (crashed) {
        const now = this.now();
        entry.crashRestarts = entry.crashRestarts.filter(at => now - at < CRASH_WINDOW_MS);
        if (entry.crashRestarts.length >= MAX_CRASH_RESTARTS) {
          // Blocked until the oldest crash leaves the window, when a restart is allowed again.
          entry.blockedUntil = entry.crashRestarts[0] + CRASH_WINDOW_MS;
          throw this.crashLoopError(entry);
        }
        entry.crashRestarts.push(now);
      }
    }

    // A use let in before its folder was closed must not start a server there.
    this.assertOpen(entry.key, entry.dir);
    // Room first: each session holds a full Kconfig tree in memory.
    await this.trim(entry);
    options.onStart?.();
    const started = this.now();
    let created: PoolClient | undefined;
    try {
      entry.session = await this.start({
        buildDir: entry.dir,
        venvPath: options.venvPath,
        serverScriptPath: this.options.serverScriptPath,
        onCreated: client => { created = client; },
      });
    } catch (error) {
      // The server's own last words are the only clue to a crash during startup, and
      // the client that heard them is about to go.
      const stderrTail = created?.recentStderr ?? [];
      await created?.dispose().catch(() => undefined);
      throw error instanceof Error && stderrTail.length ? Object.assign(error, { stderrTail }) : error;
    }
    // The fingerprint from before the start: a build that rewrote .config while the tree
    // was loading then shows up as a change on the next use, rather than being missed.
    entry.fp = fp;
    this.options.log?.(`Kconfig session started for ${entry.dir} in ${this.now() - started} ms.`);
    return true;
  }

  private crashLoopError(entry: Entry): KconfigServerError {
    return new KconfigServerError(
      `The Kconfig server for ${entry.dir} stopped ${MAX_CRASH_RESTARTS} times within a minute, so it is not restarted again for now.`,
      'crash-loop',
    );
  }

  private scheduleIdle(entry: Entry): void {
    if (entry.users > 0 || !entry.session) {
      return;
    }
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (entry.users === 0 && this.entries.get(entry.key) === entry) {
        this.entries.delete(entry.key);
        void this.stopSession(entry, 'it was idle');
      }
    }, this.idleMs);
    // An idle session must never keep the extension host (or a test run) alive.
    entry.idleTimer.unref?.();
  }

  /** Stop the least recently used idle sessions beyond the limit, leaving room for `incoming`. */
  private async trim(incoming?: Entry): Promise<void> {
    const live = [...this.entries.values()].filter(entry => entry.session && entry !== incoming);
    let excess = live.length - (incoming ? this.max - 1 : this.max);
    if (excess <= 0) {
      return;
    }
    const idle = live.filter(entry => entry.users === 0).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of idle) {
      if (excess <= 0) {
        break;
      }
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = undefined;
      }
      this.entries.delete(entry.key);
      await this.stopSession(entry, 'the pool is full');
      excess--;
    }
  }

  private async stopSession(entry: Entry, reason: string): Promise<void> {
    const session = entry.session;
    entry.session = undefined;
    entry.fp = undefined;
    if (session) {
      this.options.log?.(`Kconfig session for ${entry.dir} stopped: ${reason}.`);
      const done = session.client.dispose().catch(() => undefined);
      this.stopping.set(done, entry.key);
      try {
        await done;
      } finally {
        this.stopping.delete(done);
      }
    }
  }
}
