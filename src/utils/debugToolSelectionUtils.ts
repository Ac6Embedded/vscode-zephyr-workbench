import * as vscode from 'vscode';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

import { getDetectPlatform, findDetectedToolRoot, evaluateDetectPatterns } from './debugToolPathUtils';
import type { DebugToolAliasEntry, DebugToolEntry } from './debugToolVersionUtils';
import { compareVersions, getInternalDirRealPath } from './utils';
import { loadEnvYamlState } from './envYamlFileUtils';

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

export interface OpenocdSelectionInfo {
  defaultToolId?: string;
  defaultToolName?: string;
  cmakeOverridePath?: string;
  info: string;
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

export function getDebugToolsYamlPath(extensionUri?: vscode.Uri): string {
  const resolvedExtensionUri = extensionUri
    ?? vscode.extensions.getExtension('Ac6.zephyr-workbench')?.extensionUri;

  if (!resolvedExtensionUri) {
    throw new Error('Cannot determine extension URI to locate debug-tools.yml');
  }

  return vscode.Uri.joinPath(resolvedExtensionUri, 'scripts', 'runners', 'debug-tools.yml').fsPath;
}

function loadDebugToolsManifest(debugToolsYamlPath: string): DebugToolsManifest {
  return yaml.parse(fs.readFileSync(debugToolsYamlPath, 'utf8')) as DebugToolsManifest;
}

function loadDebugEnvData(): DebugEnvData | undefined {
  const { data } = loadEnvYamlState();
  return data as DebugEnvData | undefined;
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
  debugToolsYamlPath: string = getDebugToolsYamlPath(),
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

function usesLegacySdkVersion(sdkVersion: string | undefined): boolean {
  return !!sdkVersion && /^(?:v)?1\./i.test(sdkVersion.trim());
}

function shouldShowOpenocdDefaultInfo(sdkVersion: string | undefined): boolean {
  return !!sdkVersion && compareVersions(sdkVersion.trim(), '1.0.0') >= 0;
}

export function getOpenocdSelectionInfo(
  project: { sdkVersion?: string },
  extensionUri?: vscode.Uri,
): OpenocdSelectionInfo {
  const sdkVersion = project.sdkVersion?.trim();
  // "Legacy OpenOCD selection" refers to SDK 1.x behavior: the effective default OpenOCD tool
  // matters. west builds must pass that tool to CMake explicitly when it is not the
  // Zephyr-provided openocd-zephyr, and Debug Manager should surface which tool the build resolved.
  // Older SDKs do not need any of this handling, and the UI should stay quiet for them.
  if (!shouldShowOpenocdDefaultInfo(sdkVersion)) {
    return { info: '' };
  }

  const executableName = process.platform === 'win32' ? 'openocd.exe' : 'openocd';
  const selection = getDebugToolAliasSelection('openocd', executableName, getDebugToolsYamlPath(extensionUri));
  const defaultToolLabel = selection.defaultToolName
    ? `${selection.defaultToolName}${selection.defaultToolId ? ` (${selection.defaultToolId})` : ''}`
    : (selection.defaultToolId ?? 'unknown');

  return {
    defaultToolId: selection.defaultToolId,
    defaultToolName: selection.defaultToolName,
    // SDK 1.x is sensitive to which OpenOCD is effectively used. If the default tool is not
    // the Zephyr-provided one, west/CMake must receive the resolved executable explicitly.
    cmakeOverridePath: usesLegacySdkVersion(sdkVersion) && selection.defaultToolId !== 'openocd-zephyr'
      ? selection.executablePath
      : undefined,
    info: `Default: ${defaultToolLabel}`,
  };
}

export function getOpenocdBuildFlag(
  project: { sdkVersion?: string },
  extensionUri?: vscode.Uri,
): string | undefined {
  // Reuse the exact same decision path as Debug Manager so the displayed default tool and the
  // CMake OPENOCD override stay in sync.
  const openocdPath = getOpenocdSelectionInfo(project, extensionUri).cmakeOverridePath;
  if (!openocdPath) {
    return undefined;
  }

  return openocdPath.includes(' ')
    ? `OPENOCD="${openocdPath}"`
    : `OPENOCD=${openocdPath}`;
}

function isOpenocdFlagDValue(value: string): boolean {
  const normalizedValue = value.trim().replace(/^(--\s*)?-D/i, '').trim();
  return /^OPENOCD\s*=/.test(normalizedValue);
}

function rawWestArgsContainOpenocd(rawWestArgs: string | undefined): boolean {
  return /(?:^|\s)-DOPENOCD\s*=/.test(rawWestArgs?.trim() ?? '');
}

export function mergeOpenocdBuildFlag(
  project: { sdkVersion?: string },
  rawWestArgs: string | undefined = undefined,
  westFlagsD: string[] | undefined = [],
  extensionUri?: vscode.Uri,
): string[] {
  const mergedFlags = Array.isArray(westFlagsD) ? [...westFlagsD] : [];
  const openocdBuildFlag = getOpenocdBuildFlag(project, extensionUri);

  if (!openocdBuildFlag) {
    return mergedFlags;
  }

  // An explicit OPENOCD value in west args or west flags must win over the automatic one.
  if (rawWestArgsContainOpenocd(rawWestArgs) || mergedFlags.some(isOpenocdFlagDValue)) {
    return mergedFlags;
  }

  // OPENOCD is derived from the current SDK/default-tool selection, so add it only when the user
  // did not already provide an explicit value.
  return [
    ...mergedFlags,
    openocdBuildFlag,
  ];
}
