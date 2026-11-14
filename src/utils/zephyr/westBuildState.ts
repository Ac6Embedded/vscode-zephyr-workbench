import * as fs from 'fs';
import path from 'path';
import { RawEnvVars } from '../execUtils';

export interface WestBuildState {
  board: string;
  sysbuild: boolean;
  snippets: string[];
  cmakeArgs: string;
  envVars: RawEnvVars;
  toolchainEnv: Record<string, string>;
  sdkEnv: Record<string, string>;
  workspaceEnv: Record<string, string>;
  sourceDirOverride?: string;
}

const WEST_BUILD_STATE_FILE = '.zephyr-workbench-build-state.json';

export function getWestBuildStatePath(buildDir: string): string {
  return path.join(buildDir, WEST_BUILD_STATE_FILE);
}

/**
 * Files only a Zephyr build directory holds: the CMake cache, west's build
 * info, the state the workbench writes after every build, and the sysbuild
 * domain list. Any one is enough, so single-image and sysbuild builds qualify.
 */
export const BUILD_DIR_MARKERS: readonly string[] = ['CMakeCache.txt', 'build_info.yml', WEST_BUILD_STATE_FILE, 'domains.yaml'];

/** True when `dir` holds at least one build marker, so deleting it only removes build output. */
export function looksLikeBuildDir(dir: string): boolean {
  return BUILD_DIR_MARKERS.some(marker => fs.existsSync(path.join(dir, marker)));
}

/**
 * True when a configured build folder cannot take the new settings with a
 * CMake re-run and needs a pristine build: Zephyr keeps the board, the shields
 * and the snippets of the first configure (zephyr_check_cache), CMake keeps
 * the compiler, the SDK and the Zephyr tree it found, and sysbuild or another
 * source folder is another CMake project. Other changes (CMake arguments,
 * extra configuration or overlay files, modules) only need the re-run.
 * Without a previous state there is nothing to compare: false.
 */
export function needsPristineRebuild(previous: WestBuildState | undefined, next: WestBuildState): boolean {
  if (!previous) {
    return false;
  }
  const differs = (left: unknown, right: unknown) => JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);
  return previous.board !== next.board
    || previous.sysbuild !== next.sysbuild
    || differs(previous.snippets, next.snippets)
    || differs(previous.envVars?.SHIELD, next.envVars?.SHIELD)
    || previous.sourceDirOverride !== next.sourceDirOverride
    || differs(previous.toolchainEnv, next.toolchainEnv)
    || differs(previous.sdkEnv, next.sdkEnv)
    || differs(previous.workspaceEnv, next.workspaceEnv);
}

export function writeWestBuildState(buildDir: string, state: WestBuildState): void {
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(getWestBuildStatePath(buildDir), JSON.stringify(state, null, 2), 'utf8');
}
