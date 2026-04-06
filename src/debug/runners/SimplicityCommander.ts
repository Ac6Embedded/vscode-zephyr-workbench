import { RunnerType, WestRunner } from "./WestRunner";

/**
 * Runner for Silicon Labs Simplicity Commander CLI tool.
 * Used for flashing and device management on Silicon Labs MCUs.
 */
export class SimplicityCommander extends WestRunner {
  name = 'simplicity_commander';
  label = 'Simplicity Commander';
  types = [RunnerType.FLASH]; // Flashing only (no persistent server)
  serverStartedPattern = ''; // Commander doesn't run a GDB server

  /**
   * Returns the executable name based on the platform.
   * On Windows: commander-cli.exe
   * On Linux/macOS: commander-cli
   */
  get executable(): string {
    return process.platform === 'win32' ? 'commander-cli.exe' : 'commander-cli';
  }

  /**
   * Loads user-provided arguments (if any).
   * Just passes them through; no special parsing required.
   */
  loadArgs(args: string | undefined) {
    super.loadArgs(args);
    if (args) {
      this.loadUserArgs(args);
    }
  }

  /**
   * Automatically builds command-line arguments for this runner.
   * (Override if needed for specific flash actions.)
   */
  get autoArgs(): string {
    return super.autoArgs;
  }
}
