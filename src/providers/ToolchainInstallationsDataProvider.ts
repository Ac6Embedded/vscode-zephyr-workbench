import * as vscode from 'vscode';
import * as path from 'path';
import { ArmGnuToolchainInstallation, GlobalZephyrSdkInstallation, RustToolchainInstallation, ToolchainInstallation, IarToolchainInstallation, ZephyrSdkInstallation } from '../models/ToolchainInstallations';
import { getAllZephyrSdkInstallations, getInternalZephyrSdkInstallation, getRegisteredArmGnuToolchainInstallations, getRegisteredRustToolchainInstallations, getRegisteredIarToolchainInstallations, isZinstallerUpdateNeeded, normalizeSdkPathKey} from '../utils/utils';
import { getCachedGlobalSdks } from '../utils/zephyr/globalSdkService';
import { friendlyToolchainId, isSdkV1OrLater } from '../utils/zephyr/sdkUtils';
import { checkHostTools } from '../utils/installUtils';

/** Context key behind the view's "Add Toolchain" title action. */
const HOST_TOOLS_INSTALLED_CONTEXT = 'zephyr-workbench.hostToolsInstalled';

const warningIcon = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));

/**
 * The "Toolchains & Host Tools" view: a "Toolchains" group (SDKs, IAR, Arm GNU,
 * Rust) then a "Host Tools Dependencies" group. The view keeps the historical
 * zephyr-workbench-sdk-explorer id so its menus and saved layout still apply.
 */
