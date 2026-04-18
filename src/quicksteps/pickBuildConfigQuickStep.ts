import vscode, { QuickPickItem } from "vscode";
import { ZephyrApplication } from "../models/ZephyrApplication";

export async function pickBuildConfigQuickStep(project: ZephyrApplication): Promise<string | undefined> {

  const buildItems: QuickPickItem[] = [];
  
  for(let config of project.buildConfigs) {
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
