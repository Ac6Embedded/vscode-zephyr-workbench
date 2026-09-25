import os from "os";
import * as vscode from "vscode";
import { buildEnvSourcedShellCommand, executeTask, getShellExe, logShellCommand } from "./execUtils";
import { collectHostToolsStatus, HostToolsStatus } from "./hostToolsStatusCollector";
import { buildHostToolsOnlyCheckCommand, getHostToolsOnlyCheckInvocation } from "./hostToolsStatusUtils";
import { ensurePowershellExecutionPolicy } from "./powershellUtils";

/*
 * The Verify Host Tools command. The installer's check listing still appears
 * in the "Installing Host tools" task terminal, line by line as it is
 * printed, but the check itself runs through the same collector the Advanced
 * Host Tools panel and the agent environment check read. One run therefore
 * gives the user the listing and gives the Host Tools Manager the versions it
 * refreshes from, and the check is bounded instead of able to hang the task.
 *
 * Its own module because the collector imports installUtils, where this
 * command used to live.
 */

const TASK_NAME = 'Installing Host tools';

/** A terminal needs CRLF: a bare LF moves down a line without going back to its start. */
export function toTerminalText(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

/** What the terminal adds after the listing when the check did not finish on its own. */
export function describeUnfinishedCheck(check: HostToolsStatus['versionCheck']): string | undefined {
  if (!check.ran) {
    return `The host tools check could not start${check.error ? `: ${check.error}` : '.'}`;
  }
  if (check.timedOut) {
    return 'The host tools check did not finish in time and was stopped.';
  }
  return undefined;
}

/**
 * Run the installer's check mode and show its listing in a task terminal.
 * Resolves with the collected status, or undefined when the check did not
 * start (unsupported platform, PowerShell policy refused). Throws, as it
 * always has, when the env script setting is empty or venv.path is invalid,
 * so the command can offer to open that setting.
 */
export async function verifyHostTools(context: vscode.ExtensionContext): Promise<HostToolsStatus | undefined> {
  if (process.platform !== 'linux' && process.platform !== 'win32' && process.platform !== 'darwin') {
    vscode.window.showErrorMessage("Platform not supported !");
    return undefined;
  }
  const invocation = getHostToolsOnlyCheckInvocation(context.extensionUri);
  if (invocation.platform === 'win32') {
    // Before the check: a Restricted policy refuses install.ps1 itself.
    const ok = await ensurePowershellExecutionPolicy();
    if (!ok) { return undefined; }
  }
  // The same refusal the env-sourced task used to raise, so the command keeps
  // offering to open the setting that needs fixing.
  buildEnvSourcedShellCommand('echo', undefined, invocation.platform === 'win32' ? 'powershell.exe' : getShellExe());
  // The workbench output channel keeps its record of the check, as it had
  // when the check ran as a shell task.
  logShellCommand(TASK_NAME, buildHostToolsOnlyCheckCommand(invocation), os.homedir());

  let status: HostToolsStatus | undefined;
  const write = new vscode.EventEmitter<string>();
  const close = new vscode.EventEmitter<number>();
  const stop = new AbortController();
  const pty: vscode.Pseudoterminal = {
    onDidWrite: write.event,
    onDidClose: close.event,
    open: () => {
      void collectHostToolsStatus(context.extensionUri, {
        versionCheck: true,
        signal: stop.signal,
        onCheckOutput: text => write.fire(toTerminalText(text)),
      }).then(result => {
        status = result;
        const unfinished = describeUnfinishedCheck(result.versionCheck);
        if (unfinished) {
          write.fire(toTerminalText(`\n${unfinished}\n`));
        }
        close.fire(result.versionCheck.exitCode ?? 1);
      }, error => {
        write.fire(toTerminalText(`\n${error instanceof Error ? error.message : String(error)}\n`));
        close.fire(1);
      });
    },
    // The user closed the terminal: the check has no one left to report to.
    close: () => stop.abort(),
  };

  const task = new vscode.Task(
    { label: TASK_NAME, type: 'zephyr-workbench-shell' },
    vscode.TaskScope.Workspace,
    TASK_NAME,
    'Zephyr Workbench',
    new vscode.CustomExecution(async () => pty),
  );
  task.presentationOptions.echo = true;
  try {
    await executeTask(task);
  } finally {
    write.dispose();
    close.dispose();
  }
  return status;
}
