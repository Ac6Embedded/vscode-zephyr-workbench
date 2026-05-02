// Zephyr Workbench task provider and helpers.
// Centralizes task definitions plus tasks.json load/merge/save logic to avoid overwriting user content.
import * as fs from 'fs';
import * as fsPromise from 'fs/promises';
import * as path from 'path';
import * as ts from 'typescript';
import * as vscode from 'vscode';
import { WestWorkspace } from '../models/WestWorkspace';
import { ZephyrApplication } from '../models/ZephyrApplication';
import { ZephyrBoard } from '../models/ZephyrBoard';
import type { ZephyrBuildConfig } from '../models/ZephyrBuildConfig';
import { ArmGnuToolchainInstallation, ensureWindowsExecutableExtension, normalizeZephyrSdkVariant, ZephyrSdkInstallation, IarToolchainInstallation } from '../models/ToolchainInstallations';
import {
  ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY,
  ZEPHYR_PROJECT_SDK_SETTING_KEY,
  ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY,
  ZEPHYR_PROJECT_IAR_SETTING_KEY,
  ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY,
  ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY,
  ZEPHYR_WORKBENCH_SETTING_SECTION_KEY,
  ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY,
} from '../constants';
import { concatCommands, getConfiguredVenvPath, getConfiguredWorkbenchPath, getEnvVarFormat, getShell, getShellArgs, getShellExe, isCygwin, resolveConfiguredPath, toPortableWorkspaceFolderPath } from '../utils/execUtils';
import { getWestWorkspace, msleep, tryGetZephyrSdkInstallation } from '../utils/utils';
import { getStaticFlashRunnerNames } from '../utils/debugTools/debugUtils';
import { normalizeStoredToolchainVariant } from '../utils/toolchainSelection';
import { prepareWestBuildExecution } from '../utils/zephyr/westBuildExecution';
import { readRunnersYamlForProject } from '../utils/zephyr/runnersYamlUtils';
import { cleanupEmptyWorkspaceSettings } from '../utils/vscodeWorkspaceCleanup';
import {
  findContainingWorkspaceApplicationEntry,
  getEffectiveWorkspaceApplicationEntry,
  readWorkspaceApplicationEntries,
  resolveWorkspaceApplicationPath,
  setSelectedWorkspaceApplicationPath,
  updateWorkspaceApplicationEntry,
} from '../utils/zephyr/workspaceApplications';

export interface TaskConfig {
  version: string;
  tasks: ZephyrTaskDefinition[];
  [key: string]: any;
}
export interface ZephyrTaskDefinition extends vscode.TaskDefinition {
  label: string;
  type: string;
  command: string;
  [key: string]: any;
  args: string[];
  config?: string;
}

const ZEPHYR_TASK_TYPE = 'zephyr-workbench';

const westBuildTask: ZephyrTaskDefinition = {
  label: "West Build",
  type: ZEPHYR_TASK_TYPE,
  problemMatcher: ["$gcc"],
  group: {
    kind: "build",
    isDefault: true
  },
  command: "west",
  config: "primary",
  args: [
    "build",
    "--pristine never",
    "--board ${config:zephyr-workbench.build.configurations.0.board}",
    "--build-dir \"${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}\""
  ]
};

const rebuildTask: ZephyrTaskDefinition = {
  label: "West Rebuild",
  type: ZEPHYR_TASK_TYPE,
  problemMatcher: ["$gcc"],
  group: {
    kind: "build",
    isDefault: false
  },
  command: "west",
  config: "primary",
  args: [
    "build",
    "-p always",
    "--board ${config:zephyr-workbench.build.configurations.0.board}",
    "--build-dir \"${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}\""
  ]
};

const guiConfigTask: ZephyrTaskDefinition = {
  label: "Gui config",
  type: ZEPHYR_TASK_TYPE,
  problemMatcher: [],
  command: "west",
  config: "primary",
  args: [
    "build",
    "-t guiconfig",
    "--board ${config:zephyr-workbench.build.configurations.0.board}",
    "--build-dir \"${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}\""
  ]
};

const menuconfigTask: ZephyrTaskDefinition = {
  label: "Menuconfig",
  type: ZEPHYR_TASK_TYPE,
  command: "west",
  config: "primary",
  args: [
    "build",
    "-t menuconfig",
    "--board ${config:zephyr-workbench.build.configurations.0.board}",
    "--build-dir \"${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}\""
  ]
};

const hardenConfigTask: ZephyrTaskDefinition = {
  label: "Harden Config",
  type: ZEPHYR_TASK_TYPE,
  command: "west",
  config: "primary",
  args: [
    "build",
    "-t hardenconfig",
    "--board ${config:zephyr-workbench.build.configurations.0.board}",
    "--build-dir \"${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}\""
  ]
};

const flashTask: ZephyrTaskDefinition = {
  label: "West Flash",
  type: ZEPHYR_TASK_TYPE,
  problemMatcher: [],
  command: "west",
  config: "primary",
  args: [
    "flash",
    "--board ${config:zephyr-workbench.build.configurations.0.board}",
    "--build-dir \"${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}\""
  ]
};

const ramReportTask: ZephyrTaskDefinition = {
  label: "West RAM Report",
  type: ZEPHYR_TASK_TYPE,
  problemMatcher: [],
  command: "west",
  config: "primary",
  args: [
    "build",
    "-t ram_report",
    "--board ${config:zephyr-workbench.build.configurations.0.board}",
    "--build-dir \"${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}\""
  ]
};

const romReportTask: ZephyrTaskDefinition = {
  label: "West ROM Report",
  type: ZEPHYR_TASK_TYPE,
  problemMatcher: [],
  command: "west",
  config: "primary",
  args: [
    "build",
    "-t rom_report",
    "--board ${config:zephyr-workbench.build.configurations.0.board}",
    "--build-dir \"${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}\""
  ]
};

const ramPlotTask: ZephyrTaskDefinition = {
  label: "West RAM Plot",
  type: ZEPHYR_TASK_TYPE,
  problemMatcher: [],
  command: "west",
  config: "primary",
  args: [
    "build",
    "-t ram_plot",
    "--board ${config:zephyr-workbench.build.configurations.0.board}",
    "--build-dir \"${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}\""
  ]
};

const romPlotTask: ZephyrTaskDefinition = {
  label: "West ROM Plot",
  type: ZEPHYR_TASK_TYPE,
  problemMatcher: [],
  command: "west",
  config: "primary",
  args: [
    "build",
    "-t rom_plot",
    "--board ${config:zephyr-workbench.build.configurations.0.board}",
    "--build-dir \"${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}\""
  ]
};

const puncoverTask: ZephyrTaskDefinition = {
  label: "West Puncover",
  type: ZEPHYR_TASK_TYPE,
  problemMatcher: [],
  command: "west",
  config: "primary",
  args: [
    "build",
    "-t puncover",
    "--board ${config:zephyr-workbench.build.configurations.0.board}",
    "--build-dir \"${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}\""
  ]
};

