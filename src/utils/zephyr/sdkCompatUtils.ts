import * as vscode from "vscode";
import fs from "fs";
import path from "path";

/**
 * Zephyr SDK <-> Zephyr version compatibility.
 *
 * Detection is matrix-first: the official sdk-ng compatibility matrix bundled at
 * res/data/sdk-compatibility-matrix.csv decides whenever it covers the (SDK, Zephyr)
 * pair. It is curated truth the build system cannot derive — e.g. SDK 0.17 requires
 * Zephyr >= 4.0, yet Zephyr 3.5-4.3 all declare the same `find_package(Zephyr-sdk 0.16)`
 * minimum, so pure version math would wrongly accept 0.17.x on Zephyr 3.7.
 *
 * For pairs the matrix doesn't know (future SDK/Zephyr releases, main-branch trees),
 * fall back to replicating the gate Zephyr's own build system applies:
 * - `find_package(Zephyr-sdk <MIN>)` in ${ZEPHYR_BASE}/cmake/modules/FindHostTools.cmake
 *   (present since Zephyr 3.2) sets the minimum SDK version;
 * - the SDK side (Zephyr-sdkConfigVersion.cmake) additionally makes SDK >= 1.0 refuse
 *   requests below 1.0, i.e. older Zephyr trees cannot use SDK 1.x.
 *
 * ${ZEPHYR_BASE}/SDK_VERSION (since Zephyr 3.6) holds the *recommended* SDK version
 * (what `west sdk install` would pick); it is only used to enrich messages.
 * When neither source can answer, the verdict is 'unknown' and callers stay silent.
 */

export const SDK_COMPATIBILITY_MATRIX_URL = 'https://github.com/zephyrproject-rtos/sdk-ng/wiki/Zephyr-Version-Compatibility';

export interface SdkCompatVerdict {
  status: 'compatible' | 'partial' | 'incompatible' | 'unknown';
  zephyrVersion?: string;
  minSdk?: string;
  recommendedSdk?: string;
  source?: 'cmake' | 'matrix';
}

/** Numeric dot-segment version compare; ignores any non-numeric suffix (e.g. "0.16.5-1"). */
function cmpVer(a: string, b: string): number {
  const parse = (v: string) => v.trim().split('.').map(seg => parseInt(seg, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) { return da < db ? -1 : 1; }
  }
  return 0;
}

function readFirstLine(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf-8').split(/\r?\n/)[0].trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Parse "KEY = value" lines of ${ZEPHYR_BASE}/VERSION into "major.minor.patch". */
function readZephyrVersion(zephyrBasePath: string): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(path.join(zephyrBasePath, 'VERSION'), 'utf-8');
  } catch {
    return undefined;
  }
  const values: { [key: string]: string } = {};
  const keyValuePattern = /^([\w_]+)\s*=\s*(.*)$/gm;
  let match: RegExpExecArray | null;
  while ((match = keyValuePattern.exec(content)) !== null) {
    values[match[1].trim()] = match[2].trim();
  }
  if (!values['VERSION_MAJOR']) {
    return undefined;
  }
  return `${values['VERSION_MAJOR']}.${values['VERSION_MINOR'] ?? '0'}.${values['PATCHLEVEL'] ?? '0'}`;
}

