import vscode, { ExtensionContext, ThemeIcon } from "vscode";
import { ZephyrProject } from "./ZephyrProject";

export async function changeVenvQuickStep(context: ExtensionContext, project: ZephyrProject): Promise<string | undefined> {

  class BrowseActivateButton implements vscode.QuickInputButton {
		constructor(public iconPath: ThemeIcon, public tooltip: string) { }
	}

	const browseActivateButton = new BrowseActivateButton( ThemeIcon.Folder , 'Select activate file');

  // const result = await vscode.window.showInputBox({
  //   title: 'Set python virtual environment',
  //   placeHolder: 'Select a virtual environment activate script',
  //   buttons: [browseActivateButton]
  // });

  // if(result) {
  //   if(result instanceof BrowseActivateButton) {
  //     const folderUri = await vscode.window.showOpenDialog({
  //       canSelectFiles: true,
  //       canSelectFolders: false,
  //       canSelectMany: false,
  //       openLabel: 'Select virtual environment activate script:',
  //     });

  //     if(folderUri && folderUri.length > 0) {
  //       state.projectLoc = folderUri[0].fsPath;
  //     }

  //   } else {
  //     return Promise.resolve(result);
  //   }
  // } else {
  //   return Promise.resolve(undefined);
  // }
  return Promise.resolve(undefined);
}

