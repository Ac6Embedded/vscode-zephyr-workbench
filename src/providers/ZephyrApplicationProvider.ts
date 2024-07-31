import * as vscode from 'vscode';
import * as path from 'path';
import { ZephyrAppProject } from '../ZephyrAppProject';
import { getWestWorkspace } from '../utils';

export class ZephyrApplicationDataProvider implements vscode.TreeDataProvider<ZephyrApplicationTreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<ZephyrApplicationTreeItem | undefined | void> = new vscode.EventEmitter<ZephyrApplicationTreeItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<ZephyrApplicationTreeItem | undefined | void> = this._onDidChangeTreeData.event;

  constructor() {

	}

  getTreeItem(element: ZephyrApplicationTreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element;
  }

  async getChildren(element?: ZephyrApplicationTreeItem | undefined): Promise<ZephyrApplicationTreeItem[]> {
		if(element === undefined) {
      if(vscode.workspace.workspaceFolders) {
        const items: ZephyrApplicationTreeItem[] = [];

        for(let workspaceFolder of vscode.workspace.workspaceFolders) {
          if(ZephyrAppProject.isApplicationFolder(workspaceFolder)) {
            const appProject = new ZephyrAppProject(workspaceFolder, workspaceFolder.uri.fsPath);
            const item =  new ZephyrApplicationTreeItem(appProject, vscode.TreeItemCollapsibleState.Collapsed);
            items.push(item);
          }
        }
        return Promise.resolve(items);
      }
    }
    
    if(element instanceof ZephyrApplicationTreeItem) {
      const items: ZephyrApplicationTreeItem[] = [];
      const boardItem =  new ZephyrApplicationBoardTreeItem(element.project);
      const workspaceItem = new ZephyrApplicationWestWorkspaceTreeItem(element.project);
      items.push(boardItem);
      items.push(workspaceItem);
      return Promise.resolve(items);
      
    } 
    return Promise.resolve([]);
  }

  getParent?(element: ZephyrApplicationTreeItem): vscode.ProviderResult<ZephyrApplicationTreeItem> {
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
    }
	}
}

export class ZephyrApplicationWestWorkspaceTreeItem extends ZephyrApplicationTreeItem {
  constructor(
		public readonly project: ZephyrAppProject,
	) {
    super(project, vscode.TreeItemCollapsibleState.None);
    this.label = path.basename(project.westWorkspacePath);
    this.description = '';
    this.iconPath = {
      light: path.join(__filename, '..', '..', 'res', 'icons', 'zephyr.svg'),
      dark: path.join(__filename, '..', '..', 'res', 'icons', 'zephyr.svg')
    };
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
    this.iconPath = new vscode.ThemeIcon('circuit-board');
	}
  
  contextValue = 'zephyr-application-board';
}


