// debug_app: run and drive a debug session of a build configuration, from
// the launch configuration configure_debug wrote. The session is the one the
// user sees in the VS Code debugger, so the agent and the user share it.

import { z } from 'zod';
import { ToolMeta } from '../toolSpec';
import { domain } from './shared';

export const DEBUG_APP_ACTIONS = ['start', 'stop', 'status', 'breakpoint', 'control', 'inspect', 'gdb'] as const;
export type DebugAppAction = typeof DEBUG_APP_ACTIONS[number];

export const DEBUG_CONTROL_COMMANDS = ['continue', 'pause', 'step_over', 'step_into', 'step_out', 'restart'] as const;
export type DebugControlCommand = typeof DEBUG_CONTROL_COMMANDS[number];

export const DEBUG_INSPECT_PARTS = ['backtrace', 'locals', 'registers', 'fault', 'threads'] as const;
export type DebugInspectPart = typeof DEBUG_INSPECT_PARTS[number];

/** The longest a start or a wait_for_stop waits, in seconds. */
export const DEBUG_WAIT_MAX_SEC = 300;
/** The most bytes one memory read returns. */
export const DEBUG_MEMORY_MAX_BYTES = 4096;

const breakpoint = z.object({
  function: z.string().optional().describe('A function to stop in, such as main. Give it, or path with line.'),
  path: z.string().optional().describe('Absolute path of an existing source file inside the folders of the window, with line.'),
  line: z.number().int().min(1).optional().describe('The line in path, starting at 1.'),
  condition: z.string().optional().describe('Stop only when this C expression is true, such as count > 3. It may only read, and cannot hold a double quote.'),
  hit_condition: z.string().optional().describe('Stop only on these hits, such as 5 or >= 10.'),
  log_message: z.string().optional().describe('Print this message in the debug console instead of stopping; {expression} is replaced by its value. With Cortex-Debug, gdb also evaluates each word after the first, so none may write or call a function.'),
}).strict();

