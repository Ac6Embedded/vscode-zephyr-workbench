import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

import { classifyShell, execCommandWithEnv, getShellExe } from './execUtils';
import {
  DetectPlatform,
  DetectableToolLike,
  evaluateDetectPatterns,
  findDetectedToolRoot,
  getDetectPlatform,
  preserveDetectPatterns,
} from './debugToolPathUtils';
import { getInternalDirRealPath } from './utils';

/*
 * Shared debug-tool version probing.
 *
 * Global rules:
 * - `version` in YAML is only the reference version used for update comparison.
 * - The displayed installed version must come from an actual probe result.
 * - Tools with `explicit-detect` are resolved only from those paths.
 * - Tools without `explicit-detect` are resolved only by executable name, so they
 *   are PATH-based.
 * - Alias entries can own the shared `version-command` / `version-regex`, while a
 *   specific child tool still provides the real executable path to probe.
 * - Some packages expose the install version in their detected path instead of a
 *   CLI/file probe; `version-source: detect-path` handles that case.
 */
type VersionProbeSetting = string | Partial<Record<'default' | DetectPlatform, string>>;

export interface DebugToolEntry extends DetectableToolLike {
  tool: string;
  alias?: string;
  tooltip?: string;
  version?: string | number;
  ['auto-detect']?: Partial<Record<DetectPlatform, string[]>>;
  ['version-file']?: VersionProbeSetting;
  ['version-command']?: VersionProbeSetting;
  ['version-source']?: VersionProbeSetting;
  ['version-regex']?: VersionProbeSetting;
}

export interface DebugToolAliasEntry {
  alias: string;
  default?: string;
  name?: string;
  tooltip?: string;
  ['version-file']?: VersionProbeSetting;
  ['version-command']?: VersionProbeSetting;
  ['version-source']?: VersionProbeSetting;
  ['version-regex']?: VersionProbeSetting;
}

interface DebugToolsManifest {
  debug_tools?: DebugToolEntry[];
  aliases?: DebugToolAliasEntry[];
}

interface ToolVersionProbeResult {
  installed: boolean;
  version?: string;
  updateAvailable: boolean;
}

interface ProbeConfig {
  command?: string;
  filePath?: string;
  pathValue?: string;
  regex?: RegExp;
}

function normalizePathSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function hasExplicitDetectPatterns(
  tool: DetectableToolLike,
  platform: DetectPlatform,
): boolean {
  const patterns = preserveDetectPatterns(tool['explicit-detect']?.[platform] ?? [], getInternalDirRealPath());
  return patterns.length > 0;
}

function quoteShellArgument(value: string): string {
  const normalized = normalizePathSlashes(value);
  if (!/\s/.test(normalized) && !normalized.includes('"')) {
    return normalized;
  }
  return `"${normalized.replace(/"/g, '\\"')}"`;
}

function adaptProbeCommandForShell(command: string): string {
  const shellKind = classifyShell(getShellExe());
  if (shellKind !== 'powershell.exe' && shellKind !== 'pwsh.exe') {
    return command;
  }

  const trimmed = command.trim();
  if (!/^("?[A-Za-z]:\/|"?\/)/.test(trimmed)) {
    return command;
  }

  // PowerShell needs the call operator for absolute executable paths.
  return `& ${trimmed}`;
}

function parseDelimitedRegex(value: string): RegExp | undefined {
  if (!value.startsWith('/')) {
    return undefined;
  }

  const lastSlash = value.lastIndexOf('/');
  if (lastSlash <= 0) {
    return undefined;
  }

  const pattern = value.slice(1, lastSlash);
  const flags = value.slice(lastSlash + 1);

  try {
    return new RegExp(pattern, flags);
  } catch {
    return undefined;
  }
}

function extractComparableVersion(value: string): string | undefined {
  const match = value.match(/\d+(?:\.\d+)+/);
  return match?.[0];
}

function compareNumericVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(part => Number(part));
  const rightParts = right.split('.').map(part => Number(part));

  for (let idx = 0; idx < Math.max(leftParts.length, rightParts.length); idx += 1) {
    const leftPart = leftParts[idx] || 0;
    const rightPart = rightParts[idx] || 0;

    if (leftPart > rightPart) {
      return 1;
    }
    if (leftPart < rightPart) {
      return -1;
    }
  }

  return 0;
}

function normalizeVersion(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/^v/, '');
}

