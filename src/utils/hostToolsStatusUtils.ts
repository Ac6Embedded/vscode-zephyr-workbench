import { execFile } from "child_process";
import * as fs from 'fs';
import path from "path";
import * as vscode from "vscode";
import yaml from 'yaml';
import { ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY } from "../constants";
import { buildEnvSourcedShellCommand, captureCommand, getConfiguredWorkbenchPath, getShellExe } from "./execUtils";
import { fileExists, getInstallDirRealPath, getInternalDirRealPath } from "./utils";
import { getAdvancedRowParts, getHostToolsParts, HostToolsPartDef } from "./hostToolsPartsRegistry";
import { DEVELOPER_TOOLS_MISSING_ENV, pythonCandidatesWithoutStubs } from "./macDeveloperTools";

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

/** A -OnlyCheck version for display: empty when absent or reported missing. */
export function displayHostToolVersion(raw: string | undefined): string {
  if (!raw) { return ''; }
  if (raw.toUpperCase() === 'NOT INSTALLED') { return ''; }
  return raw;
}

export interface HostToolsPartStatus {
  part: string;
  label: string;
  /** The zinstaller copy (or, on provider rows, the provider's copy) is present. */
  present: boolean;
  detectedVersion: string;
  /** Only a system-wide tool answered the check: the zinstaller copy is absent. */
  systemDetected: boolean;
  provider?: string;
  sudo?: boolean;
  /** What the installer would install: the tools.yml version, or the provider text. */
  targetVersion?: string;
}

/**
 * Combine presence probes and -OnlyCheck versions into one status per part.
 * The Advanced Host Tools panel renders these rows, and the environment check
 * reports them.
 */
export function buildHostToolsPartsStatus(
  presence: Record<string, boolean>,
  versions: Record<string, string>,
  parts: HostToolsPartDef[] = getAdvancedRowParts(),
  targets?: Record<string, string>,
): HostToolsPartStatus[] {
  return parts.map(p => {
    const present = presence[p.id] === true;
    // The -OnlyCheck run resolves the zinstaller copy first (env sourced);
    // when the artifact is absent it falls back to a system-wide tool, so
    // the detected version then describes what the SYSTEM provides.
    let detectedVersion = '';
    if (p.probe.versionKeysAllOf) {
      // Batch row (linux system packages): list the detected constituents.
      detectedVersion = p.probe.versionKeysAllOf
        .map(k => ({ k, v: displayHostToolVersion(versions[k]) }))
        .filter(e => e.v.length > 0)
        .map(e => `${e.k} ${e.v}`)
        .join(', ');
    } else if (p.versionKey) {
      detectedVersion = displayHostToolVersion(versions[p.versionKey]);
    }
    // "System only" contrasts the zinstaller artifact with a PATH-wide
    // tool; on provider rows (brew/distro) the provider IS the system, so
    // the distinction carries no meaning there.
    const systemDetected = !p.provider && !present && detectedVersion.length > 0;
    if (p.provider && detectedVersion.length === 0) {
      detectedVersion = '-';
    }
    const status: HostToolsPartStatus = { part: p.id, label: p.label, present, detectedVersion, systemDetected };
    if (p.provider) { status.provider = p.provider; }
    if (p.sudo) { status.sudo = true; }
    if (targets) {
      const target = p.targetKey ? (targets[p.targetKey] ?? '') : (p.availableText ?? '');
      if (target) { status.targetVersion = target; }
    }
    return status;
  });
}

/**
 * Parse the installer's -OnlyCheck/--only-check output: `name [version]` lines
 * into a lowercased name -> version map (`.exe` suffixes stripped). A value
 * may be 'NOT INSTALLED'. The single parser of that byte-stable contract.
 */
export function parseHostToolsCheckOutput(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('---')) { continue; }
    // Expect lines like: python [3.13.5] or 7z [24.08 (x64)]
    const m = line.match(/^(\S+)\s*\[(.+?)\]\s*$/);
    if (!m) { continue; }
    const name = m[1].toLowerCase().replace(/\.exe$/, '');
    const ver = m[2].trim();
    if (name && ver) {
      map[name] = ver;
    }
  }
  return map;
}

export interface HostToolsOnlyCheckInvocation {
  platform: 'win32' | 'darwin' | 'linux';
  /** The per-OS installer script shipped with the extension. */
  scriptPath: string;
  /**
   * The folder the installer is given. The script appends `.zinstaller`
   * itself, so this is the parent of the internal dir, as Verify Host Tools
   * has always passed.
   */
  installDir: string;
}

