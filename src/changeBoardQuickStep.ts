import vscode, { ExtensionContext, QuickPickItem } from "vscode";
import { ZephyrProject } from "./ZephyrProject";
import { getSupportedBoards, getWestWorkspace } from "./utils";

export async function changeBoardQuickStep(context: ExtensionContext, project: ZephyrProject): Promise<string | undefined> {
  const westWorkspace = getWestWorkspace(project.westWorkspacePath);
  const boardItems: QuickPickItem[] = [];
  if(westWorkspace) {

    const boards = await getSupportedBoards(westWorkspace);
    for(let board of boards) {
      boardItems.push({ label: board.name, description: board.identifier });
    }

    const options: vscode.QuickPickOptions = {
      title: 'Change Board',
      placeHolder: 'Select a target board',
      matchOnDescription: true,
      canPickMany: false
    };

    const result = await vscode.window.showQuickPick(boardItems, options);

    if(result) {
      if(result.description) {
        return Promise.resolve(result.description);
      }
    } else {
      return Promise.resolve(undefined);
    }
  }
  return Promise.resolve(undefined);
}

