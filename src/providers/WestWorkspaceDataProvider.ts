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
  | WestWorkspaceApplicationTreeItem
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
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(element.westWorkspace.rootUri);
      if (workspaceFolder) {
        const entries = readWorkspaceApplicationEntries(workspaceFolder);
        // Only mark a row as "selected" when there are several apps to choose
        // from — when there's just one, the tick is noise since selection is
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
            items.push(new WestWorkspaceApplicationTreeItem(element.westWorkspace, appPath, isSelected));
          }
        }
      }
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

export class WestWorkspaceApplicationTreeItem extends vscode.TreeItem {
  constructor(
    public readonly westWorkspace: WestWorkspace,
    public readonly appRootPath: string,
    public readonly isSelected: boolean = false,
  ) {
    // VS Code's TreeItem renders rows as `[chevron] [icon] [label] [description]`.
    // The chevron column is owned by the tree (auto-rendered from
    // collapsibleState) and has no API to inject custom icons. To mark the
    // selected app without losing the folder glyph we prepend a Unicode tick
    // ("✓") to the label — sibling env-var rows still get their auto chevron
    // because they have children, so the visual columns stay aligned.
    const baseLabel = path.basename(appRootPath);
    super(isSelected ? `✓ ${baseLabel}` : baseLabel, vscode.TreeItemCollapsibleState.None);
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
	}

	//iconPath = new vscode.ThemeIcon('symbol-misc');
  iconPath = {
    light: path.join(__filename, '..', '..', 'res', 'icons','zephyr.svg'),
    dark: path.join(__filename, '..', '..', 'res', 'icons','zephyr.svg')
	};
	contextValue = 'west-workspace';
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