const dtDoctorTask: ZephyrTaskDefinition = {
  label: "DT Doctor",
  type: ZEPHYR_TASK_TYPE,
  problemMatcher: [],
  command: "west",
  config: "primary",
  args: [
    "build",
    "--board ${config:zephyr-workbench.build.configurations.0.board}",
    "--build-dir \"${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}\"",
    "-- -DZEPHYR_SCA_VARIANT=dtdoctor"
  ]
};

const westDashboardTask: ZephyrTaskDefinition = {
  label: "West Dashboard",
  type: ZEPHYR_TASK_TYPE,
  problemMatcher: [],
  command: "west",
  config: "primary",
  args: [
    "build",
    "-t dashboard",
    "--board ${config:zephyr-workbench.build.configurations.0.board}",
    "--build-dir \"${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}\""
  ]
};

const spdxInitTask: ZephyrTaskDefinition = {
  label: "SPDX init",
  type: ZEPHYR_TASK_TYPE,
  problemMatcher: [],
  command: "west",
  config: "primary",
  args: [
    "spdx",
    "--init",
    "--build-dir \"${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}\""
  ]
};

const spdxGenerateTask: ZephyrTaskDefinition = {
  label: "SPDX generate",
  type: ZEPHYR_TASK_TYPE,
  problemMatcher: [],
  command: "west",
  config: "primary",
  args: [
    "spdx",
    "--build-dir \"${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}\""
  ]
};

const tasksMap = new Map<string, ZephyrTaskDefinition>([
  [westBuildTask.label, westBuildTask],
  [rebuildTask.label, rebuildTask],
  [guiConfigTask.label, guiConfigTask],
  [menuconfigTask.label, menuconfigTask],
  [hardenConfigTask.label, hardenConfigTask],
  [flashTask.label, flashTask],
  [ramReportTask.label, ramReportTask],
  [romReportTask.label, romReportTask],
  [ramPlotTask.label, ramPlotTask],
  [romPlotTask.label, romPlotTask],
  [puncoverTask.label, puncoverTask],
  [dtDoctorTask.label, dtDoctorTask],
  [westDashboardTask.label, westDashboardTask],
  [spdxInitTask.label, spdxInitTask],
  [spdxGenerateTask.label, spdxGenerateTask]
]);

// Subcommands of `west` that don't take --board. We skip auto-injection of --board for these
// so commands like `west spdx --build-dir ...` aren't passed a redundant flag.
const WEST_SUBCOMMANDS_WITHOUT_BOARD = new Set(['spdx']);

const BUILTIN_TASK_LABELS = new Set(tasksMap.keys());

function isWorkbenchTask(task: { type?: string } | undefined): boolean {
  return task?.type === ZEPHYR_TASK_TYPE;
}

export function isReservedTaskLabel(label: string): boolean {
  return BUILTIN_TASK_LABELS.has(label.trim());
}

interface ParsedWestBuildTaskOptions {
  pristine: 'never' | 'always';
  target?: string;
  additionalCmakeArgs?: string;
}

function parseWestBuildTaskOptions(args: string[] | undefined): ParsedWestBuildTaskOptions {
  const parsed: ParsedWestBuildTaskOptions = { pristine: 'never' };
  const safeArgs = Array.isArray(args) ? args : [];

  for (let index = 0; index < safeArgs.length; index++) {
    const arg = safeArgs[index]?.trim();
    if (!arg) {
      continue;
    }

    if (arg === '-p always' || arg === '--pristine always' || arg === '-p=always' || arg === '--pristine=always') {
      parsed.pristine = 'always';
      continue;
    }

    if (arg.startsWith('-t ')) {
      parsed.target = arg.slice(3).trim();
      continue;
    }

    if (arg.startsWith('--target ')) {
      parsed.target = arg.slice('--target '.length).trim();
      continue;
    }

    if (arg === '--' && index + 1 < safeArgs.length) {
      parsed.additionalCmakeArgs = safeArgs.slice(index + 1).join(' ').trim();
      break;
    }

    if (arg.startsWith('-- ')) {
      parsed.additionalCmakeArgs = arg.slice(3).trim();
      break;
    }
  }

  return parsed;
}

type TasksJsonConfig = TaskConfig & { inputs?: any[] };
type SettingsJsonConfig = Record<string, any>;
type CCppPropertiesConfig = Record<string, any> & {
  configurations?: any[];
  version?: number;
};
type CCppPropertiesConfiguration = Record<string, any> & {
  name?: string;
  compileCommands?: string | string[];
  compilerPath?: string;
};
type GeneratedSettingsPathMode = NonNullable<DefaultProjectSettingsOptions['pathMode']>;
type CCppConfigurationUpdate = {
  compilerPath?: string;
  compileCommandsPath?: string;
  pathMode?: GeneratedSettingsPathMode;
};
type CCppPropertiesUpdateOptions = CCppConfigurationUpdate & {
  createConfiguration?: boolean;
};
type DefaultApplicationSettingsState = {
  values: SettingsJsonConfig;
  deleteKeys: string[];
};

const CPP_CONFIGURATION_NAME = 'Zephyr Workbench';
const LEGACY_CPP_COMPILER_PATH_KEY = 'C_Cpp.default.compilerPath';
const LEGACY_CPP_COMPILE_COMMANDS_KEY = 'C_Cpp.default.compileCommands';

export interface CreateTasksJsonOptions {
  zephyrSdkPath?: string;
  westWorkspace?: WestWorkspace;
}

export interface DefaultProjectSettingsOptions {
  toolchainVariant?: string;
  venvPath?: string;
  pathMode?: 'relative' | 'absolute';
  preferConfigurationApi?: boolean;
}

// Load tasks.json (if it exists) into a normalized structure and keep the serialized
// version so we can avoid rewriting the file when nothing changed.
async function ensureTasksFile(workspaceFolder: vscode.WorkspaceFolder): Promise<{ config: TasksJsonConfig, tasksJsonPath: string, serialized?: string }> {
  const vscodeFolderPath = path.join(workspaceFolder.uri.fsPath, '.vscode');
  const tasksJsonPath = path.join(vscodeFolderPath, 'tasks.json');

  await fsPromise.mkdir(vscodeFolderPath, { recursive: true });

  let config: TasksJsonConfig = { version: "2.0.0", tasks: [] };
  let serialized: string | undefined;

  if (fs.existsSync(tasksJsonPath)) {
    try {
      serialized = await fsPromise.readFile(tasksJsonPath, 'utf8');
      const parsed = JSON.parse(serialized);
      config = {
        version: typeof parsed.version === 'string' ? parsed.version : "2.0.0",
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        ...parsed
      };
      if (!Array.isArray(config.tasks)) {
        config.tasks = [];
      }
    } catch {
      // Keep default config on parse errors or unreadable files
    }
  }

  if (!config.inputs || !Array.isArray(config.inputs)) {
    config.inputs = [];
  }

  if (!Array.isArray(config.tasks)) {
    config.tasks = [];
  }

  return { config, tasksJsonPath, serialized };
}

