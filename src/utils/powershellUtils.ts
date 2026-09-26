import { ExecException, exec } from "child_process";
import * as vscode from "vscode";
import { ZEPHYR_DOCS_BASE_URL } from "../constants";

// Run a PowerShell command with Bypass execution policy and no profile
export type PowerShellFlavor = 'powershell' | 'pwsh';
export function runPowershellCommand(
  cmd: string,
  flavor: PowerShellFlavor = 'powershell',
  // 0 means no limit, as before. A read-only probe passes one so a stuck
  // PowerShell cannot hold its caller.
  timeoutMs = 0,
): Promise<{ stdout: string; stderr: string }>
{
  const exe = flavor === 'pwsh' ? 'pwsh' : 'powershell';
  const full = `${exe} -ExecutionPolicy Bypass -NoProfile -NonInteractive -Command ${cmd}`;
  return new Promise((resolve, reject) => {
    exec(full, { timeout: timeoutMs }, (error: ExecException | null, stdout: string, stderr: string) => {
      if (error) { return reject(Object.assign(error, { stdout, stderr })); }
      resolve({ stdout, stderr });
    });
  });
}

export async function getCurrentUserExecutionPolicy(timeoutMs = 0): Promise<string> {
  try {
    const { stdout } = await runPowershellCommand(`\"(Get-ExecutionPolicy -Scope CurrentUser -ErrorAction SilentlyContinue)\"`, 'powershell', timeoutMs);
    const val = (stdout || '').toString().trim();
    return val || 'Undefined';
  } catch {
    return 'Undefined';
  }
}

export function isExecutionPolicyAllowed(policy: string): boolean {
  const p = (policy || '').toLowerCase();
  return p === 'remotesigned' || p === 'unrestricted' || p === 'bypass';
}

/**
 * The silent part of ensurePowershellExecutionPolicy: true when the current
 * user may run scripts, after trying to set their policy to RemoteSigned when
 * not. Shows nothing, so a caller without a UI (an agent job) can report the
 * false case itself. `timeoutMs` bounds each PowerShell call (0: no limit).
 * Always true off Windows.
 */
export async function allowPowershellScriptsForCurrentUser(timeoutMs = 0): Promise<boolean> {
  if (process.platform !== 'win32') { return true; }

  const current = await getCurrentUserExecutionPolicy(timeoutMs);
  if (isExecutionPolicyAllowed(current)) {
    return true;
  }

  // Try to silently set the policy for CurrentUser to RemoteSigned
  try {
    await runPowershellCommand(`\"Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force\"`, 'powershell', timeoutMs);
  } catch {
    // ignore failures here; the re-check below decides
  }

  // Re-check after attempting to set; if allowed now, proceed without warning
  const after = await getCurrentUserExecutionPolicy(timeoutMs);
  return isExecutionPolicyAllowed(after);
}

// Ensure PowerShell execution policy allows running scripts for CurrentUser (Windows only)
export async function ensurePowershellExecutionPolicy(): Promise<boolean> {
  if (process.platform !== 'win32') { return true; }

  const docsUrl = `${ZEPHYR_DOCS_BASE_URL}/known-issues#powershell-script-execution-disabled`;

  if (await allowPowershellScriptsForCurrentUser()) {
    return true;
  }

  const warning = 'PowerShell script execution appears disabled for the current user. The installer may fail unless the policy is RemoteSigned (recommended).';
  const openDocs = 'Open Docs';

  const choice = await vscode.window.showWarningMessage(
    warning,
    { modal: true },
    openDocs
  );

  if (choice === openDocs) {
    try { await vscode.env.openExternal(vscode.Uri.parse(docsUrl)); } catch {}
  }
  return false;
}

/**
 * Quote a filesystem path so it survives being passed to `powershell.exe -Command`.
 *
 * Install commands run through a string ShellExecution as `powershell.exe -Command <cmd>`,
 * where <cmd> is appended verbatim. The outer PowerShell parses its own command line
 * (splitting on whitespace and dropping surrounding double quotes), then rebuilds the
 * -Command text by joining the tokens with single spaces, without re-quoting. Plain
 * double quotes are therefore lost, so a path containing spaces (e.g. a home directory
 * like "C:\\Users\\First Last") gets split and the command fails with
 * "... does not have a 'ps1' extension".
 *
 * Escaped double quotes (\") survive that round-trip as literal quote characters and are
 * honored when the inner command is finally parsed, including after the stop-parsing
 * token `--%`. Use this for any path interpolated into a PowerShell install command.
 */
export function quotePathForPwshCommand(p: string): string {
  return `\\"${p}\\"`;
}