export class ToolchainInstallationsDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | void> = this._onDidChangeTreeData.event;

  /** The view this provider feeds, and its title from package.json. */
  private view?: vscode.TreeView<vscode.TreeItem>;
  private viewTitle = '';

  constructor() {
	}

  /**
   * Give the provider its view, whose header shows when the host tools need an
   * update. The header is set right away, before the tree is ever drawn.
   */
  attachView(view: vscode.TreeView<vscode.TreeItem>): void {
	this.view = view;
	this.viewTitle = view.title ?? '';
	void this.readHostToolsState();
  }

  /**
   * Whether the host tools are installed and whether they need an update, also
   * set in the context key and the view header. It runs on every refresh, not
   * only when the tree is drawn: VS Code never asks a collapsed view for rows.
   */
  private async readHostToolsState(): Promise<{ installed: boolean; updateNeeded: boolean }> {
	const installed = await checkHostTools().catch(() => false);
	const updateNeeded = installed && isZinstallerUpdateNeeded();
	void vscode.commands.executeCommand('setContext', HOST_TOOLS_INSTALLED_CONTEXT, installed);
	if (this.view) {
	  // Headers are plain text, and VS Code hides the description of a collapsed
	  // view, so the warning emoji goes in the title itself.
	  this.view.title = updateNeeded ? `${this.viewTitle} ⚠️` : this.viewTitle;
	  this.view.description = updateNeeded ? 'update available' : undefined;
	}
	return { installed, updateNeeded };
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
	if (!element) {
	  // Nothing can use a toolchain before the host tools exist, so the view
	  // stays empty and its welcome content asks for them instead.
	  const { installed, updateNeeded } = await this.readHostToolsState();
	  if (!installed) {
		return [];
	  }
	  return [new ToolchainsViewGroupItem('toolchains'), new ToolchainsViewGroupItem('host-tools', updateNeeded)];
	}

	if (element instanceof ToolchainsViewGroupItem) {
	  if (element.group === 'host-tools') {
		return createHostToolsDependencyItems(element.updateNeeded);
	  }
	  const toolchains = await this.getToolchainItems();
	  return toolchains.length > 0 ? toolchains : [createAddToolchainItem()];
	}

	if (element instanceof ToolchainInstallationTreeItem) {
	  return this.getToolchainItems(element);
	}
	return [];
  }

  /** The toolchains group's rows (no element) or the children of one toolchain row. */
  private async getToolchainItems(element?: ToolchainInstallationTreeItem): Promise<ToolchainInstallationTreeItem[]> {
	const items: ToolchainInstallationTreeItem[] = [];
  
	// Registered SDKs merged with auto-detected global ones (registered win the
	// dedup); the same merged list backs the IAR and Rust link child lookups so
	// links to a global SDK render too.
	const zephyrSDKs = await getAllZephyrSdkInstallations();
	const iars = await getRegisteredIarToolchainInstallations();
	const armGnuToolchains = await getRegisteredArmGnuToolchainInstallations();
	const rustToolchains = await getRegisteredRustToolchainInstallations();
	const internal = await getInternalZephyrSdkInstallation();
	// Keyed like the merge dedup (realpath + case folding) so a registered
	// symlink or case-variant of a detected global SDK still gets the badge.
	const globalSdkPaths = new Set(getCachedGlobalSdks().map(sdk => normalizeSdkPathKey(sdk.rootUri.fsPath)));

	if (!element) {
	  // Top-level SDKs
	  for (const zephyrSdkInstallation of zephyrSDKs) {
		const isInternal = internal?.rootUri.fsPath === zephyrSdkInstallation.rootUri.fsPath;
		// v1.0+ always expands to the GNU/LLVM groups (which include install suggestions);
		// older SDKs only expand when there is at least one installed toolchain to list.
		const hasChildren = isSdkV1OrLater(zephyrSdkInstallation.version)
		  || zephyrSdkInstallation.getInstalledGnuToolchains().length > 0;
		const collapsibleState = hasChildren
		  ? vscode.TreeItemCollapsibleState.Collapsed
		  : vscode.TreeItemCollapsibleState.None;
		const item = new ToolchainInstallationTreeItem(zephyrSdkInstallation, isInternal, collapsibleState);
		// A registered SDK that is also globally discoverable keeps its normal
		// context value (still removable) but gets the same badge.
		if (!(zephyrSdkInstallation instanceof GlobalZephyrSdkInstallation)
			&& globalSdkPaths.has(normalizeSdkPathKey(zephyrSdkInstallation.rootUri.fsPath))) {
		  item.description = '[global]';
		}
		items.push(item);
	  }
  
	  // Top-level IARs
	  for (const iarToolchainInstallation of iars) {
		items.push(new ToolchainInstallationTreeItem(iarToolchainInstallation, false, vscode.TreeItemCollapsibleState.Collapsed));
	  }

	  for (const armGnuToolchainInstallation of armGnuToolchains) {
		items.push(new ToolchainInstallationTreeItem(armGnuToolchainInstallation, false, vscode.TreeItemCollapsibleState.None));
	  }

	  for (const rustToolchainInstallation of rustToolchains) {
		const hasLink = !!rustToolchainInstallation.cToolchainPath || !!rustToolchainInstallation.llvmPath;
		items.push(new ToolchainInstallationTreeItem(
		  rustToolchainInstallation,
		  false,
		  hasLink ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
		));
	  }

	  return items;
	}

	// If this is an IAR, show its associated SDK
	if (element.installation instanceof IarToolchainInstallation) {
		const zephyrSdkPath = element.installation.zephyrSdkPath;
		const zephyrSdkInstallation = zephyrSDKs.find(s => s.rootUri.fsPath === zephyrSdkPath);
		if (zephyrSdkInstallation) {
		  const isInternal = internal?.rootUri.fsPath === zephyrSdkInstallation.rootUri.fsPath;
		  return [
			new ToolchainInstallationTreeItem(zephyrSdkInstallation, isInternal, vscode.TreeItemCollapsibleState.None)
		  ];
		}
	  }

	// If this is a Rust toolchain, show its linked C toolchain
	if (element.installation instanceof RustToolchainInstallation) {
		const children: ToolchainInstallationTreeItem[] = [];
		const linkedPath = element.installation.cToolchainPath;

		if (element.installation.cToolchainType === 'gnuarmemb') {
		  const linkedArmGnu = armGnuToolchains.find(t => t.toolchainPath === linkedPath);
		  if (linkedArmGnu) {
			children.push(new ToolchainInstallationTreeItem(linkedArmGnu, false, vscode.TreeItemCollapsibleState.None));
		  }
		} else {
		  const linkedSdk = zephyrSDKs.find(s => s.rootUri.fsPath === linkedPath);
		  if (linkedSdk) {
			const isInternal = internal?.rootUri.fsPath === linkedSdk.rootUri.fsPath;
			children.push(new ToolchainInstallationTreeItem(linkedSdk, isInternal, vscode.TreeItemCollapsibleState.None));
		  }
		}

		const llvmPath = element.installation.llvmPath;
		if (llvmPath) {
		  const llvmItem = new ToolchainInstallationTreeItem(element.installation, false, vscode.TreeItemCollapsibleState.None);
		  llvmItem.label = path.basename(llvmPath);
		  llvmItem.description = '[host LLVM]';
		  llvmItem.tooltip = `Host LLVM (libclang for bindgen) @ ${llvmPath}`
			+ (element.installation.libclangDirPath
			  ? `\nLIBCLANG_PATH: ${element.installation.libclangDirPath}`
			  : '\nWarning: libclang not found in this installation');
		  llvmItem.contextValue = 'rust-llvm';
		  llvmItem.iconPath = {
			light: path.join(__filename, '..', '..', 'res', 'icons', 'light', 'llvm_icon_light.svg'),
			dark: path.join(__filename, '..', '..', 'res', 'icons', 'dark', 'llvm_icon_dark.svg')
		  };
		  children.push(llvmItem);
		}

		return children;
	  }

	// Zephyr SDK node and its category / toolchain sub-nodes
	if (element.installation instanceof ZephyrSdkInstallation) {
		const sdk = element.installation;
		const isInternal = element.isInternal;

		// The SDK root node: v1.0+ groups toolchains under GNU / LLVM; older SDKs stay flat.
		if (element.contextValue === 'zephyr-sdk' || element.contextValue === 'zephyr-sdk-internal' || element.contextValue === 'zephyr-sdk-global') {
			if (isSdkV1OrLater(sdk.version)) {
				return [
					this.makeCategoryItem(sdk, isInternal, 'GNU', 'zephyr-sdk-gnu-group'),
					this.makeCategoryItem(sdk, isInternal, 'LLVM', 'zephyr-sdk-llvm-group'),
				];
			}
			return this.makeGnuToolchainLeaves(sdk, isInternal);
		}

		// GNU category: installed arch toolchains + a suggestion to add more
		if (element.contextValue === 'zephyr-sdk-gnu-group') {
			const items = this.makeGnuToolchainLeaves(sdk, isInternal);
			items.push(this.makeActionItem(
				sdk, isInternal, 'Add GNU toolchain...', 'zephyr-sdk-add-gnu',
				'add', 'zephyr-workbench-sdk-explorer.add-sdk-toolchain'));
			return items;
		}

		// LLVM category: the installed clang toolchain, or a suggestion to install it
		if (element.contextValue === 'zephyr-sdk-llvm-group') {
			if (sdk.hasLlvmToolchain()) {
				const item = new ToolchainInstallationTreeItem(sdk, isInternal, vscode.TreeItemCollapsibleState.None);
				item.label = 'llvm';
				item.description = 'clang';
				item.tooltip = path.join(sdk.rootUri.fsPath, 'llvm');
				item.contextValue = 'zephyr-sdk-llvm';
				item.iconPath = {
					light: path.join(__filename, '..', '..', 'res', 'icons', 'light', 'llvm_icon_light.svg'),
					dark: path.join(__filename, '..', '..', 'res', 'icons', 'dark', 'llvm_icon_dark.svg')
				};
				return [item];
			}
			return [this.makeActionItem(
				sdk, isInternal, 'Install LLVM toolchain...', 'zephyr-sdk-install-llvm',
				'cloud-download', 'zephyr-workbench-sdk-explorer.install-sdk-llvm')];
		}

		return [];
	}

	return [];
  }

  /** Read-only leaves for the GNU toolchains actually installed on disk. */
  private makeGnuToolchainLeaves(sdk: ZephyrSdkInstallation, isInternal: boolean): ToolchainInstallationTreeItem[] {
	return sdk.getInstalledGnuToolchains().map(toolchain => {
		const item = new ToolchainInstallationTreeItem(sdk, isInternal, vscode.TreeItemCollapsibleState.None);
		item.label = toolchain.name;
		item.description = friendlyToolchainId(toolchain.name);
		item.tooltip = toolchain.toolchainPath;
		item.contextValue = 'zephyr-sdk-toolchain';
		item.iconPath = new vscode.ThemeIcon('chip');
		return item;
	});
  }

  /** A collapsible category node (GNU / LLVM) under a v1.0+ SDK. */
  private makeCategoryItem(sdk: ZephyrSdkInstallation, isInternal: boolean, label: string, contextValue: string): ToolchainInstallationTreeItem {
	const item = new ToolchainInstallationTreeItem(sdk, isInternal, vscode.TreeItemCollapsibleState.Collapsed);
	item.label = label;
	item.tooltip = `${label} toolchains for Zephyr SDK ${sdk.version.trim()}`;
	item.contextValue = contextValue;
	item.iconPath = new vscode.ThemeIcon('library');
	return item;
  }

  /** A clickable "install/add" suggestion leaf that runs the given command on select. */
  private makeActionItem(sdk: ZephyrSdkInstallation, isInternal: boolean, label: string, contextValue: string, icon: string, commandId: string): ToolchainInstallationTreeItem {
	const item = new ToolchainInstallationTreeItem(sdk, isInternal, vscode.TreeItemCollapsibleState.None);
	item.label = label;
	item.contextValue = contextValue;
	item.iconPath = new vscode.ThemeIcon(icon);
	item.command = { command: commandId, title: label, arguments: [item] };
	return item;
  }
  
  

  getParent?(element: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem> {
    return null;
  }

  refresh(): void {
		this._onDidChangeTreeData.fire();
		// A collapsed view draws nothing, so its header is updated from here too.
		void this.readHostToolsState();
	}

}

