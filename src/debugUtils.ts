import fs from 'fs';
import path, { resolve } from 'path';
import * as vscode from 'vscode';
import { ZEPHYR_APP_FILENAME, ZEPHYR_DIRNAME, ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from "./constants";
import { Linkserver } from "./debug/runners/Linkserver";
import { Openocd } from "./debug/runners/Openocd";
import { WestRunner } from "./debug/runners/WestRunner";
import { checkPyOCDTarget, concatCommands, getShell, getShellSourceCommand, installPyOCDTarget, updatePyOCDPack } from './execUtils';
import { ZephyrProject } from "./ZephyrProject";
import { getSupportedBoards, getWestWorkspace, getZephyrSDK } from './utils';
import { STM32CubeProgrammer } from './debug/runners/STM32CubeProgrammer';
import { JLink } from './debug/runners/JLink';
import { PyOCD } from './debug/runners/PyOCD';
import { ZephyrBoard } from './ZephyrBoard';
import { ZephyrProjectBuildConfiguration } from './ZephyrProjectBuildConfiguration';

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

export function createWestWrapper(project: ZephyrProject, buildConfigName?: string) {
  let buildDir; 
  let buildConfig;
  if(buildConfigName) {
    buildConfig = project.getBuildConfiguration(buildConfigName);
    if(buildConfig) {
      buildDir = buildConfig.getInternalDebugDir(project);
    }
  } else {
    // For legacy compatibility
    buildDir = project.internalDebugDir;
  }
  if(!buildDir) {
    return;
  }
  
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

  if(buildConfig) {
    envVars = { ...envVars, ...buildConfig.envVars };
  }

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

  if(!fs.existsSync(buildDir)) {
    fs.mkdirSync(buildDir, { recursive: true });
  }

  let wrapperPath = '';
  let wrapperScript = '';
  switch (shell) {
    case 'bash': 
      wrapperScript = `#!/bin/bash
# Wrapper script to run west commands out of Zephyr workbench environment
# This script is auto-generated -- do not edit

# Set environment variables
${envVarsCommands}

# Source environment and execute West
${debugServerCommand}
`;
      wrapperPath = path.join(buildDir, 'west_wrapper.sh');
      fs.writeFileSync(wrapperPath, wrapperScript, { mode: 0o755 });
      break;
    case 'cmd.exe':
      wrapperScript = `@echo off
REM Wrapper script to run west commands out of Zephyr workbench environment
REM This script is auto-generated -- do not edit

REM Set environment variables
${envVarsCommands}

REM Source environment and execute West
${debugServerCommand}
`;
      wrapperPath = path.join(buildDir, 'west_wrapper.bat');
      fs.writeFileSync(wrapperPath, wrapperScript);
      break;
    case 'powershell.exe':
      wrapperScript = `${envVarsCommands}

# Source environment and execute West
${debugServerCommand}
`;
      wrapperPath = path.join(buildDir, 'west_wrapper.ps1');
      fs.writeFileSync(wrapperPath, wrapperScript);
      break;
    default:
      break;
  }
}

export function createOpenocdCfg(project: ZephyrProject) {
  Openocd.createWorkaroundCfg(project.folderPath);
}

export async function setupPyOCDTarget(project: ZephyrProject, buildConfigName?: string) {
  let target;
  if(buildConfigName) {
    let buildConfig = project.getBuildConfiguration(buildConfigName);
    if(buildConfig) {
      target = buildConfig.getPyOCDTarget(project);
    }
  } else {
    // For legacy compatibility
    target = project.getPyOCDTarget();
  }
  
  if(target) { 
    if(!(await checkPyOCDTarget(target))) {
      await updatePyOCDPack();
      await installPyOCDTarget(target);
    }
  }
}

export async function createLaunchConfiguration(project: ZephyrProject, buildConfigName?: string): Promise<any> {
  const westWorkspace = getWestWorkspace(project.westWorkspacePath);
  const zephyrSDK = getZephyrSDK(project.sdkPath);
  let buildConfig: ZephyrProjectBuildConfiguration | undefined = undefined;
  let targetBoard: ZephyrBoard | undefined;
  let boardIdentifier = project.boardId;

  if(buildConfigName) {
    buildConfig = project.getBuildConfiguration(buildConfigName);
    if(buildConfig) {
      boardIdentifier = buildConfig.boardIdentifier;
    } else {
      resolve('Cannot find build configuration');
    }
  }

  const listBoards = await getSupportedBoards(westWorkspace, project, buildConfig);
  for(let board of listBoards) {
    if(board.identifier === boardIdentifier) {
      targetBoard = board;
    }
  }
  if(!targetBoard) {
    return;
  }

  const shell: string = getShell();
  let wrapperFile = '';
  switch (shell) {
    case 'bash': 
      wrapperFile = 'west_wrapper.sh';
      break;
    case 'cmd.exe':
      wrapperFile = 'west_wrapper.bat';
      break;
    case 'powershell.exe':
      wrapperFile = 'west_wrapper.ps1';
      break;
    default:
      wrapperFile = 'west_wrapper';
      break;
  }

  const targetArch = targetBoard.arch;
  let configName;
  let socToolchainName;
  let program;
  let wrapper;

  if(buildConfig) {
    configName = `Zephyr Workbench Debug [${buildConfig.name}]`;
    socToolchainName = buildConfig.getKConfigValue(project, 'SOC_TOOLCHAIN_NAME');
    program = path.join('${workspaceFolder}', `${buildConfig.relativeBuildDir}`, ZEPHYR_DIRNAME, ZEPHYR_APP_FILENAME);
    wrapper = path.join('${workspaceFolder}', `${buildConfig.relativeInternalDebugDir}`, `${wrapperFile}`);
  } else {
    // For legacy compatibility
    configName = `Zephyr Workbench Debug`;
    socToolchainName = project.getKConfigValue('SOC_TOOLCHAIN_NAME');
    program = path.join('${workspaceFolder}', 'build', '${config:zephyr-workbench.board}', ZEPHYR_DIRNAME, ZEPHYR_APP_FILENAME);
    wrapper = path.join('${workspaceFolder}', 'build', '.debug', '${config:zephyr-workbench.board}', `${wrapperFile}`);
  }
  
  const launchJson = {
    name: `${configName}`,
    type: "cppdbg",
    request: "launch",
    cwd: "${workspaceFolder}",
    program: `${program}`,
    args: [],
    stopAtEntry: true,
    svdPath: "",
    environment: [],
    externalConsole: false,
    serverLaunchTimeout: 30000,
    filterStderr: true,
    filterStdout: true,
    serverStarted: "",
    MIMode: "gdb",
    miDebuggerPath: `${zephyrSDK.getDebuggerPath(targetArch, socToolchainName)}`,
    debugServerPath: `${wrapper}`,
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

export async function createLaunchJson(project: ZephyrProject, buildConfigName?: string): Promise<any> {
  
  const launchJson : any = {
    version: "0.2.0",
    configurations: []
  };

  let config = await createLaunchConfiguration(project, buildConfigName);
  launchJson.configurations.push(config);

  return launchJson;
}

export async function readLaunchJson(project: ZephyrProject): Promise<any> {
  let launchJson = JSON.parse(await fs.promises.readFile(path.join(project.sourceDir, '.vscode', 'launch.json'), 'utf8'));
  return launchJson;
}

export function writeLaunchJson(launchJson: any, project: ZephyrProject) {
  fs.writeFileSync(path.join(project.sourceDir, '.vscode', 'launch.json'), JSON.stringify(launchJson, null, 2));
}

export async function findLaunchConfiguration(launchJson: any, project: ZephyrProject, buildConfigName?: string): Promise<any> {
  let debugConfigName: string;
  if(buildConfigName) {
    debugConfigName = `${ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME} [${buildConfigName}]`;
  } else {
    // For legacy compatibility
    debugConfigName = ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME;
  }

  for(let configuration of launchJson.configurations) {
    if(configuration.name === debugConfigName) {
      return configuration;
    }
  }
  
  launchJson.configurations.push(await createLaunchConfiguration(project, buildConfigName));
  return await findLaunchConfiguration(launchJson, project, buildConfigName);
}

export async function getLaunchConfiguration(project: ZephyrProject, buildConfigName?: string): Promise<[any, any]> {
  if(!fs.existsSync(path.join(project.sourceDir, '.vscode', 'launch.json'))) {
    writeLaunchJson(await createLaunchJson(project, buildConfigName), project);
  }

  let launchJson = await readLaunchJson(project);
  if(launchJson) {
    let configurationJson;
    if(buildConfigName) {
      configurationJson = await findLaunchConfiguration(launchJson, project, buildConfigName);
    } else {
      configurationJson = await findLaunchConfiguration(launchJson, project);
    }
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