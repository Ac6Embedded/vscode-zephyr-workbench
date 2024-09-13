import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { WestWorkspace } from './WestWorkspace';
import { ZephyrAppProject } from './ZephyrAppProject';
import { ZephyrBoard } from './ZephyrBoard';
import { ZephyrSDK } from './ZephyrSDK';
import { ZEPHYR_APP_FILENAME, ZEPHYR_DIRNAME, ZEPHYR_PROJECT_BOARD_SETTING_KEY, ZEPHYR_PROJECT_SDK_SETTING_KEY, ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY, ZEPHYR_WORKBENCH_BUILD_PRISTINE_SETTING_KEY, ZEPHYR_WORKBENCH_PATHTOENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_ACTIVATEPATH_SETTING_KEY } from './constants';
import { concatCommands, getShell, getShellArgs } from './execUtils';
import { showPristineQuickPick } from './setupBuildPristineQuickStep';
import { getInternalDirVSCodePath, getSupportedBoards, getWestWorkspace, getZephyrSDK } from './utils';

export interface ZephyrTaskDefinition extends vscode.TaskDefinition {
  label: string;
  type: string;
  command: string;
  args?: string[];
}

export class ZephyrTaskProvider implements vscode.TaskProvider {
  static ZephyrType: string = 'zephyr-workbench';

  public provideTasks(token: vscode.CancellationToken): vscode.Task[] {
    return [];
  }

