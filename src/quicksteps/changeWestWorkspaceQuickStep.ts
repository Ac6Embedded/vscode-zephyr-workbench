import vscode, { ExtensionContext, QuickPickItem } from "vscode";
import { ZephyrProject } from "../models/ZephyrProject";
import { getWestWorkspaces } from "../utils/utils";

export async function changeWestWorkspaceQuickStep(context: ExtensionContext, project: ZephyrProject): Promise<string | undefined> {

  const westWorkspaceItems: QuickPickItem[] = [];

  for(let westWorkspace of getWestWorkspaces()) {
    westWorkspaceItems.push({ label: westWorkspace.name, description: westWorkspace.rootUri.fsPath });
  }
  
  const options: vscode.QuickPickOptions = {
    title: 'Change West Workspace',
    placeHolder: 'Select a workspace',
    canPickMany: false
  };

  const result = await vscode.window.showQuickPick(westWorkspaceItems, options);

  if(result) {
    if(result.description) {
      return Promise.resolve(result.description);
    }
  } 
  return Promise.resolve(undefined);
}