import fs from 'fs';
import path from "path";
import { RunnerType, WestRunner } from "./WestRunner";
import { getInternalDirRealPath } from "../../utils";
import { execCommandWithEnv } from '../../execUtils';

export class Openocd extends WestRunner {
  name = 'openocd';
  label = 'OpenOCD';
  binDirPath = 'bin';
  types = [ RunnerType.FLASH, RunnerType.DEBUG ];
  serverStartedPattern = 'halted due to debug-request, current mode: Thread';

  get executable(): string | undefined {
    const exec = super.executable;
    if(!exec) {
      if(process.platform === 'win32') {
        return 'openocd.exe';
      } else {
        return 'openocd';
      }
    }
  }

  get versionRegex(): any | undefined {
    return /Open On-Chip Debugger ([\d.]+)/;
  }

  loadArgs(args: string | undefined) {
    super.loadArgs(args);

    if(args) {
      const pathRegex = /--openocd\s+("[^"]+"|\S+)/;
      const scriptsRegex = /--openocd-search\s+("[^"]+"|\S+)/;
      const pathMatch = args.match(pathRegex);
      const scriptsMatch = args.match(scriptsRegex);

      if(pathMatch) {
        this.serverPath = pathMatch[1];
      } 
      if(scriptsMatch) {
        this.args['scriptDir'] = scriptsMatch[1];
      } 
    }
    
    // Search if serverPath is set in settings
    if(!this.serverPath || this.serverPath.length === 0 ) {
      let pathExecSetting = this.getSetting('pathExec');
      if(pathExecSetting) {
        this.serverPath = pathExecSetting;
      }
    }

    if(args) {
      this.loadUserArgs(args);
    }
  }

  async loadInternalArgs() {
    if(!this.serverPath || this.serverPath.length === 0) {
      this.serverPath = await this.searchServerPath();
    }
  }

  get autoArgs(): string {
    let cmdArgs = super.autoArgs;
    if(this.serverPath && this.serverPath.length !== 0) {
      cmdArgs += ` --openocd ${this.serverPath}`;
    } else {
      let pathExecSetting = this.getSetting('pathExec');
      if(pathExecSetting) {
        cmdArgs += ` --openocd ${pathExecSetting}`;
      }
    }
    
    cmdArgs += ' --config openocd.cfg';
    cmdArgs += ' --config ${workspaceFolder}/build/.debug/${config:zephyr-workbench.board}/gdb.cfg';

    return cmdArgs;
  }

  async searchServerPath(): Promise<string> {
    let internalOpenOCDPath = path.join(getInternalDirRealPath(), 'tools', 'openocd', 'bin', 'openocd');
    try {
      const stats = await fs.promises.stat(internalOpenOCDPath);
      if(stats.isFile()) {
        return internalOpenOCDPath;
      }
    } catch (error: unknown) {
      return '';
    }
    return '';
  }

  async detectVersion(): Promise<string | undefined> {
    if(!this.versionRegex) {
      return undefined;
    }
    
    let execPath = '';
    if(this.serverPath) {
      execPath = this.serverPath;
    } else if(this.getSetting('pathExec')) {
      execPath = this.getSetting('pathExec') as string;
    } else if(this.executable) {
      execPath = this.executable;
    }

    let versionCmd = `${execPath} --version`;
    // Redirect stderr to stdout because openocd prints version on stderr
    versionCmd = `${versionCmd} 2>&1`;
    return new Promise<string | undefined>((resolve, reject) => {
      execCommandWithEnv(`${versionCmd}`, undefined, (error: any, stdout: string, stderr: any) => {
        if (error) {
          resolve(undefined);
        } else if (stderr) {
          resolve(undefined);
        } else {
          if(this.versionRegex) {
            const versionMatch = stdout.match(this.versionRegex);
            if (versionMatch) {
                resolve(versionMatch[1]);
            }
          } 
          reject(undefined);
        }

      });
    });
  }

}