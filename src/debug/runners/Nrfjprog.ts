import { RunnerType, WestRunner } from "./WestRunner";

/**
 * Runner for Nordic nrfjprog command-line utility.
 * Simplified version - assumes nrfjprog is available in the system PATH.
 * Used for flashing and programming Nordic devices (via J-Link).
 */
export class Nrfjprog extends WestRunner {
  name = 'nrfjprog';
  label = 'nRFjprog';
  types = [RunnerType.FLASH, RunnerType.DEBUG]; // Supports both flashing and debugging
  serverStartedPattern = ''; // nrfjprog doesn't start a GDB server

  /**
   * Returns the executable name depending on the OS.
   * On Windows: nrfjprog.exe
   * On Linux/macOS: nrfjprog
   */
  get executable(): string {
    return process.platform === 'win32' ? 'nrfjprog.exe' : 'nrfjprog';
  }

  /**
   * Loads user-provided arguments, if any.
   * (No search for system locations - just pass through.)
   */
  loadArgs(args: string | undefined) {
    super.loadArgs(args);
    if (args) {
      this.loadUserArgs(args);
    }
  }

  /**
   * Automatically builds command-line arguments.
   * Extend this method to append flags or configuration options if needed.
   */
  get autoArgs(): string {
    return super.autoArgs;
  }
}
