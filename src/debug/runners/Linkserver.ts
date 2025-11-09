import { RunnerType, WestRunner } from "./WestRunner";
import { execCommandWithEnv } from "../../utils/execUtils";

/**
 * Runner for NXP LinkServer.
 * Simplified version — assumes the LinkServer CLI tool is available in the system PATH.
 * Used for flashing and debugging NXP MCUs.
 */
export class Linkserver extends WestRunner {
  name = 'linkserver';
  label = 'LinkServer';
  types = [ RunnerType.FLASH, RunnerType.DEBUG ]; // Supports flashing and debugging
  serverStartedPattern = 'GDB server listening on port'; // Used to detect when the server starts

  /**
   * Returns the executable name based on the current platform.
   * On Windows → LinkServer.exe
   * On Linux/macOS → LinkServer
   */
  get executable(): string {
    return process.platform === 'win32' ? 'LinkServer.exe' : 'LinkServer';
  }

  /**
   * Regex to capture the version number from CLI output.
   * Example: "LinkServer v2.7.0" → captures "2.7.0"
   */
  get versionRegex(): RegExp {
    return /v([\d.]+)/;
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

  /**
   * Detect if LinkServer is installed and accessible from the PATH.
   * Runs "<executable> --version" and returns true if it executes successfully.
   */
  async detect(): Promise<boolean> {
    const cmd = `${this.executable} --version`;

    return new Promise<boolean>((resolve) => {
      execCommandWithEnv(cmd, undefined, (error: any) => {
        // If no error → LinkServer was found and executed correctly
        resolve(!error);
      });
    });
  }
}
