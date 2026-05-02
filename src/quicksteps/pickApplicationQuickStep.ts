import vscode, { ExtensionContext, QuickPickItem } from "vscode";
import { ZephyrApplication } from "../models/ZephyrApplication";

type ApplicationQuickPickItem = QuickPickItem & {
  appRootPath: string;
};

export async function pickApplicationQuickStep(context: ExtensionContext): Promise<ZephyrApplication | undefined> {

  const applicationItems: ApplicationQuickPickItem[] = [];
  
  if(vscode.workspace.workspaceFolders) {
    const applications = await ZephyrApplication.getApplications(vscode.workspace.workspaceFolders);
    for (const application of applications) {
      applicationItems.push({
        label: application.appName,
        description: application.appRootPath,
        detail: application.isWestWorkspaceApplication ? `West workspace: ${application.appWorkspaceFolder.name}` : 'Freestanding',
        appRootPath: application.appRootPath,
      });
    }
  }
  
  const options: vscode.QuickPickOptions = {
    title: 'Select Application',
    placeHolder: '',
    ignoreFocusOut: true,
    canPickMany: false
  };

  const result = await vscode.window.showQuickPick<ApplicationQuickPickItem>(applicationItems, options);

  if(result) {
    return ZephyrApplication.getApplications(vscode.workspace.workspaceFolders ?? [])
      .then(applications => applications.find(application => application.appRootPath === result.appRootPath));
  } 
  return Promise.resolve(undefined);
}
