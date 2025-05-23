import { ChildProcess, exec, ExecException, ExecOptions } from 'child_process';
import * as fs from 'fs';
import path from 'path';
import * as vscode from 'vscode';
import { WestWorkspace } from './WestWorkspace';
import { ZephyrAppProject } from './ZephyrAppProject';
import { ZephyrProject } from './ZephyrProject';
import { ZephyrSDK } from './ZephyrSDK';
import { ZephyrProjectBuildConfiguration } from './ZephyrProjectBuildConfiguration';
import { ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY } from './constants';
import { concatCommands, execShellCommandWithEnv, getShell, getShellNullRedirect, getShellIgnoreErrorCommand, getShellSourceCommand } from './execUtils';
import { fileExists, getWestWorkspace, getZephyrSDK, normalizePath } from './utils';

export function registerWestCommands(context: vscode.ExtensionContext): void {
  // TODO use this function to register every west command 
  // for better code structure
}

export async function westInitCommand(srcUrl: string, srcRev: string, workspacePath: string, manifestPath: string = ''): Promise<void> {
  let command = '';
  // If init remote repository
  if (srcUrl && srcUrl !== '') {
    workspacePath = normalizePath(workspacePath);
    command = `west init -m ${srcUrl} --mr ${srcRev} ${workspacePath}`;
    if (manifestPath !== '') {
      manifestPath = normalizePath(manifestPath);
      command += ` --mf ${manifestPath}`;
    }
  } else {
    if (manifestPath !== '' && fileExists(manifestPath)) {
      let manifestDir = path.join(workspacePath, 'manifest');
      let manifestFile = path.basename(manifestPath);
      const destFilePath = path.join(manifestDir, manifestFile);

      // If the manifest is not already in the destination folder 
      if (destFilePath !== manifestPath) {
        // If init from manifest, prepare directory
        if (!fileExists(workspacePath)) {
          fs.mkdirSync(workspacePath);
        }
        fs.mkdirSync(manifestDir);

        if (!fileExists(destFilePath)) {
          fs.cpSync(manifestPath, destFilePath);
        }
      }
      manifestFile = normalizePath(manifestFile);
      manifestDir = normalizePath(manifestDir);
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

export async function westPackagesInstallCommand(workspacePath: string): Promise<void> {

  const command = "west packages pip --install";

  const options: vscode.ShellExecutionOptions = {
    env: { ZEPHYR_PROJECT_DIRECTORY: workspacePath },
    cwd: workspacePath
  };

  await execWestCommand(
    "West – install Python dependencies for current workspace",
    command,
    options
  );
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

export async function westTmpBuildSystemCommand(zephyrProject: ZephyrProject, westWorkspace: WestWorkspace, buildConfig?: ZephyrProjectBuildConfiguration): Promise<string | undefined> {
  const redirect = getShellIgnoreErrorCommand(getShell());
  const tmpPath = normalizePath(path.join(zephyrProject.folderPath, '.tmp'));
  let command = `west build -t boards --board 96b_aerocore2 --build-dir ${tmpPath} ${redirect}`;

  if (buildConfig) {
    if (buildConfig.boardIdentifier === undefined || zephyrProject.folderPath === undefined) {
      return undefined;
    }
    let activeSdk: ZephyrSDK = getZephyrSDK(zephyrProject.sdkPath);
    if (!activeSdk) {
      throw new Error('The Zephyr SDK is missing, please install host tools first');
    }
    let options: vscode.ShellExecutionOptions = {
      env: { ...buildConfig.envVars, ...activeSdk.buildEnv, ...westWorkspace.buildEnv },
      cwd: zephyrProject.folderPath
    };
    await execWestCommand(`West Update for current workspace`, command, options);
    return tmpPath;
  }
}

export async function westBuildCommand(zephyrProject: ZephyrProject, westWorkspace: WestWorkspace): Promise<void> {
  let buildConfig;
  for (let cfg of zephyrProject.configs) {
    if (cfg.active === true) {
      buildConfig = cfg; // Assign the active configuration
      break; // Exit the loop once the active configuration is found
    }
  }
  if (buildConfig === undefined){
    buildConfig = zephyrProject.configs[0];  
  }  

  if (buildConfig.boardIdentifier === undefined || zephyrProject.folderPath === undefined) {
    return;
  }

  let activeSdk: ZephyrSDK = getZephyrSDK(zephyrProject.sdkPath);
  if (!activeSdk) {
    throw new Error('The Zephyr SDK is missing, please install host tools first');
  }

  let buildDir = normalizePath(path.join(zephyrProject.folderPath, 'build', buildConfig.boardIdentifier));
  let command = `west build -p always --board ${buildConfig.boardIdentifier} --build-dir ${buildDir} ${zephyrProject.folderPath}`;
  let options: vscode.ShellExecutionOptions = {
    env: { ...activeSdk.buildEnv, ...westWorkspace.buildEnv },
    cwd: westWorkspace.kernelUri.fsPath
  };

  await execWestCommand(`West build for ${zephyrProject.folderName}`, command, options);
}

export async function westFlashCommand(zephyrProject: ZephyrProject, westWorkspace: WestWorkspace): Promise<void> {
  let buildConfig;
  for (let cfg of zephyrProject.configs) {
    if (cfg.active === true) {
      buildConfig = cfg; // Assign the active configuration
      break; // Exit the loop once the active configuration is found
    }
  }
  if (buildConfig === undefined){
    buildConfig = zephyrProject.configs[0];  
  } 

  let buildDir = normalizePath(path.join(zephyrProject.folderPath, 'build', buildConfig.boardIdentifier));
  let command = `west flash --build-dir ${buildDir}`;
  let activeSdk: ZephyrSDK = getZephyrSDK(zephyrProject.sdkPath);

  if (!activeSdk) {
    throw new Error('The Zephyr SDK is missing, please install host tools first');
  }

  let options: vscode.ShellExecutionOptions = {
    env: { ...activeSdk.buildEnv, ...westWorkspace.buildEnv },
    cwd: westWorkspace.kernelUri.fsPath
  };

  await execWestCommand(`West flash for ${zephyrProject.folderName}`, command, options);
}

export async function westDebugCommand(zephyrProject: ZephyrProject, westWorkspace: WestWorkspace): Promise<void> {
  let buildConfig;
  for (let cfg of zephyrProject.configs) {
    if (cfg.active === true) {
      buildConfig = cfg; // Assign the active configuration
      break; // Exit the loop once the active configuration is found
    }
  }
  if (buildConfig === undefined){
    buildConfig = zephyrProject.configs[0];  
  } 

  let buildDir = normalizePath(path.join(zephyrProject.folderPath, 'build', buildConfig.boardIdentifier));
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



export async function getBoardsDirectories(parent: ZephyrAppProject | WestWorkspace, boardRoots?: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let cmd = 'west boards -f "{dir}"';
    if (boardRoots) {
      for (let boardRoot of boardRoots) {
        if (boardRoot.length > 0) {
          let normalizeBoardRoot = normalizePath(boardRoot);
          cmd += ` --board-root ${normalizeBoardRoot}`;
        }
      }
    }
    execWestCommandWithEnv(cmd, parent, (error: any, stdout: string, stderr: any) => {
      if (error) {
        reject(`Error: ${stderr}`);
      }

      // Note, the newline separator is different on Windows
      let separator = '\n';
      if (process.platform === 'win32') {
        separator = '\r\n';
      }

      const boardDirs = stdout
        .trim()
        .split(separator);
      resolve(boardDirs);
    });
  });
}

/**
 * Executes the "west shields" command and returns an array of shield names.
 * @param parent The ZephyrAppProject or WestWorkspace instance.
 * @returns A promise that resolves with the list of supported shield names.
 */
export async function getSupportedShields(parent: ZephyrAppProject | WestWorkspace): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const cmd = 'west shields';
    execWestCommandWithEnv(cmd, parent, (error: any, stdout: string, stderr: string) => {
      if (error) {
        return reject(`Error: ${stderr}`);
      }

      // Use the appropriate newline separator based on the platform
      const separator = process.platform === 'win32' ? '\r\n' : '\n';
      const shieldNames = stdout.trim().split(separator).filter(name => name.length > 0);
      resolve(shieldNames);
    });
  });
}

