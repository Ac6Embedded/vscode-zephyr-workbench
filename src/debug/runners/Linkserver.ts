import { RunnerType, WestRunner } from "./WestRunner";

/**
 * Runner for NXP LinkServer.
 * Simplified version - assumes the LinkServer CLI tool is available in the system PATH.
 * Used for flashing and debugging NXP MCUs.
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

  /**
   * Load user-provided arguments (if any).
   * No path discovery or system searching.
   */
  loadArgs(args: string | undefined) {
    super.loadArgs(args);
    if (args) {
      this.loadUserArgs(args);
    }
  }

  /**
   * Auto arguments for the LinkServer runner.
   * In this simplified version, just inherits the base arguments.
   */
  get autoArgs(): string {
    return super.autoArgs;
  }
}
