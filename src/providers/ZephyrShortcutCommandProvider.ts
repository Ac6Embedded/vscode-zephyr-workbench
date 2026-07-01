import * as vscode from 'vscode';
import { checkHostTools } from '../utils/installUtils';
import path from 'path';

class MenuItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly icon: string | { light: string; dark: string },
    public readonly command?: vscode.Command
  ) {
      super(label, collapsibleState);
      if (command) {
          this.command = command;
      }
      if (typeof icon === 'string') {
        this.iconPath = new vscode.ThemeIcon(icon);
      } else {
        this.iconPath = icon;
      }
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

const advancedInstallHostToolsMenuItem = new MenuItem(
  'Install Host Tools (Advanced)',
  vscode.TreeItemCollapsibleState.None,
  'settings-gear',
  {
    command: 'zephyr-workbench.install-host-tools.advanced',
    title: 'Install Host Tools (Advanced)',
  }
);

const newAppMenuItem = new MenuItem(
  'Add Application',
  vscode.TreeItemCollapsibleState.None,
  'file-directory-create',
  {
    command: 'zephyr-workbench-app-explorer.open-wizard',
    title: 'Add Application',
  }
);

const newWestWorkspaceMenuItem = new MenuItem(
  'Add West Workspace',
  vscode.TreeItemCollapsibleState.None,
  {
    light: path.join(__filename, '..', '..', 'res', 'icons', 'light', 'zephyr_icon_plus_light.svg'),
    dark: path.join(__filename, '..', '..', 'res', 'icons', 'dark', 'zephyr_icon_plus_dark.svg'),
  },
  {
    command: 'zephyr-workbench-west-workspace.open-wizard',
    title: 'Add West Workspace',
  }
);

const newSDKMenuItem = new MenuItem(
  'Add Toolchain',
  vscode.TreeItemCollapsibleState.None,
   {
    light: path.join(__filename, '..', '..', 'res', 'icons', 'light', 'toolchain_icon_plus_light.svg'),
    dark: path.join(__filename, '..', '..', 'res', 'icons', 'dark', 'toolchain_icon_plus_dark.svg'),
  },
  {
    command: 'zephyr-workbench-sdk-explorer.open-wizard',
    title: 'Add Toolchain',
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

// Devicetree Manager
//
// Icon: the project-shipped SVG pair
// (res/icons/{light,dark}/dt-icon.svg) so menu, command
// palette and panel tab all render the same Devicetree-Manager-
// specific glyph regardless of how each surface resolves icons.
const devicetreeManagerMenuItem = new MenuItem(
  'Devicetree Manager',
  vscode.TreeItemCollapsibleState.None,
  {
    light: path.join(__filename, '..', '..', 'res', 'icons', 'light', 'dt-icon.svg'),
    dark: path.join(__filename, '..', '..', 'res', 'icons', 'dark', 'dt-icon.svg'),
  },
  {
    command: 'zephyr-workbench.devicetree-manager',
    title: 'Devicetree Manager',
  }
);

const westManagerMenuItem = new MenuItem(
  'West Manager',
  vscode.TreeItemCollapsibleState.None,
  {
    light: path.join(__filename, '..', '..', 'res', 'icons', 'light', 'west_icon_light.svg'),
    dark: path.join(__filename, '..', '..', 'res', 'icons', 'dark', 'west_icon_dark.svg'),
  },
  {
    command: 'zephyr-workbench.west-manager',
    title: 'West Manager',
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
        items.push(advancedInstallHostToolsMenuItem);
      }

      items.push(newAppMenuItem);
      items.push(newWestWorkspaceMenuItem);
      items.push(newSDKMenuItem);
      items.push(devicetreeManagerMenuItem);
      items.push(debugManagerMenuItem);
      items.push(westManagerMenuItem);
    }
    return items;
  }

  refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}
}
