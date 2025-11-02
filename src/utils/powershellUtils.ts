import { ExecException, exec } from "child_process";
import * as vscode from "vscode";

// Run a PowerShell command with Bypass execution policy and no profile
export type PowerShellFlavor = 'powershell' | 'pwsh';
export function runPowershellCommand(
  cmd: string,
  flavor: PowerShellFlavor = 'powershell'
): Promise<{ stdout: string; stderr: string }>
{
  const exe = flavor === 'pwsh' ? 'pwsh' : 'powershell';
  const full = `${exe} -ExecutionPolicy Bypass -NoProfile -NonInteractive -Command ${cmd}`;
  return new Promise((resolve, reject) => {
    exec(full, (error: ExecException | null, stdout: string, stderr: string) => {
      if (error) { return reject(Object.assign(error, { stdout, stderr })); }
      resolve({ stdout, stderr });
    });
  });
}

export async function getCurrentUserExecutionPolicy(): Promise<string> {
  try {
    const { stdout } = await runPowershellCommand(`\"(Get-ExecutionPolicy -Scope CurrentUser -ErrorAction SilentlyContinue)\"`);
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

// Ensure PowerShell execution policy allows running scripts for CurrentUser (Windows only)
export async function ensurePowershellExecutionPolicy(): Promise<boolean> {
  if (process.platform !== 'win32') { return true; }

  const docsUrl = 'https://z-workbench.com/docs/documentation/known-issues#powershell-script-execution-disabled';

  const current = await getCurrentUserExecutionPolicy();
  if (isExecutionPolicyAllowed(current)) {
    return true;
  }

  // Try to silently set the policy for CurrentUser to RemoteSigned
  try {
    await runPowershellCommand(`\"Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force\"`);
  } catch {
    // ignore failures here; we still warn the user below
  }

  // Re-check after attempting to set; if allowed now, proceed without warning
  const after = await getCurrentUserExecutionPolicy();
  if (isExecutionPolicyAllowed(after)) {
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
