// configure_debug: the Debug Manager for agents. It writes the launch
// configuration the Debug Manager's Apply writes, and reads the existing ones;
// debug_app runs what it wrote.

import { z } from 'zod';
import { ToolMeta } from '../toolSpec';
import { appPath, domain, dryRun } from './shared';

export const CONFIGURE_DEBUG_ACTIONS = ['list', 'get', 'apply'] as const;
export type ConfigureDebugAction = typeof CONFIGURE_DEBUG_ACTIONS[number];

/** The Debug Manager's backends: the C/C++ extension, or Cortex-Debug with the server started by west or by itself. */
export const DEBUG_BACKENDS = ['cppdbg', 'cortex-west', 'cortex-native'] as const;
export type DebugBackend = typeof DEBUG_BACKENDS[number];

export const CONFIGURE_DEBUG: ToolMeta = {
  name: 'configure_debug',
  title: 'Set up debugging',
  summary: 'Creates or updates the debug configuration of a build as the Debug Manager does, and lists the existing ones.',
  description: [
    'Writes the debug launch configuration of a build configuration as the Apply button of the Debug Manager does: the launch.json entry named "Zephyr Workbench Debug ...", plus the west wrapper (cppdbg backend) and the OpenOCD gdb.cfg in the build folder; list and get read the Workbench entries of an application, marking those whose build configuration no longer exists.',
    'Call it before debug_app when list shows no entry for the configuration, or to change the runner, backend, gdb port or mode; it needs a build, so call build_app first, install a missing runner tool with manage_runners, and remove stale entries with remove_or_delete what debug_config in the full toolset, else ask the user.',
    'Every apply argument defaults to the stored entry, else to what the Debug Manager deduces from the build (another runner, or a switch to or from cortex-native, starts runner_path, runner_args and gdb_port from the defaults): runner takes debug runners only (openocd, jlink, pyocd, linkserver, stlink_gdbserver), backend defaults to cppdbg, the program, gdb and SVD paths come from the build, domain picks a sysbuild image, and dry_run returns the entry without writing or asking.',
    'Returns the entry as launch.json holds it with its Debug Manager fields, the files written and warnings, such as a runner tool not found or a pyOCD target pack to install first; nothing is flashed and no session starts.',
  ].join(' '),
  inputSchema: z.object({
    action: z.enum(CONFIGURE_DEBUG_ACTIONS).describe(
      'list: the debug entries of the application, marking those whose build configuration no longer exists; get: one entry with its Debug Manager fields; apply: create or update the entry of a build configuration.'),
    app_path: appPath,
    config_name: z.string().optional().describe(
      'The build configuration. Omit it to use the active one; with list it keeps only the entries of that name, which may be a configuration that no longer exists.'),
    domain,
    name: z.string().optional().describe(
      'get: the entry name exactly as list returns it. Omit it to get the entry of app_path, config_name and domain.'),
    runner: z.string().optional().describe(
      'apply: the debug runner, one of openocd, jlink, pyocd, linkserver or stlink_gdbserver (cortex-native takes jlink or stlink_gdbserver). Defaults to the runner of the stored entry, then to the debug runner the build\'s runners.yaml names, then to the first debug runner it lists. Flash-only runners and emulators are refused.'),
    backend: z.enum(DEBUG_BACKENDS).optional().describe(
      'apply: cppdbg (the C/C++ extension with west debugserver, the default), cortex-west (Cortex-Debug with west debugserver) or cortex-native (Cortex-Debug starting J-Link or ST-LINK itself). The Cortex-Debug backends need the Cortex-Debug extension.'),
    mode: z.enum(['program', 'attach']).optional().describe(
      'apply: program flashes the image when the session starts, the default; attach connects to what the board runs without flashing it.'),
    program_path: z.string().optional().describe('apply: absolute path of the ELF to debug. Defaults to the zephyr.elf of the build or of its domain.'),
    gdb_path: z.string().optional().describe('apply: absolute path of the gdb to use. Defaults to the gdb the build\'s toolchain provides.'),
    svd_path: z.string().optional().describe('apply: absolute path of an SVD file for the peripheral view. Defaults to the one found for the board, if any.'),
    gdb_address: z.string().optional().describe('apply: the host name or IPv4 address the gdb server listens on. Defaults to localhost. Not taken by cortex-native.'),
    gdb_port: z.number().int().min(1).max(65535).optional().describe(
      'apply: the port of the gdb server. Defaults to the stored port of the same runner, else 3333 for cppdbg, which west passes to every runner, and the runner\'s usual port for cortex-west, such as 2331 for J-Link. Not taken by cortex-native.'),
    runner_path: z.string().optional().describe(
      'apply: absolute path of the runner program, such as JLinkGDBServerCL or openocd, when it is not the one the workbench found. An empty string clears it.'),
    runner_args: z.string().optional().describe(
      'apply: extra arguments for west debugserver, or for the server cortex-native starts, such as --tool-opt=... . Shell operators are refused. An empty string clears them.'),
    device: z.string().optional().describe('apply, backend cortex-native: the device name, such as nRF52840_xxAA, which J-Link requires. Defaults to the one detected for the board.'),
    interface: z.enum(['swd', 'jtag']).optional().describe('apply, backend cortex-native: the debug interface. Defaults to swd.'),
    dry_run: dryRun,
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  category: 'config',
  // list and get only read. apply writes launch.json and files in the build
  // folder, the same kind of change configure makes.
  confirm: { apply: 'settings' },
  routeBy: ['app_path'],
};
