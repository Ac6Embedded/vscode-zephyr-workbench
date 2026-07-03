import { execFile } from "child_process";
import * as fs from 'fs';
import path from "path";
import * as vscode from "vscode";
import yaml from 'yaml';
import { execCommandWithEnv } from "./execUtils";
import { getInternalDirRealPath } from "./utils";
import { getHostToolsParts, HostToolsPartDef } from "./hostToolsPartsRegistry";

/**
 * Read-only status helpers for the host tools install: version lookup via the
 * installer's -OnlyCheck/--only-check mode, zinstaller-truthful presence
 * probes for the per-part artifacts, and python interpreter probing for the
 * system/custom python sources. Shared by the Host Tools Manager and the
 * Advanced Host Tools Installation panels.
 */

/** Minimum recommended python version surfaced as a warning in the UI. */
export const PYTHON_MIN_RECOMMENDED = '3.12';

/**
 * Artifact written by each installable part, relative to the .zinstaller
 * directory, derived from the per-OS parts registry. Presence of the artifact
 * means the part is installed there, regardless of what a system-wide tool on
 * PATH would report.
 */
export const HOST_TOOLS_PART_ARTIFACTS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const p of getHostToolsParts()) {
    if (p.probe.artifact) {
      map[p.id] = p.probe.artifact;
    }
  }
  return map;
})();

/** Filesystem probe of one part (artifact path or version-prefixed folder scan). */
function probeArtifactSync(baseDir: string, part: HostToolsPartDef): boolean {
  try {
    if (part.probe.artifact && fs.existsSync(path.join(baseDir, part.probe.artifact))) {
      return true;
    }
    if (part.probe.artifactPrefixScan) {
      const scan = part.probe.artifactPrefixScan;
      const dir = path.join(baseDir, scan.dir);
      const names = fs.readdirSync(dir);
      return names.some(n => n.startsWith(scan.prefix) && fs.existsSync(path.join(dir, n, scan.suffix)));
    }
  } catch { }
  return false;
}

/**
 * Filesystem presence of every part artifact under the .zinstaller dir.
 * Parts probed by command or check-output (darwin brew tools, the linux
 * system-packages row) come back false here; use probeHostToolsPresence for
 * the complete per-OS picture.
 */
export function probeHostToolsPartsPresence(): Record<string, boolean> {
  const baseDir = getInternalDirRealPath();
  const presence: Record<string, boolean> = {};
  for (const p of getHostToolsParts()) {
    presence[p.id] = probeArtifactSync(baseDir, p);
  }
  return presence;
}

export interface HomebrewProbeResult {
  ok: boolean;
  prefix?: string;
  brewPath?: string;
}

/**
 * Detect Homebrew even when the extension host was launched from the GUI and
 * misses the brew dir on PATH: try `brew` first, then the two fixed install
 * locations (Apple Silicon and Intel).
 */
export async function probeHomebrew(): Promise<HomebrewProbeResult> {
  const candidates = ['brew', '/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
  for (const candidate of candidates) {
    const result = await new Promise<HomebrewProbeResult | undefined>((resolve) => {
      execFile(candidate, ['--prefix'], { timeout: 10000 }, (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const prefix = String(stdout).split(/\r?\n/)[0]?.trim();
        resolve({ ok: true, prefix: prefix || undefined, brewPath: candidate });
      });
    });
    if (result) {
      return result;
    }
  }
  return { ok: false };
}

async function commandExists(cmd: string, extraDirs: string[]): Promise<boolean> {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  const onPath = await new Promise<boolean>((resolve) => {
    execFile(whichCmd, [cmd], { timeout: 5000 }, (error) => resolve(!error));
  });
  if (onPath) {
    return true;
  }
  for (const dir of extraDirs) {
    try {
      fs.accessSync(path.join(dir, cmd), fs.constants.X_OK);
      return true;
    } catch { }
  }
  return false;
}

/** All commands resolvable on PATH or as executables under one of extraDirs. */
export async function probeCommandsPresent(cmds: string[], extraDirs: string[] = []): Promise<boolean> {
  for (const cmd of cmds) {
    if (!await commandExists(cmd, extraDirs)) {
      return false;
    }
  }
  return true;
}

/**
 * Registry-driven presence probe covering every probe kind: filesystem
 * artifacts, commands (checked under the brew prefix too on darwin) and
 * check-output version keys (the linux system-packages row). Pass the
 * versions map when the caller already ran fetchHostToolsCheckedVersions;
 * otherwise it is fetched on demand when a part needs it and extensionUri is
 * provided.
 */
export async function probeHostToolsPresence(
  extensionUri?: vscode.Uri,
  versions?: Record<string, string>
): Promise<Record<string, boolean>> {
  const baseDir = getInternalDirRealPath();
  const parts = getHostToolsParts();
  const presence: Record<string, boolean> = {};

  let extraDirs: string[] = [];
  if (process.platform === 'darwin' && parts.some(p => p.probe.cmds)) {
    const brew = await probeHomebrew();
    if (brew.ok && brew.prefix) {
      extraDirs = [path.join(brew.prefix, 'bin')];
    }
  }

  let versionMap = versions;
  for (const p of parts) {
    let ok = probeArtifactSync(baseDir, p);
    if (!ok && p.probe.cmds) {
      ok = await probeCommandsPresent(p.probe.cmds, extraDirs);
    }
    if (!ok && p.probe.versionKeysAllOf) {
      if (!versionMap && extensionUri) {
        versionMap = await fetchHostToolsCheckedVersions(extensionUri);
      }
      const vm = versionMap ?? {};
      ok = p.probe.versionKeysAllOf.every(k => {
        const v = vm[k];
        return typeof v === 'string' && v.length > 0 && v.toUpperCase() !== 'NOT INSTALLED';
      });
    }
    presence[p.id] = ok;
  }
  return presence;
}

/**
 * Run the installer in -OnlyCheck mode and parse its `name [version]` lines
 * into a lowercased name -> version map (`.exe` suffixes stripped). Returns
 * an empty map on any failure; callers decide whether to keep previous data.
 * Extracted from HostToolsPanel so both panels share the single parser of the
 * byte-stable -OnlyCheck output contract.
 */
export async function fetchHostToolsCheckedVersions(extensionUri: vscode.Uri): Promise<Record<string, string>> {
  try {
    const scriptsDir = vscode.Uri.joinPath(extensionUri, 'scripts', 'hosttools');
    const destDir = getInternalDirRealPath();

    let cmd = '';
    if (process.platform === 'win32') {
      const ps = vscode.Uri.joinPath(scriptsDir, 'install.ps1').fsPath;
      cmd = `powershell -File "${ps}" -OnlyCheck -InstallDir "${destDir}"`;
    } else if (process.platform === 'darwin') {
      const sh = vscode.Uri.joinPath(scriptsDir, 'install-mac.sh').fsPath;
      cmd = `bash "${sh}" --only-check "${destDir}"`;
    } else {
      const sh = vscode.Uri.joinPath(scriptsDir, 'install.sh').fsPath;
      cmd = `bash "${sh}" --only-check "${destDir}"`;
    }

    const proc = await execCommandWithEnv(cmd);

    let full = '';
    await new Promise<void>((resolve, reject) => {
      proc.stdout?.on('data', c => { full += c.toString(); });
      proc.stderr?.on('data', c => { full += c.toString(); });
      proc.on('error', e => reject(e));
      proc.on('close', _code => resolve());
    });

    const map: Record<string, string> = {};
    const lines = full.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('---')) { continue; }
      // Expect lines like: python [3.13.5] or 7z [24.08 (x64)]
      const m = line.match(/^(\S+)\s*\[(.+?)\]\s*$/);
      if (!m) { continue; }
      let name = m[1].toLowerCase();
      name = name.replace(/\.exe$/, '');
      const ver = m[2].trim();
      if (name && ver) {
        map[name] = ver;
      }
    }
    return map;
  } catch {
    return {};
  }
}

