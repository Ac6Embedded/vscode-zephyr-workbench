import vscode, { ExtensionContext, QuickPickItem } from "vscode";
import { ZephyrProject } from "./ZephyrProject";
import { getSupportedBoards, getWestWorkspace } from "./utils";
import { ZephyrBoard } from "./ZephyrBoard";

export async function changeBoardQuickStep(context: ExtensionContext, project: ZephyrProject, buildConfigName?: string): Promise<string | undefined> {
  const westWorkspace = getWestWorkspace(project.westWorkspacePath);
  const boardItems: QuickPickItem[] = [];
  const configs = project.configs;
  let buildConfig;

  if (buildConfigName) {
    buildConfig = project.getBuildConfiguration(buildConfigName);
  } else {
    buildConfig = configs[0];
  }

  if (westWorkspace) {
    let boards: ZephyrBoard[] = [];
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Updating available boards list. It might take a while...",
      cancellable: false,
    }, async () => {
      boards = await getSupportedBoards(westWorkspace, project, buildConfig);
      boards.sort((a, b) => {
        if (a.name < b.name) {
          return -1;
        }
        if (a.name > b.name) {
          return 1;
        }
        return 0;
      });
    }
    );

    for (let board of boards) {
      boardItems.push({ label: board.name, description: board.identifier });
    }

    const options: vscode.QuickPickOptions = {
      title: 'Change Board',
      placeHolder: 'Select a target board',
      matchOnDescription: true,
      canPickMany: false,
      ignoreFocusOut: true
    };

    const result = await vscode.window.showQuickPick(boardItems, options);

    if (result) {
      if (result.description) {
        return Promise.resolve(result.description);
      }
    } else {
      return Promise.resolve(undefined);
    }
  }
  return Promise.resolve(undefined);
}

