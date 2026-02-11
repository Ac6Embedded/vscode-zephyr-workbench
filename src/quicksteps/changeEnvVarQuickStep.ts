import * as vscode from 'vscode';
import { WestWorkspace } from "../models/WestWorkspace";
import { ZephyrProject } from "../models/ZephyrProject";
import { saveConfigSetting } from '../utils/zephyrEnvUtils';
import { getWestWorkspace } from "../utils/utils";
import { getSupportedShields, getSupportedSnippets } from '../commands/WestCommands';

export async function changeEnvVarQuickStep(
  context: WestWorkspace | ZephyrProject | any,
  key: string,
  value?: any
): Promise<string | undefined> {
  if (key === 'SHIELD') {
    let project: ZephyrProject | undefined;
    if (value instanceof ZephyrProject) {
      project = value;
    } else if (value && (value as any).project) {
      project = (value as any).project;
    }
    if (project) {
      const westWorkspace = getWestWorkspace(project.westWorkspacePath);
      if (westWorkspace) {
        const shields = await getSupportedShields(westWorkspace);
        if (shields.length > 0) {
          const shieldItems: vscode.QuickPickItem[] = shields.map(shieldName => ({
            label: shieldName
          }));

          const options: vscode.QuickPickOptions = {
            title: "Select Shield",
            placeHolder: "Select a shield",
            canPickMany: false,
            ignoreFocusOut: true
          };

          const result = await vscode.window.showQuickPick(shieldItems, options);
          if (result) {
            return result.label;
          }
        } else {
          vscode.window.showInformationMessage("No shields found in the workspace.");
        }
      } else {
        vscode.window.showErrorMessage("Unable to locate the west workspace for shield selection.");
      }
    }
  }
  
  if (key === 'SNIPPETS') {
    let project: ZephyrProject | undefined;
    
    if (context instanceof ZephyrProject) {
      project = context;
    }
    else if (value instanceof ZephyrProject) {
      project = value;
    } 
    else if (value && (value as any).project) {
      project = (value as any).project;
    }
    
    if (project) {
      const westWorkspace = getWestWorkspace(project.westWorkspacePath);
      const snippets = westWorkspace ? await getSupportedSnippets(westWorkspace) : [];
      if (snippets.length > 0) {
        const snippetItems: vscode.QuickPickItem[] = snippets.map(snippetName => ({
          label: snippetName
        }));

        const options: vscode.QuickPickOptions = {
          title: "Select Snippet",
          placeHolder: "Select a snippet",
          canPickMany: false,
          ignoreFocusOut: true
        };

        const result = await vscode.window.showQuickPick(snippetItems, options);
        if (result) {
          return result.label;
        }
      } else {
        vscode.window.showInformationMessage("No snippets found in the workspace. Please make sure you have generated the west workspace correctly.");
      }
    }
    return undefined;
  }
  class BrowseButton implements vscode.QuickInputButton {
    constructor(public iconPath: vscode.ThemeIcon, public tooltip: string) { }
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
        if (key.endsWith('_FILE')) {
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

/**
 * Toggle the sysbuild flag in the build configuration.
 *
 * @param workspaceFolder The workspace folder in which to update the configuration.
 * @param key The configuration key (e.g. "zephyr-workbench") under which the settings are stored.
 * @param buildConfigName (Optional) The name of the build configuration. If not provided, the active configuration is used.
 * @param enabled A boolean indicating whether to enable or disable sysbuild.
 * @param project An instance of your ZephyrProject which holds the build configurations.
 */
export async function toggleSysbuild(
  workspaceFolder: vscode.WorkspaceFolder,
  key: string,
  enabled: boolean,
  project: ZephyrProject,
  buildConfigName?: string | undefined,
): Promise<void> {
  const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(key, workspaceFolder.uri);

  const buildConfigs = config.get<any[]>('build.configurations') || [];

  let targetConfig;
  if (buildConfigName) {
    targetConfig = project.getBuildConfiguration(buildConfigName);
  } else {
    for (let cfg of project.configs) {
      if (cfg.active === true) {
        targetConfig = cfg;
        break;
      }
    }
    // Fallback: if none are marked active but there is at least one configuration,
    // pick the first one.
    if (!targetConfig && project.configs.length > 0) {
      targetConfig = project.configs[0];
    }
  }

  if (targetConfig) {
    // Update the sysbuild property as a string "true" or "false"
    //targetConfig.sysbuild = enabled ? "true" : "false";

    // Since updating nested properties isn’t directly supported by the VS Code API,
    // update the entire build.configurations array.
    //await config.update('build.configurations', buildConfigs, vscode.ConfigurationTarget.WorkspaceFolder);
    await saveConfigSetting(workspaceFolder, targetConfig.name, key, enabled ? "true" : "false");
  }
}
