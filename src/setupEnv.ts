import * as vscode from "vscode";
import { CancellationToken, Terminal } from "vscode";
import { getZephyrTerminal, runCommandTerminal } from "./zephyrTerminalUtils";
import { ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from "./constants";

// export let output = vscode.window.createOutputChannel("Zephyr West Buildsystem");

function checkZephyrEnv(context: vscode.ExtensionContext, token: CancellationToken) {
}

async function sourceZephyrEnv(context: vscode.ExtensionContext, token: CancellationToken, terminal: Terminal) {
  let envScript = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
  if(envScript) {
    let cmd = `. ${envScript}`;
    runCommandTerminal(terminal, cmd);
  } else {
    // envScript missing
    vscode.window.showErrorMessage("Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Ac6 Zephyr");
  }
}

export function setupZephyrEnv(context: vscode.ExtensionContext) {
  vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
            title: "Setup Zephyr development environment",
            cancellable: true,
    }, async (progress, token) => {
      // output.clear();
      // output.show();
      const activeTerminal = await getZephyrTerminal();
      activeTerminal.show();
      
      progress.report({ message: "Sourcing setup environment script" });
      sourceZephyrEnv(context, token, activeTerminal);
     
      progress.report({ message: "Check if environment is well set up", increment: 50 });
      checkZephyrEnv(context, token);

      progress.report({ message: "Setup Zephyr environment successful", increment: 100 });
      vscode.window.showInformationMessage("Setup Zephyr environment successful");
    }
  );
}

