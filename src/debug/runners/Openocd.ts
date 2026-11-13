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

  /** Matches the `--cmd-pre-init` value that sources the generated gdb.cfg: `source {<path>}`. */
  static readonly GDB_CFG_SOURCE_PATTERN = /^source\s+\{(?:.*[\\/])?\.debug[\\/]gdb\.cfg\}$/;

  /**
   * Returns the executable name based on the current platform.
   * On Windows: openocd.exe
   * On Linux/macOS: openocd
   */
  get executable(): string {
    return process.platform === 'win32' ? 'openocd.exe' : 'openocd';
  }

  /** Adds the gdb.cfg generated in the build configuration's debug folder. */
  protected override getDebugAutoArgs(relativeBuildDir: string): string {
    return `${super.autoArgs} ${Openocd.getGdbCfgArg(relativeBuildDir)}`;
  }

  /**
   * Tell the base parser about the lines we add (or used to add), so they are
   * stripped on read instead of being mistaken for user-provided args. The
   * gdb.cfg ones are matched by pattern, as its folder depends on the build.
   *
   * `openocd.cfg` is no longer emitted: it overrode the board's own config from
   * runners.yaml (board_runner_args). The `--config` forms stay listed so
   * launch.json files written by older versions are cleaned up instead of
   * keeping them as user args.
   */
  protected getExtraAutoTokens() {
    return [
      { flag: '--config', value: 'openocd.cfg' },
      { flag: '--config', value: Openocd.GDB_CFG_PATTERN },
      { flag: '--cmd-pre-init', value: Openocd.GDB_CFG_SOURCE_PATTERN },
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
   * The argument that has OpenOCD run the generated gdb.cfg. It goes through
   * `--cmd-pre-init`, not `--config`: west's OpenOCD runner compares the folder
   * of every `--config` file with the board's `support` folder and fails when
   * the board has none. The script is sourced after the board's configuration,
   * so its targets exist. The path sits in Tcl braces, which keep spaces; it
   * must not hold unbalanced braces.
   */
  static getGdbCfgArg(relativeBuildDir: string): string {
    return `--cmd-pre-init "source {${Openocd.getGdbCfgLaunchPath(relativeBuildDir)}}"`;
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
