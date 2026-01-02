import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WestWorkspace } from '../models/WestWorkspace';

export class WestWorkspaceDataProvider implements vscode.TreeDataProvider<WestWorkspaceTreeItem | WestWorkspaceMiscTreeItem | WestWorkspaceEnvTreeItem | WestWorkspaceEnvValueTreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<WestWorkspaceTreeItem | WestWorkspaceMiscTreeItem | WestWorkspaceEnvTreeItem | WestWorkspaceEnvValueTreeItem | undefined | void> = new vscode.EventEmitter<WestWorkspaceTreeItem | WestWorkspaceMiscTreeItem | WestWorkspaceEnvTreeItem | WestWorkspaceEnvValueTreeItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<WestWorkspaceTreeItem | WestWorkspaceMiscTreeItem | WestWorkspaceEnvTreeItem | WestWorkspaceEnvValueTreeItem | undefined | void> = this._onDidChangeTreeData.event;

  constructor() {

  }

  getTreeItem(element: WestWorkspaceTreeItem | WestWorkspaceMiscTreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element;
  }

  getChildren(element?: WestWorkspaceTreeItem | WestWorkspaceMiscTreeItem | WestWorkspaceEnvTreeItem | WestWorkspaceEnvValueTreeItem | undefined): vscode.ProviderResult<WestWorkspaceTreeItem[] | WestWorkspaceMiscTreeItem[] | WestWorkspaceEnvTreeItem[] | WestWorkspaceEnvValueTreeItem[]> {
    if(element === undefined) {
      if(vscode.workspace.workspaceFolders) {
        const items: WestWorkspaceTreeItem[] = [];
        for(let workspaceFolder of vscode.workspace.workspaceFolders) {
          if(WestWorkspace.isWestWorkspaceFolder(workspaceFolder)) {
            const westWorkspace = new WestWorkspace(workspaceFolder.name, workspaceFolder.uri);
            const item = new WestWorkspaceTreeItem(westWorkspace, vscode.TreeItemCollapsibleState.Collapsed);
            items.push(item);
          }
        }
        return Promise.resolve(items);
      }
    }

    if(element instanceof WestWorkspaceMiscTreeItem) {
      return Promise.resolve([]);
    } 
    
    if(element instanceof WestWorkspaceTreeItem) {
      // Get Zephyr environment variables
      const items: WestWorkspaceEnvTreeItem[] = [];
      for(let key of WestWorkspace.envVarKeys) {
        const envItem = new WestWorkspaceEnvTreeItem(element.westWorkspace, key);
        items.push(envItem);
      }
      return Promise.resolve(items);
    } 

    if(element instanceof WestWorkspaceEnvTreeItem) {
      // Get Zephyr environment variables
      const items: WestWorkspaceEnvValueTreeItem[] = [];
      let values = element.westWorkspace.envVars[element.envKey];
      if(values) {
        for(let value of values) {
          const envValueItem = new WestWorkspaceEnvValueTreeItem(element.westWorkspace, element.envKey, value);
          items.push(envValueItem);
        }
      }
      
      return Promise.resolve(items);
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
    super(`${westWorkspace.name}`, collapsibleState);

		this.tooltip = `${this.westWorkspace.rootUri.fsPath}`;
		this.description = `[${this.westWorkspace.version}]`;
	}

	//iconPath = new vscode.ThemeIcon('symbol-misc');
  iconPath = {
    light: path.join(__filename, '..', '..', 'res', 'icons','zephyr.svg'),
    dark: path.join(__filename, '..', '..', 'res', 'icons','zephyr.svg')
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

export class WestWorkspaceEnvTreeItem extends vscode.TreeItem {
  constructor(
		public readonly westWorkspace: WestWorkspace,
    public readonly envKey: string
	) {
    super(envKey, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = westWorkspace.envVars[envKey].length === 0 ?'[not set]':'';
    this.tooltip = envKey;
	}
  iconPath = new vscode.ThemeIcon('variable');
  contextValue = 'west-workspace-env';
}

export class WestWorkspaceEnvValueTreeItem extends vscode.TreeItem {
  constructor(
		public readonly westWorkspace: WestWorkspace,
    public readonly envKey: string,
    public readonly envValue: string
	) {
    super(envValue, vscode.TreeItemCollapsibleState.None);
	}
  contextValue = 'west-workspace-env-value';
}