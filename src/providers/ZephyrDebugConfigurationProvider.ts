import * as vscode from 'vscode';
import { findConfigTask, getZephyrApplication } from '../utils/utils';
import { WestRunner } from '../debug/runners/WestRunner';
import { createOpenocdCfg, createWestWrapper, syncLaunchConfigurationProjectPaths } from '../utils/debugTools/debugUtils';
import { ZephyrApplication } from '../models/ZephyrApplication';
import { getTerminalDefaultProfile } from '../utils/execUtils';

export class ZephyrDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  
  async resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | null> {
    // Regenerate files to adapt in case west workspace or application
    // settings were changed.
    if (config.name.startsWith('Zephyr Workbench Debug')) {
      if(folder) {
        // West workspace applications intentionally share launch.json with the
        // workspace. Resolve through the selected application setting at launch
        // time instead of storing extension-private keys inside cppdbg entries.
        const appProject = await getZephyrApplication(folder.uri.fsPath);
        const buildConfigName = this.extractBuildConfigName(config.name);
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

  extractBuildConfigName(debugConfigName: string): string | undefined {
    const match = debugConfigName.match(/\[(.*?)\]/);
    return match ? match[1] : undefined;
  }

  async runPreLaunch(appProject: ZephyrApplication, buildConfigName: string): Promise<void> {
    let westBuildTask = await findConfigTask('West Build', appProject, buildConfigName);
    const profile = getTerminalDefaultProfile();
    if (!profile && westBuildTask) {
      await vscode.tasks.executeTask(westBuildTask);
    }
  }
}
