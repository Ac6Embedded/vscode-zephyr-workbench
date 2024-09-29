import * as fs from 'fs';
import * as vscode from 'vscode';
import { ZephyrProject } from './ZephyrProject';
import { execShellCommandWithEnv, getShell, getShellNullRedirect } from './execUtils';
import { WestWorkspace } from './WestWorkspace';
import { fileExists, getZephyrSDK } from './utils';
import { ZephyrSDK } from './ZephyrSDK';
import path from 'path';

export function registerWestCommands(context: vscode.ExtensionContext): void {
  // TODO use this function to register every west command 
  // for better code structure
}

export async function westInitCommand(srcUrl: string, srcRev: string, workspacePath: string, manifestPath: string = ''): Promise<void> {
  let command = '';
  // If init remote repository
  if(srcUrl && srcUrl !== '') {
    command = `west init -m ${srcUrl} --mr ${srcRev} ${workspacePath}`;
    if(manifestPath !== '') {
      command += ` --mf ${manifestPath}`;
    }
  } else {
    if(manifestPath !== '' && fileExists(manifestPath)) {
      // If init from manifest, prepare directory
      if(!fileExists(workspacePath)) {
        fs.mkdirSync(workspacePath);
      }
      let manifestDir = path.join(workspacePath, 'manifest');
      fs.mkdirSync(manifestDir);

      let manifestFile = path.basename(manifestPath);
      const destFilePath = path.join(manifestDir, manifestFile);
      if(!fileExists(destFilePath)) {
        fs.cpSync(manifestPath, destFilePath);
      }
      command = `west init -l --mf ${manifestFile} ${manifestDir}`;
    }
  }

  let options: vscode.ShellExecutionOptions = {
    env: { ZEPHYR_PROJECT_DIRECTORY: workspacePath },
    cwd: "${userHome}"
  };
  await execWestCommand(`West Init for current workspace`, command, options);
}

export async function westUpdateCommand(workspacePath: string): Promise<void> {
  let command = "west update";

  let options: vscode.ShellExecutionOptions = {
    env: { ZEPHYR_PROJECT_DIRECTORY: workspacePath },
    cwd: `${workspacePath}`
  };

  await execWestCommand(`West Update for current workspace`, command, options);
}

export async function westBoardsCommand(workspacePath: string): Promise<void> {
  const redirect = getShellNullRedirect(getShell());
  let command = `west boards ${redirect}`;

  let options: vscode.ShellExecutionOptions = {
    env: { ZEPHYR_PROJECT_DIRECTORY: workspacePath },
    cwd: `${workspacePath}`
  };

  await execWestCommand(`West Update for current workspace`, command, options);
}

export async function westBuildCommand(zephyrProject: ZephyrProject, westWorkspace: WestWorkspace): Promise<void> {
  
  if(zephyrProject.boardId === undefined || zephyrProject.folderPath === undefined) {
    return;
  }

  let activeSdk: ZephyrSDK = getZephyrSDK(zephyrProject.sdkPath);
  if(!activeSdk) {
    throw new Error('The Zephyr SDK is missing, please install host tools first');
  }
  
  let buildDir = path.join(zephyrProject.folderPath, 'build', zephyrProject.boardId);
  let command = `west build -p always --board ${zephyrProject.boardId} --build-dir ${buildDir} ${zephyrProject.folderPath}`;
  let options: vscode.ShellExecutionOptions = {
    env: {...activeSdk.buildEnv, ...westWorkspace.buildEnv },
    cwd: westWorkspace.kernelUri.fsPath
  };

  await execWestCommand(`West build for ${zephyrProject.folderName}`, command, options);
}

export async function westFlashCommand(zephyrProject: ZephyrProject, westWorkspace: WestWorkspace): Promise<void> {
  let buildDir = path.join(zephyrProject.folderPath, 'build', zephyrProject.boardId);
  let command = `west flash --build-dir ${buildDir}`;

  let activeSdk: ZephyrSDK = getZephyrSDK(zephyrProject.sdkPath);
  if(!activeSdk) {
    throw new Error('The Zephyr SDK is missing, please install host tools first');
  }

  let options: vscode.ShellExecutionOptions = {
    env: {...activeSdk.buildEnv, ...westWorkspace.buildEnv },
    cwd: westWorkspace.kernelUri.fsPath
  };

  await execWestCommand(`West flash for ${zephyrProject.folderName}`, command, options);
}

export async function westDebugCommand(zephyrProject: ZephyrProject, westWorkspace: WestWorkspace): Promise<void> {
  let buildDir = path.join(zephyrProject.folderPath, 'build', zephyrProject.boardId);
  let command = `west debug --build-dir ${buildDir}`;

  let options: vscode.ShellExecutionOptions = {
    env: westWorkspace.buildEnv,
    cwd: westWorkspace.kernelUri.fsPath
  };

  await execWestCommand(`West debug for ${zephyrProject.folderName}`, command, options);
}

/**
 * Execute a West command, the west command is prepend with a command to source the environment script
 * @param cmdName The command name
 * @param cmd     The west command
 * @param options The shell execution option (if no cwd, ${workspaceFolder} is default)
 * @returns 
 */
export async function execWestCommand(cmdName: string, cmd: string, options: vscode.ShellExecutionOptions) {
  await execShellCommandWithEnv(cmdName, cmd, options);
} 