import fs from 'fs';
import path from 'path';
import { RunnerType, WestRunner } from "./WestRunner";

/**
 * Runner for ST-LINK GDB Server.
 * Prefer the latest STM32CubeCLT installation and fall back to PATH.
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
   * Load user arguments and auto-resolve the server path when possible.
   */
  override loadArgs(args: string | undefined) {
    this.refreshDetectedServerPath();
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
    this.refreshDetectedServerPath();
  }

  private getCubeCltRoots(): string[] {
    if (process.platform === 'win32') {
      return ['C:\\ST\\'];
    }

    if (process.platform === 'darwin') {
      return ['/opt/ST/'];
    }

    return ['/opt/st/'];
  }

  private getCubeCltDirectories(): string[] {
    const directories: string[] = [];

    for (const root of this.getCubeCltRoots()) {
      try {
        if (!fs.existsSync(root)) {
          continue;
        }

        const found = fs.readdirSync(root, { withFileTypes: true })
          .filter(d => d.isDirectory() && d.name.toLowerCase().startsWith('stm32cubeclt_'))
          .map(d => path.join(root, d.name));

        directories.push(...found);
      } catch {
        // ignore and try next root
      }
    }

    directories.sort((a, b) => {
      const versionA = path.basename(a).replace(/^stm32cubeclt_/i, '');
      const versionB = path.basename(b).replace(/^stm32cubeclt_/i, '');
      return versionB.localeCompare(versionA, undefined, { numeric: true });
    });

    return directories;
  }

  private resolveCubeCltServerPath(): string | undefined {
    const latestCubeCltDir = this.getCubeCltDirectories()[0];
    if (!latestCubeCltDir) {
      return undefined;
    }

    const detectedPath = path.join(latestCubeCltDir, 'STLink-gdb-server', 'bin', this.executable);
    return fs.existsSync(detectedPath) ? detectedPath : undefined;
  }

  private refreshDetectedServerPath() {
    if (this.serverPath && fs.existsSync(this.serverPath)) {
      return;
    }

    const detectedPath = this.resolveCubeCltServerPath();
    if (detectedPath) {
      this.serverPath = detectedPath;
    }
  }

  /**
   * Detect the latest installed STM32CubeCLT version.
   */
  public getVersionCubeCLT(showList = false): string | null {
    const versions = this.getCubeCltDirectories()
      .map(dir => path.basename(dir).replace(/^stm32cubeclt_/i, ''));

    if (showList) {
      console.log('STM32CubeCLTs found:', versions);
    }

    return versions[0] ?? null;
  }

  /**
   * Detect ST-LINK GDB Server from STM32CubeCLT first, then fall back to PATH.
   */
  override async detect(): Promise<boolean> {
    this.refreshDetectedServerPath();
    return super.detect();
  }
}

//Check on the debug console the STM32CubeCLT version detection
//const s = new StlinkGdbserver();
//console.log('Latest Version:', s.getVersionCubeCLT(true));