/**
 * What the installer's check mode is run with. Shared by the visible Verify
 * Host Tools task and the captured check, so both inspect the same install.
 */
export function getHostToolsOnlyCheckInvocation(
  extensionUri: vscode.Uri,
  platform: NodeJS.Platform = process.platform,
): HostToolsOnlyCheckInvocation {
  const scriptsDir = vscode.Uri.joinPath(extensionUri, 'scripts', 'hosttools');
  const installDir = getInstallDirRealPath();
  if (platform === 'win32') {
    return { platform, scriptPath: vscode.Uri.joinPath(scriptsDir, 'install.ps1').fsPath, installDir };
  }
  if (platform === 'darwin') {
    return { platform, scriptPath: vscode.Uri.joinPath(scriptsDir, 'install-mac.sh').fsPath, installDir };
  }
  return { platform: 'linux', scriptPath: vscode.Uri.joinPath(scriptsDir, 'install.sh').fsPath, installDir };
}

/** The check-mode command line, before any env sourcing. */
export function buildHostToolsOnlyCheckCommand(invocation: HostToolsOnlyCheckInvocation): string {
  return invocation.platform === 'win32'
    ? `powershell -File "${invocation.scriptPath}" -OnlyCheck -InstallDir "${invocation.installDir}"`
    : `bash "${invocation.scriptPath}" --only-check "${invocation.installDir}"`;
}

/** Generous by default: on Windows the check is PowerShell running a probe per tool. */
export const HOST_TOOLS_CHECK_TIMEOUT_MS = 120000;

export interface HostToolsOnlyCheckResult {
  /** False when the check could not start at all. */
  ran: boolean;
  /** The installer exits with minus the number of missing packages, so non-zero is not a failure. */
  exitCode?: number;
  timedOut?: boolean;
  versions: Record<string, string>;
  output: string;
  error?: string;
}

/**
 * Run the installer in check mode and parse its output. Distinguishes "the
 * check could not run" (ran false, or timed out) from "it ran and found
 * nothing", which an empty map alone cannot. Bounded by a timeout that kills
 * the check, and never throws.
 */
