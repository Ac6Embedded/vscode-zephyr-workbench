import { execFile } from "child_process";
import * as fs from 'fs';
import path from "path";
import * as vscode from "vscode";
import yaml from 'yaml';
import { execCommandWithEnv } from "./execUtils";
import { getInternalDirRealPath } from "./utils";

/**
 * Read-only status helpers for the host tools install: version lookup via the
 * installer's -OnlyCheck mode, zinstaller-truthful presence probes for the
 * per-part artifacts, and python interpreter probing for the system/custom
 * python sources. Shared by the Host Tools Manager and the Advanced Host
 * Tools Installation panels.
 */

/** Minimum recommended python version surfaced as a warning in the UI. */
export const PYTHON_MIN_RECOMMENDED = '3.12';

/**
 * Artifact written by each installable part, relative to the .zinstaller
 * directory. Presence of the artifact means the part is installed there,
 * regardless of what a system-wide tool on PATH would report.
 * Paths mirror scripts/hosttools/install.ps1.
 */
export const HOST_TOOLS_PART_ARTIFACTS: Record<string, string> = {
  gperf: 'tools/gperf/bin/gperf.exe',
  cmake: 'tools/cmake/bin/cmake.exe',
  ninja: 'tools/ninja/ninja.exe',
  dtc: 'tools/dtc/usr/bin/dtc.exe',
  git: 'tools/git/bin/git.exe',
  wget: 'tools/wget/wget.exe',
  venv: '.venv/Scripts/Activate.ps1',
  python: 'tools/python/python/python.exe',
};

/** Filesystem presence of every part artifact under the .zinstaller dir. */
export function probeHostToolsPartsPresence(): Record<string, boolean> {
  const baseDir = getInternalDirRealPath();
  const presence: Record<string, boolean> = {};
  for (const [part, relPath] of Object.entries(HOST_TOOLS_PART_ARTIFACTS)) {
    try {
      presence[part] = fs.existsSync(path.join(baseDir, relPath));
    } catch {
      presence[part] = false;
    }
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
      cmd = `bash "${sh}" --only-check ${destDir}`;
    } else {
      const sh = vscode.Uri.joinPath(scriptsDir, 'install.sh').fsPath;
      cmd = `bash "${sh}" --only-check ${destDir}`;
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
 * Read the target versions from tools.yml (os.windows.version): the single
 * source of truth for what the installer is going to install, shared with the
 * install script (which builds archive names from the same values).
 * Returns tool-name -> version (e.g. cmake, ninja, gperf, dtc, git,
 * python_portable). Empty map on any failure.
 */
export function readHostToolsTargetVersions(extensionUri: vscode.Uri): Record<string, string> {
  try {
    const ymlPath = vscode.Uri.joinPath(extensionUri, 'scripts', 'hosttools', 'tools.yml').fsPath;
    const data = yaml.parse(fs.readFileSync(ymlPath, 'utf8')) || {};
    const map: Record<string, string> = {};
    for (const section of ['other_content', 'zephyr_content']) {
      const list = Array.isArray(data[section]) ? data[section] : [];
      for (const entry of list) {
        const tool = entry?.tool;
        const version = entry?.os?.windows?.version;
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