// Persist only when content actually differs to avoid clobbering timestamps/formatting needlessly.
async function writeTasksJson(tasksJsonPath: string, config: TasksJsonConfig, previousSerialized?: string): Promise<boolean> {
  const nextSerialized = JSON.stringify(config, null, 2);
  if (nextSerialized === previousSerialized) {
    return false;
  }

  await fsPromise.writeFile(tasksJsonPath, nextSerialized, 'utf8');
  return true;
}

async function ensureSettingsFile(workspaceFolder: vscode.WorkspaceFolder): Promise<{ config: SettingsJsonConfig, settingsJsonPath: string, serialized?: string, directWriteSupported: boolean }> {
  const vscodeFolderPath = path.join(workspaceFolder.uri.fsPath, '.vscode');
  const settingsJsonPath = path.join(vscodeFolderPath, 'settings.json');

  await fsPromise.mkdir(vscodeFolderPath, { recursive: true });

  if (!fs.existsSync(settingsJsonPath)) {
    return { config: {}, settingsJsonPath, directWriteSupported: true };
  }

  try {
    const serialized = await fsPromise.readFile(settingsJsonPath, 'utf8');
    const parsed = ts.parseConfigFileTextToJson(settingsJsonPath, serialized);
    if (parsed.error || !parsed.config || typeof parsed.config !== 'object' || Array.isArray(parsed.config)) {
      return { config: {}, settingsJsonPath, serialized, directWriteSupported: false };
    }

    return {
      config: parsed.config as SettingsJsonConfig,
      settingsJsonPath,
      serialized,
      directWriteSupported: true
    };
  } catch {
    return { config: {}, settingsJsonPath, directWriteSupported: false };
  }
}

async function writeSettingsJson(settingsJsonPath: string, config: SettingsJsonConfig, previousSerialized?: string): Promise<boolean> {
  const nextSerialized = JSON.stringify(config, null, 2);
  if (nextSerialized === previousSerialized) {
    return false;
  }

  await fsPromise.writeFile(settingsJsonPath, nextSerialized, 'utf8');
  return true;
}

function upsertPrimaryBuildConfig(existingConfigs: unknown, boardIdentifier: string): any[] {
  const configs = Array.isArray(existingConfigs)
    ? existingConfigs.filter(config => config && typeof config === 'object' && (config as { name?: string }).name !== 'primary')
    : [];

  configs.push({
    name: 'primary',
    board: boardIdentifier,
    active: 'true'
  });

  return configs;
}

function resolveStoredToolchainVariant(
  toolchainInstallation: ZephyrSdkInstallation | IarToolchainInstallation | ArmGnuToolchainInstallation,
  requestedVariant?: string,
): string {
  if (toolchainInstallation instanceof ZephyrSdkInstallation) {
    return normalizeZephyrSdkVariant(requestedVariant, toolchainInstallation);
  }
  if (toolchainInstallation instanceof ArmGnuToolchainInstallation) {
    return 'gnuarmemb';
  }
  return 'iar';
}

function formatGeneratedSettingsPath(
  targetPath: string,
  workspaceFolder: vscode.WorkspaceFolder,
  options: DefaultProjectSettingsOptions,
): string {
  return options.pathMode === 'absolute'
    ? targetPath
    : toPortableWorkspaceFolderPath(targetPath, workspaceFolder);
}

function hasOwnSetting(config: SettingsJsonConfig, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(config, key);
}

function inferGeneratedPathMode(existingValue: unknown): GeneratedSettingsPathMode | undefined {
  const value = Array.isArray(existingValue) ? existingValue[0] : existingValue;
  return typeof value === 'string' && value.startsWith('${workspaceFolder}')
    ? 'relative'
    : undefined;
}

function formatUpdatedPath(
  targetPath: string,
  workspaceFolder: vscode.WorkspaceFolder,
  pathMode?: GeneratedSettingsPathMode,
  existingValue?: unknown,
): string {
  return formatGeneratedSettingsPath(targetPath, workspaceFolder, {
    pathMode: pathMode ?? inferGeneratedPathMode(existingValue) ?? 'absolute',
  });
}

function getDefaultCompilerPath(
  toolchainInstallation: ZephyrSdkInstallation | IarToolchainInstallation | ArmGnuToolchainInstallation,
  zephyrBoard: ZephyrBoard,
  requestedVariant?: string,
): string {
  return toolchainInstallation instanceof ZephyrSdkInstallation
    ? toolchainInstallation.getCompilerPath(
        zephyrBoard.arch,
        undefined,
        resolveStoredToolchainVariant(toolchainInstallation, requestedVariant),
      )
    : toolchainInstallation.compilerPath;
}

function buildDefaultApplicationSettings(
  workspaceFolder: vscode.WorkspaceFolder,
  westWorkspace: WestWorkspace,
  zephyrBoard: ZephyrBoard,
  toolchainInstallation: ZephyrSdkInstallation | IarToolchainInstallation | ArmGnuToolchainInstallation,
  options: DefaultProjectSettingsOptions,
  includeWestWorkspace: boolean,
): DefaultApplicationSettingsState {
  const boardIdentifier = zephyrBoard.identifier ?? '';
  const toolchainVariant = resolveStoredToolchainVariant(toolchainInstallation, options.toolchainVariant);
  const formatPath = (targetPath: string) => formatGeneratedSettingsPath(targetPath, workspaceFolder, options);
  const values: SettingsJsonConfig = {
    'build.configurations': upsertPrimaryBuildConfig(undefined, boardIdentifier),
  };
  const deleteKeys: string[] = [];

  if (includeWestWorkspace) {
    values[ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY] = formatPath(westWorkspace.rootUri.fsPath);
  }

  if (toolchainInstallation instanceof ZephyrSdkInstallation) {
    values[ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY] = toolchainVariant;
    values[ZEPHYR_PROJECT_SDK_SETTING_KEY] = formatPath(toolchainInstallation.rootUri.fsPath);
    deleteKeys.push(ZEPHYR_PROJECT_IAR_SETTING_KEY, ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY);
  } else if (toolchainInstallation instanceof IarToolchainInstallation) {
    values[ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY] = 'iar';
    values[ZEPHYR_PROJECT_IAR_SETTING_KEY] = formatPath(toolchainInstallation.iarPath);
    values[ZEPHYR_PROJECT_SDK_SETTING_KEY] = formatPath(toolchainInstallation.zephyrSdkPath);
    deleteKeys.push(ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY);
  } else {
    values[ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY] = 'gnuarmemb';
    values[ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY] = formatPath(toolchainInstallation.toolchainPath);
    deleteKeys.push(ZEPHYR_PROJECT_SDK_SETTING_KEY, ZEPHYR_PROJECT_IAR_SETTING_KEY);
  }

  if (options.venvPath) {
    values[ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY] = formatPath(options.venvPath);
  }

  return { values, deleteKeys };
}

function getCppPropertiesPath(workspaceFolder: vscode.WorkspaceFolder): string {
  return path.join(workspaceFolder.uri.fsPath, '.vscode', 'c_cpp_properties.json');
}

