import { RunnerType, WestRunner } from "./WestRunner";

/**
 * Runner for OpenOCD (Open On-Chip Debugger).
 * Simplified version - assumes `openocd` is available in the system PATH.
 * Used for flashing and debugging ARM-based targets.
 */
export class Openocd extends WestRunner {
  name = 'openocd';
  label = 'OpenOCD';
  types = [RunnerType.FLASH, RunnerType.DEBUG]; // Supports both flashing and debugging
  serverStartedPattern = 'halted due to debug-request, current mode: Thread'; // Pattern used to detect when OpenOCD is ready

  /**
   * Returns the executable name based on the current platform.
   * On Windows: openocd.exe
   * On Linux/macOS: openocd
   */
  get executable(): string {
    return process.platform === 'win32' ? 'openocd.exe' : 'openocd';
  }

  /**
   * Loads user-provided arguments (if any).
   * No searching for installation paths.
   */
  loadArgs(args: string | undefined) {
    super.loadArgs(args);
    if (args) {
      this.loadUserArgs(args);
    }
  }

  /**
   * Automatically builds command-line arguments.
   * You can adjust default config file arguments here as needed.
   */
  get autoArgs(): string {
    let cmdArgs = super.autoArgs;
    cmdArgs += ' --config openocd.cfg';
    cmdArgs += ' --config ${workspaceFolder}/build/.debug/gdb.cfg';
    return cmdArgs;
  }

  /**
   * Creates a small workaround GDB config file that ensures
   * OpenOCD shuts down automatically when GDB detaches.
   */
  static createWorkaroundCfg(parentDir: string) {
    const fs = require('fs');
    const path = require('path');
    const buildDir = path.join(parentDir, 'build', '.debug');

    // Ensure directory exists
    if (!fs.existsSync(buildDir)) {
      fs.mkdirSync(buildDir, { recursive: true });
    }

    const cfgPath = path.join(buildDir, 'gdb.cfg');
    const cfgContent = `# Auto-generated: Force OpenOCD to shutdown when GDB detaches

if {[info exists _TARGETNAME]} {
  $_TARGETNAME configure -event gdb-detach {
    shutdown
  }
} else {
  set targets [target names]
  foreach t $targets {
    if {[string match "*.cpu*" $t]} {
      $t configure -event gdb-detach {
        shutdown
      }
    }
  }
}
`;
    fs.writeFileSync(cfgPath, cfgContent);
  }
}
