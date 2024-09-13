import * as vscode from 'vscode';
import fs from 'fs';
import path from "path";
import yaml from 'yaml';
import { fileExists, findTask, getBoardFromId, getWestWorkspace } from './utils';
import { ZEPHYR_DIRNAME, ZEPHYR_PROJECT_BOARD_SETTING_KEY, ZEPHYR_PROJECT_SDK_SETTING_KEY, ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY, ZEPHYR_WORKBENCH_PATHTOENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from './constants';
import { ZephyrTaskProvider } from './ZephyrTaskProvider';
import { getShell } from './execUtils';
export class ZephyrProject {
  
  readonly workspaceContext: any;
  readonly sourceDir : string;
  boardId!: string;
  westWorkspacePath!: string;
  sdkPath!: string;


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
	  this.boardId = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, this.workspaceContext).get(ZEPHYR_PROJECT_BOARD_SETTING_KEY, '');
    this.sdkPath = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, this.workspaceContext).get(ZEPHYR_PROJECT_SDK_SETTING_KEY, '');

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
  
  get buildDir(): string {
    return path.join(this.folderPath, 'build', this.boardId);
  }

  get buildEnv(): { [key: string]: string; } {
    return {
      BOARD: this.boardId
    };
  }

  get buildEnvWithVar(): { [key: string]: string; } {
    return {
      BOARD: this.boardId
    };
  }

  setBoard(boardId: string) {
    this.boardId = boardId;
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
      const jsonData = JSON.parse(fileContent);
      for(let task of jsonData.tasks) {
        if(task.label === 'West Build' && task.type === ZephyrTaskProvider.ZephyrType) {
          return true;
        }
      }
    }
    return false;
  }

  public async getCompatibleRunners(): Promise<string[]> {
    let runners: string[] = [];

    // Search in project build directory runners.yaml
    const runnersYAMLFilepath = path.join(this.buildDir, ZEPHYR_DIRNAME, 'runners.yaml');
    if(fileExists(runnersYAMLFilepath)) {
      const runnersYAMLFile = fs.readFileSync(runnersYAMLFilepath, 'utf8');
      const data = yaml.parse(runnersYAMLFile);
      runners = data.runners;
    }

    // Search in board.cmake if runners.yaml does not exists
    if(runners.length === 0) {
      const westWorkspace = getWestWorkspace(this.westWorkspacePath);
      const board = await getBoardFromId(this.boardId, westWorkspace);
      runners = board.getCompatibleRunners();
    }

    return runners;
  }

  private static openTerminal(zephyrProject: ZephyrProject): vscode.Terminal {
    const shell = getShell();
    const westWorkspace = getWestWorkspace(zephyrProject.westWorkspacePath);
    
    const opts: vscode.TerminalOptions = {
      name: zephyrProject.folderName + ' Terminal',
      shellPath: `${shell}`,
      env: {...zephyrProject.buildEnvWithVar, ...westWorkspace.buildEnv},
      cwd: zephyrProject.folderPath
    };
    const terminal = vscode.window.createTerminal(opts);
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

    let envScript = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_PATHTOENV_SCRIPT_SETTING_KEY);
    if(!envScript) {
      throw new Error('Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Ac6 Zephyr');
    } 
  
    let terminal = ZephyrProject.openTerminal(zephyrProject);
    let srcEnvCmd = `. ${envScript}`;
    if(process.platform === 'win32') {
      srcEnvCmd = `call ${envScript}`;
    }
    terminal.sendText(srcEnvCmd);

    // terminal.sendText("# =========================================================");
    // terminal.sendText("# TEST");
    // terminal.sendText("# =========================================================");

    return terminal;
  }
}