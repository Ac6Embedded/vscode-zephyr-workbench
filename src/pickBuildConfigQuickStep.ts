import vscode, { ExtensionContext, QuickPickItem, WorkspaceFolder } from "vscode";
import { ZephyrProject } from "./ZephyrProject";

export async function pickBuildConfigQuickStep(project: ZephyrProject): Promise<string | undefined> {

  const buildItems: QuickPickItem[] = [];
  
  for(let config of project.configs) {
    buildItems.push({ label: config.name, description: `${config.boardIdentifier}`});
  }

  
  const options: vscode.QuickPickOptions = {
    title: 'Select Build Configuration',
    placeHolder: '',
    ignoreFocusOut: true,
    canPickMany: false
  };

  const result = await vscode.window.showQuickPick(buildItems, options);

  if(result) {
    return Promise.resolve(result.label);
  } 
  return Promise.resolve(undefined);
}