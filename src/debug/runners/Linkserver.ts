import fs from "fs";
import { RunnerType, WestRunner } from "./WestRunner";
import { compareVersions } from "../../utils";
import path from "path";
import { execPath } from "process";
import { execCommandWithEnv } from "../../execUtils";

export class Linkserver extends WestRunner {
  name = 'linkserver';
  label = 'LinkServer';
  types = [ RunnerType.FLASH, RunnerType.DEBUG ];
  serverStartedPattern = 'GDB server listening on port';

  get executable(): string | undefined{
    const exec = super.executable;
    if(!exec) {
      if(process.platform === 'win32') {
        return 'LinkServer.exe';
      } else {
        return 'LinkServer';
      }
    }
  }

  get versionRegex(): any | undefined {
    return /v([\d.]+)/;
  }

  loadArgs(args: string | undefined) {
    super.loadArgs(args);

    if(args) {
      const pathRegex = /--linkserver\s+("[^"]+"|\S+)/;
      const pathMatch = args.match(pathRegex);
      if(pathMatch) {
        this.serverPath = pathMatch[1];
      }
    }
    
    // Search if serverPath is set in settings
    if(!this.serverPath || this.serverPath.length === 0 ) {
      let pathExecSetting = this.getSetting('pathExec');
      if(pathExecSetting) {
        this.serverPath = pathExecSetting;
      }
    }

    // Search in system
    if(!this.serverPath || this.serverPath.length === 0 ) {
      this.serverPath = this.findSystemLinkServer();
    }

    if(args) {
      this.loadUserArgs(args);
    }
  }

  async detect(): Promise<boolean> {
    let found = await super.detect();

    if(found) {
      return true;
    }

    return new Promise<boolean>(async (resolve, reject) => {
      let execPath = await this.findSystemLinkServer();
      
      if (!execPath) {
        resolve(false);
        return;
      }

      let versionCmd = `${execPath} --version`;
      if(process.platform === 'linux' || process.platform === 'darwin') {
        versionCmd = `${versionCmd} 2>&1`;
      }
      
      execCommandWithEnv(`${versionCmd}`, undefined, (error: any, stdout: string, stderr: any) => {
        if (error) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
    
  }

  findSystemLinkServer(): string | undefined {
    let directoryPath = '';
    switch(process.platform) {
      case 'win32': {
        directoryPath = path.win32.join('c:\\', 'NXP');
        break;
      } 
      case 'linux': {
        directoryPath = '/usr/local';
        break;
      }
      case 'darwin': {
        directoryPath = '/Applications';
        break;
      }
    }

    const latestFile = this.findLatestVersion(directoryPath);

    if (latestFile && this.executable) {
      return path.join(latestFile, this.executable);
    }

    return undefined;
  }

  getVersionFromPath(filePath: string): string | null {
    const match = filePath.match(/LinkServer_(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  }

  findLatestVersion(directory: string): string | null {
    try {
      const files = fs.readdirSync(directory);
      
      if (files.length === 0) {
        return null;
      }
  
      let latestVersion: string | null = null;
      let latestFilePath: string | null = null;
  
      for (const file of files) {
        const filePath = path.join(directory, file);
        const version = this.getVersionFromPath(filePath);
  
        if (version) {
          if (!latestVersion || compareVersions(version, latestVersion) > 0) {
            latestVersion = version;
            latestFilePath = filePath;
          }
        }
      }
  
      return latestFilePath;
    } catch (error) {
      return null;
    }
  }
  
  get autoArgs(): string {
    let cmdArgs = super.autoArgs;

    if(this.serverPath) {
      cmdArgs += ` --linkserver ${this.serverPath}`;
    } else {

      let pathExecSetting = this.getSetting('pathExec');
      if(pathExecSetting) {
        cmdArgs += ` --linkserver ${pathExecSetting}`;
      } else {
        // Search in system
        let pathExec = this.findSystemLinkServer();
        if(pathExec && pathExec.length > 0) {
          cmdArgs += ` --linkserver ${pathExec}`;
        }
      }
      
    }
    return cmdArgs;
  }
}