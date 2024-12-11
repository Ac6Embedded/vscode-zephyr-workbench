import { RunnerType, WestRunner } from "./WestRunner";

export class JLink extends WestRunner {
  name = 'jlink';
  label = 'J-Link';
  types = [ RunnerType.FLASH, RunnerType.DEBUG ];
  serverStartedPattern = 'GDB Server start settings'; 

  get executable(): string | undefined {
    const exec = super.executable;
    if(!exec) {
      return 'JLinkGDBServer';
    }
  }

  get versionRegex(): any | undefined {
    return /J-Link GDB Server V([\d.]+[a-z]?)/i;
  }

  loadArgs(args: string | undefined) {
    super.loadArgs(args);

    if(args) {
      const pathRegex = /--gdbserver\s+("[^"]+"|\S+)/;
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
      cmdArgs += ` --gdbserver ${this.serverPath}`;
    }
    return cmdArgs;
  }
}