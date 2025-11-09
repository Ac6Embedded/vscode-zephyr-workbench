import vscode, { ExtensionContext, QuickPickItem, WorkspaceFolder } from "vscode";
import { ZephyrAppProject } from "../models/ZephyrAppProject";

export async function pickApplicationQuickStep(context: ExtensionContext): Promise<WorkspaceFolder | undefined> {

  const applicationItems: QuickPickItem[] = [];
  
  if(vscode.workspace.workspaceFolders) {
    for(let workspaceFolder of vscode.workspace.workspaceFolders) {
      if(await ZephyrAppProject.isZephyrProjectWorkspaceFolder(workspaceFolder)) {
        applicationItems.push({ label: workspaceFolder.name, description: workspaceFolder.uri.fsPath});
      }
    }
  }
  
  const options: vscode.QuickPickOptions = {
    title: 'Select Application',
    placeHolder: '',
    ignoreFocusOut: true,
    canPickMany: false
  };

  const result = await vscode.window.showQuickPick(applicationItems, options);

  if(result && result.description) {
    const selectedFolder = vscode.workspace.workspaceFolders?.find(folder => folder.uri.fsPath === result.description);
    return Promise.resolve(selectedFolder);
  } 
  return Promise.resolve(undefined);
}