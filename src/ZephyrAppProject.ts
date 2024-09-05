import * as vscode from 'vscode';
import fs from "fs";
import { ZephyrProject } from "./ZephyrProject";
import { WestWorkspace } from './WestWorkspace';
import { ZephyrBoard } from './ZephyrBoard';
import path from 'path';
import { fileExists } from './utils';
import { ZephyrSDK } from './ZephyrSDK';

export class ZephyrAppProject extends ZephyrProject {

  public constructor(
    workspaceContext: any,
    sourceDir: string,
  ) {
    super(workspaceContext, sourceDir);
    //this.parseZWManifest();
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