import * as vscode from 'vscode';

import { findConfigTask } from '../utils';
import { getTerminalDefaultProfile } from '../execUtils';
import { ZephyrApplication } from '../../models/ZephyrApplication';

/**
 * Run the West Build task before a debug session, mirroring what the cppdbg
 * provider does (same terminal-profile guard). Shared by the cortex-debug and
 * zephyr-workbench providers; the cppdbg provider keeps its own private copy
 * untouched.
 */
export async function runWestBuildPreLaunch(project: ZephyrApplication, buildConfigName: string): Promise<void> {
  const westBuildTask = await findConfigTask('West Build', project, buildConfigName);
  const profile = getTerminalDefaultProfile();
  if (!profile && westBuildTask) {
    await vscode.tasks.executeTask(westBuildTask);
  }
}
