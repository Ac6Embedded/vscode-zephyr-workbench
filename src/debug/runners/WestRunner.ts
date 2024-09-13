import * as vscode from 'vscode';
import path from "path";
import { ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from "../../constants";

export const ZEPHYR_WORKBENCH_DEBUG_PATH_SETTING_KEY = 'pathExec';

enum RunnerType {
  FLASH,
  DEBUG
}
export class WestRunner {
  name!: string;
  types?: RunnerType[];
  serverPath?: string;
  serverStartedPattern?: string;
  serverAddress?: string;
  serverPort?: string;

  private getSettingKey(key: string): string {
    return `debug.${this.name}.${key}`;
  }

  get executable(): string | undefined {
    if(this.serverPath) {
      return path.basename(this.serverPath);
    } else {
      return undefined;
    }
  }

  getCmdArgs(buildDir : string): string {
    let cmdArgs = `debugserver --runner ${this.name} --build-dir ${buildDir}`;
    if(this.serverPort) {
      cmdArgs += ` --gdb-port ${this.serverPort}`;
    }
    return cmdArgs;
  }

  public loadSettings() {
    let pathExec: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(this.getSettingKey('pathExec'));
    if(pathExec) {
      this.serverPath = pathExec;
    }
  }

  public saveSettings() {
    vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).update(this.getSettingKey('pathExec'), this.serverPath, vscode.ConfigurationTarget.Global);
  }

}