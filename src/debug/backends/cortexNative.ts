import fs from 'fs';
import path from 'path';

import {
  ParsedRunnersYaml,
  readRunnersYamlForProject,
} from '../../utils/zephyr/runnersYamlUtils';
import { tokenizeArgs, unquoteToken } from '../../utils/argsTokenizer';
import { assembleCortexDebugBaseConfig } from './cortexCommon';
import { CortexNativeInput } from './types';

export interface JlinkDeviceDetection {
  device: string;
  source: 'runners.yaml' | 'board.cmake';
}

/**
 * Extract the J-Link `--device` value from runners.yaml `args.jlink`
 * (authoritative post-build source; supports `--device=X` and `--device X`).
 */
export function extractJlinkDeviceFromRunnersYaml(runnersYaml: ParsedRunnersYaml | undefined): string | undefined {
  const jlinkArgs = runnersYaml?.runnerArgs?.jlink;
  if (!jlinkArgs || jlinkArgs.length === 0) {
    return undefined;
  }

  for (let i = 0; i < jlinkArgs.length; i++) {
    const arg = jlinkArgs[i];
    const assignedMatch = arg.match(/^--device=(.+)$/);
    if (assignedMatch) {
      return assignedMatch[1].trim().replace(/^"(.*)"$/, '$1') || undefined;
    }
    if (arg === '--device' && jlinkArgs[i + 1]) {
      return jlinkArgs[i + 1].trim().replace(/^"(.*)"$/, '$1') || undefined;
    }
  }
  return undefined;
}

/**
 * Pre-build fallback: extract `--device` from the literal Zephyr idiom
 * `board_runner_args(jlink "--device=STM32F429ZI" "--speed=4000")`.
 */
export function extractJlinkDeviceFromBoardCmakeText(boardCmakeText: string): string | undefined {
  const match = boardCmakeText.match(/board_runner_args\(\s*jlink\b[^)]*?--device[= ]\s*"?([^"\s)]+)"?/s);
  return match?.[1]?.trim() || undefined;
}

export function extractJlinkDeviceFromBoardCmake(boardRootPath: string): string | undefined {
  try {
    const boardCmakePath = path.join(boardRootPath, 'board.cmake');
    if (!fs.existsSync(boardCmakePath)) {
      return undefined;
    }
    return extractJlinkDeviceFromBoardCmakeText(fs.readFileSync(boardCmakePath, 'utf8'));
  } catch {
    return undefined;
  }
}

type DetectableProject = Parameters<typeof readRunnersYamlForProject>[0];
type DetectableBuildConfig = Parameters<typeof readRunnersYamlForProject>[1];

/**
 * Detect the SEGGER device name for the cortex-debug `device` attribute.
 * runners.yaml first (fully resolved), board.cmake second (pre-build), and
 * `undefined` when neither knows — the field is then left for the user, never
 * invented.
 */
export function detectJlinkDevice(
  project: DetectableProject,
  buildConfig: DetectableBuildConfig,
  targetBoard?: { rootPath: string },
): JlinkDeviceDetection | undefined {
  const runnersYaml = readRunnersYamlForProject(project, buildConfig);
  const fromRunnersYaml = extractJlinkDeviceFromRunnersYaml(runnersYaml);
  if (fromRunnersYaml) {
    return { device: fromRunnersYaml, source: 'runners.yaml' };
  }

  const boardDirCandidates = [
    ...(runnersYaml?.boardDirCandidates ?? []),
    ...(targetBoard?.rootPath ? [targetBoard.rootPath] : []),
  ];
  for (const boardDir of boardDirCandidates) {
    const fromBoardCmake = extractJlinkDeviceFromBoardCmake(boardDir);
    if (fromBoardCmake) {
      return { device: fromBoardCmake, source: 'board.cmake' };
    }
  }

  return undefined;
}

/**
 * Build the persisted native cortex-debug launch.json entry. cortex-debug
 * spawns the GDB server itself, so no west invocation and no address/port are
 * involved. Empty optional fields are omitted so cortex-debug can fall back to
 * its own `cortex-debug.*` settings or PATH.
 */
export function buildCortexNativeLaunchConfig(input: CortexNativeInput): any {
  const config = assembleCortexDebugBaseConfig(input);
  config.servertype = input.server;
  config.interface = input.interface === 'jtag' ? 'jtag' : 'swd';

  const device = input.device?.trim();
  if (input.server === 'jlink') {
    // REQUIRED by cortex-debug for jlink; kept (possibly empty) so the user
    // can fill it in launch.json when detection failed.
    config.device = device ?? '';
  } else if (device) {
    // Optional for stlink: ST-LINK_gdbserver auto-detects the target.
    config.device = device;
  }

  const serverPath = input.serverPath?.trim();
  if (serverPath) {
    config.serverpath = serverPath;
  }

  if (input.server === 'stlink') {
    const cubeProgrammerDir = input.stm32CubeProgrammerDir?.trim();
    if (cubeProgrammerDir) {
      config.stm32cubeprogrammer = cubeProgrammerDir;
    }
  }

  const serverArgs = input.serverArgs?.trim();
  if (serverArgs) {
    config.serverArgs = tokenizeArgs(serverArgs)
      .map(unquoteToken)
      .filter(token => token.length > 0);
  }

  return config;
}
