import * as vscode from 'vscode';
import fs from 'fs';
import path from "path";
import {
  fileExists,
  getSelectedToolchainVariantEnv,
  getWestWorkspace,
  getZephyrSdkInstallation,
  tryGetZephyrSdkInstallation,
  findArmGnuToolchainInstallation,
  findIarToolchainInstallation,
} from '../utils/utils';
import {
  ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY,
  ZEPHYR_PROJECT_EXTRA_WEST_ARGS_SETTING_KEY,
  ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY,
  ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY,
  ZEPHYR_WORKBENCH_SETTING_SECTION_KEY,
} from '../constants';
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
import { loadEnv } from '../utils/env/zephyrEnvUtils';
import { ZephyrBuildConfig } from './ZephyrBuildConfig';
import { ArmGnuToolchainInstallation, IarToolchainInstallation } from './ToolchainInstallations';
import { normalizeStoredToolchainVariant } from '../utils/toolchainSelection';

/**
 * Runtime model for one Zephyr application managed by the extension.
 *
 * Important scope notes:
 * - This represents an application folder, not a west workspace. The west root
 *   used by the application is tracked separately in `westWorkspaceRootPath`.
 * - The instance is hydrated from workspace-folder settings in the constructor,
 *   so it should be treated as a snapshot of the current configuration rather
 *   than a long-lived source of truth.
 * - It owns application-scoped state such as the app root path, selected
 *   toolchain/SDK information, environment variables, and build configs.
 *
 * In practice, most callers use this model as the entry point for commands,
 * tree items, debug/run helpers, and any logic that needs to answer "what is
 * the current configuration of this Zephyr application?"
 */
export class ZephyrApplication {
  private static applicationWorkspaceCache = new Map<string, boolean>();

  readonly appWorkspaceFolder: any;
  readonly appRootPath: string;
  westWorkspaceRootPath!: string;
  zephyrSdkPath!: string;
  zephyrSdkVersion?: string;
  selectedIarToolchainInstallation!: IarToolchainInstallation;
  selectedArmGnuToolchainInstallation!: ArmGnuToolchainInstallation;
  buildConfigs: ZephyrBuildConfig[] = [];

  envVars: { [key: string]: any } = {
    EXTRA_CONF_FILE: [],
    EXTRA_DTC_OVERLAY_FILE: [],
    EXTRA_ZEPHYR_MODULES: [],
    SHIELD: [],
    SNIPPETS: [],
  };
  westArgs: string = '';

  static envVarKeys = ['EXTRA_CONF_FILE', 'EXTRA_DTC_OVERLAY_FILE', 'EXTRA_ZEPHYR_MODULES', 'SHIELD', 'SNIPPETS'];

  public constructor(
    appWorkspaceFolder: any,
    appRootPath: string,
  ) {
    this.appWorkspaceFolder = appWorkspaceFolder;
    this.appRootPath = appRootPath;
    this.parseSettings();
  }

  get appName(): string {
    return path.basename(this.appRootPath);
  }

