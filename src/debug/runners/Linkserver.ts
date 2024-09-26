import { RunnerType, WestRunner } from "./WestRunner";

export class Linkserver extends WestRunner {
  name = 'linkserver';
  label = 'LinkServer';
  types = [ RunnerType.FLASH, RunnerType.DEBUG ];
  serverStartedPattern = 'GDB server listening on port';

  get executable(): string | undefined{
    const exec = super.executable;
    if(!exec) {
      return 'LinkServer';
    }
  }

  loadArgs(args: string) {
    super.loadArgs(args);

    const pathRegex = /--linkserver\s+("[^"]+"|\S+)/;
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
      cmdArgs += ` --linkserver ${this.serverPath}`;
    }
    return cmdArgs;
  }
}