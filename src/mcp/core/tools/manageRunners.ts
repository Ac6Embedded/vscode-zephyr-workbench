// manage_runners: install and configure the host tools behind the flash and
// debug runners, as the Install Runners panel and the pyOCD Manager do. What
// is installed is read with list_runners; removing pyOCD packs is a
// remove_or_delete action, so this tool never deletes.

import { z } from 'zod';
import { ToolMeta } from '../toolSpec';
import { appPath, configName, dryRun, listEdit, waitSec } from './shared';

export const MANAGE_RUNNERS_ACTIONS = [
  'install', 'set_path', 'set_default', 'set_add_to_path', 'extra_paths', 'pyocd_update_index', 'pyocd_install_pack',
] as const;
export type ManageRunnersAction = typeof MANAGE_RUNNERS_ACTIONS[number];

export const MANAGE_RUNNERS: ToolMeta = {
  name: 'manage_runners',
  title: 'Install and configure runners',
  summary: 'Installs and configures the flash and debug runners, such as OpenOCD, J-Link and pyOCD, as the Install Runners panel does.',
  description: [
    'Installs and configures the host tools behind the flash and debug runners, as the Install Runners panel and the pyOCD Manager do: install runs the workbench runner installer for tools or a vendor pack (OpenOCD variants, J-Link, pyOCD, nrfutil, nrfjprog, Simplicity Commander, USB drivers), set_path records a tool installed by hand, set_default picks the variant behind an alias such as openocd, set_add_to_path and extra_paths change what every Zephyr terminal puts on PATH, and the pyocd actions update the pack index and install the pack of a target.',
    'Call it when check_environment or list_runners reports a runner tool missing, or a flash or debug fails with RUNNER_TOOL_MISSING; read the state first with list_runners (all_tools true, or include pyocd); remove_or_delete deletes pyOCD packs in the full toolset.',
    'tools takes tool ids, aliases or runner names and pack a vendor pack; tool acts on one tool with path or add_to_path; J-Link needs accept_license true, passed only after the user accepted the SEGGER terms of use; pyocd_target names a pyOCD target, or app_path and config_name pick the target of a build.',
    'Returns a job for installs and pack downloads, else the settings as stored; the user approves each action in VS Code (J-Link every time), tools needing administrator rights raise a UAC or graphical sudo prompt, a tool only its vendor ships (STM32CubeProgrammer, LinkServer) returns its vendor page instead, and dry_run reports what would happen.',
  ].join(' '),
  inputSchema: z.object({
    action: z.enum(MANAGE_RUNNERS_ACTIONS).describe(
      'install: install tools or a pack; set_path: record or clear the path of a tool; set_default: the tool an alias such as openocd uses; set_add_to_path: whether the Zephyr environment puts a tool on PATH; extra_paths: extra folders put on PATH; pyocd_update_index: refresh the pyOCD pack index; pyocd_install_pack: install the pack of a pyOCD target.'),
    tools: z.array(z.string()).max(20).optional().describe(
      'install: tool ids, aliases or runner names from the runner manifest, such as openocd, jlink, pyocd or nrfutil, as list_runners all_tools returns them; an alias installs the variant it resolves to. An unknown name is an error that lists the valid ones.'),
    pack: z.string().optional().describe(
      'install: a vendor pack of the manifest instead of tools: stm32, nxp, nordic, silabs, esp32, infineon or ti. Its tools that do not install on this OS come back as vendor pages.'),
    tool: z.string().optional().describe(
      'set_path and set_add_to_path: a tool id or an alias such as openocd, whose variants share its path; set_default: the variant an alias uses, such as openocd-zephyr. Ids as list_runners all_tools returns them.'),
    path: z.string().optional().describe(
      'set_path: absolute existing folder of the tool as installed, the one that holds its program and goes on PATH. An empty string clears what env.yml records for the tool.'),
    add_to_path: z.boolean().optional().describe('set_add_to_path: true puts the tool on PATH in the Zephyr environment, false leaves it out.'),
    extra_paths: listEdit('absolute existing folders').optional().describe('extra_paths: folders added to PATH in the Zephyr environment.'),
    accept_license: z.boolean().optional().describe(
      'install: must be true to install J-Link, whose installer accepts the SEGGER terms of use. Ask the user before passing it.'),
    pyocd_target: z.string().optional().describe(
      'pyocd_install_pack: the pyOCD target, such as stm32f429zitx. Omit it to use the target of the board of app_path and config_name.'),
    app_path: appPath,
    config_name: configName,
    dry_run: dryRun,
    wait_sec: waitSec,
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  category: 'action',
  // Every action changes ~/.zinstaller, which every VS Code window and every
  // Zephyr terminal of the machine reads, so all of them ask as installs.
  confirm: 'install',
  routeBy: ['app_path'],
  machineScope: true,
};
