// open_in_workbench: show something to the user in VS Code.

import { z } from 'zod';
import { ToolMeta } from '../toolSpec';
import { appPath, configName } from './shared';

export const OPEN_IN_WORKBENCH_TARGETS = [
  'file', 'dashboard', 'kconfig_manager', 'menuconfig', 'guiconfig', 'devicetree_manager', 'west_manager',
  'debug_manager', 'pyocd_manager', 'install_runners', 'eclair_manager', 'eclair_report', 'terminal',
  'ram_plot', 'rom_plot', 'puncover', 'west_dashboard', 'add_application', 'add_west_workspace', 'add_toolchain',
] as const;

export const OPEN_IN_WORKBENCH: ToolMeta = {
  name: 'open_in_workbench',
  title: 'Show something to the user',
  summary: 'Opens something in VS Code for you: a file at a line, a Workbench view or manager, a memory plot, or a wizard.',
  description: [
    'Opens a Zephyr Workbench view or editor in VS Code for the user to look at or act on: a file at a line, the Workbench dashboard, the Kconfig Manager, menuconfig or guiconfig in a terminal, the Devicetree, West, Debug, pyOCD and ECLAIR Managers, the Install Runners page, the ECLAIR report, a Zephyr terminal, the RAM and ROM plots, Puncover, the West dashboard, or the Add Application, Add West Workspace and Add Toolchain wizards.',
    'Use it to hand over to the user, for a choice they want to make themselves or a secret such as an IAR licence token that must never pass through the agent; never run menuconfig or guiconfig in your own shell, and change Kconfig values with set_kconfig rather than through menuconfig.',
    'target picks what to open, path with line and column name a file inside the window, app_path and config_name pick the build for the build-related targets, and west_workspace picks the workspace for west_manager and terminal.',
    'Returns what was opened without waiting for the user; a target that needs another extension or tool that is not installed returns DEPENDENCY_MISSING.',
    'ram_plot, rom_plot, puncover and west_dashboard need a completed build without sysbuild whose Zephyr defines that west build target, and run west build -t in a VS Code terminal, and while that task runs build_app answers BUSY_EXTERNAL for the configuration.',
    'pyocd_manager with a build needs the pyOCD pack index, which manage_runners pyocd_update_index downloads.',
  ].join(' '),
  inputSchema: z.object({
    target: z.enum(OPEN_IN_WORKBENCH_TARGETS).describe(
      'What to open for the user. debug_manager and pyocd_manager open with the build configuration selected, install_runners lists the flash and debug tools to install, and ram_plot, rom_plot, puncover and west_dashboard run that west build target in a VS Code terminal.'),
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
  routeBy: ['app_path', 'path', 'west_workspace'],
  // The wizards, the Install Runners page and the bare pyOCD Manager take no
  // folder, and any window can show them. A config_name alone still needs the
  // window of its application.
  machineScope: {
    add_application: true, add_west_workspace: true, add_toolchain: true, install_runners: true,
    pyocd_manager: args => args.config_name === undefined,
  },
};
