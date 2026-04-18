import fs from 'fs';
import path from 'path';
import { RunnerType, WestRunner } from "./WestRunner";

/**
 * Runner for ST-LINK GDB Server.
 *
 * The server is launched indirectly (via west / the STM32CubeCLT bundle) and does
 * not accept an executable-path flag on the command line. Accordingly:
 *   - install/version detection comes from the STM32CubeCLT folder name
 *     (`STM32CubeCLT_<version>`), not from invoking `ST-LINK_gdbserver --version`
 *   - `serverPath` is kept only as an internal compatibility detail so older
 *     saved configs can still round-trip cleanly; it is never injected into
 *     `debugServerArgs` (the Debug Manager writer skips `--stlink_gdbserver <path>`)
 *     and the UI hides the runner path field.
 *   - The install/version surface lives in the Install Runners panel; we deliberately
 *     do not duplicate that here.
 *
 * Argument parsing is delegated to the base class with two small overrides:
 *   - `getGdbPortFlag()`     — this runner uses `--port-number`, not `--gdb-port`
 *   - `getServerPathFlags()` — default is kept so legacy launch.json entries that
 *     contain `--stlink_gdbserver <path>` are consumed and silently dropped on the
 *     next save, rather than leaking into `userArgs`.
 *
 * Auto-detection of the CubeCLT-bundled binary happens in `loadInternalArgs` only
 * as a best-effort compatibility detail when no usable path is already set.
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

  /** ST-LINK uses `--port-number` instead of the standard `--gdb-port`. */
  protected getGdbPortFlag(): string {
    return '--port-number';
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

  /**
   * Called after `loadArgs` has parsed any saved path. Only fall back to
   * auto-detection when no usable path is set, so the user's saved choice wins.
   */
  override async loadInternalArgs() {
    this.refreshDetectedServerPath();
  }

  protected getCubeCltRoots(): string[] {
    if (process.platform === 'win32') {
      return ['C:\\ST\\'];
    }

    if (process.platform === 'darwin') {
      return ['/opt/ST/'];
    }

    return ['/opt/st/'];
  }

  protected getCubeCltDirectories(): string[] {
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

  public getLatestCubeCLTDirectory(): string | undefined {
    return this.getCubeCltDirectories()[0];
  }

  private getCubeCltVersionFromDirectory(cubeCltDir: string): string | undefined {
    // CubeCLT version detection is defined by the install folder name itself:
    // `STM32CubeCLT_<version>`. The installed version shown in the UI must come
    // from that folder name, not from invoking the bundled ST-LINK executable.
    const version = path.basename(cubeCltDir).replace(/^stm32cubeclt_/i, '').trim();
    return version.length > 0 ? version : undefined;
  }

  private getLatestCubeCltInstall(): { directory: string; version: string } | undefined {
    const directory = this.getLatestCubeCLTDirectory();
    if (!directory) {
      return undefined;
    }

    const version = this.getCubeCltVersionFromDirectory(directory);
    if (!version) {
      return undefined;
    }

    return { directory, version };
  }

  public findCubeCltFile(...relativePathSegments: string[]): string | undefined {
    for (const cubeCltDir of this.getCubeCltDirectories()) {
      const candidate = path.join(cubeCltDir, ...relativePathSegments);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  private resolveCubeCltServerPath(): string | undefined {
    return this.findCubeCltFile('STLink-gdb-server', 'bin', this.executable);
  }

  /**
   * Fill `serverPath` from the latest STM32CubeCLT install — but only when no
   * usable path is already set. A saved path that exists on disk is preserved
   * exactly as-is.
   */
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
   * Detect the latest installed STM32CubeCLT version from the folder name.
   *
   * This is the canonical installed-version source for CubeCLT in the runner
   * layer, so callers always get the version from `STM32CubeCLT_<version>`.
   */
  public getVersionCubeCLT(showList = false): string | null {
    const versions = this.getCubeCltDirectories()
      .map(dir => this.getCubeCltVersionFromDirectory(dir))
      .filter((version): version is string => typeof version === 'string' && version.length > 0);

    if (showList) {
      console.log('STM32CubeCLTs found:', versions);
    }

    return versions[0] ?? null;
  }

  /**
   * Detect installation from the STM32CubeCLT folder name only.
   *
   * We intentionally do not invoke `ST-LINK_gdbserver(.exe) --version` here:
   * the executable is not the supported user-facing integration point and west
   * launches it indirectly from the bundle.
   */
  override async detect(): Promise<boolean> {
    this.refreshDetectedServerPath();
    return this.getLatestCubeCltInstall() !== undefined;
  }

  /**
   * The runner name `stlink_gdbserver` is not a tool in `debug-tools.yml`
   * (the package is registered there as `stm32cubeclt`), so the default
   * `detectRunnerVersion(this.name, ...)` probe returns nothing. Short-circuit
   * to the already-parsed CubeCLT directory version instead — same source the
   * Install Runners panel uses for `stm32cubeclt`.
   */
  override async detectVersion(): Promise<string | undefined> {
    return this.getLatestCubeCltInstall()?.version;
  }
}

//Check on the debug console the STM32CubeCLT version detection
//const s = new StlinkGdbserver();
//console.log('Latest Version:', s.getVersionCubeCLT(true));
