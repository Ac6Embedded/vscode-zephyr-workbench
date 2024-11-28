import * as vscode from 'vscode';
import { ZephyrProject } from "./ZephyrProject";
import { fileExists } from './utils';

export class ZephyrAppProject extends ZephyrProject {

  constructor(
    workspaceContext: any,
    sourceDir: string,
  ) {
    super(workspaceContext, sourceDir);
  }

  get prjConfUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.workspaceContext.uri, 'prj.conf');
  }
  
  static isApplicationFolder(folder: vscode.WorkspaceFolder): boolean {
    const prjConfFile = vscode.Uri.joinPath(folder.uri, 'prj.conf');
    return fileExists(prjConfFile.fsPath);
  }
  
  get manifestUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.workspaceContext.uri, 'west.yaml');
  }

}