import { RunnerType, WestRunner } from "./WestRunner";
import { execCommandWithEnv } from "../../utils/execUtils";

/**
 * Runner for STM32CubeProgrammer.
 * Simplified version — assumes the CLI tool is available in the system PATH.
 */
export class STM32CubeProgrammer extends WestRunner {
  name = 'stm32cubeprogrammer';
  label = 'STM32CubeProgrammer';
  types = [ RunnerType.FLASH ];  // This runner is used for flashing firmware
  serverStartedPattern = '';

  /**
   * Returns the executable name based on the current platform.
   * On Windows → STM32_Programmer_CLI.exe
   * On Linux/macOS → STM32_Programmer_CLI
   */
  get executable(): string {
    return process.platform === 'win32'
      ? 'STM32_Programmer_CLI.exe'
      : 'STM32_Programmer_CLI';
  }

  /**
   * Regex to capture the version number from CLI output.
   */
  get versionRegex(): RegExp {
    return /STM32CubeProgrammer version: ([\d.]+)/;
  }

  /**
   * Load user arguments if provided — no extra search logic.
   */
  loadArgs(args: string | undefined) {
    super.loadArgs(args);
    if (args) {
      this.loadUserArgs(args);
    }
  }

  /**
   * Auto arguments for this runner.
   * Just inherits from the base runner — no extra args needed.
   */
  get autoArgs(): string {
    return super.autoArgs;
  }

  /**
   * Detect if STM32CubeProgrammer is available in PATH.
   * Simply runs `<executable> --version` and checks if it executes successfully.
   */
  async detect(): Promise<boolean> {
    const cmd = `${this.executable} --version`;

    return new Promise<boolean>((resolve) => {
      execCommandWithEnv(cmd, undefined, (error: any) => {
        // If command executes without error, the tool is available
        resolve(!error);
      });
    });
  }
}
