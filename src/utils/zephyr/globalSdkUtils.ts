/**
 * Detection of Zephyr SDKs that are "globally discoverable" by the Zephyr
 * build system, i.e. SDKs a plain `west build` would find without any
 * workbench configuration. Mirrors the three discovery channels of
 * ${ZEPHYR_BASE}/cmake/modules/FindHostTools.cmake:
 *
 * - the CMake user package registry (written by the SDK's setup script:
 *   ~/.cmake/packages/Zephyr-sdk/* on POSIX, HKCU registry values on Windows);
 * - the recommended install locations scanned by Zephyr-sdk's find logic
 *   (home dir, /opt, /usr/local, Program Files, ...);
 * - the ZEPHYR_SDK_INSTALL_DIR environment variable.
 *
 * Pure Node module: no vscode import, so it stays unit-testable. No caching
 * here either; the vscode-side service layers caching on top.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { compareVersions } from '../versionUtils';

const execFileAsync = promisify(execFile);

export type GlobalSdkSource = 'cmake-registry' | 'default-location' | 'env';

export interface DetectedGlobalSdk {
  /** Realpath of the SDK root. */
  path: string;
  /** First line of <root>/sdk_version, trimmed. */
  version: string;
  /** Merged discovery channels, in canonical order. */
  sources: GlobalSdkSource[];
}

const SOURCE_ORDER: GlobalSdkSource[] = ['cmake-registry', 'default-location', 'env'];

const SDK_DIR_PATTERN = /^zephyr-sdk-/i;

/** Same semantics as ZephyrSdkInstallation.isSdkPath: a root holds a sdk_version file. */
function isSdkRoot(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, 'sdk_version'));
  } catch {
    return false;
  }
}

function readSdkVersion(sdkRoot: string): string | undefined {
  try {
    return fs.readFileSync(path.join(sdkRoot, 'sdk_version'), 'utf-8').split(/\r?\n/)[0].trim();
  } catch {
    return undefined;
  }
}

/** Immediate zephyr-sdk-* children of a directory that are valid SDK roots. */
function listSdkChildren(baseDir: string): string[] {
  try {
    return fs
      .readdirSync(baseDir)
      .filter(name => SDK_DIR_PATTERN.test(name))
      .map(name => path.join(baseDir, name))
      .filter(isSdkRoot);
  } catch {
    // ENOENT / EACCES / ENOTDIR on a candidate base dir just means no SDKs there.
    return [];
  }
}

/**
 * Maps one CMake package registry entry to an SDK root, or undefined when the
 * entry does not describe a valid SDK. The registered content is the package
 * config dir, typically <sdkRoot>/cmake (that is what the SDK's setup script
 * registers), so the SDK root is the entry's PARENT directory; the entry
 * itself is accepted too in case a root was registered directly. Registry
 * files may carry trailing whitespace or a newline.
 */
export function resolveSdkRootFromRegistryEntry(configDir: string): string | undefined {
  const trimmed = configDir.split(/\r?\n/)[0].trim();
  if (!trimmed) {
    return undefined;
  }
  if (isSdkRoot(trimmed)) {
    return trimmed;
  }
  const parent = path.dirname(trimmed);
  if (parent !== trimmed && isSdkRoot(parent)) {
    return parent;
  }
  return undefined;
}

/**
 * Parses `reg.exe query HKCU\...\Packages\Zephyr-sdk` output into
 * (value name, data) pairs. Data lines look like
 * "    <hash>    REG_SZ    C:\zephyr-sdk-0.17.0\cmake"; splitting on the
 * REG_SZ column keeps paths that contain spaces intact.
 */
export function parseRegQueryOutput(stdout: string): { key: string; configDir: string }[] {
  const entries: { key: string; configDir: string }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.split(/\s+REG_SZ\s+/);
    if (parts.length < 2) {
      continue;
    }
    const key = parts[0].trim();
    const configDir = parts.slice(1).join(' REG_SZ ').trim();
    if (key && configDir) {
      entries.push({ key, configDir });
    }
  }
  return entries;
}

export interface CmakeRegistryEntryRef {
  /** POSIX: file name under ~/.cmake/packages/Zephyr-sdk. Windows: registry value name. */
  key: string;
  /** The registered package config dir content (typically <sdkRoot>/cmake). */
  configDir: string;
}

const CMAKE_REGISTRY_WINDOWS_KEY = 'HKCU\\Software\\Kitware\\CMake\\Packages\\Zephyr-sdk';

function cmakeRegistryPosixDir(): string {
  return path.join(os.homedir(), '.cmake', 'packages', 'Zephyr-sdk');
}