type ToolchainsViewGroup = 'toolchains' | 'host-tools';

/**
 * One of the two top-level groups. Their context values match no menu entry.
 * updateNeeded marks the host tools group while the host tools are outdated.
 */
class ToolchainsViewGroupItem extends vscode.TreeItem {
	constructor(public readonly group: ToolchainsViewGroup, public readonly updateNeeded = false) {
	  super(group === 'toolchains' ? 'Toolchains' : 'Host Tools Dependencies', vscode.TreeItemCollapsibleState.Expanded);
	  this.contextValue = group === 'toolchains' ? 'toolchains-group' : 'host-tools-group';
	  this.iconPath = updateNeeded ? warningIcon : new vscode.ThemeIcon(group === 'toolchains' ? 'tools' : 'package');
	  if (updateNeeded) {
		this.tooltip = 'Host tools update available';
	  }
	}
}

/** Stands in for an empty toolchains group. */
function createAddToolchainItem(): vscode.TreeItem {
	const item = new vscode.TreeItem('Add Toolchain', vscode.TreeItemCollapsibleState.None);
	item.iconPath = new vscode.ThemeIcon('add');
	item.command = { command: 'zephyr-workbench-sdk-explorer.open-wizard', title: 'Add Toolchain' };
	return item;
}

function createHostToolsDependencyItems(updateNeeded: boolean): vscode.TreeItem[] {
	const runners = new vscode.TreeItem('Install Runners', vscode.TreeItemCollapsibleState.None);
	runners.iconPath = new vscode.ThemeIcon('desktop-download');
	runners.command = { command: 'zephyr-workbench.install-runners', title: 'Install Runners' };

	const manager = new vscode.TreeItem('Host Tools Manager', vscode.TreeItemCollapsibleState.None);
	manager.command = { command: 'zephyr-workbench.host-tools-manager', title: 'Host Tools Manager' };
	if (updateNeeded) {
	  manager.description = 'update available';
	  manager.iconPath = warningIcon;
	} else {
	  manager.iconPath = new vscode.ThemeIcon('wrench');
	}

	return [runners, manager];
}

