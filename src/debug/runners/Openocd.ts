import fs from 'fs';
import path from "path";
import { RunnerType, WestRunner } from "./WestRunner";
import { getInternalDirRealPath } from "../../utils";

export class Openocd extends WestRunner {
  name = 'openocd';
  label = 'OpenOCD';
  types = [ RunnerType.FLASH, RunnerType.DEBUG ];
  serverStartedPattern = 'halted due to debug-request, current mode: Thread';

  get executable(): string | undefined{
    const exec = super.executable;
    if(!exec) {
      return 'openocd';
    }
  }

  loadArgs(args: string) {
    super.loadArgs(args);

    const pathRegex = /--openocd\s+("[^"]+"|\S+)/;
    const scriptsRegex = /--openocd-search\s+("[^"]+"|\S+)/;
    const pathMatch = args.match(pathRegex);
    const scriptsMatch = args.match(scriptsRegex);

    if(pathMatch) {
      this.serverPath = pathMatch[1];
    } else {
      let pathExecSetting = this.getSetting('pathExec');
      if(pathExecSetting) {
        this.serverPath = pathExecSetting;
      }
    }

    if(scriptsMatch) {
      this.args['scriptDir'] = scriptsMatch[1];
    } 

    this.loadUserArgs(args);
  }

  async loadInternalArgs() {
    if(!this.serverPath || this.serverPath.length === 0) {
      this.serverPath = await this.searchServerPath();
    }
  }

  get autoArgs(): string {
    let cmdArgs = super.autoArgs;
    if(this.serverPath) {
      cmdArgs += ` --openocd ${this.serverPath}`;
    }
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



}