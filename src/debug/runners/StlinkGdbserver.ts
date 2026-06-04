import * as vscode from 'vscode';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

import {
  DetectableToolLike,
  findDetectedToolRoots,
  getDetectPlatform,
} from '../../utils/debugTools/debugToolPathUtils';
import { getInternalDirRealPath } from '../../utils/utils';
import { RunnerType, WestRunner } from './WestRunner';

interface DebugToolsManifest {
  debug_tools?: Array<DetectableToolLike & { tool?: string }>;
}

interface CubeCltInstall {
  directory: string;
  version: string;
}

/**
 * Runner for ST-LINK GDB Server.
 *
 * The server is launched indirectly through west and the STM32CubeCLT bundle, so
 * the launch arguments must not receive a `--stlink_gdbserver <path>` override.
 * The path is still detected internally for UI state, version display, and SVD
 * lookup. CubeCLT install roots are read from `debug-tools.yml`.
 */
export class StlinkGdbserver extends WestRunner {
  name = 'stlink_gdbserver';
  label = 'ST-LINK GDB Server';
  types = [RunnerType.DEBUG];
  serverStartedPattern = 'Waiting for debugger connection...';

  get executable(): string {
    return process.platform === 'win32'
      ? 'ST-LINK_gdbserver.exe'
      : 'ST-LINK_gdbserver';
  }

  protected getGdbPortFlag(): string {
    return '--port-number';
  }

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

  private normalizePathSlashes(value: string): string {
    return value.replace(/\\/g, '/');
  }

  private getDebugToolsYamlPath(): string | undefined {
    const extensionUri = vscode.extensions.getExtension('Ac6.zephyr-workbench')?.extensionUri;
    if (extensionUri) {
      return vscode.Uri.joinPath(extensionUri, 'scripts', 'runners', 'debug-tools.yml').fsPath;
    }

    const candidates = [
      path.resolve(process.cwd(), 'scripts', 'runners', 'debug-tools.yml'),
      path.resolve(__dirname, '..', '..', '..', 'scripts', 'runners', 'debug-tools.yml'),
      path.resolve(__dirname, '..', '..', 'scripts', 'runners', 'debug-tools.yml'),
    ];

    return candidates.find(candidate => fs.existsSync(candidate));
  }

  private getCubeCltTool(): DetectableToolLike | undefined {
    const yamlPath = this.getDebugToolsYamlPath();
    if (!yamlPath || !fs.existsSync(yamlPath)) {
      return undefined;
    }

    try {
      const manifest = yaml.parse(fs.readFileSync(yamlPath, 'utf8')) as DebugToolsManifest;
      return manifest.debug_tools?.find(tool => tool.tool === 'stm32cubeclt');
    } catch {
      return undefined;
    }
  }

  private getCubeCltRootFromDetectedPath(detectedPath: string): string | undefined {
    let current = path.resolve(detectedPath);

    while (true) {
      if (/^STM32CubeCLT_/i.test(path.basename(current))) {
        return current;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }

  private getCubeCltVersionFromDirectory(cubeCltDir: string): string | undefined {
    const match = path.basename(cubeCltDir).match(/^STM32CubeCLT_(.+)$/i);
    return match?.[1]?.trim() || undefined;
  }

  private getCubeCltVersionParts(cubeCltDir: string): number[] {
    return (this.getCubeCltVersionFromDirectory(cubeCltDir) ?? '')
      .split('.')
      .map(part => Number(part))
      .map(part => (Number.isFinite(part) ? part : 0));
  }

  private compareCubeCltDirectories(left: string, right: string): number {
    const leftParts = this.getCubeCltVersionParts(left);
    const rightParts = this.getCubeCltVersionParts(right);

    for (let idx = 0; idx < Math.max(leftParts.length, rightParts.length); idx += 1) {
      const leftPart = leftParts[idx] || 0;
      const rightPart = rightParts[idx] || 0;
      if (leftPart !== rightPart) {
        return rightPart - leftPart;
      }
    }

    return path.basename(right).localeCompare(path.basename(left));
  }

  private getCubeCltServerPath(cubeCltDir: string): string {
    return path.join(cubeCltDir, 'STLink-gdb-server', 'bin', this.executable);
  }

  private isUsableCubeCltRoot(cubeCltDir: string): boolean {
    return fs.existsSync(this.getCubeCltServerPath(cubeCltDir));
  }

  protected getCubeCltDirectories(): string[] {
    const tool = this.getCubeCltTool();
    if (!tool) {
      return [];
    }

    const detectedRoots = findDetectedToolRoots(tool, getInternalDirRealPath(), getDetectPlatform())
      .map(root => this.getCubeCltRootFromDetectedPath(root))
      .filter((root): root is string => typeof root === 'string' && root.length > 0)
      .map(root => this.normalizePathSlashes(root));

    return Array.from(new Set(detectedRoots))
      .filter(root => this.isUsableCubeCltRoot(root))
      .sort((left, right) => this.compareCubeCltDirectories(left, right));
  }

  public getLatestCubeCLTDirectory(): string | undefined {
    return this.getCubeCltDirectories()[0];
  }

  private getLatestCubeCltInstall(): CubeCltInstall | undefined {
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
    const directory = this.getLatestCubeCLTDirectory();
    if (!directory) {
      return undefined;
    }

    return this.getCubeCltServerPath(directory);
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

  public getVersionCubeCLT(showList = false): string | null {
    const versions = this.getCubeCltDirectories()
      .map(dir => this.getCubeCltVersionFromDirectory(dir))
      .filter((version): version is string => typeof version === 'string' && version.length > 0);

    if (showList) {
      console.log('STM32CubeCLTs found:', versions);
    }

    return versions[0] ?? null;
  }

  override async detect(): Promise<boolean> {
    this.refreshDetectedServerPath();
    return this.getLatestCubeCltInstall() !== undefined;
  }

  override async detectVersion(): Promise<string | undefined> {
    return this.getLatestCubeCltInstall()?.version;
  }
}