function readCmakeRegistryEntriesPosix(): CmakeRegistryEntryRef[] {
  let entryNames: string[];
  try {
    entryNames = fs.readdirSync(cmakeRegistryPosixDir());
  } catch {
    return [];
  }
  const entries: CmakeRegistryEntryRef[] = [];
  for (const name of entryNames) {
    try {
      entries.push({ key: name, configDir: fs.readFileSync(path.join(cmakeRegistryPosixDir(), name), 'utf-8') });
    } catch {
      // Unreadable registry entry: skip it, keep scanning the others.
    }
  }
  return entries;
}

async function readCmakeRegistryEntriesWindows(): Promise<CmakeRegistryEntryRef[]> {
  try {
    const result = await execFileAsync('reg.exe', ['query', CMAKE_REGISTRY_WINDOWS_KEY]);
    return parseRegQueryOutput(result.stdout);
  } catch {
    // reg.exe exits non-zero when the key does not exist, which just means
    // no SDK ever registered itself: an empty result, not an error.
    return [];
  }
}

async function readCmakeRegistryEntries(): Promise<CmakeRegistryEntryRef[]> {
  return process.platform === 'win32' ? readCmakeRegistryEntriesWindows() : readCmakeRegistryEntriesPosix();
}

async function readCmakeRegistry(): Promise<string[]> {
  const roots: string[] = [];
  for (const entry of await readCmakeRegistryEntries()) {
    const root = resolveSdkRootFromRegistryEntry(entry.configDir);
    if (root) {
      roots.push(root);
    }
  }
  return roots;
}

function defaultLocationBaseDirs(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const dirs = [home];
    const { HOMEDRIVE: homeDrive, HOMEPATH: homePath } = process.env;
    if (homeDrive && homePath) {
      const drivePath = path.join(homeDrive, homePath);
      if (drivePath.toLowerCase() !== home.toLowerCase()) {
        dirs.push(drivePath);
      }
    }
    for (const envDir of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (envDir) {
        dirs.push(envDir);
      }
    }
    return dirs;
  }
  return [
    home,
    path.join(home, '.local'),
    path.join(home, '.local', 'opt'),
    path.join(home, 'bin'),
    '/opt',
    '/usr/local',
    '/usr',
  ];
}

function scanDefaultLocations(): string[] {
  const roots: string[] = [];
  for (const baseDir of defaultLocationBaseDirs()) {
    if (isSdkRoot(baseDir)) {
      roots.push(baseDir);
    }
    roots.push(...listSdkChildren(baseDir));
  }
  return roots;
}

function envChannel(): string[] {
  const envDir = process.env.ZEPHYR_SDK_INSTALL_DIR;
  if (!envDir) {
    return [];
  }
  if (isSdkRoot(envDir)) {
    return [envDir];
  }
  // The variable may also point at a parent dir holding several SDKs.
  return listSdkChildren(envDir);
}

function dedupKeyForPath(sdkPath: string): string {
  // Windows and default macOS filesystems are case-insensitive, and realpath
  // does not canonicalize the case of a user-typed path, so fold it here.
  return process.platform === 'win32' || process.platform === 'darwin'
    ? sdkPath.toLowerCase()
    : sdkPath;
}

/**
 * Merges per-channel candidates into the final list: dedup by path
 * (case-insensitive on win32 and darwin), union of sources in canonical order,
 * sorted by version descending with the path as ascending tie-break. Callers
 * are expected to have applied realpath to the candidate paths already.
 */
export function mergeAndSortCandidates(
  candidates: { path: string; version: string; source: GlobalSdkSource }[],
): DetectedGlobalSdk[] {
  const byPath = new Map<string, DetectedGlobalSdk>();
  for (const candidate of candidates) {
    const key = dedupKeyForPath(candidate.path);
    const existing = byPath.get(key);
    if (existing) {
      if (!existing.sources.includes(candidate.source)) {
        existing.sources.push(candidate.source);
      }
    } else {
      byPath.set(key, {
        path: candidate.path,
        version: candidate.version,
        sources: [candidate.source],
      });
    }
  }
  const merged = [...byPath.values()];
  for (const sdk of merged) {
    sdk.sources.sort((a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b));
  }
  merged.sort(
    (a, b) => compareVersions(b.version, a.version) || a.path.localeCompare(b.path),
  );
  return merged;
}

async function toRealpath(sdkPath: string): Promise<string> {
  try {
    return await fs.promises.realpath(sdkPath);
  } catch {
    return path.resolve(sdkPath);
  }
}

