// Owns one kconfig_server.py child process and speaks its NDJSON JSON-RPC protocol.
// Deliberately free of any `vscode` dependency (child_process only) so it can be
// smoke-tested directly; the panel supplies logging/lifecycle callbacks.

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import type { KconfigLaunchSpec } from './kconfigEnvExtractor';
import type { KcResponseMeta } from './kconfigRpcTypes';

export type KconfigServerState = 'idle' | 'starting' | 'ready' | 'crashed' | 'disposed';

export class KconfigServerError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'KconfigServerError';
    this.code = code;
  }
}

export interface KconfigServerOptions {
  spec: KconfigLaunchSpec;
  serverScriptPath: string;
  /** Diagnostics + child stderr, one line at a time. */
  log?: (line: string) => void;
  onWarnings?: (warnings: string[]) => void;
  onDirty?: (dirty: boolean) => void;
  /** Fired when the process exits. `expected` is true when we asked it to stop. */
  onExit?: (code: number | null, expected: boolean) => void;
  initTimeoutMs?: number;
  callTimeoutMs?: number;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timer?: NodeJS.Timeout;
  method: string;
}

const STDERR_RING = 60;

export class KconfigServerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuf = '';
  private readonly pending = new Map<string, Pending>();
  private idCounter = 0;
  private _state: KconfigServerState = 'idle';
  private readyResolve: (() => void) | undefined;
  private readyReject: ((e: any) => void) | undefined;
  private disposing = false;
  private readonly stderrRing: string[] = [];
  private handlers: Pick<KconfigServerOptions, 'log' | 'onWarnings' | 'onDirty' | 'onExit'>;

  constructor(private readonly opts: KconfigServerOptions) {
    this.handlers = { log: opts.log, onWarnings: opts.onWarnings, onDirty: opts.onDirty, onExit: opts.onExit };
  }

  get state(): KconfigServerState { return this._state; }
  get recentStderr(): string[] { return [...this.stderrRing]; }

  /**
   * Rebind the event callbacks to a new owner. Used when a panel is closed with unsaved
   * changes and the user cancels: the reopened panel adopts this still-running client.
   */
  setHandlers(handlers: Pick<KconfigServerOptions, 'log' | 'onWarnings' | 'onDirty' | 'onExit'>): void {
    this.handlers = handlers;
  }

  /** Spawn the process and resolve once it emits its `ready` event (or reject on failure). */
  start(): Promise<void> {
    if (this._state !== 'idle') {
      return Promise.reject(new KconfigServerError(`Cannot start in state '${this._state}'`));
    }
    this._state = 'starting';
    const { spec, serverScriptPath } = this.opts;

    const args = ['-u', serverScriptPath, '--zephyr-base', spec.zephyrBase, '--kconfig-root', spec.kconfigRoot];
    const env = {
      ...process.env,
      ...spec.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONDONTWRITEBYTECODE: '1',
      KCONFIG_SERVER_ENV_SOURCE: spec.source,
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(spec.python, args, { cwd: spec.cwd, env, windowsHide: true });
    } catch (e) {
      this._state = 'crashed';
      return Promise.reject(new KconfigServerError(`Failed to spawn Python: ${String(e)}`, 'spawn-failed'));
    }
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.onStderr(chunk));

    child.on('error', (err) => {
      this.log(`process error: ${String(err)}`);
      this.fail(new KconfigServerError(`Server process error: ${String(err)}`, 'proc-error'));
    });
    child.on('exit', (code) => this.onExit(code));

    const initTimeout = this.opts.initTimeoutMs ?? 120000;
    return new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      const timer = setTimeout(() => {
        if (this._state === 'starting') {
          this.fail(new KconfigServerError('Timed out waiting for the Kconfig server to start', 'init-timeout'));
        }
      }, initTimeout);
      // Clear the start timer as soon as we settle.
      const origResolve = this.readyResolve;
      const origReject = this.readyReject;
      this.readyResolve = () => { clearTimeout(timer); origResolve!(); };
      this.readyReject = (e) => { clearTimeout(timer); origReject!(e); };
    });
  }

  /** Send a request and await its result. Rejects (KconfigServerError) on server error. */
  call<T = any>(method: string, params?: any, timeoutMs?: number): Promise<T> {
    if (this._state !== 'ready') {
      return Promise.reject(new KconfigServerError(`Server not ready (state '${this._state}')`, 'not-ready'));
    }
    const id = String(++this.idCounter);
    const budget = timeoutMs ?? this.opts.callTimeoutMs ?? 15000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // The server is strictly sequential, so a timeout usually means an earlier
        // request is still running; name the queue to make that diagnosable.
        const queued = [...this.pending.values()].map((p) => p.method).join(', ');
        this.log(`RPC '${method}' timed out after ${budget}ms${queued ? `; still queued: ${queued}` : ''}`);
        reject(new KconfigServerError(`RPC '${method}' timed out after ${budget}ms`, 'timeout'));
      }, budget);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.child!.stdin.write(JSON.stringify({ id, method, params: params ?? {} }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new KconfigServerError(`Failed to write request: ${String(e)}`, 'write-failed'));
      }
    });
  }

  async dispose(): Promise<void> {
    if (this.disposing || this._state === 'disposed') { return; }
    this.disposing = true;
    const child = this.child;
    if (!child) { this._state = 'disposed'; return; }
    // Ask nicely, then escalate.
    try { child.stdin.write(JSON.stringify({ id: '__bye', method: 'shutdown', params: {} }) + '\n'); } catch { /* ignore */ }
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(kill); resolve(); });
    });
    this._state = 'disposed';
    this.rejectAllPending(new KconfigServerError('Server disposed', 'disposed'));
  }

  // -- internals ------------------------------------------------------------

  private onStdout(chunk: string) {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line.trim()) { this.handleLine(line); }
    }
  }

  private handleLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log(`unparseable stdout line: ${line.slice(0, 200)}`);
      return;
    }

    // Lifecycle events (no id).
    if (msg.event === 'ready') {
      this._state = 'ready';
      this.readyResolve?.();
      this.readyResolve = this.readyReject = undefined;
      return;
    }
    if (msg.event === 'fatal') {
      const err = new KconfigServerError(msg.error?.message ?? 'Server fatal error', msg.error?.code ?? 'fatal');
      this.fail(err);
      return;
    }

    // Warnings/dirty piggyback on every response envelope.
    const meta = msg as Partial<KcResponseMeta>;
    // A throwing handler (for example one still bound to a disposed panel) must never
    // prevent the pending request from resolving, or callers see spurious timeouts.
    if (Array.isArray(meta.warnings) && meta.warnings.length && this.handlers.onWarnings) {
      try { this.handlers.onWarnings(meta.warnings); } catch { /* never block resolution */ }
    }
    if (typeof meta.dirty === 'boolean' && this.handlers.onDirty) {
      try { this.handlers.onDirty(meta.dirty); } catch { /* never block resolution */ }
    }

    if (msg.id === undefined || msg.id === null) { return; }
    const p = this.pending.get(String(msg.id));
    if (!p) { return; }
    this.pending.delete(String(msg.id));
    if (p.timer) { clearTimeout(p.timer); }
    if (msg.error) {
      p.reject(new KconfigServerError(msg.error.message ?? 'Server error', msg.error.code));
    } else {
      p.resolve(msg.result);
    }
  }

  private onStderr(chunk: string) {
    for (const line of chunk.split('\n')) {
      if (!line) { continue; }
      this.stderrRing.push(line);
      if (this.stderrRing.length > STDERR_RING) { this.stderrRing.shift(); }
      this.log(`[py] ${line}`);
    }
  }

  private onExit(code: number | null) {
    const expected = this.disposing;
    if (this._state !== 'disposed') {
      this._state = expected ? 'disposed' : 'crashed';
    }
    if (!expected) {
      this.rejectAllPending(new KconfigServerError(`Server exited unexpectedly (code ${code})`, 'crashed'));
      // If it died before becoming ready, settle start().
      if (this.readyReject) {
        this.readyReject(new KconfigServerError(`Server exited during startup (code ${code})`, 'startup-crash'));
        this.readyResolve = this.readyReject = undefined;
      }
    }
    this.handlers.onExit?.(code, expected);
  }

  private fail(err: KconfigServerError) {
    if (this._state !== 'disposed') { this._state = 'crashed'; }
    this.rejectAllPending(err);
    if (this.readyReject) {
      this.readyReject(err);
      this.readyResolve = this.readyReject = undefined;
    }
    try { this.child?.kill('SIGKILL'); } catch { /* ignore */ }
  }

  private rejectAllPending(err: KconfigServerError) {
    for (const [id, p] of this.pending) {
      if (p.timer) { clearTimeout(p.timer); }
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private log(line: string) {
    this.handlers.log?.(line);
  }
}
