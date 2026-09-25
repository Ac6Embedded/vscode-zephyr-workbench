// Build configuration actions shared by the Applications view and the agent
// tools, so a change made from either one leaves the settings, IntelliSense
// and tasks.json in the same state (except for the tasks of other
// applications, see syncActiveBuildConfig). Nothing here shows UI: the view
// commands keep their own notifications around these calls.

import * as path from 'path';
import * as vscode from 'vscode';
import { ZephyrApplication } from '../../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../../models/ZephyrBuildConfig';
import { ZEPHYR_BUILD_CONFIG_SYSBUILD_SETTING_KEY } from '../../constants';
import { taskAppRootPath, updateTasks } from '../../providers/ZephyrTaskProvider';
import { isSelectedIntelliSenseApplication, updateBuildConfigCompileCommandsSetting } from '../intellisense/intellisenseSync';
import { getZephyrApplication } from '../utils';
import { saveApplicationConfigSetting, setActiveApplicationConfig } from './applicationSettings';
import {
  findContainingWorkspaceApplicationEntry, resolveWorkspaceApplicationPath, setSelectedWorkspaceApplicationPath,
} from './workspaceApplications';

/** The configuration used when none is named: the active one, else the first. */
export function getActiveOrDefaultBuildConfig(project: ZephyrApplication): ZephyrBuildConfig | undefined {
  return project.buildConfigs.find(config => config.active) ?? project.buildConfigs[0];
}

/**
 * Which workbench tasks in the tasks.json of `project`'s folder run for
 * `project`, decided the way ZephyrTaskProvider.resolve decides it: a task
 * that names no application runs for the selected one, and a task's appRoot
 * belongs to the workspace application that contains it.
 */
export function tasksRunningFor(project: ZephyrApplication): (task: vscode.TaskDefinition) => boolean {
  const folder = project.appWorkspaceFolder;
  const selected = isSelectedIntelliSenseApplication(project);
  return task => {
    const root = taskAppRootPath(task, folder);
    if (!root) {
      return selected;
    }
    const entry = findContainingWorkspaceApplicationEntry(folder, root);
    const owner = (entry && resolveWorkspaceApplicationPath(entry, folder)) || root;
    return path.relative(path.resolve(owner), path.resolve(project.appRootPath)) === '';
  };
}

/**
 * Point IntelliSense and the workbench tasks in tasks.json at a configuration
 * that has just become the active one. `index` is its position in the stored
 * list, which tasks.json references use.
 *
 * Only the tasks that run for `project` follow it: a west workspace shares one
 * tasks.json between its applications, and another application's task would
 * be left naming a configuration that application does not have. `allTasks`
 * moves every workbench task of the folder, as the Applications view's
 * activate command always has.
 */
export async function syncActiveBuildConfig(
  project: ZephyrApplication,
  config: ZephyrBuildConfig,
  index: number,
  options: { allTasks?: boolean } = {},
): Promise<void> {
  await updateBuildConfigCompileCommandsSetting(project, config);
  await updateTasks(project.appWorkspaceFolder, config.name, index, options.allTasks ? undefined : tasksRunningFor(project));
}

/** Make `config` the only active configuration of `project`. Returns false when it no longer exists. */
export async function activateBuildConfig(project: ZephyrApplication, config: ZephyrBuildConfig): Promise<boolean> {
  const index = await setActiveApplicationConfig(project, config.name);
  if (index === -1) {
    return false;
  }
  config.active = true;
  for (const other of project.buildConfigs) {
    if (other !== config) {
      other.active = false;
    }
  }
  // The Applications view's activate command, which keeps moving every task.
  await syncActiveBuildConfig(project, config, index, { allTasks: true });
  return true;
}

/** Turn sysbuild on or off for a configuration, and follow its compile_commands.json. */
export async function setBuildConfigSysbuild(project: ZephyrApplication, config: ZephyrBuildConfig, enabled: boolean): Promise<void> {
  config.sysbuild = enabled ? 'true' : 'false';
  await saveApplicationConfigSetting(project, config.name, ZEPHYR_BUILD_CONFIG_SYSBUILD_SETTING_KEY, config.sysbuild);
  await updateBuildConfigCompileCommandsSetting(project, config, enabled);
}

/**
 * Make an application the selected one of its west workspace, then point
 * IntelliSense at its active configuration. Pass `project` when it is already
 * resolved; otherwise it is looked up after the selection is saved, as the
 * Applications view always did.
 */
export async function selectWorkspaceApplication(
  workspaceFolder: vscode.WorkspaceFolder,
  appRootPath: string,
  project?: ZephyrApplication,
): Promise<void> {
  await setSelectedWorkspaceApplicationPath(workspaceFolder, appRootPath);
  const resolved = project ?? await getZephyrApplication(appRootPath).catch(() => undefined);
  const targetConfig = resolved ? getActiveOrDefaultBuildConfig(resolved) : undefined;
  if (resolved && targetConfig) {
    await updateBuildConfigCompileCommandsSetting(resolved, targetConfig);
  }
}
