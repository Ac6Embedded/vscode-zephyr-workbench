import fs from 'fs';
import path from 'path';
import { RunnerType, WestRunner } from "./WestRunner";
import { execCommandWithEnv } from "../../utils/execUtils";

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

  override async loadInternalArgs() {
    if (this.serverPath && this.serverPath.trim().length > 0) {
      return;
    }

    const discovered = this.findFromCubeCLT();
    if (discovered) {
      this.serverPath = discovered;
    }
  }

  private findFromCubeCLT(): string | undefined {
    const roots =
      process.platform === 'win32' ? ['C:\\ST\\'] :
      process.platform === 'darwin' ? ['/opt/ST/'] :
      ['/opt/st/'];

    for (const root of roots) {
      try {
        if (!fs.existsSync(root)) {
          continue;
        }

        const dirs = fs.readdirSync(root, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name)
          .filter(name => name.toLowerCase().startsWith('stm32cubeclt_'))
          .sort((a, b) => b.localeCompare(a));

        for (const dir of dirs) {
          const base = path.join(root, dir);

          // Check typical installation path
          const candidate = path.join(base, 'STLink-gdb-server', 'bin', this.executable);
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        }
      } catch {
        // ignore and try next root
      }
    }

    return undefined;
  }

  /**
   * Detect if STM32CubeCLT is available in PATH.
   * Simply runs `<executable> --version` and checks if it executes successfully.
   */
  override async detect(): Promise<boolean> {
    await this.loadInternalArgs();

    // If we found a full path, prefer it
    if (this.serverPath && fs.existsSync(this.serverPath)) {
      return true;
    }

    // Fallback: try PATH (avoid relying on runner-specific version output)
    const cmd = process.platform === 'win32'
      ? `where ${this.executable}`
      : `which ${this.executable}`;

    return new Promise<boolean>((resolve) => {
      execCommandWithEnv(cmd, undefined, (error: any) => {
        resolve(!error);
      });
    });
  }
}