async function readCppPropertiesFile(
  workspaceFolder: vscode.WorkspaceFolder,
  showWarning = true,
): Promise<{ config: CCppPropertiesConfig, cppPropertiesPath: string, serialized: string } | undefined> {
  const cppPropertiesPath = getCppPropertiesPath(workspaceFolder);
  if (!fs.existsSync(cppPropertiesPath)) {
    return undefined;
  }

  try {
    const serialized = await fsPromise.readFile(cppPropertiesPath, 'utf8');
    const parsed = ts.parseConfigFileTextToJson(cppPropertiesPath, serialized);
    if (parsed.error || !parsed.config || typeof parsed.config !== 'object' || Array.isArray(parsed.config)) {
      if (showWarning) {
        vscode.window.showWarningMessage('Cannot setup C/C++ properties: c_cpp_properties.json format is invalid.');
      }
      return undefined;
    }
    return { config: parsed.config, cppPropertiesPath, serialized };
  } catch {
    if (showWarning) {
      vscode.window.showWarningMessage('Cannot setup C/C++ properties: c_cpp_properties.json could not be parsed.');
    }
    return undefined;
  }
}

function getZephyrCppConfiguration(config: CCppPropertiesConfig): CCppPropertiesConfiguration | undefined {
  if (!Array.isArray(config.configurations)) {
    return undefined;
  }

  return config.configurations.find(configuration =>
    configuration && typeof configuration === 'object' && configuration.name === CPP_CONFIGURATION_NAME
  ) as CCppPropertiesConfiguration | undefined;
}

function getCompileCommandsValue(configuration: CCppPropertiesConfiguration): string | undefined {
  const value = Array.isArray(configuration.compileCommands)
    ? configuration.compileCommands[0]
    : configuration.compileCommands;
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
}

function getForceRefreshCompileCommandsValue(value: string | string[]): string | string[] {
  const dummyValue = (entry: string) => `${entry}.force-refresh`;
  return Array.isArray(value)
    ? value.map(entry => typeof entry === 'string' ? dummyValue(entry) : entry)
    : dummyValue(value);
}

async function updateCppPropertiesFile(
  workspaceFolder: vscode.WorkspaceFolder,
  update: CCppPropertiesUpdateOptions,
): Promise<boolean> {
  let config: CCppPropertiesConfig = { configurations: [], version: 4 };
  let serialized: string | undefined;
  const cppPropertiesPath = getCppPropertiesPath(workspaceFolder);
  const cppPropertiesExists = fs.existsSync(cppPropertiesPath);
  const parsedFile = await readCppPropertiesFile(workspaceFolder);

  if (parsedFile) {
    config = parsedFile.config;
    serialized = parsedFile.serialized;
  } else if (cppPropertiesExists) {
    return false;
  } else if (update.createConfiguration) {
    await fsPromise.mkdir(path.dirname(cppPropertiesPath), { recursive: true });
  } else {
    return false;
  }

  if (!Array.isArray(config.configurations)) {
    config.configurations = [];
  }
  if (typeof config.version !== 'number') {
    config.version = 4;
  }

  const existingIndex = config.configurations.findIndex(configuration =>
    configuration && typeof configuration === 'object' && configuration.name === CPP_CONFIGURATION_NAME
  );

  if (existingIndex === -1) {
    if (!update.createConfiguration) {
      return false;
    }
    config.configurations.push({ name: CPP_CONFIGURATION_NAME });
  }

  const configuration = config.configurations[existingIndex === -1 ? config.configurations.length - 1 : existingIndex] as CCppPropertiesConfiguration;
  if (update.compileCommandsPath) {
    configuration.compileCommands = [
      formatUpdatedPath(update.compileCommandsPath, workspaceFolder, update.pathMode, configuration.compileCommands),
    ];
  }
  if (update.compilerPath) {
    configuration.compilerPath = formatUpdatedPath(
      ensureWindowsExecutableExtension(update.compilerPath),
      workspaceFolder,
      update.pathMode,
      configuration.compilerPath,
    );
  }

  const nextSerialized = JSON.stringify(config, null, 2);
  if (nextSerialized !== serialized) {
    await fsPromise.writeFile(cppPropertiesPath, nextSerialized, 'utf8');
  }
  return true;
}

export async function createCppPropertiesCompileCommandsRefresh(workspaceFolder: vscode.WorkspaceFolder): Promise<() => Promise<void>> {
  const parsedFile = await readCppPropertiesFile(workspaceFolder, false);
  const zephyrConfiguration = parsedFile ? getZephyrCppConfiguration(parsedFile.config) : undefined;
  const configuredCompileCommandsPath = zephyrConfiguration ? getCompileCommandsValue(zephyrConfiguration) : undefined;
  const compileCommandsPath = resolveConfiguredPath(configuredCompileCommandsPath, workspaceFolder);

  // Missing c_cpp_properties.json or missing Zephyr Workbench config is valid; leave it as a quiet no-op.
  if (!compileCommandsPath || fs.existsSync(compileCommandsPath)) {
    return async () => {};
  }

  return async () => {
    if (!fs.existsSync(compileCommandsPath)) {
      return;
    }

    const latestFile = await readCppPropertiesFile(workspaceFolder, false);
    // The file or Zephyr Workbench config may have been removed while the build was running; that is still fine.
    const latestZephyrConfiguration = latestFile ? getZephyrCppConfiguration(latestFile.config) : undefined;
    const originalCompileCommands = latestZephyrConfiguration?.compileCommands;
    if (!latestFile || !latestZephyrConfiguration || (typeof originalCompileCommands !== 'string' && !Array.isArray(originalCompileCommands))) {
      return;
    }

    try {
      // Workaround for cpptools: when compile_commands.json appears after the path was configured,
      // IntelliSense can miss it. Force a visible setting change, then restore the real value.
      latestZephyrConfiguration.compileCommands = getForceRefreshCompileCommandsValue(originalCompileCommands);
      await fsPromise.writeFile(latestFile.cppPropertiesPath, JSON.stringify(latestFile.config, null, 2), 'utf8');
      await msleep(2000);
      latestZephyrConfiguration.compileCommands = originalCompileCommands;
      await fsPromise.writeFile(latestFile.cppPropertiesPath, JSON.stringify(latestFile.config, null, 2), 'utf8');
    } catch {
      vscode.window.showWarningMessage('Cannot refresh C/C++ properties for IntelliSense.');
    }
  };
}

async function writeDefaultCppPropertiesFile(
  workspaceFolder: vscode.WorkspaceFolder,
  compilerPath: string,
  compileCommandsPath: string,
  options: DefaultProjectSettingsOptions,
): Promise<void> {
  await updateCppPropertiesFile(workspaceFolder, {
    compilerPath,
    compileCommandsPath,
    pathMode: options.pathMode ?? 'relative',
    createConfiguration: true,
  });
}

