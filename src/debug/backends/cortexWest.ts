import { assembleCortexDebugBaseConfig, mapGdbModeToRequest } from './cortexCommon';
import { CortexWestInput, GdbMode, ZW_DEBUG_TYPE, ZW_SERVER_TOKEN_KEY } from './types';

/**
 * Build the persisted `zephyr-workbench` launch.json entry. Field names reuse
 * the cppdbg spelling (`program`, `svdPath`, `miDebuggerPath`,
 * `debugServerArgs`) so the Debug Manager round-trips state with the same
 * reader for both backends.
 */
export function buildCortexWestLaunchConfig(input: CortexWestInput, debugServerArgs: string): any {
  return {
    name: input.name,
    type: ZW_DEBUG_TYPE,
    request: 'launch',
    cwd: input.cwd,
    program: input.programPath,
    svdPath: input.svdPath ?? '',
    miDebuggerPath: input.gdbPath ?? '',
    debugServerArgs,
    gdbTarget: `${input.gdbAddress || 'localhost'}:${input.gdbPort || '3333'}`,
    gdbMode: mapGdbModeToRequest(input.gdbMode) === 'attach' ? 'attach' : 'program',
  };
}

export interface ExternalLaunchOverrides {
  overrideLaunchCommands?: string[];
  overrideRestartCommands?: string[];
}

/**
 * cortex-debug's default `servertype: "external"` launch sequence is
 * OpenOCD-shaped (`monitor reset halt` + `load`), which other GDB servers do
 * not understand. This table is the single place where per-runner monitor
 * command differences live.
 *
 * Attach never flashes or resets (matching the cppdbg attach semantics), so it
 * needs no overrides for any runner.
 */
export function getExternalLaunchOverrides(
  runnerName: string | undefined,
  gdbMode: GdbMode,
): ExternalLaunchOverrides {
  if (gdbMode === 'attach') {
    return {};
  }

  switch (runnerName) {
    case 'jlink':
      // J-Link GDB Server has no `reset halt`; `monitor reset` halts per its
      // default strategy.
      return {
        overrideLaunchCommands: ['monitor halt', 'load', 'monitor reset'],
        overrideRestartCommands: ['monitor reset'],
      };
    case 'stlink_gdbserver':
      return {
        overrideLaunchCommands: ['monitor reset', 'load', 'monitor reset'],
        overrideRestartCommands: ['monitor reset'],
      };
    case 'linkserver':
      return {
        overrideLaunchCommands: ['monitor reset halt', 'load'],
        overrideRestartCommands: ['monitor reset halt'],
      };
    default:
      // openocd / pyocd: cortex-debug's defaults are correct.
      return {};
  }
}

export interface ExternalTransformContext {
  program: string;
  cwd: string;
  gdbTarget: string;
  runnerName?: string;
  serverToken?: string;
}

/**
 * Resolve-time transform of a stored `zephyr-workbench` entry into the runtime
 * cortex-debug `servertype: "external"` configuration handed to VS Code. The
 * result is never written to launch.json.
 */
export function transformToExternalCortexConfig(stored: any, ctx: ExternalTransformContext): any {
  // Hand-edited entries may express attach via `request` instead of `gdbMode`;
  // honor both so a launch never flashes a target the user meant to attach to.
  const gdbMode: GdbMode = stored?.gdbMode === 'attach' || stored?.request === 'attach' ? 'attach' : 'program';
  const config = assembleCortexDebugBaseConfig({
    name: typeof stored?.name === 'string' ? stored.name : 'Zephyr Workbench Debug',
    cwd: ctx.cwd,
    programPath: ctx.program,
    svdPath: typeof stored?.svdPath === 'string' ? stored.svdPath : undefined,
    gdbPath: typeof stored?.miDebuggerPath === 'string' ? stored.miDebuggerPath : undefined,
    gdbMode,
  });

  config.servertype = 'external';
  config.gdbTarget = ctx.gdbTarget;
  Object.assign(config, getExternalLaunchOverrides(ctx.runnerName, gdbMode));
  if (ctx.serverToken) {
    config[ZW_SERVER_TOKEN_KEY] = ctx.serverToken;
  }
  return config;
}
