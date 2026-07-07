import * as vscode from 'vscode';
import * as path from 'path';
import { ZephyrApplication } from '../models/ZephyrApplication';
import { getWestWorkspace, readDirectoryEntries } from '../utils/utils';
import { ZephyrBuildConfig } from '../models/ZephyrBuildConfig';
import { ZEPHYR_BUILD_CONFIG_WEST_ARGS_SETTING_KEY } from '../constants';
import {
  getEffectiveWorkspaceApplicationEntry,
  resolveWorkspaceApplicationPath,
} from '../utils/zephyr/workspaceApplications';
import { checkSdkCompatibility, clearSdkCompatCache, formatSdkCompatMessage } from '../utils/zephyr/sdkCompatUtils';
import { resolveGlobalSdkForZephyr } from '../utils/zephyr/globalSdkService';

const EXTRA_ENV_KEYS = ['EXTRA_CONF_FILE', 'EXTRA_DTC_OVERLAY_FILE', 'EXTRA_ZEPHYR_MODULES'];
const WEST_ARGUMENTS_LABEL = 'west Arguments';
const WEST_FLAGS_D_LABEL = 'west Flags -D';

export class ZephyrApplicationDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | void> = this._onDidChangeTreeData.event;

  // Accordion state for the per-app Code Explorer: the appRootPath (normalized)
  // of the single app whose Code Explorer sub-node is currently expanded, or
  // undefined when none is. Opening one collapses the others (see extension.ts).
  private expandedExplorerRoot: string | undefined;

  constructor() {

	}

  getTreeItem(element: any): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element;
  }

  async getChildren(element?: any): Promise< vscode.TreeItem[] > {
		const items: vscode.TreeItem[] = [];
    if(element === undefined) {
      if(vscode.workspace.workspaceFolders) {
        const applications = await ZephyrApplication.getApplications(vscode.workspace.workspaceFolders);
        for (const appProject of applications) {
          const item =  new ZephyrApplicationTreeItem(appProject, vscode.TreeItemCollapsibleState.Collapsed);
          // Stable id so TreeView.reveal() can match this app node when walking
          // up from a Code Explorer file node (getParent reconstructs the same id).
          item.id = `app:${appProject.appRootPath}`;
          items.push(item);
        }
        return Promise.resolve(items);
      }
    }
    
    if(element instanceof ZephyrApplicationTreeItem) {
      const workspaceItem = new ZephyrApplicationWestWorkspaceTreeItem(element.project);
      items.push(workspaceItem);
      // Toolchain row sits next to the west workspace row because both are
      // application-scoped (apply across all build configs), unlike the
      // board/runner/env rows that belong to a specific build config.
      items.push(new ZephyrApplicationToolchainTreeItem(element.project));

      if(element.project.buildConfigs.length > 1) {
        for(let config of element.project.buildConfigs) {
          const buildConfigItem = new ZephyrConfigTreeItem(element.project, config, vscode.TreeItemCollapsibleState.Collapsed);
          items.push(buildConfigItem);
        }
      } else if(element.project.buildConfigs.length === 1) {
        const config = element.project.buildConfigs[0];
        const boardItem = new ZephyrConfigBoardTreeItem(element.project, config);
        const runnerItem = new ZephyrConfigDefaultRunnerTreeItem(element.project, config);
        items.push(boardItem, runnerItem);
        // Show custom args below the runner when set
        if (config.defaultRunner && config.defaultRunner.length > 0 && config.customArgs && config.customArgs.length > 0) {
          const customArgsItem = new ZephyrConfigCustomArgsTreeItem(element.project, config);
          items.push(customArgsItem);
        }
        // Arguments & Environment: collapsible group holding west Arguments,
        // west Flags -D, EXTRA, and the env-var rows (SHIELD, SNIPPETS, ...).
        items.push(new ZephyrConfigArgsEnvTreeItem(element.project, config));
      }
      // Per-application Code Explorer: a plain, browsable file tree rooted at
      // the app folder. Rendered last so it sits below the build info. Its
      // expanded/collapsed state is driven by the accordion logic (extension.ts).
      items.push(new ZephyrCodeExplorerTreeItem(element.project, this.isExplorerExpanded(element.project)));

      return Promise.resolve(items);
    }

    if(element instanceof ZephyrCodeExplorerTreeItem) {
      return this.listCodeExplorerDirectory(element.project, vscode.Uri.file(element.project.appRootPath), true);
    }

    if(element instanceof ZephyrCodeExplorerEntryTreeItem) {
      if(!element.isDirectory) {
        return Promise.resolve([]);
      }
      return this.listCodeExplorerDirectory(element.project, element.uri, false);
    }

    if(element instanceof ZephyrConfigTreeItem) {
      const boardItem = new ZephyrConfigBoardTreeItem(element.project, element.buildConfig);
      const runnerItem = new ZephyrConfigDefaultRunnerTreeItem(element.project, element.buildConfig);
      items.push(boardItem, runnerItem);
      // Show custom args below the runner when set
      if (element.buildConfig.defaultRunner && element.buildConfig.defaultRunner.length > 0 && element.buildConfig.customArgs && element.buildConfig.customArgs.length > 0) {
        const customArgsItem = new ZephyrConfigCustomArgsTreeItem(element.project, element.buildConfig);
        items.push(customArgsItem);
      }
      items.push(new ZephyrConfigArgsEnvTreeItem(element.project, element.buildConfig));

      return Promise.resolve(items);
    }

    if(element instanceof ZephyrConfigArgsEnvTreeItem) {
      return Promise.resolve(this.configOptionRows(element.project, element.config));
    }

    if(element instanceof ZephyrApplicationEnvTreeItem) {
      // Get Zephyr environment variables
      let values = element.project.envVars[element.envKey];
      if(values) {
        for(let value of values) {
          const envValueItem = new ZephyrApplicationEnvValueTreeItem(element.project, element.envKey, value);
          items.push(envValueItem);
        }
      }
      
      return Promise.resolve(items);
    } 

    if(element instanceof ZephyrApplicationArgTreeItem) {
      // Get West Argument
      const items: vscode.TreeItem[] = [];
      if(element.project.westArgs && element.project.westArgs.length > 0) {
        const westArgsItem = new ZephyrApplicationArgValueTreeItem(element.project, WEST_ARGUMENTS_LABEL, element.project.westArgs);
        items.push(westArgsItem);
      } 
      return Promise.resolve(items);
    } 

    if(element instanceof ZephyrConfigExtraEnvTreeItem) {
      for (const key of EXTRA_ENV_KEYS) {
        if (Array.isArray(element.config.envVars[key])) {
          items.push(new ZephyrConfigEnvTreeItem(element.project, element.config, key));
        }
      }
      return Promise.resolve(items);
    }

    if(element instanceof ZephyrConfigEnvTreeItem) {
      // Get Zephyr environment variables
      let values = element.config.envVars[element.envKey];
      if(values) {
        for(let value of values) {
          const envValueItem = new ZephyrConfigEnvValueTreeItem(element.project, element.config, element.envKey, value);
          items.push(envValueItem);
        }
      }
      
      return Promise.resolve(items);
    } 

    if (element instanceof ZephyrConfigWestFlagsDTreeItem) {
      for (const value of element.config.westFlagsD) {
        items.push(new ZephyrConfigWestFlagsDValueTreeItem(element.project, element.config, value));
      }
      return Promise.resolve(items);
    }

    if(element instanceof ZephyrConfigArgTreeItem) {
      // Get West Argument
      const items: vscode.TreeItem[] = [];
      if(element.argName === WEST_ARGUMENTS_LABEL) {
        if(element.config.westArgs && element.config.westArgs.length > 0) {
          const westArgsItem = new ZephyrConfigArgValueTreeItem(element.project, element.config, WEST_ARGUMENTS_LABEL, element.config.westArgs);
          items.push(westArgsItem);
        } 
      } else {
        if(element.config.envVars[element.argName] && element.config.envVars[element.argName].length > 0) {
          const westArgsItem = new ZephyrConfigArgValueTreeItem(element.project, element.config, element.argName, element.config.envVars[element.argName]);
          items.push(westArgsItem);
        } 
      }

      
      return Promise.resolve(items);
    } 

    return Promise.resolve([]);
  }

  getParent(element: any): vscode.ProviderResult<vscode.TreeItem> {
    // Only the Code Explorer branch needs a real parent chain (TreeView.reveal
    // walks it up to the root). Ancestors are reconstructed with the same ids
    // that getChildren() produces so VS Code can match them.
    if (element instanceof ZephyrCodeExplorerEntryTreeItem) {
      const parentDir = path.dirname(element.uri.fsPath);
      if (path.normalize(parentDir) === path.normalize(element.project.appRootPath)) {
        return new ZephyrCodeExplorerTreeItem(element.project, this.isExplorerExpanded(element.project));
      }
      return new ZephyrCodeExplorerEntryTreeItem(element.project, vscode.Uri.file(parentDir), true);
    }
    if (element instanceof ZephyrCodeExplorerTreeItem) {
      const appItem = new ZephyrApplicationTreeItem(element.project, vscode.TreeItemCollapsibleState.Collapsed);
      appItem.id = `app:${element.project.appRootPath}`;
      return appItem;
    }
    return null;
  }

  resolveTreeItem(item: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem> {
    // Code Explorer folder items intentionally carry no tooltip/command; return
    // them unchanged rather than throwing when VS Code asks to resolve them.
    return item;
  }

  /**
   * Whether the given app's Code Explorer sub-node is the currently expanded one.
   */
  private isExplorerExpanded(project: ZephyrApplication): boolean {
    return this.expandedExplorerRoot !== undefined
      && this.expandedExplorerRoot === path.normalize(project.appRootPath);
  }

  /** The normalized appRootPath whose Code Explorer is currently expanded, if any. */
  get activeExplorerRoot(): string | undefined {
    return this.expandedExplorerRoot;
  }

  /**
   * Set which app's Code Explorer is expanded (accordion). Fires a lightweight
   * tree refresh WITHOUT the cache-clearing that refresh() does, so the other
   * apps' Code Explorer nodes re-render collapsed (their id encodes the state,
   * which is what makes VS Code actually collapse an already-expanded node).
   */
  setExpandedExplorer(appRootPath: string | undefined): void {
    const normalized = appRootPath ? path.normalize(appRootPath) : undefined;
    if (this.expandedExplorerRoot === normalized) {
      return;
    }
    this.expandedExplorerRoot = normalized;
    this._onDidChangeTreeData.fire();
  }

  /** Lightweight refresh of the whole tree (used after file operations). */
  refreshCodeExplorer(): void {
    this._onDidChangeTreeData.fire();
  }

  /**
   * Build the option rows grouped under a build config's "Arguments &
   * Environment" node: west Arguments, west Flags -D, EXTRA (a sub-group), and
   * the remaining env-var rows (SHIELD, SNIPPETS, ...). Shared by the
   * single-config app node and each multi-config build-config node so both
   * render identically. The rows keep their original classes/contextValues, so
   * their existing right-click menus and edit commands keep working unchanged.
   */
  private configOptionRows(project: ZephyrApplication, config: ZephyrBuildConfig): vscode.TreeItem[] {
    const rows: vscode.TreeItem[] = [];
    rows.push(new ZephyrConfigArgTreeItem(project, config, WEST_ARGUMENTS_LABEL, config.westArgs, ZEPHYR_BUILD_CONFIG_WEST_ARGS_SETTING_KEY));
    rows.push(new ZephyrConfigWestFlagsDTreeItem(project, config));
    rows.push(new ZephyrConfigExtraEnvTreeItem(project, config));
    for (const key of Object.keys(config.envVars)) {
      if (EXTRA_ENV_KEYS.includes(key)) {
        continue;
      }
      if (Array.isArray(config.envVars[key])) {
        rows.push(new ZephyrConfigEnvTreeItem(project, config, key));
      } else {
        rows.push(new ZephyrConfigArgTreeItem(project, config, key, config.envVars[key]));
      }
    }
    return rows;
  }

  /**
   * List a directory as sorted Code Explorer entries (folders first, then files,
   * case-insensitive). At the app root, hides the build output and .git folders.
   */
  private async listCodeExplorerDirectory(
    project: ZephyrApplication,
    dir: vscode.Uri,
    isRoot: boolean,
  ): Promise<vscode.TreeItem[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await readDirectoryEntries(dir);
    } catch {
      return [];
    }
    const dirs: ZephyrCodeExplorerEntryTreeItem[] = [];
    const files: ZephyrCodeExplorerEntryTreeItem[] = [];
    for (const [name, type] of entries) {
      if (isRoot && CODE_EXPLORER_IGNORED_ROOT_ENTRIES.has(name)) {
        continue;
      }
      const childUri = vscode.Uri.joinPath(dir, name);
      const isDirectory = (type & vscode.FileType.Directory) === vscode.FileType.Directory;
      (isDirectory ? dirs : files).push(new ZephyrCodeExplorerEntryTreeItem(project, childUri, isDirectory));
    }
    const byName = (a: ZephyrCodeExplorerEntryTreeItem, b: ZephyrCodeExplorerEntryTreeItem) =>
      path.basename(a.uri.fsPath).toLowerCase().localeCompare(path.basename(b.uri.fsPath).toLowerCase());
    dirs.sort(byName);
    files.sort(byName);
    return [...dirs, ...files];
  }

  refresh(): void {
    ZephyrApplication.clearApplicationWorkspaceCache();
    clearSdkCompatCache();
		this._onDidChangeTreeData.fire();
	}

}

