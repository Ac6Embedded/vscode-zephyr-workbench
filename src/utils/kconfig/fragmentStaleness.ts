// Reads the ordered Kconfig fragment list a build was generated from, and detects
// whether those fragments changed since `.config` was produced.
//
// Zephyr records the merge list in <build>/build_info.yml (cmake.kconfig.files) and
// maintains <build>/zephyr/.cmake.dotconfig.checksum: the concatenation of one 32-char
// MD5 per fragment (in list order) followed by one per parsed Kconfig source file.
// Comparing the fragment MD5s against the checksum prefix answers "did the project's
// config files change after .config was generated" without re-running CMake.
//
// This module is deliberately vscode-free (fs/crypto/yaml only) so it can be unit-tested.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import yaml from 'yaml';

export interface KconfigFragmentInfo {
  /** Full ordered merge list (board defconfig first, later entries override earlier). */
  files: string[];
  /** CONF_FILE entries (the app prj.conf), in order. */
  userFiles: string[];
  /** EXTRA_CONF_FILE entries (extra fragments, snippets), in order. */
  extraUserFiles: string[];
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) { return []; }
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/** Read the fragment lists from a build_info.yml. Returns undefined when unusable. */
export function readKconfigFragments(buildInfoYmlPath: string): KconfigFragmentInfo | undefined {
  let parsed: any;
  try {
    parsed = yaml.parse(fs.readFileSync(buildInfoYmlPath, 'utf8'));
  } catch {
    return undefined;
  }
  const kconfig = parsed?.cmake?.kconfig;
  const files = toStringArray(kconfig?.files);
  if (files.length === 0) { return undefined; }
  return {
    files,
    userFiles: toStringArray(kconfig?.['user-files']),
    extraUserFiles: toStringArray(kconfig?.['extra-user-files']),
  };
}

/** Locate build_info.yml for an inner build dir (domain dir first, then its parent for sysbuild roots). */
export function findBuildInfoYml(innerBuildDir: string): string | undefined {
  const candidates = [
    path.join(innerBuildDir, 'build_info.yml'),
    path.join(path.dirname(innerBuildDir), 'build_info.yml'),
  ];
  return candidates.find((c) => fs.existsSync(c));
}

export interface FragmentStalenessResult {
  stale: boolean;
  reason?: string;
}

function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/**
 * Compare the current state of the build inputs with the stored checksum: first one MD5
 * per fragment (in list order), then one per parsed Kconfig source file (listed in
 * <build>/zephyr/kconfig/sources.txt). This mirrors CMake's own re-merge decision, so
 * "stale" here means the next configure would regenerate .config. Any missing input
 * conservatively reports stale (the baseline may not match).
 *
 * A sysbuild image lists one more file than the checksum covers: the FORCED_CONF_FILE
 * sysbuild writes at <image>/zephyr/.config.sysbuild. kconfig.cmake applies it on every
 * configure, on top of .config, and leaves it out of the checksum, so it is skipped here
 * too. Comparing it would shift every later hash by one and report each sysbuild image
 * stale forever. The caller's list keeps it, because a merge must still end with it.
 */
