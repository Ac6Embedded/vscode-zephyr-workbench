// open_in_workbench: show something to the user in VS Code.

import { z } from 'zod';
import { ToolMeta } from '../toolSpec';
import { appPath, configName } from './shared';

export const OPEN_IN_WORKBENCH: ToolMeta = {
  name: 'open_in_workbench',
  title: 'Show something to the user',
  description: [
    'Opens a Zephyr Workbench view or editor in VS Code for the user to look at or act on: a file at a line, the Workbench dashboard, the Kconfig Manager, menuconfig or guiconfig in a terminal, the Devicetree Manager, the West Manager, the ECLAIR Manager or report, a Zephyr terminal, or the Add Application, Add West Workspace and Add Toolchain wizards.',
    'Use it to hand over to the user, for a choice they want to make themselves or a secret such as an IAR licence token that must never pass through the agent; never run menuconfig or guiconfig in your own shell, and change Kconfig values with set_kconfig rather than through menuconfig.',
    'target picks what to open, path with line and column name a file inside the window, app_path and config_name pick the build for the build-related targets, and west_workspace picks the workspace for west_manager and terminal.',
    'Returns what was opened without waiting for the user, who works in VS Code at their own pace; a target that needs another extension or tool that is not installed returns DEPENDENCY_MISSING.',
  ].join(' '),
  inputSchema: z.object({
    target: z.enum([
      'file', 'dashboard', 'kconfig_manager', 'menuconfig', 'guiconfig', 'devicetree_manager', 'west_manager',
      'eclair_manager', 'eclair_report', 'terminal', 'add_application', 'add_west_workspace', 'add_toolchain',
    ]).describe('What to open for the user.'),
    path: z.string().optional().describe('file only: absolute path of a file inside the folders of the window.'),
    line: z.number().int().min(1).optional().describe('file only: line to reveal, starting at 1.'),
    column: z.number().int().min(1).optional().describe('file only: column to place the cursor at, starting at 1.'),
    app_path: appPath,
    config_name: configName,
    west_workspace: z.string().optional().describe(
      'west_manager and terminal: absolute west workspace root, one of the west_workspaces[].path values get_status returns. Omit it with terminal to open the terminal of the application instead.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  category: 'editor',
  toolsets: ['core'],
  routeBy: ['app_path', 'path', 'west_workspace'],
  // The wizards take no folder, and any window can show them.
  machineScope: { add_application: true, add_west_workspace: true, add_toolchain: true },
};
