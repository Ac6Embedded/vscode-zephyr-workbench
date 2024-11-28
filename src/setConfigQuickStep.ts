import vscode, {  } from "vscode";
import { ZephyrProjectBuildConfiguration } from "./ZephyrProjectBuildConfiguration";
import { ZephyrProject } from "./ZephyrProject";

export async function setConfigQuickStep(
  context: ZephyrProjectBuildConfiguration,
  project?: ZephyrProject
): Promise<string | undefined> {

  const inputBox = vscode.window.createInputBox();
  inputBox.title = `Enter build configuration name`;
  inputBox.value = context ? context.name : '';
  inputBox.prompt = 'Enter configuration name';
  inputBox.ignoreFocusOut = true;

  inputBox.onDidChangeValue((input) => {
    inputBox.validationMessage = undefined;

    if (input.trim() === '') {
      inputBox.validationMessage = 'Configuration name cannot be empty.';
    }

    const regex = /^[a-zA-Z0-9-_]+$/;
    if (!regex.test(input)) {
      inputBox.validationMessage = 'Configuration name can only contain letters, digits, "-", "_", and must not include spaces.';
    }

    if(project) {
      const configNames = project.configs.map(config => config.name);
      if(configNames.includes(input)) {
        inputBox.validationMessage = `This "${input}" build configuration already exists`;
      }
    }
});

  return new Promise((resolve) => {
    inputBox.onDidAccept(() => {
      if(inputBox.validationMessage === undefined) {
        resolve(inputBox.value);
        inputBox.dispose();
      }
    });

    inputBox.onDidHide(() => {
      resolve(undefined);
      inputBox.dispose();
    });

    inputBox.show();
  });
}
