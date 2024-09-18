import { WestRunner } from "./WestRunner";

export class Openocd extends WestRunner {
  name = 'openocd';
  serverStartedPattern = 'halted due to debug-request, current mode: Thread';

  get executable(): string | undefined{
    const exec = super.executable;
    if(!exec) {
      return 'openocd';
    }
  }

  loadArgs(args: string) {
    super.loadArgs(args);

    const pathRegex = /--openocd\s+("[^"]+"|\S+)/;
    const scriptsRegex = /--openocd-search\s+("[^"]+"|\S+)/;
    const pathMatch = args.match(pathRegex);
    const scriptsMatch = args.match(scriptsRegex);

    if(pathMatch) {
      this.serverPath = pathMatch[1];
    }
    if(scriptsMatch) {
      this.args['scriptDir'] = scriptsMatch[1];
    } 

    this.loadUserArgs(args);
  }

  get autoArgs(): string {
    let cmdArgs = super.autoArgs;
    if(this.serverPath) {
      cmdArgs += ` --openocd ${this.serverPath}`;
    }
    // if(this.args['scriptDir']) {
    //   cmdArgs += ` --openocd-search ${this.args['scriptDir']}`;
    // }
    return cmdArgs;
  }

}