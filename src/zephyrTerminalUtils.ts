import * as vscode from 'vscode';
import { getShellExe, getResolvedShell } from './execUtils';

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

export async function openZephyrTerminal(): Promise<vscode.Terminal> {

  let shellPath  = 'bash'; 
  let shellArgs: string[] | undefined;    

  if (process.platform === 'win32') {
    const resolved = getResolvedShell();
    shellPath  = resolved.path;
    shellArgs  = resolved.args;
  }

  const opts: vscode.TerminalOptions = {
    name: 'Zephyr BuildSystem Terminal',
    shellPath,
    shellArgs,
    env: {
      ...getProfileEnv(),
      ...getZephyrEnvironment()
    }
  };

  const terminal = vscode.window.createTerminal(opts);
  return terminal;
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