export async function updateCppToolsConfiguration(
  workspaceFolder: vscode.WorkspaceFolder,
  update: CCppConfigurationUpdate,
): Promise<boolean> {
  const { config, settingsJsonPath, serialized, directWriteSupported } = await ensureSettingsFile(workspaceFolder);
  let legacyUpdated = false;
  let pendingCompilerPath = update.compilerPath;
  let pendingCompileCommandsPath = update.compileCommandsPath;

  if (directWriteSupported) {
    // Legacy C/C++ settings.json keys are kept for existing projects; consider removing this old method in the future.
    if (pendingCompilerPath && hasOwnSetting(config, LEGACY_CPP_COMPILER_PATH_KEY)) {
      config[LEGACY_CPP_COMPILER_PATH_KEY] = formatUpdatedPath(
        ensureWindowsExecutableExtension(pendingCompilerPath),
        workspaceFolder,
        update.pathMode,
        config[LEGACY_CPP_COMPILER_PATH_KEY],
      );
      pendingCompilerPath = undefined;
      legacyUpdated = true;
    }

    if (pendingCompileCommandsPath && hasOwnSetting(config, LEGACY_CPP_COMPILE_COMMANDS_KEY)) {
      config[LEGACY_CPP_COMPILE_COMMANDS_KEY] = formatUpdatedPath(
        pendingCompileCommandsPath,
        workspaceFolder,
        update.pathMode,
        config[LEGACY_CPP_COMPILE_COMMANDS_KEY],
      );
      pendingCompileCommandsPath = undefined;
      legacyUpdated = true;
    }

    if (legacyUpdated) {
      await writeSettingsJson(settingsJsonPath, config, serialized);
    }
  }

  if (!pendingCompilerPath && !pendingCompileCommandsPath) {
    return legacyUpdated;
  }

  const cppPropertiesUpdated = await updateCppPropertiesFile(workspaceFolder, {
    compilerPath: pendingCompilerPath,
    compileCommandsPath: pendingCompileCommandsPath,
    pathMode: update.pathMode,
  });
  return legacyUpdated || cppPropertiesUpdated;
}

export async function removeCppToolsConfiguration(workspaceFolder: vscode.WorkspaceFolder): Promise<boolean> {
  const parsedFile = await readCppPropertiesFile(workspaceFolder, false);
  if (!parsedFile || !Array.isArray(parsedFile.config.configurations)) {
    return false;
  }

  const nextConfigurations = parsedFile.config.configurations.filter(configuration =>
    !(configuration && typeof configuration === 'object' && configuration.name === CPP_CONFIGURATION_NAME)
  );
  if (nextConfigurations.length === parsedFile.config.configurations.length) {
    return false;
  }

  if (nextConfigurations.length === 0) {
    // The generated C/C++ properties file has no remaining configurations, so
    // remove the file rather than leaving an empty shell behind.
    await fsPromise.unlink(parsedFile.cppPropertiesPath);
    await cleanupEmptyWorkspaceSettings(workspaceFolder);
    return true;
  }

  parsedFile.config.configurations = nextConfigurations;
  await fsPromise.writeFile(parsedFile.cppPropertiesPath, JSON.stringify(parsedFile.config, null, 2), 'utf8');
  await cleanupEmptyWorkspaceSettings(workspaceFolder);
  return true;
}

