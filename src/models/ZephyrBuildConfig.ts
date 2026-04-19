import * as vscode from 'vscode';
import fs from "fs";
import path from 'path';
import { ZephyrApplication } from "./ZephyrApplication";
import { getBuildEnv, loadConfigEnv } from "../utils/env/zephyrEnvUtils";
import {
  concatCommands,
  getConfiguredWorkbenchPath,
  getShellCdCommand,
  getShellClearCommand,
  getShellEchoCommand,
  getConfiguredVenvPath,
  getResolvedShell,
  getShellSetEnvCommand,
  getShellSourceCommand,
  classifyShell,
  normalizePathForShell,
  winToPosixPath,
} from '../utils/execUtils';
import { getBoardFromIdentifier } from '../utils/zephyr/boardDiscovery';
import {
  fileExists,
  getConfigValue,
  getSelectedToolchainVariantEnv,
  getWestWorkspace,
  tryGetZephyrSdkInstallation,
} from '../utils/utils';
import {
  ZEPHYR_BUILD_CONFIG_WEST_FLAGS_D_SETTING_KEY,
  ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY,
  ZEPHYR_WORKBENCH_SETTING_SECTION_KEY,
} from '../constants';
import { composeWestBuildArgs, normalizeWestFlagDValue } from '../utils/zephyr/westArgUtils';
import { mergeOpenocdBuildFlag } from '../utils/debugTools/debugToolSelectionUtils';
import { getPyOcdTargetFromRunnersYaml, readRunnersYamlForProject } from '../utils/zephyr/runnersYamlUtils';

export class ZephyrBuildConfig {
  name: string;
  active: boolean = true;
  boardIdentifier!: string;
  envVars: { [key: string]: any } = {
    EXTRA_CONF_FILE: [],
    EXTRA_DTC_OVERLAY_FILE: [],
    EXTRA_ZEPHYR_MODULES: [],
    SHIELD: [],
    SNIPPETS: [],
  };
  westArgs: string = '';
  westFlagsD: string[] = [];
  defaultRunner?: string;
  customArgs?: string;

  sysbuild: string = "false";

  constructor(
    name?: string,
  ) {
    this.name = name ?? '';
  }

  get boardId(): string {
    return this.boardIdentifier;
  }

  set boardId(value: string) {
    this.boardIdentifier = value;
  }

