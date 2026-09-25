// The serial captures of this window: one helper process per captured port,
// run as a job the user watches in a terminal. The registry is per extension
// host, which is per VS Code window, like the jobs themselves; an entry lives
// exactly as long as its helper, and failRunning (the window closing) aborts
// the job, which stops the helper through the same path as a cancel.

import { ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import type * as vscode from 'vscode';
import { killProcessTree } from '../../../utils/execUtils';
import { LineEnding } from '../../core/serialArgs';
import { PortSource } from '../../core/serialPorts';
import { SerialLineAssembler, statusLine } from '../../core/serialStream';
import { JobRunResult, JobSink } from '../../jobs/jobManager';
import { HelperCommand, HelperEvent, lineSplitter, parseHelperEvent, serialHelper } from './helper';

/** A prompt with no newline reaches the log after this long without more output. */
export const IDLE_FLUSH_MS = 150;
/** How long a stop waits after closing the helper's stdin before SIGTERM, then SIGKILL. */
export const STOP_TERM_MS = 2000;
export const STOP_KILL_MS = 5000;
/** How long a send waits for the helper to say it wrote the text. */
const SEND_ACK_MS = 5000;
/** The helper enforces the duration itself; this is the safety net if it hangs. */
const DURATION_GRACE_MS = 10_000;

export type StopReason = 'agent' | 'terminal' | 'cancelled' | 'duration';

const STOP_TEXT: Record<StopReason, string> = {
  agent: 'stopped by the agent',
  terminal: 'stopped from the terminal',
  cancelled: 'cancelled',
  duration: 'reached its time limit',
};

/** How opening the port went, as early as the helper can tell. */
export type OpenOutcome =
  | { ok: true }
  | { ok: false; code: string; message: string; pid?: number };

export interface CaptureInfo {
  port: string;
  /** The port as compared and locked on, from normalizePort. */
  key: string;
  baud: number;
  portSource: PortSource;
  baudSource: 'argument' | 'devicetree' | 'default';
  /** The devicetree node of the console, when the speed came from it. */
  consoleNode?: string;
  /** Raise DTR once the port is open (wantsDtr), for a board's own USB console. */
  raiseDtr?: boolean;
  durationSec: number;
  appPath?: string;
  configName?: string;
  board?: string;
}

export class SerialCapture {
  jobId?: string;
  state: 'starting' | 'open' | 'disconnected' | 'closed' = 'starting';
  disconnects = 0;
  deviceBytes = 0;
  /** Resolves once the port opened, or with why it did not. */
  readonly opened: Promise<OpenOutcome>;
  /** Resolves when the helper has loaded pyserial, so opening is all that is left. */
  readonly ready: Promise<void>;
  /** Resolves when the helper has exited and the capture's last line is logged. */
  readonly done: Promise<void>;

  private child: ChildProcess | undefined;
  private stopReason: StopReason | undefined;
  private stopping = false;
  private readonly listeners = new Set<() => void>();
  private readonly acks = new Map<number, (event: HelperEvent) => void>();
  private nextId = 1;
  private settleOpened: (outcome: OpenOutcome) => void = () => undefined;
  private settleReady: () => void = () => undefined;
  private settleDone: () => void = () => undefined;
  /** Set while the helper runs: writes a status line to the log and the terminal. */
  private writeStatus: ((message: string) => void) | undefined;
  private logSize: () => number = () => 0;

  constructor(readonly info: CaptureInfo) {
    this.opened = new Promise(resolve => { this.settleOpened = resolve; });
    this.ready = new Promise(resolve => { this.settleReady = resolve; });
    this.done = new Promise(resolve => { this.settleDone = resolve; });
  }

  get ended(): boolean {
    return this.state === 'closed';
  }

  /** Called with the job once it exists, so offsets can be read from its log. */
  attachJob(jobId: string, logSize: () => number): void {
    this.jobId = jobId;
    this.logSize = logSize;
  }

  /** Called whenever the log grows or the capture changes state. */
  onChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  /**
   * The job's work: run the helper in a terminal the user can watch and stop,
   * until the duration ends, the agent stops it, or the job is cancelled.
   */
  async execute(helper: HelperCommand, sink: JobSink, signal: AbortSignal, terminal: {
    reveal?: vscode.TaskRevealKind; header?: string; scope?: vscode.WorkspaceFolder;
  }): Promise<JobRunResult> {
    const { port, baud } = this.info;
    try {
      return await serialHelper.runStep(`Serial ${port} at ${baud} baud`, sink, signal, (_log, stepSignal, channels) =>
        this.runHelper(helper, stepSignal, signal, channels), {
        ...terminal,
        // The runner's notices about its terminal are messages of the capture,
        // never device output a wait_for or grep could match.
        note: message => (this.writeStatus ? this.writeStatus(message) : sink.onData(`${statusLine(message)}\n`)),
      });
    } catch (error) {
      // Cancelled before the step started: the helper never ran.
      this.state = 'closed';
      this.settleOpened({ ok: false, code: 'not_started', message: error instanceof Error ? error.message : String(error) });
      this.settleReady();
      this.settleDone();
      this.notify();
      throw error;
    }
  }

  private runHelper(
    helper: HelperCommand, stepSignal: AbortSignal, jobSignal: AbortSignal,
    channels: { terminal(text: string): void; record(text: string): void },
  ): Promise<JobRunResult> {
    const { port, baud, durationSec } = this.info;
    const assembler = new SerialLineAssembler();
    const decoder = new StringDecoder('utf8');
    let terminalAtLineStart = true;
    let idle: NodeJS.Timeout | undefined;
    let openError: { code: string; message: string } | undefined;
    let closeReason: string | undefined;
    const stderrTail: string[] = [];

    const record = (text: string) => {
      if (text) {
        channels.record(text);
        this.notify();
      }
    };
    const show = (text: string) => {
      if (text) {
        channels.terminal(text);
        terminalAtLineStart = text.endsWith('\n');
      }
    };
    const status = (message: string) => {
      clearTimeout(idle);
      record(assembler.status(message));
      show(`${terminalAtLineStart ? '' : '\n'}${statusLine(message)}\n`);
    };
    this.writeStatus = status;

    const flushLater = () => {
      clearTimeout(idle);
      if (assembler.hasPending) {
        idle = setTimeout(() => record(assembler.flushPartial()), IDLE_FLUSH_MS);
      }
    };
    const onDevice = (chunk: Buffer) => {
      this.deviceBytes += chunk.length;
      const text = decoder.write(chunk);
      if (text) {
        show(text);
        record(assembler.push(text));
        flushLater();
      }
    };

    const child = serialHelper.spawn(helper.command, [
      ...helper.args, '--port', port, '--baud', String(baud), '--duration', String(durationSec),
      ...(this.info.raiseDtr ? ['--dtr'] : []),
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;

    const onEvent = (event: HelperEvent) => {
      switch (event.event) {
        case 'ready':
          this.settleReady();
          break;
        case 'opened':
          this.state = 'open';
          status(`${port} opened at ${baud} baud${this.info.raiseDtr ? ' with DTR raised, as the board\'s own USB console waits for it' : ''}; `
            + `the capture stops by itself after ${durationSec} s`);
          this.settleOpened({ ok: true });
          break;
        case 'error':
          openError = { code: event.code ?? 'open_failed', message: event.message ?? 'unknown error' };
          status(event.code === 'pyserial_missing'
            ? 'pyserial is not installed in the Python environment of the helper'
            : `could not open ${port}: ${event.message ?? event.code}`);
          this.settleReady();
          this.settleOpened({ ok: false, ...openError, ...(child.pid ? { pid: child.pid } : {}) });
          break;
        case 'disconnected':
          this.state = 'disconnected';
          this.disconnects++;
          status('the device disconnected; the capture reopens it when it comes back');
          break;
        case 'reopened':
          this.state = 'open';
          status(`${port} reopened`);
          break;
        case 'sent':
        case 'send_failed': {
          const ack = typeof event.id === 'number' ? this.acks.get(event.id) : undefined;
          ack?.(event);
          if (event.event === 'send_failed') {
            status(`sending failed: ${event.message ?? 'unknown error'}`);
          }
          break;
        }
        case 'closed':
          closeReason = event.reason;
          break;
        default:
          break;
      }
      this.notify();
    };
    const stderr = lineSplitter(line => {
      const event = parseHelperEvent(line);
      if (event) {
        onEvent(event);
      } else if (line.trim()) {
        // A Python traceback: kept to explain an unexpected exit.
        stderrTail.push(line.trim());
        stderrTail.splice(0, Math.max(0, stderrTail.length - 5));
      }
    });
    child.stdout?.on('data', onDevice);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => stderr.push(chunk));
    // A write to a helper that already exited must not throw in the host.
    child.stdin?.on('error', () => undefined);

    const onStepAbort = () => void this.stop(jobSignal.aborted ? 'cancelled' : 'terminal');
    stepSignal.addEventListener('abort', onStepAbort, { once: true });
    const safety = setTimeout(() => void this.stop('duration'), durationSec * 1000 + DURATION_GRACE_MS);

    return new Promise<JobRunResult>(resolve => {
      let finished = false;
      const finish = (code: number | null, spawnError?: Error) => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(safety);
        clearTimeout(idle);
        stepSignal.removeEventListener('abort', onStepAbort);
        stderr.end();
        const rest = decoder.end();
        if (rest) {
          show(rest);
          record(assembler.push(rest));
        }
        record(assembler.flushPartial());
        for (const ack of this.acks.values()) {
          ack({ event: 'send_failed', message: 'the capture ended' });
        }
        this.acks.clear();

        const reason: StopReason | undefined = this.stopReason ?? (closeReason === 'duration' ? 'duration' : undefined);
        const failed = !reason && (spawnError !== undefined || openError !== undefined || code !== 0);
        if (spawnError) {
          status(`the serial helper could not start: ${spawnError.message}`);
        } else if (failed && !openError) {
          status(`the serial helper stopped unexpectedly (exit code ${code ?? 'none'})${stderrTail.length ? `: ${stderrTail[stderrTail.length - 1]}` : ''}`);
        }
        if (!openError) {
          status(`closed, ${reason ? STOP_TEXT[reason] : failed ? 'after an error' : 'the helper ended'}`);
        }
        // A no-op when the port opened: only the first outcome counts.
        this.settleOpened({
          ok: false,
          code: openError?.code ?? (failed ? 'exited' : 'stopped'),
          message: openError?.message ?? spawnError?.message
            ?? (failed ? (stderrTail.join(' ') || `exit code ${code}`) : 'the capture was stopped before the port opened'),
        });
        this.settleReady();
        this.state = 'closed';
        this.writeStatus = undefined;
        this.child = undefined;
        resolve({
          exitCode: failed ? (code || 1) : 0,
          extra: {
            port,
            baud_rate: baud,
            port_source: this.info.portSource,
            baud_source: this.info.baudSource,
            ...(this.info.appPath ? { app_path: this.info.appPath } : {}),
            ...(this.info.configName ? { config_name: this.info.configName } : {}),
            device_bytes: this.deviceBytes,
            disconnects: this.disconnects,
            ...(reason ? { stopped_by: reason } : {}),
            ...(openError ? { error: openError } : {}),
          },
        });
        this.settleDone();
        this.notify();
      };
      child.on('error', error => finish(null, error));
      child.on('close', code => finish(code));
    });
  }

  /**
   * Write a line to the device. The log gets a status line first, so the
   * offset returned, where the device's answer starts, comes after it and
   * after the part of a line (a prompt) received before the send.
   */
  send(text: string, lineEnding: LineEnding): { offset: number; ack: Promise<HelperEvent> } {
    const child = this.child;
    if (!child?.stdin || this.state === 'closed') {
      return { offset: this.logSize(), ack: Promise.resolve({ event: 'send_failed', message: 'the capture has ended' }) };
    }
    this.writeStatus?.(`sent ${JSON.stringify(text)}${lineEnding === 'none' ? '' : ` + ${lineEnding}`}`);
    const offset = this.logSize();
    const id = this.nextId++;
    const ack = new Promise<HelperEvent>(resolve => {
      const timer = setTimeout(() => {
        this.acks.delete(id);
        resolve({ event: 'send_failed', message: `the helper did not confirm the write within ${SEND_ACK_MS / 1000} seconds` });
      }, SEND_ACK_MS);
      this.acks.set(id, event => {
        clearTimeout(timer);
        this.acks.delete(id);
        resolve(event);
      });
    });
    child.stdin.write(`${JSON.stringify({ id, send: text, line_ending: lineEnding })}\n`);
    return { offset, ack };
  }

  /**
   * Stop the capture: close the helper's stdin, which it takes as the signal
   * to close the port and exit, then SIGTERM after 2 seconds and SIGKILL after
   * 5 if it has not. Resolves once the capture has ended.
   */
  stop(reason: StopReason): Promise<void> {
    this.stopReason ??= reason;
    const child = this.child;
    if (!child || this.stopping) {
      return this.done;
    }
    this.stopping = true;
    try {
      child.stdin?.end();
    } catch {
      // Already closed: the timers below still end it.
    }
    // Through the process tree on Windows, where the venv's python.exe is a
    // launcher in front of the interpreter that holds the port.
    const term = setTimeout(() => killProcessTree(child, 'SIGTERM'), STOP_TERM_MS);
    const kill = setTimeout(() => killProcessTree(child, 'SIGKILL'), STOP_KILL_MS);
    void this.done.then(() => {
      clearTimeout(term);
      clearTimeout(kill);
    });
    return this.done;
  }
}

/** The running captures of this window. */
export class SerialCaptures {
  private readonly entries = new Set<SerialCapture>();

  add(capture: SerialCapture): void {
    if (!capture.ended) {
      this.entries.add(capture);
    }
  }

  delete(capture: SerialCapture): void {
    this.entries.delete(capture);
  }

  byJob(jobId: string): SerialCapture | undefined {
    return [...this.entries].find(capture => capture.jobId === jobId);
  }

  /** The capture holding a port, by its normalized name. */
  byPort(key: string): SerialCapture | undefined {
    return [...this.entries].find(capture => capture.info.key === key && !capture.ended);
  }

  list(): SerialCapture[] {
    return [...this.entries];
  }
}

export const serialCaptures = new SerialCaptures();

/** What get_status adds to a running serial job: the port and the speed it captures. */
export function captureFields(jobId: string): { port?: string; baud_rate?: number } {
  const capture = serialCaptures.byJob(jobId);
  return capture ? { port: capture.info.port, baud_rate: capture.info.baud } : {};
}
