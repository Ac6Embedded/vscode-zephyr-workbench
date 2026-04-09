import * as vscode from 'vscode';
import fs from "fs";
import path from 'path';
import yaml from 'yaml';
import { ZephyrProject } from "./ZephyrProject";
import { getBuildEnv, loadConfigEnv } from "../utils/zephyrEnvUtils";
import { concatCommands, getShellClearCommand, getShellEchoCommand, getTerminalShell, getResolvedShell, classifyShell, normalizePathForShell, winToPosixPath } from '../utils/execUtils';
import { fileExists, getBoardFromIdentifier, getConfigValue, getWestWorkspace, getZephyrSDK } from '../utils/utils';
import { ZEPHYR_BUILD_CONFIG_WEST_FLAGS_D_SETTING_KEY, ZEPHYR_DIRNAME, ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY } from '../constants';
import { composeWestBuildArgs, normalizeWestFlagDValue } from '../utils/westArgUtils';

export class ZephyrProjectBuildConfiguration {
  name: string;
  active: boolean = true;
  boardIdentifier!: string;
  // Maybe not allow changing workspace nor sdk, uncomment if needed
  // westWorkspacePath!: string;
  // sdkPath!: string;
  envVars: { [key: string]: any } = {
    EXTRA_CONF_FILE: [],
    EXTRA_DTC_OVERLAY_FILE: [],
    EXTRA_ZEPHYR_MODULES: [],
    SHIELD: [],
    SNIPPETS: [],
  };
  westArgs: string = '';
  westFlagsD: string[] = [];
  // Preferred west runner for this configuration (used for Run/Flash)
  defaultRunner?: string;
  // Custom arguments passed to the runner (e.g. -p /dev/ttyX, --erase)
  customArgs?: string;

  sysbuild: string = "false";

  constructor(
    name?: string,
  ) {
    this.name = name ?? '';
  }

  parseSettings(buildConfig: any, workspaceContext: vscode.WorkspaceFolder) {
    this.active = buildConfig['active'] === "true" ? true : false;
    this.boardIdentifier = buildConfig['board'];
    // Read persisted default runner if set; empty string means unset
    if (typeof buildConfig['default-runner'] === 'string' && buildConfig['default-runner'].length > 0) {
      this.defaultRunner = buildConfig['default-runner'];
    } else {
      this.defaultRunner = undefined;
    }
    // Read persisted custom arguments if set
    if (typeof buildConfig['custom-args'] === 'string' && buildConfig['custom-args'].length > 0) {
      this.customArgs = buildConfig['custom-args'];
    } else {
      this.customArgs = undefined;
    }
    this.westArgs = buildConfig['west-args'] ?? '';
    this.westFlagsD = Array.isArray(buildConfig[ZEPHYR_BUILD_CONFIG_WEST_FLAGS_D_SETTING_KEY])
      ? buildConfig[ZEPHYR_BUILD_CONFIG_WEST_FLAGS_D_SETTING_KEY]
          .map((value: unknown) => typeof value === 'string' ? normalizeWestFlagDValue(value) : '')
          .filter((value: string) => value.length > 0)
      : [];
    for (let key in this.envVars) {
      const values = loadConfigEnv(workspaceContext, this.name, key);
      if (values) {
        this.envVars[key] = values;
      }
    }
    if (typeof buildConfig["sysbuild"] !== "undefined") {
      this.sysbuild = buildConfig["sysbuild"];
    } else {
      this.sysbuild = "false";
    }
  }

  setBoard(boardIdentifier: string) {
    this.boardIdentifier = boardIdentifier;
  }

  get relativeRootBuildDir(): string {
    return path.join('build', this.name);
  }

  get relativeBuildDir(): string {
    return path.join(this.relativeRootBuildDir);
  }

  get relativeInternalDebugDir(): string {
    return path.join(this.relativeRootBuildDir, '.debug');
  }

  /**
   * Build directory
   */
  getBuildDir(parentProject: ZephyrProject): string {
    return path.join(parentProject.folderPath, this.relativeBuildDir);
  }

  private getBuildArtifactCandidates(parentProject: ZephyrProject, ...segments: string[]): string[] {
    const buildDir = this.getBuildDir(parentProject);
    const appFolderName = parentProject.workspaceContext?.name;
    const candidates: string[] = [];

    if (appFolderName && appFolderName.length > 0) {
      candidates.push(path.join(buildDir, appFolderName, ...segments));
    }
    candidates.push(path.join(buildDir, ...segments));

    return candidates;
  }

  getBuildArtifactPath(parentProject: ZephyrProject, ...segments: string[]): string | undefined {
    return this.getBuildArtifactCandidates(parentProject, ...segments).find(candidate => fileExists(candidate));
  }

  /**
   * Under build directory, the internal debug directory is used to generate wrappers, files, etc...
   * and is not removed after pristine rebuilt. 
   */
  getInternalDebugDir(parentProject: ZephyrProject): string {
    return path.join(parentProject.folderPath, this.relativeInternalDebugDir);
  }

  getBuildEnv(parentProject: ZephyrProject): { [key: string]: string; } {
    const westBuildArgs = composeWestBuildArgs(this.westArgs, this.westFlagsD);
    let baseEnv: { [key: string]: string; } = {
      BOARD: this.boardIdentifier,
      BUILD_DIR: this.getBuildDir(parentProject),
      ...(westBuildArgs) ? { WEST_ARGS: westBuildArgs } : {}
    };
    
    // Make a copy of envVars to modify
    let envVars = { ...this.envVars };

    // If sysbuild is true, remove EXTRA_CONF_FILE from envVars
    if (this.sysbuild === "true") {
      delete envVars.EXTRA_CONF_FILE;
    }

    let additionalEnv = getBuildEnv(envVars);
    baseEnv = { ...baseEnv, ...additionalEnv };
    return baseEnv;
  }

