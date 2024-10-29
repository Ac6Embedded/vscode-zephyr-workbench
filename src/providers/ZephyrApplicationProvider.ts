import * as vscode from 'vscode';
import * as path from 'path';
import { ZephyrAppProject } from '../ZephyrAppProject';
import { getWestWorkspace } from '../utils';

export class ZephyrApplicationDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | void> = this._onDidChangeTreeData.event;

  constructor() {

	}

  getTreeItem(element: any): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element;
  }

  async getChildren(element?: any): Promise< vscode.TreeItem[] > {
		if(element === undefined) {
      if(vscode.workspace.workspaceFolders) {
        const items: ZephyrApplicationTreeItem[] = [];

        for(let workspaceFolder of vscode.workspace.workspaceFolders) {
          if(await ZephyrAppProject.isZephyrProjectWorkspaceFolder(workspaceFolder)) {
            const appProject = new ZephyrAppProject(workspaceFolder, workspaceFolder.uri.fsPath);
            const item =  new ZephyrApplicationTreeItem(appProject, vscode.TreeItemCollapsibleState.Collapsed);
            items.push(item);
          }
        }
        return Promise.resolve(items);
      }
    }
    
    if(element instanceof ZephyrApplicationTreeItem) {
      const items: vscode.TreeItem[] = [];
      const boardItem = new ZephyrApplicationBoardTreeItem(element.project);
      const workspaceItem = new ZephyrApplicationWestWorkspaceTreeItem(element.project);
      items.push(boardItem);
      items.push(workspaceItem);

      for(let key of ZephyrAppProject.envVarKeys) {
        const envItem = new ZephyrApplicationEnvTreeItem(element.project, key);
        items.push(envItem);
      }

      const westArgsItem = new ZephyrApplicationArgTreeItem(element.project, 'west arguments');
      items.push(westArgsItem);
      return Promise.resolve(items);
    } 

    if(element instanceof ZephyrApplicationEnvTreeItem) {
      // Get Zephyr environment variables
      const items: vscode.TreeItem[] = [];
      let values = element.project.envVars[element.envKey];
      if(values) {
        for(let value of values) {
          const envValueItem = new ZephyrApplicationEnvValueTreeItem(element.project, element.envKey, value);
          items.push(envValueItem);
        }
      }
      
      return Promise.resolve(items);
    } 

    if(element instanceof ZephyrApplicationArgTreeItem) {
      // Get West Argument
      const items: vscode.TreeItem[] = [];
      if(element.project.westArgs && element.project.westArgs.length > 0) {
        const westArgsItem = new ZephyrApplicationArgValueTreeItem(element.project, 'west arguments', element.project.westArgs);
        items.push(westArgsItem);
      } 
      return Promise.resolve(items);
    } 

    return Promise.resolve([]);
  }

  getParent?(element: any): vscode.ProviderResult<vscode.TreeItem> {
    return null;
  }

  resolveTreeItem?(item: vscode.TreeItem, element: ZephyrApplicationTreeItem, token: vscode.CancellationToken): vscode.ProviderResult<vscode.TreeItem> {
    throw new Error('Method not implemented.');
  }

  refresh(): void {
		this._onDidChangeTreeData.fire();
	}

}

export class ZephyrApplicationTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrAppProject,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
	) {
    if(project.sourceDir) {
      super(project.folderName, collapsibleState);
      try {
        let westWorkspace = getWestWorkspace(project.westWorkspacePath);
        if(westWorkspace !== null) {
          this.description = `[${project.boardId} - ${westWorkspace.name}]`;
          this.contextValue = 'zephyr-application';
        } else {
          this.description = `[not configured]`;
          this.contextValue = 'zephyr-application-not-config';
        }
      } catch(e) {
        console.error(e, " path: ", project.westWorkspacePath);
      }
      this.iconPath = new vscode.ThemeIcon('folder');
      this.tooltip = project.sourceDir;
    }
	}
}

export class ZephyrApplicationWestWorkspaceTreeItem extends ZephyrApplicationTreeItem {
  constructor(
		public readonly project: ZephyrAppProject,
	) {
    super(project, vscode.TreeItemCollapsibleState.None);
    let westWorkspace = getWestWorkspace(project.westWorkspacePath);
    if(westWorkspace) {
      this.label = westWorkspace.name;
      this.description = `[${westWorkspace.version}]`;
      this.tooltip = westWorkspace.rootUri.fsPath;
      this.iconPath = {
        light: path.join(__filename, '..', '..', 'res', 'icons', 'zephyr.svg'),
        dark: path.join(__filename, '..', '..', 'res', 'icons', 'zephyr.svg')
      };
    }
	}

  contextValue = 'zephyr-application-workspace';
}

export class ZephyrApplicationBoardTreeItem extends ZephyrApplicationTreeItem {
  constructor(
		public readonly project: ZephyrAppProject,
	) {
    super(project, vscode.TreeItemCollapsibleState.None);
    this.label = project.boardId;
    this.description = '';
    this.tooltip = project.boardId;
    this.iconPath = new vscode.ThemeIcon('circuit-board');
	}
  
  contextValue = 'zephyr-application-board';
}

export class ZephyrApplicationEnvTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrAppProject,
    public readonly envKey: string
	) {
    super(envKey, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = project.envVars[envKey].length === 0 ?'[not set]':'';
    this.tooltip = envKey;
    this.iconPath = new vscode.ThemeIcon('variable');
	}
  
  contextValue = 'zephyr-application-env';
}

export class ZephyrApplicationEnvValueTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrAppProject,
    public readonly envKey: string,
    public readonly envValue: string
	) {
    super(envValue, vscode.TreeItemCollapsibleState.None);
	}
  contextValue = 'zephyr-application-env-value';
}

export class ZephyrApplicationArgTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrAppProject,
    public readonly argName: string
	) {
    super(argName, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = project.westArgs.length === 0 ?'[not set]':'';
    this.tooltip = argName;
    this.iconPath = new vscode.ThemeIcon('variable');
	}
  contextValue = 'zephyr-application-arg';
}

export class ZephyrApplicationArgValueTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrAppProject,
    public readonly argName: string,
    public readonly argValue: string
	) {
    super(argValue, vscode.TreeItemCollapsibleState.None);
	}
  contextValue = 'zephyr-application-arg-value';
}