import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ZephyrModuleProject } from '../models/ZephyrModuleProject';
import { getListProject } from '../utils/utils';

export class ZephyrModuleDataProvider implements vscode.TreeDataProvider<ZephyrModuleTreeItem> {
  private wsRoot: string | undefined;
	private _onDidChangeTreeData: vscode.EventEmitter<ZephyrModuleTreeItem | undefined | void> = new vscode.EventEmitter<ZephyrModuleTreeItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<ZephyrModuleTreeItem | undefined | void> = this._onDidChangeTreeData.event;

  constructor(private workspaceRoot: string | undefined) {
		this.wsRoot = workspaceRoot;
	}

  getTreeItem(element: ZephyrModuleTreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element;
  }

  async getChildren(element?: ZephyrModuleTreeItem | undefined): Promise<ZephyrModuleTreeItem[]> {
		if(element) {
			return Promise.resolve([]);
		}

    // Get the list of projects on from the workspace "modules" directory
		// if(this.workspaceRoot) {
		// 	let treeItems : ZephyrModuleTreeItem[] = [];
    //   if(fs.existsSync(this.workspaceRoot)) {
		// 		let modulesDir = path.join(this.workspaceRoot, "modules");
    //     const listModProjects = await getListProject(modulesDir);

    //     for(let i=0; i<listModProjects.length; i++) {
    //       let project = listModProjects[i];
    //       const treeItem = new ZephyrModuleTreeItem(project, true, vscode.TreeItemCollapsibleState.None);
    //       treeItems.push(treeItem);
    //     }
        
    //     return Promise.resolve(treeItems);
		// 	}
		// }
    return Promise.resolve([]);
  }

  getParent?(element: ZephyrModuleTreeItem): vscode.ProviderResult<ZephyrModuleTreeItem> {
    return null;
  }

  resolveTreeItem?(item: vscode.TreeItem, element: ZephyrModuleTreeItem, token: vscode.CancellationToken): vscode.ProviderResult<vscode.TreeItem> {
    throw new Error('Method not implemented.');
  }

  refresh(): void {
		this._onDidChangeTreeData.fire();
	}

}

export class ZephyrModuleTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrModuleProject,
		private isActive: boolean,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
	) {
    if(project.sourceDir) {
      super(project.folderName, collapsibleState);
      this.description = this.isActive ? "[active]" : "";
    }
	}

	iconPath = {
		light: path.join(__filename, '..', '..', 'resources', 'light', 'zephyrModule.svg'),
		dark: path.join(__filename, '..', '..', 'resources', 'dark', 'zephyrModule.svg')
	};

  contextValue = 'zephyr-module';
}