  public async runPreTask(_task: vscode.Task, project: ZephyrAppProject): Promise<void> {
    const workspaceFolder = project.workspaceFolder;
    
    if(_task.name === 'West Build') {
      // Check pristine option
      let pristineOpt = await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).get(ZEPHYR_WORKBENCH_BUILD_PRISTINE_SETTING_KEY);
      if(!pristineOpt || pristineOpt === '') {
        let pristineValue = await showPristineQuickPick();
        await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).update(ZEPHYR_WORKBENCH_BUILD_PRISTINE_SETTING_KEY, pristineValue, vscode.ConfigurationTarget.WorkspaceFolder);
      }
    }
  }

  public async resolveTask(_task: vscode.Task, token: vscode.CancellationToken): Promise<vscode.Task> {
    const folder = _task.scope as vscode.WorkspaceFolder;
    const project = new ZephyrAppProject(folder, folder.uri.fsPath);
    const activeSdk = getZephyrSDK(project.sdkPath);

    await this.runPreTask(_task, project);

    const westWorkspace = getWestWorkspace(project.westWorkspacePath);
    const cmd = _task.definition.command;
    const args = _task.definition.args.join(' ');
    const envScript = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_PATHTOENV_SCRIPT_SETTING_KEY);
    const activatePath: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, folder).get(ZEPHYR_WORKBENCH_VENV_ACTIVATEPATH_SETTING_KEY);

    if(!envScript) {
      throw new Error('Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Zephyr Workbench > Path To Env Script',
        { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATHTOENV_SCRIPT_SETTING_KEY}` });
    } 
    if(!cmd || cmd.length === 0) {
      throw new Error('Missing command to execute');
    }
  
    const fullCommand = `${cmd} ${args}`;
    const shell: string = getShell();
    const shellArgs: string[] = getShellArgs(shell);
  
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
        options.env = { ...options.env, ..._task.definition.options.cwd };
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
    const tasksJsonContent = {
      version: "2.0.0",
      tasks: [
        {
          label: "West Build",
          type: "zephyr-workbench",
          problemMatcher: [ "$gcc" ],
          group: {
            kind: "build",
            isDefault: true
          },
          command: "west",
          args: [
            "build",
            "-p ${config:zephyr-workbench.build.pristine}",
            "--board ${config:zephyr-workbench.board}",
            "--build-dir " + buildDir
          ]
        },
        {
          label: "Clean",
          type: "zephyr-workbench",
          problemMatcher: [],
          command: "ninja",
          args: [
            "-C " + buildDir,
            "clean",
          ]
        },
        {
          label: "Delete Build",
          type: "zephyr-workbench",
          problemMatcher: [],
          command: "rm",
          args: [
            "-rf " + buildDir,
          ]
        },
        {
          label: "Clean Pristine",
          type: "zephyr-workbench",
          problemMatcher: [],
          command: "ninja",
          args: [
            "-C " + buildDir,
            "pristine",
          ]
        },
        {
          label: "Gui config",
          type: "zephyr-workbench",
          problemMatcher: [],
          command: "west",
          args: [
            "build",
            "-t guiconfig",
            "--board ${config:zephyr-workbench.board}",
            "--build-dir " + buildDir
          ]
        },
        {
          label: "Menuconfig",
          type: "zephyr-workbench",
          command: "west",
          args: [
            "build",
            "-t menuconfig",
            "--board ${config:zephyr-workbench.board}",
            "--build-dir " + buildDir
          ]
        },
        {
          label: "Generate SPDX",
          type: "zephyr-workbench",
          problemMatcher: [],
          command: "west",
          args: [
            "spdx",
            "--init",
            "--build-dir " + buildDir
          ]
        },
        {
          label: "West Flash",
          type: "zephyr-workbench",
          problemMatcher: [],
          command: "west",
          args: [
            "flash",
            "${input:west.runner}",
            "--build-dir " + buildDir
          ]
        }
      ],
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

    // Write tasks.json file
    fs.writeFileSync(tasksJsonPath, JSON.stringify(tasksJsonContent, null, 2));
  }
}

export async function createLaunchJson(workspaceFolder: vscode.WorkspaceFolder, zephyrSDK: ZephyrSDK): Promise<void> {
  const vscodeFolderPath = path.join(workspaceFolder.uri.fsPath, '.vscode');
  const launchJsonPath = path.join(vscodeFolderPath, 'launch.json');
  const project = new ZephyrAppProject(workspaceFolder, workspaceFolder.uri.fsPath);
  const westWorkspace = getWestWorkspace(project.westWorkspacePath);
  let targetBoard;

  const listBoards = await getSupportedBoards(westWorkspace);
  for(let board of listBoards) {
    if(board.identifier === project.boardId) {
      targetBoard = board;
    }
  }
  if(!targetBoard) {
    return;
  }

  let targetArch = targetBoard.arch;
  // Ensure .vscode directory exists
  if (!fs.existsSync(vscodeFolderPath)) {
    fs.mkdirSync(vscodeFolderPath);
  }

  const executable = path.join('${workspaceFolder}', 'build', '${config:zephyr-workbench.board}', ZEPHYR_DIRNAME, ZEPHYR_APP_FILENAME);
  const launchJsonContent = {
    version: "0.2.0",
    configurations: [
      {
        name: "Launch with OpenOCD",
        cwd: "${workspaceFolder}",
        executable: executable,
        request: "launch",
        type: "cortex-debug",
        runToEntryPoint: "main",
        serverpath: "${config:zephyr-workbench.openocd.execPath}",
        servertype: "openocd",
        interface: "swd",
        gdbPath: `${zephyrSDK.getDebuggerPath(targetArch)}`,
        preLaunchTask: "West Build",
        searchDir: [
          "${config:zephyr-workbench.openocd.searchDir}"
        ],
        configFiles: [
          path.join(targetBoard.rootPath,'support','openocd.cfg')
        ]
      },
    ]
  };

  // Write launch.json file
  fs.writeFileSync(launchJsonPath, JSON.stringify(launchJsonContent, null, 2));
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
      "marus25.cortex-debug"
    ]
  };

  // Write extensions.json file
  fs.writeFileSync(extensionsJsonPath, JSON.stringify(extensionsJsonContent, null, 2));

}

export async function setDefaultProjectSettings(workspaceFolder: vscode.WorkspaceFolder, westWorkspace: WestWorkspace, zephyrBoard: ZephyrBoard, zephyrSDK: ZephyrSDK): Promise<void> {
  await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).update(ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY, westWorkspace.rootUri.fsPath, vscode.ConfigurationTarget.WorkspaceFolder);
	await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).update(ZEPHYR_PROJECT_BOARD_SETTING_KEY, zephyrBoard.identifier, vscode.ConfigurationTarget.WorkspaceFolder);
  await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).update(ZEPHYR_PROJECT_SDK_SETTING_KEY, zephyrSDK.rootUri.fsPath, vscode.ConfigurationTarget.WorkspaceFolder);

  try {
    // Hush CMake
    await vscode.workspace.getConfiguration('cmake', workspaceFolder).update('configureOnOpen', false, vscode.ConfigurationTarget.WorkspaceFolder);
  } catch(e) {
    vscode.window.showWarningMessage('Cannot setup cmake setting on project');
  }
  
  try {
    // IntelliSense
    let buildDir = path.join('${workspaceFolder}', 'build', zephyrBoard.identifier);
    let targetArch = zephyrBoard.arch;
    await vscode.workspace.getConfiguration('C_Cpp', workspaceFolder).update('default.compilerPath', zephyrSDK.getCompilerPath(targetArch), vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration('C_Cpp', workspaceFolder).update('default.compileCommands', path.join(buildDir, 'compile_commands.json'), vscode.ConfigurationTarget.WorkspaceFolder);
  } catch(e) {
    vscode.window.showWarningMessage('Cannot setup C/C++ settings on project');
  }
  
}