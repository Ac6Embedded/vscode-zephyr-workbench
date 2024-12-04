import vscode, {  } from "vscode";
import { ZephyrProjectBuildConfiguration } from "./ZephyrProjectBuildConfiguration";
import { ZephyrProject } from "./ZephyrProject";

export async function setConfigQuickStep(
  context: ZephyrProjectBuildConfiguration,
  project?: ZephyrProject
): Promise<string | undefined> {

  let defaultName = 'setup';
  if(project) {
    if(project.configs.length > 0) {
      defaultName = getNewConfigName(project.configs);
    }
  }

  const inputBox = vscode.window.createInputBox();
  inputBox.title = `Enter build configuration name`;
  inputBox.value = context && context.name.length > 0 ? context.name : defaultName;
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

function getNewConfigName(configs: any[]): string {
  const regex = /^setup(_(\d+))?$/;

  const setupNumbers = configs
    .map(config => {
      const match = config.name.match(regex);
      if (match && match[2]) {
        return parseInt(match[2], 10);
      } else if (config.name === 'setup') {
        return 1;
      }
      return null;
    })
    .filter(num => num !== null) as number[];

  if (setupNumbers.length === 0) {
    return 'setup';
  }

  const latestSetupNumber = Math.max(...setupNumbers);
  return `setup_${latestSetupNumber + 1}`;
}
