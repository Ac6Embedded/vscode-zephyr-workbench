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
import { concatCommands, getConfiguredVenvPath, getConfiguredWorkbenchPath, getEnvVarFormat, getShell, getShellArgs, toPortableWorkspaceFolderPath } from '../utils/execUtils';
import { getSelectedToolchainVariantEnv, getWestWorkspace, msleep, tryGetZephyrSdkInstallation } from '../utils/utils';
import { getStaticFlashRunnerNames } from '../utils/debugTools/debugUtils';
import { normalizeStoredToolchainVariant } from '../utils/toolchainSelection';
import { prepareWestBuildExecution } from '../utils/zephyr/westBuildExecution';
import { readRunnersYamlForProject } from '../utils/zephyr/runnersYamlUtils';

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
  [dtDoctorTask.label, dtDoctorTask]
]);

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

  const boardIdentifier = zephyrBoard.identifier ?? '';
  const buildDir = path.join(workspaceFolder.uri.fsPath, 'build', 'primary');
  const compilerPath = toolchainInstallation instanceof ZephyrSdkInstallation
    ? toolchainInstallation.getCompilerPath(
        zephyrBoard.arch,
        undefined,
        resolveStoredToolchainVariant(toolchainInstallation, options.toolchainVariant),
      )
    : toolchainInstallation.compilerPath;
  const toolchainVariant = resolveStoredToolchainVariant(toolchainInstallation, options.toolchainVariant);
  const formatPath = (targetPath: string) => formatGeneratedSettingsPath(targetPath, workspaceFolder, options);

  config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY}`] = formatPath(westWorkspace.rootUri.fsPath);
  config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.build.configurations`] = upsertPrimaryBuildConfig(
    config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.build.configurations`],
    boardIdentifier
  );

  if (toolchainInstallation instanceof ZephyrSdkInstallation) {
    config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY}`] = toolchainVariant;
    config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_SDK_SETTING_KEY}`] = formatPath(toolchainInstallation.rootUri.fsPath);
    delete config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_IAR_SETTING_KEY}`];
    delete config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY}`];
  } else if (toolchainInstallation instanceof IarToolchainInstallation) {
    config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY}`] = 'iar';
    config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_IAR_SETTING_KEY}`] = formatPath(toolchainInstallation.iarPath);
    config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_SDK_SETTING_KEY}`] = formatPath(toolchainInstallation.zephyrSdkPath);
    delete config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY}`];
  } else {
    config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY}`] = 'gnuarmemb';
    config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY}`] = formatPath(toolchainInstallation.toolchainPath);
    delete config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_SDK_SETTING_KEY}`];
    delete config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_IAR_SETTING_KEY}`];
  }

  if (options.venvPath) {
    config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY}`] = formatPath(options.venvPath);
  }

  config['cmake.configureOnOpen'] = false;
  config['cmake.enableAutomaticKitScan'] = false;
  config['C_Cpp.default.compilerPath'] = formatPath(ensureWindowsExecutableExtension(compilerPath));
  config['C_Cpp.default.compileCommands'] = formatPath(path.join(buildDir, 'compile_commands.json'));

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
  const boardIdentifier = zephyrBoard.identifier ? zephyrBoard.identifier : '';
  const toolchainVariant = resolveStoredToolchainVariant(toolchainInstallation, options.toolchainVariant);
  const formatPath = (targetPath: string) => formatGeneratedSettingsPath(targetPath, workspaceFolder, options);

  await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).update(
    ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY,
    formatPath(westWorkspace.rootUri.fsPath),
    vscode.ConfigurationTarget.WorkspaceFolder,
  );
  if (toolchainInstallation instanceof ZephyrSdkInstallation) {
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
      .update(ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY, toolchainVariant, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
      .update(ZEPHYR_PROJECT_SDK_SETTING_KEY, formatPath(toolchainInstallation.rootUri.fsPath), vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
      .update(ZEPHYR_PROJECT_IAR_SETTING_KEY, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
      .update(ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  } else if (toolchainInstallation instanceof IarToolchainInstallation) {
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
      .update(ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY, 'iar', vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
      .update(ZEPHYR_PROJECT_IAR_SETTING_KEY, formatPath(toolchainInstallation.iarPath), vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
      .update(ZEPHYR_PROJECT_SDK_SETTING_KEY, formatPath(toolchainInstallation.zephyrSdkPath), vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
      .update(ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  } else {
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
      .update(ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY, 'gnuarmemb', vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
      .update(ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY, formatPath(toolchainInstallation.toolchainPath), vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
      .update(ZEPHYR_PROJECT_SDK_SETTING_KEY, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
      .update(ZEPHYR_PROJECT_IAR_SETTING_KEY, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  }

  const config = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder);
  const buildConfigs = config.get<any[]>('build.configurations') ?? [];
  const nextBuildConfigs = upsertPrimaryBuildConfig(buildConfigs, boardIdentifier);
  await config.update('build.configurations', nextBuildConfigs, vscode.ConfigurationTarget.WorkspaceFolder);

  if (options.venvPath) {
    await config.update(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY, formatPath(options.venvPath), vscode.ConfigurationTarget.WorkspaceFolder);
  }

  try {
    await vscode.workspace.getConfiguration('cmake', workspaceFolder).update('configureOnOpen', false, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration('cmake', workspaceFolder).update('enableAutomaticKitScan', false, vscode.ConfigurationTarget.WorkspaceFolder);
  } catch (e) {
    vscode.window.showWarningMessage('Cannot setup cmake setting on project');
  }

  try {
    const buildDir = path.join(workspaceFolder.uri.fsPath, 'build', 'primary');
    const compilerPath = toolchainInstallation instanceof ZephyrSdkInstallation
      ? toolchainInstallation.getCompilerPath(zephyrBoard.arch, undefined, toolchainVariant)
      : toolchainInstallation.compilerPath;

    await vscode.workspace.getConfiguration('C_Cpp', workspaceFolder).update(
      'default.compilerPath',
      formatPath(ensureWindowsExecutableExtension(compilerPath)),
      vscode.ConfigurationTarget.WorkspaceFolder
    );
    await vscode.workspace.getConfiguration('C_Cpp', workspaceFolder).update('default.compileCommands', formatPath(path.join(buildDir, 'compile_commands.json')), vscode.ConfigurationTarget.WorkspaceFolder);
  } catch (e) {
    vscode.window.showWarningMessage('Cannot setup C/C++ settings on project');
  }
}

export class ZephyrTaskProvider implements vscode.TaskProvider {
  static ZephyrType: string = ZEPHYR_TASK_TYPE;

  public async provideTasks(_token: vscode.CancellationToken): Promise<vscode.Task[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const zephyrFolders = await ZephyrApplication.getApplicationWorkspaceFolders(folders);

    const tasks: vscode.Task[] = [];
    for (const folder of zephyrFolders) {
      const task = buildDirectTask(folder, 'West Build');
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
    const project = new ZephyrApplication(folder, folder.uri.fsPath);
    const activeZephyrSdkInstallation = tryGetZephyrSdkInstallation(project.zephyrSdkPath);
    const westWorkspace = getWestWorkspace(project.westWorkspaceRootPath);
    const shell: string = getShell();
    const shellArgs: string[] = getShellArgs(shell);

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
    const venvPath = getConfiguredVenvPath(folder ?? project.appWorkspaceFolder);

    if (!envScript) {
      throw new Error('Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Zephyr Workbench > Path To Env Script',
        { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` });
    }
    if (!cmd || cmd.length === 0) {
      throw new Error('Missing command to execute');
    }

    let envSourceCmd = `source ${envScript}`;
    if (shell === 'cmd.exe') {
      envSourceCmd = `call ${envScript}`;
    } else if (shell === 'powershell.exe') {
      envSourceCmd = `. ${envScript}`;
    }

    let options: vscode.ShellExecutionOptions = {
      executable: shell,
      shellArgs: shellArgs,
      env: {
        ...(activeZephyrSdkInstallation?.buildEnvWithVar ?? {}),
        ...westWorkspace.buildEnvWithVar
      },
    };

    const cfg = vscode.workspace.getConfiguration(
      ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, folder);
    const toolchainVariant = normalizeStoredToolchainVariant(cfg, cfg.get<string>("toolchain") ?? "zephyr");
    const toolchainEnv = getSelectedToolchainVariantEnv(cfg, folder ?? project.appWorkspaceFolder);

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
      const execution = prepareWestBuildExecution(
        project,
        westWorkspace,
        config,
        {
          pristine: parsedTaskOptions.pristine,
          target: parsedTaskOptions.target,
          additionalCmakeArgs: parsedTaskOptions.additionalCmakeArgs,
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

    const shellExecution = new vscode.ShellExecution(concatCommands(shell, envSourceCmd, fullCommand), options);
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
 * Build and resolve an in-memory Zephyr task for a given build configuration.
 * Returns undefined if the task is unknown or incompatible (e.g. report task with sysbuild).
 */
export function buildDirectTask(
  workspaceFolder: vscode.WorkspaceFolder,
  taskName: string,
  configName?: string,
  options: BuildDirectTaskOptions = {},
): vscode.Task | undefined {
  const taskDef = tasksMap.get(taskName);
  if (!taskDef) {
    return undefined;
  }

  const project = new ZephyrApplication(workspaceFolder, workspaceFolder.uri.fsPath);
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
    if (targetConfig.boardIdentifier && targetConfig.boardIdentifier.length > 0) {
      args.push(`--board ${targetConfig.boardIdentifier}`);
    }
    args.push(`--build-dir ${buildDirVar}`);
    if (taskName === 'West Flash' && options.flashRunnerArgs?.trim()) {
      args.push(options.flashRunnerArgs.trim());
    }

    definition = { ...taskDef, config: targetConfig.name, args };
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

/**
 * Set default settings.json for newly created project
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
}