  getBuildEnvWithVar(parentProject: ZephyrProject): { [key: string]: string; } {
    const westBuildArgs = composeWestBuildArgs(this.westArgs, this.westFlagsD);
    let baseEnv: { [key: string]: string; } = {
      BOARD: this.boardIdentifier,
      BUILD_DIR: this.getBuildDir(parentProject),
      ...(westBuildArgs) ? { WEST_ARGS: westBuildArgs } : {}
    };

    // Make a copy of envVars to modify
    let envVars = { ...this.envVars };

    // If sysbuild is true, remove EXTRA_CONF_FILE from envVars
    if (this.sysbuild === "true") {
      delete envVars.EXTRA_CONF_FILE;
    }

    let additionalEnv = getBuildEnv(envVars);
    baseEnv = { ...baseEnv, ...additionalEnv };
    return baseEnv;
  }

  async getCompatibleRunners(parentProject: ZephyrProject): Promise<string[]> {
    let runners: string[] = [];

    // Search in project build directory runners.yaml
    const runnersYAMLFilepath = this.getBuildArtifactPath(parentProject, ZEPHYR_DIRNAME, 'runners.yaml');
    if (runnersYAMLFilepath && fileExists(runnersYAMLFilepath)) {
      const runnersYAMLFile = fs.readFileSync(runnersYAMLFilepath, 'utf8');
      const data = yaml.parse(runnersYAMLFile);
      runners = data.runners;
    }

    // Search in board.cmake if runners.yaml does not exists
    if (runners.length === 0) {
      try {
        const westWorkspace = getWestWorkspace(parentProject.westWorkspacePath);
        const board = await getBoardFromIdentifier(this.boardIdentifier, westWorkspace, parentProject, this);
        runners = board.getCompatibleRunners();
      } catch {
        runners = [];
      }
    }

    return runners;
  }

  getPyOCDTarget(parentProject: ZephyrProject): string | undefined {
    const runnersYAMLFilepath = this.getBuildArtifactPath(parentProject, ZEPHYR_DIRNAME, 'runners.yaml');
    if (runnersYAMLFilepath && fileExists(runnersYAMLFilepath)) {
      const runnersYAMLFile = fs.readFileSync(runnersYAMLFilepath, 'utf8');
      const data = yaml.parse(runnersYAMLFile);
      const pyOCDArgs = data?.args?.pyocd;
      if (pyOCDArgs) {
        const targetArg = pyOCDArgs.find((arg: string) => arg.startsWith('--target='));
        if (targetArg) {
          return targetArg.split('=')[1];
        }
      }
    }
    return undefined;
  }

  getKConfigValue(parentProject: ZephyrProject, configKey: string): string | undefined {
    const dotConfig = this.getBuildArtifactPath(parentProject, 'zephyr', '.config');
    if (dotConfig && fileExists(dotConfig)) {
      return getConfigValue(dotConfig, configKey);
    }
    return undefined;
  }

  private static openTerminal(zephyrProject: ZephyrProject, buildConfig: ZephyrProjectBuildConfiguration): vscode.Terminal {
    const { path: shellPath, args: shellArgs } = getResolvedShell();
    const shellType = classifyShell(shellPath);
    const zephyrSdk = getZephyrSDK(zephyrProject.sdkPath);
    const westWorkspace = getWestWorkspace(zephyrProject.westWorkspacePath);

    const isWinPosix = process.platform === 'win32' &&
                   (shellType === 'bash' || shellType === 'zsh' ||
                    shellType === 'dash' || shellType === 'fish');

    let venvPath: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY);
    if (!venvPath || venvPath.length === 0) {
      venvPath = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, zephyrProject.workspaceFolder.uri).get(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY);
    }

    const opts: vscode.TerminalOptions = {
      name: `${zephyrProject.folderName} (${buildConfig.name}) Terminal`,
      shellPath: `${shellPath}`,
      shellArgs: shellArgs,
      env: { ...(isWinPosix ? { CHERE_INVOKING: '1' } : {}), ...zephyrSdk.buildEnv, ...westWorkspace.buildEnv, ...buildConfig.getBuildEnv(zephyrProject) },
      cwd: fs.existsSync(buildConfig.getBuildDir(zephyrProject)) ? buildConfig.getBuildDir(zephyrProject) : zephyrProject.folderPath
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

    if (venvPath) {
      opts.env = {
        PYTHON_VENV_PATH: venvPath,
        ...opts.env
      };
    }

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

  static getTerminal(zephyrProject: ZephyrProject, buildConfig: ZephyrProjectBuildConfiguration): vscode.Terminal {
    const terminals = <vscode.Terminal[]>(<any>vscode.window).terminals;
    for (let i = 0; i < terminals.length; i++) {
      const cTerminal = terminals[i];
      if (cTerminal.name === `${zephyrProject.folderName} (${buildConfig.name}) Terminal`) {
        return cTerminal;
      }
    }

    let envScript: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
    if (!envScript) {
      throw new Error('Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Ac6 Zephyr');
    }

    let terminal = ZephyrProjectBuildConfiguration.openTerminal(zephyrProject, buildConfig);
    const { path: shellPath, args: shellArgs } = getResolvedShell();
    const shellType = classifyShell(shellPath);
    envScript = normalizePathForShell(shellType, envScript);
    let srcEnvCmd = `. ${envScript}`;
    terminal.sendText(srcEnvCmd);

    return terminal;
  }
}
