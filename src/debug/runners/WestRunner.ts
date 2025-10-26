import * as vscode from 'vscode';
import path from "path";
import { ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from "../../constants";
import { execCommandWithEnv } from '../../utils/execUtils';
import { formatWindowsPath } from '../../utils/utils';

export const ZEPHYR_WORKBENCH_DEBUG_PATH_SETTING_KEY = 'pathExec';

export enum RunnerType {
  FLASH,
  DEBUG
}
export class WestRunner {
  name!: string;
  label!: string;
  binDirPath: string = "";
  types?: RunnerType[];
  serverPath?: string;
  serverStartedPattern?: string;
  serverAddress?: string;
  serverPort?: string;
  args: { [key: string]: string } = {};
  userArgs: string = "";

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

  loadArgs(args: string | undefined) {
    if(args) {
      const gdbPortRegex = /gdb-port\s+(\d+)/;
      const gdbPortMatch = args.match(gdbPortRegex);

      if(gdbPortMatch) {
        this.serverPort = gdbPortMatch[1];
      } 
    }
  }

  async loadInternalArgs() {
  }

  protected loadUserArgs(args: string) {
    // For windows, to escape regex special characters
    let autoArgs = this.autoArgs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Strip autoArgs to extract user args
    this.userArgs = args.replace(new RegExp(`^.*${autoArgs}\\s*`), '');
  }

  getWestDebugArgs(relativeBuildDir: string): string {
    return `debugserver --build-dir "\${workspaceFolder}/${relativeBuildDir}" ${this.autoArgs} ${this.userArgs}`;
  }

  getWestFlashArgs(relativeBuildDir: string): string {
    return `flash --build-dir "\${workspaceFolder}/build/${relativeBuildDir}" ${this.autoArgs} ${this.userArgs}`;
  }

  get autoArgs(): string {
    let args = `--runner ${this.name}`;
    if(this.serverPort) {
       args += ` --gdb-port ${this.serverPort}`;
    }
    return args;
  }

  loadSettings() {
    let pathExec: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(this.getSettingKey('pathExec'));
    if(pathExec) {
      this.serverPath = pathExec;
    }
  }

  async updateSettings() {
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).update(this.getSettingKey('pathExec'), this.serverPath, vscode.ConfigurationTarget.Global);
  }

  getSetting(key: string): string | undefined {
    return vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(this.getSettingKey(key));
  }

  async updateSetting(key: string, value: string) {
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).update(this.getSettingKey(key), value);
  }

  async detect(): Promise<boolean> {
    let execPath = '';
    if(this.serverPath) {
      execPath = this.serverPath;
    } else if(this.getSetting('pathExec')) {
      execPath = this.getSetting('pathExec') as string;
    } else if(this.executable) {
      execPath = this.executable;
    }

    if(execPath.includes(' ')) {
      execPath=`"${execPath}"`;
    }

    let versionCmd = `${execPath} --version`;
    if(process.platform === 'linux' || process.platform === 'darwin') {
      versionCmd = `${versionCmd} 2>&1`;
    }
    return new Promise<boolean>((resolve, reject) => {
      execCommandWithEnv(`${versionCmd}`, undefined, (error: any, stdout: string, stderr: any) => {
        if (error) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  async detectVersion(): Promise<string | undefined> {
    if(!this.versionRegex) {
      return undefined;
    }
    
    let execPath = '';
    if(this.serverPath) {
      execPath = this.serverPath;
    } else if(this.executable) {
      execPath = this.executable;
    }

    if(execPath.includes(' ')) {
      execPath=`"${execPath}"`;
    }

    let versionCmd = `${execPath} --version`;
    return new Promise<string | undefined>((resolve) => {
      execCommandWithEnv(versionCmd, undefined, (error: any, stdout: string, stderr: string) => {
        if (error) {
          resolve(undefined);
          return;
        }

        // Merge both outputs, since some tools (e.g., OpenOCD) print version info to stderr
        const output = `${stdout}\n${stderr}`;

        const match = output.match(this.versionRegex);
        if (match) {
          resolve(match[1]);
        } else {
          resolve(undefined);
        }
      });
    });
  }

  get versionRegex(): any | undefined {
    return undefined;
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