export async function getBoardsDirectoriesFromIdentifier(boardIdentifier: string, parent: ZephyrAppProject | WestWorkspace, boardRoots?: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let boardName = boardIdentifier;
    if (boardIdentifier) {
      const regex = /^([^@\/]+)(?:@([^\/]+))?(?:\/([^\/]+)(?:\/([^\/]+)(?:\/([^\/]+))?)?)?$/;
      const match = boardIdentifier.match(regex);

      if (!match) {
        reject(`Error: Identifier format invalid for: ${boardIdentifier}`);
      } else {
        boardName = match[1];
      }
    }

    let cmd = `west boards --board ${boardName} -f "{dir}"`;
    if (boardRoots) {
      for (let boardRoot of boardRoots) {
        if (boardRoot.length > 0) {
          let normalizeBoardRoot = normalizePath(boardRoot);
          cmd += ` --board-root ${normalizeBoardRoot}`;
        }
      }
    }
    execWestCommandWithEnv(cmd, parent, (error: any, stdout: string, stderr: any) => {
      if (error) {
        reject(`Error: ${stderr}`);
      }

      // Note, the newline separator is different on Windows
      let separator = '\n';
      if (process.platform === 'win32') {
        separator = '\r\n';
      }

      const boardDirs = stdout
        .trim()
        .split(separator);
      resolve(boardDirs);
    });
  });
}

export function execWestCommandWithEnv(cmd: string, parent: ZephyrAppProject | WestWorkspace, callback?: ((error: ExecException | null, stdout: string, stderr: string) => void)): ChildProcess {
  let envScript: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
  let activatePath: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY);
  let options: ExecOptions = {};

  if (!envScript) {
    throw new Error('Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Zephyr Workbench > Path To Env Script',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` });
  }

  if (activatePath && !fileExists(activatePath)) {
    throw new Error('Invalid Python Virtual Environment.\nGo to File > Preferences > Settings > Extensions > Zephyr Workbench > Venv: Activate Path',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY}` });
  } else {
    options = {
      env: {
        ...process.env,
        'PYTHON_VENV_ACTIVATE_PATH': activatePath,
      }
    };
  }

  if (parent instanceof ZephyrAppProject) {
    const project = parent;
    const activeSdk = getZephyrSDK(project.sdkPath);
    const westWorkspace = getWestWorkspace(project.westWorkspacePath);
    const buildEnv = project.getBuildConfiguration;
    options.cwd = project.folderPath;
    options.env = {
      ...options.env,
      ...activeSdk.buildEnv,
      ...westWorkspace.buildEnv,
      ...buildEnv
    };

  } else if (parent instanceof WestWorkspace) {
    const westWorkspace = parent;
    options.cwd = westWorkspace.rootUri.fsPath;
    options.env = {
      ...options.env,
      ...westWorkspace.buildEnv
    };
  }

  const shell: string = getShell();
  const redirect = getShellNullRedirect(shell);
  const cmdEnv = `${getShellSourceCommand(shell, envScript)} ${redirect}`;
  const command = concatCommands(shell, cmdEnv, cmd);

  options.shell = shell;

  return exec(command, options, callback);
}
