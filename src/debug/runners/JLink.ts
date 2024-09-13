import { WestRunner } from "./WestRunner";

export class JLink extends WestRunner {
  name = 'j-link';
  serverStartedPattern = '';

  get executable(): string | undefined{
    const exec = super.executable;
    if(!exec) {
      return 'jlink';
    }
  }

  getCmdArgs(buildDir : string): string {
    let cmdArgs = super.getCmdArgs(buildDir);
    if(this.serverPath) {
      cmdArgs += ` --jlink ${this.serverPath}`;
    }
    return cmdArgs;
  }
}