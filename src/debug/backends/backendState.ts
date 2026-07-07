import { getGdbMode } from '../gdbUtils';
import { WestRunner } from '../runners/WestRunner';
import { getRunner, getServerAddressFromConfig } from '../../utils/debugTools/debugUtils';
import {
  CortexNativeServer,
  DebugBackendId,
  GdbMode,
  ZW_DEBUG_TYPE,
  getDefaultGdbPort,
  nativeServerToRunnerName,
} from './types';

export interface BackendSelection {
  backend: DebugBackendId;
  nativeServer?: CortexNativeServer;
}

/**
 * Derive the Debug Manager backend radio state from a stored launch entry.
 * The launch.json entry is the single source of truth: cppdbg (or anything
 * unknown, including legacy entries without a type) maps to the default
 * backend.
 */
export function getBackendFromLaunchConfig(config: any): BackendSelection {
  switch (config?.type) {
    case ZW_DEBUG_TYPE:
      return { backend: 'cortex-west' };
    case 'cortex-debug': {
      const servertype = config?.servertype;
      const nativeServer: CortexNativeServer | undefined =
        servertype === 'jlink' ? 'jlink' : servertype === 'stlink' ? 'stlink' : undefined;
      return { backend: 'cortex-native', nativeServer };
    }
    default:
      return { backend: 'cppdbg' };
  }
}

export interface NormalizedPanelState extends BackendSelection {
  programPath: string;
  svdPath: string;
  gdbPath: string;
  gdbAddress: string;
  gdbPort: string;
  gdbMode: GdbMode;
  runnerName?: string;
  /** Present for cppdbg / zephyr-workbench entries; parsed by WestRunner. */
  debugServerArgs?: string;
  /** Present for native cortex-debug entries (no debugServerArgs to parse). */
  runnerPath?: string;
  runnerArgs?: string;
  device?: string;
  deviceInterface?: 'swd' | 'jtag';
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function splitGdbTarget(gdbTarget: unknown): { address: string; port: string } | undefined {
  if (typeof gdbTarget !== 'string' || !gdbTarget.includes(':')) {
    return undefined;
  }
  const separatorIndex = gdbTarget.lastIndexOf(':');
  const address = gdbTarget.slice(0, separatorIndex).trim();
  const port = gdbTarget.slice(separatorIndex + 1).trim();
  if (!address || !port) {
    return undefined;
  }
  return { address, port };
}

/**
 * Read the Debug Manager form state out of a stored launch entry of any of the
 * three supported types. Never throws on shape mismatches — cortex entries
 * have no `setupCommands`/`debugServerArgs`, cppdbg entries have no
 * `executable`/`servertype`, and hand-edited files can hold anything.
 */
export function readPanelStateFromConfig(config: any): NormalizedPanelState {
  const selection = getBackendFromLaunchConfig(config);

  if (selection.backend === 'cortex-native') {
    const runnerName = nativeServerToRunnerName(selection.nativeServer);
    return {
      ...selection,
      programPath: asString(config?.executable),
      svdPath: asString(config?.svdFile),
      gdbPath: asString(config?.gdbPath),
      gdbAddress: 'localhost',
      gdbPort: getDefaultGdbPort(runnerName),
      gdbMode: config?.request === 'attach' ? 'attach' : 'program',
      runnerName,
      runnerPath: asString(config?.serverpath),
      // Re-quote whitespace-bearing tokens so the free-text field round-trips
      // through the tokenizer without splitting them.
      runnerArgs: Array.isArray(config?.serverArgs)
        ? config.serverArgs
          .filter((token: unknown): token is string => typeof token === 'string')
          .map((token: string) => (/\s/.test(token) ? `"${token}"` : token))
          .join(' ')
        : '',
      device: asString(config?.device),
      deviceInterface: config?.interface === 'jtag' ? 'jtag' : 'swd',
    };
  }

  if (selection.backend === 'cortex-west') {
    const target = splitGdbTarget(config?.gdbTarget);
    const debugServerArgs = asString(config?.debugServerArgs);
    const runnerName = debugServerArgs ? WestRunner.extractRunner(debugServerArgs) : undefined;
    // Same port precedence as the provider: the explicit --gdb-port inside
    // debugServerArgs is authoritative, gdbTarget is the fallback.
    let argsPort: string | undefined;
    if (runnerName && debugServerArgs) {
      const runner = getRunner(runnerName);
      runner?.loadArgs(debugServerArgs);
      argsPort = runner?.serverPort;
    }
    return {
      ...selection,
      programPath: asString(config?.program),
      svdPath: asString(config?.svdPath),
      gdbPath: asString(config?.miDebuggerPath),
      gdbAddress: target?.address ?? 'localhost',
      gdbPort: argsPort ?? target?.port ?? getDefaultGdbPort(runnerName),
      gdbMode: config?.gdbMode === 'attach' || config?.request === 'attach' ? 'attach' : 'program',
      runnerName,
      debugServerArgs,
    };
  }

  // cppdbg (and unknown/legacy shapes treated as cppdbg)
  const setupCommands = Array.isArray(config?.setupCommands) ? config.setupCommands : [];
  const serverAddress = getServerAddressFromConfig(config);
  let gdbAddress = 'localhost';
  let gdbPort = '3333';
  if (typeof serverAddress === 'string' && serverAddress.length > 0) {
    if (serverAddress.includes(':')) {
      [gdbAddress, gdbPort] = serverAddress.split(':');
    } else {
      gdbAddress = serverAddress;
    }
  }
  const debugServerArgs = asString(config?.debugServerArgs);
  return {
    ...selection,
    programPath: asString(config?.program),
    svdPath: asString(config?.svdPath),
    gdbPath: asString(config?.miDebuggerPath),
    gdbAddress,
    gdbPort,
    gdbMode: getGdbMode(setupCommands) === 'attach' ? 'attach' : 'program',
    runnerName: debugServerArgs ? WestRunner.extractRunner(debugServerArgs) : undefined,
    debugServerArgs,
  };
}
