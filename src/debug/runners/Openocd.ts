import { WestRunner } from "./WestRunner";

export class Openocd extends WestRunner {
  name = 'openocd';
  serverStartedPattern = 'halted due to debug-request, current mode: Thread';
  scriptDir?: string;

  getCmdArgs(buildDir : string): string {
    return `${super.getCmdArgs(buildDir)} 
      --openocd ${this.serverPath} 
      --openocd-search ${this.scriptDir}`;
  }

}