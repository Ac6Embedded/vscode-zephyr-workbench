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

  get autoArgs(): string {
    let cmdArgs = super.autoArgs;
    if(this.serverPath) {
      cmdArgs += ` --pyocd ${this.serverPath}`;
    }
    return cmdArgs;
  }
}
