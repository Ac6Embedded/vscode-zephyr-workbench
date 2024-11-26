import * as vscode from 'vscode';
import fs from "fs";
import path from 'path';
import { ZephyrProject } from "./ZephyrProject";
import { getBuildEnv, loadConfigEnv } from "./zephyrEnvUtils";
import { getShell, getShellClearCommand } from './execUtils';
import { getWestWorkspace, getZephyrSDK } from './utils';
import { ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY } from './constants';

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
  
  public constructor(
    name: string,
  ) {
    this.name = name;
  }

  public parseSettings(buildConfig: any, workspaceContext: vscode.WorkspaceFolder) {
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

  public setBoard(boardIdentifier: string) {
    this.boardIdentifier = boardIdentifier;
  }

  /**
   * Build directory
   */
  public getBuildDir(parentProject: ZephyrProject): string {
    return path.join(parentProject.folderPath, this.name, this.boardIdentifier);
  }

  /**
   * Under build directory, the internal debug directory is used to generate wrappers, files, etc...
   * and is not removed after pristine rebuilt. 
   */
  public getInternalDebugDir(parentProject: ZephyrProject): string {
    return path.join(parentProject.folderPath, this.name, '.debug', this.boardIdentifier);
  }

  public getBuildEnv(parentProject: ZephyrProject): { [key: string]: string; } {
    let baseEnv: { [key: string]: string; } = {
      BOARD: this.boardIdentifier,
      BUILD_DIR: this.getBuildDir(parentProject)
    };

    let additionalEnv = getBuildEnv(this.envVars);
    baseEnv = { ...baseEnv, ...additionalEnv };
    return baseEnv;
  }

  public getBuildEnvWithVar(parentProject: ZephyrProject): { [key: string]: string; } {
    let baseEnv: { [key: string]: string; } = {
      BOARD: this.boardIdentifier,
      BUILD_DIR: this.getBuildDir(parentProject)
    };

    let additionalEnv = getBuildEnv(this.envVars);
    baseEnv = { ...baseEnv, ...additionalEnv };
    return baseEnv;
  }

  private static openTerminal(zephyrProject: ZephyrProject, buildConfig: ZephyrProjectBuildConfiguration): vscode.Terminal {
    const shell = getShell();
    const zephyrSdk = getZephyrSDK(zephyrProject.sdkPath);
    const westWorkspace = getWestWorkspace(zephyrProject.westWorkspacePath);
    let activatePath: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY);
    if(!activatePath || activatePath.length === 0) {
      activatePath = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, zephyrProject.workspaceFolder.uri).get(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY);
    }

    const opts: vscode.TerminalOptions = {
      name: `${zephyrProject.folderName} (${buildConfig.name}) Terminal`,
      shellPath: `${shell}`,
      env: {...buildConfig.getBuildEnv(zephyrProject), ...zephyrProject.buildEnv, ...westWorkspace.buildEnv, ...zephyrSdk.buildEnv},
      cwd: fs.existsSync(buildConfig.getBuildDir(zephyrProject)) ? buildConfig.getBuildDir(zephyrProject):zephyrProject.folderPath
    };

    const envVars = opts.env || {};
    const printEnvCommand = Object.entries(envVars).map(([key, value]) => {
      if (shell.includes("bash") || shell.includes("sh")) {
        return `echo ${key}="${value}"`;
      } else if (shell.includes("powershell")) {
        return `Write-Output "${key}=${value}"`;
      } else {
        return `echo ${key}="${value}"`;
      }
    }).join(" && ");

    if(activatePath) {
      opts.env =  {
        PYTHON_VENV_ACTIVATE_PATH: activatePath,
        ...opts.env
      };
    }
    let clearCommand = getShellClearCommand(shell);
    const printHeaderCommand = `${clearCommand} && echo "======= Zephyr Workbench Environment =======" && ${printEnvCommand} && echo "============================================"`;
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

    let envScript = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
    if(!envScript) {
      throw new Error('Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Ac6 Zephyr');
    } 
  
    let terminal = ZephyrProjectBuildConfiguration.openTerminal(zephyrProject, buildConfig);
    let srcEnvCmd = `. ${envScript}`;
    if(process.platform === 'win32') {
      srcEnvCmd = `call ${envScript}`;
    }
    terminal.sendText(srcEnvCmd);

    return terminal;
  }
}