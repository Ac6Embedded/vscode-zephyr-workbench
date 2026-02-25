import fs from 'fs';
import { RunnerType, WestRunner } from "./WestRunner";

/**
 * Runner for ST-LINK GDB Server.
 * Simplified version — assumes `stlink_gdbserver` is available in the system PATH.
 */
export class StlinkGdbserver extends WestRunner {
  name = 'stlink_gdbserver';
  label = 'ST-LINK GDB Server';
  types = [ RunnerType.DEBUG ];  // This runner is used for debugging
  serverStartedPattern = 'Waiting for debugger connection...';

  /**
   * Returns the executable name based on the current platform.
   * On Windows → ST-LINK_gdbserver.exe
   * On Linux/macOS → ST-LINK_gdbserver
   */
  get executable(): string {
    return process.platform === 'win32'
      ? 'ST-LINK_gdbserver.exe'
      : 'ST-LINK_gdbserver';
  }

  /**
   * Regex to capture the version number from CLI output.
   */
  get versionRegex(): RegExp {
    return /ST-LINK GDB Server version: ([\d.]+)/;
  }

  /**
   * Load user arguments if provided — no extra search logic.
   */
  override loadArgs(args: string | undefined) {
    super.loadArgs(args);
    if (!args) {
      return;
    }

    // stlink_gdbserver uses --port-number (not --gdb-port)
    const portMatch = args.match(/--port-number(?:\s+|=)(\d+)/i);
    if (portMatch?.[1]) {
      this.serverPort = portMatch[1];
    }

    this.loadUserArgs(args);
  }

  /**
   * Auto arguments for this runner.
   * In this Runners we will use --port-number instead of --gdb-port
   */
  override get autoArgs(): string {
    let args = `--runner ${this.name}`;
    if (this.serverPort && `${this.serverPort}`.trim().length > 0) {
      args += ` --port-number ${this.serverPort}`;
    }
    return args;
  }

  private hasCubeCLTFolder(): boolean {
    const roots =
      process.platform === 'win32' ? ['C:\\ST\\'] :
      process.platform === 'darwin' ? ['/opt/ST/'] :
      ['/opt/st/'];

    for (const root of roots) {
      try {
        if (!fs.existsSync(root)) {
          continue;
        }

        const found = fs.readdirSync(root, { withFileTypes: true })
          .some(d => d.isDirectory() && d.name.toLowerCase().startsWith('stm32cubeclt_'));
        if (found) {
          return true;
        }
      } catch {
        // ignore and try next root
      }
    }

    return false;
  }

  /**
   * Detect if STM32CubeCLT is installed by scanning known installation roots.
   * Only checks folder existence: STM32CubeCLT_*.
   */
  override async detect(): Promise<boolean> {
    return this.hasCubeCLTFolder();
  }
}