export class ZephyrApplicationTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrApplication,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
	) {
    if(project.appRootPath) {
      super(project.appName, collapsibleState);
      try {
        let westWorkspace = getWestWorkspace(project.westWorkspaceRootPath);
        if(westWorkspace !== null) {
          const selectedDescription = isSelectedWorkspaceApplication(project) ? ' [selected]' : '';
          this.description = project.buildConfigs.length > 0
            ? `[with ${westWorkspace.name}]${selectedDescription}`
            : `[invalid]`;
          this.contextValue = 'zephyr-application';
        } else {
          this.description = `[not configured]`;
          this.contextValue = 'zephyr-application-not-config';
        }
      } catch(e) {
        console.error(e, " path: ", project.westWorkspaceRootPath);
      }
      this.iconPath = new vscode.ThemeIcon('folder');
      this.tooltip = project.appRootPath;
    }
	}
}

function isSelectedWorkspaceApplication(project: ZephyrApplication): boolean {
  if (!project.isWestWorkspaceApplication) {
    return false;
  }

  const effectiveEntry = getEffectiveWorkspaceApplicationEntry(project.appWorkspaceFolder);
  const effectivePath = effectiveEntry
    ? resolveWorkspaceApplicationPath(effectiveEntry, project.appWorkspaceFolder)
    : undefined;
  return !!effectivePath && path.normalize(effectivePath) === path.normalize(project.appRootPath);
}

