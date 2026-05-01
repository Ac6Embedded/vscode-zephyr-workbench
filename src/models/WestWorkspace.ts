import * as vscode from 'vscode';
import fs from "fs";
import path from 'path';
import { fileExists, getWorkspaceFolder } from '../utils/utils';
import { ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY } from '../constants';
import { getBuildEnv, loadEnv } from '../utils/env/zephyrEnvUtils';
import { buildStartupSetupShellArgs, buildTerminalEnvCommands, concatCommands, getConfiguredWorkbenchPath, getShellCdCommand, getShellClearCommand, getResolvedShell, getShellSourceCommand, classifyShell, normalizePathForShell, TerminalEnvGroup } from '../utils/execUtils';

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

  get testsDirUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.kernelUri, 'tests');
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

  private static buildTerminalContext(westWorkspace: WestWorkspace) {
    const { path: shellPath, args: shellArgs } = getResolvedShell();
    const shellType = classifyShell(shellPath);
    const groups: TerminalEnvGroup[] = [
      { label: 'Zephyr build system', env: westWorkspace.buildEnv },
    ];
    return {
      shellPath,
      shellArgs,
      shellType,
      env: westWorkspace.buildEnv,
      groups,
      cwd: westWorkspace.rootUri.fsPath,
    };
  }

  // Reuse path only: shell already running, must use sendText. Visible chained
  // command is fine because the user explicitly re-triggered "open terminal".
  private static refreshTerminal(
    terminal: vscode.Terminal,
    westWorkspace: WestWorkspace,
    envScript: string,
  ): void {
    const context = WestWorkspace.buildTerminalContext(westWorkspace);
    const envScriptForShell = normalizePathForShell(context.shellType, envScript);
    const { setCommands, echoCommands } = buildTerminalEnvCommands(context.shellType, context.groups);

    const setupCommand = concatCommands(
      context.shellType,
      getShellClearCommand(context.shellType),
      getShellCdCommand(context.shellType, context.cwd),
      ...setCommands,
      getShellSourceCommand(context.shellType, envScriptForShell),
      ...echoCommands,
    );
    terminal.sendText(setupCommand);
  }

  // New-terminal path: bake the setup into shellArgs so it runs silently at startup.
  // env vars are already injected via createTerminal({ env }), so the setup only
  // sources the env script and echoes the grouped banner.
  private static openTerminal(westWorkspace: WestWorkspace, envScript: string): vscode.Terminal {
    const context = WestWorkspace.buildTerminalContext(westWorkspace);
    const envScriptForShell = normalizePathForShell(context.shellType, envScript);
    const { echoCommands } = buildTerminalEnvCommands(context.shellType, context.groups);

    const setupCommands = [
      getShellSourceCommand(context.shellType, envScriptForShell),
      ...echoCommands,
    ];
    const shellArgs = buildStartupSetupShellArgs(
      context.shellPath,
      context.shellType,
      context.shellArgs,
      setupCommands,
    );

    const opts: vscode.TerminalOptions = {
      name: westWorkspace.name + ' Terminal',
      shellPath: `${context.shellPath}`,
      shellArgs,
      env: context.env,
      cwd: westWorkspace.rootUri,
    };

    return vscode.window.createTerminal(opts);
  }

  static getTerminal(westWorkspace: WestWorkspace): vscode.Terminal {
    let envScript: string | undefined = getConfiguredWorkbenchPath(
      ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY,
      westWorkspace.rootUri,
    );
    if (!envScript) {
      throw new Error('Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Ac6 Zephyr');
    }

    const terminals = <vscode.Terminal[]>(<any>vscode.window).terminals;
    for (let i = 0; i < terminals.length; i++) {
      const cTerminal = terminals[i];
      if (cTerminal.name === westWorkspace.name + ' Terminal') {
        WestWorkspace.refreshTerminal(cTerminal, westWorkspace, envScript);
        return cTerminal;
      }
    }

    return WestWorkspace.openTerminal(westWorkspace, envScript);
  }

}
