import { RunnerType, WestRunner } from "./WestRunner";
import { execCommandWithEnv } from "../../utils/execUtils";

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
   * On Windows → commander-cli.exe
   * On Linux/macOS → commander-cli
   */
  get executable(): string {
    return process.platform === 'win32' ? 'commander-cli.exe' : 'commander-cli';
  }

  /**
   * Regex to extract the version number from CLI output.
   * Example output:
   *   Simplicity Commander 1v20p5b1945
   *   JLink DLL version: 8.44
   */
  get versionRegex(): RegExp {
    return /Simplicity Commander\s+([A-Za-z0-9._-]+)/i;
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

  /**
   * Detects if commander-cli is installed and available in PATH or tools directory.
   * Runs "commander-cli --version" and checks output.
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

  /**
   * Retrieves the version string by running the CLI and parsing the output.
   * Example: returns "1v20p5b1945".
   */
  async getVersion(): Promise<string | undefined> {
    const cmd = `${this.executable} --version`;
    return new Promise<string | undefined>((resolve) => {
      execCommandWithEnv(cmd, undefined, (error: any, stdout: string, stderr: string) => {
        const output = `${stdout}\n${stderr}`;
        const match = this.versionRegex.exec(output);
        if (match && match[1]) {
          resolve(match[1].trim());
        } else {
          resolve(undefined);
        }
      });
    });
  }
}