export class ToolchainInstallationTreeItem extends vscode.TreeItem {
	constructor(
	  public readonly installation: ToolchainInstallation,
	  public readonly isInternal: boolean,
	  public readonly collapsibleState: vscode.TreeItemCollapsibleState
	) {
	  super(installation.name, collapsibleState);
  
	  if (installation instanceof IarToolchainInstallation) {
		this.label = `${installation.name}`;
		this.tooltip = `IAR Toolchain @ ${installation.iarPath}`;
		this.contextValue = "iar-toolchain";
		this.iconPath = path.join(__filename, '..', '..', 'res', 'icons', 'iar-logo.jpg');
	  } else if (installation instanceof ArmGnuToolchainInstallation) {
		this.label = installation.name;
		this.tooltip = `Arm GNU Toolchain @ ${installation.toolchainPath}`;
		this.contextValue = 'arm-gnu-toolchain';
		this.iconPath = {
		  light: path.join(__filename, '..', '..', 'res', 'icons', 'light', 'arm_gnu_icon_light.svg'),
		  dark: path.join(__filename, '..', '..', 'res', 'icons', 'dark', 'arm_gnu_icon_dark.svg')
		};
	  } else if (installation instanceof RustToolchainInstallation) {
		this.label = installation.name;
		this.tooltip = `Rust Toolchain @ ${installation.toolchainPath}`
		  + (installation.targets.length ? `\nTargets: ${installation.targets.join(', ')}` : '')
		  + (installation.cToolchainPath
			? `\nLinked C toolchain: ${installation.cToolchainPath}`
			: '\nNo linked C toolchain')
		  + (installation.llvmPath
			? `\nHost LLVM: ${installation.llvmPath}`
			: '\nNo linked host LLVM (bindgen needs libclang)');
		this.contextValue = 'rust-toolchain';
		this.iconPath = {
		  light: path.join(__filename, '..', '..', 'res', 'icons', 'light', 'rust_icon_light.svg'),
		  dark: path.join(__filename, '..', '..', 'res', 'icons', 'dark', 'rust_icon_dark.svg')
		};
	  } else {
		this.label = `Zephyr SDK ${installation.version}`;
		this.tooltip = `Zephyr SDK ${installation.version} @ ${installation.rootUri.fsPath}`;
		if (installation instanceof GlobalZephyrSdkInstallation) {
		  // Auto-detected via the build system's global discovery channels:
		  // not registered in listSDKs, so not removable from here.
		  this.contextValue = 'zephyr-sdk-global';
		  this.description = '[global]';
		  this.tooltip += '\nAuto-detected global SDK (CMake package registry, default install locations, or ZEPHYR_SDK_INSTALL_DIR)';
		} else {
		  this.contextValue = isInternal ? "zephyr-sdk-internal" : "zephyr-sdk";
		}
		this.iconPath = {
          light: path.join(__filename, '..', '..', 'res', 'icons', 'light', 'toolchain_icon_light.svg'),
          dark: path.join(__filename, '..', '..', 'res', 'icons', 'dark', 'toolchain_icon_dark.svg')
        };
	  }
	}
  }
  
  
