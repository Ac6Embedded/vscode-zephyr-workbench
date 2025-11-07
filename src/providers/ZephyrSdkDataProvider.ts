import * as vscode from 'vscode';
import * as path from 'path';
import { ZephyrSDK, IARToolchain } from '../models/ZephyrSDK';
import { getInternalZephyrSDK, getListZephyrSDKs, getListIARs} from '../utils/utils';

export class ZephyrSdkDataProvider implements vscode.TreeDataProvider<ZephyrSdkTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<ZephyrSdkTreeItem | undefined | void> = new vscode.EventEmitter<ZephyrSdkTreeItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<ZephyrSdkTreeItem | undefined | void> = this._onDidChangeTreeData.event;

  constructor() {
	}

  getTreeItem(element: ZephyrSdkTreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  async getChildren(element?: ZephyrSdkTreeItem): Promise<ZephyrSdkTreeItem[]> {
	const items: ZephyrSdkTreeItem[] = [];
  
	const zephyrSDKs = await getListZephyrSDKs();
	const iars = await getListIARs();
	const internal = await getInternalZephyrSDK();
  
	if (!element) {
	  // Top-level SDKs
	  for (const sdk of zephyrSDKs) {
		const isInternal = internal?.rootUri.fsPath === sdk.rootUri.fsPath;
		items.push(new ZephyrSdkTreeItem(sdk, isInternal, vscode.TreeItemCollapsibleState.None));
	  }
  
	  // Top-level IARs
	  for (const iar of iars) {
		items.push(new ZephyrSdkTreeItem(iar, false, vscode.TreeItemCollapsibleState.Collapsed));
	  }
  
	  return items;
	}
  
	// If this is an IAR, show its associated SDK
	if (element.sdk instanceof IARToolchain) {
		const sdkPath = element.sdk.zephyrSdkPath;
		const sdk = zephyrSDKs.find(s => s.rootUri.fsPath === sdkPath);
		if (sdk) {
		  const isInternal = internal?.rootUri.fsPath === sdk.rootUri.fsPath;
		  return [
			new ZephyrSdkTreeItem(sdk, isInternal, vscode.TreeItemCollapsibleState.None)
		  ];
		}
	  }
  
	return [];
  }
  
  

  getParent?(element: ZephyrSdkTreeItem): vscode.ProviderResult<ZephyrSdkTreeItem> {
    return null;
  }

  resolveTreeItem?(item: vscode.TreeItem, element: ZephyrSdkTreeItem, token: vscode.CancellationToken): vscode.ProviderResult<vscode.TreeItem> {
    throw new Error('Method not implemented.');
  }

  refresh(): void {
		this._onDidChangeTreeData.fire();
	}

}
export class ZephyrSdkTreeItem extends vscode.TreeItem {
	constructor(
	  public readonly sdk: ZephyrSDK | IARToolchain,
	  public readonly isInternal: boolean,
	  public readonly collapsibleState: vscode.TreeItemCollapsibleState
	) {
	  super(sdk.name, collapsibleState);
  
	  if (sdk instanceof IARToolchain) {
		this.label = sdk.name;
		//this.description = sdk.iarPath;
		this.tooltip = `IAR Toolchain @ ${sdk.iarPath}`;
		this.contextValue = "iar-toolchain";
		this.iconPath = path.join(__filename, '..', '..', 'res', 'icons', 'iar-logo.jpg');
	  } else {
		this.label = `Zephyr SDK ${sdk.version}`;
		//this.description = sdk.rootUri.fsPath + (isInternal ? " [Internal]" : "");
		this.tooltip = `Zephyr SDK ${sdk.version} @ ${sdk.rootUri.fsPath}`;
		this.contextValue = isInternal ? "zephyr-sdk-internal" : "zephyr-sdk";
		this.iconPath = new vscode.ThemeIcon("folder");
	  }
	}
  }
  
  
