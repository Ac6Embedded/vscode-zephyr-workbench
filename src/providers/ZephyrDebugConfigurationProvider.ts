import * as vscode from 'vscode';
import path from 'path';
import { findConfigTask, getZephyrApplication } from '../utils/utils';
import { WestRunner } from '../debug/runners/WestRunner';
import { createOpenocdCfg, createWestWrapper, extractDebugBuildConfigName, extractWorkspaceApplicationPathFromDebugConfigName, syncLaunchConfigurationProjectPaths } from '../utils/debugTools/debugUtils';
import { ZephyrApplication } from '../models/ZephyrApplication';
import { getTerminalDefaultProfile } from '../utils/execUtils';

export class ZephyrDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  
  async resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | null> {
    // Regenerate files to adapt in case west workspace or application
    // settings were changed.
    if (config.name.startsWith('Zephyr Workbench Debug')) {
      if(folder) {
        const workspaceApplicationPath = extractWorkspaceApplicationPathFromDebugConfigName(config.name);
        // Workspace-app launch configurations include the app path in their
        // name because they all live in the west workspace launch.json. Resolve
        // that explicit app path first so launching from VS Code's Run dropdown
        // does not depend on whichever app is currently selected.
        const appProject = await getZephyrApplication(workspaceApplicationPath
          ? path.join(folder.uri.fsPath, workspaceApplicationPath)
          : folder.uri.fsPath);
        const buildConfigName = extractDebugBuildConfigName(config.name);
        const runnerName = WestRunner.extractRunner(config.debugServerArgs);
        syncLaunchConfigurationProjectPaths(config, appProject, buildConfigName);

        // Run tasks required before debug
        if(buildConfigName) {
          await this.runPreLaunch(appProject, buildConfigName);
        }
        
        // Create required files for debug
        createWestWrapper(appProject, buildConfigName);
        switch(runnerName) {
          case 'openocd': 
            createOpenocdCfg(appProject);
            break;
          case 'pyocd':
            // Assume target was already installed from "Debug Manager"
            break;
          default:
            break;
        }
      }
    }
    return config;
  }

  async runPreLaunch(appProject: ZephyrApplication, buildConfigName: string): Promise<void> {
    let westBuildTask = await findConfigTask('West Build', appProject, buildConfigName);
    const profile = getTerminalDefaultProfile();
    if (!profile && westBuildTask) {
      await vscode.tasks.executeTask(westBuildTask);
    }
  }
}