export class ZephyrConfigTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrApplication,
    public readonly buildConfig: ZephyrBuildConfig,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
	) {
    if(buildConfig) {
      super(buildConfig.name, collapsibleState);
      this.tooltip = project.appRootPath;

      if(buildConfig.active) {
        this.iconPath = new vscode.ThemeIcon('folder-active');
        this.description = `[${buildConfig.boardIdentifier}] [active]`;
        this.contextValue = 'zephyr-build-config-active';
      } else {
        this.iconPath = new vscode.ThemeIcon('folder');
        this.description = `[${buildConfig.boardIdentifier}] [not active]`;
        this.contextValue = 'zephyr-build-config';
      }
    }
	}
}

// Application-scoped toolchain row. Right-clicking it triggers the existing
// change-toolchain command, which reads `node.project` — kept compatible by
// extending ZephyrApplicationTreeItem so the same payload is exposed.
export class ZephyrApplicationToolchainTreeItem extends ZephyrApplicationTreeItem {
  constructor(
    public readonly project: ZephyrApplication,
  ) {
    super(project, vscode.TreeItemCollapsibleState.None);

    // Use the same naming as the Toolchains sidebar so the row identifies the
    // exact installation in use (e.g. `zephyr-sdk-1.6.0` for Zephyr SDK,
    // `IAR-…` for IAR, `Arm GNU 12.2 (arm-none-eabi)` for Arm GNU). Falls
    // back to `[not set]` when the variant has no resolvable installation.
    const variant = project.toolchainVariant;
    let installationName: string | undefined;
    let detailPath: string | undefined;
    if (variant === 'iar') {
      installationName = project.selectedIarToolchainInstallation?.name;
      detailPath = project.selectedIarToolchainInstallation?.iarPath;
    } else if (variant === 'gnuarmemb') {
      installationName = project.selectedArmGnuToolchainInstallation?.name;
      detailPath = project.selectedArmGnuToolchainInstallation?.toolchainPath;
    } else if (project.isGlobalSdk) {
      // 'global' sentinel: show which detected SDK the build would pick
      // (advisory; the build system makes the final pick at build time).
      installationName = 'Global Zephyr SDK';
      let kernelPath: string | undefined;
      try {
        kernelPath = getWestWorkspace(project.westWorkspaceRootPath).kernelUri.fsPath;
      } catch {
        kernelPath = undefined;
      }
      detailPath = resolveGlobalSdkForZephyr(kernelPath)?.rootUri.fsPath;
    } else {
      // 'zephyr' / 'zephyr/llvm': the SDK installation isn't loaded eagerly,
      // so derive the install folder name from the configured path the same
      // way ZephyrSdkInstallation.name does (`path.basename(rootUri.fsPath)`).
      if (project.zephyrSdkPath) {
        installationName = path.basename(project.zephyrSdkPath);
        detailPath = project.zephyrSdkPath;
      }
    }

    // A pinned Rust toolchain rides on top of the C toolchain; surface it
    // next to the C variant instead of replacing it.
    const rustInstallation = project.selectedRustToolchainInstallation;
    this.label = installationName ?? 'toolchain';
    this.description = installationName
      ? (rustInstallation ? `[${variant} + rust]` : `[${variant}]`)
      : '[not set]';
    if (project.isGlobalSdk) {
      this.description += detailPath
        ? ` auto-detected: ${path.basename(detailPath)}`
        : ' (no global SDK detected)';
    }
    const rustDetail = rustInstallation ? `\nRust toolchain: ${rustInstallation.toolchainPath}` : '';
    this.tooltip = detailPath
      ? project.isGlobalSdk
        ? `${installationName} (${variant})\nAuto-detected: ${detailPath}\nThe build system makes the final pick at build time.${rustDetail}`
        : `${installationName} (${variant})\n${detailPath}${rustDetail}`
      : project.isGlobalSdk
        ? `Global Zephyr SDK (${variant}): no global SDK detected on this machine${rustDetail}`
        : `Toolchain not set (${variant})${rustDetail}`;
    // Mirror the Toolchains sidebar's icon-per-vendor convention so the row
    // tells the user which toolchain family is in use at a glance:
    //   - IAR uses the IAR logo (raster, no theme variants).
    //   - Arm GNU uses the dedicated Arm GNU glyph.
    //   - Zephyr SDK (default) uses the generic toolchain glyph.
    if (variant === 'iar') {
      this.iconPath = path.join(__filename, '..', '..', 'res', 'icons', 'iar-logo.jpg');
    } else if (variant === 'gnuarmemb') {
      this.iconPath = {
        light: path.join(__filename, '..', '..', 'res', 'icons', 'light', 'arm_gnu_icon_light.svg'),
        dark: path.join(__filename, '..', '..', 'res', 'icons', 'dark', 'arm_gnu_icon_dark.svg'),
      };
    } else if (rustInstallation) {
      this.iconPath = {
        light: path.join(__filename, '..', '..', 'res', 'icons', 'light', 'rust_icon_light.svg'),
        dark: path.join(__filename, '..', '..', 'res', 'icons', 'dark', 'rust_icon_dark.svg'),
      };
    } else {
      this.iconPath = {
        light: path.join(__filename, '..', '..', 'res', 'icons', 'light', 'toolchain_icon_light.svg'),
        dark: path.join(__filename, '..', '..', 'res', 'icons', 'dark', 'toolchain_icon_dark.svg'),
      };
    }

    // Passive SDK <-> Zephyr compatibility badge (Zephyr SDK variants only).
    // Verdicts are cached by sdkCompatUtils and cleared on provider refresh.
    if ((variant === 'zephyr' || variant === 'zephyr/llvm') && project.zephyrSdkVersion) {
      try {
        const westWorkspace = getWestWorkspace(project.westWorkspaceRootPath);
        const verdict = checkSdkCompatibility(project.zephyrSdkVersion, westWorkspace.kernelUri.fsPath);
        const message = formatSdkCompatMessage(verdict, project.zephyrSdkVersion);
        if (message) {
          this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
          this.description = `${this.description} ⚠ ${verdict.status === 'partial' ? 'partially compatible' : 'incompatible'} with Zephyr ${verdict.zephyrVersion}`;
          this.tooltip = `${this.tooltip}\n${message}`;
        }
      } catch {
        // Unknown compatibility -> no badge.
      }
    }
  }

