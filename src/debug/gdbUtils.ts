import path from "path";
import { formatWindowsPath } from "../utils/utils";

export function getSetupCommands(program: string, serverAddress: string | undefined, serverPort: string | undefined, gdbMode: string = 'program'): any[] {
  let basename = path.basename(program);
  let dirname = path.dirname(program);

  let gdbSetupCommands = [];

  if(!serverAddress) {
    serverAddress = "localhost";
  }

  if(!serverPort) {
    serverPort = "3333";
  }

  gdbSetupCommands.push({ "text": "-environment-cd " +`${formatWindowsPath(dirname)}`});
  gdbSetupCommands.push({ "text": "-target-select remote " + `${serverAddress}:${serverPort}`, "description": "connect to target", "ignoreFailures": false });
  gdbSetupCommands.push({ "text": "-file-exec-and-symbols " + `${basename}`, "description": "load file", "ignoreFailures": false});
  
  if(gdbMode === 'program') {
    gdbSetupCommands.push({ "text": "-interpreter-exec console \"monitor reset\"", "ignoreFailures": false });
    gdbSetupCommands.push({ "text": "-target-download", "description": "flash target", "ignoreFailures": false });
    gdbSetupCommands.push({ "text": "set breakpoint pending on", "description": "Set pending", "ignoreFailures": false });
    gdbSetupCommands.push({ "text": "tbreak main", "description": "Set a breakpoint at main", "ignoreFailures": true });
  }
  return gdbSetupCommands;
}

export function getGdbMode(setupCommands: any[]) {
  if(setupCommands.some(command => 
    command.text === "-target-download" && 
    command.description === "flash target")) {
    return "program";
  } else {
    return "attach";
  }
}