export function isIgnoredReferenceVersion(value: unknown): boolean {
  return normalizeVersion(value) === 'ignore';
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

function expandConfiguredPathTemplate(
  value: string,
  envData: any,
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

  return normalizePathSlashes(expanded);
}

function resolveExplicitDetectMatch(
  tool: DetectableToolLike,
  envData: any,
  ziBaseDir: string,
  platform: DetectPlatform,
): string | undefined {
  // `explicit-detect` can contain env.yml-style templates. We expand them first,
  // then evaluate globs, because the probe path must match the real installed
  // instance instead of the literal template string.
  const explicitDetectPatterns = preserveDetectPatterns(tool['explicit-detect']?.[platform] ?? [], ziBaseDir)
    .map(pattern => expandConfiguredPathTemplate(pattern, envData, ziBaseDir))
    .filter((pattern): pattern is string => typeof pattern === 'string' && pattern.length > 0);

  if (explicitDetectPatterns.length === 0) {
    return undefined;
  }

  return evaluateDetectPatterns(explicitDetectPatterns, ziBaseDir)[0];
}

function getLeadingCommandToken(command: string): string | undefined {
  const match = command.match(/^("([^"]+)"|'([^']+)'|\S+)/);
  return match?.[1];
}

function resolveExecutablePathFromBase(basePath: string, executableName: string): string {
  const normalizedBase = normalizePathSlashes(basePath);
  const expectedName = executableName.toLowerCase();
  const basename = path.posix.basename(normalizedBase).toLowerCase();

  if (basename === expectedName) {
    return normalizedBase;
  }

  if (basename === 'bin') {
    return normalizePathSlashes(path.posix.join(normalizedBase, executableName));
  }

  if (fs.existsSync(basePath)) {
    const stats = fs.statSync(basePath);
    if (stats.isFile()) {
      return normalizedBase;
    }

    const directCandidate = path.join(basePath, executableName);
    if (fs.existsSync(directCandidate)) {
      return normalizePathSlashes(directCandidate);
    }

    const binCandidate = path.join(basePath, 'bin', executableName);
    if (fs.existsSync(binCandidate)) {
      return normalizePathSlashes(binCandidate);
    }

    const binDir = path.join(basePath, 'bin');
    if (fs.existsSync(binDir) && fs.statSync(binDir).isDirectory()) {
      return normalizePathSlashes(path.join(binDir, executableName));
    }
  }

  return normalizePathSlashes(path.posix.join(normalizedBase, 'bin', executableName));
}

function getDebugToolsYamlPath(): string {
  return path.resolve(__dirname, '..', '..', 'scripts', 'runners', 'debug-tools.yml');
}

function loadDebugToolsManifest(): DebugToolsManifest {
  const yamlFile = fs.readFileSync(getDebugToolsYamlPath(), 'utf8');
  return yaml.parse(yamlFile) as DebugToolsManifest;
}

function findDebugTool(manifest: DebugToolsManifest, toolId: string): DebugToolEntry | undefined {
  return manifest.debug_tools?.find(tool => tool.tool === toolId);
}

function findDebugToolAlias(manifest: DebugToolsManifest, aliasId: string): DebugToolAliasEntry | undefined {
  return manifest.aliases?.find(alias => alias.alias === aliasId);
}

function resolveVersionProbeSetting(
  setting: VersionProbeSetting | undefined,
  platform: DetectPlatform = getDetectPlatform(),
): string | undefined {
  if (typeof setting === 'string') {
    const trimmed = setting.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (!setting) {
    return undefined;
  }

  const resolved = setting[platform] ?? setting.default;
  if (typeof resolved !== 'string') {
    return undefined;
  }

  const trimmed = resolved.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function compileVersionRegex(rawRegex: string | undefined): RegExp | undefined {
  if (!rawRegex) {
    return undefined;
  }

  const delimited = parseDelimitedRegex(rawRegex);
  if (delimited) {
    return delimited;
  }

  try {
    return new RegExp(rawRegex);
  } catch {
    return undefined;
  }
}

export function extractVersionFromProbeText(value: string, regex?: RegExp): string | undefined {
  const match = regex?.exec(value);
  return match?.[1]?.trim() || match?.[0]?.trim();
}

function renderVersionCommand(
  commandTemplate: string,
  executablePath?: string,
  executableName?: string,
): string | undefined {
  const trimmedTemplate = commandTemplate.trim();
  if (trimmedTemplate.length === 0) {
    return undefined;
  }

  const quotedExecutable = executablePath ? quoteShellArgument(executablePath) : undefined;

  const leadingToken = getLeadingCommandToken(trimmedTemplate);
  const normalizedExecutableName = executableName || (executablePath ? path.basename(executablePath) : undefined);
  if (leadingToken && normalizedExecutableName && quotedExecutable) {
    const unquotedToken = stripWrappingQuotes(leadingToken);
    if (unquotedToken.toLowerCase() === normalizedExecutableName.toLowerCase()) {
      // Keep the YAML command explicit, but if it starts with the executable name
      // swap only that first token so alias-owned probes still run against the
      // concrete detected binary.
      return `${quotedExecutable}${trimmedTemplate.slice(leadingToken.length)}`;
    }
  }

  if (!quotedExecutable || quotedExecutable.length === 0) {
    return trimmedTemplate;
  }

  return trimmedTemplate;
}

function isReferenceVersionNewer(
  detectedVersion: string | undefined,
  referenceVersion: string | number | undefined,
): boolean {
  const detected = normalizeVersion(detectedVersion);
  const reference = normalizeVersion(referenceVersion);

  if (!detected || !reference || detected === reference) {
    return false;
  }

  const comparableDetected = extractComparableVersion(detected);
  const comparableReference = extractComparableVersion(reference);

  if (comparableDetected && comparableReference) {
    return compareNumericVersions(comparableDetected, comparableReference) < 0;
  }

  return detected !== reference;
}

function resolveProbeOwner(
  manifest: DebugToolsManifest,
  tool: DebugToolEntry,
): DebugToolEntry | DebugToolAliasEntry | undefined {
  // Alias metadata owns shared version parsing rules so child variants do not
  // need to repeat the same command/regex.
  if (tool.alias) {
    const aliasEntry = findDebugToolAlias(manifest, tool.alias);
    if (
      aliasEntry?.['version-command'] ||
      aliasEntry?.['version-file'] ||
      aliasEntry?.['version-source'] ||
      aliasEntry?.['version-regex']
    ) {
      return aliasEntry;
    }
  }

  return tool;
}

function resolveVersionProbeFilePath(
  probeOwner: DebugToolEntry | DebugToolAliasEntry | undefined,
  envData: any,
  ziBaseDir: string,
  platform: DetectPlatform,
): string | undefined {
  if (!probeOwner) {
    return undefined;
  }

  const fileTemplate = resolveVersionProbeSetting(probeOwner['version-file'], platform);
  if (!fileTemplate) {
    return undefined;
  }

  const expanded = expandConfiguredPathTemplate(fileTemplate, envData, ziBaseDir);
  if (!expanded) {
    return undefined;
  }

  return evaluateDetectPatterns([expanded], ziBaseDir)[0];
}

function buildProbeConfig(
  probeOwner: DebugToolEntry | DebugToolAliasEntry | undefined,
  tool: DetectableToolLike | undefined,
  executablePath?: string,
  executableName?: string,
  envData?: any,
  ziBaseDir: string = getInternalDirRealPath(),
  platform: DetectPlatform = getDetectPlatform(),
): ProbeConfig | undefined {
  if (!probeOwner) {
    return undefined;
  }

  const rawRegex = resolveVersionProbeSetting(probeOwner['version-regex'], platform);
  const probeSource = resolveVersionProbeSetting(probeOwner['version-source'], platform);
  const filePath = resolveVersionProbeFilePath(probeOwner, envData, ziBaseDir, platform);
  if (filePath) {
    return {
      filePath,
      regex: compileVersionRegex(rawRegex),
    };
  }

  const commandTemplate = resolveVersionProbeSetting(probeOwner['version-command'], platform);

  if (!commandTemplate) {
    if (probeSource !== 'detect-path' || !tool) {
      return undefined;
    }

    const detectedPath = findDetectedToolRoot(tool, ziBaseDir, platform);
    if (!detectedPath) {
      return undefined;
    }

    return {
      pathValue: normalizePathSlashes(detectedPath),
      regex: compileVersionRegex(rawRegex),
    };
  }

  const command = renderVersionCommand(commandTemplate, executablePath, executableName);
  if (!command || !command.trim()) {
    return undefined;
  }

  return {
    command,
    regex: compileVersionRegex(rawRegex),
  };
}

function resolveToolExecutablePath(
  tool: DebugToolEntry,
  executableName: string | undefined,
  envData: any,
  ziBaseDir: string = getInternalDirRealPath(),
  platform: DetectPlatform = getDetectPlatform(),
): string | undefined {
  if (!executableName) {
    return undefined;
  }

  if (!hasExplicitDetectPatterns(tool, platform)) {
    // No explicit detect means PATH-only. Alias parent rows intentionally return
    // undefined here so they probe the bare command from PATH.
    return tool.alias ? undefined : executableName;
  }

  const detectedRoot = resolveExplicitDetectMatch(tool, envData, ziBaseDir, platform);
  if (!detectedRoot) {
    return undefined;
  }

  return resolveExecutablePathFromBase(detectedRoot, executableName);
}

async function executeVersionProbe(probe: ProbeConfig): Promise<{ installed: boolean; version?: string }> {
  return new Promise(resolve => {
    if (probe.pathValue) {
      const version = extractVersionFromProbeText(probe.pathValue, probe.regex);
      resolve({
        installed: true,
        version: version && version.length > 0 ? version : undefined,
      });
      return;
    }

    if (probe.filePath) {
      try {
        const contents = fs.readFileSync(probe.filePath, 'utf8');
        const version = extractVersionFromProbeText(contents, probe.regex);
        resolve({
          installed: true,
          version: version && version.length > 0 ? version : undefined,
        });
      } catch {
        resolve({ installed: false });
      }
      return;
    }

    if (!probe.command?.trim()) {
      resolve({ installed: false });
      return;
    }

    execCommandWithEnv(adaptProbeCommandForShell(probe.command), undefined, (error, stdout, stderr) => {
      const output = `${stdout ?? ''}\n${stderr ?? ''}`;
      const version = extractVersionFromProbeText(output, probe.regex);
      if (version && version.length > 0) {
        // Some tools print a valid version to stderr or still return a non-zero
        // exit code for `--version`. A regex match is enough to treat the probe
        // as successful.
        resolve({ installed: true, version });
        return;
      }

      if (error) {
        resolve({ installed: false });
        return;
      }

      resolve({
        installed: true,
        version: version && version.length > 0 ? version : undefined,
      });
    });
  });
}

export async function probeDebugToolVersion(options: {
  manifest: DebugToolsManifest;
  tool: DebugToolEntry;
  executableName?: string;
  envData?: any;
  ziBaseDir?: string;
  platform?: DetectPlatform;
}): Promise<ToolVersionProbeResult> {
  const {
    manifest,
    tool,
    executableName,
    envData,
    ziBaseDir = getInternalDirRealPath(),
    platform = getDetectPlatform(),
  } = options;

  // Install detection and version probing are kept separate:
  // - `explicit-detect` answers "is this specific tool instance present?"
  // - the command/file probe answers "what version does it report?"
  const installedFromDetect = hasExplicitDetectPatterns(tool, platform)
    ? !!resolveExplicitDetectMatch(tool, envData, ziBaseDir, platform)
    : undefined;
  const executablePath = resolveToolExecutablePath(
    tool,
    executableName,
    envData,
    ziBaseDir,
    platform,
  );
  const probeOwner = resolveProbeOwner(manifest, tool);
  if (tool.alias && !executablePath && installedFromDetect !== true) {
    return { installed: false, updateAvailable: false };
  }

  const probe = buildProbeConfig(probeOwner, tool, executablePath, executableName, envData, ziBaseDir, platform);

  if (!probe || (!probe.pathValue && !probe.filePath && !probe.command?.trim())) {
    return {
      installed: installedFromDetect ?? false,
      updateAvailable: false,
    };
  }

  const result = await executeVersionProbe(probe);
  const installed = installedFromDetect ?? result.installed;

  return {
    installed,
    version: result.version,
    updateAvailable:
      installed &&
      !isIgnoredReferenceVersion(tool.version) &&
      isReferenceVersionNewer(result.version, tool.version),
  };
}

async function probeInstalledVersion(
  toolOrAliasId: string,
  executablePath?: string,
): Promise<{ installed: boolean; version?: string }> {
  const manifest = loadDebugToolsManifest();
  const tool = findDebugTool(manifest, toolOrAliasId);
  const alias = tool ? undefined : findDebugToolAlias(manifest, toolOrAliasId);
  const probeOwner = tool ? resolveProbeOwner(manifest, tool) : alias;
  const probe = buildProbeConfig(
    probeOwner,
    tool,
    executablePath,
    executablePath ? path.basename(executablePath) : undefined,
    undefined,
    getInternalDirRealPath(),
  );

  if (!probe || (!probe.pathValue && !probe.filePath && !probe.command?.trim())) {
    return { installed: false };
  }

  return executeVersionProbe(probe);
}

export async function detectRunnerVersion(toolOrAliasId: string, executablePath?: string): Promise<string | undefined> {
  const result = await probeInstalledVersion(toolOrAliasId, executablePath);
  return result.version;
}
