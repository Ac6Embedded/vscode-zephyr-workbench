import * as vscode from 'vscode';
import {
  concatCommands,
  execShellCommand,
  classifyShell,
  getShellExe,
  getShellArgs,
  getShellSourceCommand,
  normalizePathForShell,
  normalisePathsInString,
} from "../utils/execUtils";
import { ZephyrApplication } from '../models/ZephyrApplication';
import { findVenvSPDXActivateScript } from '../utils/installUtils';
import { fileExists } from '../utils/utils';

export async function execNtiaCheckerCommand(spdxFile: string, zephyrProject: ZephyrApplication) {
  const command = `ntia-checker --file ${spdxFile}`;
  await execSPDXCommand('ntia-checker', command, zephyrProject);
}

export async function execSBom2DocCommand(spdxFile: string, zephyrProject: ZephyrApplication) {
  const command = `sbom2doc -i ${spdxFile}`;
  await execSPDXCommand('sbom2doc', command, zephyrProject);
}

export async function execCveBinToolCommand(spdxFile: string, zephyrProject: ZephyrApplication) {
  const command = `cve-bin-tool --sbom spdx --sbom-file ${spdxFile}`;
  await execSPDXCommand('cve-bin-tool', command, zephyrProject);
}

export async function execSPDXCommand(
  cmdName      : string,
  cmd          : string,
  zephyrProject: ZephyrApplication
) {
  if (!cmd?.length) {
    throw new Error('Missing command to execute', { cause: 'missing.command' });
  }

  // SPDX helpers live in the application's Python environment.
  let activateScript = findVenvSPDXActivateScript(zephyrProject.appWorkspaceFolder.uri.fsPath);
  if (!activateScript || !fileExists(activateScript)) {
    throw new Error(
      'Missing SPDX tools, please install the dependencies',
      { cause: 'missing.spdx.tools' }
    );
  }

  const shellExe  = getShellExe();
  const shellKind = classifyShell(shellExe);
  const shellArgs = getShellArgs(shellKind);

  // Normalize paths before sourcing the venv when a POSIX shell runs on Windows.
  const posixish = ['bash', 'zsh', 'dash', 'fish'].includes(shellKind);
  if (posixish) {
    activateScript = normalizePathForShell(shellKind, activateScript);
    cmd = normalisePathsInString(shellKind, cmd);
  }

  const options: vscode.ShellExecutionOptions = {
    cwd       : zephyrProject.appRootPath,
    executable: shellExe,
    shellArgs
  };

  // Activate the venv for this command only instead of mutating the user's shell.
  const cmdEnv = getShellSourceCommand(shellKind, activateScript);
  await execShellCommand(
    cmdName,
    concatCommands(shellKind, cmdEnv, cmd),
    options
  );
}
