import * as vscode from 'vscode';
import { checkHostTools } from '../utils/installUtils';
import { isZinstallerUpdateNeeded } from '../utils/utils';
import { ZEPHYR_DOCS_BASE_URL } from '../constants';
import path from 'path';

class MenuItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly icon: string | { light: string; dark: string } | undefined,
    public readonly command?: vscode.Command
  ) {
      super(label, collapsibleState);
      if (command) {
          this.command = command;
      }
      if (typeof icon === 'string') {
        this.iconPath = new vscode.ThemeIcon(icon);
      } else if (icon) {
        this.iconPath = icon;
      }
  }
}

const warningIcon = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));

// Shown at the top of Get Started while the host tools are missing, since
// west workspaces, toolchains and builds all need them.
const installHostToolsMenuItem = new MenuItem(
  'Install Host Tools',
  vscode.TreeItemCollapsibleState.None,
  'warning',
  {
    command: 'zephyr-workbench.install-host-tools.open-manager',
    title: 'Install Host Tools',
  }
);
installHostToolsMenuItem.iconPath = warningIcon;
installHostToolsMenuItem.tooltip = 'Host tools are not installed yet. West workspaces, toolchains and builds need them.';

// Takes the install row's place once the host tools are installed but older
// than this extension needs. The Host Tools Manager offers the reinstall.
const updateHostToolsMenuItem = new MenuItem(
  'Update Host Tools',
  vscode.TreeItemCollapsibleState.None,
  'warning',
  {
    command: 'zephyr-workbench.host-tools-manager',
    title: 'Update Host Tools',
  }
);
updateHostToolsMenuItem.iconPath = warningIcon;
updateHostToolsMenuItem.tooltip = 'Your host tools are outdated. Builds might not work properly. Open the Host Tools Manager to update them.';

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
devicetreeManagerMenuItem.tooltip = new vscode.MarkdownString(
  `Open the Devicetree Manager.\n\n[Read the documentation](${ZEPHYR_DOCS_BASE_URL}/devicetree-manager)`
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

const aiManagerMenuItem = new MenuItem(
  'AI Manager',
  vscode.TreeItemCollapsibleState.None,
  // Same colors in both themes.
  {
    light: path.join(__filename, '..', '..', 'res', 'icons', 'ai_manager_icon.svg'),
    dark: path.join(__filename, '..', '..', 'res', 'icons', 'ai_manager_icon.svg'),
  },
  {
    command: 'zephyr-workbench.ai-manager',
    title: 'AI Manager',
  }
);
aiManagerMenuItem.tooltip = 'Connect AI coding agents (Claude Code, Codex, Copilot, Cursor and others) to Zephyr Workbench.';

// Collapsed group at the end of Get Started: links that open in the browser.
// No icon on purpose: VS Code only puts the rows' icons in the expand arrow's
// column when no expandable row beside them has an icon, which keeps the Get
// Started icons in line with the Managers ones.
const externalResourcesMenuItem = new MenuItem(
  'External',
  vscode.TreeItemCollapsibleState.Collapsed,
  undefined
);

const workbenchDocsMenuItem = new MenuItem(
  'Zephyr Workbench Documentation',
  vscode.TreeItemCollapsibleState.None,
  {
    light: path.join(__filename, '..', '..', 'res', 'icons', 'light', 'zephyr_workbench_icon_light.svg'),
    dark: path.join(__filename, '..', '..', 'res', 'icons', 'dark', 'zephyr_workbench_icon_dark.svg'),
  },
  {
    command: 'zephyr-workbench.open-webpage',
    title: 'Zephyr Workbench Documentation',
    arguments: [`${ZEPHYR_DOCS_BASE_URL}/zephyr-workbench`]
  }
);

const trainingPartnersMenuItem = new MenuItem(
  'Zephyr Training Partners',
  vscode.TreeItemCollapsibleState.None,
  // Same colors in both themes.
  {
    light: path.join(__filename, '..', '..', 'res', 'icons', 'training_icon.svg'),
    dark: path.join(__filename, '..', '..', 'res', 'icons', 'training_icon.svg'),
  },
  {
    command: 'zephyr-workbench.open-webpage',
    title: 'Zephyr Training Partners',
    arguments: ['https://zephyrproject.org/training-partner-program']
  }
);

/**
 * The "Get Started" view: the Add actions, preceded by Install Host Tools
 * while the host tools are missing (or Update Host Tools while they are
 * outdated), then the External group.
 */
export class ZephyrShortcutCommandProvider implements vscode.TreeDataProvider<MenuItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<MenuItem | undefined> = new vscode.EventEmitter<MenuItem | undefined>();
  readonly onDidChangeTreeData: vscode.Event<MenuItem | undefined> = this._onDidChangeTreeData.event;

  getTreeItem(element: MenuItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  async getChildren(element?: MenuItem): Promise<MenuItem[]> {
    const items: MenuItem[] = [];

    if(element === undefined) {
      if(!await checkHostTools()) {
        items.push(installHostToolsMenuItem);
      } else if (isZinstallerUpdateNeeded()) {
        items.push(updateHostToolsMenuItem);
      }

      items.push(newAppMenuItem);
      items.push(newWestWorkspaceMenuItem);
      items.push(newSDKMenuItem);
      items.push(externalResourcesMenuItem);
    } else if (element === externalResourcesMenuItem) {
      items.push(workbenchDocsMenuItem);
      items.push(trainingPartnersMenuItem);
    }
    return items;
  }

  refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}
}

/** The "Managers" view: Devicetree, Debug, West, then AI. */
export class ZephyrManagersCommandProvider implements vscode.TreeDataProvider<MenuItem> {
  getTreeItem(element: MenuItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  getChildren(element?: MenuItem): MenuItem[] {
    if (element !== undefined) {
      return [];
    }
    return [devicetreeManagerMenuItem, debugManagerMenuItem, westManagerMenuItem, aiManagerMenuItem];
  }
}
