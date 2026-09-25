// A VS Code window for the application tests, installed on the vscode stub:
// workspace folders, folder settings read from and written to each folder's
// .vscode/settings.json the way VS Code does, user settings in memory, and a
// Uri class the settings code can test with instanceof. Plus small on-disk
// fixtures: a west workspace with a sample, a Zephyr SDK, an Arm GNU
// toolchain. Everything the production code does with them is real.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseJsonc } from 'jsonc-parser';

const stub = require('vscode') as Record<string, any>;

export class FakeUri {
  constructor(readonly fsPath: string) {}
  get path(): string { return this.fsPath; }
  get scheme(): string { return 'file'; }
  static file(fsPath: string): FakeUri { return new FakeUri(fsPath); }
  static parse(value: string): FakeUri { return new FakeUri(decodeURIComponent(value.replace(/^file:\/\//, ''))); }
  static joinPath(base: FakeUri, ...parts: string[]): FakeUri { return new FakeUri(path.join(base.fsPath, ...parts)); }
  toString(): string { return `file://${this.fsPath}`; }
}

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

export function readSettingsFile(folder: string): Record<string, any> {
  try {
    const parsed = parseJsonc(fs.readFileSync(path.join(folder, '.vscode', 'settings.json'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeSettingsFile(folder: string, settings: Record<string, unknown>): void {
  fs.mkdirSync(path.join(folder, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(folder, '.vscode', 'settings.json'), JSON.stringify(settings, null, 2));
}

export interface FakeWindow {
  /** The open workspace folders, in order. */
  folders: string[];
  /** Set for a multi-root workspace saved or untitled; undefined for a single-folder or empty window. */
  workspaceFile?: string;
  /** User settings, by full key. */
  user: Record<string, unknown>;
  /** Every settings write, as "<folder path or user>: <key>". */
  writes: string[];
  restore(): void;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Install the window on the vscode stub. Call restore() after the test. */
export function installFakeWindow(folders: string[] = []): FakeWindow {
  const workspace = stub.workspace as Record<string, any>;
  const saved = {
    Uri: stub.Uri,
    getConfiguration: workspace.getConfiguration,
    getWorkspaceFolder: workspace.getWorkspaceFolder,
    workspaceFolders: Object.getOwnPropertyDescriptor(workspace, 'workspaceFolders'),
    workspaceFile: Object.getOwnPropertyDescriptor(workspace, 'workspaceFile'),
    onDidChangeWorkspaceFolders: workspace.onDidChangeWorkspaceFolders,
    onDidChangeConfiguration: workspace.onDidChangeConfiguration,
  };
  const window: FakeWindow = {
    folders: [...folders],
    user: {},
    writes: [],
    restore: () => {
      stub.Uri = saved.Uri;
      workspace.getConfiguration = saved.getConfiguration;
      workspace.getWorkspaceFolder = saved.getWorkspaceFolder;
      if (saved.workspaceFolders) {
        Object.defineProperty(workspace, 'workspaceFolders', saved.workspaceFolders);
      }
      if (saved.workspaceFile) {
        Object.defineProperty(workspace, 'workspaceFile', saved.workspaceFile);
      } else {
        delete workspace.workspaceFile;
      }
      workspace.onDidChangeWorkspaceFolders = saved.onDidChangeWorkspaceFolders;
      workspace.onDidChangeConfiguration = saved.onDidChangeConfiguration;
    },
  };

  const folderObject = (folder: string, index: number) => ({ uri: FakeUri.file(folder), name: path.basename(folder), index });
  const openFolderOf = (target: string | undefined): string | undefined => target === undefined
    ? undefined
    : window.folders.filter(folder => isInside(target, folder)).sort((a, b) => b.length - a.length)[0];
  const pathOfScope = (scope: unknown): string | undefined => {
    if (typeof scope === 'string') {
      return scope;
    }
    if (scope && typeof scope === 'object') {
      const candidate = scope as { fsPath?: string; uri?: { fsPath?: string } };
      return candidate.uri?.fsPath ?? candidate.fsPath;
    }
    return undefined;
  };

  stub.Uri = FakeUri;
  Object.defineProperty(workspace, 'workspaceFolders', {
    configurable: true,
    get: () => (window.folders.length > 0 ? window.folders.map(folderObject) : undefined),
  });
  Object.defineProperty(workspace, 'workspaceFile', {
    configurable: true,
    get: () => (window.workspaceFile ? FakeUri.file(window.workspaceFile) : undefined),
  });
  workspace.getWorkspaceFolder = (uri: { fsPath: string }) => {
    const folder = openFolderOf(uri?.fsPath);
    return folder ? folderObject(folder, window.folders.indexOf(folder)) : undefined;
  };
  workspace.onDidChangeWorkspaceFolders = () => ({ dispose() {} });
  workspace.onDidChangeConfiguration = () => ({ dispose() {} });
  workspace.getConfiguration = (section?: string, scope?: unknown) => {
    const folder = openFolderOf(pathOfScope(scope));
    const full = (key: string) => (section ? `${section}.${key}` : key);
    const folderValue = (key: string) => (folder ? readSettingsFile(folder)[full(key)] : undefined);
    return {
      get: (key: string, fallback?: unknown) => {
        const value = folderValue(key) ?? window.user[full(key)];
        return value === undefined ? fallback : clone(value);
      },
      has: (key: string) => folderValue(key) !== undefined || window.user[full(key)] !== undefined,
      inspect: (key: string) => ({
        key: full(key),
        globalValue: clone(window.user[full(key)]),
        workspaceFolderValue: clone(folderValue(key)),
      }),
      update: async (key: string, value: unknown, target?: unknown) => {
        if (target === 1 || target === true) {
          if (value === undefined) {
            delete window.user[full(key)];
          } else {
            window.user[full(key)] = clone(value);
          }
          window.writes.push(`user: ${full(key)}`);
          return;
        }
        if (!folder) {
          throw new Error(`Unable to write ${full(key)}: no workspace folder is open for this resource.`);
        }
        const settings = readSettingsFile(folder);
        if (value === undefined) {
          delete settings[full(key)];
        } else {
          settings[full(key)] = clone(value);
        }
        writeSettingsFile(folder, settings);
        window.writes.push(`${folder}: ${full(key)}`);
      },
    };
  };
  return window;
}

/** A fresh temporary folder, with its real path (macOS puts tmp behind a symbolic link). */
export function tempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function writeFile(file: string, text = ''): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/**
 * A west workspace: .west/config, a Zephyr 4.1 tree recommending SDK 0.17.0,
 * and a hello_world sample with its sample.yaml.
 */
export function makeWestWorkspace(root: string, options: { zephyrVersion?: [number, number, number]; recommendedSdk?: string } = {}): string {
  const [major, minor, patch] = options.zephyrVersion ?? [4, 1, 0];
  writeFile(path.join(root, '.west', 'config'), '[manifest]\npath = zephyr\nfile = west.yml\n\n[zephyr]\nbase = zephyr\n');
  writeFile(path.join(root, 'zephyr', 'VERSION'), `VERSION_MAJOR = ${major}\nVERSION_MINOR = ${minor}\nPATCHLEVEL = ${patch}\nVERSION_TWEAK = 0\nEXTRAVERSION =\n`);
  writeFile(path.join(root, 'zephyr', 'SDK_VERSION'), `${options.recommendedSdk ?? '0.17.0'}\n`);
  makeApplicationFolder(path.join(root, 'zephyr', 'samples', 'hello_world'));
  writeFile(path.join(root, 'zephyr', 'samples', 'hello_world', 'sample.yaml'), 'sample:\n  name: Hello World\n');
  return root;
}

/** The files that make a folder a Zephyr application. */
export function makeApplicationFolder(dir: string, prjConf = 'CONFIG_PRINTK=y\n'): string {
  writeFile(path.join(dir, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20.0)\nfind_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})\nproject(app)\ntarget_sources(app PRIVATE src/main.c)\n');
  writeFile(path.join(dir, 'prj.conf'), prjConf);
  writeFile(path.join(dir, 'src', 'main.c'), 'int main(void) { return 0; }\n');
  return dir;
}

/** A Zephyr SDK folder of `version`, with its LLVM toolchain when asked. */
export function makeSdk(dir: string, version: string, options: { llvm?: boolean } = {}): string {
  writeFile(path.join(dir, 'sdk_version'), `${version}\n`);
  writeFile(path.join(dir, 'sdk_toolchains'), 'arm-zephyr-eabi\n');
  if (options.llvm) {
    writeFile(path.join(dir, 'llvm', 'bin', process.platform === 'win32' ? 'clang.exe' : 'clang'));
  }
  return dir;
}

/** An Arm GNU toolchain folder for arm-none-eabi. */
export function makeArmGnu(dir: string): string {
  writeFile(path.join(dir, 'bin', process.platform === 'win32' ? 'arm-none-eabi-gcc.exe' : 'arm-none-eabi-gcc'));
  return dir;
}
