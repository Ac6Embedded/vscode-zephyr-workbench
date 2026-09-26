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

export function writeWestBuildState(buildDir: string, state: WestBuildState): void {
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(getWestBuildStatePath(buildDir), JSON.stringify(state, null, 2), 'utf8');
}
