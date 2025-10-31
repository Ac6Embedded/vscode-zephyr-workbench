import * as vscode from 'vscode';
import { checkHostTools } from '../utils/installUtils';
import { isZinstallerUpdateNeeded } from '../utils/utils';

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

// Removed: reinstall/verify actions from the tree menu per request

const installDebugToolsMenuItem = new MenuItem(
  'Install Runners',
  vscode.TreeItemCollapsibleState.None,
  'desktop-download',
  {
    command: 'zephyr-workbench.install-runners',
    title: 'Install Runners',
  }
);


function createHostToolsManagerMenuItem(): MenuItem {
  const needsUpdate = isZinstallerUpdateNeeded();
  const label = needsUpdate ? 'Host Tools Manager ⚠️ Needs update' : 'Host Tools Manager';
  return new MenuItem(
    label,
    vscode.TreeItemCollapsibleState.None,
    'wrench',
    {
      command: 'zephyr-workbench.host-tools-manager',
      title: label,
    }
  );
}

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
        items.push(createHostToolsManagerMenuItem());
        items.push(installDebugToolsMenuItem);
      }
    } 
    return items;
  }

  refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}
}
