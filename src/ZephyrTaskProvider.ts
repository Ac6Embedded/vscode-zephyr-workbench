import * as fs from 'fs';
import * as fsPromise from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { WestWorkspace } from './WestWorkspace';
import { ZephyrAppProject } from './ZephyrAppProject';
import { ZephyrBoard } from './ZephyrBoard';
import { ZephyrSDK } from './ZephyrSDK';
import { ZEPHYR_PROJECT_BOARD_SETTING_KEY, ZEPHYR_PROJECT_SDK_SETTING_KEY, ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY, ZEPHYR_WORKBENCH_BUILD_PRISTINE_SETTING_KEY, ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY } from './constants';
import { concatCommands, getEnvVarFormat, getShell, getShellArgs } from './execUtils';
import { getWestWorkspace, getZephyrSDK, msleep } from './utils';
import { addConfig } from './zephyrEnvUtils';
import { ZephyrProjectBuildConfiguration } from './ZephyrProjectBuildConfiguration';

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
  problemMatcher: [ "$gcc" ],
  group: {
    kind: "build",
    isDefault: true
  },
  command: "west",
  config: "primary",
  args: [
    "build",
    "-p ${config:zephyr-workbench.build.pristine}",
    "--board ${config:zephyr-workbench.build.configurations.0.board}",
    "--build-dir ${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}"
  ]
};