  contextValue = 'zephyr-application-toolchain';
}

export class ZephyrApplicationWestWorkspaceTreeItem extends ZephyrApplicationTreeItem {
  constructor(
		public readonly project: ZephyrApplication,
	) {
    super(project, vscode.TreeItemCollapsibleState.None);
    let westWorkspace = getWestWorkspace(project.westWorkspaceRootPath);
    if(westWorkspace) {
      this.label = westWorkspace.name;
      this.description = `[${westWorkspace.version}]`;
      this.tooltip = westWorkspace.rootUri.fsPath;
      this.iconPath = {
        light: path.join(__filename, '..', '..', 'res', 'icons', 'zephyr.svg'),
        dark: path.join(__filename, '..', '..', 'res', 'icons', 'zephyr.svg')
      };
    }
	}

  contextValue = 'zephyr-application-workspace';
}

export class ZephyrConfigBoardTreeItem extends vscode.TreeItem {
  constructor(
    public readonly project: ZephyrApplication,
		public readonly config: ZephyrBuildConfig,
	) {
    super(config.boardIdentifier, vscode.TreeItemCollapsibleState.None);
    this.description = '';
    this.tooltip = config.boardIdentifier;
    this.iconPath = new vscode.ThemeIcon('circuit-board');
	}
  
