import path from "path";
import { formatWindowsPath } from "../utils/utils";

export function getSetupCommands(program: string, serverAddress: string | undefined, serverPort: string | undefined, gdbMode: string = 'program', runnerName?: string): any[] {
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
    // QEMU starts halted (-S) with the ELF already loaded, so there is no server
    // to reset and nothing to flash: skip the monitor reset and target download
    // steps that hardware GDB servers need.
    if(runnerName !== 'qemu') {
      gdbSetupCommands.push({ "text": "-interpreter-exec console \"monitor reset\"", "ignoreFailures": false });
      gdbSetupCommands.push({ "text": "-target-download", "description": "flash target", "ignoreFailures": false });
    }
    gdbSetupCommands.push({ "text": "set breakpoint pending on", "description": "Set pending", "ignoreFailures": false });
    gdbSetupCommands.push({ "text": "tbreak main", "description": "Set a breakpoint at main", "ignoreFailures": true });
  }
  return gdbSetupCommands;
}

export function getGdbMode(setupCommands: any[], runnerName?: string) {
  // QEMU program-mode configs carry no `-target-download` step (see
  // getSetupCommands), so fall back to the tbreak-main marker to distinguish
  // program from attach for that runner.
  if(runnerName === 'qemu') {
    return setupCommands.some(command =>
      command.description === "Set a breakpoint at main")
      ? "program"
      : "attach";
  }
  if(setupCommands.some(command =>
    command.text === "-target-download" &&
    command.description === "flash target")) {
    return "program";
  } else {
    return "attach";
  }
}