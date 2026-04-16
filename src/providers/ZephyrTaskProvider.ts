// Zephyr Workbench task provider and helpers.
// Centralizes task definitions plus tasks.json load/merge/save logic to avoid overwriting user content.
import * as fs from 'fs';
import * as fsPromise from 'fs/promises';
import * as path from 'path';
import * as ts from 'typescript';
import * as vscode from 'vscode';
import { WestWorkspace } from '../models/WestWorkspace';
import { ZephyrAppProject } from '../models/ZephyrAppProject';
import { ZephyrBoard } from '../models/ZephyrBoard';
import { ZephyrSDK, IARToolchain } from '../models/ZephyrSDK';
import { ZEPHYR_PROJECT_SDK_SETTING_KEY, ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY, ZEPHYR_PROJECT_IAR_SETTING_KEY, ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY, ZEPHYR_WORKBENCH_BUILD_PRISTINE_SETTING_KEY, ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY } from '../constants';
import { concatCommands, getEnvVarFormat, getShell, getShellArgs } from '../utils/execUtils';
import { getWestWorkspace, getZephyrSDK, findIarEntry, migrateToolchainVariant, msleep } from '../utils/utils';
import { ZephyrProjectBuildConfiguration } from '../models/ZephyrProjectBuildConfiguration';
import { getStaticFlashRunnerNames } from '../utils/debugTools/debugUtils';
import { mergeOpenocdBuildFlag } from '../utils/debugTools/debugToolSelectionUtils';

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

const westBuildTask: ZephyrTaskDefinition = {
  label: "West Build",
  type: "zephyr-workbench",
  problemMatcher: ["$gcc"],
  group: {
    kind: "build",
    isDefault: true
  },
  command: "west",
  config: "primary",
  args: [
    "build",
    "--board ${config:zephyr-workbench.build.configurations.0.board}",
    "--build-dir \"${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}\""
  ]
};

const rebuildTask: ZephyrTaskDefinition = {
  label: "West Rebuild",
  type: "zephyr-workbench",
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
  type: "zephyr-workbench",
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
  type: "zephyr-workbench",
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
  type: "zephyr-workbench",
  command: "west",
  config: "primary",
  args: [
    "build",
    "-t hardenconfig",
    "--board ${config:zephyr-workbench.build.configurations.0.board}",
    "--build-dir \"${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}\""
  ]
};

const spdxInitTask: ZephyrTaskDefinition = {
  label: "Init SPDX",
  type: "zephyr-workbench",
  problemMatcher: [],
  command: "west",
  config: "primary",
  args: [
    "spdx",
    "--init",
    "--build-dir \"${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}\""
  ]
};

const spdxTask: ZephyrTaskDefinition = {
  label: "Generate SPDX",
  type: "zephyr-workbench",
  problemMatcher: [],
  command: "west",
  config: "primary",
  args: [
    "spdx",
    "--build-dir \"${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}\""
  ]
};

const flashTask: ZephyrTaskDefinition = {
  label: "West Flash",
  type: "zephyr-workbench",
  problemMatcher: [],
  command: "west",
  config: "primary",
  args: [
    "flash",
    "${input:west.runner}",
    "--board ${config:zephyr-workbench.build.configurations.0.board}",
    "--build-dir \"${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}\""
  ]
};

const ramReportTask: ZephyrTaskDefinition = {
  label: "West RAM Report",
  type: "zephyr-workbench",
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
  type: "zephyr-workbench",
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
  type: "zephyr-workbench",
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
  type: "zephyr-workbench",
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
  type: "zephyr-workbench",
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
  type: "zephyr-workbench",
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
  [spdxInitTask.label, spdxInitTask],
  [spdxTask.label, spdxTask],
  [flashTask.label, flashTask],
  [ramReportTask.label, ramReportTask],
  [romReportTask.label, romReportTask],
  [ramPlotTask.label, ramPlotTask],
  [romPlotTask.label, romPlotTask],
  [puncoverTask.label, puncoverTask],
  [dtDoctorTask.label, dtDoctorTask]
]);

type TasksJsonConfig = TaskConfig & { inputs?: any[] };
type SettingsJsonConfig = Record<string, any>;

export interface CreateTasksJsonOptions {
  sdkPath?: string;
  westWorkspace?: WestWorkspace;
}

export interface DefaultProjectSettingsOptions {
  pristine?: string;
  venvPath?: string;
}

const runnerPickInput = {
  id: "west.runner",
  type: "pickString",
  description: "Override default runner. Runners can flash and/or debug Zephyr programs.",
  options: [
    "",
    ...getStaticFlashRunnerNames().map(n => `--runner ${n}`)
  ],
  default: ""
};

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