const rebuildTask: ZephyrTaskDefinition = {
  label: "West Rebuild",
  type: "zephyr-workbench",
  problemMatcher: [ "$gcc" ],
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
    "--build-dir ${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}"
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
    "--build-dir ${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}"
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
    "--build-dir ${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}"
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
    "--build-dir ${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}"
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
    "--build-dir ${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}"
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
    "--build-dir ${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}"
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
    "--build-dir ${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}"
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
    "--build-dir ${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}"
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
    "--build-dir ${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}"
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
    "--build-dir ${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}"
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
  [puncoverTask.label, puncoverTask]
]);

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
    const buildDirVar = getEnvVarFormat(shell, 'BUILD_DIR');
    const westArgVar = getEnvVarFormat(shell, 'WEST_ARGS');

    let config = undefined;

    // Search for configuration
    if(_task.definition.config) {
      config = project.getBuildConfiguration(_task.definition.config); 
    }

    let cmd = _task.definition.command;
    // FIXME: Changes on multibuild build process
    // let args = _task.definition.args.map((arg: string) => {
    //   if (arg.startsWith('--build-dir')) {
    //     // Do not add user any --build-dir option, use value from BUILD_DIR variable
    //     return '';
    //   } else if (arg === '--board ${config:zephyr-workbench.board}') {
    //     // To avoid error with legacy project, if --board argument is set, remove it, west will
    //     // use BOARD environment variable instead
    //     return '';
    //   }
    //   return arg;
    // }).join(' ');
    // args = `${args} --build-dir ${buildDirVar}`;
    let args = _task.definition.args.join(' ');
    if(config) {
      if(config.westArgs && config.westArgs.length > 0) {
        args = `${args} ${westArgVar}`;
      }
    }
    const fullCommand = `${cmd} ${args}`;

    const envScript = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
    let activatePath: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, folder).get(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY);
    if(!activatePath || activatePath.length === 0) {
      activatePath = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, project.workspaceFolder.uri).get(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY);
    }

    if(!envScript) {
      throw new Error('Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Zephyr Workbench > Path To Env Script',
        { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` });
    } 
    if(!cmd || cmd.length === 0) {
      throw new Error('Missing command to execute');
    }

    // Prepend environment script before any command
    let envSourceCmd = `source ${envScript}`;
    if(shell === 'cmd.exe') {
      envSourceCmd = `call ${envScript}`;
    } else if(shell === 'powershell.exe') {
      envSourceCmd = `. ${envScript}`;
    }
    
    // Set shell execution options
    let options: vscode.ShellExecutionOptions = {
      executable: shell,
      shellArgs: shellArgs,
      env: { ...activeSdk.buildEnvWithVar, 
             ...westWorkspace.buildEnvWithVar, 
             ...project.buildEnvWithVar},
    };

    if(config) {
      options.env = { ...options.env, ...config.getBuildEnvWithVar(project) };
    }

    if(activatePath) {
      options.env =  {
        PYTHON_VENV_ACTIVATE_PATH: activatePath,
        ...options.env
      };
    }

    if(_task.definition.options) {
      if(_task.definition.options.cwd) {
        options.cwd = _task.definition.options.cwd;
      }
  
      if(_task.definition.options.env) {
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

// Function to check for prj.conf and create tasks.json
export async function checkAndCreateTasksJson(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
  const prjConfPath = path.join(workspaceFolder.uri.fsPath, 'prj.conf');
  if (fs.existsSync(prjConfPath)) {
    await createTasksJson(workspaceFolder);
  }
}

// Function to create tasks.json file
export async function createTasksJson(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
  const vscodeFolderPath = path.join(workspaceFolder.uri.fsPath, '.vscode');
  const tasksJsonPath = path.join(vscodeFolderPath, 'tasks.json');

  // Ensure .vscode directory exists
  if (!fs.existsSync(vscodeFolderPath)) {
    fs.mkdirSync(vscodeFolderPath);
  }

  const project = new ZephyrAppProject(workspaceFolder, workspaceFolder.uri.fsPath);
  const buildDir = path.join('${workspaceFolder}', 'build', '${config:zephyr-workbench.board}');
  const westWorkspace = getWestWorkspace(project.westWorkspacePath);
  const activeSdk: ZephyrSDK = getZephyrSDK(project.sdkPath);
  if(westWorkspace && activeSdk) {
    const tasksJsonContent:{
      version: string;
      tasks: ZephyrTaskDefinition[];
      inputs: {
        id: string;
        type: string;
        description: string;
        options: string[];
        default: string;
      }[];
    } = {
      version: "2.0.0",
      tasks: [],
      inputs: [
        {
          id: "west.runner",
          type: "pickString",
          description: "Override default runner. Runners can flash and/or debug Zephyr programs.",
          options: [
            "",
            "--runner arc-nsim",
            "--runner blackmagicprobe",
            "--runner bossac",
            "--runner canopen_program",
            "--runner dediprog",
            "--runner dfu-util",
            "--runner esp32",
            "--runner ezflashcli",
            "--runner gd32isp",
            "--runner hifive1",
            "--runner intel_adsp",
            "--runner intel_cyclonev",
            "--runner jlink",
            "--runner linkserver",
            "--runner mdb-hw",
            "--runner mdb-nsim",
            "--runner misc-flasher",
            "--runner nios2",
            "--runner nrfjprog",
            "--runner nrfutil",
            "--runner nsim",
            "--runner nxp_s32dbg",
            "--runner openocd",
            "--runner pyocd",
            "--runner qemu",
            "--runner renode-robot",
            "--runner renode",
            "--runner silabs_commander",
            "--runner spi_burn",
            "--runner stm32cubeprogrammer",
            "--runner stm32flash",
            "--runner teensy",
            "--runner trace32",
            "--runner uf2",
            "--runner xtensa"
          ],
          default: ""
        }
      ]
    };

    tasksJsonContent.tasks.push(
      westBuildTask,
      rebuildTask,
      guiConfigTask,
      menuconfigTask,
      hardenConfigTask,
      spdxInitTask,
      flashTask,
      ramReportTask,
      romReportTask,
      puncoverTask
    );

    // Write tasks.json file
    fs.writeFileSync(tasksJsonPath, JSON.stringify(tasksJsonContent, null, 2));
  }
}

export async function checkOrCreateTask(workspaceFolder: vscode.WorkspaceFolder, taskName: string): Promise<boolean> {
  const vscodeFolderPath = path.join(workspaceFolder.uri.fsPath, '.vscode');
  const tasksJsonPath = path.join(vscodeFolderPath, 'tasks.json');

  try {
      const data = await fsPromise.readFile(tasksJsonPath, 'utf8');
      const config: TaskConfig = JSON.parse(data);
      const taskExists = config.tasks.some(task => task.label === taskName);
      if(taskExists) {
        return true;
      } else {
        const task = tasksMap.get(taskName);
        if(task) {
          config.tasks.push(task);
          await fsPromise.writeFile(tasksJsonPath, JSON.stringify(config, null, 2), 'utf8');
          // Sleep to let VS Code time to reload the tasks.json
          await msleep(500); 
          return true;
        }
      }

  } catch (err) {
    return false;
  }
  return false;
}

/**
 * Update task to adapt to the new active configuration
 * @param workspaceFolder 
 * @param activeConfigName 
 * @param activeIndex 
 * @returns 
 */
export async function updateTasks(workspaceFolder: vscode.WorkspaceFolder, activeConfigName: string, activeIndex: number) {
  const vscodeFolderPath = path.join(workspaceFolder.uri.fsPath, '.vscode');
  const tasksJsonPath = path.join(vscodeFolderPath, 'tasks.json');
  try {
      const data = await fsPromise.readFile(tasksJsonPath, 'utf8');
      const config: TaskConfig = JSON.parse(data);
      const regex = /\${config:zephyr-workbench\.build\.configurations\.(\d+)\./;
      const newTasks = config.tasks.map(task => {
        if(task.type === "zephyr-workbench") {
          // Change active configuration
          task.config = activeConfigName;
          // Update arguments value
          task.args = task.args.map((arg: string) => {
            return arg.replace(regex, (match, p1) => {
              return match.replace(p1, activeIndex.toString());
            });
          });
        }
        return task;
      });      
      config.tasks = newTasks;
      await fsPromise.writeFile(tasksJsonPath, JSON.stringify(config, null, 2), 'utf8');
      // Sleep to let VS Code time to reload the tasks.json
      await msleep(500); 

  } catch (err) {
    return false;
  }
  return false;
}

export async function createExtensionsJson(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
  const vscodeFolderPath = path.join(workspaceFolder.uri.fsPath, '.vscode');
  const extensionsJsonPath = path.join(vscodeFolderPath, 'extensions.json');

  // Ensure .vscode directory exists
  if (!fs.existsSync(vscodeFolderPath)) {
    fs.mkdirSync(vscodeFolderPath);
  }

  // If extensions.json already exists, do not overwrite it
  if(fs.existsSync(extensionsJsonPath)) {
    return;
  }

  // Define extensions.json content
  const extensionsJsonContent = {
    recommendations: [
      "ms-vscode.cpptools-extension-pack",
      "ms-vscode.vscode-embedded-tools",
      "ms-vscode.vscode-serial-monitor",
    ]
  };

  // Write extensions.json file
  fs.writeFileSync(extensionsJsonPath, JSON.stringify(extensionsJsonContent, null, 2));

}

/**
 * Set default settings.json for newly created project
 * @param workspaceFolder 
 * @param westWorkspace 
 * @param zephyrBoard 
 * @param zephyrSDK 
 */
export async function setDefaultProjectSettings(workspaceFolder: vscode.WorkspaceFolder, westWorkspace: WestWorkspace, zephyrBoard: ZephyrBoard, zephyrSDK: ZephyrSDK): Promise<void> {
  // Zephyr Workbench settings
  const boardIdentifier = zephyrBoard.identifier ? zephyrBoard.identifier : '';
  await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).update(ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY, westWorkspace.rootUri.fsPath, vscode.ConfigurationTarget.WorkspaceFolder);
	await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).update(ZEPHYR_PROJECT_BOARD_SETTING_KEY, boardIdentifier, vscode.ConfigurationTarget.WorkspaceFolder);
  await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).update(ZEPHYR_PROJECT_SDK_SETTING_KEY, zephyrSDK.rootUri.fsPath, vscode.ConfigurationTarget.WorkspaceFolder);
  let newConfig = new ZephyrProjectBuildConfiguration('primary');
  newConfig.boardIdentifier = boardIdentifier;
  await addConfig(workspaceFolder, newConfig);

  try {
    // Hush CMake settings
    await vscode.workspace.getConfiguration('cmake', workspaceFolder).update('configureOnOpen', false, vscode.ConfigurationTarget.WorkspaceFolder);
  } catch(e) {
    vscode.window.showWarningMessage('Cannot setup cmake setting on project');
  }
  
  try {
    // IntelliSense settings
    let buildDir = path.join('${workspaceFolder}', 'build', 'primary');
    let targetArch = zephyrBoard.arch;
    await vscode.workspace.getConfiguration('C_Cpp', workspaceFolder).update('default.compilerPath', zephyrSDK.getCompilerPath(targetArch), vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration('C_Cpp', workspaceFolder).update('default.compileCommands', path.join(buildDir, 'compile_commands.json'), vscode.ConfigurationTarget.WorkspaceFolder);
  } catch(e) {
    vscode.window.showWarningMessage('Cannot setup C/C++ settings on project');
  }
  
}