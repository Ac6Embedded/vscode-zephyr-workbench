// Runs an agent job's work in a terminal the user can watch: a workbench task,
// captured so the job gets its output and exit code, or an in-process step
// such as a download, mirrored into a terminal of its own. Neither ever shows
// a notification: a window busy with a dialog must not hang the job.

import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { toTerminalText } from '../core/ansi';
import { agentTaskPresentation, CAPTURED_TASK_MARKER, CaptureSink, toCapturedTask } from './capturedTask';

/** How long VS Code may take to open a terminal before the run stops waiting for it. */
export const OPEN_TIMEOUT_MS = 10_000;

/** Output of a logged step kept for a terminal VS Code has not opened yet. */
const MAX_PENDING_CHARS = 64 * 1024;

export interface TerminalOptions {
  reveal?: vscode.TaskRevealKind;
  /** First line of the terminal, naming the agent and what it runs. */
  header?: string;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Run a resolved ShellExecution task as part of a job. The user watches it in
 * a terminal, the sink gets its output, and the job's signal stops it with its
 * process tree. The exit code is undefined when the run was cancelled.
 * `started` is false when the process never ran, because VS Code refused the
 * task or did not open its terminal in time: such a run touched nothing, so
 * nothing may be recorded about it.
 */
export async function runCapturedTask(
  task: vscode.Task, sink: CaptureSink, signal: AbortSignal, options: TerminalOptions = {},
): Promise<{ exitCode: number | undefined; started: boolean }> {
  if (signal.aborted) {
    return { exitCode: undefined, started: false };
  }
  const captured = toCapturedTask(task, sink, options);
  const onAbort = () => captured.cancel();
  signal.addEventListener('abort', onAbort, { once: true });
  // executeTask resolves only once VS Code starts the task, and a window
  // busy with a modal dialog can hold that indefinitely. The job must still
  // end, so it gives up after a bounded wait.
  const watchdog = setTimeout(() => captured.abandon(
    `VS Code did not start the terminal for "${task.name}" within 10 seconds. Close any open dialog in the VS Code window and try again.`,
  ), OPEN_TIMEOUT_MS);
  void captured.opened.then(() => clearTimeout(watchdog));
  vscode.tasks.executeTask(captured.task).then(undefined, error => captured.abandon(
    `VS Code refused to start "${task.name}": ${messageOf(error)}`,
  ));
  try {
    const exitCode = await captured.completed;
    return { exitCode, started: captured.started() };
  } finally {
    clearTimeout(watchdog);
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Run an in-process step, such as a download or an extraction, in a terminal
 * the user can watch. What `log` receives is shown there and forwarded to the
 * sink. The terminal closes with 0 when `work` resolves and 1 when it throws;
 * the error is shown in the terminal and rethrown for the caller to report.
 * Closing the terminal stops the step, as the job's signal does.
 *
 * The work does not wait for the terminal, since a window busy with a dialog
 * may open it late or never. Output until then is kept, bounded, and replayed
 * when it opens. After OPEN_TIMEOUT_MS without a terminal the job log says so
 * and stops keeping output for it. A terminal opened after the step ended
 * shows how it ended and closes at once, so none is ever left behind.
 */
export async function runLoggedStep<T>(
  name: string,
  sink: CaptureSink,
  signal: AbortSignal,
  work: (log: (text: string) => void, signal: AbortSignal) => Promise<T>,
  options: TerminalOptions & { scope?: vscode.WorkspaceFolder } = {},
): Promise<T> {
  if (signal.aborted) {
    throw new Error(`"${name}" was cancelled before it started.`);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });

  const writeEmitter = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<number>();
  let opened = false;
  let givenUp = false;
  let closed = false;
  let pending = '';
  let truncated = false;
  /** Set once the work has settled. */
  let exitCode: number | undefined;

  const write = (text: string) => writeEmitter.fire(toTerminalText(text));
  const close = (code: number) => {
    if (!closed) {
      closed = true;
      closeEmitter.fire(code);
    }
  };
  const show = (text: string) => {
    if (opened) {
      write(text);
    } else if (!givenUp) {
      pending += text;
      if (pending.length > MAX_PENDING_CHARS) {
        pending = pending.slice(-MAX_PENDING_CHARS);
        truncated = true;
      }
    }
  };
  const log = (text: string) => {
    show(text);
    sink.onData(text);
  };

  const pty: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open: () => {
      opened = true;
      if (options.header) {
        write(`${options.header}\n`);
      }
      write(`${name}\n\n`);
      if (truncated || givenUp) {
        write('(the earlier output is in the job log)\n');
      }
      write(pending);
      pending = '';
      if (exitCode !== undefined) {
        close(exitCode);
      }
    },
    // The terminal's trash icon lands here, so the user can always stop an agent.
    close: () => controller.abort(),
  };

  const task = new vscode.Task(
    // Unique, so VS Code never takes a second step for one already running
    // and asks the user whether to restart it.
    { type: 'zephyr-workbench-shell', label: name, __stepId: randomBytes(4).toString('hex'), [CAPTURED_TASK_MARKER]: true },
    options.scope ?? vscode.TaskScope.Workspace,
    name,
    'Zephyr Workbench',
    new vscode.CustomExecution(async () => pty),
  );
  task.presentationOptions = agentTaskPresentation(options.reveal);

  const watchdog = setTimeout(() => {
    if (!opened) {
      givenUp = true;
      pending = '';
      sink.onData(`\nVS Code did not open a terminal for "${name}" within 10 seconds. The step goes on; its output stays in this log.\n`);
    }
  }, OPEN_TIMEOUT_MS);
  vscode.tasks.executeTask(task).then(undefined, error => {
    sink.onData(`\nVS Code refused to show "${name}" in a terminal: ${messageOf(error)}\n`);
  });

  try {
    const value = await work(log, controller.signal);
    exitCode = 0;
    return value;
  } catch (error) {
    exitCode = 1;
    show(`\n${messageOf(error)}\n`);
    throw error;
  } finally {
    clearTimeout(watchdog);
    signal.removeEventListener('abort', onAbort);
    if (opened) {
      close(exitCode ?? 1);
    }
  }
}
