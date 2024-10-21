import fs from 'fs';
import path from 'path';
import * as vscode from 'vscode';
import { ZEPHYR_APP_FILENAME, ZEPHYR_DIRNAME, ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from "./constants";
import { Linkserver } from "./debug/runners/Linkserver";
import { Openocd } from "./debug/runners/Openocd";
import { WestRunner } from "./debug/runners/WestRunner";
import { checkPyOCDTarget, concatCommands, getShell, getShellSourceCommand, installPyOCDTarget, updatePyOCDPack } from './execUtils';
import { ZephyrProject } from "./ZephyrProject";
import { getConfigValue, getSupportedBoards, getWestWorkspace, getZephyrSDK } from './utils';
import { STM32CubeProgrammer } from './debug/runners/STM32CubeProgrammer';
import { JLink } from './debug/runners/JLink';
import { PyOCD } from './debug/runners/PyOCD';

export const ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME = 'Zephyr Workbench Debug';

export function getDebugRunners(): WestRunner[] {
  return [ 
    new Openocd(), 
    new Linkserver(),
    new JLink(),
    new PyOCD()
  ];
}

export function getRunRunners(): WestRunner[] {
  return [ 
    new Openocd(), 
    new Linkserver(),
    new STM32CubeProgrammer(),
    new JLink(),
    new PyOCD()
  ];
}

export function getRunner(runnerName: string): WestRunner | undefined {
  switch(runnerName) {
    case 'openocd':
      return new Openocd();
    case 'linkserver':
      return new Linkserver();
    case 'jlink':
      return new JLink();
    case 'pyocd':
      return new PyOCD();
    case 'stm32cubeprogrammer':
      return new STM32CubeProgrammer();
    default: 
      return undefined;
  }
}

export function createWestWrapper(project: ZephyrProject) {
  const westWorkspace = getWestWorkspace(project.westWorkspacePath);
  let envScript: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
  if(!envScript) {
    throw new Error('Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Zephyr Workbench > Path To Env Script',
       { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` });
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
      wrapperPath = path.join(project.buildDir, 'west_wrapper.sh');
      fs.writeFileSync(wrapperPath, wrapperScript, { mode: 0o755 });
      break;
    case 'cmd.exe':
      wrapperScript = `@echo off
REM Set environment variables
${envVarsCommands}

REM Source environment and execute West
${debugServerCommand}
`;
      wrapperPath = path.join(project.buildDir, 'west_wrapper.bat');
      fs.writeFileSync(wrapperPath, wrapperScript);
      break;
    case 'powershell.exe':
      wrapperScript = `${envVarsCommands}

# Source environment and execute West
${debugServerCommand}
`;
      wrapperPath = path.join(project.buildDir, 'west_wrapper.ps1');
      fs.writeFileSync(wrapperPath, wrapperScript);
      break;
    default:
      break;
  }
}

export function createOpenocdCfg(project: ZephyrProject) {
  let cfgPath = path.join(project.buildDir, 'gdb.cfg');
  const cfgContent = `# Workaround to force OpenOCD to shutdown when gdb is detached

  $_TARGETNAME configure -event gdb-detach {
  shutdown
}`;
  fs.writeFileSync(cfgPath, cfgContent);
}

export async function setupPyOCDTarget(project: ZephyrProject) {
  let target = project.getPyOCDTarget();
  if(target) { 
    if(!(await checkPyOCDTarget(target))) {
      await updatePyOCDPack();
      await installPyOCDTarget(target);
    }
  }
}

export async function createConfiguration(project: ZephyrProject): Promise<any> {
  const westWorkspace = getWestWorkspace(project.westWorkspacePath);
  const zephyrSDK = getZephyrSDK(project.sdkPath);
  const listBoards = await getSupportedBoards(westWorkspace, project);

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
	const socToolchainName = project.getKConfigValue('SOC_TOOLCHAIN_NAME');

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
    preLaunchTask: "West Build",
    program: `${program}`,
    args: [],
    stopAtEntry: true,
    svdPath: "",
    environment: [],
    externalConsole: false,
    serverLaunchTimeout: 10000,
    filterStderr: true,
    filterStdout: true,
    serverStarted: "",
    MIMode: "gdb",
    miDebuggerPath: `${zephyrSDK.getDebuggerPath(targetArch, socToolchainName)}`,
    debugServerPath: `\${workspaceFolder}/build/\${config:zephyr-workbench.board}/${wrapper}`,
    debugServerArgs: "",
    setupCommands: [
      { 
        text: "-target-select remote localhost:3333", 
        description: "connect to target",
        ignoreFailures: false 
      },
    ],
    logging: {
      moduleLoad: true,
      trace: true,
      engineLogging: true,
      programOutput: true,
      exceptions: true
    }
  };

  return launchJson;
}

export async function createLaunchJson(project: ZephyrProject): Promise<any> {
  
  const launchJson : any = {
    version: "0.2.0",
    configurations: []
  };

  let config = await createConfiguration(project);
  launchJson.configurations.push(config);

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
    if(configuration.name === ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME) {
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

export function getServerAddressFromConfig(config: any) : any | undefined {
  for(const setupCmd of config.setupCommands) {
    if(setupCmd.description === 'connect to target') {
      const regex = /\S*:\S*/g;
      const matches = setupCmd.text.match(regex);
      if(matches) {
        return matches[0];
      }
    }
  }
  return undefined;
}