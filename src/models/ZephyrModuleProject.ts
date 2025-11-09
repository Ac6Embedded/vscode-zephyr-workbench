import * as vscode from 'vscode';
import fs from "fs";
import { ZephyrProject } from "./ZephyrProject";
import { fileExists } from '../utils/utils';

export class ZephyrModuleProject extends ZephyrProject {
  static isModuleFolder(folder: vscode.WorkspaceFolder): boolean {
    const moduleFile = vscode.Uri.joinPath(folder.uri, 'module.yaml');
    return fileExists(moduleFile.fsPath);
  }
}