import fs from 'fs';
import path, { resolve } from 'path';
import * as vscode from 'vscode';
import { ZEPHYR_APP_FILENAME, ZEPHYR_DIRNAME, ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from "../constants";
import { Linkserver } from "../debug/runners/Linkserver";
import { Openocd } from "../debug/runners/Openocd";
import { WestRunner } from "../debug/runners/WestRunner";
import { checkPyOCDTarget, concatCommands, getShell, getShellSourceCommand, installPyOCDTarget, updatePyOCDPack } from './execUtils';
import { ZephyrProject } from "../models/ZephyrProject";
import { ZephyrAppProject } from "../models/ZephyrAppProject";
import { getSupportedBoards, getWestWorkspace, getZephyrSDK, deleteFolder } from './utils';
import { STM32CubeProgrammer } from '../debug/runners/STM32CubeProgrammer';
import { Nrfutil } from '../debug/runners/Nrfutil';
import { Nrfjprog } from '../debug/runners/Nrfjprog';
import { SimplicityCommander } from '../debug/runners/SimplicityCommander';
import { JLink } from '../debug/runners/JLink';
import { PyOCD } from '../debug/runners/PyOCD';
import { ZephyrBoard } from '../models/ZephyrBoard';
import { ZephyrProjectBuildConfiguration } from '../models/ZephyrProjectBuildConfiguration';
import { execWestCommandWithEnv, execWestCommandWithEnvAsync } from '../commands/WestCommands';

export const ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME = 'Zephyr Workbench Debug';

export function getDebugRunners(): WestRunner[] {
  return [ 
    new Openocd(), 
    new Linkserver(),
    new JLink(),
    new PyOCD()
  ];
}

// Static list of flash-capable runners to use for task inputs
// and as a fallback when discovery fails. Order matches existing
// tasks.json options for predictability.
export function getStaticFlashRunnerNames(): string[] {
  return [
    'arc-nsim',
    'blackmagicprobe',
    'bossac',
    'canopen_program',
    'dediprog',
    'dfu-util',
    'esp32',
    'ezflashcli',
    'gd32isp',
    'hifive1',
    'intel_adsp',
    'intel_cyclonev',
    'jlink',
    'linkserver',
    'mdb-hw',
    'mdb-nsim',
    'misc-flasher',
    'nios2',
    'nrfjprog',
    'nrfutil',
    'nsim',
    'nxp_s32dbg',
    'openocd',
    'pyocd',
    'qemu',
    'renode-robot',
    'renode',
    'silabs_commander',
    'spi_burn',
    'stm32cubeprogrammer',
    'stm32flash',
    'teensy',
    'trace32',
    'uf2',
    'xtensa',
    'ecpprog',
    'minichlink',
    'probe_rs',
    'native',
    'xsdb'
  ];
}

export function getRunRunners(): WestRunner[] {
  return [ 
    new Openocd(), 
    new Linkserver(),
    new STM32CubeProgrammer(),
    new JLink(),
    new PyOCD(),
    new Nrfutil(),
    new Nrfjprog(),
    new SimplicityCommander()
  ];
}

/**
 * Query west to get flash-capable runners and those available in runners.yaml for a given build config.
 * Runs with --build-dir and --board, using a temporary build dir if the main one doesn't exist.
 */
export async function getFlashRunners(
  project: ZephyrAppProject,
  config: ZephyrProjectBuildConfiguration
): Promise<{ all: string[]; available: string[]; def?: string; output: string }>
{
  return new Promise((resolve, reject) => {
    // Always use a temporary build directory for help query; avoids touching real build artifacts
    const buildDir = path.join(project.folderPath, '.tmp', 'flash-runners', config.name);
    try { fs.mkdirSync(buildDir, { recursive: true }); } catch {}

    // 1) Ensure runner properties are generated for this build dir
    //    Use dedicated target runners_yaml_props_target then query help
    const westArgs = (config.westArgs && config.westArgs.length > 0) ? ` ${config.westArgs}` : '';
    const buildCmd = `west build -t runners_yaml_props_target --board ${config.boardIdentifier} --build-dir "${buildDir}" "${project.folderPath}"${westArgs}`;
    const helpCmd  = `west flash -H --board ${config.boardIdentifier} --build-dir "${buildDir}" "${project.folderPath}"`;

    execWestCommandWithEnvAsync(buildCmd, project)
      .then(() => {
        execWestCommandWithEnv(helpCmd, project, (err, stdout) => {
          if (err) { deleteFolder(buildDir); deleteFolder(path.join(project.folderPath, '.tmp')); return reject(err); }

      const lines = stdout.split(/\r?\n/).map(l => l.trim());
      const pickList: string[] = [];
      const available: string[] = [];
      let def: string | undefined = undefined;

      // Extract block under: zephyr runners which support "west flash":
      const headerIdx = lines.findIndex(l => l.toLowerCase().startsWith('zephyr runners which support') && l.includes('west flash'));
      if (headerIdx !== -1) {
        for (let i = headerIdx + 1; i < lines.length; i++) {
          const l = lines[i];
          if (l.length === 0 || l.toLowerCase().startsWith('note:') || l.toLowerCase().startsWith('available runners')) {
            break;
          }
          l.split(',').map(s => s.trim()).filter(s => s.length > 0).forEach(s => pickList.push(s));
        }
      }

      // Extract available runners in runners.yaml:
      const availIdx = lines.findIndex(l => l.toLowerCase().startsWith('available runners in runners.yaml'));
      if (availIdx !== -1) {
        for (let i = availIdx + 1; i < lines.length; i++) {
          const l = lines[i];
          if (l.length === 0 || l.endsWith(':')) { break; }
          l.split(',').map(s => s.trim()).filter(s => s.length > 0).forEach(s => available.push(s));
        }
      }

      // Extract default runner in runners.yaml:
      const defIdx = lines.findIndex(l => l.toLowerCase().startsWith('default runner in runners.yaml'));
      if (defIdx !== -1 && defIdx + 1 < lines.length) {
        const v = lines[defIdx + 1].trim();
        def = v.split(',')[0].trim();
      }

          // De-duplicate and basic validation
          const all = Array.from(new Set(pickList));
          if (all.length === 0 && available.length === 0) {
            deleteFolder(buildDir);
            deleteFolder(path.join(project.folderPath, '.tmp'));
            return reject(new Error('No flash runners were found for this configuration.'));
          }
          deleteFolder(buildDir);
          deleteFolder(path.join(project.folderPath, '.tmp'));
          resolve({ all, available, def, output: stdout });
        });
      })
      .catch((e) => { deleteFolder(buildDir); deleteFolder(path.join(project.folderPath, '.tmp')); reject(e); });
  });
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
    case 'nrfutil':
      return new Nrfutil();
    case 'nrfjprog':
      return new Nrfjprog();
    case 'simplicity_commander':
      return new SimplicityCommander();
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

  let envVars = {
    ...westWorkspace.buildEnv,
  };

  if(buildConfig) {
    envVars = { ...envVars, ...buildConfig.envVars };
    // To uncomment when args VS build args are supported
    // if(buildConfig.westArgs) {
    //   westCmd = `${westCmd} ${buildConfig.westArgs}`;
    // }
  }

  const cmdEnv = getShellSourceCommand(shell, envScript);
  const debugServerCommand = concatCommands(shell, cmdEnv, westCmd);

  let envVarsCommands = '';
  for (const [key, value] of Object.entries(envVars)) {
    if(key === null || key === undefined || value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) 
    {
      continue;
    }
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
  } 

  if(target) { 
    if(!(await checkPyOCDTarget(target))) {
      await updatePyOCDPack();
      await installPyOCDTarget(target);
    }
  }
  else {
    vscode.window.showErrorMessage('Target not compatible with PyOCD. Please select a valid target in the build configuration.');
    return;
  }
}

export async function createLaunchConfiguration(project: ZephyrProject, buildConfigName?: string): Promise<any> {
  const westWorkspace = getWestWorkspace(project.westWorkspacePath);
  const zephyrSDK = getZephyrSDK(project.sdkPath);
  let buildConfig: ZephyrProjectBuildConfiguration | undefined = undefined;
  let targetBoard: ZephyrBoard | undefined;
  let boardIdentifier;

  if(buildConfigName) {
    buildConfig = project.getBuildConfiguration(buildConfigName);
    if(buildConfig) {
      boardIdentifier = buildConfig.boardIdentifier;
    } else {
      resolve('Cannot find build configuration');
    }
  }

  const listBoards = await getSupportedBoards(westWorkspace, project, buildConfig);
  // boardIdentifier may be hierarchical like X/Y/Z; fallback to X/Y then X
  if (boardIdentifier) {
    let candidate = String(boardIdentifier);
    while (candidate.length > 0) {
      const found = listBoards.find(b => b.identifier === candidate);
      if (found) { targetBoard = found; break; }
      const lastSlash = candidate.lastIndexOf('/');
      if (lastSlash === -1) {break;}
      candidate = candidate.substring(0, lastSlash);
    }
  }
  if(!targetBoard) {
    // Warn the user and throw to prevent pushing an invalid configuration
    try {
      vscode.window.showWarningMessage('Zephyr Workbench: Board was not automatically detected.');
    } catch {}
    throw new Error('createLaunchConfiguration: target board not found');
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

  if (buildConfig) {
    configName = `Zephyr Workbench Debug [${buildConfig.name}]`;
    socToolchainName = buildConfig.getKConfigValue(project, 'SOC_TOOLCHAIN_NAME');

    const workspacePath = project.workspaceFolder.uri.fsPath;
    const buildFolderPath = path.join(workspacePath, buildConfig.relativeBuildDir);
    const appFolderName = project.workspaceContext.name;
    const appNameDir = path.join(buildFolderPath, appFolderName);

    if (fs.existsSync(appNameDir)) {
      program = path.join('${workspaceFolder}', buildConfig.relativeBuildDir, appFolderName, ZEPHYR_DIRNAME, ZEPHYR_APP_FILENAME);
    } else {
      program = path.join('${workspaceFolder}', buildConfig.relativeBuildDir, ZEPHYR_DIRNAME, ZEPHYR_APP_FILENAME);
    }
    wrapper = path.join('${workspaceFolder}', buildConfig.relativeInternalDebugDir, wrapperFile);
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
      { 
        text: "-interpreter-exec console \"monitor reset\"", 
        ignoreFailures: false 
      },
      { 
        text: "-target-download", "description": "flash target", 
        ignoreFailures: false 
      },
      { 
        text: "set breakpoint pending on", 
        description: "Set pending", 
        ignoreFailures: false 
      },
      { 
        text: "tbreak main", 
        description: "Set a breakpoint at main", 
        ignoreFailures: true 
      }
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
    debugConfigName = ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME;
  }

  for(let configuration of launchJson.configurations) {
    if(configuration.name === debugConfigName) {
      return configuration;
    }
  }
  // Create and push a new configuration only if valid
  let newCfg: any;
  try {
    newCfg = await createLaunchConfiguration(project, buildConfigName);
  } catch (err) {
    console.error('[DebugManager] findLaunchConfiguration: failed to create configuration', err);
    // Propagate error; do not push invalid entry
    throw err;
  }
  if (!newCfg || typeof newCfg !== 'object' || typeof newCfg.name !== 'string') {
    console.error('[DebugManager] findLaunchConfiguration: createLaunchConfiguration returned invalid config', newCfg);
    throw new Error('createLaunchConfiguration returned invalid configuration');
  }
  launchJson.configurations.push(newCfg);
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