async function tryWriteDefaultProjectSettingsFile(
  workspaceFolder: vscode.WorkspaceFolder,
  westWorkspace: WestWorkspace,
  zephyrBoard: ZephyrBoard,
  toolchainInstallation: ZephyrSdkInstallation | IarToolchainInstallation | ArmGnuToolchainInstallation,
  options: DefaultProjectSettingsOptions
): Promise<boolean> {
  const { config, settingsJsonPath, serialized, directWriteSupported } = await ensureSettingsFile(workspaceFolder);
  if (!directWriteSupported) {
    return false;
  }

  const { values, deleteKeys } = buildDefaultApplicationSettings(
    workspaceFolder,
    westWorkspace,
    zephyrBoard,
    toolchainInstallation,
    options,
    true,
  );

  for (const [key, value] of Object.entries(values)) {
    const fullKey = `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${key}`;
    config[fullKey] = key === 'build.configurations'
      ? upsertPrimaryBuildConfig(config[fullKey], zephyrBoard.identifier ?? '')
      : value;
  }

  for (const key of deleteKeys) {
    delete config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${key}`];
  }

  config['cmake.configureOnOpen'] = false;
  config['cmake.enableAutomaticKitScan'] = false;

  await writeSettingsJson(settingsJsonPath, config, serialized);
  return true;
}

async function applyDefaultProjectSettingsViaConfigurationApi(
  workspaceFolder: vscode.WorkspaceFolder,
  westWorkspace: WestWorkspace,
  zephyrBoard: ZephyrBoard,
  toolchainInstallation: ZephyrSdkInstallation | IarToolchainInstallation | ArmGnuToolchainInstallation,
  options: DefaultProjectSettingsOptions
): Promise<void> {
  const config = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder);
  const { values, deleteKeys } = buildDefaultApplicationSettings(
    workspaceFolder,
    westWorkspace,
    zephyrBoard,
    toolchainInstallation,
    options,
    true,
  );

  for (const [key, value] of Object.entries(values)) {
    const nextValue = key === 'build.configurations'
      ? upsertPrimaryBuildConfig(config.get<any[]>('build.configurations') ?? [], zephyrBoard.identifier ?? '')
      : value;
    await config.update(key, nextValue, vscode.ConfigurationTarget.WorkspaceFolder);
  }

  for (const key of deleteKeys) {
    await config.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  }

  try {
    await vscode.workspace.getConfiguration('cmake', workspaceFolder).update('configureOnOpen', false, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration('cmake', workspaceFolder).update('enableAutomaticKitScan', false, vscode.ConfigurationTarget.WorkspaceFolder);
  } catch (e) {
    vscode.window.showWarningMessage('Cannot setup cmake setting on project');
  }

}

export class ZephyrTaskProvider implements vscode.TaskProvider {
  static ZephyrType: string = ZEPHYR_TASK_TYPE;

  public async provideTasks(_token: vscode.CancellationToken): Promise<vscode.Task[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const applications = await ZephyrApplication.getApplications(folders);

    const tasks: vscode.Task[] = [];
    for (const application of applications) {
      const task = buildDirectTask(application.appWorkspaceFolder, 'West Build', undefined, {}, application);
      if (task) {
        tasks.push(task);
      }
    }
    return tasks;
  }

  public resolveTask(_task: vscode.Task, _token: vscode.CancellationToken): vscode.Task | undefined {
    return ZephyrTaskProvider.resolve(_task);
  }

  static resolve(_task: vscode.Task): vscode.Task {
    const folder = _task.scope as vscode.WorkspaceFolder;
    const appRootPath = typeof _task.definition.__appRootPath === 'string'
      ? _task.definition.__appRootPath
      : undefined;
    let project: ZephyrApplication;
    if (appRootPath) {
      const entry = findContainingWorkspaceApplicationEntry(folder, appRootPath);
      const resolvedPath = entry ? resolveWorkspaceApplicationPath(entry, folder) : undefined;
      if (entry && resolvedPath) {
        project = new ZephyrApplication(folder, resolvedPath, { workspaceApplicationSettings: entry });
      } else if (WestWorkspace.isWestWorkspaceFolder(folder)) {
        throw new Error('The selected West workspace application is not linked in this workspace.');
      } else {
        project = new ZephyrApplication(folder, appRootPath);
      }
    } else {
      const entry = getEffectiveWorkspaceApplicationEntry(folder);
      const resolvedPath = entry ? resolveWorkspaceApplicationPath(entry, folder) : undefined;
      if (entry && resolvedPath) {
        project = new ZephyrApplication(folder, resolvedPath, { workspaceApplicationSettings: entry });
      } else if (WestWorkspace.isWestWorkspaceFolder(folder)) {
        throw new Error('Select a West workspace application before running this task.');
      } else {
        project = new ZephyrApplication(folder, folder.uri.fsPath);
      }
    }
    const activeZephyrSdkInstallation = tryGetZephyrSdkInstallation(project.zephyrSdkPath);
    const westWorkspace = getWestWorkspace(project.westWorkspaceRootPath);
    const shellExe = getShellExe();
    const shellKind = getShell();
    // Cygwin's bash needs --login -i to source the user profile and CHERE_INVOKING=1 to honor cwd;
    // MSYS2 / Git Bash classify as 'bash' but don't have these quirks.
    const cygwin = isCygwin(shellExe);
    const shellArgs: string[] = cygwin
      ? ['--login', '-i', ...getShellArgs(shellKind)]
      : getShellArgs(shellKind);

    let config = undefined;

    if (_task.definition.config) {
      config = project.getBuildConfiguration(_task.definition.config);
    }

    let cmd = _task.definition.command;
    // FIXME: Changes on multibuild build process
    // let args = _task.definition.args.map((arg: string) => {
    //   if (arg.startsWith('--build-dir')) {
    //     // Do not add user any --build-dir option, use value from BUILD_DIR variable
    //     return '';
    //   } else if (arg.startsWith('--board ')) {
    //     // To avoid error with legacy tasks, if --board argument is set, remove it, west will
    //     // use BOARD environment variable instead
    //     return '';
    //   }
    //   return arg;
    // }).join(' ');
    // args = `${args} --build-dir ${buildDirVar}`;
    let args = _task.definition.args.join(' ');

    // If a default runner is set on the build configuration, inject it to avoid prompting
    // We look for the input token rather than the task label to support temporary tasks like "West Flash [cfg]".
    if (config && config.defaultRunner && config.defaultRunner.length > 0 && args.includes("${input:west.runner}")) {
      args = args.replace("${input:west.runner}", `--runner ${config.defaultRunner}`);
      // Append optional runner arguments exactly as provided by the user.
      if (config.customArgs && config.customArgs.length > 0) {
        args = `${args} ${config.customArgs.trim()}`;
      }
    }

    const isWestBuildTask = cmd === 'west' && Array.isArray(_task.definition.args) && _task.definition.args[0] === 'build';
    let fullCommand = `${cmd} ${args}`;

    const envScript = getConfiguredWorkbenchPath(
      ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY,
      folder ?? project.appWorkspaceFolder,
    );
    const venvPath = project.venvPath ?? getConfiguredVenvPath(folder ?? project.appWorkspaceFolder);

    if (!envScript) {
      throw new Error('Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Zephyr Workbench > Path To Env Script',
        { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` });
    }
    if (!cmd || cmd.length === 0) {
      throw new Error('Missing command to execute');
    }

    let envSourceCmd = `source ${envScript}`;
    if (shellKind === 'cmd.exe') {
      envSourceCmd = `call ${envScript}`;
    } else if (shellKind === 'powershell.exe' || shellKind === 'pwsh.exe') {
      envSourceCmd = `. ${envScript}`;
    }

    let options: vscode.ShellExecutionOptions = {
      executable: shellExe,
      shellArgs: shellArgs,
      env: {
        ...(cygwin ? { CHERE_INVOKING: '1' } : {}),
        ...(activeZephyrSdkInstallation?.buildEnvWithVar ?? {}),
        ...westWorkspace.buildEnvWithVar
      },
    };

    const cfg = vscode.workspace.getConfiguration(
      ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, folder);
    const toolchainVariant = project.toolchainVariant
      ?? normalizeStoredToolchainVariant(cfg, cfg.get<string>("toolchain") ?? "zephyr");
    const toolchainEnv = project.getToolchainEnv();

    if ((toolchainVariant === 'iar' || toolchainVariant === 'gnuarmemb') && Object.keys(toolchainEnv).length === 0) {
      const missingPath = toolchainVariant === 'iar'
        ? (getConfiguredWorkbenchPath(ZEPHYR_PROJECT_IAR_SETTING_KEY, folder ?? project.appWorkspaceFolder) ?? '')
        : (getConfiguredWorkbenchPath(ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY, folder ?? project.appWorkspaceFolder) ?? '');
      const label = toolchainVariant === 'iar' ? 'IAR' : 'Arm GNU';
      vscode.window.showWarningMessage(
        `${label} toolchain "${missingPath}" not found; tasks will run with the default Zephyr SDK.`,
      );
    }

    options.env = { ...options.env, ...toolchainEnv };

    if (isWestBuildTask && config && westWorkspace) {
      const parsedTaskOptions = parseWestBuildTaskOptions(_task.definition.args);
      const rawWestArgsOverride = typeof _task.definition.__rawWestArgs === 'string'
        ? _task.definition.__rawWestArgs
        : undefined;
      const execution = prepareWestBuildExecution(
        project,
        westWorkspace,
        config,
        {
          pristine: parsedTaskOptions.pristine,
          target: parsedTaskOptions.target,
          additionalCmakeArgs: parsedTaskOptions.additionalCmakeArgs,
          rawWestArgsOverride,
        },
      );

      fullCommand = execution.command;
      options.env = execution.env;
      if (execution.needsConfigure) {
        (_task.definition as Record<string, unknown>).__westBuildStatePath = execution.buildDirPath;
        (_task.definition as Record<string, unknown>).__westBuildState = JSON.stringify(execution.buildState);
      }
    } else if (config) {
      options.env = { ...options.env, ...config.getBuildEnvWithVar(project) };
    }

    if (venvPath) {
      options.env = {
        PYTHON_VENV_PATH: venvPath,
        ...options.env
      };
    }

    if (_task.definition.options) {
      if (_task.definition.options.cwd) {
        options.cwd = _task.definition.options.cwd;
      }

      if (_task.definition.options.env) {
        options.env = { ...options.env, ..._task.definition.options.env };
      }
    }

    const shellExecution = new vscode.ShellExecution(concatCommands(shellKind, envSourceCmd, fullCommand), options);
    const resolvedTask = new vscode.Task(
      _task.definition,
      _task.scope as vscode.WorkspaceFolder,
      _task.name,
      'Zephyr Workbench',
      shellExecution,
      _task.problemMatchers
    );

    if (_task.group) {
      resolvedTask.group = _task.group;
    }
    if (_task.detail) {
      resolvedTask.detail = _task.detail;
    }

    return resolvedTask;
  }
}

export async function checkAndCreateTasksJson(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
  const prjConfPath = path.join(workspaceFolder.uri.fsPath, 'prj.conf');
  if (fs.existsSync(prjConfPath)) {
    await createTasksJson(workspaceFolder);
  }
}