  contextValue = 'zephyr-application-board';
}

export class ZephyrConfigDefaultRunnerTreeItem extends vscode.TreeItem {
  constructor(
    public readonly project: ZephyrApplication,
    public readonly config: ZephyrBuildConfig,
  ) {
    super('Flash runner', vscode.TreeItemCollapsibleState.None);
    const hasDefaultRunner = !!(config.defaultRunner && config.defaultRunner.length > 0);
    this.description = hasDefaultRunner ? config.defaultRunner : '[not set]';
    this.tooltip = hasDefaultRunner ? `Default runner: ${config.defaultRunner}` : 'Default runner: not set';
    this.iconPath = new vscode.ThemeIcon('run');
    this.contextValue = hasDefaultRunner ? 'zephyr-application-default-runner' : 'zephyr-application-default-runner-not-set';
  }
}

export class ZephyrConfigCustomArgsTreeItem extends vscode.TreeItem {
  constructor(
    public readonly project: ZephyrApplication,
    public readonly config: ZephyrBuildConfig,
  ) {
    super('custom arguments for runner', vscode.TreeItemCollapsibleState.None);
    this.description = config.customArgs ?? '';
    this.tooltip = `Custom arguments for runner: ${config.customArgs}`;
    this.iconPath = new vscode.ThemeIcon('symbol-parameter');
  }
  contextValue = 'zephyr-application-custom-args';
}

export class ZephyrApplicationEnvTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrApplication,
    public readonly envKey: string
	) {
    // Drop the chevron when there are no values to expand into; keeps the
    // tree row visually consistent with leaf nodes that have no children.
    const isEmpty = project.envVars[envKey].length === 0;
    super(envKey, isEmpty ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    this.description = isEmpty ? '[not set]' : '';
    this.tooltip = envKey;
    this.iconPath = new vscode.ThemeIcon('variable');
	}

  contextValue = 'zephyr-application-env';
}

export class ZephyrConfigExtraEnvTreeItem extends vscode.TreeItem {
  constructor(
    public readonly project: ZephyrApplication,
    public readonly config: ZephyrBuildConfig,
  ) {
    // EXTRA is a grouping row for EXTRA_CONF_FILE / EXTRA_DTC_OVERLAY_FILE /
    // EXTRA_ZEPHYR_MODULES. Those child rows are rendered regardless of their
    // own values, so the chevron must always be shown — otherwise the user
    // can't reach the empty placeholders to add a first value.
    super('EXTRA', vscode.TreeItemCollapsibleState.Collapsed);
    const hasAnyValue = EXTRA_ENV_KEYS.some((key) => Array.isArray(config.envVars[key]) && config.envVars[key].length > 0);
    this.description = hasAnyValue ? '' : '[not set]';
    this.tooltip = 'EXTRA';
    this.iconPath = new vscode.ThemeIcon('variable');
  }
  contextValue = 'zephyr-application-extra';
}