/**
 * Detects every SDK visible through at least one global discovery channel.
 * Never rejects: a broken channel contributes nothing, worst case is [].
 */
export async function detectGlobalSdks(): Promise<DetectedGlobalSdk[]> {
  const channels: { source: GlobalSdkSource; run: () => Promise<string[]> }[] = [
    { source: 'cmake-registry', run: () => readCmakeRegistry() },
    { source: 'default-location', run: async () => scanDefaultLocations() },
    { source: 'env', run: async () => envChannel() },
  ];

  const candidates: { path: string; version: string; source: GlobalSdkSource }[] = [];
  for (const channel of channels) {
    let roots: string[];
    try {
      roots = await channel.run();
    } catch {
      continue;
    }
    for (const root of roots) {
      const realRoot = await toRealpath(root);
      const version = readSdkVersion(realRoot);
      if (version === undefined) {
        continue;
      }
      candidates.push({ path: realRoot, version, source: channel.source });
    }
  }
  return mergeAndSortCandidates(candidates);
}

/**
 * Which global channels expose the given SDK path, or undefined when the SDK
 * is not globally discoverable at all.
 */
export async function getGlobalSourcesForPath(
  sdkPath: string,
): Promise<GlobalSdkSource[] | undefined> {
  const realPath = await toRealpath(sdkPath);
  const key = dedupKeyForPath(realPath);
  const detected = await detectGlobalSdks();
  return detected.find(sdk => dedupKeyForPath(sdk.path) === key)?.sources;
}

/**
 * Comparison keys an SDK path is known by: the (real)path itself, normalized
 * and case-folded like dedupKeyForPath. Falls back to the resolved path when
 * the directory no longer exists, so entries can still be matched for cleanup
 * after the SDK folder was deleted.
 */
function sdkPathKeys(sdkPath: string): string[] {
  const keys = new Set<string>();
  keys.add(dedupKeyForPath(path.normalize(path.resolve(sdkPath))));
  try {
    keys.add(dedupKeyForPath(path.normalize(fs.realpathSync(sdkPath))));
  } catch {
    // Deleted or dangling path: the resolved key above is all we have.
  }
  return [...keys];
}

/**
 * Keys a registry entry's content can stand for: the registered dir and its
 * parent (the SDK root, since the setup script registers <sdkRoot>/cmake).
 * Pure string/path work so it also matches entries whose target was deleted.
 * Exported for unit tests.
 */
export function registryEntryTargetKeys(configDir: string): string[] {
  const firstLine = configDir.split(/\r?\n/)[0].trim();
  if (!firstLine) {
    return [];
  }
  const keys = new Set<string>();
  for (const candidate of [firstLine]) {
    const normalized = path.normalize(path.resolve(candidate));
    keys.add(dedupKeyForPath(normalized));
    const parent = path.dirname(normalized);
    if (parent !== normalized) {
      keys.add(dedupKeyForPath(parent));
    }
    try {
      const real = fs.realpathSync(normalized);
      keys.add(dedupKeyForPath(path.normalize(real)));
      const realParent = path.dirname(real);
      if (realParent !== real) {
        keys.add(dedupKeyForPath(path.normalize(realParent)));
      }
    } catch {
      // Entry points at a deleted dir: the string-based keys still match.
    }
  }
  return [...keys];
}

/** CMake package registry entries that register the given SDK (or its cmake dir). */
export async function findCmakeRegistryEntriesForSdk(sdkPath: string): Promise<CmakeRegistryEntryRef[]> {
  const targetKeys = new Set(sdkPathKeys(sdkPath));
  const entries = await readCmakeRegistryEntries();
  return entries.filter(entry => registryEntryTargetKeys(entry.configDir).some(key => targetKeys.has(key)));
}

/**
 * Removes the CMake package registry entries registering the given SDK
 * (POSIX: unlink the entry file; Windows: delete the registry value). Best
 * effort per entry; returns how many were removed. Works after the SDK folder
 * was already deleted, so callers can clean up stale registrations.
 */
export async function removeCmakeRegistryEntriesForSdk(sdkPath: string): Promise<number> {
  const matches = await findCmakeRegistryEntriesForSdk(sdkPath);
  let removed = 0;
  for (const entry of matches) {
    try {
      if (process.platform === 'win32') {
        await execFileAsync('reg.exe', ['delete', CMAKE_REGISTRY_WINDOWS_KEY, '/v', entry.key, '/f']);
      } else {
        await fs.promises.unlink(path.join(cmakeRegistryPosixDir(), entry.key));
      }
      removed++;
    } catch {
      // A failed entry removal must not abort the remaining ones.
    }
  }
  return removed;
}
