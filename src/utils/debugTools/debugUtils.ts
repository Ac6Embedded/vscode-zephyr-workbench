import fs from 'fs';
import path from 'path';
import * as vscode from 'vscode';
import yaml from 'yaml';
import { ZEPHYR_APP_FILENAME, ZEPHYR_DIRNAME, ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from "../../constants";
import { Linkserver } from "../../debug/runners/Linkserver";
import { Openocd } from "../../debug/runners/Openocd";
import { WestRunner } from "../../debug/runners/WestRunner";
import { checkPyOCDTarget, concatCommands, getConfiguredWorkbenchPath, getShell, getShellSourceCommand, installPyOCDTarget, updatePyOCDPack } from '../execUtils';
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

export const ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME = 'Zephyr Workbench Debug';
const LEGACY_ZEPHYR_WORKBENCH_DEBUG_APP_ROOT_KEY = 'zephyrWorkbenchAppRoot';
const ZEPHYR_SDK_CONFIG_VARIABLE = '${config:zephyr-workbench.sdk}';
const WORKSPACE_APPLICATION_DEBUG_CONFIG_SEPARATOR = ': ';

interface LaunchConfigurationArtifacts {
  compatibleRunners: string[];
  defaultDebugRunner?: string;
  generatedGdbPath?: string;
  generatedOpenocdPath?: string;
  targetBoard?: ZephyrBoard;
}

interface LaunchConfigurationPaths {
  cwd: string;
  program: string;
  debugServerPath: string;
  workspaceRelativeBuildDir: string;
}

function getWorkspaceApplicationDebugName(project: ZephyrApplication): string {
  const relativePath = path
    .relative(project.appWorkspaceFolder.uri.fsPath, project.appRootPath)
    .replace(/\\/g, '/');

  return relativePath && relativePath !== '.' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
    ? relativePath
    : project.appName;
}

export function getDebugLaunchConfigurationName(
  project: ZephyrApplication,
  buildConfigName?: string,
): string {
  if (!project.isWestWorkspaceApplication) {
    return getFreestandingDebugLaunchConfigurationName(buildConfigName);
  }

  // West workspace apps share one launch.json. Include the app path relative to
  // the west workspace so same-named multibuild configs from different apps
  // remain distinct and can be resolved from VS Code's Run dropdown.
  const buildConfigSuffix = buildConfigName ? ` [${buildConfigName}]` : '';
  return `${ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME}${WORKSPACE_APPLICATION_DEBUG_CONFIG_SEPARATOR}${getWorkspaceApplicationDebugName(project)}${buildConfigSuffix}`;
}

function getFreestandingDebugLaunchConfigurationName(buildConfigName?: string): string {
  return `${ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME}${buildConfigName ? ` [${buildConfigName}]` : ''}`;
}

function stripTrailingBuildConfigSuffix(configName: string): string {
  return configName.replace(/\s+\[[^\]]+\]\s*$/, '').trim();
}

export function extractDebugBuildConfigName(configName: string): string | undefined {
  const match = configName.match(/\[([^\]]+)\]\s*$/);
  return match ? match[1] : undefined;
}

