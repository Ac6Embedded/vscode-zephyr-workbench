import * as vscode from 'vscode';
import { concatCommands, execShellCommand, getShell, getShellArgs, getShellSourceCommand } from "./execUtils";
import { ZephyrProject } from './ZephyrProject';
import { findVenvSPDXActivateScript } from './installUtils';
import { fileExists } from './utils';

export async function execNtiaCheckerCommand(spdxFile: string, zephyrProject: ZephyrProject) {
  const command = `ntia-checker --file ${spdxFile}`;
  await execSPDXCommand('ntia-checker', command, zephyrProject);
}

export async function execSBom2DocCommand(spdxFile: string, zephyrProject: ZephyrProject) {
  const command = `sbom2doc -i ${spdxFile}`;
  await execSPDXCommand('sbom2doc', command, zephyrProject);
}

export async function execCveBinToolCommand(spdxFile: string, zephyrProject: ZephyrProject) {
  const command = `cve-bin-tool --sbom spdx --sbom-file ${spdxFile}`;
  await execSPDXCommand('cve-bin-tool', command, zephyrProject);
}

export async function execSPDXCommand(cmdName: string, cmd: string, zephyrProject: ZephyrProject) {
  if(!cmd || cmd.length === 0) {
    throw new Error('Missing command to execute', { cause: "missing.command" });
  }

  let activateScript = findVenvSPDXActivateScript(zephyrProject.workspaceFolder.uri.fsPath);
  if(!activateScript || !fileExists(activateScript)) {
    throw new Error('Missing SPDX tools, please install the dependencies', { cause: "missing.command" });
  }

  const shell: string = getShell();
  const shellArgs: string[] = getShellArgs(shell);
  let options: vscode.ShellExecutionOptions = {
    cwd: zephyrProject.folderPath,
    executable: shell,
    shellArgs: shellArgs
  };

  // Prepend environment script before any command
  let cmdEnv = getShellSourceCommand(shell, activateScript);
  await execShellCommand(cmdName, concatCommands(shell, cmdEnv, cmd), options);
} 