import { RunnerType, WestRunner } from "./WestRunner";
import { execCommandWithEnv } from "../../utils/execUtils";

/**
 * Runner for OpenOCD (Open On-Chip Debugger).
 * Simplified version — assumes `openocd` is available in the system PATH.
 * Used for flashing and debugging ARM-based targets.
 */
export class Openocd extends WestRunner {
  name = 'openocd';
  label = 'OpenOCD';
  types = [RunnerType.FLASH, RunnerType.DEBUG]; // Supports both flashing and debugging
  serverStartedPattern = 'halted due to debug-request, current mode: Thread'; // Pattern used to detect when OpenOCD is ready

  /**
   * Returns the executable name based on the current platform.
   * On Windows → openocd.exe
   * On Linux/macOS → openocd
   */
  get executable(): string {
    return process.platform === 'win32' ? 'openocd.exe' : 'openocd';
  }

  /**
   * Regex to capture the version number from CLI output.
   * Example: "Open On-Chip Debugger 0.12.0" → captures "0.12.0"
   */
  get versionRegex(): RegExp {
    return /Open On-Chip Debugger ([\d.]+)/;
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
   * Detects if OpenOCD is installed and available in PATH.
   * Runs "openocd --version" and checks if it executes successfully.
   */
  async detect(): Promise<boolean> {
    const cmd = `${this.executable} --version`; // Redirect stderr since OpenOCD prints version to stderr
    return new Promise<boolean>((resolve) => {
      execCommandWithEnv(cmd, undefined, (error: any) => {
        // If no error, OpenOCD is available
        resolve(!error);
      });
    });
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
