import fs from 'fs';
import path from 'path';
import * as vscode from 'vscode';
import yaml from 'yaml';
import { ZEPHYR_APP_FILENAME, ZEPHYR_DIRNAME, ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY, ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY, ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from "../../constants";
import { Linkserver } from "../../debug/runners/Linkserver";
import { Openocd } from "../../debug/runners/Openocd";
import { WestRunner } from "../../debug/runners/WestRunner";
import { checkPyOCDTarget, concatCommands, getShell, getShellSourceCommand, installPyOCDTarget, updatePyOCDPack } from '../execUtils';
import { ZephyrApplication } from "../../models/ZephyrApplication";
import { findBoardByHierarchicalIdentifier, getSupportedBoards } from '../zephyr/boardDiscovery';
import { findArmGnuToolchainInstallation, getWestWorkspace, deleteFolder, fileExists, tryGetZephyrSdkInstallation } from '../utils';
import { STM32CubeProgrammer } from '../../debug/runners/STM32CubeProgrammer';
import { StlinkGdbserver } from '../../debug/runners/StlinkGdbserver';
import { Nrfutil } from '../../debug/runners/Nrfutil';
import { Nrfjprog } from '../../debug/runners/Nrfjprog';
import { SimplicityCommander } from '../../debug/runners/SimplicityCommander';
import { JLink } from '../../debug/runners/JLink';
import { PyOCD } from '../../debug/runners/PyOCD';
import { ZephyrBoard } from '../../models/ZephyrBoard';
import { ZephyrBuildConfig } from '../../models/ZephyrBuildConfig';
import { execWestCommandWithEnv, execWestCommandWithEnvAsync, westTmpBuildCmakeOnlyCommand } from '../../commands/WestCommands';
import { ParsedRunnersYaml, findRunnersYamlForProject, getRunnerPathFromRunnersYaml, readRunnersYamlFile, readRunnersYamlForBuildDir, readRunnersYamlForProject } from '../zephyr/runnersYamlUtils';
import { composeWestBuildArgs } from '../zephyr/westArgUtils';
import { mergeOpenocdBuildFlag } from './debugToolSelectionUtils';
import { normalizeStoredToolchainVariant } from '../toolchainSelection';

export const ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME = 'Zephyr Workbench Debug';

interface LaunchConfigurationArtifacts {
  compatibleRunners: string[];
  defaultDebugRunner?: string;
  generatedGdbPath?: string;
  generatedOpenocdPath?: string;
  targetBoard?: ZephyrBoard;
}

/**
 * Auto-detect the SVD file path for STM32 boards using STM32CubeCLT.
 * Returns the SVD path if found, empty string otherwise.
 */
export function autoDetectSvdPath(board: ZephyrBoard): string {
  // Only for ST boards
  if (!board.vendor || board.vendor.toLowerCase() !== 'st') {
    return '';
  }

  // Get SoC name from board.yml
  const socName = board.getSocName();
  if (!socName) {
    return '';
  }

  // Process SoC name: remove trailing "xx" and convert to uppercase
  const processed = socName.replace(/xx$/i, '').toUpperCase();

  // Locate STM32CubeCLT installation
  const stlink = new StlinkGdbserver();
  const cubeCLTVersion = stlink.getVersionCubeCLT();
  if (!cubeCLTVersion) {
    return '';
  }

  // Construct CubeCLT base path
  const root = process.platform === 'win32' ? 'C:\\ST' :
               process.platform === 'darwin' ? '/opt/ST' : '/opt/st';
  const cubeCLTPath = path.join(root, `STM32CubeCLT_${cubeCLTVersion}`);

  // Construct SVD file path
  const svdFilePath = path.join(cubeCLTPath, 'STMicroelectronics_CMSIS_SVD', `${processed}.svd`);

  // Check if file exists
  if (fs.existsSync(svdFilePath)) {
    return svdFilePath;
  }

  return '';
}

export function getDebugRunners(): WestRunner[] {
  return [ 
    new Openocd(), 
    new Linkserver(),
    new JLink(),
    new PyOCD(),
    new StlinkGdbserver()
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

function getExistingRunnersYamlPath(
  project: ZephyrApplication,
  config: ZephyrBuildConfig
): string | undefined {
  return findRunnersYamlForProject(project, config);
}

function parseFlashRunnersFromYaml(runnersYamlPath: string): { all: string[]; available: string[]; def?: string; output: string } | undefined {
  const runnersYaml = readRunnersYamlFile(runnersYamlPath);
  if (!runnersYaml || runnersYaml.runners.length === 0) {
    return undefined;
  }

  return {
    all: runnersYaml.runners,
    available: runnersYaml.runners,
    def: runnersYaml.defaultFlashRunner,
    output: runnersYaml.raw,
  };
}

function findBoardYamlInDir(boardDir: string, boardIdentifier?: string): string | undefined {
  if (!boardDir || !fs.existsSync(boardDir)) {
    return undefined;
  }

  const yamlFiles = fs.readdirSync(boardDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.yaml'))
    .map(entry => path.join(boardDir, entry.name));

  if (yamlFiles.length === 0) {
    return undefined;
  }

  if (boardIdentifier) {
    for (const yamlFile of yamlFiles) {
      try {
        const data = yaml.parse(fs.readFileSync(yamlFile, 'utf8'));
        if (data?.identifier === boardIdentifier) {
          return yamlFile;
        }
      } catch {
        // Ignore malformed board yaml and keep scanning candidates.
      }
    }
  }

  return yamlFiles[0];
}

function getBuildArtifactCandidates(buildDir: string, appFolderName: string | undefined, ...segments: string[]): string[] {
  const candidates: string[] = [];

  if (appFolderName && appFolderName.length > 0) {
    candidates.push(path.join(buildDir, appFolderName, ...segments));
  }
  candidates.push(path.join(buildDir, ...segments));

  return candidates;
}

function getFirstExistingBuildArtifact(buildDir: string, appFolderName: string | undefined, ...segments: string[]): string | undefined {
  return getBuildArtifactCandidates(buildDir, appFolderName, ...segments).find(candidate => fileExists(candidate));
}

function parseGdbPathFromCMakeCache(cmakeCachePath: string): string | undefined {
  try {
    const cacheText = fs.readFileSync(cmakeCachePath, 'utf8');
    const match = cacheText.match(/^CMAKE_GDB(?::[A-Z]+)?=(.+)$/m);
    return match?.[1]?.trim().length ? match[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeSdkRelativeDetectedPath(detectedPath: string, sdkPath: string): string {
  const strippedDetectedPath = detectedPath.trim().replace(/^"(.*)"$/, '$1');
  const normalizedDetectedPath = path.normalize(strippedDetectedPath);
  const normalizedSdkPath = path.normalize(sdkPath);

  const compareDetectedPath = process.platform === 'win32'
    ? normalizedDetectedPath.toLowerCase()
    : normalizedDetectedPath;
  const compareSdkPath = process.platform === 'win32'
    ? normalizedSdkPath.toLowerCase()
    : normalizedSdkPath;

  const pathIsInsideSdk =
    compareDetectedPath === compareSdkPath ||
    compareDetectedPath.startsWith(`${compareSdkPath}${path.sep}`);

  if (!pathIsInsideSdk) {
    return strippedDetectedPath;
  }

  const relativePath = path.relative(normalizedSdkPath, normalizedDetectedPath);
  if (!relativePath || relativePath === '.') {
    return '${config:zephyr-workbench.sdk}';
  }

  const separator = process.platform === 'win32' ? '\\' : '/';
  const relativeSegments = relativePath.split(/[\\/]+/).filter(segment => segment.length > 0);
  return ['${config:zephyr-workbench.sdk}', ...relativeSegments].join(separator);
}

function resolveBoardFromRunnersYaml(runnersYaml: ParsedRunnersYaml | undefined, boardIdentifier?: string): ZephyrBoard | undefined {
  if (!runnersYaml) {
    return undefined;
  }

  for (const boardDir of runnersYaml.boardDirCandidates) {
    const boardYamlPath = findBoardYamlInDir(boardDir, boardIdentifier);
    if (boardYamlPath) {
      return new ZephyrBoard(vscode.Uri.file(boardYamlPath));
    }
  }

  return undefined;
}

function resolveGeneratedArtifactsFromBuildDir(
  buildDir: string,
  appFolderName: string | undefined,
  boardIdentifier?: string,
): LaunchConfigurationArtifacts {
  const runnersYaml = readRunnersYamlForBuildDir(buildDir, appFolderName);
  let generatedGdbPath = runnersYaml?.gdbPath;

  if (!generatedGdbPath) {
    const cmakeCachePath = getFirstExistingBuildArtifact(buildDir, appFolderName, 'CMakeCache.txt');
    if (cmakeCachePath) {
      generatedGdbPath = parseGdbPathFromCMakeCache(cmakeCachePath);
    }
  }

  return {
    compatibleRunners: runnersYaml?.runners ?? [],
    defaultDebugRunner: runnersYaml?.defaultDebugRunner,
    generatedGdbPath,
    generatedOpenocdPath: getRunnerPathFromRunnersYaml(runnersYaml, 'openocd'),
    targetBoard: resolveBoardFromRunnersYaml(runnersYaml, boardIdentifier),
  };
}

export function getDefaultDebugRunner(
  project: ZephyrApplication,
  buildConfig: ZephyrBuildConfig
): string | undefined {
  return readRunnersYamlForProject(project, buildConfig)?.defaultDebugRunner;
}

async function collectLaunchConfigurationArtifacts(
  project: ZephyrApplication,
  buildConfig: ZephyrBuildConfig,
  westWorkspace: ReturnType<typeof getWestWorkspace>,
): Promise<LaunchConfigurationArtifacts> {
  const appFolderName = project.appWorkspaceFolder?.name;
  const buildDir = buildConfig.getBuildDir(project);
  const boardIdentifier = buildConfig.boardIdentifier;
  let {
    targetBoard,
    generatedGdbPath,
    compatibleRunners,
    defaultDebugRunner,
    generatedOpenocdPath,
  } = resolveGeneratedArtifactsFromBuildDir(buildDir, appFolderName, boardIdentifier);
  let tmpBuildDir: string | undefined;

  try {
    if ((!targetBoard || !generatedGdbPath || compatibleRunners.length === 0 || !defaultDebugRunner || !generatedOpenocdPath) && !fileExists(buildDir)) {
      tmpBuildDir = await westTmpBuildCmakeOnlyCommand(project, westWorkspace, buildConfig);
      if (tmpBuildDir) {
        const generatedArtifacts = resolveGeneratedArtifactsFromBuildDir(tmpBuildDir, appFolderName, boardIdentifier);
        targetBoard = targetBoard ?? generatedArtifacts.targetBoard;
        generatedGdbPath = generatedGdbPath ?? generatedArtifacts.generatedGdbPath;
        if (compatibleRunners.length === 0) {
          compatibleRunners = generatedArtifacts.compatibleRunners;
        }
        defaultDebugRunner = defaultDebugRunner ?? generatedArtifacts.defaultDebugRunner;
        generatedOpenocdPath = generatedOpenocdPath ?? generatedArtifacts.generatedOpenocdPath;
      }
    }

    if (!targetBoard) {
      const listBoards = await getSupportedBoards(westWorkspace, project, buildConfig, tmpBuildDir);
      if (boardIdentifier) {
        targetBoard = findBoardByHierarchicalIdentifier(boardIdentifier, listBoards);
      }
    }

    if (compatibleRunners.length === 0 && targetBoard) {
      compatibleRunners = targetBoard.getCompatibleRunners();
    }

    return {
      compatibleRunners,
      defaultDebugRunner,
      generatedGdbPath,
      generatedOpenocdPath,
      targetBoard,
    };
  } finally {
    if (tmpBuildDir) {
      deleteFolder(tmpBuildDir);
    }
  }
}

/**
 * Query west to get flash-capable runners and those available in runners.yaml for a given build config.
 * Runs with --build-dir and --board, using a temporary build dir if the main one doesn't exist.
 */
export async function getFlashRunners(
  project: ZephyrApplication,
  config: ZephyrBuildConfig
): Promise<{ all: string[]; available: string[]; def?: string; output: string }>
{
  const existingRunnersYamlPath = getExistingRunnersYamlPath(project, config);
  if (existingRunnersYamlPath) {
    const parsed = parseFlashRunnersFromYaml(existingRunnersYamlPath);
    if (parsed) {
      return parsed;
    }
  }

  return new Promise((resolve, reject) => {
    // Always use a temporary build directory for help query; avoids touching real build artifacts
    const buildDir = path.join(project.appRootPath, '.tmp', 'flash-runners', config.name);
    try { fs.mkdirSync(buildDir, { recursive: true }); } catch {}

    // 1) Ensure runner properties are generated for this build dir
    //    Use dedicated target runners_yaml_props_target then query help
    const composedWestArgs = composeWestBuildArgs(config.westArgs, mergeOpenocdBuildFlag(project, config.westArgs, config.westFlagsD));
    const westArgs = composedWestArgs.length > 0 ? ` ${composedWestArgs}` : '';
    const buildCmd = `west build -t runners_yaml_props_target --board ${config.boardIdentifier} --build-dir "${buildDir}" "${project.appRootPath}"${westArgs}`;
    const helpCmd  = `west flash -H --board ${config.boardIdentifier} --build-dir "${buildDir}" "${project.appRootPath}"`;

    execWestCommandWithEnvAsync(buildCmd, project)
      .then(() => {
        execWestCommandWithEnv(helpCmd, project, (err, stdout) => {
          if (err) { deleteFolder(buildDir); deleteFolder(path.join(project.appRootPath, '.tmp')); return reject(err); }

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
            deleteFolder(path.join(project.appRootPath, '.tmp'));
            return reject(new Error('No flash runners were found for this configuration.'));
          }
          deleteFolder(buildDir);
          deleteFolder(path.join(project.appRootPath, '.tmp'));
          resolve({ all, available, def, output: stdout });
        });
      })
      .catch((e) => { deleteFolder(buildDir); deleteFolder(path.join(project.appRootPath, '.tmp')); reject(e); });
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
    case 'stlink_gdbserver':
      return new StlinkGdbserver();
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

export function createWestWrapper(project: ZephyrApplication, buildConfigName?: string) {
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
  
  const westWorkspace = getWestWorkspace(project.westWorkspaceRootPath);
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

export function createOpenocdCfg(project: ZephyrApplication) {
  Openocd.createWorkaroundCfg(project.appRootPath);
}

export async function setupPyOCDTarget(project: ZephyrApplication, buildConfigName?: string) {
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

export async function createLaunchConfiguration(
  project: ZephyrApplication,
  buildConfigName?: string,
  artifacts?: LaunchConfigurationArtifacts,
): Promise<any> {
  const westWorkspace = getWestWorkspace(project.westWorkspaceRootPath);
  const cfg = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, project.appWorkspaceFolder);
  const toolchainVariant = normalizeStoredToolchainVariant(cfg, cfg.get<string>(ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY) ?? 'zephyr');
  const zephyrSdkInstallation = tryGetZephyrSdkInstallation(project.zephyrSdkPath);
  const armGnuToolchainInstallation = toolchainVariant === 'gnuarmemb'
    ? findArmGnuToolchainInstallation(cfg.get<string>(ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY, ''))
    : undefined;
  let buildConfig: ZephyrBuildConfig | undefined = undefined;
  let targetBoard: ZephyrBoard | undefined;
  let generatedGdbPath: string | undefined;

  if(buildConfigName) {
    buildConfig = project.getBuildConfiguration(buildConfigName);
    if(!buildConfig) {
      throw new Error(`Cannot find build configuration: ${buildConfigName}`);
    }
  }

  if (buildConfig) {
    const resolvedArtifacts = artifacts ?? await collectLaunchConfigurationArtifacts(project, buildConfig, westWorkspace);
    targetBoard = resolvedArtifacts.targetBoard;
    generatedGdbPath = resolvedArtifacts.generatedGdbPath;
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

    const workspacePath = project.appWorkspaceFolder.uri.fsPath;
    const buildFolderPath = path.join(workspacePath, buildConfig.relativeBuildDir);
    const appFolderName = project.appWorkspaceFolder.name;
    const appNameDir = path.join(buildFolderPath, appFolderName);

    if (fs.existsSync(appNameDir)) {
      program = path.join('${workspaceFolder}', buildConfig.relativeBuildDir, appFolderName, ZEPHYR_DIRNAME, ZEPHYR_APP_FILENAME);
    } else {
      program = path.join('${workspaceFolder}', buildConfig.relativeBuildDir, ZEPHYR_DIRNAME, ZEPHYR_APP_FILENAME);
    }
    wrapper = path.join('${workspaceFolder}', buildConfig.relativeInternalDebugDir, wrapperFile);
  }

  // Auto-detect SVD for STM32 boards (best effort)
  let svdPath = '';
  if (targetBoard) {
    svdPath = autoDetectSvdPath(targetBoard);
  }
  
  const launchJson = {
    name: `${configName}`,
    type: "cppdbg",
    request: "launch",
    cwd: "${workspaceFolder}",
    program: `${program}`,
    args: [],
    stopAtEntry: true,
    svdPath: svdPath,
    environment: [],
    externalConsole: false,
    serverLaunchTimeout: 30000,
    filterStderr: true,
    filterStdout: true,
    serverStarted: "",
    MIMode: "gdb",
    miDebuggerPath: `${armGnuToolchainInstallation?.debuggerPath ?? zephyrSdkInstallation?.getDebuggerPath(targetArch, socToolchainName) ?? ''}`,
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

  launchJson.miDebuggerPath = generatedGdbPath
    ? (project.zephyrSdkPath ? normalizeSdkRelativeDetectedPath(generatedGdbPath, project.zephyrSdkPath) : generatedGdbPath)
    : `${armGnuToolchainInstallation?.debuggerPath ?? zephyrSdkInstallation?.getDebuggerPath(targetArch, socToolchainName) ?? ''}`;

  return launchJson;
}

export async function createLaunchJson(
  project: ZephyrApplication,
  buildConfigName?: string,
  artifacts?: LaunchConfigurationArtifacts,
): Promise<any> {
  
  const launchJson : any = {
    version: "0.2.0",
    configurations: []
  };

  let config = await createLaunchConfiguration(project, buildConfigName, artifacts);
  launchJson.configurations.push(config);

  return launchJson;
}

export async function readLaunchJson(project: ZephyrApplication): Promise<any | undefined> {
  // launch.json may exist as an empty placeholder (created by VS Code when the
  // user opens the Run/Debug view) or contain malformed JSON. Treat both as
  // "no usable config" so callers can fall back to creating a fresh one,
  // instead of crashing with "Unexpected end of JSON input".
  const raw = await fs.promises.readFile(path.join(project.appRootPath, '.vscode', 'launch.json'), 'utf8');
  if (raw.trim().length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function writeLaunchJson(launchJson: any, project: ZephyrApplication) {
  fs.writeFileSync(path.join(project.appRootPath, '.vscode', 'launch.json'), JSON.stringify(launchJson, null, 2));
}

export function pyocdLaunchJson(
  config: any,
  gdbAddress?: string,
  gdbPort?: string
): any {
  const serverAddress = (gdbAddress && gdbAddress.length > 0) ? gdbAddress : 'localhost';
  const serverPort = (gdbPort && gdbPort.length > 0) ? gdbPort : '3333';
  const {
    miDebuggerServerAddress: _ignored,
    serverStarted,
    miDebuggerPath,
    debugServerPath,
    debugServerArgs,
    logging,
    ...beforeServerAddress
  } = config;

  return {
    ...beforeServerAddress,
    serverStarted: serverStarted,
    miDebuggerServerAddress: `${serverAddress}:${serverPort}`,
    miDebuggerPath,
    debugServerPath,
    debugServerArgs,
    setupCommands: [
      {
        text: '-enable-pretty-printing',
        description: 'Enable pretty printing',
        ignoreFailures: true,
      },
      {
        text: 'monitor reset halt',
        description: 'Reset and halt',
        ignoreFailures: true,
      },
      {
        text: 'set breakpoint pending on',
        description: 'Set pending',
        ignoreFailures: false,
      },
      {
        text: 'tbreak main',
        description: 'Set a breakpoint at main',
        ignoreFailures: true,
      },
    ],
    logging,
  };
}

export async function findLaunchConfiguration(
  launchJson: any,
  project: ZephyrApplication,
  buildConfigName?: string,
  artifacts?: LaunchConfigurationArtifacts,
): Promise<any> {
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
    newCfg = await createLaunchConfiguration(project, buildConfigName, artifacts);
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

export async function getLaunchConfiguration(
  project: ZephyrApplication,
  buildConfigName?: string,
  createIfMissing: boolean = false,
  artifacts?: LaunchConfigurationArtifacts,
): Promise<[any, any]> {
  let launchJson: any;
  const launchPath = path.join(project.appRootPath, '.vscode', 'launch.json');

  if (fs.existsSync(launchPath)) {
    launchJson = await readLaunchJson(project);
  }
  // Fall back to a fresh in-memory launch.json when the file is missing,
  // empty, or unparseable — `readLaunchJson` returns undefined in those cases.
  if (!launchJson) {
    launchJson = await createLaunchJson(project, buildConfigName, artifacts);
    // skip writing to avoid creating launch.json on selection too debug
  }

  if (launchJson) {
    let configurationJson;
    if (buildConfigName) {
      configurationJson = await findLaunchConfiguration(launchJson, project, buildConfigName, artifacts);
    } else {
      configurationJson = await findLaunchConfiguration(launchJson, project, undefined, artifacts);
    }
    return [launchJson, configurationJson];
  }
  return [undefined, undefined];
}

export async function getDebugManagerLaunchConfiguration(
  project: ZephyrApplication,
  buildConfig: ZephyrBuildConfig,
): Promise<[any, any, string[], string | undefined, string | undefined]> {
  const westWorkspace = getWestWorkspace(project.westWorkspaceRootPath);
  const artifacts = await collectLaunchConfigurationArtifacts(project, buildConfig, westWorkspace);
  const [launchJson, config] = await getLaunchConfiguration(project, buildConfig.name, false, artifacts);
  return [launchJson, config, artifacts.compatibleRunners, artifacts.defaultDebugRunner, artifacts.generatedOpenocdPath];
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
