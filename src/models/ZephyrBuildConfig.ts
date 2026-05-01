import * as vscode from 'vscode';
import fs from "fs";
import path from 'path';
import { ZephyrApplication } from "./ZephyrApplication";
import { getBuildEnv, loadConfigEnv } from "../utils/env/zephyrEnvUtils";
import {
  buildStartupSetupShellArgs,
  buildTerminalEnvCommands,
  concatCommands,
  getConfiguredWorkbenchPath,
  getShellCdCommand,
  getShellClearCommand,
  getConfiguredVenvPath,
  getResolvedShell,
  getShellSourceCommand,
  classifyShell,
  normalizePathForShell,
  TerminalEnvGroup,
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
  // helpers all derive the same BOARD/BUILD_DIR view.
  private composeBuildEnv(application: ZephyrApplication): { [key: string]: string; } {
    let baseEnv: { [key: string]: string; } = {
      BOARD: this.boardIdentifier,
      BUILD_DIR: this.getBuildDir(application),
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
    const toolchainEnv = getSelectedToolchainVariantEnv(
      vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, application.appWorkspaceFolder),
      application.appWorkspaceFolder,
    );

    // "Zephyr build system" holds anything Zephyr / west / CMake actually consume:
    // ZEPHYR_BASE, BOARD, plus user-configured Zephyr env vars from west.yml or the
    // build-config UI (EXTRA_CONF_FILE, BOARD_ROOT, DTS_ROOT, SNIPPETS, ...).
    // "Other env variables" holds names we synthesize ourselves for the user's
    // convenience — nothing outside this extension reads them: BUILD_DIR is our
    // internal convention for the per-config build dir, WEST_ARGS / WEST_FLAGS_D
    // mirror buildConfig fields so the user can see what extra args / -D flags
    // their build config will pass.
    const SYNTHETIC_VAR_KEYS = new Set(['BUILD_DIR']);
    const wsEnv = westWorkspace.buildEnv;
    const cfgEnv = buildConfig.getBuildEnv(application);

    const buildSystemEnv: { [k: string]: string } = {};
    const otherEnv: { [k: string]: string } = {};
    for (const [k, v] of Object.entries({ ...wsEnv, ...cfgEnv })) {
      if (SYNTHETIC_VAR_KEYS.has(k)) {
        otherEnv[k] = v;
      } else {
        buildSystemEnv[k] = v;
      }
    }
    // Show the full west args line the user's build config will produce (e.g.
    // `--cmake-only -- -DCONF_FILE=foo`), composed exactly the way the build flow
    // composes it. One line is easier to read than two synthetic vars.
    const composedWestArgs = composeWestBuildArgs(buildConfig.westArgs, buildConfig.westFlagsD);
    if (composedWestArgs) {
      otherEnv.WEST_ARGS = composedWestArgs;
    }

    const groups: TerminalEnvGroup[] = [
      { label: 'Zephyr build system', env: buildSystemEnv },
      { label: 'Other env variables', env: otherEnv },
      { label: 'Toolchain', env: { ...(zephyrSdk?.buildEnv ?? {}), ...toolchainEnv } },
      {
        label: 'Helpers',
        env: {
          ...(isWinPosix ? { CHERE_INVOKING: '1' } : {}),
          ...(venvPath ? { PYTHON_VENV_PATH: venvPath } : {}),
        },
      },
    ];

    // Flatten for VS Code's createTerminal({ env }) — that API only accepts a flat record.
    const env = groups.reduce<{ [key: string]: string }>((acc, g) => ({ ...acc, ...g.env }), {});

    return {
      shellPath,
      shellArgs,
      shellType,
      env,
      groups,
      cwd: fs.existsSync(buildConfig.getBuildDir(application)) ? buildConfig.getBuildDir(application) : application.appRootPath,
    };
  }

  // Reuse path only: the shell is already running, so we have no choice but to
  // sendText. The user explicitly re-triggered "open terminal" on an existing one,
  // so a visible chained command is acceptable.
  private static refreshTerminal(
    terminal: vscode.Terminal,
    application: ZephyrApplication,
    buildConfig: ZephyrBuildConfig,
    envScript: string,
  ): void {
    const context = ZephyrBuildConfig.buildTerminalContext(application, buildConfig);
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
  // env vars are already injected via createTerminal({ env }), so the setup only needs
  // to source the env script and echo the grouped banner.
  private static openTerminal(
    application: ZephyrApplication,
    buildConfig: ZephyrBuildConfig,
    envScript: string,
  ): vscode.Terminal {
    const context = ZephyrBuildConfig.buildTerminalContext(application, buildConfig);
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
      name: `${application.appName} (${buildConfig.name}) Terminal`,
      shellPath: `${context.shellPath}`,
      shellArgs,
      env: context.env,
      cwd: context.cwd,
    };

    return vscode.window.createTerminal(opts);
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
        ZephyrBuildConfig.refreshTerminal(currentTerminal, application, buildConfig, envScript);
        return currentTerminal;
      }
    }

    return ZephyrBuildConfig.openTerminal(application, buildConfig, envScript);
  }
}
