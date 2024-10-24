import vscode, { ExtensionContext, ThemeIcon } from "vscode";
import { ZephyrProject } from "./ZephyrProject";
import { WestWorkspace } from "./WestWorkspace";
import { MultiStepInput } from "./utilities/MultiStepQuickPick";

export async function changeEnvVarQuickStep(context: ExtensionContext, parent: WestWorkspace | ZephyrProject, key: string, value?: string) {

  interface Config {
    key: string,
    value: string
  }

  async function collectInputs(key: string, value?: string) {
    const state = {} as Partial<Config>;
    state.key = key;
    state.value = value;
    await MultiStepInput.run(input => enterEnvVar(input, state));
    return state as Config;
  }

  class BrowseButton implements vscode.QuickInputButton {
		constructor(public iconPath: ThemeIcon, public tooltip: string) { }
	}

	const browseButton = new BrowseButton( ThemeIcon.Folder , 'Select');

  async function enterEnvVar(input: MultiStepInput, state: Partial<Config>) {
		const inputBox = vscode.window.createInputBox();
		inputBox.title = `Enter value for ${key}`;
		inputBox.value = typeof state.value === 'string' ? state.value : '';
		inputBox.prompt = 'Enter variable value';
		inputBox.buttons = [browseButton];
    inputBox.ignoreFocusOut = true;

		inputBox.onDidTriggerButton(async button => {
			if (button === browseButton) {
				const fileUri = await vscode.window.showOpenDialog({
					canSelectFiles: true,
					canSelectFolders: true,
					canSelectMany: false, 
					openLabel: 'Select location:', 
				});

				if (fileUri && fileUri.length > 0) {
					inputBox.value = fileUri[0].fsPath;  // Update input box value with the selected path
				}
			}
		});

		inputBox.onDidAccept(() => {
			state.value = inputBox.value;
			inputBox.hide();
		});

		inputBox.onDidHide(() => inputBox.dispose());
		inputBox.show();
	}
  
  const state = await collectInputs(key, value);

  if(state.value) {
    parent.envVars[key] = parent.envVars[key];
  }
}

