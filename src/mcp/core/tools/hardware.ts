// hardware: everything that touches a connected board. It holds the catalog's
// last slot, so it is one tool with an action; each family of actions (serial
// and flash now, run and debug later) has a handler module of its own.

import { z } from 'zod';
import { ToolMeta } from '../toolSpec';
import { BAUD_MAX, BAUD_MIN, DURATION_MAX_SEC, LINE_ENDINGS, READ_MAX_CHARS, SEND_MAX_CHARS } from '../serialArgs';
import { appPath, configName, waitSec } from './shared';

export const HARDWARE_ACTIONS = ['flash', 'list_ports', 'serial_start', 'serial_read', 'serial_send', 'serial_stop'] as const;
export type HardwareAction = typeof HARDWARE_ACTIONS[number];

export const HARDWARE: ToolMeta = {
  name: 'hardware',
  title: 'Flash and serial console of a board',
  summary: 'Flashes a connected board with west flash, and reads its serial console or sends it a line such as a shell command.',
  description: [
    'Works with a connected board: flash runs west flash on the build of app_path and config_name as a job the user watches in a VS Code terminal, list_ports lists the serial ports without opening them, serial_start opens one as a capture job, serial_read returns the captured text, serial_send writes a line such as a Zephyr shell command, and serial_stop closes the port.',
    'Start a capture before flashing or resetting the board or its boot messages are lost, then flash with wait_for to wait for a boot line; flash and serial_send ask the user in VS Code first, and a port opens in one program at a time, so a serial monitor holding it makes serial_start fail with BUSY_EXTERNAL.',
    'flash uses runner, else the default runner of the configuration, else the board\'s (list_runners lists them), with runner_args, domain, erase, dev_id and rebuild; port and baud_rate default to the USB port matching the board and the console speed in the devicetree, wait_for with wait_sec waits for a line of output, offset and max_chars page through it, and duration_sec ends a capture on its own.',
    'flash returns its job with the runner and where it came from, serial_start the capture job with port, baud_rate and next_offset for the next serial_read; job action log reads the same text, where lines starting with "--- serial:" are messages of the capture, not device output.',
  ].join(' '),
  inputSchema: z.object({
    action: z.enum(HARDWARE_ACTIONS).describe(
      'flash: write the build to the board with west flash, after asking the user; list_ports: list the serial ports; serial_start: open a port and capture it; serial_read: read the captured output; serial_send: write a line to the board, after asking the user; serial_stop: end a capture.'),
    app_path: appPath.describe(
      'Absolute application root as returned by list_apps. flash: the application to flash. list_ports and serial_start: its board picks the port and its last build gives the console speed. serial_read, serial_send and serial_stop: picks the capture serial_start made for it. Omit it when the window has a single application, or to go by the ports alone.'),
    config_name: configName.describe(
      'With app_path: the build configuration to flash, or whose board and devicetree are used. Omit it to use the active configuration.'),
    runner: z.string().optional().describe(
      'flash: the west runner, such as jlink, openocd or pyocd, one of those list_runners returns for the build. Defaults to the default runner of the configuration, else the flash runner of the board in the build\'s runners.yaml.'),
    runner_args: z.string().optional().describe(
      'flash: extra options of the runner, appended to west flash, such as --tool-opt=... The configuration\'s own runner_args come first when the runner is its default one. No shell operator, and no option this action has an argument for (runner, domain, erase, dev_id, rebuild). Pass a tool option that starts with - as --tool-opt=VALUE, never as a separate word.'),
    domain: z.string().optional().describe(
      'flash: the sysbuild domain to flash, such as mcuboot. Omit it to flash every image of a sysbuild build in its flash order. An unknown domain, or one given for a build without sysbuild, is an error that lists the valid names.'),
    erase: z.boolean().optional().describe(
      'flash: erase the whole flash of the chip first (--erase). On a sysbuild build it needs domain, so an erase for one image cannot wipe the others such as MCUboot. Defaults to false.'),
    dev_id: z.string().optional().describe(
      'flash: serial number of the probe to use when several boards are connected, usually the serial_number list_ports gives for its port. Passed as --dev-id, as --serial plus the command adapter serial to openocd, and as --probe to linkserver.'),
    rebuild: z.boolean().optional().describe(
      'flash: false flashes the last build as it is, without letting west rebuild it first. Defaults to true, where west rebuilds when a source changed, as build_app would.'),
    dry_run: z.boolean().optional().describe(
      'flash: check everything and return the west flash command that would run, without asking the user or flashing.'),
    port: z.string().optional().describe(
      'serial_start: the port to open, exactly as list_ports returns it, such as /dev/ttyACM0, /dev/cu.usbmodem14203 or COM3; any other name is refused. serial_read, serial_send and serial_stop: the port of a capture, instead of job_id.'),
    baud_rate: z.number().int().min(BAUD_MIN).max(BAUD_MAX).optional().describe(
      'serial_start: the speed in baud. Defaults to the current-speed of the console in the build\'s devicetree, else 115200.'),
    duration_sec: z.number().int().min(1).max(DURATION_MAX_SEC).optional().describe(
      'serial_start: stop the capture by itself after this many seconds. Defaults to 600.'),
    job_id: z.string().optional().describe(
      'serial_read, serial_send and serial_stop: the job_id serial_start returned. Omit it and port when a single capture runs.'),
    offset: z.number().int().min(0).optional().describe(
      'serial_read: byte offset in the captured output to read from, the next_offset of the previous answer. Defaults to 0, the start of the capture.'),
    max_chars: z.number().int().min(1).max(READ_MAX_CHARS).optional().describe(
      'serial_read: maximum characters of output to return. Defaults to 8000.'),
    grep: z.string().optional().describe(
      'serial_read: return only the lines after offset containing this text, case-insensitive; * matches any run of characters. Not a regular expression.'),
    wait_for: z.string().optional().describe(
      'serial_start, serial_read, serial_send and flash: wait until a line of device output contains this text (case-insensitive, * matches any run of characters, not a regular expression): output since the capture started, after offset, after the text sent, or after the flash, in the running capture of the application. The answer says whether it matched and where.'),
    wait_sec: waitSec.describe(
      'How long wait_for waits, in seconds. Defaults to the workbench setting, normally 45, which keeps the call under the 60 second timeout most agents use. flash: how long the call waits for the flash job, then for wait_for, before returning the job. serial_read without wait_for waits this long for any new output, and not at all by default.'),
    text: z.string().max(SEND_MAX_CHARS).optional().describe(
      `serial_send: the line to send, at most ${SEND_MAX_CHARS} characters, with no control character other than tab and no invisible formatting character. The Zephyr shell echoes it back.`),
    line_ending: z.enum(LINE_ENDINGS).optional().describe(
      'serial_send: what ends the line: crlf (the default, which the Zephyr shell and most firmware accept), lf, cr, or none.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  category: 'action',
  // Flashing replaces the firmware of the board, and writing to a board can
  // run any shell command on it.
  confirm: { serial_send: 'hardware', flash: 'hardware' },
  maxResultChars: 60000,
  routeBy: ['app_path'],
  // Ports belong to the machine, not to a folder, so any window may answer.
  // A job_id sends the call to the window running that capture, and a window
  // without the capture refuses rather than acting on something else. A flash
  // goes to the window holding the application, which has its build.
  machineScope: { flash: false, list_ports: true, serial_start: true, serial_read: true, serial_send: true, serial_stop: true },
};
