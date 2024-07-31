import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WestWorkspace } from '../WestWorkspace';

export class WestWorkspaceDataProvider implements vscode.TreeDataProvider<WestWorkspaceTreeItem | WestWorkspaceMiscTreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<WestWorkspaceTreeItem | WestWorkspaceMiscTreeItem | undefined | void> = new vscode.EventEmitter<WestWorkspaceTreeItem | WestWorkspaceMiscTreeItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<WestWorkspaceTreeItem | WestWorkspaceMiscTreeItem | undefined | void> = this._onDidChangeTreeData.event;

  constructor() {

  }

  getTreeItem(element: WestWorkspaceTreeItem | WestWorkspaceMiscTreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element;
  }

  getChildren(element?: WestWorkspaceTreeItem | WestWorkspaceMiscTreeItem | undefined): vscode.ProviderResult<WestWorkspaceTreeItem[] | WestWorkspaceMiscTreeItem[]> {
    if(element === undefined) {
      if(vscode.workspace.workspaceFolders) {
        const items: WestWorkspaceTreeItem[] = [];
        for(let workspaceFolder of vscode.workspace.workspaceFolders) {
          if(WestWorkspace.isWestWorkspaceFolder(workspaceFolder)) {
            const westWorkspace = new WestWorkspace(workspaceFolder.name, workspaceFolder.uri);
            const item = new WestWorkspaceTreeItem(westWorkspace, vscode.TreeItemCollapsibleState.None);
            items.push(item);
          }
        }
        return Promise.resolve(items);
      }
    }

    if(element instanceof WestWorkspaceMiscTreeItem) {
      return Promise.resolve([]);
    } 
    
    if (element instanceof WestWorkspaceTreeItem) {

    } 
    return Promise.resolve([]);
  }


  refresh(): void {
		this._onDidChangeTreeData.fire();
	}

}

export class WestWorkspaceTreeItem extends vscode.TreeItem {
  constructor(
		public readonly westWorkspace: WestWorkspace,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
	) {
		super(westWorkspace.name, collapsibleState);

		this.tooltip = `${this.westWorkspace.rootUri.fsPath}`;
		this.description = `[${this.westWorkspace.version}]`;
	}

	//iconPath = new vscode.ThemeIcon('symbol-misc');
  iconPath = {
    light: path.join(__filename, '..', '..', 'res', 'icons', 'zephyr.svg'),
    dark: path.join(__filename, '..', '..', 'res', 'icons', 'zephyr.svg')
  };
	contextValue = 'west-workspace';
}

export class WestWorkspaceMiscTreeItem extends vscode.TreeItem {
  constructor(
		public readonly label: string,
		private readonly version: string,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
	) {
		super(version, collapsibleState);

		this.tooltip = `${this.version}`;
		this.description = "";
	}

	contextValue = 'west-workspace-misc';
}