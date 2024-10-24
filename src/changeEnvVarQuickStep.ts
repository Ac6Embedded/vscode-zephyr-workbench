import vscode, { ExtensionContext, ThemeIcon } from "vscode";
import { ZephyrProject } from "./ZephyrProject";
import { WestWorkspace } from "./WestWorkspace";

export async function changeEnvVarQuickStep(
  parent: WestWorkspace | ZephyrProject,
  key: string,
  value?: string
): Promise<string | undefined> {
  class BrowseButton implements vscode.QuickInputButton {
    constructor(public iconPath: ThemeIcon, public tooltip: string) {}
  }

  const browseButton = new BrowseButton(ThemeIcon.Folder, 'Select');
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
          openLabel: 'Select item:'
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
