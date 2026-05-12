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

export function writeWestBuildState(buildDir: string, state: WestBuildState): void {
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(getWestBuildStatePath(buildDir), JSON.stringify(state, null, 2), 'utf8');
}
