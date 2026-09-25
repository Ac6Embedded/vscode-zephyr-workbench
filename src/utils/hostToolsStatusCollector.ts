import path from "path";
import * as vscode from "vscode";
import {
  ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY,
  ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY,
  ZINSTALLER_MINIMUM_VERSION,
} from "../constants";
import {
  buildEnvSourcedShellCommand,
  classifyShell,
  ConfigurationScope,
  getConfiguredWorkbenchPath,
  getShellExe,
  getSubstitutedShellName,
  isSpdxOnlyVenvPath,
} from "./execUtils";
import { readInstalledZinstallerVersion, versionAtLeast } from "./env/zinstallerVersionUtils";
import { getHostToolsParts } from "./hostToolsPartsRegistry";
import {
  buildHostToolsPartsStatus,
  HomebrewProbeResult,
  HostToolsPartStatus,
  probeHomebrew,
  probeHostToolsPartsPresence,
  probeHostToolsPresence,
  readHostToolsTargetVersions,
  runHostToolsOnlyCheck,
} from "./hostToolsStatusUtils";
import { checkEnvFile, checkHostTools, getZinstallerVersionStampPath } from "./installUtils";
import { getCurrentUserExecutionPolicy, isExecutionPolicyAllowed } from "./powershellUtils";
import { fileExists, getEnvScriptFilename, getInternalDirRealPath } from "./utils";

/*
 * One read-only picture of the host tools install and of the settings every
 * env-sourced command depends on. The Advanced Host Tools panel and the
 * agent environment check both read it, so they cannot disagree.
 *
 * Its own module on purpose: installUtils imports hostToolsStatusUtils, so
 * the composition that needs installUtils cannot live there without a cycle.
 *
 * Never throws, shows no UI, and writes nothing: every failure lands in
 * `errors`, and the install-time helpers that write settings or env.yml are
 * never called from here.
 */

export interface HostToolsStatus {
  /** The .zinstaller folder everything below lives in. */
  internalDir: string;
  /** The tools/ folder exists. Not proof of an install on its own: the installer creates it first. */
  installed: boolean;
  /** tools/, the env script and the completion stamp all exist: the rule the installer itself uses. */
  complete: boolean;
  envFile: { path: string; exists: boolean };
  stamp: { path: string; exists: boolean };
  zinstaller: { installedVersion?: string; minimum: string; upToDate: boolean };
  /** Every part of this OS, python and the venv included. */
  parts: HostToolsPartStatus[];
  /** The raw presence map the parts were built from. */
  presence: Record<string, boolean>;
  /**
   * Parts only a spawned probe can confirm (brew tools, the linux system
   * packages): unknown without the version check, or when it could not run.
   */
  undetermined: string[];
  /**
   * Installer steps (the Advanced panel rows) known to be absent. Python and
   * the venv are left out: the installer may use a system or custom Python
   * on purpose, so their absence here is not a gap, and the venv a build
   * activates is checked on its own.
   */
  missing: string[];
  /** The installer's check-mode versions, when the version check ran. */
  checkedVersions?: Record<string, string>;
  versionCheck: { ran: boolean; exitCode?: number; timedOut?: boolean; error?: string };
  homebrew?: HomebrewProbeResult;
  executionPolicy?: { current: string; allowed: boolean };
  errors: string[];
}

export interface CollectHostToolsOptions {
  /** Run the installer's check mode for versions and command-probed parts. Spawns processes. */
  versionCheck?: boolean;
  /** Probe Homebrew on macOS. Defaults to versionCheck. */
  homebrew?: boolean;
  /** Read the CurrentUser PowerShell execution policy on Windows. Spawns PowerShell. */
  executionPolicy?: boolean;
  /** Bound for each spawned probe. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Receives the installer's check output as it is printed, for Verify Host Tools. */
  onCheckOutput?: (text: string) => void;
  /**
   * The caller found the macOS developer tools missing and must not show a
   * dialog: the version check then reports their /usr/bin stubs (python3,
   * git, make, gperf) as not installed instead of running them.
   */
  developerToolsMissing?: boolean;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function collectHostToolsStatus(
  extensionUri: vscode.Uri,
  opts: CollectHostToolsOptions = {},
): Promise<HostToolsStatus> {
  const errors: string[] = [];
  const settle = async <T>(label: string, run: () => Promise<T> | T, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      errors.push(`${label}: ${message(error)}`);
      return fallback;
    }
  };

  const internalDir = getInternalDirRealPath();
  const installed = await settle('tools folder', checkHostTools, false);
  const envFilePath = path.join(internalDir, getEnvScriptFilename());
  const envFileExists = await settle('environment script', checkEnvFile, false);
  const stampPath = getZinstallerVersionStampPath();
  const stampExists = fileExists(stampPath);
  const installedVersion = readInstalledZinstallerVersion();

  const parts = getHostToolsParts();
  let presence: Record<string, boolean>;
  let versions: Record<string, string> = {};
  let undetermined: string[] = [];
  const versionCheck: HostToolsStatus['versionCheck'] = { ran: false };

