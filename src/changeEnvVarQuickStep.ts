import * as vscode from 'vscode';
import { WestWorkspace } from "./WestWorkspace";
import { ZephyrProject } from "./ZephyrProject";
import { getSupportedShields, getWestWorkspace } from "./utils";

// If you want to keep changeEnvVarQuickStep as a generic handler, add this at the top:
export async function changeEnvVarQuickStep(
  context: WestWorkspace | ZephyrProject | any,
  key: string,
  value?: any
): Promise<string | undefined> {
  // Special handling for the SHIELD key
  if (key === 'SHIELD') {
    // Try to get a ZephyrProject from the context.
    let project: ZephyrProject | undefined;
    if (value instanceof ZephyrProject) {
      project = value;
    } else if (value && (value as any).project) {
      project = (value as any).project;
    }
    if (!project) {
      vscode.window.showErrorMessage("Shield selection requires a project context.");
      return undefined;
    }

    // Get the WestWorkspace from the project's westWorkspacePath.
    const westWorkspace = getWestWorkspace(project.westWorkspacePath);
    if (!westWorkspace) {
      vscode.window.showErrorMessage("Unable to locate the west workspace for shield selection.");
      return undefined;
    }

    // Retrieve the list of supported shields (an array of shield names)
    const shields = await getSupportedShields(westWorkspace);
    if (shields.length === 0) {
      vscode.window.showInformationMessage("No shields found in the workspace.");
      return undefined;
    }

    // Map the shield names into quick pick items
    const shieldItems: vscode.QuickPickItem[] = shields.map(shieldName => ({
      label: shieldName
    }));

    // Show a quick pick menu for shields
    const options: vscode.QuickPickOptions = {
      title: "Select Shield",
      placeHolder: "Select a shield",
      canPickMany: false,
      ignoreFocusOut: true
    };

    const result = await vscode.window.showQuickPick(shieldItems, options);
    return result ? result.label : undefined;
  }

  // --- Default generic behavior below ---
  class BrowseButton implements vscode.QuickInputButton {
    constructor(public iconPath: vscode.ThemeIcon, public tooltip: string) {}
  }

  const browseButton = new BrowseButton(vscode.ThemeIcon.Folder, 'Select');
  const inputBox = vscode.window.createInputBox();
  inputBox.title = `Enter value for ${key}`;
  inputBox.value = typeof value === 'string' ? value : '';
  inputBox.prompt = 'Enter variable value';
  inputBox.buttons = [browseButton];
  inputBox.ignoreFocusOut = true;

  return new Promise((resolve) => {
    inputBox.onDidTriggerButton(async (button) => {
      if (button === browseButton) {
        let options: vscode.OpenDialogOptions = {
          openLabel: 'Select'
        };
        if(key.endsWith('_FILE')) {
          options.canSelectFiles = true;
          options.canSelectFolders = false;
        } else {
          options.canSelectFiles = false;
          options.canSelectFolders = true;
        }
        const fileUri = await vscode.window.showOpenDialog(options);
        if (fileUri && fileUri.length > 0) {
          inputBox.value = fileUri[0].fsPath;
        }
      }
    });

    inputBox.onDidAccept(() => {
      resolve(inputBox.value);
      inputBox.dispose();
    });

    inputBox.onDidHide(() => {
      resolve(undefined);
      inputBox.dispose();
    });

    inputBox.show();
  });
}