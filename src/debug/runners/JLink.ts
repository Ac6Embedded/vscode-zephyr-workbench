import { RunnerType, WestRunner } from "./WestRunner";

export class JLink extends WestRunner {
  name = 'j-link';
  label = 'J-Link';
  types = [ RunnerType.FLASH, RunnerType.DEBUG ];
  serverStartedPattern = '';

  get executable(): string | undefined{
    const exec = super.executable;
    if(!exec) {
      return 'JLinkGDBServer';
    }
  }

  loadArgs(args: string) {
    super.loadArgs(args);

    const pathRegex = /--gdbserver\s+("[^"]+"|\S+)/;
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
      cmdArgs += ` --gdbserver ${this.serverPath}`;
    }
    return cmdArgs;
  }
}