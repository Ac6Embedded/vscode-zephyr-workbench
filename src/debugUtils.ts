import fs from 'fs';
import path from 'path';
import * as vscode from 'vscode';
import { ZEPHYR_APP_FILENAME, ZEPHYR_DIRNAME, ZEPHYR_WORKBENCH_PATHTOENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from "./constants";
import { Linkserver } from "./debug/runners/Linkserver";
import { Openocd } from "./debug/runners/Openocd";
import { WestRunner } from "./debug/runners/WestRunner";
import { concatCommands, getShell, getShellSourceCommand } from './execUtils';
import { WestWorkspace } from "./WestWorkspace";
import { ZephyrProject } from "./ZephyrProject";
import { getSupportedBoards, getWestWorkspace, getZephyrSDK } from './utils';

export function getDebugRunners(): WestRunner[] {
  return [ new Openocd(), 
    new Linkserver() ];
}

export function getRunner(runnerName: string): WestRunner | undefined {
  switch(runnerName) {
    case 'openocd':
      return new Openocd();
    case 'linkserver':
      return new Linkserver();
    default: 
      return undefined;
  }
}

export function createWestWrapper(project: ZephyrProject, westWorkspace: WestWorkspace) {
  let envScript: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_PATHTOENV_SCRIPT_SETTING_KEY);
  if(!envScript) {
    throw new Error('Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Zephyr Workbench > Path To Env Script',
       { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATHTOENV_SCRIPT_SETTING_KEY}` });
  } 
  const shell: string = getShell();
  let westCmd = '';
  switch (shell) {
    case 'bash': 
      westCmd = 'west "$@"';
      break;
    case 'cmd.exe':
      westCmd = 'west %*';
      break;
    case 'powershell.exe':
      westCmd = 'west $args';
      break;
    default:
      westCmd = 'west "$@"';
      break;
  }

  const cmdEnv = getShellSourceCommand(shell, envScript);
  const debugServerCommand = concatCommands(shell, cmdEnv, westCmd);
  
  let envVars = {
    ...westWorkspace.buildEnv,
    ...project.buildEnv
  };

  let envVarsCommands = '';

  for (const [key, value] of Object.entries(envVars)) {
    switch (shell) {
      case 'bash': 
        envVarsCommands += `export ${key}="${value}"\n`;
        break;
      case 'cmd.exe':
        envVarsCommands += `set ${key}=${value}\n`;
        break;
      case 'powershell.exe':
        envVarsCommands += `$env:${key} = "${value}"\n`;
        break;
      default:
        envVarsCommands += `export ${key}="${value}"\n`;
        break;
    }
  }

  let wrapperPath = '';
  let wrapperScript = '';
  switch (shell) {
    case 'bash': 
      wrapperScript = `#!/bin/bash
# Set environment variables
${envVarsCommands}

# Source environment and execute West
${debugServerCommand}
`;
      wrapperPath = path.join(project.sourceDir, 'west_wrapper.sh');
      fs.writeFileSync(wrapperPath, wrapperScript, { mode: 0o755 });
      break;
    case 'cmd.exe':
      wrapperScript = `@echo off
REM Set environment variables
${envVarsCommands}

REM Source environment and execute West
${debugServerCommand}
`;
      wrapperPath = path.join(project.sourceDir, 'west_wrapper.bat');
      fs.writeFileSync(wrapperPath, wrapperScript);
      break;
    case 'powershell.exe':
      wrapperScript = `${envVarsCommands}

# Source environment and execute West
${debugServerCommand}
`;
      wrapperPath = path.join(project.sourceDir, 'west_wrapper.ps1');
      fs.writeFileSync(wrapperPath, wrapperScript);
      break;
    default:
      break;
  }
}

export async function createConfiguration(project: ZephyrProject): Promise<any> {
  
  const westWorkspace = getWestWorkspace(project.westWorkspacePath);
  const zephyrSDK = getZephyrSDK(project.sdkPath);
  const listBoards = await getSupportedBoards(westWorkspace);

  let targetBoard;
  for(let board of listBoards) {
    if(board.identifier === project.boardId) {
      targetBoard = board;
    }
  }
  if(!targetBoard) {
    return;
  }

  const targetArch = targetBoard.arch;
  const program = path.join('${workspaceFolder}', 'build', '${config:zephyr-workbench.board}', ZEPHYR_DIRNAME, ZEPHYR_APP_FILENAME);

  const shell: string = getShell();
  let wrapper = '';
  switch (shell) {
    case 'bash': 
      wrapper = 'west_wrapper.sh';
      break;
    case 'cmd.exe':
      wrapper = 'west_wrapper.bat';
      break;
    case 'powershell.exe':
      wrapper = 'west_wrapper.ps1';
      break;
    default:
      wrapper = 'west_wrapper';
      break;
  }

  const launchJson = {
    name: "Zephyr Workbench Debug",
    type: "cppdbg",
    request: "launch",
    cwd: "${workspaceFolder}",
    program: `"${program}"`,
    args: [],
    stopAtEntry: true,
    environment: [],
    externalConsole: false,
    serverLaunchTimeout: 20000,
    filterStderr: true,
    filterStdout: true,
    serverStarted: "${serverStartPattern}",
    MIMode: "gdb",
    miDebuggerPath: `"${zephyrSDK.getDebuggerPath(targetArch)}"`,
    miDebuggerServerAddress: "localhost:3333",
    debugServerPath: `"$\{workspaceFolder\}/${wrapper}"`,
    debugServerArgs: "debugserver --runner openocd --build-dir ${workspaceFolder}/build/${config:zephyr-workbench.board}",
    setupCommands: [],
    logging: {}
  };

  return launchJson;
}

export async function createLaunchJson(project: ZephyrProject): Promise<any> {
  
  const westWorkspace = getWestWorkspace(project.westWorkspacePath);
  const zephyrSDK = getZephyrSDK(project.sdkPath);
  const listBoards = await getSupportedBoards(westWorkspace);

  let targetBoard;
  for(let board of listBoards) {
    if(board.identifier === project.boardId) {
      targetBoard = board;
    }
  }
  if(!targetBoard) {
    return;
  }

  const targetArch = targetBoard.arch;
  const program = path.join('${workspaceFolder}', 'build', '${config:zephyr-workbench.board}', ZEPHYR_DIRNAME, ZEPHYR_APP_FILENAME);

  const shell: string = getShell();
  let wrapper = '';
  switch (shell) {
    case 'bash': 
      wrapper = 'west_wrapper.sh';
      break;
    case 'cmd.exe':
      wrapper = 'west_wrapper.bat';
      break;
    case 'powershell.exe':
      wrapper = 'west_wrapper.ps1';
      break;
    default:
      wrapper = 'west_wrapper';
      break;
  }

  const launchJson = {
    version: "0.2.0",
    configurations: [
      {
        name: "Zephyr Workbench Debug",
        type: "cppdbg",
        request: "launch",
        cwd: "${workspaceFolder}",
        program: `"${program}"`,
        args: [],
        stopAtEntry: true,
        environment: [],
        externalConsole: false,
        serverLaunchTimeout: 20000,
        filterStderr: true,
        filterStdout: true,
        serverStarted: "${serverStartPattern}",
        MIMode: "gdb",
        miDebuggerPath: `"${zephyrSDK.getDebuggerPath(targetArch)}"`,
        miDebuggerServerAddress: "localhost:3333",
        debugServerPath: `"$\{workspaceFolder\}/${wrapper}"`,
        debugServerArgs: "debugserver --runner openocd --build-dir ${workspaceFolder}/build/${config:zephyr-workbench.board}",
        setupCommands: [],
        logging: {}
      },
    ]
  };

  return launchJson;
}

export async function readLaunchJson(project: ZephyrProject): Promise<any> {
  let launchJson = JSON.parse(await fs.promises.readFile(path.join(project.sourceDir, '.vscode', 'launch.json'), 'utf8'));
  return launchJson;
}

export function writeLaunchJson(project: ZephyrProject, launchJson: any) {
  fs.writeFileSync(path.join(project.sourceDir, '.vscode', 'launch.json'), JSON.stringify(launchJson, null, 2));
}

export async function findLaunchConfiguration(project: ZephyrProject, launchJson: any): Promise<any> {
  for(let configuration of launchJson.configurations) {
    if(configuration.name === 'Zephyr Workbench Debug') {
      return configuration;
    }
  }
  launchJson.configurations.push(await createConfiguration(project));
  return await findLaunchConfiguration(project, launchJson);
}

export async function getLaunchConfiguration(project: ZephyrProject): Promise<[any, any]> {
  if(!fs.existsSync(path.join(project.sourceDir, '.vscode', 'launch.json'))) {
    writeLaunchJson(project, await createLaunchJson(project));
  }

  let launchJson = await readLaunchJson(project);
  if(launchJson) {
    let configurationJson = await findLaunchConfiguration(project, launchJson);
    return [launchJson, configurationJson];
  }
  return [undefined, undefined];
}
