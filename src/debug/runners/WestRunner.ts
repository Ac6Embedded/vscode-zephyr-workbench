import path from "path";

export class WestRunner {
  name!: string;
  serverPath?: string;
  serverStartedPattern?: string;
  serverAddress?: string;
  serverPort?: string;

  get executable(): string | undefined{
    if(this.serverPath) {
      return path.basename(this.serverPath);
    } else {
      return undefined;
    }
  }

  public setServerPath(path: string) {
    this.serverPath = path;
  }

  public setServerAddress(address: string) {
    this.serverAddress = address;
  }

  public setServerPort(port: string) {
    this.serverPort = port;
  }

  getCmdArgs(buildDir : string): string {
    return `debugserver --runner ${this.name} --build-dir ${buildDir}`;
  }

}