import path from "path";
import os from 'os';
import { RunnerType, WestRunner } from "./WestRunner";
import { execCommandWithEnv } from "../../execUtils";

export class STM32CubeProgrammer extends WestRunner {
  name = 'stm32cubeprogrammer';
  label = 'STM32CubeProgrammer';
  types = [ RunnerType.FLASH ];
  serverStartedPattern = '';

  get executable(): string | undefined {
    const exec = super.executable;
    if(!exec) {
      if(process.platform === 'win32') {
        return 'STM32_Programmer_CLI.exe';
      } else {
        return 'STM32_Programmer_CLI';
      }
    }
  }

  get versionRegex(): any | undefined {
    return /STM32CubeProgrammer version: ([\d.]+)/;
  }


  loadArgs(args: string | undefined) {
    super.loadArgs(args);

    if(args) {
      const pathRegex = /--extload\s+("[^"]+"|\S+)/;
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
      this.serverPath = this.findSystemCubeProgrammer();
    }

    if(args) {
      this.loadUserArgs(args);
    }
  }

  get autoArgs(): string {
    let cmdArgs = super.autoArgs;
    if(this.serverPath) {
      cmdArgs += ` --extload ${this.serverPath}`;
    }
    return cmdArgs;
  }

  findSystemCubeProgrammer(): string | undefined {
    let directoryPath = '';
    switch(process.platform) {
      case 'win32': {
        directoryPath = path.win32.join('c:\\', 'Program Files', 'STMicroelectronics', 'STM32Cube', 'STM32CubeProgrammer', 'bin');
        break;
      } 
      case 'linux': {
        directoryPath = path.join(os.homedir(), 'STMicroelectronics', 'STM32Cube', 'STM32CubeProgrammer', 'bin');
        break;
      }
      default: {
        return undefined;
      }
    }

    if (this.executable) {
      return path.join(directoryPath, this.executable);
    }
    return undefined;
  }

  async detect(): Promise<boolean> {
    let found = await super.detect();

    if(found) {
      return true;
    }

    return new Promise<boolean>(async (resolve, reject) => {
      let execPath = this.findSystemCubeProgrammer();
      
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
}