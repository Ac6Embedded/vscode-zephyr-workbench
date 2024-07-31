import * as vscode from "vscode";
import { Terminal } from "vscode";

export async function openZephyrTerminal(): Promise<vscode.Terminal> {
  let shell: string = "";
  switch(process.platform) {
    case 'linux': {
      shell = 'bash';
      break; 
    }
    case 'win32': {
      shell = 'cmd.exe';
      break; 
    }
    case 'darwin': {
      shell = 'bash';
      break; 
    }
    default: {
      shell = 'bash';
      break; 
    }
  }
  
  let opts: vscode.TerminalOptions = {
    name: "Zephyr BuildSystem Terminal",
    shellPath: `${shell}`,
    env: getZephyrEnvironment(),
  };
  const terminal = vscode.window.createTerminal(opts);
  return terminal;
}

export async function getZephyrTerminal(): Promise<vscode.Terminal> {
  const terminals = <vscode.Terminal[]>(<any>vscode.window).terminals;
  for(let i=0; i<terminals.length; i++) {
    const cTerminal = terminals[i];
    if(cTerminal.name === "Zephyr BuildSystem Terminal") {
      return cTerminal;
    }
  }

  return await openZephyrTerminal();
}

export async function runCommandTerminal(terminal: Terminal, command: string) {
  if(command) {
    terminal.sendText(command);
  }
}

export function getZephyrEnvironment(): { [key: string]: string | null | undefined; } | undefined {
  let env = process.env;

	// env["TEST_ZEPHYR"] = "Shell variable";
	// env["PATH"] = path.join("/newpath/test/", ":" + env["PATH"]);

	return env;
}

