import * as vscode from 'vscode';
import fs from 'fs';
import path from "path";
import yaml from 'yaml';
import { fileExists, findTask, getBoardFromIdentifier, getConfigValue, getWestWorkspace, getZephyrSDK } from './utils';
import { ZEPHYR_DIRNAME, ZEPHYR_PROJECT_BOARD_SETTING_KEY, ZEPHYR_PROJECT_EXTRA_WEST_ARGS_SETTING_KEY, ZEPHYR_PROJECT_SDK_SETTING_KEY, ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY, ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY } from './constants';
import { ZephyrTaskProvider } from './ZephyrTaskProvider';
import { concatCommands, getShellClearCommand, getShellEchoCommand, getTerminalShell } from './execUtils';
import { getBuildEnv, loadEnv } from './zephyrEnvUtils';
import { ZephyrProjectBuildConfiguration } from './ZephyrProjectBuildConfiguration';
export class ZephyrProject {
  
  readonly workspaceContext: any;
  readonly sourceDir : string;
  westWorkspacePath!: string;
  sdkPath!: string;
  configs: ZephyrProjectBuildConfiguration[] = [];

  envVars: {[key:string]: any} = {
    EXTRA_CONF_FILE:[],
    EXTRA_DTC_OVERLAY_FILE:[],
    EXTRA_ZEPHYR_MODULES:[],
    SHIELD:[],
  };
  westArgs: string = '';

  static envVarKeys = ['EXTRA_CONF_FILE', 'EXTRA_DTC_OVERLAY_FILE', 'EXTRA_ZEPHYR_MODULES', 'SHIELD'];

  public constructor(
    workspaceContext: any,
    sourceDir: string,
  ) {
    this.workspaceContext = workspaceContext;
    this.sourceDir = sourceDir;
    this.parseSettings();
  }

  private parseSettings() {
    this.westWorkspacePath = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, this.workspaceContext).get(ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY, '');
	  this.sdkPath = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, this.workspaceContext).get(ZEPHYR_PROJECT_SDK_SETTING_KEY, '');
    this.westArgs = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, this.workspaceContext).get(ZEPHYR_PROJECT_EXTRA_WEST_ARGS_SETTING_KEY, '');
    for(let key of Object.keys(this.envVars)) {
      let values = loadEnv(this.workspaceContext, key);
      if(values) {
        this.envVars[key] = values;
      }
    }

    // Parse build configurations
    const buildConfigs: any[] = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, this.workspaceContext).get('build.configurations', []);
    buildConfigs.forEach(buildConfig => {
      let config = new ZephyrProjectBuildConfiguration(buildConfig.name);
      config.parseSettings(buildConfig, this.workspaceContext);
      this.configs.push(config);
    });
  }

  /**
     * The Workspace folder associated with this ZephyrAppProject instance.
     * This is where we search for the variants and workspace-local kits.
     */
  get workspaceFolder(): vscode.WorkspaceFolder {
    return this.workspaceContext;
  }

  /**
   * The folder associated with this ZephyrAppProject.
   * For single-project folders, this is the WorkspaceFolder for historical reasons.
   * For multi-project folders, this is the directory where the ZephyrAppProject lives (this.sourceDir)
   */
  get folderPath(): string {
    return this.sourceDir;
  }

  /**
   * The name of the folder for this ZephyrAppProject instance
   */
  get folderName(): string {
    return path.basename(this.folderPath);
  }

  addBuildConfiguration(config: ZephyrProjectBuildConfiguration) {
    this.configs.push(config);
  }

  getBuildConfiguration(name: string): ZephyrProjectBuildConfiguration | undefined {
    return this.configs.find(config => config.name === name);
  }

  static async isZephyrProjectWorkspaceFolder(folder: vscode.WorkspaceFolder) {
    const westBuildTask = await findTask('West Build', folder);
    if(westBuildTask && westBuildTask.definition.type === ZephyrTaskProvider.ZephyrType) {
      return true;
    }
    return false;
  }

  static isZephyrProjectPath(projectPath: string): boolean {
    const zwFilePath = path.join(projectPath, '.vscode', 'tasks.json');
    if(fileExists(zwFilePath)) {
      const fileContent = fs.readFileSync(zwFilePath, 'utf-8');
      try {
        const jsonData = JSON.parse(fileContent);
        for(let task of jsonData.tasks) {
          if(task.label === 'West Build' && task.type === ZephyrTaskProvider.ZephyrType) {
            return true;
          }
        }
      } catch(e) {
        return false;
      }
    }
    return false;
  }

  private static openTerminal(zephyrProject: ZephyrProject): vscode.Terminal {
    const shell = getTerminalShell();
    const zephyrSdk = getZephyrSDK(zephyrProject.sdkPath);
    const westWorkspace = getWestWorkspace(zephyrProject.westWorkspacePath);
    let activatePath: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY);
    if(!activatePath || activatePath.length === 0) {
      activatePath = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, zephyrProject.workspaceFolder.uri).get(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY);
    }

    const opts: vscode.TerminalOptions = {
      name: zephyrProject.folderName + ' Terminal',
      shellPath: `${shell}`,
      env: { ...westWorkspace.buildEnv, ...zephyrSdk.buildEnv},
      cwd: zephyrProject.folderPath
    };

    const envVars = opts.env || {};

    const echoCommand = getShellEchoCommand(shell);
    const clearCommand = getShellClearCommand(shell);
    const printEnvCommands = Object.entries(envVars).map(([key, value]) => {
      return `${echoCommand} ${key}="${value}"`;
    });
    const printEnvCommand = concatCommands(shell, ...printEnvCommands);

    if(activatePath) {
      opts.env =  {
        PYTHON_VENV_ACTIVATE_PATH: activatePath,
        ...opts.env
      };
    }
    
    const printHeaderCommand = concatCommands(shell,
      `${clearCommand}`,  
      `echo "======= Zephyr Workbench Environment ======="`,
      `${printEnvCommand}`,
      `echo "============================================"`
    );

   const terminal = vscode.window.createTerminal(opts);
    terminal.sendText(printHeaderCommand);
    return terminal;
  }

  static getTerminal(zephyrProject: ZephyrProject): vscode.Terminal {
    const terminals = <vscode.Terminal[]>(<any>vscode.window).terminals;
    for(let i=0; i<terminals.length; i++) {
      const cTerminal = terminals[i];
      if(cTerminal.name === zephyrProject.folderName + ' Terminal') {
        return cTerminal;
      }
    }

    let envScript: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
    if(!envScript) {
      throw new Error('Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Ac6 Zephyr');
    } 
  
    let terminal = ZephyrProject.openTerminal(zephyrProject);
    const shell = getTerminalShell();
    let srcEnvCmd = `. ${envScript}`;
    if(shell === 'powershell.exe') {
      envScript = envScript.replace(/%([^%]+)%/g, '${env:$1}');
      envScript = envScript.replace('env.bat', 'env.ps1');
      srcEnvCmd = `. ${envScript}`;
    } else if(shell === 'cmd.exe'){
      srcEnvCmd = `call ${envScript}`;
    }
    terminal.sendText(srcEnvCmd);

    return terminal;
  }
  
}