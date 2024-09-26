import { RunnerType, WestRunner } from "./WestRunner";

export class PyOCD extends WestRunner {
  name = 'pyocd';
  label = 'pyOCD';
  types = [ RunnerType.FLASH, RunnerType.DEBUG ];
  serverStartedPattern = '';

  get executable(): string | undefined{
    const exec = super.executable;
    if(!exec) {
      return 'pyocd';
    }
  }

  loadArgs(args: string) {
    super.loadArgs(args);

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


    this.loadUserArgs(args);
  }

  get autoArgs(): string {
    let cmdArgs = super.autoArgs;
    if(this.serverPath) {
      cmdArgs += ` --pyocd ${this.serverPath}`;
    }
    return cmdArgs;
  }
}