// Collapsible "Arguments & Environment" group under a build config. Holds no
// value of its own; its children are the west Arguments / west Flags -D / EXTRA
// / env-var rows. Its contextValue matches no menu, so no stray right-click
// items leak onto the group header, and the moved rows keep their own
// contextValues so their menus/commands are unaffected.
export class ZephyrConfigArgsEnvTreeItem extends vscode.TreeItem {
  constructor(
    public readonly project: ZephyrApplication,
    public readonly config: ZephyrBuildConfig,
  ) {
    super('Arguments & Environment', vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `args-env:${project.appRootPath}:${config.name}`;
    this.tooltip = 'west arguments, -D flags, EXTRA files, and environment variables';
    this.iconPath = new vscode.ThemeIcon('gear');
  }

  contextValue = 'zephyr-application-args-env';
}

export class ZephyrConfigWestFlagsDTreeItem extends vscode.TreeItem {
  constructor(
    public readonly project: ZephyrApplication,
    public readonly config: ZephyrBuildConfig,
  ) {
    const isEmpty = config.westFlagsD.length === 0;
    super(WEST_FLAGS_D_LABEL, isEmpty ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    this.description = isEmpty ? '[not set]' : '';
    this.tooltip = WEST_FLAGS_D_LABEL;
    this.iconPath = new vscode.ThemeIcon('symbol-parameter');
  }

  contextValue = 'zephyr-application-west-d-flags';
}

export class ZephyrConfigEnvTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrApplication,
    public readonly config: ZephyrBuildConfig,
    public readonly envKey: string
	) {
    const isEmpty = config.envVars[envKey].length === 0;
    super(envKey, isEmpty ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    this.description = isEmpty ? '[not set]' : '';
    this.tooltip = envKey;
    this.iconPath = new vscode.ThemeIcon('variable');
	}

  contextValue = 'zephyr-application-env';
}

export class ZephyrApplicationEnvValueTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrApplication,
    public readonly envKey: string,
    public readonly envValue: string
	) {
    super(envValue, vscode.TreeItemCollapsibleState.None);
	}
  contextValue = 'zephyr-application-env-value';
}

export class ZephyrConfigEnvValueTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrApplication,
    public readonly config: ZephyrBuildConfig,
    public readonly envKey: string,
    public readonly envValue: string
	) {
    super(envValue, vscode.TreeItemCollapsibleState.None);
	}
  contextValue = 'zephyr-application-env-value';
}

export class ZephyrApplicationArgTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrApplication,
    public readonly argName: string
	) {
    const isEmpty = project.westArgs.length === 0;
    super(argName, isEmpty ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    this.description = isEmpty ? '[not set]' : '';
    this.tooltip = argName;
    this.iconPath = new vscode.ThemeIcon('variable');
	}
  contextValue = 'zephyr-application-arg';
}

export class ZephyrConfigArgTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrApplication,
    public readonly config: ZephyrBuildConfig,
    public readonly argName: string,
    public argValue: string,
    public readonly argSetting?: string
	) {
    const isEmpty = (argValue === undefined) || (argValue.length === 0);
    super(argName, isEmpty ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    this.description = isEmpty ? '[not set]' : '';
    this.tooltip = argName;
    this.iconPath = new vscode.ThemeIcon('variable');
	}
  contextValue = 'zephyr-application-arg';
}

export class ZephyrApplicationArgValueTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrApplication,
    public readonly argName: string,
    public readonly argValue: string
	) {
    super(argValue, vscode.TreeItemCollapsibleState.None);
	}
  contextValue = 'zephyr-application-arg-value';
}

export class ZephyrConfigArgValueTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrApplication,
    public readonly config: ZephyrBuildConfig,
    public readonly argName: string,
    public readonly argValue: string
	) {
    super(argValue, vscode.TreeItemCollapsibleState.None);
	}
  contextValue = 'zephyr-application-arg-value';
}

export class ZephyrConfigWestFlagsDValueTreeItem extends vscode.TreeItem {
  constructor(
    public readonly project: ZephyrApplication,
    public readonly config: ZephyrBuildConfig,
    public readonly flagValue: string
  ) {
    super(flagValue, vscode.TreeItemCollapsibleState.None);
    this.tooltip = `-D${flagValue}`;
  }
  contextValue = 'zephyr-application-west-d-flag';
}

// Top-level entries hidden from the per-app Code Explorer: the build output
// (build/<config>, all under 'build') and the git metadata folder.
const CODE_EXPLORER_IGNORED_ROOT_ENTRIES = new Set<string>(['build', '.git']);

/**
 * Accordion "Code Explorer" node placed under each application. Expanding it
 * lists the app's file tree; opening one collapses the others. The expanded
 * state is encoded into the id so VS Code honors a forced collapse on refresh.
 */
export class ZephyrCodeExplorerTreeItem extends vscode.TreeItem {
  constructor(
    public readonly project: ZephyrApplication,
    expanded: boolean,
  ) {
    super(
      'Code Explorer',
      expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.id = `ce:${project.appRootPath}:${expanded ? 'x' : 'c'}`;
    this.iconPath = new vscode.ThemeIcon('folder-library');
    this.tooltip = project.appRootPath;
  }

  contextValue = 'zephyr-ce-root';
}

/**
 * One filesystem entry (folder or file) in a Code Explorer. Files carry a
 * `vscode.open` command; both set only `resourceUri` so the active file-icon
 * theme paints them plainly (no badges, no recoloring). The id is prefixed with
 * the owning app root so the same physical path under nested apps stays unique.
 */
export class ZephyrCodeExplorerEntryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly project: ZephyrApplication,
    public readonly uri: vscode.Uri,
    public readonly isDirectory: boolean,
  ) {
    super(
      uri,
      isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    this.id = `ce-entry:${project.appRootPath}::${uri.fsPath}`;
    this.resourceUri = uri;
    this.contextValue = isDirectory ? 'zephyr-ce-folder' : 'zephyr-ce-file';
    if (!isDirectory) {
      this.command = { command: 'vscode.open', title: 'Open', arguments: [uri] };
    }
  }
}