// Make sure the runner pick input exists once; return true if we touched the config.
function ensureRunnerInput(config: TasksJsonConfig): boolean {
  let changed = false;

  if (!config.inputs || !Array.isArray(config.inputs)) {
    config.inputs = [];
    changed = true;
  }

  const hasRunnerInput = config.inputs.some(input => input && input.id === runnerPickInput.id);
  if (!hasRunnerInput) {
    config.inputs.push({ ...runnerPickInput });
    changed = true;
  }

  return changed;
}

// Add any missing Zephyr Workbench tasks without disturbing user-defined tasks.
function ensureTasks(config: TasksJsonConfig, tasks: ZephyrTaskDefinition[]): boolean {
  let changed = false;

  for (const task of tasks) {
    const exists = config.tasks.some(existing => existing.label === task.label && existing.type === task.type);
    if (!exists) {
      config.tasks.push({ ...task, args: [...task.args] });
      changed = true;
    }
  }

  return changed;
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

async function tryWriteDefaultProjectSettingsFile(
  workspaceFolder: vscode.WorkspaceFolder,
  westWorkspace: WestWorkspace,
  zephyrBoard: ZephyrBoard,
  toolchain: ZephyrSDK | IARToolchain,
  options: DefaultProjectSettingsOptions
): Promise<boolean> {
  const { config, settingsJsonPath, serialized, directWriteSupported } = await ensureSettingsFile(workspaceFolder);
  if (!directWriteSupported) {
    return false;
  }

  const boardIdentifier = zephyrBoard.identifier ?? '';
  const buildDir = path.join('${workspaceFolder}', 'build', 'primary');
  const compilerPath = toolchain instanceof ZephyrSDK
    ? toolchain.getCompilerPath(zephyrBoard.arch)
    : toolchain.compilerPath;
  const pristineValue = options.pristine ?? 'auto';

  config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY}`] = westWorkspace.rootUri.fsPath;
  config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_BUILD_PRISTINE_SETTING_KEY}`] = pristineValue;
  config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.build.configurations`] = upsertPrimaryBuildConfig(
    config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.build.configurations`],
    boardIdentifier
  );

  if (toolchain instanceof ZephyrSDK) {
    config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY}`] = 'zephyr_sdk';
    config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_SDK_SETTING_KEY}`] = toolchain.rootUri.fsPath;
    delete config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_IAR_SETTING_KEY}`];
  } else {
    config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY}`] = 'iar';
    config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_IAR_SETTING_KEY}`] = toolchain.iarPath;
    config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_SDK_SETTING_KEY}`] = toolchain.zephyrSdkPath;
  }

  if (options.venvPath) {
    config[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY}`] = options.venvPath;
  }

  config['cmake.configureOnOpen'] = false;
  config['cmake.enableAutomaticKitScan'] = false;
  config['C_Cpp.default.compilerPath'] = compilerPath;
  config['C_Cpp.default.compileCommands'] = path.join(buildDir, 'compile_commands.json');

  await writeSettingsJson(settingsJsonPath, config, serialized);
  return true;
}

async function applyDefaultProjectSettingsViaConfigurationApi(
  workspaceFolder: vscode.WorkspaceFolder,
  westWorkspace: WestWorkspace,
  zephyrBoard: ZephyrBoard,
  toolchain: ZephyrSDK | IARToolchain,
  options: DefaultProjectSettingsOptions
): Promise<void> {
  const boardIdentifier = zephyrBoard.identifier ? zephyrBoard.identifier : '';
  const pristineValue = options.pristine ?? 'auto';

  await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).update(ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY, westWorkspace.rootUri.fsPath, vscode.ConfigurationTarget.WorkspaceFolder);
  if (toolchain instanceof ZephyrSDK) {
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
      .update(ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY, 'zephyr_sdk', vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
      .update(ZEPHYR_PROJECT_SDK_SETTING_KEY, toolchain.rootUri.fsPath, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
      .update(ZEPHYR_PROJECT_IAR_SETTING_KEY, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  } else {
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
      .update(ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY, 'iar', vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
      .update(ZEPHYR_PROJECT_IAR_SETTING_KEY, toolchain.iarPath, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
      .update(ZEPHYR_PROJECT_SDK_SETTING_KEY, toolchain.zephyrSdkPath, vscode.ConfigurationTarget.WorkspaceFolder);
  }
  await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).update(ZEPHYR_WORKBENCH_BUILD_PRISTINE_SETTING_KEY, pristineValue, vscode.ConfigurationTarget.WorkspaceFolder);

  const config = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder);
  const buildConfigs = config.get<any[]>('build.configurations') ?? [];
  const nextBuildConfigs = upsertPrimaryBuildConfig(buildConfigs, boardIdentifier);
  await config.update('build.configurations', nextBuildConfigs, vscode.ConfigurationTarget.WorkspaceFolder);

  if (options.venvPath) {
    await config.update(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY, options.venvPath, vscode.ConfigurationTarget.WorkspaceFolder);
  }

  try {
    await vscode.workspace.getConfiguration('cmake', workspaceFolder).update('configureOnOpen', false, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration('cmake', workspaceFolder).update('enableAutomaticKitScan', false, vscode.ConfigurationTarget.WorkspaceFolder);
  } catch (e) {
    vscode.window.showWarningMessage('Cannot setup cmake setting on project');
  }

  try {
    const buildDir = path.join('${workspaceFolder}', 'build', 'primary');
    const compilerPath = toolchain instanceof ZephyrSDK
      ? toolchain.getCompilerPath(zephyrBoard.arch)
      : toolchain.compilerPath;

    await vscode.workspace.getConfiguration('C_Cpp', workspaceFolder).update(
      'default.compilerPath',
      compilerPath,
      vscode.ConfigurationTarget.WorkspaceFolder
    );
    await vscode.workspace.getConfiguration('C_Cpp', workspaceFolder).update('default.compileCommands', path.join(buildDir, 'compile_commands.json'), vscode.ConfigurationTarget.WorkspaceFolder);
  } catch (e) {
    vscode.window.showWarningMessage('Cannot setup C/C++ settings on project');
  }
}

export class ZephyrTaskProvider implements vscode.TaskProvider {
  static ZephyrType: string = 'zephyr-workbench';

  public provideTasks(token: vscode.CancellationToken): vscode.Task[] {
    return [];
  }

  public resolveTask(_task: vscode.Task, token: vscode.CancellationToken): vscode.Task | undefined {
    return ZephyrTaskProvider.resolve(_task);
  }

  static resolve(_task: vscode.Task): vscode.Task {
    const folder = _task.scope as vscode.WorkspaceFolder;
    const project = new ZephyrAppProject(folder, folder.uri.fsPath);
    const activeSdk = getZephyrSDK(project.sdkPath);
    const westWorkspace = getWestWorkspace(project.westWorkspacePath);
    const shell: string = getShell();
    const shellArgs: string[] = getShellArgs(shell);
    const westArgVar = getEnvVarFormat(shell, 'WEST_ARGS');

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

    const sysbuildEnabled =
      config && String(config.sysbuild).toLowerCase() === "true";

    const sysbuildFlag = sysbuildEnabled ? " --sysbuild" : "";

    const isBuildTask = _task.name === westBuildTask.label || _task.name === rebuildTask.label;
    const isWestBuildTask = cmd === 'west' && Array.isArray(_task.definition.args) && _task.definition.args[0] === 'build';
    const snippets = isBuildTask && config ? config.envVars?.['SNIPPETS'] : undefined;
    const snippetsFlag = Array.isArray(snippets) && snippets.length > 0
      ? snippets.map((s: string) => ` -S ${s}`).join('')
      : '';

    // WEST_ARGS comes from the environment, so the dynamic OPENOCD override must be merged before
    // we decide whether a west build task needs that variable at all.
    const effectiveWestFlagsD = config ? mergeOpenocdBuildFlag(project, config.westArgs, config.westFlagsD) : [];
    const westArgsFlag = isWestBuildTask && config &&
      ((config.westArgs && config.westArgs.length > 0) || effectiveWestFlagsD.length > 0)
      ? ` ${westArgVar}`
      : '';

    const fullCommand = `${cmd} ${args}${sysbuildFlag}${snippetsFlag}${westArgsFlag}`;

    const envScript = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
    let venvPath: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, folder).get(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY);
    if (!venvPath || venvPath.length === 0) {
      venvPath = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, project.workspaceFolder.uri).get(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY);
    }

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
        ...activeSdk.buildEnvWithVar,
        ...westWorkspace.buildEnvWithVar
      },
    };

    const cfg = vscode.workspace.getConfiguration(
      ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, folder);
    const toolchainKind = migrateToolchainVariant(cfg, cfg.get<string>("toolchain") ?? "zephyr");

    if (toolchainKind === "iar") {
      const selectedIarPath = cfg.get<string>("iar", "");
      const iarEntry = findIarEntry(selectedIarPath);

      if (iarEntry) {
        const armSubdir = process.platform === "win32"
          ? path.join(iarEntry.iarPath, "arm")
          : path.posix.join(iarEntry.iarPath, "arm");

        options.env = {
          ...options.env,
          IAR_TOOLCHAIN_PATH: armSubdir,
          ZEPHYR_TOOLCHAIN_VARIANT: "iar",
          IAR_LMS_BEARER_TOKEN: iarEntry.token
        };
      } else {
        vscode.window.showWarningMessage(
          `IAR toolchain "${selectedIarPath}" not found in listIARs; ` +
          `tasks will run with the default Zephyr SDK.`);
      }
    } else {
      options.env = { ...options.env, ZEPHYR_TOOLCHAIN_VARIANT: toolchainKind };
    }

    if (config) {
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
  const project = new ZephyrAppProject(workspaceFolder, workspaceFolder.uri.fsPath);
  const westWorkspace = options?.westWorkspace ?? getWestWorkspace(project.westWorkspacePath);
  const activeSdk = getZephyrSDK(options?.sdkPath ?? project.sdkPath);

  if (!westWorkspace || !activeSdk) {
    return;
  }

  const { config, tasksJsonPath, serialized } = await ensureTasksFile(workspaceFolder);

  let changed = false;

  if (!config.version) {
    config.version = "2.0.0";
    changed = true;
  }

  changed = ensureRunnerInput(config) || changed;
  
  // Only save essential tasks to tasks.json
  const persistentTasks = [westBuildTask, rebuildTask, flashTask, spdxInitTask, spdxTask];
  
  changed = ensureTasks(config, persistentTasks) || changed;

  if (changed) {
    await writeTasksJson(tasksJsonPath, config, serialized);
  }
}

// TODO: Enhace directTasks and reportTasks to be dynamic
export async function checkOrCreateTask(workspaceFolder: vscode.WorkspaceFolder, taskName: string): Promise<boolean> {
  // Tasks that run directly without saving to tasks.json
  const directTasks = ['DT Doctor', 'West ROM Report', 'West RAM Report', 'West RAM Plot', 'West ROM Plot', 'Menuconfig', 'Gui config', 'Harden Config'];
  const { config, tasksJsonPath, serialized } = await ensureTasksFile(workspaceFolder);
  const taskExists = config.tasks.some(task => task.label === taskName && task.type === ZephyrTaskProvider.ZephyrType);

  if (directTasks.includes(taskName)) {
    // Check if task is a RAM/ROM report/plot and sysbuild is enabled (not supported)
    const reportTasks = ['West ROM Report', 'West RAM Report', 'West RAM Plot', 'West ROM Plot'];
    if (reportTasks.includes(taskName)) {
      const project = new ZephyrAppProject(workspaceFolder, workspaceFolder.uri.fsPath);
      const activeConfig = project.configs.find(cfg => cfg.active) ?? project.configs[0];
      const sysbuildEnabled = activeConfig && String(activeConfig.sysbuild).toLowerCase() === "true";

      if (sysbuildEnabled) {
        vscode.window.showWarningMessage(`Task "${taskName}" is not supported with sysbuild enabled.`);
        return false;
      }
    }

    const taskDef = tasksMap.get(taskName);
    if (!taskDef) {
      return false;
    }

    const task = new vscode.Task(taskDef, workspaceFolder, taskName, ZephyrTaskProvider.ZephyrType);
    await vscode.tasks.executeTask(ZephyrTaskProvider.resolve(task));
    return false;
  }

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
  ensureRunnerInput(config);

  config.tasks.push({ ...task, args: [...task.args] });
  const wrote = await writeTasksJson(tasksJsonPath, config, serialized);
  if (wrote) {
    // Sleep to let VS Code time to reload the tasks.json
    await msleep(500);
  }
  return true;
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
    if (task.type !== ZephyrTaskProvider.ZephyrType) {
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
 * @param zephyrSDK 
 */
export async function setDefaultProjectSettings(
  workspaceFolder: vscode.WorkspaceFolder,
  westWorkspace: WestWorkspace,
  zephyrBoard: ZephyrBoard,
  toolchain: ZephyrSDK | IARToolchain,
  options: DefaultProjectSettingsOptions = {}
): Promise<void> {
  const directWriteApplied = await tryWriteDefaultProjectSettingsFile(workspaceFolder, westWorkspace, zephyrBoard, toolchain, options);
  if (!directWriteApplied) {
    await applyDefaultProjectSettingsViaConfigurationApi(workspaceFolder, westWorkspace, zephyrBoard, toolchain, options);
  }
}
