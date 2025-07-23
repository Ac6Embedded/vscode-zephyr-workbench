import * as vscode from 'vscode';
import { findConfigTask, getZephyrProject } from './utils';
import { WestRunner } from './debug/runners/WestRunner';
import { createOpenocdCfg, createWestWrapper } from './debugUtils';
import { ZephyrProject } from './ZephyrProject';
import { ZephyrProjectBuildConfiguration } from './ZephyrProjectBuildConfiguration';
import { getTerminalDefaultProfile } from './execUtils';

export class ZephyrDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  
  async resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | null> {
    // Regenerate files to adapt in case west workspace or application
    // settings were changed.
    if (config.name.startsWith('Zephyr Workbench Debug')) {
      if(folder) {
        const appProject = await getZephyrProject(folder.uri.fsPath);
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

  async runPreLaunch(appProject: ZephyrProject, buildConfigName: string): Promise<void> {
    let westBuildTask = await findConfigTask('West Build', appProject, buildConfigName);
    const profile = getTerminalDefaultProfile();
    if (!profile && westBuildTask) {
      await vscode.tasks.executeTask(westBuildTask);
    }
  }
}