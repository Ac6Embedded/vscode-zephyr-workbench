import { RunnerType, WestRunner } from "./WestRunner";

export class STM32CubeProgrammer extends WestRunner {
  name = 'stm32cubeprogrammer';
  label = 'STM32CubeProgrammer';
  types = [ RunnerType.FLASH ];
  serverStartedPattern = '';

  get executable(): string | undefined {
    const exec = super.executable;
    if(!exec) {
      return 'STM32_Programmer_CLI';
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
}