  if (opts.versionCheck) {
    // Versions first: the registry-driven probe reuses the map for the parts
    // whose presence derives from the check output, so the check never runs twice.
    const check = await runHostToolsOnlyCheck(extensionUri, {
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onOutput: opts.onCheckOutput,
      developerToolsMissing: opts.developerToolsMissing,
    });
    versions = check.versions;
    versionCheck.ran = check.ran;
    if (check.exitCode !== undefined) { versionCheck.exitCode = check.exitCode; }
    if (check.timedOut) { versionCheck.timedOut = true; }
    if (check.error) { versionCheck.error = check.error; }
    presence = await settle<Record<string, boolean> | undefined>(
      'presence probe', () => probeHostToolsPresence(extensionUri, versions), undefined)
      ?? probeHostToolsPartsPresence();
    if (!check.ran || check.timedOut || check.exitCode === undefined) {
      // A part whose presence is read from the check output cannot be told
      // missing when the check never answered (no exit code: it was stopped).
      undetermined = parts
        .filter(p => !presence[p.id] && p.probe.versionKeysAllOf)
        .map(p => p.id);
    }
  } else {
    // Filesystem only. A part probed by command or by check output reads
    // false here whatever is installed, so it is reported as unknown rather
    // than as missing.
    presence = probeHostToolsPartsPresence();
    undetermined = parts
      .filter(p => !presence[p.id] && !p.probe.artifact && !p.probe.artifactPrefixScan)
      .map(p => p.id);
  }

  let homebrew: HomebrewProbeResult | undefined;
  if (process.platform === 'darwin' && (opts.homebrew ?? !!opts.versionCheck)) {
    homebrew = await settle('Homebrew probe', probeHomebrew, { ok: false });
  }

  let executionPolicy: HostToolsStatus['executionPolicy'];
  if (process.platform === 'win32' && opts.executionPolicy) {
    // The read-only half of ensurePowershellExecutionPolicy, which would
    // change the policy and show a dialog.
    const current = await settle('PowerShell policy', () => getCurrentUserExecutionPolicy(opts.timeoutMs ?? 0), 'Undefined');
    executionPolicy = { current, allowed: isExecutionPolicyAllowed(current) };
  }

  const targets = readHostToolsTargetVersions(extensionUri);
  return {
    internalDir,
    installed,
    complete: installed && envFileExists && stampExists,
    envFile: { path: envFilePath, exists: envFileExists },
    stamp: { path: stampPath, exists: stampExists },
    zinstaller: {
      ...(installedVersion ? { installedVersion } : {}),
      minimum: ZINSTALLER_MINIMUM_VERSION,
      upToDate: !!installedVersion && versionAtLeast(installedVersion, ZINSTALLER_MINIMUM_VERSION),
    },
    parts: buildHostToolsPartsStatus(presence, versions, parts, targets),
    presence,
    undetermined,
    missing: parts.filter(p => p.row && !presence[p.id] && !undetermined.includes(p.id)).map(p => p.id),
    ...(opts.versionCheck ? { checkedVersions: versions } : {}),
    versionCheck,
    ...(homebrew ? { homebrew } : {}),
    ...(executionPolicy ? { executionPolicy } : {}),
    errors,
  };
}

export interface EnvironmentSettingsStatus {
  envScript: { configured?: string; exists: boolean; ok: boolean };
  venvSetting: { configured?: string; exists: boolean; ok: boolean; spdxOnlyIgnored?: boolean };
  shell: { path: string; kind: string; substitutedFrom?: string };
  /** What buildEnvSourcedShellCommand refuses with, exactly as a build or a probe would hit it. */
  preflightError?: { setting?: string; message: string };
  /** Env-sourced commands can run: the preflight passes and the env script exists. */
  envSourcedReady: boolean;
}

/**
 * The settings every env-sourced build, flash and probe depends on, read at
 * `scope` the way those commands read them. Settings reads only: nothing runs.
 */
export function collectEnvironmentSettings(scope?: ConfigurationScope): EnvironmentSettingsStatus {
  let envScript: string | undefined;
  let rawVenv: string | undefined;
  try { envScript = getConfiguredWorkbenchPath(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, scope); } catch { }
  try { rawVenv = getConfiguredWorkbenchPath(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY, scope); } catch { }
  const envScriptExists = !!envScript && fileExists(envScript);
  // An SPDX-only venv in venv.path is ignored by every build, so it neither
  // counts as the venv nor as a broken setting.
  const spdxOnlyIgnored = isSpdxOnlyVenvPath(rawVenv);
  const effectiveVenv = spdxOnlyIgnored ? undefined : rawVenv;
  const venvExists = !!effectiveVenv && fileExists(effectiveVenv);

  let preflightError: EnvironmentSettingsStatus['preflightError'];
  try {
    buildEnvSourcedShellCommand('echo', scope);
  } catch (error) {
    const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
    preflightError = { ...(typeof cause === 'string' ? { setting: cause } : {}), message: message(error) };
  }

  const shellPath = getShellExe();
  const substitutedFrom = getSubstitutedShellName();
  return {
    envScript: { ...(envScript ? { configured: envScript } : {}), exists: envScriptExists, ok: envScriptExists },
    venvSetting: {
      ...(rawVenv ? { configured: rawVenv } : {}),
      exists: venvExists,
      ok: !effectiveVenv || venvExists,
      ...(spdxOnlyIgnored ? { spdxOnlyIgnored: true } : {}),
    },
    shell: { path: shellPath, kind: classifyShell(shellPath), ...(substitutedFrom ? { substitutedFrom } : {}) },
    ...(preflightError ? { preflightError } : {}),
    envSourcedReady: !preflightError && envScriptExists,
  };
}
