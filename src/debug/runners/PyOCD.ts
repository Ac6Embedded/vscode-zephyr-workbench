import { quoteIfNeeded } from "../../utils/shellQuoting";
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
      // One argument, even with a space in the path.
      cmdArgs += ` --pyocd ${quoteIfNeeded(this.serverPath)}`;
    }
    return cmdArgs;
  }
}
