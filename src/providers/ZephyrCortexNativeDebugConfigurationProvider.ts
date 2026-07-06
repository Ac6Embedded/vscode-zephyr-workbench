import * as vscode from 'vscode';
import path from 'path';

import { getZephyrApplication } from '../utils/utils';
import {
  ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME,
  extractDebugBuildConfigName,
  extractWorkspaceApplicationPathFromDebugConfigName,
  syncLaunchConfigurationProjectPaths,
} from '../utils/debugTools/debugUtils';
import { runWestBuildPreLaunch } from '../utils/debugTools/debugPreLaunch';
import { ZW_SERVER_TOKEN_KEY } from '../debug/backends/types';

/**
 * Pre-launch parity for the native cortex-debug backend: the entries the
 * Debug Manager writes with `type: "cortex-debug"` get the same West Build
 * pre-launch task and generated-path re-sync the cppdbg provider performs.
 *
 * Scoped strictly to our own entries by the config-name prefix; every other
 * cortex-debug configuration (user-authored) passes through untouched. The
 * transient server token marks runtime configs produced by the
 * zephyr-workbench provider, which already ran this work.
 */
export class ZephyrCortexNativeDebugConfigurationProvider implements vscode.DebugConfigurationProvider {

  async resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration> {
    if (
      config.type !== 'cortex-debug'
      || typeof config.name !== 'string'
      || !config.name.startsWith(ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME)
      || config[ZW_SERVER_TOKEN_KEY]
      || !folder
    ) {
      return config;
    }

    try {
      const workspaceApplicationPath = extractWorkspaceApplicationPathFromDebugConfigName(config.name);
      const project = await getZephyrApplication(workspaceApplicationPath
        ? path.join(folder.uri.fsPath, workspaceApplicationPath)
        : folder.uri.fsPath);
      const buildConfigName = extractDebugBuildConfigName(config.name);
      syncLaunchConfigurationProjectPaths(config, project, buildConfigName);
      if (buildConfigName) {
        await runWestBuildPreLaunch(project, buildConfigName);
      }
    } catch (error) {
      // Never block a cortex-debug session on our pre-launch conveniences.
      console.error('Zephyr Workbench: cortex-debug pre-launch preparation failed', error);
    }

    return config;
  }
}
