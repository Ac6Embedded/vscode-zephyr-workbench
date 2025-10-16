import fs from 'fs';
import path from "path";
import { RunnerType, WestRunner } from "./WestRunner";
import { getInternalDirRealPath } from "../../utils";
import { execCommandWithEnv } from '../../execUtils';

export class Xsdb extends WestRunner {
  name = 'xsdb';
  label = 'XSDB';
  binDirPath = 'bin';
  types = [RunnerType.FLASH, RunnerType.DEBUG];
  serverStartedPattern = 'xsdb>';

  get executable(): string | undefined {
    const exec = super.executable;
    if (!exec) {
      if (process.platform === 'win32') {
        return 'xsdb.exe';
      } else {
        return 'xsdb';
      }
    }
  }

  get versionRegex(): any | undefined {
    return /version\s*([\d.]+)/;
  }

  loadArgs(args: string | undefined) {
    super.loadArgs(args);

    if (args) {
      const pathRegex = /--xsdb\s+("[^"]+"|\S+)/;
      const scriptsRegex = /--xsdb-search\s+("[^"]+"|\S+)/;
      const pathMatch = args.match(pathRegex);
      const scriptsMatch = args.match(scriptsRegex);

      if (pathMatch) {
        this.serverPath = pathMatch[1];
      }
      if (scriptsMatch) {
        this.args['scriptDir'] = scriptsMatch[1];
      }
    }

    // Search if serverPath is set in settings
    if (!this.serverPath || this.serverPath.length === 0) {
      let pathExecSetting = this.getSetting('pathExec');
      if (pathExecSetting) {
        this.serverPath = pathExecSetting;
      }
    }

    if (args) {
      this.loadUserArgs(args);
    }
  }

  async loadInternalArgs() {
    if (!this.serverPath || this.serverPath.length === 0) {
      this.serverPath = await this.searchServerPath();
    }
  }

  get autoArgs(): string {
    let cmdArgs = super.autoArgs;
    if (this.serverPath && this.serverPath.length !== 0) {
      cmdArgs += ` --xsdb ${this.serverPath}`;
    } else {
      let pathExecSetting = this.getSetting('pathExec');
      if (pathExecSetting) {
        cmdArgs += ` --xsdb ${pathExecSetting}`;
      }
    }
    return cmdArgs;
  }

  async searchServerPath(): Promise<string> {
    let internalXsdbPath = path.join(getInternalDirRealPath(), 'tools', 'xsdb', 'bin', 'xsdb');
    try {
      const stats = await fs.promises.stat(internalXsdbPath);
      if (stats.isFile()) {
        return internalXsdbPath;
      }
    } catch (error: unknown) {
      return '';
    }
    return '';
  }

  async detectVersion(): Promise<string | undefined> {
    if (!this.versionRegex) {
      return undefined;
    }

    let execPath = '';
    if (this.serverPath) {
      execPath = this.serverPath;
    } else if (this.getSetting('pathExec')) {
      execPath = this.getSetting('pathExec') as string;
    } else if (this.executable) {
      execPath = this.executable;
    }

    let versionCmd = `${execPath} --version`;
   
    return new Promise<string | undefined>((resolve) => {
      execCommandWithEnv(`${versionCmd}`, undefined, (error: any, stdout: string, stderr: any) => {
        if (error) {
          resolve(undefined);
        }
        
        // If there is something in stderr, but stdout has the version, it should still try to extract
        const output = stdout || stderr;

        if (this.versionRegex) {
          const versionMatch = output.match(this.versionRegex);
          if (versionMatch) {
            resolve(versionMatch[1]);
            return;
          }
        }

      resolve(undefined); 

      });
    });
  }

  static createWorkaroundCfg(parentDir: string) {
    let buildDir = path.join(parentDir, 'build', '.debug');

    if (!fs.existsSync(buildDir)) {
      fs.mkdirSync(buildDir, { recursive: true });
    }
    const cfgPath = path.join(buildDir, 'gdb.cfg');
    const cfgContent = `# gdb.cfg for XSDB (auto-generated) - currently contains no XSDB-specific content\n`;
    fs.writeFileSync(cfgPath, cfgContent);
  }

}