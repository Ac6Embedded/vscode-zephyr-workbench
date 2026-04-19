import * as vscode from 'vscode';
import {
  execShellCommand,
  classifyShell,
  getShellExe,
  getShellArgs,
  normalizePathForShell,
} from "../utils/execUtils";
import { ZephyrApplication } from '../models/ZephyrApplication';
import { findVenvSPDXExecutablePath } from '../utils/installUtils';

export async function execNtiaCheckerCommand(spdxFile: string, zephyrProject: ZephyrApplication) {
  await execSPDXCommand('ntia-checker', 'ntia-checker', `--file ${formatShellArgument(classifyShell(getShellExe()), spdxFile)}`, zephyrProject);
}

export async function execSBom2DocCommand(spdxFile: string, zephyrProject: ZephyrApplication) {
  await execSPDXCommand('sbom2doc', 'sbom2doc', `-i ${formatShellArgument(classifyShell(getShellExe()), spdxFile)}`, zephyrProject);
}

export async function execCveBinToolCommand(spdxFile: string, zephyrProject: ZephyrApplication) {
  await execSPDXCommand(
    'cve-bin-tool',
    'cve-bin-tool',
    `--sbom spdx --sbom-file ${formatShellArgument(classifyShell(getShellExe()), spdxFile)}`,
    zephyrProject,
  );
}

function formatShellArgument(shellKind: string, value: string): string {
  const normalized = normalizePathForShell(shellKind, value);
  if (shellKind === 'cmd.exe' || shellKind === 'powershell.exe' || shellKind === 'pwsh.exe') {
    return /\s/.test(normalized) ? `"${normalized}"` : normalized;
  }
  return normalized;
}

function formatShellExecutable(shellKind: string, executablePath: string): string {
  const formattedPath = formatShellArgument(shellKind, executablePath);
  if (shellKind === 'powershell.exe' || shellKind === 'pwsh.exe') {
    return `& ${formattedPath}`;
  }
  return formattedPath;
}

export async function execSPDXCommand(
  cmdName      : string,
  executable   : string,
  args         : string,
  zephyrProject: ZephyrApplication
) {
  if (!executable?.length) {
    throw new Error('Missing command to execute', { cause: 'missing.command' });
  }

  const shellExe  = getShellExe();
  const shellKind = classifyShell(shellExe);
  const executablePath = findVenvSPDXExecutablePath(
    zephyrProject.appWorkspaceFolder.uri.fsPath,
    executable,
  );

  if (!executablePath) {
    throw new Error(
      'Missing SPDX tools, please install the dependencies',
      { cause: 'missing.spdx.tools' }
    );
  }

  const shellArgs = getShellArgs(shellKind);

  const options: vscode.ShellExecutionOptions = {
    cwd       : zephyrProject.appRootPath,
    executable: shellExe,
    shellArgs
  };

  await execShellCommand(
    cmdName,
    `${formatShellExecutable(shellKind, executablePath)} ${args}`.trim(),
    options
  );
}