export async function runHostToolsOnlyCheck(
  extensionUri: vscode.Uri,
  opts: {
    timeoutMs?: number;
    signal?: AbortSignal;
    onOutput?: (text: string) => void;
    /**
     * The macOS developer tools are missing: the check reports their
     * /usr/bin stubs as not installed instead of running them, since each
     * would open the system install dialog.
     */
    developerToolsMissing?: boolean;
  } = {},
): Promise<HostToolsOnlyCheckResult> {
  try {
    const invocation = getHostToolsOnlyCheckInvocation(extensionUri);
    const cmd = buildHostToolsOnlyCheckCommand(invocation);
    // win32 forces PowerShell on the env-sourced path: routing this
    // `powershell -File ...` command through a Git Bash/Cygwin default
    // profile would depend on `powershell` being on that shell's PATH and on
    // bash preserving the quoted backslash paths.
    const executableOverride = invocation.platform === 'win32' ? 'powershell.exe' : undefined;

    // The env-sourced wrapper chains '. env.sh && <cmd>': before the host
    // tools exist (or when env.sh was deleted) the sourcing fails and the
    // check never runs, leaving the Detected column empty for tools that ARE
    // installed. The check scripts are self-sufficient, so run them plain
    // whenever the configured env script is not an existing file, or when the
    // env-sourced run would be refused anyway (venv.path set to a missing folder).
    let envScriptPath: string | undefined;
    try {
      envScriptPath = getConfiguredWorkbenchPath(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
    } catch { }
    let useEnv = !!envScriptPath && fileExists(envScriptPath);
    if (useEnv) {
      try {
        buildEnvSourcedShellCommand(cmd, undefined, executableOverride ?? getShellExe());
      } catch {
        useEnv = false;
      }
    }

    const result = await captureCommand(cmd, {
      timeoutMs: opts.timeoutMs ?? HOST_TOOLS_CHECK_TIMEOUT_MS,
      sourceEnv: useEnv,
      executableOverride,
      signal: opts.signal,
      onOutput: opts.onOutput,
      ...(opts.developerToolsMissing && invocation.platform === 'darwin' ? { env: { [DEVELOPER_TOOLS_MISSING_ENV]: '1' } } : {}),
    });
    const output = `${result.stdout}\n${result.stderr}`;
    return {
      ran: result.ran,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(result.timedOut ? { timedOut: true } : {}),
      versions: parseHostToolsCheckOutput(output),
      output,
      ...(result.error && !result.ran ? { error: result.error } : {}),
    };
  } catch (error) {
    return { ran: false, versions: {}, output: '', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Run the installer in -OnlyCheck mode and return the parsed version map.
 * Returns an empty map on any failure; callers decide whether to keep
 * previous data. Extracted from HostToolsPanel so both panels share the
 * single parser of the byte-stable -OnlyCheck output contract.
 */
export async function fetchHostToolsCheckedVersions(extensionUri: vscode.Uri): Promise<Record<string, string>> {
  return (await runHostToolsOnlyCheck(extensionUri)).versions;
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

/** One interpreter run; resolves undefined when the executable does not work. */
function runPythonProbe(exe: string): Promise<PythonProbeResult | undefined> {
  return new Promise((resolve) => {
    execFile(
      exe,
      ['-c', 'import sys;print(sys.executable);print(sys.version.split()[0])'],
      { timeout: 10000 },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const lines = String(stdout).split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
        const exePath = lines[0];
        const version = lines[1];
        if (!exePath || !version) {
          resolve(undefined);
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

/**
 * Probe a python interpreter WITHOUT sourcing the Zephyr environment script:
 * execCommandWithEnv would put the portable python on PATH and falsify a
 * "system" probe. execFile also avoids shell quoting for paths with spaces.
 * The Microsoft Store app-execution alias resolves as `python` but exits
 * non-zero, so it correctly lands in the "not detected" branch. On posix
 * `python3` is probed first: distros usually ship no bare `python`.
 *
 * `developerToolsMissing` is for a caller that must not show a dialog: with
 * the macOS developer tools missing, /usr/bin/python3 is a stub that opens
 * the install dialog, so it is skipped instead of run.
 */
export async function probePythonInterpreter(
  mode: 'system' | 'custom',
  customPath?: string,
  opts: { developerToolsMissing?: boolean } = {},
): Promise<PythonProbeResult> {
  const candidates: string[] = [];
  if (mode === 'custom') {
    const provided = (customPath ?? '').trim();
    if (!provided) {
      return { ok: false, error: 'No python path provided' };
    }
    let isDir = false;
    try {
      isDir = fs.existsSync(provided) && fs.statSync(provided).isDirectory();
    } catch { }
    if (isDir) {
      const names = process.platform === 'win32' ? ['python.exe'] : ['python3', 'python'];
      for (const name of names) {
        const p = path.join(provided, name);
        if (fs.existsSync(p)) {
          candidates.push(p);
        }
      }
      if (candidates.length === 0) {
        return { ok: false, error: `No python executable found in: ${provided}` };
      }
    } else {
      if (!fs.existsSync(provided)) {
        return { ok: false, error: `Python executable not found: ${provided}` };
      }
      candidates.push(provided);
    }
  } else {
    if (process.platform === 'win32') {
      candidates.push('python');
    } else if (process.platform === 'darwin' && opts.developerToolsMissing) {
      candidates.push(...pythonCandidatesWithoutStubs(['python3', 'python']));
      if (candidates.length === 0) {
        return {
          ok: false,
          error: 'No Python on PATH other than the /usr/bin/python3 stub, which was not run because the macOS Command Line Tools are not installed',
        };
      }
    } else {
      candidates.push('python3', 'python');
    }
  }

  for (const exe of candidates) {
    const result = await runPythonProbe(exe);
    if (result) {
      return result;
    }
  }
  return {
    ok: false,
    error: mode === 'system'
      ? 'No working Python detected on PATH'
      : 'The selected Python does not run',
  };
}

/** The version number in `west --version` output, such as "West version: v1.2.0". */
export function parseWestVersionOutput(text: string): string | undefined {
  return /v?(\d+(?:\.\d+)+)/.exec(text)?.[1];
}

export interface WestVersionProbeResult {
  ok: boolean;
  version?: string;
  timedOut?: boolean;
  error?: string;
}

/**
 * Read the version of a venv's west without a shell or the env script: west
 * is a console script whose launcher already points at the venv's Python.
 * Only ever pass a path the workbench resolved itself, because this runs it.
 */
export function probeWestVersion(westPath: string, timeoutMs = 10000): Promise<WestVersionProbeResult> {
  return new Promise((resolve) => {
    try {
      const child = execFile(westPath, ['--version'], { timeout: timeoutMs }, (error, stdout, stderr) => {
        const version = parseWestVersionOutput(`${stdout}\n${stderr}`);
        if (version) {
          resolve({ ok: true, version });
          return;
        }
        resolve({
          ok: false,
          ...(error?.killed ? { timedOut: true } : {}),
          error: error ? error.message : 'west printed no version',
        });
      });
      child.stdin?.end();
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
