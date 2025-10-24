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

const reinstallHostToolsMenuItem = new MenuItem(
  'Reinstall Host Tools',
  vscode.TreeItemCollapsibleState.None,
  'desktop-download',
  {
    command: 'zephyr-workbench.install-host-tools.open-manager',
    title: 'Reinstall Host Tools',
    arguments: ['true']
  }
);

const reinstallVenvMenuItem = new MenuItem(
  'Reinstall Virtual Environment',
  vscode.TreeItemCollapsibleState.None,
  'desktop-download',
  {
    command: 'zephyr-workbench.reinstall-venv',
    title: 'Reinstall Virtual Environment',
  }
);

const verifyHostToolsMenuItem = new MenuItem(
  'Verify Host Tools',
  vscode.TreeItemCollapsibleState.None,
  'compass',
  {
    command: 'zephyr-workbench.verify-host-tools',
    title: 'Verify Host Tools',
  }
);

const installDebugToolsMenuItem = new MenuItem(
  'Install Runners',
  vscode.TreeItemCollapsibleState.None,
  'desktop-download',
  {
    command: 'zephyr-workbench.install-debug-tools',
    title: 'Install Runners',
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

export class ZephyrHostToolsCommandProvider implements vscode.TreeDataProvider<MenuItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<MenuItem | undefined> = new vscode.EventEmitter<MenuItem | undefined>();
  readonly onDidChangeTreeData: vscode.Event<MenuItem | undefined> = this._onDidChangeTreeData.event;

  getTreeItem(element: MenuItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  async getChildren(element?: any): Promise<MenuItem[]> {
    const items: MenuItem[] = [];

    if(element === undefined) {
      if(await checkHostTools()) {
        items.push(reinstallHostToolsMenuItem);
        items.push(reinstallVenvMenuItem);
        items.push(verifyHostToolsMenuItem);
        items.push(installDebugToolsMenuItem);
        items.push(debugManagerMenuItem);
      }
    } 
    return items;
  }

  refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}
}