export function checkFragmentStaleness(innerBuildDir: string, fragmentList: string[]): FragmentStalenessResult {
  const forced = path.join(innerBuildDir, 'zephyr', '.config.sysbuild');
  // Also matched by its name as the last entry, where CMake puts it, in case the build
  // recorded the image folder with another spelling (case, a link) than the caller's.
  const isForced = (f: string, index: number) => samePath(f, forced)
    || (index === fragmentList.length - 1 && path.basename(f) === '.config.sysbuild' && path.basename(path.dirname(f)) === 'zephyr');
  const fragments = fragmentList.filter((f, index) => !isForced(f, index));
  const checksumPath = path.join(innerBuildDir, 'zephyr', '.cmake.dotconfig.checksum');
  let stored: string;
  try {
    stored = fs.readFileSync(checksumPath, 'utf8').trim();
  } catch {
    return { stale: true, reason: 'checksum file missing' };
  }
  if (stored.length < fragments.length * 32) {
    return { stale: true, reason: 'checksum shorter than the fragment list' };
  }
  for (let i = 0; i < fragments.length; i++) {
    let content: Buffer;
    try {
      content = fs.readFileSync(fragments[i]);
    } catch {
      return { stale: true, reason: `fragment missing: ${path.basename(fragments[i])}` };
    }
    const md5 = crypto.createHash('md5').update(content).digest('hex');
    if (stored.slice(i * 32, i * 32 + 32) !== md5) {
      return { stale: true, reason: `changed since the last configure: ${path.basename(fragments[i])}` };
    }
  }

  // Remainder of the checksum: the parsed Kconfig sources. A mismatch means the Kconfig
  // tree itself changed (for example a Zephyr update), which shifts defaults and makes
  // the drift list include those shifts.
  const sourcesPath = path.join(innerBuildDir, 'zephyr', 'kconfig', 'sources.txt');
  let sources: string[];
  try {
    sources = fs.readFileSync(sourcesPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return { stale: true, reason: 'Kconfig sources list missing' };
  }
  const tail = stored.slice(fragments.length * 32);
  if (tail.length !== sources.length * 32) {
    return { stale: true, reason: 'Kconfig source list changed since the last configure' };
  }
  for (let i = 0; i < sources.length; i++) {
    let content: Buffer;
    try {
      content = fs.readFileSync(sources[i]);
    } catch {
      return { stale: true, reason: `Kconfig source missing: ${path.basename(sources[i])}` };
    }
    const md5 = crypto.createHash('md5').update(content).digest('hex');
    if (tail.slice(i * 32, i * 32 + 32) !== md5) {
      return { stale: true, reason: `Kconfig sources changed since the last configure (${path.basename(sources[i])})` };
    }
  }
  return { stale: false };
}

/**
 * Fragments that merge after an export target, whose assignments therefore win over it.
 * For the prj.conf target the anchor falls back to the first CONF_FILE entry when the
 * given path is not in the list. A fragment not in the list yet would merge at the
 * EXTRA_CONF_FILE position.
 */
export function fragmentsMergedAfter(info: KconfigFragmentInfo, targetPath: string, isPrjTarget: boolean): string[] {
  const files = info.files;
  let anchor = files.findIndex((f) => samePath(f, targetPath));
  if (isPrjTarget) {
    if (anchor < 0 && info.userFiles.length > 0) {
      anchor = files.findIndex((f) => samePath(f, info.userFiles[0]));
    }
  } else if (anchor < 0) {
    // New fragment: it would merge at the EXTRA_CONF_FILE position; only the
    // generated CLI options file and build-dir *.conf glob come after.
    const lastExtra = info.extraUserFiles.length
      ? files.findIndex((f) => samePath(f, info.extraUserFiles[info.extraUserFiles.length - 1]))
      : -1;
    anchor = lastExtra >= 0 ? lastExtra : files.length - 1;
  }
  return anchor >= 0 ? files.slice(anchor + 1) : [];
}

/**
 * The merge list the next configure would use once `targetPath` holds new content, with
 * `standIn` (a temporary copy of that content) in its place.
 *
 * A target already in the list is replaced where it is. A new fragment is inserted where
 * EXTRA_CONF_FILE entries merge: after the last one, or when there are none, before the
 * first file the build generates inside `buildDir` (extra_kconfig_options.conf from
 * -DCONFIG_ flags, the build-dir *.conf glob), which Zephyr always merges last.
 */
export function mergeListWithTarget(
  info: KconfigFragmentInfo, targetPath: string, standIn: string, buildDir: string,
): { files: string[]; inBuild: boolean } {
  const index = info.files.findIndex((f) => samePath(f, targetPath));
  if (index >= 0) {
    const files = [...info.files];
    files[index] = standIn;
    return { files, inBuild: true };
  }
  let insertAt = -1;
  const lastExtra = info.extraUserFiles.length
    ? info.files.findIndex((f) => samePath(f, info.extraUserFiles[info.extraUserFiles.length - 1]))
    : -1;
  if (lastExtra >= 0) {
    insertAt = lastExtra + 1;
  } else {
    const root = path.resolve(buildDir) + path.sep;
    insertAt = info.files.findIndex((f) => (path.resolve(f) + path.sep).startsWith(root));
    if (insertAt < 0) { insertAt = info.files.length; }
  }
  const files = [...info.files];
  files.splice(insertAt, 0, standIn);
  return { files, inBuild: false };
}

/** One `CONFIG_FOO=...` (or `# CONFIG_FOO is not set`) line in a fragment. */
export interface FragmentAssignment {
  file: string;
  /** 1-based. */
  line: number;
  /** The text after `=`, or `n` for the `is not set` form. */
  value: string;
}

/**
 * Every assignment of the given symbols (names WITHOUT the CONFIG_ prefix) in the given
 * fragments, in merge order, so the last entry per name is the one that wins.
 * Unreadable files are skipped, as the build would fail on them anyway.
 */
export function findFragmentAssignments(fragments: string[], names: string[]): Map<string, FragmentAssignment[]> {
  const out = new Map<string, FragmentAssignment[]>();
  if (names.length === 0) { return out; }
  const wanted = new Set(names);
  for (const file of fragments) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    text.split(/\r?\n/).forEach((line, index) => {
      let name: string | undefined;
      let value: string | undefined;
      const set = /^\s*CONFIG_([A-Za-z0-9_]+)\s*=(.*)$/.exec(line);
      if (set) {
        name = set[1];
        value = set[2].trim();
      } else {
        const unset = /^\s*#\s*CONFIG_([A-Za-z0-9_]+)\s+is not set\s*$/.exec(line);
        if (unset) {
          name = unset[1];
          value = 'n';
        }
      }
      if (name && value !== undefined && wanted.has(name)) {
        const list = out.get(name) ?? [];
        list.push({ file, line: index + 1, value });
        out.set(name, list);
      }
    });
  }
  return out;
}

/**
 * Scan fragments that merge AFTER the export target for assignments to the given
 * symbol names; such assignments override whatever the export writes.
 * Returns a map of symbol name -> first overriding fragment path.
 */
export function findLaterFragmentOverrides(laterFragments: string[], names: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (names.length === 0 || laterFragments.length === 0) { return out; }
  const wanted = new Set(names);
  for (const frag of laterFragments) {
    let text: string;
    try {
      text = fs.readFileSync(frag, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      let m = /^\s*CONFIG_([A-Za-z0-9_]+)\s*=/.exec(line);
      if (!m) { m = /^\s*#\s*CONFIG_([A-Za-z0-9_]+)\s+is not set\s*$/.exec(line); }
      if (m && wanted.has(m[1]) && !out.has(m[1])) {
        out.set(m[1], frag);
      }
    }
  }
  return out;
}