export async function createTasksJson(workspaceFolder: vscode.WorkspaceFolder, options?: CreateTasksJsonOptions): Promise<void> {
  const project = new ZephyrApplication(workspaceFolder, workspaceFolder.uri.fsPath);
  const westWorkspace = options?.westWorkspace ?? getWestWorkspace(project.westWorkspaceRootPath);

  if (!westWorkspace) {
    return;
  }

  const { config, tasksJsonPath, serialized } = await ensureTasksFile(workspaceFolder);

  let changed = false;

  if (!config.version) {
    config.version = "2.0.0";
    changed = true;
  }

  if (changed) {
    await writeTasksJson(tasksJsonPath, config, serialized);
  }
}

// Tasks that run directly without being persisted to tasks.json.
const DIRECT_TASKS = new Set<string>([
  'West Build',
  'West Rebuild',
  'West Flash',
  'DT Doctor',
  'West ROM Report',
  'West RAM Report',
  'West RAM Plot',
  'West ROM Plot',
  'Menuconfig',
  'Gui config',
  'Harden Config',
]);

const SYSBUILD_UNSUPPORTED_TASKS = new Set<string>([
  'West ROM Report',
  'West RAM Report',
  'West RAM Plot',
  'West ROM Plot',
]);

export function isDirectTask(taskName: string): boolean {
  return DIRECT_TASKS.has(taskName);
}

export interface FlashRunnerSelection {
  runner: string;
  customArgs?: string;
}

export interface BuildDirectTaskOptions {
  flashRunner?: string;
  flashRunnerArgs?: string;
  rawWestArgsOverride?: string;
}

function getFlashRunnerPickItems(
  project: ZephyrApplication,
  config: ZephyrBuildConfig,
): vscode.QuickPickItem[] {
  const runnersYaml = readRunnersYamlForProject(project, config);
  const compatibleRunners = runnersYaml?.runners ?? [];
  const names = compatibleRunners.length > 0
    ? compatibleRunners
    : getStaticFlashRunnerNames();
  const defaultRunner = runnersYaml?.defaultFlashRunner;
  const ordered = defaultRunner && names.includes(defaultRunner)
    ? [defaultRunner, ...names.filter(name => name !== defaultRunner)]
    : names;

  return ordered.map(name => ({
    label: name,
    description: compatibleRunners.length > 0 ? 'compatible' : undefined,
    picked: name === defaultRunner,
  }));
}

export async function resolveFlashRunnerSelection(
  project: ZephyrApplication,
  config: ZephyrBuildConfig,
): Promise<FlashRunnerSelection | undefined> {
  if (config.defaultRunner && config.defaultRunner.length > 0) {
    return {
      runner: config.defaultRunner,
      customArgs: config.customArgs,
    };
  }

  const items = getFlashRunnerPickItems(project, config);
  if (items.length === 0) {
    vscode.window.showErrorMessage('No flash runners are available.');
    return undefined;
  }

  const selection = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select flash runner',
  });
  if (!selection) {
    return undefined;
  }

  return { runner: selection.label };
}

/**
 * Default entry point for invoking a Zephyr-Workbench operation programmatically
 * (toolbar buttons, context menus, command palette handlers, etc).
 *
 * Picks the named template from `tasksMap` (e.g. `'West Build'`, `'West Flash'`,
 * `'Menuconfig'`, `'SPDX init'`), splices in the active/given build config's board
 * and build dir, and runs it through `ZephyrTaskProvider.resolve` — so env sourcing,
 * shell selection (zsh/bash/PowerShell/Cygwin/...), toolchain env, and west-build-state
 * tracking happen in exactly one place.
 *
 * Pair the returned task with `executeTask(...)` to run it and await completion.
 * Returns `undefined` if `taskName` is not in `tasksMap`, or if the task is incompatible
 * with the given config (e.g. RAM/ROM Report when sysbuild is enabled).
 *
 * Use this for anything that operates on a project + build config. For workspace-level
 * commands (`west init/update/boards/packages`) or pre-project setup (installs, SDK
 * setup), use the helpers in `execUtils.ts` instead.
 */
export function buildDirectTask(
  workspaceFolder: vscode.WorkspaceFolder,
  taskName: string,
  configName?: string,
  options: BuildDirectTaskOptions = {},
  projectOverride?: ZephyrApplication,
): vscode.Task | undefined {
  const taskDef = tasksMap.get(taskName);
  if (!taskDef) {
    return undefined;
  }

  const project = projectOverride
    ?? (WestWorkspace.isWestWorkspaceFolder(workspaceFolder)
      ? ZephyrApplication.getEffectiveWorkspaceApplication(workspaceFolder)
      : new ZephyrApplication(workspaceFolder, workspaceFolder.uri.fsPath));
  if (!project) {
    vscode.window.showInformationMessage('Select a West workspace application before running this task.');
    return undefined;
  }
  const targetConfig = configName
    ? project.buildConfigs.find(cfg => cfg.name === configName)
    : (project.buildConfigs.find(cfg => cfg.active) ?? project.buildConfigs[0]);

  if (SYSBUILD_UNSUPPORTED_TASKS.has(taskName)) {
    const sysbuildEnabled = targetConfig && String(targetConfig.sysbuild).toLowerCase() === 'true';
    if (sysbuildEnabled) {
      vscode.window.showWarningMessage(`Task "${taskName}" is not supported with sysbuild enabled.`);
      return undefined;
    }
  }

  let taskLabel = taskName;
  let definition: ZephyrTaskDefinition = { ...taskDef, args: [...taskDef.args] };

  if (targetConfig) {
    const buildDirVar = getEnvVarFormat(getShell(), 'BUILD_DIR');
    const args: string[] = [];
    for (const arg of taskDef.args) {
      if (!arg.startsWith('--build-dir') && !arg.startsWith('--board')) {
        args.push(arg);
      }
    }
    if (taskName === 'West Flash' && options.flashRunner) {
      args.push(`--runner ${options.flashRunner}`);
    }
    const subcommand = taskDef.command === 'west' ? taskDef.args[0]?.split(' ')[0] : undefined;
    const skipBoard = subcommand !== undefined && WEST_SUBCOMMANDS_WITHOUT_BOARD.has(subcommand);
    if (!skipBoard && targetConfig.boardIdentifier && targetConfig.boardIdentifier.length > 0) {
      args.push(`--board ${targetConfig.boardIdentifier}`);
    }
    args.push(`--build-dir ${buildDirVar}`);
    if (taskName === 'West Flash' && options.flashRunnerArgs?.trim()) {
      args.push(options.flashRunnerArgs.trim());
    }

    definition = { ...taskDef, config: targetConfig.name, args };
    if (typeof options.rawWestArgsOverride === 'string') {
      (definition as Record<string, unknown>).__rawWestArgs = options.rawWestArgsOverride;
    }
    (definition as Record<string, unknown>).__appRootPath = project.appRootPath;
    taskLabel = `${taskName} [${targetConfig.name}]`;
  }

  const task = new vscode.Task(
    definition,
    workspaceFolder,
    taskLabel,
    ZephyrTaskProvider.ZephyrType,
  );

  const groupKind = typeof definition.group === 'object' ? definition.group?.kind : definition.group;
  if (groupKind === 'build') {
    task.group = vscode.TaskGroup.Build;
  }
  if (targetConfig) {
    task.detail = `Build config: ${targetConfig.name}`;
  }

  return ZephyrTaskProvider.resolve(task);
}

