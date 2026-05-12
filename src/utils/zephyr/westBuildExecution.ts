import * as fs from 'fs';
import path from 'path';
import { ZephyrApplication } from '../../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../../models/ZephyrBuildConfig';
import { WestWorkspace } from '../../models/WestWorkspace';
import { mergeOpenocdBuildFlag } from '../debugTools/debugToolSelectionUtils';
import {
  classifyShell,
  getConfiguredVenvPath,
  getShellExe,
  normalizeEnvVarsForShell,
  normalizePathForShell,
  RawEnvVars,
} from '../execUtils';
import { tryGetZephyrSdkInstallation } from '../utils';
import { getWestBuildSourceDirArgValue, hasWestBuildSourceDirArg, splitWestBuildArgs } from './westArgUtils';
import { getWestBuildStatePath, WestBuildState } from './westBuildState';

export interface PrepareWestBuildExecutionOptions {
  pristine: 'never' | 'always';
  rawWestArgsOverride?: string;
  additionalWestArgs?: string;
  additionalCmakeArgs?: string;
  target?: string;
}

export interface PreparedWestBuildExecution {
  command: string;
  env: Record<string, string>;
  buildDirPath: string;
  buildState: WestBuildState;
  needsConfigure: boolean;
}

export function prepareWestBuildExecution(
  zephyrProject: ZephyrApplication,
  westWorkspace: WestWorkspace,
  buildConfig: ZephyrBuildConfig,
  runOptions: PrepareWestBuildExecutionOptions,
): PreparedWestBuildExecution {
  const shellKind = classifyShell(getShellExe());
  const buildDirPath = path.join(zephyrProject.appRootPath, 'build', buildConfig.name);
  const buildDir = normalizePathForShell(shellKind, buildDirPath);
  const rawWestArgs = runOptions.rawWestArgsOverride && runOptions.rawWestArgsOverride.length > 0
    ? runOptions.rawWestArgsOverride
    : buildConfig.westArgs;
  const effectiveWestFlagsD = mergeOpenocdBuildFlag(zephyrProject, rawWestArgs, buildConfig.westFlagsD);
  const splitArgs = splitWestBuildArgs(rawWestArgs, effectiveWestFlagsD);
  const westArgs = [splitArgs.westArgs, runOptions.additionalWestArgs].filter(Boolean).join(' ').trim();
  const cmakeArgs = [splitArgs.cmakeArgs, runOptions.additionalCmakeArgs].filter(Boolean).join(' ').trim();
  const sourceDirOverride = getWestBuildSourceDirArgValue(westArgs);
  const includeDefaultSourceDir = !hasWestBuildSourceDirArg(westArgs);

  const rawEnvVars = buildConfig.envVars as RawEnvVars;
  const normEnvVars = normalizeEnvVarsForShell(rawEnvVars, shellKind);

  const sysbuildEnabled =
    typeof buildConfig.sysbuild === 'string'
      ? buildConfig.sysbuild.toLowerCase() === 'true'
      : Boolean(buildConfig.sysbuild);

  const snippets = Array.isArray(buildConfig.envVars?.['SNIPPETS'])
    ? [...buildConfig.envVars['SNIPPETS']]
    : [];
  const snippetsFlag = snippets.length > 0
    ? snippets.map(s => ` -S ${s}`).join('')
    : '';

  const toolchainEnv = zephyrProject.getToolchainEnv();
  const sdkEnv = tryGetZephyrSdkInstallation(zephyrProject.zephyrSdkPath)?.buildEnv ?? {};
  const workspaceEnv = westWorkspace.buildEnv;
  const buildState = createWestBuildState(
    buildConfig.boardIdentifier,
    sysbuildEnabled,
    snippets,
    cmakeArgs,
    rawEnvVars,
    toolchainEnv,
    sdkEnv,
    workspaceEnv,
    sourceDirOverride,
  );

  const buildDirConfigured = hasWestBuildConfiguration(buildDirPath);
  const stateChanged = !buildStatesMatch(readWestBuildState(buildDirPath), buildState);
  const needsConfigure = runOptions.pristine === 'always' || !buildDirConfigured || stateChanged;

  const venvPath = zephyrProject.venvPath ?? getConfiguredVenvPath(zephyrProject.appWorkspaceFolder) ?? '';
  const baseEnv = { ...sdkEnv, ...workspaceEnv, ...toolchainEnv };
  const configureEnv = needsConfigure ? normEnvVars : {};

  const env = venvPath && sysbuildEnabled
    ? {
        ...configureEnv,
        ...baseEnv,
        PATH: process.platform === 'win32'
          ? `${path.join(venvPath, 'Scripts')};${baseEnv.PATH ?? ''}`
          : `${path.join(venvPath, 'bin')}:${baseEnv.PATH ?? ''}`
      }
    : { ...configureEnv, ...baseEnv };

  const command =
    `west build` +
    (runOptions.target ? ` -t ${runOptions.target}` : '') +
    ` --pristine ${runOptions.pristine}` +
    (needsConfigure && buildDirConfigured ? ' --cmake' : '') +
    (needsConfigure ? ` --board ${buildConfig.boardIdentifier}` : '') +
    ` --build-dir "${buildDir}"` +
    (needsConfigure && sysbuildEnabled ? ' --sysbuild' : '') +
    (needsConfigure ? snippetsFlag : '') +
    (needsConfigure && includeDefaultSourceDir ? ` --source-dir "${zephyrProject.appRootPath}"` : '') +
    (westArgs.length > 0 ? ` ${westArgs}` : '') +
    (needsConfigure && cmakeArgs.length > 0 ? ` -- ${cmakeArgs}` : '');

  return {
    command,
    env,
    buildDirPath,
    buildState,
    needsConfigure,
  };
}

function createWestBuildState(
  board: string,
  sysbuild: boolean,
  snippets: string[],
  cmakeArgs: string,
  envVars: RawEnvVars,
  toolchainEnv: Record<string, string>,
  sdkEnv: Record<string, string>,
  workspaceEnv: Record<string, string>,
  sourceDirOverride: string | undefined,
): WestBuildState {
  return {
    board,
    sysbuild,
    snippets: [...snippets],
    cmakeArgs,
    envVars: normalizeRawEnvVars(envVars),
    toolchainEnv: sortRecord(toolchainEnv),
    sdkEnv: sortRecord(sdkEnv),
    workspaceEnv: sortRecord(workspaceEnv),
    ...(sourceDirOverride !== undefined ? { sourceDirOverride } : {}),
  };
}

function normalizeRawEnvVars(envVars: RawEnvVars): RawEnvVars {
  const normalized: RawEnvVars = {};

  for (const [key, value] of Object.entries(envVars ?? {})) {
    if (Array.isArray(value)) {
      normalized[key] = [...value].sort();
      continue;
    }
    normalized[key] = value;
  }

  return normalized;
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record ?? {}).sort(([left], [right]) => left.localeCompare(right))
  );
}

function hasWestBuildConfiguration(buildDir: string): boolean {
  return fs.existsSync(path.join(buildDir, 'CMakeCache.txt'));
}

function readWestBuildState(buildDir: string): WestBuildState | undefined {
  const statePath = getWestBuildStatePath(buildDir);
  if (!fs.existsSync(statePath)) {
    return undefined;
  }

  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8')) as WestBuildState;
  } catch {
    return undefined;
  }
}

function buildStatesMatch(previous: WestBuildState | undefined, next: WestBuildState): boolean {
  return JSON.stringify(previous) === JSON.stringify(next);
}
