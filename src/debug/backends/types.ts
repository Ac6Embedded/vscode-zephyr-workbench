/**
 * Shared declarations for the Debug Manager backends.
 *
 * The Debug Manager writes ONE launch configuration per application/build
 * config (named by `getDebugLaunchConfigurationName`) whose `type` encodes the
 * selected backend:
 *   - `cppdbg`           — historical pipeline (west wrapper + cpptools)
 *   - `zephyr-workbench` — cortex-debug via a directly spawned `west debugserver`
 *   - `cortex-debug`     — native cortex-debug servers (J-Link / ST-LINK)
 */

export type DebugBackendId = 'cppdbg' | 'cortex-west' | 'cortex-native';

export type CortexNativeServer = 'jlink' | 'stlink';

export type GdbMode = 'program' | 'attach';

/** Debug type contributed in package.json for the cortex-west backend. */
export const ZW_DEBUG_TYPE = 'zephyr-workbench';

/**
 * Session <-> spawned-server correlation key. The `__` prefix makes VS Code
 * treat it as transient so it can never be persisted into launch.json.
 */
export const ZW_SERVER_TOKEN_KEY = '__zwServerToken';

export const DEFAULT_SERVER_READY_TIMEOUT_MS = 15000;

/**
 * Default GDB server ports per west runner, from the Zephyr runner sources
 * (jlink.py DEFAULT_JLINK_GDB_PORT, openocd.py/pyocd.py GDB defaults,
 * ST-LINK_gdbserver's factory default).
 */
export const RUNNER_DEFAULT_GDB_PORT: Record<string, string> = {
  jlink: '2331',
  openocd: '3333',
  pyocd: '3333',
  linkserver: '3333',
  stlink_gdbserver: '61234',
};

export function getDefaultGdbPort(runnerName: string | undefined): string {
  return (runnerName && RUNNER_DEFAULT_GDB_PORT[runnerName]) || '3333';
}

/** West runner names offered by the cortex-native backend. */
export const CORTEX_NATIVE_RUNNER_NAMES = ['jlink', 'stlink_gdbserver'] as const;

export function runnerNameToNativeServer(runnerName: string | undefined): CortexNativeServer | undefined {
  switch (runnerName) {
    case 'jlink':
      return 'jlink';
    case 'stlink_gdbserver':
      return 'stlink';
    default:
      return undefined;
  }
}

export function nativeServerToRunnerName(server: CortexNativeServer | undefined): string | undefined {
  switch (server) {
    case 'jlink':
      return 'jlink';
    case 'stlink':
      return 'stlink_gdbserver';
    default:
      return undefined;
  }
}

/** Fields common to every cortex-debug configuration the backends emit. */
export interface CortexConfigInput {
  name: string;
  cwd: string;
  programPath: string;
  svdPath?: string;
  gdbPath?: string;
  gdbMode: GdbMode;
}

export interface CortexWestInput extends CortexConfigInput {
  gdbAddress: string;
  gdbPort: string;
}

export interface CortexNativeInput extends CortexConfigInput {
  server: CortexNativeServer;
  device?: string;
  interface?: 'swd' | 'jtag';
  /** GDB server executable (cortex-debug `serverpath`). */
  serverPath?: string;
  /** Free-text extra server arguments (tokenized into `serverArgs`). */
  serverArgs?: string;
  /** STM32CubeProgrammer bin directory (stlink only). */
  stm32CubeProgrammerDir?: string;
}
