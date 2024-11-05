import * as vscode from 'vscode';

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


const trainingProgramMenuItem = new MenuItem(
  'Zephyr Training Partners',
  vscode.TreeItemCollapsibleState.None,
  'link',
  {
    command: 'zephyr-workbench.open-webpage',
    title: 'Zephyr Training Program',
    arguments: ['https://zephyrproject.org/training-partner-program']
  }
);

const documentationMenuItem = new MenuItem(
  'Zephyr Documentation',
  vscode.TreeItemCollapsibleState.None,
  'link',
  {
    command: 'zephyr-workbench.open-webpage',
    title: 'Zephyr Documentation',
    arguments: ['https://docs.zephyrproject.org/latest/index.html']
  }
);

const awesomeMenuItem = new MenuItem(
  'Awesome Zephyr',
  vscode.TreeItemCollapsibleState.None,
  'link',
  {
    command: 'zephyr-workbench.open-webpage',
    title: 'Awesome Zephyr',
    arguments: ['https://github.com/zephyrproject-rtos/awesome-zephyr-rtos']
  }
);

const tutorialMenuItem = new MenuItem(
  'Tutorials',
  vscode.TreeItemCollapsibleState.None,
  'link',
  {
    command: 'zephyr-workbench.open-webpage',
    title: 'Tutorials',
    arguments: ['https://zephyr-workbench.com/']
  }
);

export class ZephyrOtherResourcesCommandProvider implements vscode.TreeDataProvider<MenuItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<MenuItem | undefined> = new vscode.EventEmitter<MenuItem | undefined>();
  readonly onDidChangeTreeData: vscode.Event<MenuItem | undefined> = this._onDidChangeTreeData.event;

  getTreeItem(element: MenuItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  async getChildren(element?: any): Promise<MenuItem[]> {
    const items: MenuItem[] = [];

    items.push(trainingProgramMenuItem);
    items.push(tutorialMenuItem);
    items.push(documentationMenuItem);
    items.push(awesomeMenuItem);
    return items;
  }

  refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}
}
