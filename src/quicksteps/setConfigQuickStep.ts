import vscode, {  } from "vscode";
import { ZephyrBuildConfig } from "../models/ZephyrBuildConfig";
import { ZephyrApplication } from "../models/ZephyrApplication";
import { defaultNewConfigName, validateBuildConfigName } from "../utils/zephyr/buildConfigRules";

export async function setConfigQuickStep(
  context: ZephyrBuildConfig,
  project?: ZephyrApplication
): Promise<string | undefined> {

  const defaultName = project ? defaultNewConfigName(project.buildConfigs) : 'primary';

  const inputBox = vscode.window.createInputBox();
  inputBox.title = `Enter build configuration name`;
  inputBox.value = context && context.name.length > 0 ? context.name : defaultName;
  inputBox.prompt = 'Enter configuration name';
  inputBox.ignoreFocusOut = true;

  inputBox.onDidChangeValue((input) => {
    // The same rule the agent tools apply, so a name created by either one
    // can be typed again here.
    const configNames = project ? project.buildConfigs.map(config => config.name) : [];
    inputBox.validationMessage = validateBuildConfigName(input, configNames);
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
