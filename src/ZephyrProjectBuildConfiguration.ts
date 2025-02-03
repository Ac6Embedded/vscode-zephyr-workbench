import * as vscode from 'vscode';
import fs from "fs";
import path from 'path';
import yaml from 'yaml';
import { ZephyrProject } from "./ZephyrProject";
import { getBuildEnv, loadConfigEnv } from "./zephyrEnvUtils";
import { concatCommands, getShellClearCommand, getShellEchoCommand, getTerminalShell } from './execUtils';
import { fileExists, getBoardFromIdentifier, getConfigValue, getWestWorkspace, getZephyrSDK } from './utils';
import { ZEPHYR_DIRNAME, ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY } from './constants';

export class ZephyrProjectBuildConfiguration {
  name: string;
  active: boolean = true;
  boardIdentifier!: string;
  // Maybe not allow changing workspace nor sdk, uncomment if needed
  // westWorkspacePath!: string;
  // sdkPath!: string;
  envVars: { [key: string]: any } = {
    CONF_FILE:'',
    EXTRA_CONF_FILE:[],
    EXTRA_DTC_OVERLAY_FILE:[],
    EXTRA_ZEPHYR_MODULES:[]
  };
  westArgs: string = '';
  
  constructor(
    name: string,
  ) {
    this.name = name;
  }

  parseSettings(buildConfig: any, workspaceContext: vscode.WorkspaceFolder) {
    this.active = buildConfig['active'] === "true" ? true : false;
    this.boardIdentifier = buildConfig['board'];
    this.westArgs = buildConfig['west-args'];
    for(let key in this.envVars) {
      const values = loadConfigEnv(workspaceContext, this.name, key);
      if(values) {
        this.envVars[key] = values;
      }
    }
  }

  setBoard(boardIdentifier: string) {
    this.boardIdentifier = boardIdentifier;
  }

  get relativeRootBuildDir(): string {
    return path.join('build', this.name);
  }

  get relativeBuildDir(): string {
    return path.join(this.relativeRootBuildDir);
  }

  get relativeInternalDebugDir(): string {
    return path.join(this.relativeRootBuildDir, '.debug');
  }

  /**
   * Build directory
   */
  getBuildDir(parentProject: ZephyrProject): string {
    return path.join(parentProject.folderPath, this.relativeBuildDir);
  }

  /**
   * Under build directory, the internal debug directory is used to generate wrappers, files, etc...
   * and is not removed after pristine rebuilt. 
   */
  getInternalDebugDir(parentProject: ZephyrProject): string {
    return path.join(parentProject.folderPath, this.relativeInternalDebugDir);
  }

  getBuildEnv(parentProject: ZephyrProject): { [key: string]: string; } {
    let baseEnv: { [key: string]: string; } = {
      BOARD: this.boardIdentifier,
      BUILD_DIR: this.getBuildDir(parentProject),
      WEST_ARGS: this.westArgs
    };

    let additionalEnv = getBuildEnv(this.envVars);
    baseEnv = { ...baseEnv, ...additionalEnv };
    return baseEnv;
  }

  getBuildEnvWithVar(parentProject: ZephyrProject): { [key: string]: string; } {
    let baseEnv: { [key: string]: string; } = {
      BOARD: this.boardIdentifier,
      BUILD_DIR: this.getBuildDir(parentProject),
      WEST_ARGS: this.westArgs
    };

    let additionalEnv = getBuildEnv(this.envVars);
    baseEnv = { ...baseEnv, ...additionalEnv };
    return baseEnv;
  }

  async getCompatibleRunners(parentProject: ZephyrProject): Promise<string[]> {
    let runners: string[] = [];

    // Search in project build directory runners.yaml
    const runnersYAMLFilepath = path.join(this.getBuildDir(parentProject), ZEPHYR_DIRNAME, 'runners.yaml');
    if(fileExists(runnersYAMLFilepath)) {
      const runnersYAMLFile = fs.readFileSync(runnersYAMLFilepath, 'utf8');
      const data = yaml.parse(runnersYAMLFile);
      runners = data.runners;
    }

    // Search in board.cmake if runners.yaml does not exists
    if(runners.length === 0) {
      const westWorkspace = getWestWorkspace(parentProject.westWorkspacePath);
      const board = await getBoardFromIdentifier(this.boardIdentifier, westWorkspace, parentProject, this);
      runners = board.getCompatibleRunners();
    }

    return runners;
  }

  getPyOCDTarget(parentProject: ZephyrProject): string | undefined {
    const runnersYAMLFilepath = path.join(this.getBuildDir(parentProject), ZEPHYR_DIRNAME, 'runners.yaml');
    if(fileExists(runnersYAMLFilepath)) {
      const runnersYAMLFile = fs.readFileSync(runnersYAMLFilepath, 'utf8');
      const data = yaml.parse(runnersYAMLFile);
      const pyOCDArgs = data?.args?.pyocd;
      if (pyOCDArgs) {
        const targetArg = pyOCDArgs.find((arg: string) => arg.startsWith('--target='));
        if (targetArg) {
            return targetArg.split('=')[1];
        }
      }
    }
    return undefined;
  }

  getKConfigValue(parentProject: ZephyrProject, configKey: string): string | undefined {  
    let dotConfig = path.join(this.getBuildDir(parentProject), 'zephyr', '.config');
    if(fileExists(dotConfig)) {
      return getConfigValue(dotConfig, configKey);
    }
	  return undefined;
  }

  private static openTerminal(zephyrProject: ZephyrProject, buildConfig: ZephyrProjectBuildConfiguration): vscode.Terminal {
    const shell = getTerminalShell();
    const zephyrSdk = getZephyrSDK(zephyrProject.sdkPath);
    const westWorkspace = getWestWorkspace(zephyrProject.westWorkspacePath);
    let activatePath: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY);
    if(!activatePath || activatePath.length === 0) {
      activatePath = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, zephyrProject.workspaceFolder.uri).get(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY);
    }

    const opts: vscode.TerminalOptions = {
      name: `${zephyrProject.folderName} (${buildConfig.name}) Terminal`,
      shellPath: `${shell}`,
      env: {...zephyrSdk.buildEnv, ...westWorkspace.buildEnv, ...zephyrProject.buildEnv, ...buildConfig.getBuildEnv(zephyrProject) },
      cwd: fs.existsSync(buildConfig.getBuildDir(zephyrProject)) ? buildConfig.getBuildDir(zephyrProject):zephyrProject.folderPath
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

  static getTerminal(zephyrProject: ZephyrProject, buildConfig: ZephyrProjectBuildConfiguration): vscode.Terminal {
    const terminals = <vscode.Terminal[]>(<any>vscode.window).terminals;
    for(let i=0; i<terminals.length; i++) {
      const cTerminal = terminals[i];
      if(cTerminal.name === `${zephyrProject.folderName} (${buildConfig.name}) Terminal`) {
        return cTerminal;
      }
    }

    let envScript: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
    if(!envScript) {
      throw new Error('Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Ac6 Zephyr');
    } 
  
    let terminal = ZephyrProjectBuildConfiguration.openTerminal(zephyrProject, buildConfig);
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