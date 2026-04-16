import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

import { ZEPHYR_DIRNAME } from '../../constants';

type ArtifactProject = {
  folderPath: string;
  workspaceContext?: {
    name?: string;
  };
};

type ArtifactBuildConfig = {
  getBuildDir(parentProject: ArtifactProject): string;
  getBuildArtifactPath(parentProject: ArtifactProject, ...segments: string[]): string | undefined;
};

export interface ParsedRunnersYaml {
  path: string;
  raw: string;
  data: any;
  runners: string[];
  defaultFlashRunner?: string;
  defaultDebugRunner?: string;
  gdbPath?: string;
  boardDirCandidates: string[];
  runnerArgs: Record<string, string[]>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeString(value: string): string {
  return value.trim();
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const items = value
    .filter(isNonEmptyString)
    .map(normalizeString);

  return Array.from(new Set(items));
}

function getNestedValue(data: any, ...keys: string[]): unknown {
  let current = data;

  for (const key of keys) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = current[key];
  }

  return current;
}

function pickFirstString(...values: unknown[]): string | undefined {
  const found = values.find(isNonEmptyString);
  return found ? found.trim() : undefined;
}

function normalizeRunnerArgs(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: Record<string, string[]> = {};
  for (const [runnerName, runnerArgs] of Object.entries(value)) {
    const args = normalizeStringList(runnerArgs);
    if (args.length > 0) {
      result[runnerName] = args;
    }
  }

  return result;
}

function getBuildArtifactCandidates(buildDir: string, appFolderName: string | undefined, ...segments: string[]): string[] {
  const candidates: string[] = [];

  if (appFolderName && appFolderName.length > 0) {
    candidates.push(path.join(buildDir, appFolderName, ...segments));
  }

  candidates.push(path.join(buildDir, ...segments));
  return candidates;
}

export function findRunnersYamlForBuildDir(buildDir: string, appFolderName?: string): string | undefined {
  return getBuildArtifactCandidates(buildDir, appFolderName, ZEPHYR_DIRNAME, 'runners.yaml')
    .find(candidate => fs.existsSync(candidate));
}

export function findRunnersYamlForProject(parentProject: ArtifactProject, buildConfig: ArtifactBuildConfig): string | undefined {
  return buildConfig.getBuildArtifactPath(parentProject, ZEPHYR_DIRNAME, 'runners.yaml');
}

export function parseRunnersYamlText(raw: string, filePath = 'runners.yaml'): ParsedRunnersYaml | undefined {
  try {
    const data = yaml.parse(raw) ?? {};
    const runners = normalizeStringList(data.runners);

    return {
      path: filePath,
      raw,
      data,
      runners,
      defaultFlashRunner: pickFirstString(
        data['flash-runner'],
        data.flash_runner,
        data['default-runner'],
        data.default_runner,
        getNestedValue(data, 'config', 'flash-runner'),
        getNestedValue(data, 'config', 'flash_runner'),
        getNestedValue(data, 'config', 'default-runner'),
        getNestedValue(data, 'config', 'default_runner'),
      ),
      defaultDebugRunner: pickFirstString(
        data['debug-runner'],
        data.debug_runner,
        getNestedValue(data, 'config', 'debug-runner'),
        getNestedValue(data, 'config', 'debug_runner'),
      ),
      gdbPath: pickFirstString(getNestedValue(data, 'config', 'gdb')),
      boardDirCandidates: normalizeStringList([
        getNestedValue(data, 'config', 'board_dir'),
        data?.board_dir,
      ]),
      runnerArgs: normalizeRunnerArgs(data.args),
    };
  } catch {
    return undefined;
  }
}

export function readRunnersYamlFile(filePath: string): ParsedRunnersYaml | undefined {
  if (!filePath || !fs.existsSync(filePath)) {
    return undefined;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return parseRunnersYamlText(raw, filePath);
  } catch {
    return undefined;
  }
}

export function readRunnersYamlForBuildDir(buildDir: string, appFolderName?: string): ParsedRunnersYaml | undefined {
  const runnersYamlPath = findRunnersYamlForBuildDir(buildDir, appFolderName);
  if (!runnersYamlPath) {
    return undefined;
  }

  return readRunnersYamlFile(runnersYamlPath);
}

export function readRunnersYamlForProject(parentProject: ArtifactProject, buildConfig: ArtifactBuildConfig): ParsedRunnersYaml | undefined {
  const runnersYamlPath = findRunnersYamlForProject(parentProject, buildConfig);
  if (!runnersYamlPath) {
    return undefined;
  }

  return readRunnersYamlFile(runnersYamlPath);
}

export function getRunnerPathFromRunnersYaml(runnersYaml: ParsedRunnersYaml | undefined, runnerName: string): string | undefined {
  if (!runnersYaml || !runnerName) {
    return undefined;
  }

  const normalizedRunnerName = runnerName.replace(/-/g, '_');
  return pickFirstString(
    getNestedValue(runnersYaml.data, 'config', runnerName),
    getNestedValue(runnersYaml.data, 'config', normalizedRunnerName),
    runnersYaml.data?.[runnerName],
    runnersYaml.data?.[normalizedRunnerName],
  );
}

export function getPyOcdTargetFromRunnersYaml(runnersYaml: ParsedRunnersYaml | undefined): string | undefined {
  const pyocdArgs = runnersYaml?.runnerArgs.pyocd;
  if (!pyocdArgs) {
    return undefined;
  }

  const targetArg = pyocdArgs.find(arg => arg.startsWith('--target='));
  return targetArg ? targetArg.split('=')[1] : undefined;
}
