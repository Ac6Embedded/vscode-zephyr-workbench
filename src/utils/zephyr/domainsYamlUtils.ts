import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

const DOMAINS_YAML_FILENAME = 'domains.yaml';

export interface DomainEntry {
  name: string;
  buildDir: string;
}

export interface ParsedDomainsYaml {
  path: string;
  defaultDomain: string;
  topBuildDir: string;
  domains: DomainEntry[];
  flashOrder: string[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isNonEmptyString).map(item => item.trim());
}

/**
 * Whether two build-directory paths point at the same location. Matches the
 * case-insensitive comparison the extension uses elsewhere for win32 paths.
 */
function samePath(a: string, b: string): boolean {
  const normalizedA = path.resolve(a);
  const normalizedB = path.resolve(b);
  if (process.platform === 'win32') {
    return normalizedA.toLowerCase() === normalizedB.toLowerCase();
  }
  return normalizedA === normalizedB;
}

/**
 * Parse a sysbuild `domains.yaml`. When `actualBuildDir` is supplied and differs
 * from the top `build_dir` recorded in the file (artifacts were moved), every
 * domain build directory is rebased onto the actual location, replicating what
 * `west`'s domains.py does.
 */
export function parseDomainsYamlText(
  raw: string,
  filePath = DOMAINS_YAML_FILENAME,
  actualBuildDir?: string,
): ParsedDomainsYaml | undefined {
  try {
    const data = yaml.parse(raw) ?? {};

    const defaultDomain = isNonEmptyString(data.default) ? data.default.trim() : undefined;
    const recordedTopBuildDir = isNonEmptyString(data.build_dir) ? data.build_dir.trim() : undefined;
    if (!defaultDomain || !recordedTopBuildDir || !Array.isArray(data.domains)) {
      return undefined;
    }

    const rebase = actualBuildDir !== undefined && !samePath(recordedTopBuildDir, actualBuildDir);
    const effectiveTopBuildDir = rebase ? actualBuildDir! : recordedTopBuildDir;

    const domains: DomainEntry[] = [];
    for (const entry of data.domains) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const name = isNonEmptyString(entry.name) ? entry.name.trim() : undefined;
      const recordedBuildDir = isNonEmptyString(entry.build_dir) ? entry.build_dir.trim() : undefined;
      if (!name || !recordedBuildDir) {
        continue;
      }
      const buildDir = rebase
        ? path.join(effectiveTopBuildDir, path.relative(recordedTopBuildDir, recordedBuildDir))
        : recordedBuildDir;
      domains.push({ name, buildDir });
    }

    if (domains.length === 0 || !domains.some(domain => domain.name === defaultDomain)) {
      return undefined;
    }

    return {
      path: filePath,
      defaultDomain,
      topBuildDir: effectiveTopBuildDir,
      domains,
      flashOrder: normalizeStringList(data.flash_order),
    };
  } catch {
    return undefined;
  }
}

export function readDomainsYamlFile(filePath: string): ParsedDomainsYaml | undefined {
  if (!filePath || !fs.existsSync(filePath)) {
    return undefined;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return parseDomainsYamlText(raw, filePath, path.dirname(filePath));
  } catch {
    return undefined;
  }
}

/**
 * Read `<buildDir>/domains.yaml` (the sysbuild top-level build directory). The
 * presence of this file is the authoritative signal that a build is sysbuild.
 */
export function readDomainsForBuildDir(buildDir: string): ParsedDomainsYaml | undefined {
  if (!buildDir) {
    return undefined;
  }
  return readDomainsYamlFile(path.join(buildDir, DOMAINS_YAML_FILENAME));
}

export function getDomainBuildDir(parsed: ParsedDomainsYaml | undefined, domain: string): string | undefined {
  return parsed?.domains.find(entry => entry.name === domain)?.buildDir;
}
