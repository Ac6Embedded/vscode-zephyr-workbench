import fs from 'fs';
import path from 'path';

export type DetectPlatform = 'windows' | 'linux' | 'darwin';

export interface DetectableToolLike {
  install_dir?: string;
  ['auto-detect']?: Partial<Record<DetectPlatform, string[]>>;
  ['explicit-detect']?: Partial<Record<DetectPlatform, string[]>>;
}

function normalizePathSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function hasGlobPattern(value: string): boolean {
  return /[*?[]/.test(value);
}

function hasTemplateVariable(value: string): boolean {
  return /\$\{[^}]+\}/.test(value);
}

export function getDetectPlatform(platform: NodeJS.Platform = process.platform): DetectPlatform {
  switch (platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'darwin';
    default:
      return 'linux';
  }
}

export function preserveDetectPattern(pattern: string, ziBaseDir: string): string {
  void ziBaseDir;
  return normalizePathSlashes(pattern);
}

export function preserveDetectPatterns(patterns: string[], ziBaseDir: string): string[] {
  return Array.from(new Set(
    patterns
      .map(pattern => preserveDetectPattern(pattern, ziBaseDir).trim())
      .filter(pattern => pattern.length > 0)
  ));
}

export function evaluateDetectPatterns(patterns: string[], ziBaseDir: string): string[] {
  const { sync: globSync } = require('glob');
  const matches: string[] = [];

  for (const pattern of patterns) {
    const expanded = preserveDetectPattern(pattern, ziBaseDir);
    if (hasGlobPattern(expanded)) {
      const globMatches = globSync(expanded, { dot: true })
        .map((match: string) => normalizePathSlashes(match))
        .sort((a: string, b: string) => b.localeCompare(a));
      matches.push(...globMatches);
      continue;
    }

    if (fs.existsSync(expanded)) {
      matches.push(expanded);
    }
  }

  return Array.from(new Set(matches));
}

export function getToolDetectPatterns(
  tool: DetectableToolLike,
  platform: DetectPlatform,
  ziBaseDir: string,
): string[] {
  const explicitDetectPaths = tool['explicit-detect']?.[platform];
  if (Array.isArray(explicitDetectPaths) && explicitDetectPaths.length > 0) {
    return preserveDetectPatterns(explicitDetectPaths, ziBaseDir);
  }

  const autoDetectPaths = tool['auto-detect']?.[platform];
  if (Array.isArray(autoDetectPaths) && autoDetectPaths.length > 0) {
    return preserveDetectPatterns(autoDetectPaths, ziBaseDir);
  }

  if (tool.install_dir) {
    return [normalizePathSlashes(path.join(ziBaseDir, 'tools', tool.install_dir))];
  }

  return [];
}

function getInternalInstallRoot(tool: DetectableToolLike, ziBaseDir: string): string | undefined {
  if (!tool.install_dir) {
    return undefined;
  }
  return normalizePathSlashes(path.join(ziBaseDir, 'tools', tool.install_dir));
}

export function findDetectedToolRoot(
  tool: DetectableToolLike,
  ziBaseDir: string,
  platform: DetectPlatform = getDetectPlatform(),
): string | undefined {
  const patterns = getToolDetectPatterns(tool, platform, ziBaseDir);
  const matches = evaluateDetectPatterns(
    patterns.filter(pattern => !hasTemplateVariable(pattern)),
    ziBaseDir,
  );
  if (matches.length > 0) {
    return matches[0];
  }

  // Placeholder-based paths are kept literal for env.yml. For installation
  // detection we fall back to the internal install_dir when one exists.
  const internalInstallRoot = getInternalInstallRoot(tool, ziBaseDir);
  if (internalInstallRoot && fs.existsSync(internalInstallRoot)) {
    return internalInstallRoot;
  }

  return matches[0];
}

function looksLikeExecutablePath(target: string, executableName: string): boolean {
  return path.posix.basename(normalizePathSlashes(target)).toLowerCase() === executableName.toLowerCase();
}

function deriveCommandDir(rootPath: string, executableName: string): string {
  const normalizedRoot = normalizePathSlashes(rootPath);

  if (looksLikeExecutablePath(normalizedRoot, executableName)) {
    return normalizePathSlashes(path.posix.dirname(normalizedRoot));
  }

  if (path.posix.basename(normalizedRoot).toLowerCase() === 'bin') {
    return normalizedRoot;
  }

  if (!hasGlobPattern(normalizedRoot) && fs.existsSync(normalizedRoot)) {
    const rootStat = fs.statSync(normalizedRoot);
    if (rootStat.isFile()) {
      return normalizePathSlashes(path.dirname(normalizedRoot));
    }

    const binExecutable = path.join(normalizedRoot, 'bin', executableName);
    if (fs.existsSync(binExecutable)) {
      return normalizePathSlashes(path.dirname(binExecutable));
    }

    const directExecutable = path.join(normalizedRoot, executableName);
    if (fs.existsSync(directExecutable)) {
      return normalizedRoot;
    }

    const binDir = path.join(normalizedRoot, 'bin');
    if (fs.existsSync(binDir) && fs.statSync(binDir).isDirectory()) {
      return normalizePathSlashes(binDir);
    }
  }

  return normalizePathSlashes(path.posix.join(normalizedRoot, 'bin'));
}

function deriveExplicitCommandDir(targetPath: string, executableName: string): string {
  const normalizedTarget = normalizePathSlashes(targetPath);

  if (looksLikeExecutablePath(normalizedTarget, executableName)) {
    return normalizePathSlashes(path.posix.dirname(normalizedTarget));
  }

  return normalizedTarget;
}

export function getToolCommandDir(
  tool: DetectableToolLike,
  ziBaseDir: string,
  executableName: string,
  platform: DetectPlatform = getDetectPlatform(),
): string | undefined {
  const explicitDetectPaths = preserveDetectPatterns(tool['explicit-detect']?.[platform] ?? [], ziBaseDir);
  if (explicitDetectPaths.length > 0) {
    const preservedRoot = explicitDetectPaths[0];
    const evaluatedRoot = evaluateDetectPatterns(
      explicitDetectPaths.filter(pattern => !hasTemplateVariable(pattern)),
      ziBaseDir,
    )[0];
    const rootForEnv = (hasGlobPattern(preservedRoot) || hasTemplateVariable(preservedRoot))
      ? preservedRoot
      : (evaluatedRoot ?? preservedRoot);
    return deriveExplicitCommandDir(rootForEnv, executableName);
  }

  const patterns = getToolDetectPatterns(tool, platform, ziBaseDir);
  if (patterns.length === 0) {
    return undefined;
  }

  const preservedRoot = patterns[0];
  const evaluatedRoot = findDetectedToolRoot(tool, ziBaseDir, platform);
  // Keep wildcard and placeholder-based patterns literal in env.yml so the
  // environment loader can resolve them later.
  const rootForEnv = (hasGlobPattern(preservedRoot) || hasTemplateVariable(preservedRoot))
    ? preservedRoot
    : (evaluatedRoot ?? preservedRoot);
  return deriveCommandDir(rootForEnv, executableName);
}
