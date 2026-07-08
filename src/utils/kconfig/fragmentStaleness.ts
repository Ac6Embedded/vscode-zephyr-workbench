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

/**
 * Compare the current state of the build inputs with the stored checksum: first one MD5
 * per fragment (in list order), then one per parsed Kconfig source file (listed in
 * <build>/zephyr/kconfig/sources.txt). This mirrors CMake's own re-merge decision, so
 * "stale" here means the next configure would regenerate .config. Any missing input
 * conservatively reports stale (the baseline may not match).
 */
export function checkFragmentStaleness(innerBuildDir: string, fragments: string[]): FragmentStalenessResult {
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
