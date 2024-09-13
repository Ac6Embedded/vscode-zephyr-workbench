import { WestRunner } from "./WestRunner";

export class Openocd extends WestRunner {
  name = 'openocd';
  serverStartedPattern = 'halted due to debug-request, current mode: Thread';
  scriptDir?: string;

  get executable(): string | undefined{
    const exec = super.executable;
    if(!exec) {
      return 'openocd';
    }
  }

  getCmdArgs(buildDir : string): string {
    let cmdArgs = super.getCmdArgs(buildDir);
    if(this.serverPath) {
      cmdArgs += ` --openocd ${this.serverPath}`;
    }
    cmdArgs += ` --openocd-search ${this.scriptDir}`;
    return cmdArgs;
  }

}