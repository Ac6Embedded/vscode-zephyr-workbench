// run_command: run a command line in the Zephyr environment of an
// application or a west workspace, for what no other tool covers. It runs as
// a job in a terminal the user watches, never in the agent's hidden shell.

import { z } from 'zod';
import { ToolMeta } from '../toolSpec';
import { appPath, configName, waitSec } from './shared';

export const RUN_COMMAND_ACTIONS = ['run', 'env'] as const;
export type RunCommandAction = typeof RUN_COMMAND_ACTIONS[number];

export const RUN_COMMAND_SHELLS = ['bash', 'zsh', 'powershell', 'cmd'] as const;
export type RunCommandShell = typeof RUN_COMMAND_SHELLS[number];

/** The longest a command may run, in seconds. */
export const RUN_COMMAND_TIMEOUT_MAX_SEC = 3600;
export const RUN_COMMAND_TIMEOUT_DEFAULT_SEC = 600;
export const RUN_COMMAND_MAX_CHARS = 4000;

export const RUN_COMMAND: ToolMeta = {
  name: 'run_command',
  title: 'Run a command in the Zephyr environment',
  summary: 'Runs a command line in the Zephyr environment of an application or west workspace, in a terminal you can watch.',
  description: [
    'Runs one command line with the environment of the Zephyr terminal of an application or a west workspace (west workspace and build configuration variables, SDK and toolchain, Python virtual environment, environment script sourced) as a job in a VS Code terminal the user watches; action env instead writes a script that sets up the same environment and then runs its arguments, for your own shell.',
    'Use it only for what no other tool covers, such as a west command without a tool of its own, a vendor command line tool or a Python script: flash with hardware, debug with debug_app and update with manage_west_workspace, and never run menuconfig or guiconfig, which wait for a keyboard; those commands are refused. Build with build_app: a build here is refused while a job or a VS Code task uses its build folder.',
    'app_path with config_name, or west_workspace, picks the environment and the working folder (the build folder when it exists, else the application or workspace root), cwd changes it within the folders of the window, timeout_sec (default 600) stops the command, and shell picks the kind of script env writes.',
    'run returns a job with the exit code, the tail of the output and result.shell, result.cwd and result.timed_out, read further with job action log; the command gets no keyboard input, so anything that prompts ends, and the user approves each command in VS Code first.',
    'env returns the script path, a usage example and the names of the variables it sets, and runs nothing.',
  ].join(' '),
  inputSchema: z.object({
    action: z.enum(RUN_COMMAND_ACTIONS).describe(
      'run: run command as a job; env: write and return a script that runs a command in the same environment from your own shell.'),
    command: z.string().max(RUN_COMMAND_MAX_CHARS).optional().describe(
      `run: the command line, at most ${RUN_COMMAND_MAX_CHARS} characters, in the syntax of the shell VS Code uses for terminals, which env and every result name as shell (bash, zsh, powershell or cmd), such as west boards or python scripts/gen.py. With cmd it must be a single line.`),
    app_path: appPath,
    config_name: configName,
    west_workspace: z.string().optional().describe(
      'Absolute west workspace root, one of the west_workspaces[].path values get_status returns, for its environment instead of an application\'s. Cannot be combined with app_path.'),
    cwd: z.string().optional().describe(
      'run: absolute working folder inside the folders of the window. Defaults to the build folder when it exists, else the application or west workspace root.'),
    timeout_sec: z.number().int().min(1).max(RUN_COMMAND_TIMEOUT_MAX_SEC).optional().describe(
      `run: stop the command after this many seconds. Defaults to ${RUN_COMMAND_TIMEOUT_DEFAULT_SEC}.`),
    wait_sec: waitSec,
    shell: z.enum(RUN_COMMAND_SHELLS).optional().describe(
      'env: the shell the script is for. Defaults to the shell VS Code uses for terminals.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  category: 'action',
  // A command the agent wrote can do anything the user can, so it always asks
  // under the core preset. env only writes a script and runs nothing.
  confirm: { run: 'command' },
  routeBy: ['app_path', 'west_workspace', 'cwd'],
};
