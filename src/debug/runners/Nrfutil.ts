import { RunnerType, WestRunner } from "./WestRunner";

/**
 * Runner for Nordic nrfutil CLI tool.
 * Simplified version - assumes nrfutil is available in the system PATH.
 * Used for flashing and DFU operations on Nordic devices.
 */
export class Nrfutil extends WestRunner {
  name = 'nrfutil';
  label = 'nRF Util';
  types = [ RunnerType.FLASH ]; // Only flashing / DFU (no debugging)
  serverStartedPattern = ''; // nrfutil doesn't launch a persistent GDB server

  /**
   * Returns the executable name based on the platform.
   * On Windows: nrfutil.exe
   * On Linux/macOS: nrfutil
   */
  get executable(): string {
    return process.platform === 'win32' ? 'nrfutil.exe' : 'nrfutil';
  }

  /**
   * Loads user-provided arguments (if any).
   * No system path or settings lookup - just passes them through.
   */
  loadArgs(args: string | undefined) {
    super.loadArgs(args);
    if (args) {
      this.loadUserArgs(args);
    }
  }

  /**
   * Automatically builds command-line arguments for this runner.
   * Modify as needed for specific DFU or flash operations.
   */
  get autoArgs(): string {
    return super.autoArgs;
  }
}