/** Minimum SDK version required by this Zephyr tree (the cmake gate), if declared. */
function readMinSdkVersion(zephyrBasePath: string): string | undefined {
  const findHostTools = path.join(zephyrBasePath, 'cmake', 'modules', 'FindHostTools.cmake');
  let content: string;
  try {
    content = fs.readFileSync(findHostTools, 'utf-8');
  } catch {
    return undefined;
  }
  const match = content.match(/find_package\(Zephyr-sdk\s+([0-9][0-9.]*)/);
  return match ? match[1] : undefined;
}

// ---------------------------------------------------------------------------
// Bundled official compatibility matrix (fallback for old Zephyr trees)
// ---------------------------------------------------------------------------

type CompatMatrix = {
  zephyrColumns: string[];                          // e.g. ['main', 'collab-sdk-dev', '4.4.0', ...]
  rows: Map<string, string[]>;                      // sdk version -> Y/P/N per column
};

let cachedMatrix: CompatMatrix | null | undefined;  // undefined = not loaded, null = load failed

function loadMatrix(): CompatMatrix | null {
  if (cachedMatrix !== undefined) {
    return cachedMatrix;
  }
  try {
    // Bundled layout: out/extension.js -> <root>/res/...; source layout (ts-node
    // unit tests): src/utils/zephyr/*.ts -> <root>/res/...
    const candidates = [
      path.join(__filename, '..', '..', 'res', 'data', 'sdk-compatibility-matrix.csv'),
      path.join(__filename, '..', '..', '..', '..', 'res', 'data', 'sdk-compatibility-matrix.csv'),
    ];
    const csvPath = candidates.find(p => fs.existsSync(p)) ?? candidates[0];
    const lines = fs.readFileSync(csvPath, 'utf-8').split(/\r?\n/).filter(l => l.trim() !== '');
    const zephyrColumns = lines[0].split(',').slice(1).map(c => c.trim());
    const rows = new Map<string, string[]>();
    for (const line of lines.slice(1)) {
      const cells = line.split(',').map(c => c.trim());
      rows.set(cells[0], cells.slice(1));
    }
    cachedMatrix = { zephyrColumns, rows };
  } catch {
    cachedMatrix = null;
  }
  return cachedMatrix;
}

function matrixVerdict(sdkVersion: string, zephyrVersion: string): 'compatible' | 'partial' | 'incompatible' | 'unknown' {
  const matrix = loadMatrix();
  if (!matrix) {
    return 'unknown';
  }
  // Row: exact SDK version, retrying without a "-suffix" (e.g. "0.16.5-1" -> "0.16.5")
  const row = matrix.rows.get(sdkVersion) ?? matrix.rows.get(sdkVersion.split('-')[0]);
  if (!row) {
    return 'unknown';
  }
  // Column: same Zephyr major.minor series (4.4.1 -> "4.4.0")
  const [major, minor] = sdkVersionParts(zephyrVersion);
  const colIdx = matrix.zephyrColumns.findIndex(col => {
    const [colMajor, colMinor] = sdkVersionParts(col);
    return colMajor === major && colMinor === minor;
  });
  if (colIdx < 0 || !row[colIdx]) {
    return 'unknown';
  }
  switch (row[colIdx].toUpperCase()) {
    case 'Y': return 'compatible';
    case 'P': return 'partial';
    case 'N': return 'incompatible';
    default: return 'unknown';
  }
}

function sdkVersionParts(version: string): number[] {
  return version.trim().split('.').map(seg => parseInt(seg, 10));
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const verdictCache = new Map<string, SdkCompatVerdict>();

export function clearSdkCompatCache(): void {
  verdictCache.clear();
}

/**
 * Compatibility verdict for a Zephyr SDK version against the Zephyr tree at
 * `zephyrBasePath` (= ZEPHYR_BASE, e.g. `westWorkspace.kernelUri.fsPath`).
 * Never throws; anything unreadable yields status 'unknown'.
 */
export function checkSdkCompatibility(sdkVersion: string | undefined, zephyrBasePath: string): SdkCompatVerdict {
  const sdk = sdkVersion?.trim();
  if (!sdk) {
    return { status: 'unknown' };
  }
  const cacheKey = `${sdk}|${zephyrBasePath}`;
  const cached = verdictCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const zephyrVersion = readZephyrVersion(zephyrBasePath);
  const recommendedSdk = readFirstLine(path.join(zephyrBasePath, 'SDK_VERSION'));
  let verdict: SdkCompatVerdict = { status: 'unknown', zephyrVersion, recommendedSdk };

  // The curated matrix wins whenever it covers the pair (see module header:
  // the cmake gate is minimum-only and cannot express SDK upper bounds).
  const matrixStatus = zephyrVersion ? matrixVerdict(sdk, zephyrVersion) : 'unknown';
  if (matrixStatus !== 'unknown') {
    verdict = { status: matrixStatus, zephyrVersion, recommendedSdk, source: 'matrix' };
  } else {
    const minSdk = readMinSdkVersion(zephyrBasePath);
    if (minSdk) {
      // Replicate the cmake gate: SDK must satisfy the minimum, and an SDK >= 1.0
      // declares itself incompatible with Zephyr trees requiring less than 1.0.
      let status: SdkCompatVerdict['status'] = 'compatible';
      if (cmpVer(sdk, minSdk) < 0) {
        status = 'incompatible';
      } else if (sdkVersionParts(sdk)[0] >= 1 && cmpVer(minSdk, '1.0') < 0) {
        status = 'incompatible';
      }
      verdict = { status, zephyrVersion, minSdk, recommendedSdk, source: 'cmake' };
    }
  }

  verdictCache.set(cacheKey, verdict);
  return verdict;
}

/** One-line human message for a non-compatible verdict (undefined when nothing to say). */
export function formatSdkCompatMessage(verdict: SdkCompatVerdict, sdkVersion: string | undefined): string | undefined {
  if (verdict.status !== 'incompatible' && verdict.status !== 'partial') {
    return undefined;
  }
  const sdk = sdkVersion?.trim() ?? 'unknown';
  const zephyr = verdict.zephyrVersion ?? 'unknown';
  const recommended = verdict.recommendedSdk ? ` (recommended SDK: ${verdict.recommendedSdk})` : '';
  if (verdict.status === 'partial') {
    return `Zephyr SDK ${sdk} is only partially compatible with Zephyr ${zephyr}${recommended}.`;
  }
  return `Zephyr SDK ${sdk} may be incompatible with Zephyr ${zephyr}${recommended}.`;
}

/**
 * Show the non-blocking compatibility warning when the verdict warrants one.
 * Fire-and-forget: never await this from an assignment flow.
 */
export function showSdkCompatWarning(verdict: SdkCompatVerdict, sdkVersion: string | undefined): void {
  const message = formatSdkCompatMessage(verdict, sdkVersion);
  if (!message) {
    return;
  }
  const openMatrix = 'Open Compatibility Matrix';
  vscode.window.showWarningMessage(message, openMatrix).then(choice => {
    if (choice === openMatrix) {
      vscode.env.openExternal(vscode.Uri.parse(SDK_COMPATIBILITY_MATRIX_URL));
    }
  });
}
