import * as vscode from 'vscode';
import * as path from 'path';
import { ArmGnuToolchainInstallation, RustToolchainInstallation, ToolchainInstallation, IarToolchainInstallation, ZephyrSdkInstallation } from '../models/ToolchainInstallations';
import { getInternalZephyrSdkInstallation, getRegisteredArmGnuToolchainInstallations, getRegisteredRustToolchainInstallations, getRegisteredZephyrSdkInstallations, getRegisteredIarToolchainInstallations} from '../utils/utils';
import { friendlyToolchainId, isSdkV1OrLater } from '../utils/zephyr/sdkUtils';

export class ToolchainInstallationsDataProvider implements vscode.TreeDataProvider<ToolchainInstallationTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<ToolchainInstallationTreeItem | undefined | void> = new vscode.EventEmitter<ToolchainInstallationTreeItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<ToolchainInstallationTreeItem | undefined | void> = this._onDidChangeTreeData.event;

  constructor() {
	}

  getTreeItem(element: ToolchainInstallationTreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  async getChildren(element?: ToolchainInstallationTreeItem): Promise<ToolchainInstallationTreeItem[]> {
	const items: ToolchainInstallationTreeItem[] = [];
  
	const zephyrSDKs = await getRegisteredZephyrSdkInstallations();
	const iars = await getRegisteredIarToolchainInstallations();
	const armGnuToolchains = await getRegisteredArmGnuToolchainInstallations();
	const rustToolchains = await getRegisteredRustToolchainInstallations();
	const internal = await getInternalZephyrSdkInstallation();
  
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
		items.push(new ToolchainInstallationTreeItem(zephyrSdkInstallation, isInternal, collapsibleState));
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
		if (element.contextValue === 'zephyr-sdk' || element.contextValue === 'zephyr-sdk-internal') {
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
  
  

  getParent?(element: ToolchainInstallationTreeItem): vscode.ProviderResult<ToolchainInstallationTreeItem> {
    return null;
  }

  resolveTreeItem?(item: vscode.TreeItem, element: ToolchainInstallationTreeItem, token: vscode.CancellationToken): vscode.ProviderResult<vscode.TreeItem> {
    throw new Error('Method not implemented.');
  }

  refresh(): void {
		this._onDidChangeTreeData.fire();
	}

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
		this.contextValue = isInternal ? "zephyr-sdk-internal" : "zephyr-sdk";
		this.iconPath = {
          light: path.join(__filename, '..', '..', 'res', 'icons', 'light', 'toolchain_icon_light.svg'),
          dark: path.join(__filename, '..', '..', 'res', 'icons', 'dark', 'toolchain_icon_dark.svg')
        };
	  }
	}
  }
  
  