export async function checkOrCreateTask(workspaceFolder: vscode.WorkspaceFolder, taskName: string): Promise<boolean> {
  if (isDirectTask(taskName)) {
    return false;
  }

  const { config, tasksJsonPath, serialized } = await ensureTasksFile(workspaceFolder);
  const taskExists = config.tasks.some(task => task.label === taskName && task.type === ZephyrTaskProvider.ZephyrType);

  if (taskExists) {
    return true;
  }

  const task = tasksMap.get(taskName);
  if (!task) {
    return false;
  }

  if (!config.version) {
    config.version = "2.0.0";
  }

  config.tasks.push({ ...task, args: [...task.args] });
  const wrote = await writeTasksJson(tasksJsonPath, config, serialized);
  if (wrote) {
    // Sleep to let VS Code time to reload the tasks.json
    await msleep(500);
  }
  return true;
}

export interface SaveCustomTaskOptions {
  overwrite?: boolean;
}

export interface SaveCustomTaskResult {
  status: 'added' | 'updated' | 'conflict';
  tasksJsonPath: string;
}

export async function saveCustomTaskDefinition(
  workspaceFolder: vscode.WorkspaceFolder,
  taskDefinition: ZephyrTaskDefinition,
  options: SaveCustomTaskOptions = {},
): Promise<SaveCustomTaskResult> {
  const { config, tasksJsonPath, serialized } = await ensureTasksFile(workspaceFolder);
  const normalizedLabel = taskDefinition.label.trim();

  const nextTask: ZephyrTaskDefinition = {
    ...taskDefinition,
    label: normalizedLabel,
    type: ZEPHYR_TASK_TYPE,
    command: taskDefinition.command.trim(),
    args: Array.isArray(taskDefinition.args)
      ? taskDefinition.args.map(arg => typeof arg === 'string' ? arg : String(arg))
      : [],
  };

  if (!config.version) {
    config.version = "2.0.0";
  }

  const existingIndex = config.tasks.findIndex(task => task && task.label === normalizedLabel);
  if (existingIndex !== -1 && !options.overwrite) {
    return { status: 'conflict', tasksJsonPath };
  }

  if (existingIndex !== -1) {
    config.tasks[existingIndex] = nextTask;
  } else {
    config.tasks.push(nextTask);
  }

  await writeTasksJson(tasksJsonPath, config, serialized);

  return {
    status: existingIndex !== -1 ? 'updated' : 'added',
    tasksJsonPath,
  };
}

/**
 * Update task to adapt to the new active configuration
 * @param workspaceFolder 
 * @param activeConfigName 
 * @param activeIndex 
 * @returns 
 */
export async function updateTasks(workspaceFolder: vscode.WorkspaceFolder, activeConfigName: string, activeIndex: number) {
  const { config, tasksJsonPath, serialized } = await ensureTasksFile(workspaceFolder);
  const regex = /\${config:zephyr-workbench\.build\.configurations\.(\d+)\./;

  let changed = false;
  const updatedTasks = config.tasks.map(task => {
    if (!isWorkbenchTask(task)) {
      return task;
    }

    const updatedTask: any = { ...task };

    if (updatedTask.config !== activeConfigName) {
      updatedTask.config = activeConfigName;
      changed = true;
    }

    if (Array.isArray(updatedTask.args)) {
      updatedTask.args = updatedTask.args.map((arg: string) => {
        const newArg = typeof arg === 'string'
          ? arg.replace(regex, (match, p1) => match.replace(p1, activeIndex.toString()))
          : arg;
        if (newArg !== arg) {
          changed = true;
        }
        return newArg;
      });
    }

    return updatedTask;
  });

  if (changed) {
    config.tasks = updatedTasks;
    const wrote = await writeTasksJson(tasksJsonPath, config, serialized);
    if (wrote) {
      // Sleep to let VS Code time to reload the tasks.json
      await msleep(500);
    }
  }

  return changed;
}

export async function setDefaultWorkspaceApplicationSettings(
  workspaceFolder: vscode.WorkspaceFolder,
  applicationRootPath: string,
  westWorkspace: WestWorkspace,
  zephyrBoard: ZephyrBoard,
  toolchainInstallation: ZephyrSdkInstallation | IarToolchainInstallation | ArmGnuToolchainInstallation,
  options: DefaultProjectSettingsOptions = {},
): Promise<void> {
  const { values, deleteKeys } = buildDefaultApplicationSettings(
    workspaceFolder,
    westWorkspace,
    zephyrBoard,
    toolchainInstallation,
    options,
    false,
  );

  // Workspace applications are declared in the west workspace settings instead
  // of a per-app `.vscode` folder. Keeping the value shape aligned with
  // freestanding settings lets the runtime model parse both modes through the
  // same ZephyrApplication/ZephyrBuildConfig code path.
  await updateWorkspaceApplicationEntry(workspaceFolder, applicationRootPath, previousEntry => {
    const nextEntry = { ...(previousEntry ?? {}) };
    for (const [key, value] of Object.entries(values)) {
      nextEntry[key] = value;
    }
    for (const key of deleteKeys) {
      delete nextEntry[key];
    }
    return nextEntry;
  });

  const entries = readWorkspaceApplicationEntries(workspaceFolder);
  await setSelectedWorkspaceApplicationPath(
    workspaceFolder,
    entries.length > 1 ? applicationRootPath : undefined,
  );

  await writeDefaultCppPropertiesFile(
    workspaceFolder,
    getDefaultCompilerPath(toolchainInstallation, zephyrBoard, options.toolchainVariant),
    path.join(applicationRootPath, 'build', 'primary', 'compile_commands.json'),
    options,
  );
}

/**
 * Set default workspace files for newly created or imported project
 * @param workspaceFolder 
 * @param westWorkspace 
 * @param zephyrBoard 
 * @param toolchainInstallation 
 */
export async function setDefaultProjectSettings(
  workspaceFolder: vscode.WorkspaceFolder,
  westWorkspace: WestWorkspace,
  zephyrBoard: ZephyrBoard,
  toolchainInstallation: ZephyrSdkInstallation | IarToolchainInstallation | ArmGnuToolchainInstallation,
  options: DefaultProjectSettingsOptions = {}
): Promise<void> {
  const directWriteApplied = options.preferConfigurationApi
    ? false
    : await tryWriteDefaultProjectSettingsFile(workspaceFolder, westWorkspace, zephyrBoard, toolchainInstallation, options);
  if (!directWriteApplied) {
    await applyDefaultProjectSettingsViaConfigurationApi(workspaceFolder, westWorkspace, zephyrBoard, toolchainInstallation, options);
  }

  await writeDefaultCppPropertiesFile(
    workspaceFolder,
    getDefaultCompilerPath(toolchainInstallation, zephyrBoard, options.toolchainVariant),
    path.join(workspaceFolder.uri.fsPath, 'build', 'primary', 'compile_commands.json'),
    options,
  );
}
