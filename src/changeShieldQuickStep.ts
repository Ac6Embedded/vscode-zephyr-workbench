import vscode, { ExtensionContext, QuickPickItem } from "vscode";
import { ZephyrProject } from "./ZephyrProject";
import { getSupportedShields, getWestWorkspace } from "./utils";

export async function changeShieldQuickStep(context: ExtensionContext, project: ZephyrProject): Promise<string | undefined> {
  // Retrieve the West workspace from the project's westWorkspacePath.
  const westWorkspace = getWestWorkspace(project.westWorkspacePath);
  if (!westWorkspace) {
    vscode.window.showErrorMessage("West workspace not found.");
    return undefined;
  }

  let shields: string[] = [];
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Updating available shields list. It might take a while...",
    cancellable: false,
  }, async () => {
    shields = await getSupportedShields(westWorkspace);
    shields.sort((a, b) => a.localeCompare(b));
  });

  // Create quick pick items from the shield names.
  const shieldItems: QuickPickItem[] = shields.map(shield => ({ label: shield }));

  const options: vscode.QuickPickOptions = {
    title: 'Change Shield',
    placeHolder: 'Select a shield',
    canPickMany: false,
    ignoreFocusOut: true
  };

  const result = await vscode.window.showQuickPick(shieldItems, options);
  return result ? result.label : undefined;
}