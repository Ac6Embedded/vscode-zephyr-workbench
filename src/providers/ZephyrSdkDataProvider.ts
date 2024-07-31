import * as vscode from 'vscode';
import * as path from 'path';
import { ZephyrSDK } from '../ZephyrSDK';
import { getInternalZephyrSDK, getListZephyrSDKs } from '../utils';

export class ZephyrSdkDataProvider implements vscode.TreeDataProvider<ZephyrSdkTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<ZephyrSdkTreeItem | undefined | void> = new vscode.EventEmitter<ZephyrSdkTreeItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<ZephyrSdkTreeItem | undefined | void> = this._onDidChangeTreeData.event;

  constructor() {
	}

  getTreeItem(element: ZephyrSdkTreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  async getChildren(element?: ZephyrSdkTreeItem | undefined): Promise<ZephyrSdkTreeItem[]> {
    if(element === undefined) {
			let treeItems: ZephyrSdkTreeItem[] = [];

			const sdks = await getListZephyrSDKs();
			const internalSDK = await getInternalZephyrSDK();
			for(const sdk of sdks) {
				let isInternal = false;
				if(internalSDK && internalSDK.rootUri.fsPath === sdk.rootUri.fsPath) {
					isInternal = true;
				}
				const sdkItem = new ZephyrSdkTreeItem(sdk, isInternal, vscode.TreeItemCollapsibleState.None);
				treeItems.push(sdkItem);
			}
			return treeItems;
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
		public readonly sdk: ZephyrSDK,
		private isInternal: boolean,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
	) {
		super(sdk.name, collapsibleState);

		this.tooltip = `Zephyr SDK ${sdk.version} [${sdk.rootUri.fsPath}]`;
		this.description = this.isInternal ? "[Internal]" : "";
		this.contextValue = this.isInternal ? 'zephyr-sdk-internal' : 'zephyr-sdk';
	}

	iconPath = new vscode.ThemeIcon('symbol-method');

	// iconPath = {
	// 	light: path.join(__filename, '..', '..', 'resources', 'light', 'zephyrsdk.svg'),
	// 	dark: path.join(__filename, '..', '..', 'resources', 'dark', 'zephyrsdk.svg')
	// };

}
