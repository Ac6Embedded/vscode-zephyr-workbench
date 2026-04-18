import { RunnerType, WestRunner } from "./WestRunner";

/**
 * Runner for NXP LinkServer.
 * Simplified version - assumes the LinkServer CLI tool is available in the system PATH.
 * Used for flashing and debugging NXP MCUs.
 *
 * Argument parsing is fully handled by the base class: `--linkserver <path>` is
 * recognized as the server path via the default `getServerPathFlags()` (which
 * returns `['--<runner-name>']`), and `--gdb-port` / `--runner` / `--build-dir`
 * are stripped automatically. Anything else round-trips as `userArgs`.
 */
export class Linkserver extends WestRunner {
  name = 'linkserver';
  label = 'LinkServer';
  types = [ RunnerType.FLASH, RunnerType.DEBUG ]; // Supports flashing and debugging
  serverStartedPattern = 'GDB server listening on port'; // Used to detect when the server starts

  /**
   * Returns the executable name based on the current platform.
   * On Windows: LinkServer.exe
   * On Linux/macOS: LinkServer
   */
  get executable(): string {
    return process.platform === 'win32' ? 'LinkServer.exe' : 'LinkServer';
  }
}
