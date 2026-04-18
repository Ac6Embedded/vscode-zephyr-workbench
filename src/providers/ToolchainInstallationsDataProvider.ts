import * as vscode from 'vscode';
import * as path from 'path';
import { ArmGnuToolchainInstallation, ToolchainInstallation, IarToolchainInstallation } from '../models/ToolchainInstallations';
import { getInternalZephyrSdkInstallation, getRegisteredArmGnuToolchainInstallations, getRegisteredZephyrSdkInstallations, getRegisteredIarToolchainInstallations} from '../utils/utils';

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
	const internal = await getInternalZephyrSdkInstallation();
  
	if (!element) {
	  // Top-level SDKs
	  for (const zephyrSdkInstallation of zephyrSDKs) {
		const isInternal = internal?.rootUri.fsPath === zephyrSdkInstallation.rootUri.fsPath;
		items.push(new ToolchainInstallationTreeItem(zephyrSdkInstallation, isInternal, vscode.TreeItemCollapsibleState.None));
	  }
  
	  // Top-level IARs
	  for (const iarToolchainInstallation of iars) {
		items.push(new ToolchainInstallationTreeItem(iarToolchainInstallation, false, vscode.TreeItemCollapsibleState.Collapsed));
	  }

	  for (const armGnuToolchainInstallation of armGnuToolchains) {
		items.push(new ToolchainInstallationTreeItem(armGnuToolchainInstallation, false, vscode.TreeItemCollapsibleState.None));
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
  
	return [];
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
  
  
