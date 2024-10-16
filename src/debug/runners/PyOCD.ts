import { RunnerType, WestRunner } from "./WestRunner";

export class PyOCD extends WestRunner {
  name = 'pyocd';
  label = 'pyOCD';
  types = [ RunnerType.FLASH, RunnerType.DEBUG ];
  serverStartedPattern = 'GDB server started on port';

  get executable(): string | undefined{
    const exec = super.executable;
    if(!exec) {
      return 'pyocd';
    }
  }

  get versionRegex(): any | undefined {
    return /([\d.]+)/;
  }

  loadArgs(args: string | undefined) {
    super.loadArgs(args);

    if(args) {
      const pathRegex = /--pyocd\s+("[^"]+"|\S+)/;
      const pathMatch = args.match(pathRegex);

      if(pathMatch) {
        this.serverPath = pathMatch[1];
      } else {
        let pathExecSetting = this.getSetting('pathExec');
        if(pathExecSetting) {
          this.serverPath = pathExecSetting;
        }
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
      cmdArgs += ` --pyocd ${this.serverPath}`;
    }
    return cmdArgs;
  }

  isTargetSupported() {
    const command = 'pyocd list --targets';
  }
}