import * as vscode from 'vscode';
import path from "path";
import { ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from "../../constants";
import { execCommandWithEnv } from '../../execUtils';

export const ZEPHYR_WORKBENCH_DEBUG_PATH_SETTING_KEY = 'pathExec';

export enum RunnerType {
  FLASH,
  DEBUG
}
export class WestRunner {
  name!: string;
  label!: string;
  types?: RunnerType[];
  serverPath?: string;
  serverStartedPattern?: string;
  serverAddress?: string;
  serverPort?: string;
  args: { [key: string]: string } = {};
  userArgs?: string;

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

  loadArgs(args: string) {
  }

  async loadInternalArgs() {
  }

  protected loadUserArgs(args: string) {
    this.userArgs = args.replace(new RegExp(`^.*${this.autoArgs}\\s*`), '');
  }

  getWestDebugArgs(): string {
    return `debugserver --build-dir \${workspaceFolder}/build/\${config:zephyr-workbench.board} ${this.autoArgs} ${this.userArgs}`;
  }

  getWestFlashArgs(): string {
    return `flash --build-dir \${workspaceFolder}/build/\${config:zephyr-workbench.board} ${this.autoArgs} ${this.userArgs}`;
  }

  get autoArgs(): string {
    return `--runner ${this.name}`;
  }

  getSetupCommands(program: string): any[] {
    return [
      { "text": "-target-select remote " + `${this.serverAddress}:${this.serverPort}`, "description": "connect to target", "ignoreFailures": false },
      { "text": "-file-exec-and-symbols " + `${program}`, "description": "load file", "ignoreFailures": false},
      { "text": "-interpreter-exec console \"monitor reset\"", "ignoreFailures": false },
      { "text": "-target-download", "description": "flash target", "ignoreFailures": false },
      { "text": "set breakpoint pending on", "description": "Set pending", "ignoreFailures": false },
      { "text": "tbreak main", "description": "Set a breakpoint at main", "ignoreFailures": true },
    ];
  }

  loadSettings() {
    let pathExec: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(this.getSettingKey('pathExec'));
    if(pathExec) {
      this.serverPath = pathExec;
    }
  }

  updateSettings() {
    vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).update(this.getSettingKey('pathExec'), this.serverPath, vscode.ConfigurationTarget.Global);
  }

  getSetting(key: string): string | undefined {
    return vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(this.getSettingKey(key));
  }

  updateSetting(key: string, value: string) {
    vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).update(this.getSettingKey(key), value);
  }

  async detect(): Promise<boolean> {
    let execPath = '';
    if(this.serverPath) {
      execPath = this.serverPath;
    } else if(this.executable) {
      execPath = this.executable;
    }
    
    try {
      let versionCmd = `${execPath} --version`;
      if(process.platform === 'linux' || process.platform === 'darwin') {
        versionCmd = `${versionCmd} 2>&1`;
      }
      await execCommandWithEnv(`${versionCmd}`);
      return true;
    } catch (error) {
      return false;
    }
  }

  static extractRunner(args: any): string | undefined {
    const runnerRegex = /--runner\s+("[^"]+"|\S+)/;
    const runnerMatch = args.match(runnerRegex);

    if(runnerMatch) {
      return runnerMatch[1];
    }

    return undefined;
  }

}