export const DEBUG_APP: ToolMeta = {
  name: 'debug_app',
  title: 'Debug on the board',
  summary: 'Starts a debug session on the board, sets breakpoints, steps, and reads variables, registers and memory.',
  description: [
    'Runs a debug session of a build configuration in the VS Code debugger the user watches, from the entry configure_debug wrote (start makes one with the Debug Manager defaults when there is none): start flashes and halts the board or attaches, and the other actions work on a running Workbench session, including one the user started.',
    'Set breakpoints, then control with command continue and wait_for_stop to reach one, and inspect once the target is stopped; use hardware to flash without debugging and its serial actions to read the console.',
    'session_id comes from start or status and may be omitted when one session runs (app_path and config_name narrow it); breakpoint takes add, remove and clear and always lists every breakpoint; control takes command; inspect takes include, expressions and memory with frame, thread_id and depth; gdb takes text, one gdb or monitor command from an allowlist that refuses commands reaching the host.',
    'Returns the session with its state, stop reason and current frame, and for inspect the frames, variables, registers, memory bytes or a decoded Cortex-M fault; start and gdb ask the user in VS Code first, and the breakpoints the agent added apply to every session and are removed when the last Workbench session ends (stop keeps them with keep_breakpoints), or with breakpoint clear.',
  ].join(' '),
  inputSchema: z.object({
    action: z.enum(DEBUG_APP_ACTIONS).describe(
      'start: start a session; stop: end it; status: the sessions and their state; breakpoint: add, remove or list breakpoints; control: continue, pause, step or restart; inspect: read the stopped target; gdb: run one gdb or monitor command.'),
    app_path: z.string().optional().describe(
      'Absolute application root as returned by list_apps. start: the application to debug, optional when the window has one. Other actions: picks the session of this application when session_id is omitted.'),
    config_name: z.string().optional().describe(
      'start: the build configuration to debug, the active one when omitted. Other actions: with app_path, picks the session of this configuration.'),
    domain: domain.describe('start: the sysbuild domain to debug, such as mcuboot. Omit it for the default domain of a sysbuild build.'),
    name: z.string().optional().describe(
      'start: the debug entry name exactly as configure_debug list returns it, instead of config_name and domain.'),
    session_id: z.string().optional().describe(
      'Every action but start: the session_id start or status returned. Omit it when a single Workbench session runs.'),
    add: z.array(breakpoint).max(32).optional().describe(
      'breakpoint: breakpoints to add. They apply to the running session and to one started later; one already set at the same place is not added twice.'),
    remove: z.array(z.string()).max(64).optional().describe(
      'breakpoint: ids of breakpoints the agent added, as breakpoint returns them. The user\'s own breakpoints cannot be removed.'),
    clear: z.boolean().optional().describe(
      'breakpoint: remove every breakpoint the agent added. The user\'s own breakpoints stay.'),
    command: z.enum(DEBUG_CONTROL_COMMANDS).optional().describe(
      'control: continue, pause, step_over, step_into, step_out, or restart the program from its reset. A step needs a stopped target.'),
    wait_for_stop: z.boolean().optional().describe(
      'start and control: wait until the target stops, at a breakpoint, a step, a fault or a pause, before answering. Defaults to true for start, pause, restart and the steps, false for continue.'),
    wait_sec: z.number().int().min(0).max(DEBUG_WAIT_MAX_SEC).optional().describe(
      'start and control: how long wait_for_stop waits, in seconds. Defaults to the workbench setting, normally 45; a target still running then is reported as running.'),
    include: z.array(z.enum(DEBUG_INSPECT_PARTS)).optional().describe(
      'inspect: backtrace (the frames), locals (arguments and local variables of frame), registers, fault (the Cortex-M fault registers decoded, with the backtrace) and threads (Zephyr threads, when the build has CONFIG_DEBUG_THREAD_INFO=y). Defaults to backtrace and locals when neither expressions nor memory is given.'),
    expressions: z.array(z.string()).max(20).optional().describe(
      'inspect: C expressions to evaluate in frame, such as my_struct.field or *ptr. An expression that fails reports its error alone; one that would write memory or call a function is refused, since the gdb action does that and asks first.'),
    memory: z.object({
      address: z.string().describe('Start address, such as 0x20000000, or an expression gdb evaluates to an address, such as &buffer.'),
      length: z.number().int().min(1).max(DEBUG_MEMORY_MAX_BYTES).describe(`Bytes to read, at most ${DEBUG_MEMORY_MAX_BYTES}.`),
    }).strict().optional().describe('inspect: a memory range to read, returned as hex bytes with its start address.'),
    frame: z.number().int().min(0).optional().describe('inspect: the frame to read, 0 being the innermost. Defaults to 0.'),
    thread_id: z.number().int().optional().describe('inspect and control: the thread, as threads or the stop returns it. Defaults to the thread that stopped.'),
    depth: z.number().int().min(0).max(3).optional().describe('inspect: how many levels of structures and arrays to expand in locals and expressions. Defaults to 1.'),
    text: z.string().max(500).optional().describe(
      'gdb: one gdb command, such as info registers, p/x var, x/8xw 0x20000000, bt, set var x = 1 or monitor reset halt. Commands that reach the host, such as shell, python, source, dump, set logging or $_shell, are refused, as are monitor commands other than reset, halt, resume and target memory or register reads and writes, and anything with a newline or ";".'),
    keep_breakpoints: z.boolean().optional().describe('stop: keep the breakpoints the agent added for the next session. Without it they are removed once no other Workbench session runs. Defaults to false.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  category: 'action',
  // start flashes the board, and a gdb command can write its memory or reset
  // it. inspect and breakpoint refuse expressions that would write or call.
  confirm: { start: 'hardware', gdb: 'hardware' },
  routeBy: ['app_path'],
};