  get prjConfUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.appWorkspaceFolder.uri, 'prj.conf');
  }

  get manifestUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.appWorkspaceFolder.uri, 'west.yaml');
  }

  // Populate the runtime model from workspace-scoped settings while keeping
  // the persisted settings keys unchanged.
  private parseSettings() {
    const cfg = vscode.workspace.getConfiguration(
      ZEPHYR_WORKBENCH_SETTING_SECTION_KEY,
      this.appWorkspaceFolder,
    );
    this.westWorkspaceRootPath = getConfiguredWorkbenchPath(
      ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY,
      this.appWorkspaceFolder,
    ) ?? '';

    const toolchainVariant = normalizeStoredToolchainVariant(cfg, cfg.get<string>("toolchain") ?? "zephyr");

    if (toolchainVariant === "iar") {
      const selectedIarPath = getConfiguredWorkbenchPath("iar", this.appWorkspaceFolder) ?? '';
      const iarToolchainInstallation = findIarToolchainInstallation(selectedIarPath);

      if (iarToolchainInstallation) {
        this.zephyrSdkPath = iarToolchainInstallation.zephyrSdkPath;
        this.selectedIarToolchainInstallation = iarToolchainInstallation;
      } else {
        vscode.window.showWarningMessage(
          `IAR toolchain ${selectedIarPath} not found in listIARs; falling back to SDK setting`
        );
        this.zephyrSdkPath = getConfiguredWorkbenchPath("sdk", this.appWorkspaceFolder) ?? '';
      }
    } else if (toolchainVariant === 'gnuarmemb') {
      const selectedArmGnuPath = getConfiguredWorkbenchPath(
        ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY,
        this.appWorkspaceFolder,
      ) ?? '';
      const armGnuToolchainInstallation = findArmGnuToolchainInstallation(selectedArmGnuPath);

      if (armGnuToolchainInstallation) {
        this.zephyrSdkPath = '';
        this.selectedArmGnuToolchainInstallation = armGnuToolchainInstallation;
      } else if (selectedArmGnuPath) {
        vscode.window.showWarningMessage(
          `Arm GNU toolchain ${selectedArmGnuPath} not found in listArmGnuToolchains`
        );
        this.zephyrSdkPath = '';
      } else {
        this.zephyrSdkPath = '';
      }
    } else {
      this.zephyrSdkPath = getConfiguredWorkbenchPath("sdk", this.appWorkspaceFolder) ?? '';
    }

    this.zephyrSdkVersion = undefined;
    if (this.zephyrSdkPath) {
      try {
        this.zephyrSdkVersion = getZephyrSdkInstallation(this.zephyrSdkPath).version.trim();
      } catch {
        this.zephyrSdkVersion = undefined;
      }
    }

    this.westArgs = vscode.workspace
      .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, this.appWorkspaceFolder)
      .get(ZEPHYR_PROJECT_EXTRA_WEST_ARGS_SETTING_KEY, '');

    for (const key of Object.keys(this.envVars)) {
      const values = loadEnv(this.appWorkspaceFolder, key);
      if (values) {
        this.envVars[key] = values;
      }
    }

    const rawBuildConfigs: any[] = vscode.workspace
      .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, this.appWorkspaceFolder)
      .get('build.configurations', []);

    rawBuildConfigs.forEach(buildConfig => {
      const config = new ZephyrBuildConfig(buildConfig.name);
      config.parseSettings(buildConfig, this.appWorkspaceFolder);
      this.buildConfigs.push(config);
    });
  }

  addBuildConfiguration(config: ZephyrBuildConfig) {
    this.buildConfigs.push(config);
  }

  getBuildConfiguration(name: string): ZephyrBuildConfig | undefined {
    return this.buildConfigs.find(config => config.name === name);
  }

  // Detect application folders via the zephyr-workbench.westWorkspace setting,
  // with a fallback to the persisted workspace settings file.
  static async isApplicationWorkspaceFolder(folder: vscode.WorkspaceFolder) {
    const applicationPath = folder.uri.fsPath;
    const cachedValue = ZephyrApplication.applicationWorkspaceCache.get(applicationPath);

    if (cachedValue !== undefined) {
      return cachedValue;
    }

    const configuredWestWorkspace = vscode.workspace
      .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, folder)
      .get<string>(ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY);
    if (configuredWestWorkspace && configuredWestWorkspace.length > 0) {
      ZephyrApplication.applicationWorkspaceCache.set(applicationPath, true);
      return true;
    }

    if (ZephyrApplication.isApplicationPath(applicationPath)) {
      ZephyrApplication.applicationWorkspaceCache.set(applicationPath, true);
      return true;
    }

    ZephyrApplication.applicationWorkspaceCache.set(applicationPath, false);
    return false;
  }

  static async getApplicationWorkspaceFolders(
    folders: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders ?? []
  ): Promise<vscode.WorkspaceFolder[]> {
    const results = await Promise.allSettled(
      folders.map(async (folder) => {
        const isApplication = await ZephyrApplication.isApplicationWorkspaceFolder(folder);
        return isApplication ? folder : undefined;
      })
    );

    return results.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []);
  }

  static invalidateApplicationWorkspaceFolder(applicationPath: string) {
    ZephyrApplication.applicationWorkspaceCache.delete(applicationPath);
  }

  static clearApplicationWorkspaceCache() {
    ZephyrApplication.applicationWorkspaceCache.clear();
  }

  static isApplicationPath(applicationPath: string): boolean {
    const settingsPath = path.join(applicationPath, '.vscode', 'settings.json');
    if (fileExists(settingsPath)) {
      try {
        const fileContent = fs.readFileSync(settingsPath, 'utf-8');
        const jsonData = JSON.parse(fileContent);
        const key = `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY}`;
        if (jsonData && typeof jsonData[key] === 'string' && jsonData[key].length > 0) {
          return true;
        }
      } catch {
        return false;
      }
    }
    return false;
  }

  static isApplicationFolder(folder: vscode.WorkspaceFolder): boolean {
    const prjConfFile = vscode.Uri.joinPath(folder.uri, 'prj.conf');
    return fileExists(prjConfFile.fsPath);
  }

  private static buildTerminalContext(application: ZephyrApplication) {
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

    const groups: TerminalEnvGroup[] = [
      { label: 'Zephyr build system', env: { ...westWorkspace.buildEnv } },
      { label: 'Toolchain', env: { ...(zephyrSdk?.buildEnv ?? {}), ...toolchainEnv } },
      {
        label: 'Helpers',
        env: {
          ...(isWinPosix ? { CHERE_INVOKING: '1' } : {}),
          ...(venvPath ? { PYTHON_VENV_PATH: venvPath } : {}),
        },
      },
    ];

    const env = groups.reduce<{ [key: string]: string }>((acc, g) => ({ ...acc, ...g.env }), {});

    return {
      shellPath,
      shellArgs,
      shellType,
      env,
      groups,
      cwd: application.appRootPath,
    };
  }

  // Reuse path only: the shell is already running, so we have to sendText.
  // Visible chained command is acceptable because the user explicitly re-triggered
  // "open terminal" on an existing one.
  private static refreshTerminal(
    terminal: vscode.Terminal,
    application: ZephyrApplication,
    envScript: string,
  ): void {
    const context = ZephyrApplication.buildTerminalContext(application);
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
  private static openTerminal(application: ZephyrApplication, envScript: string): vscode.Terminal {
    const context = ZephyrApplication.buildTerminalContext(application);
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
      name: application.appName + ' Terminal',
      shellPath: `${context.shellPath}`,
      shellArgs,
      env: context.env,
      cwd: context.cwd,
    };

    return vscode.window.createTerminal(opts);
  }

  static getTerminal(application: ZephyrApplication): vscode.Terminal {
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
      if (currentTerminal.name === application.appName + ' Terminal') {
        ZephyrApplication.refreshTerminal(currentTerminal, application, envScript);
        return currentTerminal;
      }
    }

    return ZephyrApplication.openTerminal(application, envScript);
  }

  /**
   * Return west runner names compatible with this application.
   *
   * Behavior:
   * - If a `buildConfigName` is provided and found, use it.
   * - Else use the active config, or fall back to the first.
   * - If no configs exist, return an empty list.
   */
  async getCompatibleRunners(buildConfigName?: string): Promise<string[]> {
    if (buildConfigName) {
      const cfg = this.getBuildConfiguration(buildConfigName);
      if (cfg) {
        return await cfg.getCompatibleRunners(this);
      }
    }

    const activeCfg = this.buildConfigs.find(c => c.active) ?? this.buildConfigs[0];
    if (activeCfg) {
      return await activeCfg.getCompatibleRunners(this);
    }

    return [];
  }
}
