import * as vscode from 'vscode';
import * as path from 'path';
import { WestWorkspace } from '../models/WestWorkspace';
import {
  getEffectiveWorkspaceApplicationEntry,
  readWorkspaceApplicationEntries,
  resolveWorkspaceApplicationPath,
} from '../utils/zephyr/workspaceApplications';

type WestWorkspaceProviderItem =
  | WestWorkspaceTreeItem
  | WestWorkspaceApplicationsTreeItem
  | WestWorkspaceApplicationTreeItem
  | WestWorkspaceRootConfigurationsTreeItem
  | WestWorkspaceEnvTreeItem
  | WestWorkspaceEnvValueTreeItem;

export class WestWorkspaceDataProvider implements vscode.TreeDataProvider<WestWorkspaceProviderItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<WestWorkspaceProviderItem | undefined | void> = new vscode.EventEmitter<WestWorkspaceProviderItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<WestWorkspaceProviderItem | undefined | void> = this._onDidChangeTreeData.event;

  getTreeItem(element: WestWorkspaceProviderItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  getChildren(element?: WestWorkspaceProviderItem | undefined): vscode.ProviderResult<WestWorkspaceProviderItem[]> {
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

    if(element instanceof WestWorkspaceTreeItem) {
      const items: WestWorkspaceProviderItem[] = [];
      const applications = getWorkspaceApplicationTreeItems(element.westWorkspace);
      if (applications.length > 0) {
        items.push(new WestWorkspaceApplicationsTreeItem(element.westWorkspace, applications.length));
      }
      items.push(new WestWorkspaceRootConfigurationsTreeItem(
        element.westWorkspace,
        applications.length === 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      ));
      return Promise.resolve(items);
    }

    if(element instanceof WestWorkspaceApplicationsTreeItem) {
      return Promise.resolve(getWorkspaceApplicationTreeItems(element.westWorkspace));
    }

    if(element instanceof WestWorkspaceRootConfigurationsTreeItem) {
      return Promise.resolve(getWorkspaceRootConfigurationTreeItems(element.westWorkspace));
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

function getWorkspaceRootConfigurationTreeItems(westWorkspace: WestWorkspace): WestWorkspaceEnvTreeItem[] {
  return WestWorkspace.envVarKeys.map(key => new WestWorkspaceEnvTreeItem(westWorkspace, key));
}

function getWorkspaceApplicationTreeItems(westWorkspace: WestWorkspace): WestWorkspaceApplicationTreeItem[] {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(westWorkspace.rootUri);
  if (!workspaceFolder) {
    return [];
  }

  const items: WestWorkspaceApplicationTreeItem[] = [];
  const entries = readWorkspaceApplicationEntries(workspaceFolder);
  // Only mark a row as "selected" when there are several apps to choose
  // from - when there's just one, the tick is noise since selection is
  // implicit and unchangeable.
  const showSelection = entries.length > 1;
  const effectiveEntry = showSelection ? getEffectiveWorkspaceApplicationEntry(workspaceFolder) : undefined;
  const effectivePath = effectiveEntry
    ? resolveWorkspaceApplicationPath(effectiveEntry, workspaceFolder)
    : undefined;
  const normalizedSelectedPath = effectivePath ? path.normalize(effectivePath) : undefined;

  for (const entry of entries) {
    const appPath = resolveWorkspaceApplicationPath(entry, workspaceFolder);
    if (appPath) {
      const isSelected = !!normalizedSelectedPath && path.normalize(appPath) === normalizedSelectedPath;
      items.push(new WestWorkspaceApplicationTreeItem(westWorkspace, appPath, isSelected));
    }
  }

  return items;
}

export class WestWorkspaceApplicationsTreeItem extends vscode.TreeItem {
  constructor(
    public readonly westWorkspace: WestWorkspace,
    public readonly applicationCount: number,
  ) {
    super('Applications', vscode.TreeItemCollapsibleState.Expanded);
    this.description = `[${applicationCount}]`;
    this.tooltip = 'West workspace applications';
    this.iconPath = new vscode.ThemeIcon('folder');
  }

  contextValue = 'west-workspace-applications';
}

export class WestWorkspaceRootConfigurationsTreeItem extends vscode.TreeItem {
  constructor(
    public readonly westWorkspace: WestWorkspace,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super('Configurations', collapsibleState);
    this.tooltip = 'West workspace root configurations';
    this.iconPath = new vscode.ThemeIcon('variable');
  }

  contextValue = 'west-workspace-root-configurations';
}

export class WestWorkspaceApplicationTreeItem extends vscode.TreeItem {
  constructor(
    public readonly westWorkspace: WestWorkspace,
    public readonly appRootPath: string,
    public readonly isSelected: boolean = false,
  ) {
    // VS Code renders rows as: chevron, icon, label, description. The chevron
    // is controlled by collapsibleState, so selected apps keep the folder glyph
    // and use a text marker in the label.
    const baseLabel = path.basename(appRootPath);
    super(isSelected ? `\u2713 ${baseLabel}` : baseLabel, vscode.TreeItemCollapsibleState.None);
    this.description = path.relative(westWorkspace.rootUri.fsPath, appRootPath).replace(/\\/g, '/');
    this.tooltip = isSelected ? `${appRootPath}\n[selected]` : appRootPath;
    this.iconPath = new vscode.ThemeIcon('folder');
  }

  contextValue = 'west-workspace-application';
}

export class WestWorkspaceTreeItem extends vscode.TreeItem {
  constructor(
    public readonly westWorkspace: WestWorkspace,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(`${westWorkspace.name}`, collapsibleState);

    this.tooltip = `${this.westWorkspace.rootUri.fsPath}`;
    this.description = `[${this.westWorkspace.version}]`;
    // Suffix the context value when a dedicated venv is set so the "Remove venv"
    // menu item can be gated to only appear when there is one to remove.
    this.contextValue = westWorkspace.venvPath ? 'west-workspace-hasvenv' : 'west-workspace';
  }

  //iconPath = new vscode.ThemeIcon('symbol-misc');
  iconPath = {
    light: path.join(__filename, '..', '..', 'res', 'icons','zephyr.svg'),
    dark: path.join(__filename, '..', '..', 'res', 'icons','zephyr.svg')
  };
}

export class WestWorkspaceEnvTreeItem extends vscode.TreeItem {
  constructor(
    public readonly westWorkspace: WestWorkspace,
    public readonly envKey: string
  ) {
    // Match the application tree's behaviour: drop the chevron on empty
    // env-var rows (BOARD_ROOT, DTS_ROOT, ...) so they don't pretend to
    // have children when there's nothing to expand into.
    const isEmpty = westWorkspace.envVars[envKey].length === 0;
    super(envKey, isEmpty ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    this.description = isEmpty ? '[not set]' : '';
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
