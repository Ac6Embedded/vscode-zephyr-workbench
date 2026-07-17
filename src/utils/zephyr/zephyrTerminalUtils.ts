import * as vscode from 'vscode';
import { getResolvedShell } from '../execUtils';

/* detect Windows profile env (keeps file self-contained) */
function getProfileEnv(): Record<string, string> | undefined {
  if (process.platform !== 'win32') {
    return undefined;
  }

  const termCfg = vscode.workspace.getConfiguration('terminal.integrated');
  const profName = termCfg.get<string>('defaultProfile.windows');
  const profiles = termCfg.get<any>('profiles.windows');

  if (!profName || !profiles || !profiles[profName]) {
    return undefined;
  }

  return profiles[profName].env as Record<string, string> | undefined;
}

/**
 * Terminal options for the "Zephyr BuildSystem Terminal": the user's resolved
 * default shell on Windows (profile exe + args, e.g. Git Bash's --login),
 * plain 'bash' on POSIX platforms. Shared by openZephyrTerminal and the
 * `zephyr-workbench.terminal` profile provider so the two cannot drift.
 */
export function buildZephyrTerminalOptions(): vscode.TerminalOptions {
  let shellPath = 'bash';
  let shellArgs: string[] | undefined;

  if (process.platform === 'win32') {
    const resolved = getResolvedShell();
    shellPath = resolved.path;
    shellArgs = resolved.args;
  }

  return {
    name: 'Zephyr BuildSystem Terminal',
    shellPath,
    shellArgs,
    env: {
      ...getProfileEnv(),
      ...getZephyrEnvironment()
    }
  };
}

export async function openZephyrTerminal(): Promise<vscode.Terminal> {
  return vscode.window.createTerminal(buildZephyrTerminalOptions());
}

export async function getZephyrTerminal(): Promise<vscode.Terminal> {
  const terms = (vscode.window as any).terminals as vscode.Terminal[];
  for (const t of terms) {
    if (t.name === 'Zephyr BuildSystem Terminal') {
      return t;
    }
  }
  return openZephyrTerminal();
}

export async function runCommandTerminal(t: vscode.Terminal, cmd: string) {
  if (cmd) {
    t.sendText(cmd);
  }
}

export function getZephyrEnvironment():
  | { [key: string]: string | null | undefined }
  | undefined {
  return process.env;
}
