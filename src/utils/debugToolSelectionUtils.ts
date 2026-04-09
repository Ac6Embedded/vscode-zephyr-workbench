import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

import { getDetectPlatform, findDetectedToolRoot, evaluateDetectPatterns } from './debugToolPathUtils';
import type { DebugToolAliasEntry, DebugToolEntry } from './debugToolVersionUtils';
import { getInternalDirRealPath } from './utils';

interface DebugToolsManifest {
  debug_tools?: DebugToolEntry[];
  aliases?: DebugToolAliasEntry[];
}

interface DebugEnvData {
  runners?: Record<string, { default?: string; path?: string }>;
  env?: Record<string, string>;
}

export interface DebugToolAliasSelection {
  alias: string;
  defaultToolId?: string;
  defaultToolName?: string;
  executablePath?: string;
}

function normalizePathSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

function hasGlobPattern(value: string): boolean {
  return /[*?[]/.test(value);
}

function loadDebugToolsManifest(debugToolsYamlPath: string): DebugToolsManifest {
  return yaml.parse(fs.readFileSync(debugToolsYamlPath, 'utf8')) as DebugToolsManifest;
}

function loadDebugEnvData(): DebugEnvData | undefined {
  try {
    const envYamlPath = path.join(getInternalDirRealPath(), 'env.yml');
    if (!fs.existsSync(envYamlPath)) {
      return undefined;
    }
    return yaml.parse(fs.readFileSync(envYamlPath, 'utf8')) as DebugEnvData;
  } catch {
    return undefined;
  }
}

function expandConfiguredPathTemplate(
  value: string,
  envData: DebugEnvData | undefined,
  ziBaseDir: string,
): string | undefined {
  const replacements: Record<string, string | undefined> = {
    zi_base_dir: envData?.env?.zi_base_dir || ziBaseDir,
    zi_tools_dir: envData?.env?.zi_tools_dir || path.join(ziBaseDir, 'tools'),
    HOME: process.env.HOME || process.env.USERPROFILE,
    USERPROFILE: process.env.USERPROFILE || process.env.HOME,
  };

  const expanded = value.replace(/\$\{([^}]+)\}/g, (match, variableName: string) => {
    const replacement = replacements[variableName] ?? process.env[variableName];
    return typeof replacement === 'string' && replacement.length > 0
      ? normalizePathSlashes(replacement)
      : match;
  });

  if (/\$\{[^}]+\}/.test(expanded)) {
    return undefined;
  }

  return normalizePathSlashes(stripWrappingQuotes(expanded));
}

function resolveExecutablePathFromBase(basePath: string, executableName: string): string {
  const normalizedBasePath = normalizePathSlashes(basePath);
  const basename = path.posix.basename(normalizedBasePath).toLowerCase();
  const expectedExecutable = executableName.toLowerCase();

  if (basename === expectedExecutable) {
    return normalizedBasePath;
  }

  if (basename === 'bin') {
    return normalizePathSlashes(path.posix.join(normalizedBasePath, executableName));
  }

  if (fs.existsSync(basePath)) {
    const stats = fs.statSync(basePath);
    if (stats.isFile()) {
      return normalizedBasePath;
    }

    const directCandidate = path.join(basePath, executableName);
    if (fs.existsSync(directCandidate)) {
      return normalizePathSlashes(directCandidate);
    }

    const binCandidate = path.join(basePath, 'bin', executableName);
    if (fs.existsSync(binCandidate)) {
      return normalizePathSlashes(binCandidate);
    }
  }

  return normalizePathSlashes(path.posix.join(normalizedBasePath, executableName));
}

function resolveConfiguredExecutablePath(
  configuredPath: string | undefined,
  executableName: string,
  envData: DebugEnvData | undefined,
  ziBaseDir: string,
): string | undefined {
  if (!configuredPath) {
    return undefined;
  }

  const expandedPath = expandConfiguredPathTemplate(configuredPath.trim(), envData, ziBaseDir);
  if (!expandedPath) {
    return undefined;
  }

  const resolvedBasePath = evaluateDetectPatterns([expandedPath], ziBaseDir)[0];
  if (resolvedBasePath) {
    return resolveExecutablePathFromBase(resolvedBasePath, executableName);
  }

  if (hasGlobPattern(expandedPath)) {
    return undefined;
  }

  return resolveExecutablePathFromBase(expandedPath, executableName);
}

function resolveDetectedExecutablePath(
  tool: DebugToolEntry | undefined,
  executableName: string,
  ziBaseDir: string,
): string | undefined {
  if (!tool) {
    return undefined;
  }

  const detectedRoot = findDetectedToolRoot(tool, ziBaseDir, getDetectPlatform());
  if (!detectedRoot) {
    return undefined;
  }

  return resolveExecutablePathFromBase(detectedRoot, executableName);
}

export function getDebugToolAliasSelection(
  alias: string,
  executableName: string,
  debugToolsYamlPath: string,
): DebugToolAliasSelection {
  const ziBaseDir = getInternalDirRealPath();
  const manifest = loadDebugToolsManifest(debugToolsYamlPath);
  const envData = loadDebugEnvData();
  const aliasEntry = manifest.aliases?.find(entry => entry.alias === alias);
  const defaultToolId = envData?.runners?.[alias]?.default
    || aliasEntry?.default
    || manifest.debug_tools?.find(tool => tool.alias === alias)?.tool;
  const selectedTool = manifest.debug_tools?.find(tool => tool.tool === defaultToolId);
  const aliasConfiguredPath = envData?.runners?.[alias]?.path;
  const toolConfiguredPath = defaultToolId ? envData?.runners?.[defaultToolId]?.path : undefined;
  const executablePath = resolveConfiguredExecutablePath(aliasConfiguredPath, executableName, envData, ziBaseDir)
    || resolveConfiguredExecutablePath(toolConfiguredPath, executableName, envData, ziBaseDir)
    || resolveDetectedExecutablePath(selectedTool, executableName, ziBaseDir);

  return {
    alias,
    defaultToolId,
    defaultToolName: (selectedTool as { name?: string } | undefined)?.name,
    executablePath,
  };
}
