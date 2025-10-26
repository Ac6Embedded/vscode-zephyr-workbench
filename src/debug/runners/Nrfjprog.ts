import { RunnerType, WestRunner } from "./WestRunner";
import { execCommandWithEnv } from "../../execUtils";

/**
 * Runner for Nordic nrfjprog command-line utility.
 * Simplified version — assumes nrfjprog is available in the system PATH.
 * Used for flashing and programming Nordic devices (via J-Link).
 */
export class Nrfjprog extends WestRunner {
  name = 'nrfjprog';
  label = 'nRFjprog';
  types = [RunnerType.FLASH, RunnerType.DEBUG]; // Supports both flashing and debugging
  serverStartedPattern = ''; // nrfjprog doesn’t start a GDB server

  /**
   * Returns the executable name depending on the OS.
   * On Windows → nrfjprog.exe
   * On Linux/macOS → nrfjprog
   */
  get executable(): string {
    return process.platform === 'win32' ? 'nrfjprog.exe' : 'nrfjprog';
  }

  /**
   * Regex to capture the nrfjprog version number from CLI output.
   * Example: "nrfjprog version: 10.24.2 external"
   */
  get versionRegex(): RegExp {
    return /nrfjprog version:\s*([\d.]+)/i;
  }

  /**
   * Loads user-provided arguments, if any.
   * (No search for system locations — just pass through.)
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

  /**
   * Detects whether nrfjprog is installed and accessible via PATH.
   * Executes "nrfjprog --version" and checks for valid output.
   */
  async detect(): Promise<boolean> {
    const cmd = `${this.executable} --version`;

    return new Promise<boolean>((resolve) => {
      execCommandWithEnv(cmd, undefined, (error: any, stdout: string, stderr: string) => {
        // Combine stdout and stderr since version info may appear on either
        const output = `${stdout}\n${stderr}`;
        const found = this.versionRegex.test(output);
        resolve(found);
      });
    });
  }
}
