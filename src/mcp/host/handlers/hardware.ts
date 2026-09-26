// hardware: one tool for everything that touches a connected board,
// dispatched on `action` to the module of its family (hardwareSerial.ts for
// the serial console; flash, run and debug get modules of their own). Each
// action accepts only its own arguments, so a misplaced one is refused instead
// of silently ignored.

import { McpToolError } from '../../core/errors';
import { logSafe } from '../../core/redact';
import { HARDWARE_ACTIONS, HardwareAction } from '../../core/tools/hardware';
import { ToolContext, ToolHandler } from '../../core/toolSpec';
import { HostDeps } from './deps';
import { listSerialPorts, serialRead, serialSend, serialStart, serialStop } from './hardwareSerial';

type Ctx = ToolContext<HostDeps>;

const ROUTES: Readonly<Record<HardwareAction, {
  args: readonly string[];
  run(args: Record<string, unknown>, ctx: Ctx): Promise<unknown>;
}>> = {
  list_ports: { args: ['app_path', 'config_name'], run: listSerialPorts },
  serial_start: { args: ['app_path', 'config_name', 'port', 'baud_rate', 'duration_sec', 'wait_for', 'wait_sec'], run: serialStart },
  // app_path also picks the window, and that application's capture.
  serial_read: { args: ['job_id', 'port', 'app_path', 'config_name', 'offset', 'max_chars', 'grep', 'wait_for', 'wait_sec'], run: serialRead },
  serial_send: { args: ['job_id', 'port', 'app_path', 'config_name', 'text', 'line_ending', 'wait_for', 'wait_sec'], run: serialSend },
  serial_stop: { args: ['job_id', 'port', 'app_path', 'config_name'], run: serialStop },
};

export const hardware: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const action = typeof args.action === 'string' ? args.action : '';
  const route = Object.prototype.hasOwnProperty.call(ROUTES, action) ? ROUTES[action as HardwareAction] : undefined;
  if (!route) {
    throw new McpToolError('INVALID_ARGUMENT', `action must be one of ${HARDWARE_ACTIONS.join(', ')}, not "${logSafe(action, 40)}".`);
  }
  const accepted = new Set(['action', ...route.args]);
  const unexpected = Object.keys(args).filter(key => args[key] !== undefined && !accepted.has(key));
  if (unexpected.length > 0) {
    throw new McpToolError('INVALID_ARGUMENT', `action "${action}" does not take ${unexpected.join(', ')}.`, {
      details: { accepted: [...accepted] },
    });
  }
  return route.run(args, ctx);
};
