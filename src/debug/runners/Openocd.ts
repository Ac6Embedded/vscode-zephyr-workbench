import path from "path";
import { ZEPHYR_WORKBENCH_DEBUG_DIRNAME } from "../../constants";
import { RunnerType, WestRunner } from "./WestRunner";

const GDB_CFG_FILENAME = 'gdb.cfg';

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
   * Matches the generated gdb.cfg however launch.json names it: under a build
   * configuration, under the older per-app build/.debug, or absolute.
   */
  static readonly GDB_CFG_PATTERN = /(?:^|[\\/])\.debug[\\/]gdb\.cfg$/;

  /**
   * Returns the executable name based on the current platform.
   * On Windows: openocd.exe
   * On Linux/macOS: openocd
   */
  get executable(): string {
    return process.platform === 'win32' ? 'openocd.exe' : 'openocd';
  }

  /**
   * Automatically builds command-line arguments.
   * You can adjust default config file arguments here as needed.
   */
  get autoArgs(): string {
    let cmdArgs = super.autoArgs;
    cmdArgs += ' --config openocd.cfg';
    return cmdArgs;
  }

  /** Adds the gdb.cfg generated in the build configuration's debug folder. */
  protected override getDebugAutoArgs(relativeBuildDir: string): string {
    return `${this.autoArgs} --config "${Openocd.getGdbCfgLaunchPath(relativeBuildDir)}"`;
  }

  /**
   * Tell the base parser about the two `--config` lines we add, so they are
   * stripped on read instead of being mistaken for user-provided args. The
   * gdb.cfg one is matched by pattern, as its folder depends on the build.
   */
  protected getExtraAutoTokens() {
    return [
      { flag: '--config', value: 'openocd.cfg' },
      { flag: '--config', value: Openocd.GDB_CFG_PATTERN },
    ];
  }

  /**
   * The generated gdb.cfg as launch.json passes it to OpenOCD, for the build
   * directory `${workspaceFolder}/<relativeBuildDir>` that --build-dir names.
   */
  static getGdbCfgLaunchPath(relativeBuildDir: string): string {
    return path.posix.join('${workspaceFolder}', relativeBuildDir, ZEPHYR_WORKBENCH_DEBUG_DIRNAME, GDB_CFG_FILENAME);
  }

  /**
   * Creates a small workaround GDB config file in `debugDir` that ensures
   * OpenOCD shuts down automatically when GDB detaches.
   */
  static createWorkaroundCfg(debugDir: string) {
    const fs = require('fs');

    // Ensure directory exists
    if (!fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir, { recursive: true });
    }

    const cfgPath = path.join(debugDir, GDB_CFG_FILENAME);
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
