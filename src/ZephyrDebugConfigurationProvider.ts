import * as vscode from 'vscode';
import { getZephyrProject } from './utils';
import { WestRunner } from './debug/runners/WestRunner';
import { createOpenocdCfg, createWestWrapper } from './debugUtils';

export class ZephyrDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  
  async resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | null> {
    // Regenerate files to adapt in case west workspace or application
    // settings were changed.
    if (config.name === 'Zephyr Workbench Debug') {
      if(folder) {
        const appProject = await getZephyrProject(folder.uri.fsPath);
        const runnerName = WestRunner.extractRunner(config.debugServerArgs);
        createWestWrapper(appProject);
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
}