import * as vscode from 'vscode';
import fs from 'fs';
import path from "path";
import { fileExists, findTask } from './utils';
import { ZEPHYR_PROJECT_BOARD_SETTING_KEY, ZEPHYR_PROJECT_SDK_SETTING_KEY, ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from './constants';
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

  setBoard(boardId: string) {
    this.boardId = boardId;
  }

  static async isZephyrProjectWorkspaceFolder(folder: vscode.WorkspaceFolder) {
    const westBuildTask = await findTask('West Build', folder);
    if(westBuildTask) {
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
        if(task.label === 'West Build' && task.type === 'zephyr-workbench') {
          return true;
        }
      }
    }
    return false;
  }
}