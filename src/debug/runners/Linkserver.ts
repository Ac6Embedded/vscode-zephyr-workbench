import { WestRunner } from "./WestRunner";

export class Linkserver extends WestRunner {
  name = 'linkserver';
  serverStartedPattern = 'halted due to debug-request, current mode: Thread';

  get executable(): string | undefined{
    const exec = super.executable;
    if(!exec) {
      return 'LinkServer';
    }
  }

  getCmdArgs(buildDir : string): string {
    let cmdArgs = super.getCmdArgs(buildDir);
    if(this.serverPath) {
      cmdArgs += ` --linkserver ${this.serverPath}`;
    }
    return cmdArgs;
  }
}