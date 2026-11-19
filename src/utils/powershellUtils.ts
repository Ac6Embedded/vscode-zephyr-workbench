import { ExecException, exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ZEPHYR_DOCS_BASE_URL } from "../constants";

/**
 * True for a PSModulePath folder that belongs to PowerShell 7: the Modules
 * folder of a PowerShell 7 install, wherever it is (a pwsh.dll sits next to
 * it), or one of its folders for installed modules, which end in
 * \PowerShell\Modules (in Documents and in Program Files).
 */
export function isPowerShell7ModuleFolder(folder: string): boolean {
  const f = folder.trim();
  return f.length > 0
    && (/[\\/]PowerShell[\\/]Modules[\\/]?$/i.test(f) || fs.existsSync(path.join(path.dirname(f), 'pwsh.dll')));
}

/**
 * The PSModulePath to give a Windows PowerShell the extension starts, or
 * undefined when `value` can be passed on as it is: off Windows, or when it
 * holds no PowerShell 7 folder, which is the case unless VS Code was started
 * from PowerShell 7.
 *
 * VS Code started from a PowerShell 7 session inherits PowerShell 7's module
 * folders at the front of PSModulePath. Windows PowerShell then finds
 * PowerShell 7's copies of its own modules first, cannot load them, and loses
 * commands such as Get-ExecutionPolicy and Get-FileHash. PowerShell 7 drops
 * these folders itself for a Windows PowerShell it starts directly (see
 * about_PSModulePath), but not when another program sits in between. This
 * drops them the same way and keeps every other folder, in order.
 */
export function windowsPowerShellModulePath(
  value: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32' || !value) {
    return undefined;
  }
  const folders = value.split(';');
  const kept = folders.filter(folder => !isPowerShell7ModuleFolder(folder));
  return kept.length === folders.length ? undefined : kept.join(';');
}

/**
 * The environment for a process that may start Windows PowerShell: `env`
 * itself when its PSModulePath needs no change, else a copy with the value
 * from windowsPowerShellModulePath.
 */
export function windowsPowerShellEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  // Windows variable names ignore case: replace the variable under the name it has.
  const key = Object.keys(env).find(name => name.toUpperCase() === 'PSMODULEPATH');
  if (key === undefined) {
    return env;
  }
  const value = windowsPowerShellModulePath(env[key], platform);
  return value === undefined ? env : { ...env, [key]: value };
}

// Run a PowerShell command with Bypass execution policy, no profile, and a
// PSModulePath without PowerShell 7's folders (see windowsPowerShellModulePath).
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
    exec(full, { timeout: timeoutMs, env: windowsPowerShellEnv() }, (error: ExecException | null, stdout: string, stderr: string) => {
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
