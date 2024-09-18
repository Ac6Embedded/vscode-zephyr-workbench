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

  get autoArgs(buildDir : string): string {
    let cmdArgs = super.get autoArgs(buildDir);
    if(this.serverPath) {
      cmdArgs += ` --jlink ${this.serverPath}`;
    }
    return cmdArgs;
  }
}