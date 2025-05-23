import * as vscode from 'vscode';
import { checkHostTools } from '../installUtils';

class MenuItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly icon: string,
    public readonly command?: vscode.Command
  ) {
      super(label, collapsibleState);
      if (command) {
          this.command = command;
      }
      this.iconPath = new vscode.ThemeIcon(icon);
  }
}

const installHostToolsMenuItem = new MenuItem(
  'Install Host Tools',
  vscode.TreeItemCollapsibleState.None,
  'desktop-download',
  {
    command: 'zephyr-workbench.install-host-tools.open-manager',
    title: 'Install Host Tools',
  }
);

const newAppMenuItem = new MenuItem(
  'New Application',
  vscode.TreeItemCollapsibleState.None,
  'file-directory-create',
  {
    command: 'zephyr-workbench-app-explorer.open-wizard',
    title: 'New Application',
  }
);

const createModMenuItem = new MenuItem(
  'Create Extra Module',
  vscode.TreeItemCollapsibleState.None,
  'file-directory-create',
  {
    command: 'zephyr-workbench-module-explorer.create-module',
    title: 'Create New Module',
  }
);

const newWestWorkspaceMenuItem = new MenuItem(
  'New West Workspace',
  vscode.TreeItemCollapsibleState.None,
  'file-directory-create',
  {
    command: 'zephyr-workbench-west-workspace.open-wizard',
    title: 'New West Workspace',
  }
);

const newSDKMenuItem = new MenuItem(
  'New Toolchain',
  vscode.TreeItemCollapsibleState.None,
  'file-directory-create',
  {
    command: 'zephyr-workbench-sdk-explorer.open-wizard',
    title: 'New Toolchain',
  }
);

const debugManagerMenuItem = new MenuItem(
  'Debug Manager',
  vscode.TreeItemCollapsibleState.None,
  'bug',
  {
    command: 'zephyr-workbench.debug-manager',
    title: 'Debug Manager',
  }
);


export class ZephyrShortcutCommandProvider implements vscode.TreeDataProvider<MenuItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<MenuItem | undefined> = new vscode.EventEmitter<MenuItem | undefined>();
  readonly onDidChangeTreeData: vscode.Event<MenuItem | undefined> = this._onDidChangeTreeData.event;

  getTreeItem(element: MenuItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  async getChildren(element?: any): Promise<MenuItem[]> {
    const items: MenuItem[] = [];

    if(element === undefined) {
      if(!await checkHostTools()) {
        items.push(installHostToolsMenuItem);
      }

      items.push(newAppMenuItem);
      items.push(newWestWorkspaceMenuItem);
      items.push(newSDKMenuItem);
      items.push(debugManagerMenuItem);
    } 
    return items;
  }

  refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}
}