/**
 * Read the target versions from tools.yml (os.<platform>.version): the single
 * source of truth for what the installer is going to install, shared with the
 * install scripts (which build archive/folder names from the same values).
 * Returns tool-name -> version (e.g. cmake, ninja, gperf, dtc, git,
 * python_portable). Empty map on any failure.
 */
export function readHostToolsTargetVersions(
  extensionUri: vscode.Uri,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  try {
    const osKey = platform === 'win32' ? 'windows' : (platform === 'darwin' ? 'darwin' : 'linux');
    const ymlPath = vscode.Uri.joinPath(extensionUri, 'scripts', 'hosttools', 'tools.yml').fsPath;
    const data = yaml.parse(fs.readFileSync(ymlPath, 'utf8')) || {};
    const map: Record<string, string> = {};
    for (const section of ['other_content', 'zephyr_content']) {
      const list = Array.isArray(data[section]) ? data[section] : [];
      for (const entry of list) {
        const tool = entry?.tool;
        const version = entry?.os?.[osKey]?.version;
        if (tool && version !== undefined && version !== null) {
          map[String(tool)] = String(version);
        }
      }
    }
    return map;
  } catch {
    return {};
  }
}

export interface PythonProbeResult {
  ok: boolean;
  exePath?: string;
  version?: string;
  tooOld?: boolean;
  error?: string;
}

/** Numeric segment-wise version compare: true when a < b. */
export function versionLessThan(a: string, b: string): boolean {
  const pa = String(a).split('.').map(s => parseInt(s, 10));
  const pb = String(b).split('.').map(s => parseInt(s, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x < y) { return true; }
    if (x > y) { return false; }
  }
  return false;
}

/**
 * Probe a python interpreter WITHOUT sourcing the Zephyr environment script:
 * execCommandWithEnv would put the portable python on PATH and falsify a
 * "system" probe. execFile also avoids shell quoting for paths with spaces.
 * The Microsoft Store app-execution alias resolves as `python` but exits
 * non-zero, so it correctly lands in the "not detected" branch.
 */
export async function probePythonInterpreter(mode: 'system' | 'custom', customPath?: string): Promise<PythonProbeResult> {
  let exe = 'python';
  if (mode === 'custom') {
    const provided = (customPath ?? '').trim();
    if (!provided) {
      return { ok: false, error: 'No python path provided' };
    }
    let resolved = provided;
    try {
      if (fs.existsSync(provided) && fs.statSync(provided).isDirectory()) {
        resolved = path.join(provided, process.platform === 'win32' ? 'python.exe' : 'python');
      }
    } catch { }
    if (!fs.existsSync(resolved)) {
      return { ok: false, error: `Python executable not found: ${resolved}` };
    }
    exe = resolved;
  }

  return new Promise<PythonProbeResult>((resolve) => {
    execFile(
      exe,
      ['-c', 'import sys;print(sys.executable);print(sys.version.split()[0])'],
      { timeout: 10000 },
      (error, stdout) => {
        if (error) {
          resolve({
            ok: false,
            error: mode === 'system'
              ? 'No working Python detected on PATH'
              : 'The selected Python does not run',
          });
          return;
        }
        const lines = String(stdout).split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
        const exePath = lines[0];
        const version = lines[1];
        if (!exePath || !version) {
          resolve({ ok: false, error: 'Unexpected output from the python interpreter' });
          return;
        }
        resolve({
          ok: true,
          exePath,
          version,
          tooOld: versionLessThan(version, PYTHON_MIN_RECOMMENDED),
        });
      }
    );
  });
}
