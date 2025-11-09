import * as vscode from 'vscode';
import { concatCommands, execShellCommand,   classifyShell, getShellExe,getShell, getShellArgs, getShellSourceCommand, normalizePathForShell, normalisePathsInString } from "../utils/execUtils";
import { ZephyrProject } from '../models/ZephyrProject';
import { findVenvSPDXActivateScript } from '../utils/installUtils';
import { fileExists } from '../utils/utils';

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

export async function execSPDXCommand(
  cmdName      : string,
  cmd          : string,
  zephyrProject: ZephyrProject
) {

  if (!cmd?.length) {
    throw new Error('Missing command to execute', { cause: 'missing.command' });
  }

  /* locate the venv’s activate script ------------------------------------------------ */
  let activateScript = findVenvSPDXActivateScript(zephyrProject.workspaceFolder.uri.fsPath);
  if (!activateScript || !fileExists(activateScript)) {
    throw new Error(
      'Missing SPDX tools, please install the dependencies',
      { cause: 'missing.spdx.tools' }
    );
  }

  /* detect & classify current shell -------------------------------------------------- */
  const shellExe  = getShellExe();
  const shellKind = classifyShell(shellExe);
  const shellArgs = getShellArgs(shellKind);

  /* path conversions for POSIX-ish shells on Windows --------------------------------- */
  const posixish = ['bash', 'zsh', 'dash', 'fish'].includes(shellKind);

  if (posixish) {
    activateScript = normalizePathForShell(shellKind, activateScript);
    cmd            = normalisePathsInString(shellKind, cmd);
  }

  /* build ShellExecution options ----------------------------------------------------- */
  const options: vscode.ShellExecutionOptions = {
    cwd       : zephyrProject.folderPath,
    executable: shellExe,
    shellArgs
  };

  /* prepend ‘source <activate>’ and run ---------------------------------------------- */
  const cmdEnv = getShellSourceCommand(shellKind, activateScript);
  await execShellCommand(
    cmdName,
    concatCommands(shellKind, cmdEnv, cmd),
    options
  );
}