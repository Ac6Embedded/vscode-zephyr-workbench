import * as vscode from 'vscode';
import { ZephyrApplication } from "./ZephyrApplication";
import { fileExists } from '../utils/utils';

export class ZephyrModuleProject extends ZephyrApplication {
  static isModuleFolder(folder: vscode.WorkspaceFolder): boolean {
    const moduleFile = vscode.Uri.joinPath(folder.uri, 'module.yaml');
    return fileExists(moduleFile.fsPath);
  }
}
