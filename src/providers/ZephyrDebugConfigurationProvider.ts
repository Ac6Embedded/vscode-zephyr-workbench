import * as vscode from 'vscode';
import { findConfigTask, getZephyrApplication } from '../utils/utils';
import { WestRunner } from '../debug/runners/WestRunner';
import { createOpenocdCfg, createWestWrapper, ZEPHYR_WORKBENCH_DEBUG_APP_ROOT_KEY } from '../utils/debugTools/debugUtils';
import { ZephyrApplication } from '../models/ZephyrApplication';
import { getTerminalDefaultProfile } from '../utils/execUtils';

export class ZephyrDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  
  async resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | null> {
    // Regenerate files to adapt in case west workspace or application
    // settings were changed.
    if (config.name.startsWith('Zephyr Workbench Debug')) {
      if(folder) {
        // Freestanding apps are scoped by their own workspace folder. West
        // workspace apps share one folder, so launch configs generated for them
        // carry an app-root marker that keeps debug resolution aligned with the
        // selected application rather than whichever app happens to be active.
        const appRootPath = typeof config[ZEPHYR_WORKBENCH_DEBUG_APP_ROOT_KEY] === 'string'
          ? config[ZEPHYR_WORKBENCH_DEBUG_APP_ROOT_KEY]
          : folder.uri.fsPath;
        const appProject = await getZephyrApplication(appRootPath);
        const buildConfigName = this.extractBuildConfigName(config.name);
        const runnerName = WestRunner.extractRunner(config.debugServerArgs);

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
