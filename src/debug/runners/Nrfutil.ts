import { RunnerType, WestRunner } from "./WestRunner";
import { execCommandWithEnv } from "../../execUtils";

/**
 * Runner for Nordic nrfutil CLI tool.
 * Simplified version — assumes nrfutil is available in the system PATH.
 * Used for flashing and DFU operations on Nordic devices.
 */
export class Nrfutil extends WestRunner {
  name = 'nrfutil';
  label = 'nRF Util';
  types = [ RunnerType.FLASH ]; // Only flashing / DFU (no debugging)
  serverStartedPattern = ''; // nrfutil doesn’t launch a persistent GDB server

  /**
   * Returns the executable name based on the platform.
   * On Windows → nrfutil.exe
   * On Linux/macOS → nrfutil
   */
  get executable(): string {
    return process.platform === 'win32' ? 'nrfutil.exe' : 'nrfutil';
  }

  /**
   * Regex to extract the version number from CLI output.
   * Example output: "nrfutil version 6.1.9"
   */
  get versionRegex(): RegExp {
    return /nrfutil(?: version)? ([\d.]+)/i;
  }

  /**
   * Loads user-provided arguments (if any).
   * No system path or settings lookup — just passes them through.
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

  /**
   * Detects if nrfutil is installed and available in PATH.
   * Runs "nrfutil --version" and checks output.
   */
  async detect(): Promise<boolean> {
    const cmd = `${this.executable} --version`;
    return new Promise<boolean>((resolve) => {
      execCommandWithEnv(cmd, undefined, (error: any, stdout: string, stderr: string) => {
        const output = `${stdout}\n${stderr}`;
        const found = this.versionRegex.test(output);
        resolve(found);
      });
    });
  }
}
