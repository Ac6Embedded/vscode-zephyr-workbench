import * as vscode from 'vscode';
import fs from "fs";
import path from 'path';
import { fileExists, getWorkspaceFolder } from './utils';
import { ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from './constants';
import { getBuildEnv, loadEnv } from './zephyrEnvUtils';
import { concatCommands, getShellClearCommand, getShellEchoCommand, getTerminalShell, getResolvedShell, classifyShell, normalizePathForShell, winToPosixPath } from './execUtils';

export class WestWorkspace {
  versionArray!: { [key: string]: string };
  manifestPath!: string;
  manifestFile!: string;
  zephyrBase!: string;
  envVars: { [key: string]: any } = {
    ARCH_ROOT: [],
    SOC_ROOT: [],
    BOARD_ROOT: [],
    DTS_ROOT: []
  };

  static envVarKeys = ['ARCH_ROOT', 'SOC_ROOT', 'BOARD_ROOT', 'DTS_ROOT'];

  constructor(
    public readonly name: string,
    public readonly rootUri: vscode.Uri) {
    // Parsing information from west config file
    const configData = this.parseConfig();
    this.manifestPath = configData['manifest']['path'];
    this.manifestFile = configData['manifest']['file'];

    if (configData['zephyr']) {
      this.zephyrBase = configData['zephyr']['base'];
    } else {
      this.zephyrBase = 'zephyr';
    }

    // Parsing full version
    this.versionArray = this.parseVersion();

    // Load settings
    this.loadSettings();
  }

  parseConfig(): { [key: string]: { [key: string]: string } } {
    // If the config does not exists, assume missing information
    if (!fileExists(this.westConfUri.fsPath)) {
      return {};
    }

    // .west/config format is similar to INI format
    const configContent = fs.readFileSync(this.westConfUri.fsPath, 'utf-8');

    // Pattern for [section]
    const sectionPattern: RegExp = /\[(.+?)\]\s*([\s\S]*?)(?=\n\[|$)/g;
    // Pattern for key = value
    const keyValuePattern: RegExp = /^\s*([\w\s]+?)\s*=\s*(.+?)\s*$/gm;
    const result: { [key: string]: { [key: string]: string } } = {};

    let sectionMatch: RegExpExecArray | null;
    while ((sectionMatch = sectionPattern.exec(configContent)) !== null) {
      const section = sectionMatch[1].trim();
      const body = sectionMatch[2];
      result[section] = {};

      let keyValueMatch: RegExpExecArray | null;
      while ((keyValueMatch = keyValuePattern.exec(body)) !== null) {
        const key = keyValueMatch[1].trim();
        const value = keyValueMatch[2].trim();
        result[section][key] = value;
      }
    }

    return result;
  }

  parseVersion(): { [key: string]: string } {
    let version: string = '';

    // If the config does not exists, assume missing information
    if (!fileExists(this.versionUri.fsPath)) {
      return {};
    }

    // {base}/VERSION file
    const versionContent = fs.readFileSync(this.versionUri.fsPath, 'utf-8');

    const keyValuePattern: RegExp = /^([\w_]+)\s*=\s*(.*)$/gm;
    const ver: { [key: string]: string } = {};

    let match: RegExpExecArray | null;
    while ((match = keyValuePattern.exec(versionContent)) !== null) {
      const key = match[1].trim();
      const value = match[2].trim();
      ver[key] = value;
    }

    return ver;
  }

  loadSettings() {
    const workspaceFolder = getWorkspaceFolder(this.rootUri.fsPath);
    if (workspaceFolder) {
      for (let key of Object.keys(this.envVars)) {
        let values = loadEnv(workspaceFolder, key);
        if (values) {
          this.envVars[key] = values;
        }
      }
    }
  }

  get version(): string {
    if (!this.versionArray['VERSION_MAJOR']) {
      return 'No version found';
    }

    let version = `${this.versionArray['VERSION_MAJOR']}.${this.versionArray['VERSION_MINOR']}.${this.versionArray['PATCHLEVEL']}`;
    if (this.versionArray['VERSION_TWEAK']) {
      version += `+${this.versionArray['VERSION_TWEAK']}`;
    }
    if (this.versionArray['EXTRAVERSION']) {
      version += `-${this.versionArray['EXTRAVERSION']}`;
    }
    return version;
  }

  get westDirUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.rootUri, '.west');
  }

  get westConfUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.westDirUri, 'config');
  }

  get kernelUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.rootUri, this.zephyrBase);
  }

  get manifestUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.rootUri, this.manifestPath, this.manifestFile);
  }

  get versionUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.kernelUri, 'VERSION');
  }

  get boardsDirUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.kernelUri, 'boards');
  }

  get samplesDirUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.kernelUri, 'samples');
  }

  get buildEnv(): { [key: string]: string; } {
    let baseEnv: { [key: string]: string } = {
      ZEPHYR_BASE: this.kernelUri.fsPath,
      ZEPHYR_PROJECT_DIRECTORY: this.rootUri.fsPath
    };

    let additionalEnv = getBuildEnv(this.envVars);
    baseEnv = { ...baseEnv, ...additionalEnv };
    return baseEnv;
  }

  get buildEnvWithVar(): { [key: string]: string; } {
    let baseEnv: { [key: string]: string } = {
      ZEPHYR_BASE: path.join("${config:zephyr-workbench.westWorkspace}", this.zephyrBase),
      ZEPHYR_PROJECT_DIRECTORY: "${config:zephyr-workbench.westWorkspace}"
    };

    let additionalEnv = getBuildEnv(this.envVars);
    baseEnv = { ...baseEnv, ...additionalEnv };
    return baseEnv;
  }

  static isWestWorkspaceFolder(folder: vscode.WorkspaceFolder): boolean {
    const westFolder = vscode.Uri.joinPath(folder.uri, '.west');
    return fileExists(westFolder.fsPath);
  }

  static isWestWorkspacePath(workspacePath: string): boolean {
    const westPath = path.join(workspacePath, '.west');
    return fileExists(westPath);
  }


  private static openTerminal(westWorkspace: WestWorkspace): vscode.Terminal {
    const { path: shellPath, args: shellArgs } = getResolvedShell();
    const shellType = classifyShell(shellPath);
    let opts: vscode.TerminalOptions = {
      name: westWorkspace.name + ' Terminal',
      shellPath: `${shellPath}`,
      shellArgs: shellArgs,
      env: westWorkspace.buildEnv,
      cwd: westWorkspace.rootUri
    };

    const envVars = opts.env || {};

    const echoCommand = getShellEchoCommand(shellType);
    const clearCommand = getShellClearCommand(shellType);
    const printEnvCommands = Object.entries(envVars).map(([key, value]) => {
      const v = (shellType === 'bash')
        ? winToPosixPath(String(value))
        : String(value);
      return `${echoCommand} ${key}="${v}"`;
    });
    const printEnvCommand = concatCommands(shellType, ...printEnvCommands);

    const printHeaderCommand = concatCommands(shellType,
      `${clearCommand}`,
      `echo "======= Zephyr Workbench Environment ======="`,
      `${printEnvCommand}`,
      `echo "============================================"`
    );

    const terminal = vscode.window.createTerminal(opts);
    terminal.sendText(printHeaderCommand);

    return terminal;
  }

  static getTerminal(westWorkspace: WestWorkspace): vscode.Terminal {
    const terminals = <vscode.Terminal[]>(<any>vscode.window).terminals;
    for (let i = 0; i < terminals.length; i++) {
      const cTerminal = terminals[i];
      if (cTerminal.name === westWorkspace.name + ' Terminal') {
        return cTerminal;
      }
    }

    let envScript: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
    if (!envScript) {
      throw new Error('Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Ac6 Zephyr');
    }

    let terminal = WestWorkspace.openTerminal(westWorkspace);
    const { path: shellPath, args: shellArgs } = getResolvedShell();
    const shellType = classifyShell(shellPath);
    envScript = normalizePathForShell(shellType, envScript);
    let srcEnvCmd = `. ${envScript}`;
    terminal.sendText(srcEnvCmd);
    return terminal;
  }

}