export function extractWorkspaceApplicationPathFromDebugConfigName(configName: string): string | undefined {
  const prefix = `${ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME}${WORKSPACE_APPLICATION_DEBUG_CONFIG_SEPARATOR}`;
  if (!configName.startsWith(prefix)) {
    return undefined;
  }

  const appPath = stripTrailingBuildConfigSuffix(configName.slice(prefix.length));
  return appPath.length > 0 ? appPath : undefined;
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

function isCMakeNotFoundPath(value: string): boolean {
  return value.trim().replace(/^"(.*)"$/, '$1').endsWith('-NOTFOUND');
}

function normalizeDetectedGdbPath(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const strippedValue = value.trim().replace(/^"(.*)"$/, '$1');
  return strippedValue.length > 0 && !isCMakeNotFoundPath(strippedValue)
    ? strippedValue
    : undefined;
}

function parseGdbPathFromCMakeCache(cmakeCachePath: string): string | undefined {
  try {
    const cacheText = fs.readFileSync(cmakeCachePath, 'utf8');
    const match = cacheText.match(/^CMAKE_GDB(?::[A-Z]+)?=(.+)$/m);
    return normalizeDetectedGdbPath(match?.[1]);
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
    return ZEPHYR_SDK_CONFIG_VARIABLE;
  }

  const separator = process.platform === 'win32' ? '\\' : '/';
  const relativeSegments = relativePath.split(/[\\/]+/).filter(segment => segment.length > 0);
  return [ZEPHYR_SDK_CONFIG_VARIABLE, ...relativeSegments].join(separator);
}

function resolveSdkConfigVariablePath(value: string, sdkPath: string): string {
  return path.normalize(value.replace(ZEPHYR_SDK_CONFIG_VARIABLE, sdkPath));
}

function resolveExistingSdkDebuggerPath(
  project: ZephyrApplication,
  zephyrSdkInstallation: ReturnType<typeof tryGetZephyrSdkInstallation>,
  targetArch: string,
  socToolchainName: string | undefined,
): string {
  const sdkDebuggerPath = zephyrSdkInstallation?.getDebuggerPath(targetArch, socToolchainName) ?? '';
  if (!sdkDebuggerPath || !project.zephyrSdkPath) {
    return sdkDebuggerPath;
  }

  const concreteDebuggerPath = sdkDebuggerPath.includes(ZEPHYR_SDK_CONFIG_VARIABLE)
    ? resolveSdkConfigVariablePath(sdkDebuggerPath, project.zephyrSdkPath)
    : sdkDebuggerPath;

  if (!fileExists(concreteDebuggerPath)) {
    return '';
  }

  // VS Code's `${config:...}` token can resolve freestanding app SDK settings,
  // but workspace applications store SDK/toolchain values inside their
  // application entry. They therefore need the concrete executable path.
  return project.isWestWorkspaceApplication ? concreteDebuggerPath : sdkDebuggerPath;
}

function getFallbackMiDebuggerPath(
  project: ZephyrApplication,
  zephyrSdkInstallation: ReturnType<typeof tryGetZephyrSdkInstallation>,
  armGnuToolchainInstallation: ReturnType<typeof findArmGnuToolchainInstallation>,
  targetArch: string,
  socToolchainName: string | undefined,
): string {
  if (armGnuToolchainInstallation?.debuggerPath) {
    return armGnuToolchainInstallation.debuggerPath;
  }

  // LLVM SDK builds may report `CMAKE_GDB-NOTFOUND` because there is no clang
  // debugger. Fall back to the GNU GDB that matches the board architecture when
  // the SDK actually ships it; otherwise keep the launch field empty.
  return resolveExistingSdkDebuggerPath(project, zephyrSdkInstallation, targetArch, socToolchainName);
}

function getMiDebuggerPath(
  project: ZephyrApplication,
  generatedGdbPath: string | undefined,
  fallbackPath: string,
): string {
  if (!generatedGdbPath) {
    return fallbackPath;
  }

  const strippedGeneratedPath = normalizeDetectedGdbPath(generatedGdbPath);
  if (!strippedGeneratedPath) {
    return fallbackPath;
  }

  if (project.isWestWorkspaceApplication) {
    // VS Code cannot resolve application-entry settings from launch.json's
    // `${config:...}` syntax. Workspace-app debug configs therefore keep the
    // concrete GDB executable path discovered from the build instead.
    return strippedGeneratedPath;
  }

  return project.zephyrSdkPath
    ? normalizeSdkRelativeDetectedPath(strippedGeneratedPath, project.zephyrSdkPath)
    : strippedGeneratedPath;
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
  let generatedGdbPath = normalizeDetectedGdbPath(runnersYaml?.gdbPath);

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
  const appFolderName = path.basename(project.appRootPath);
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
  let envScript: string | undefined = getConfiguredWorkbenchPath(
    ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY,
    project.appWorkspaceFolder,
  );
  if(!envScript) {
    throw new Error('Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Zephyr Workbench > Path To Env Script',
       { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` });
  } 
  const shell: string = getShell();
  let westCmd = '';
  switch (shell) {
    case 'bash':
    case 'zsh':
    case 'dash':
    case 'fish':
      westCmd = 'west "$@"';
      break;
    case 'cmd.exe':
      westCmd = 'west %*';
      break;
    case 'powershell.exe':
    case 'pwsh.exe':
      westCmd = 'west $args';
      break;
    default:
      westCmd = 'west "$@"';
      break;
  }

  let envVars = {
    ...westWorkspace.buildEnv,
    ...project.getToolchainEnv(),
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
    case 'zsh':
    case 'dash':
    case 'fish':
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
    case 'pwsh.exe':
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

function getWestWrapperFile(shell: string = getShell()): string {
  switch (shell) {
    case 'bash':
    case 'zsh':
    case 'dash':
    case 'fish':
      return 'west_wrapper.sh';
    case 'cmd.exe':
      return 'west_wrapper.bat';
    case 'powershell.exe':
    case 'pwsh.exe':
      return 'west_wrapper.ps1';
    default:
      return 'west';
  }
}

function getWorkspaceRelativeBuildDir(
  project: ZephyrApplication,
  buildConfig: ZephyrBuildConfig,
): string {
  const relativeBuildDir = path
    .relative(project.appWorkspaceFolder.uri.fsPath, buildConfig.getBuildDir(project))
    .replace(/\\/g, '/');

  return relativeBuildDir && !relativeBuildDir.startsWith('..') && !path.isAbsolute(relativeBuildDir)
    ? relativeBuildDir
    : buildConfig.relativeBuildDir.replace(/\\/g, '/');
}

export function getWestDebugArgsForProject(
  runner: WestRunner,
  project: ZephyrApplication,
  buildConfig: ZephyrBuildConfig,
): string {
  return runner.getWestDebugArgs(getLaunchConfigurationPaths(project, buildConfig).workspaceRelativeBuildDir);
}

function withDebugServerBuildDir(debugServerArgs: string | undefined, buildDirExpression: string): string | undefined {
  if (!debugServerArgs || debugServerArgs.trim().length === 0) {
    return debugServerArgs;
  }

  const quotedBuildDir = `"${buildDirExpression}"`;
  const buildDirPattern = /--build-dir(?:\s+|=)(?:"[^"]*"|\S+)/;
  if (buildDirPattern.test(debugServerArgs)) {
    return debugServerArgs.replace(buildDirPattern, `--build-dir ${quotedBuildDir}`);
  }

  return debugServerArgs.startsWith('debugserver')
    ? debugServerArgs.replace(/^debugserver\b/, `debugserver --build-dir ${quotedBuildDir}`)
    : `${debugServerArgs} --build-dir ${quotedBuildDir}`;
}

function resolveWorkspaceExpression(value: string | undefined, workspaceFolder: vscode.WorkspaceFolder): string | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }

  const unquotedValue = value.trim().replace(/^"(.*)"$/, '$1');
  const workspaceToken = '${workspaceFolder}';
  if (unquotedValue === workspaceToken) {
    return workspaceFolder.uri.fsPath;
  }

  if (unquotedValue.startsWith(`${workspaceToken}/`) || unquotedValue.startsWith(`${workspaceToken}\\`)) {
    return path.normalize(path.join(workspaceFolder.uri.fsPath, unquotedValue.slice(workspaceToken.length + 1)));
  }

  return path.isAbsolute(unquotedValue) ? path.normalize(unquotedValue) : undefined;
}

function isWithin(parentPath: string, childPath: string): boolean {
  const normalizedParent = path.resolve(parentPath);
  const normalizedChild = path.resolve(childPath);
  const parent = process.platform === 'win32' ? normalizedParent.toLowerCase() : normalizedParent;
  const child = process.platform === 'win32' ? normalizedChild.toLowerCase() : normalizedChild;
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function shouldRefreshWorkspaceApplicationProgram(config: any, project: ZephyrApplication): boolean {
  const programPath = resolveWorkspaceExpression(config.program, project.appWorkspaceFolder);
  if (!programPath) {
    return true;
  }

  // Workspace applications share a launch.json at the west root. If the stored
  // program points somewhere else inside that west workspace, it likely belongs
  // to a different selected application and must be re-targeted. Absolute paths
  // outside the workspace are treated as intentional user overrides.
  return isWithin(project.appWorkspaceFolder.uri.fsPath, programPath) && !isWithin(project.appRootPath, programPath);
}

function getGeneratedGdbPath(
  project: ZephyrApplication,
  buildConfig: ZephyrBuildConfig,
  artifacts?: LaunchConfigurationArtifacts,
): string | undefined {
  if (artifacts?.generatedGdbPath) {
    return normalizeDetectedGdbPath(artifacts.generatedGdbPath);
  }

  const appFolderName = path.basename(project.appRootPath);
  return resolveGeneratedArtifactsFromBuildDir(
    buildConfig.getBuildDir(project),
    appFolderName,
    buildConfig.boardIdentifier,
  ).generatedGdbPath;
}

function getWorkspaceApplicationMiDebuggerPath(
  config: any,
  project: ZephyrApplication,
  buildConfig: ZephyrBuildConfig,
  artifacts?: LaunchConfigurationArtifacts,
): string | undefined {
  const generatedGdbPath = getGeneratedGdbPath(project, buildConfig, artifacts);
  if (generatedGdbPath) {
    return getMiDebuggerPath(project, generatedGdbPath, '');
  }

  const currentPath = typeof config.miDebuggerPath === 'string'
    ? config.miDebuggerPath
    : '';
  if (!currentPath.includes(ZEPHYR_SDK_CONFIG_VARIABLE) || !project.zephyrSdkPath) {
    return undefined;
  }

  const resolvedPath = resolveSdkConfigVariablePath(currentPath, project.zephyrSdkPath);
  return fileExists(resolvedPath) ? resolvedPath : '';
}

function getDebugProgramPath(project: ZephyrApplication, buildConfig: ZephyrBuildConfig): string {
  const buildFolderPath = buildConfig.getBuildDir(project);
  const appFolderName = path.basename(project.appRootPath);
  const appNameDir = path.join(buildFolderPath, appFolderName);

  if (fs.existsSync(appNameDir)) {
    return getLaunchWorkspaceRelativePath(project, path.join(appNameDir, ZEPHYR_DIRNAME, ZEPHYR_APP_FILENAME));
  }

  return getLaunchWorkspaceRelativePath(project, path.join(buildFolderPath, ZEPHYR_DIRNAME, ZEPHYR_APP_FILENAME));
}

function getLaunchWorkspaceRelativePath(project: ZephyrApplication, targetPath: string): string {
  const relativePath = path
    .relative(project.appWorkspaceFolder.uri.fsPath, targetPath)
    .replace(/\\/g, '/');

  if (!relativePath || relativePath === '.') {
    return '${workspaceFolder}';
  }

  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
    ? path.posix.join('${workspaceFolder}', relativePath)
    : targetPath;
}

function getLaunchConfigurationPaths(
  project: ZephyrApplication,
  buildConfig: ZephyrBuildConfig,
): LaunchConfigurationPaths {
  // Keep the original launch.json contract intact:
  // debugger-facing file paths and the west build-dir argument are expressed
  // from the VS Code workspace folder. For freestanding apps `${workspaceFolder}`
  // is the app; for workspace apps it is the west workspace, so the relative
  // segment includes the application directory.
  const workspaceRelativeBuildDir = getWorkspaceRelativeBuildDir(project, buildConfig);
  return {
    cwd: getLaunchWorkspaceRelativePath(project, project.appRootPath),
    program: getDebugProgramPath(project, buildConfig),
    debugServerPath: getLaunchWorkspaceRelativePath(
      project,
      path.join(buildConfig.getInternalDebugDir(project), getWestWrapperFile()),
    ),
    workspaceRelativeBuildDir,
  };
}

export function syncLaunchConfigurationProjectPaths(
  config: any,
  project: ZephyrApplication,
  buildConfigName?: string,
  artifacts?: LaunchConfigurationArtifacts,
): void {
  if (!config || !buildConfigName) {
    return;
  }

  const buildConfig = project.getBuildConfiguration(buildConfigName);
  if (!buildConfig) {
    return;
  }

  const paths = getLaunchConfigurationPaths(project, buildConfig);
  // These fields are generated paths, not user-owned debugger options. Refresh
  // them from one path model so workspace-app launch entries stay aligned with
  // the selected app without storing extension-private keys inside cppdbg.
  config.cwd = paths.cwd;
  config.debugServerPath = paths.debugServerPath;
  config.debugServerArgs = withDebugServerBuildDir(
    config.debugServerArgs,
    '${workspaceFolder}/' + paths.workspaceRelativeBuildDir,
  );

  if (project.isWestWorkspaceApplication && shouldRefreshWorkspaceApplicationProgram(config, project)) {
    config.program = paths.program;
  }
  if (project.isWestWorkspaceApplication) {
    const currentMiDebuggerPath = typeof config.miDebuggerPath === 'string'
      ? config.miDebuggerPath
      : '';
    if (!currentMiDebuggerPath || currentMiDebuggerPath.includes(ZEPHYR_SDK_CONFIG_VARIABLE)) {
      const miDebuggerPath = getWorkspaceApplicationMiDebuggerPath(config, project, buildConfig, artifacts);
      if (typeof miDebuggerPath === 'string') {
        config.miDebuggerPath = miDebuggerPath;
      }
    }
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
  const toolchainVariant = project.toolchainVariant;
  const zephyrSdkInstallation = tryGetZephyrSdkInstallation(project.zephyrSdkPath);
  const armGnuToolchainInstallation = toolchainVariant === 'gnuarmemb'
    ? findArmGnuToolchainInstallation(project.selectedArmGnuToolchainInstallation?.toolchainPath ?? '')
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

  const targetArch = targetBoard.arch;
  let configName;
  let socToolchainName;
  let paths: LaunchConfigurationPaths | undefined;

  if (buildConfig) {
    configName = getDebugLaunchConfigurationName(project, buildConfig.name);
    socToolchainName = buildConfig.getKConfigValue(project, 'SOC_TOOLCHAIN_NAME');
    paths = getLaunchConfigurationPaths(project, buildConfig);
  }
  const fallbackMiDebuggerPath = targetBoard
    ? getFallbackMiDebuggerPath(
        project,
        zephyrSdkInstallation,
        armGnuToolchainInstallation,
        targetArch,
        socToolchainName,
      )
    : '';

  // Auto-detect SVD for STM32 boards (best effort)
  let svdPath = '';
  if (targetBoard) {
    svdPath = autoDetectSvdPath(targetBoard);
  }
  
  const launchJson = {
    name: `${configName}`,
    type: "cppdbg",
    request: "launch",
    cwd: paths?.cwd ?? getLaunchWorkspaceRelativePath(project, project.appRootPath),
    program: paths?.program ?? '',
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
    miDebuggerPath: fallbackMiDebuggerPath,
    debugServerPath: paths?.debugServerPath ?? '',
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

  launchJson.miDebuggerPath = getMiDebuggerPath(project, generatedGdbPath, fallbackMiDebuggerPath);

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
  const raw = await fs.promises.readFile(path.join(project.appWorkspaceFolder.uri.fsPath, '.vscode', 'launch.json'), 'utf8');
  if (raw.trim().length === 0) {
    return undefined;
  }
  try {
    const launchJson = JSON.parse(raw);
    stripUnsupportedLaunchConfigurationProperties(launchJson);
    return launchJson;
  } catch {
    return undefined;
  }
}

function stripUnsupportedLaunchConfigurationProperties(launchJson: any): void {
  if (!Array.isArray(launchJson?.configurations)) {
    return;
  }

  for (const config of launchJson.configurations) {
    if (config && typeof config === 'object') {
      // This was briefly used as internal routing metadata for workspace
      // applications. cppdbg launch entries should contain only debugger
      // configuration, so scrub it whenever we touch launch.json.
      delete config[LEGACY_ZEPHYR_WORKBENCH_DEBUG_APP_ROOT_KEY];
    }
  }
}

export function writeLaunchJson(launchJson: any, project: ZephyrApplication) {
  stripUnsupportedLaunchConfigurationProperties(launchJson);
  const launchDir = path.join(project.appWorkspaceFolder.uri.fsPath, '.vscode');
  fs.mkdirSync(launchDir, { recursive: true });
  fs.writeFileSync(path.join(launchDir, 'launch.json'), JSON.stringify(launchJson, null, 2));
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
  const debugConfigName = getDebugLaunchConfigurationName(project, buildConfigName);

  const matchingConfigurations = launchJson.configurations.filter((configuration: any) =>
    configuration && typeof configuration === 'object' && configuration.name === debugConfigName
  );

  if (matchingConfigurations.length > 0) {
    if (project.isWestWorkspaceApplication) {
      syncLaunchConfigurationProjectPaths(matchingConfigurations[0], project, buildConfigName, artifacts);
    }
    return matchingConfigurations[0];
  }

  if (project.isWestWorkspaceApplication) {
    const legacyConfigName = getFreestandingDebugLaunchConfigurationName(buildConfigName);
    const legacyConfiguration = launchJson.configurations.find((configuration: any) =>
      configuration && typeof configuration === 'object' && configuration.name === legacyConfigName
    );
    if (legacyConfiguration) {
      // Workspace applications used to create freestanding-style names in the
      // shared west workspace launch.json. Rename that one legacy entry to the
      // app-specific name so existing launch.json files stop presenting an
      // ambiguous "primary" config beside the new per-app entries.
      legacyConfiguration.name = debugConfigName;
      syncLaunchConfigurationProjectPaths(legacyConfiguration, project, buildConfigName, artifacts);
      return legacyConfiguration;
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
  return newCfg;
}

export async function getLaunchConfiguration(
  project: ZephyrApplication,
  buildConfigName?: string,
  createIfMissing: boolean = false,
  artifacts?: LaunchConfigurationArtifacts,
): Promise<[any, any]> {
  let launchJson: any;
  const launchPath = path.join(project.appWorkspaceFolder.uri.fsPath, '.vscode', 'launch.json');

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