  parseSettings(buildConfig: any, workspaceFolder: vscode.WorkspaceFolder) {
    this.active = buildConfig['active'] === "true" ? true : false;
    this.boardIdentifier = buildConfig['board'];
    if (typeof buildConfig['default-runner'] === 'string' && buildConfig['default-runner'].length > 0) {
      this.defaultRunner = buildConfig['default-runner'];
    } else {
      this.defaultRunner = undefined;
    }
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
    for (const key in this.envVars) {
      const values = loadConfigEnv(workspaceFolder, this.name, key);
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
   * Build directory for this configuration under the application root.
   */
  getBuildDir(application: ZephyrApplication): string {
    return path.join(application.appRootPath, this.relativeBuildDir);
  }

  // Some generated layouts place artifacts under an extra application-name
  // directory, so probe both shapes before concluding that an artifact is missing.
  private getBuildArtifactCandidates(application: ZephyrApplication, ...segments: string[]): string[] {
    const buildDir = this.getBuildDir(application);
    const appFolderName = application.appWorkspaceFolder?.name;
    const candidates: string[] = [];

    if (appFolderName && appFolderName.length > 0) {
      candidates.push(path.join(buildDir, appFolderName, ...segments));
    }
    candidates.push(path.join(buildDir, ...segments));

    return candidates;
  }

  getBuildArtifactPath(application: ZephyrApplication, ...segments: string[]): string | undefined {
    return this.getBuildArtifactCandidates(application, ...segments).find(candidate => fileExists(candidate));
  }

  getInternalDebugDir(application: ZephyrApplication): string {
    return path.join(application.appRootPath, this.relativeInternalDebugDir);
  }

  // Centralize config-specific env assembly so tasks, terminals and debug
  // helpers all derive the same BOARD/BUILD_DIR/WEST_ARGS view.
  private composeBuildEnv(application: ZephyrApplication): { [key: string]: string; } {
    const westBuildArgs = composeWestBuildArgs(this.westArgs, mergeOpenocdBuildFlag(application, this.westArgs, this.westFlagsD));
    let baseEnv: { [key: string]: string; } = {
      BOARD: this.boardIdentifier,
      BUILD_DIR: this.getBuildDir(application),
      ...(westBuildArgs) ? { WEST_ARGS: westBuildArgs } : {}
    };

    const envVars = { ...this.envVars };

    if (this.sysbuild === "true") {
      delete envVars.EXTRA_CONF_FILE;
    }

    const additionalEnv = getBuildEnv(envVars);
    baseEnv = { ...baseEnv, ...additionalEnv };
    return baseEnv;
  }

  getBuildEnv(application: ZephyrApplication): { [key: string]: string; } {
    return this.composeBuildEnv(application);
  }

  getBuildEnvWithVar(application: ZephyrApplication): { [key: string]: string; } {
    return this.composeBuildEnv(application);
  }

  async getCompatibleRunners(application: ZephyrApplication): Promise<string[]> {
    const runnersYaml = readRunnersYamlForProject(application, this);
    let runners = runnersYaml?.runners ?? [];

    // Fall back to board metadata when runners.yaml has not been generated yet.
    if (runners.length === 0) {
      try {
        const westWorkspace = getWestWorkspace(application.westWorkspaceRootPath);
        const board = await getBoardFromIdentifier(this.boardIdentifier, westWorkspace, application, this);
        runners = board.getCompatibleRunners();
      } catch {
        runners = [];
      }
    }

    return runners;
  }

  getPyOCDTarget(application: ZephyrApplication): string | undefined {
    return getPyOcdTargetFromRunnersYaml(readRunnersYamlForProject(application, this));
  }

  getKConfigValue(application: ZephyrApplication, configKey: string): string | undefined {
    const dotConfig = this.getBuildArtifactPath(application, 'zephyr', '.config');
    if (dotConfig && fileExists(dotConfig)) {
      return getConfigValue(dotConfig, configKey);
    }
    return undefined;
  }

  private static buildTerminalContext(application: ZephyrApplication, buildConfig: ZephyrBuildConfig) {
    const { path: shellPath, args: shellArgs } = getResolvedShell();
    const shellType = classifyShell(shellPath);
    const zephyrSdk = tryGetZephyrSdkInstallation(application.zephyrSdkPath);
    const westWorkspace = getWestWorkspace(application.westWorkspaceRootPath);
    const isWinPosix = process.platform === 'win32' &&
      (shellType === 'bash' || shellType === 'zsh' ||
        shellType === 'dash' || shellType === 'fish');

    const venvPath = getConfiguredVenvPath(application.appWorkspaceFolder);

    const env: { [key: string]: string; } = {
      ...(isWinPosix ? { CHERE_INVOKING: '1' } : {}),
      ...(zephyrSdk?.buildEnv ?? {}),
      ...westWorkspace.buildEnv,
      ...getSelectedToolchainVariantEnv(
        vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, application.appWorkspaceFolder),
        application.appWorkspaceFolder,
      ),
      ...buildConfig.getBuildEnv(application),
      ...(venvPath ? { PYTHON_VENV_PATH: venvPath } : {}),
    };

    return {
      shellPath,
      shellArgs,
      shellType,
      env,
      cwd: fs.existsSync(buildConfig.getBuildDir(application)) ? buildConfig.getBuildDir(application) : application.appRootPath,
    };
  }

  private static setupTerminal(
    terminal: vscode.Terminal,
    application: ZephyrApplication,
    buildConfig: ZephyrBuildConfig,
    envScript: string,
  ): void {
    const context = ZephyrBuildConfig.buildTerminalContext(application, buildConfig);
    const envScriptForShell = normalizePathForShell(context.shellType, envScript);
    const echoCommand = getShellEchoCommand(context.shellType);
    const clearCommand = getShellClearCommand(context.shellType);
    const envSetCommands = Object.entries(context.env).map(([key, value]) =>
      getShellSetEnvCommand(context.shellType, key, String(value)),
    );
    const printEnvCommands = Object.entries(context.env).map(([key, value]) => {
      const renderedValue = (context.shellType === 'bash')
        ? winToPosixPath(String(value))
        : String(value);
      return `${echoCommand} ${key}="${renderedValue}"`;
    });

    const setupCommand = concatCommands(
      context.shellType,
      clearCommand,
      getShellCdCommand(context.shellType, context.cwd),
      ...envSetCommands,
      getShellSourceCommand(context.shellType, envScriptForShell),
      `echo "======= Zephyr Workbench Environment ======="`,
      ...printEnvCommands,
      `echo "============================================"`,
    );

    terminal.sendText(setupCommand);
  }

  private static openTerminal(application: ZephyrApplication, buildConfig: ZephyrBuildConfig): vscode.Terminal {
    const context = ZephyrBuildConfig.buildTerminalContext(application, buildConfig);
    const opts: vscode.TerminalOptions = {
      name: `${application.appName} (${buildConfig.name}) Terminal`,
      shellPath: `${context.shellPath}`,
      shellArgs: context.shellArgs,
      env: context.env,
      cwd: context.cwd,
    };

    const terminal = vscode.window.createTerminal(opts);
    return terminal;
  }

  static getTerminal(application: ZephyrApplication, buildConfig: ZephyrBuildConfig): vscode.Terminal {
    let envScript: string | undefined = getConfiguredWorkbenchPath(
      ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY,
      application.appWorkspaceFolder,
    );
    if (!envScript) {
      throw new Error('Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Ac6 Zephyr');
    }

    const terminals = <vscode.Terminal[]>(<any>vscode.window).terminals;
    for (let i = 0; i < terminals.length; i++) {
      const currentTerminal = terminals[i];
      if (currentTerminal.name === `${application.appName} (${buildConfig.name}) Terminal`) {
        ZephyrBuildConfig.setupTerminal(currentTerminal, application, buildConfig, envScript);
        return currentTerminal;
      }
    }

    const terminal = ZephyrBuildConfig.openTerminal(application, buildConfig);
    ZephyrBuildConfig.setupTerminal(terminal, application, buildConfig, envScript);
    return terminal;
  }
}
