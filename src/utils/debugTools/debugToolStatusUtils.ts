import fs from 'fs';
import yaml from 'yaml';
import * as vscode from 'vscode';

import { getRunner } from './debugUtils';
import { findDetectedToolRoot, getDetectPlatform } from './debugToolPathUtils';
import {
  DebugToolEntry,
  DebugToolsManifest,
  isIgnoredReferenceVersion,
  probeDebugToolVersion,
  ToolVersionProbeResult,
  VersionProbeRunOptions,
} from './debugToolVersionUtils';
import { getDebugToolsYamlPath } from './debugToolSelectionUtils';
import {
  buildAliasProbeTool,
  DebugToolEnvData,
  getConfiguredDebugToolPath,
  getDefaultToolIdForAlias,
  isDebugToolCompatible,
  ManifestDebugTool,
} from './debugToolManifestUtils';
import { fileExists, getInternalDirRealPath } from '../utils';
import { loadEnvYamlState } from '../env/envYamlFileUtils';

/*
 * Installed-and-version status of the flash and debug tools listed in
 * debug-tools.yml. The Install Runners panel renders it and the agent
 * environment check reports it; neither shows UI from here nor writes env.yml.
 */

export function loadDebugToolsManifest(extensionUri?: vscode.Uri): DebugToolsManifest {
  return yaml.parse(fs.readFileSync(getDebugToolsYamlPath(extensionUri), 'utf8')) as DebugToolsManifest;
}

/** The per-OS executable name the version command runs, from the runner of the same id. */
export function getDebugToolExecutableName(toolId: string): string | undefined {
  return getRunner(toolId)?.executable;
}

export interface DebugToolProbeOutcome {
  /**
   * null when the version command gave no answer (it timed out or was
   * stopped) and the filesystem cannot tell either.
   */
  installed: boolean | null;
  /** The Install Runners panel's status column. */
  status: string;
  version: string;
  updateAvailable: boolean;
  timedOut?: boolean;
  aborted?: boolean;
}

/** The status column of a tool whose version command was killed at its time limit. */
export const PROBE_TIMED_OUT_STATUS = 'No answer (timed out)';
/** The status column of a tool whose version command was stopped by the caller. */
export const PROBE_STOPPED_STATUS = 'No answer (stopped)';

/**
 * Turn one version probe into a status row. A version command that timed out
 * or was stopped proves nothing: for a PATH-only tool the probe reports it
 * absent, so the row falls back to the filesystem (a detected install root or
 * an existing configured path) and, when that cannot tell, says there was no
 * answer rather than "Not installed".
 */
export function describeProbeOutcome(
  result: ToolVersionProbeResult,
  filesystemInstalled: () => boolean | null,
  referenceIgnored = false,
): DebugToolProbeOutcome {
  const unanswered = !!(result.timedOut || result.aborted);
  const installed = unanswered ? filesystemInstalled() : result.installed;
  const updateAvailable = !unanswered && result.updateAvailable;
  let status: string;
  if (referenceIgnored) {
    status = '';
  } else if (installed === null) {
    status = result.aborted ? PROBE_STOPPED_STATUS : PROBE_TIMED_OUT_STATUS;
  } else {
    status = installed ? (updateAvailable ? 'New Version Available' : 'Installed') : 'Not installed';
  }
  return {
    installed,
    status,
    version: result.version || '',
    updateAvailable,
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.aborted ? { aborted: true } : {}),
  };
}

/** Probe one tool row the way the Install Runners panel does. */
export async function probeDebugToolStatus(
  manifest: DebugToolsManifest,
  tool: DebugToolEntry,
  envData: DebugToolEnvData | undefined,
  runOptions: VersionProbeRunOptions = {},
): Promise<DebugToolProbeOutcome> {
  const result = await probeDebugToolVersion({
    manifest,
    tool,
    executableName: getDebugToolExecutableName(tool.alias || tool.tool),
    envData,
    ziBaseDir: getInternalDirRealPath(),
    platform: getDetectPlatform(),
    ...runOptions,
  });
  return describeProbeOutcome(
    result,
    () => detectWithoutSpawn(tool, envData).installed,
    isIgnoredReferenceVersion(tool.version),
  );
}

/**
 * Probe an alias row (such as openocd): the alias's shared version command
 * against whichever variant is selected. Undefined when the manifest has no
 * such alias.
 */
export async function probeDebugToolAliasStatus(
  manifest: DebugToolsManifest,
  envData: DebugToolEnvData | undefined,
  alias: string,
  runOptions: VersionProbeRunOptions = {},
): Promise<DebugToolProbeOutcome | undefined> {
  const aliasTool = buildAliasProbeTool(manifest, envData, alias);
  if (!aliasTool) {
    return undefined;
  }

  const result = await probeDebugToolVersion({
    manifest,
    tool: aliasTool,
    executableName: getDebugToolExecutableName(alias),
    envData,
    ziBaseDir: getInternalDirRealPath(),
    platform: getDetectPlatform(),
    ...runOptions,
  });
  // Without an answer, the alias is what its selected variant's install shows.
  const selected = findSelectedAliasTool(manifest, envData, alias);
  return describeProbeOutcome(result, () => (selected ? detectWithoutSpawn(selected, envData).installed : null));
}

function findSelectedAliasTool(
  manifest: DebugToolsManifest,
  envData: DebugToolEnvData | undefined,
  alias: string,
): ManifestDebugTool | undefined {
  const selectedId = getDefaultToolIdForAlias(manifest, envData, alias);
  return ((manifest.debug_tools ?? []) as ManifestDebugTool[]).find(tool => tool.tool === selectedId);
}

export interface DebugToolStatus {
  id: string;
  /** An alias row (such as openocd) that follows its selected variant. */
  isAlias: boolean;
  /** For a variant row, the alias it belongs to. */
  alias?: string;
  name?: string;
  type?: string;
  vendor?: string;
  /** The Install Runners panel can install it on this OS. */
  installableHere: boolean;
  /** For a variant row, whether it is the one its alias resolves to. */
  isDefaultForAlias?: boolean;
  /** For an alias row, the variant it resolves to. */
  defaultTool?: string;
  /** null when only a spawned probe could tell and none ran. */
  installed: boolean | null;
  version?: string;
  referenceVersion?: string;
  updateAvailable: boolean;
  configuredPath?: string;
  detectedPath?: string;
  timedOut?: boolean;
  /** Why this row carries no answer. */
  note?: string;
}

export interface CollectDebugToolsOptions {
  extensionUri?: vscode.Uri;
  manifest?: DebugToolsManifest;
  envData?: DebugToolEnvData;
  /**
   * Manifest ids (tools or aliases) to report. Defaults to every alias and
   * every tool this OS can run (a tool whose manifest `os` entry for this OS
   * is explicitly false is left out).
   */
  toolIds?: readonly string[];
  /** Run each tool's version command. False reads the filesystem and env.yml only. */
  probe?: boolean;
  timeoutMs?: number;
  /**
   * Epoch milliseconds after which no further version command starts, and
   * that bounds the ones already running. A tool reached after it is reported
   * from the filesystem with a note, so a slow machine still gets every row.
   */
  deadline?: number;
  /** Version commands run at once. */
  concurrency?: number;
  signal?: AbortSignal;
}

/**
 * The least time before the deadline a version command is started with. Less
 * than that is not enough for a PowerShell spawn that sources env.ps1.
 */
export const MIN_PROBE_WINDOW_MS = 3000;

function detectPlatformKey(): 'windows' | 'linux' | 'darwin' {
  return getDetectPlatform();
}

async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Filesystem-only presence: a detected install root, or an existing configured path. */
function detectWithoutSpawn(
  tool: DebugToolEntry,
  envData: DebugToolEnvData | undefined,
): { installed: boolean | null; detectedPath?: string } {
  const platform = detectPlatformKey();
  const detected = findDetectedToolRoot(tool, getInternalDirRealPath(), platform, envData);
  if (detected) {
    return { installed: true, detectedPath: detected };
  }
  const configured = getConfiguredDebugToolPath(envData, tool.tool);
  if (configured && fileExists(configured)) {
    return { installed: true, detectedPath: configured };
  }
  // With explicit detect paths the filesystem is the whole answer; without
  // them the tool is found on PATH, which only a spawned probe can confirm.
  const explicit = (tool['explicit-detect']?.[platform] ?? []).filter(p => typeof p === 'string' && p.trim().length > 0);
  return { installed: explicit.length > 0 ? false : null };
}

/**
 * Status of the manifest's flash and debug tools. With `probe` each tool's
 * version command runs through the env-sourced shell, bounded by `timeoutMs`
 * and `concurrency`; without it nothing is spawned.
 */
export async function collectDebugToolsStatus(opts: CollectDebugToolsOptions = {}): Promise<DebugToolStatus[]> {
  const manifest = opts.manifest ?? loadDebugToolsManifest(opts.extensionUri);
  const envData = opts.envData ?? (loadEnvYamlState().data as DebugToolEnvData | undefined);
  const platform = detectPlatformKey();
  const allTools = (manifest.debug_tools ?? []) as ManifestDebugTool[];
  const allAliases = manifest.aliases ?? [];
  const wanted = opts.toolIds ? new Set(opts.toolIds) : undefined;

  const toolRows = allTools.filter(tool => wanted
    ? wanted.has(tool.tool)
    : tool.os?.[platform] !== false);
  const aliasRows = allAliases.filter(alias => !wanted || wanted.has(alias.alias));
  // A probe started with only a sliver of the deadline left is killed before
  // a PowerShell and env.ps1 spawn can print anything, and then reads as no
  // answer. The filesystem answer is worth more than that, so such a probe
  // does not start at all. A caller's own shorter per-probe limit lowers the floor.
  const floor = Math.min(opts.timeoutMs ?? MIN_PROBE_WINDOW_MS, MIN_PROBE_WINDOW_MS);
  // Undefined when no probe may start any more: the deadline has passed, or too little of it is left.
  const runOptionsNow = (): VersionProbeRunOptions | undefined => {
    if (opts.deadline === undefined) {
      return { timeoutMs: opts.timeoutMs, signal: opts.signal };
    }
    const left = opts.deadline - Date.now();
    if (left <= 0 || left < floor) {
      return undefined;
    }
    return { timeoutMs: Math.min(opts.timeoutMs ?? left, left), signal: opts.signal };
  };
  const OUT_OF_TIME = 'Not probed: the time allowed for this check ran out first.';
  const STOPPED = 'Stopped before this tool was probed.';
  const NO_ANSWER = 'The version command did not answer in time, so installed comes from the filesystem only.';
  const STOPPED_WHILE_PROBING = 'Stopped while this tool was probed, so installed comes from the filesystem only.';
  // A probe that gave no answer has already fallen back to the filesystem in
  // describeProbeOutcome; the note says so.
  const outcomeFields = (outcome: DebugToolProbeOutcome) => ({
    installed: outcome.installed,
    ...(outcome.version ? { version: outcome.version } : {}),
    updateAvailable: outcome.updateAvailable,
    ...(outcome.timedOut ? { timedOut: true, note: NO_ANSWER } : {}),
    ...(outcome.aborted ? { note: STOPPED_WHILE_PROBING } : {}),
  });

  const describeTool = async (tool: ManifestDebugTool): Promise<DebugToolStatus> => {
    const base: DebugToolStatus = {
      id: tool.tool,
      isAlias: false,
      ...(tool.alias ? { alias: tool.alias } : {}),
      ...(tool.name ? { name: tool.name } : {}),
      ...(tool.type ? { type: tool.type } : {}),
      ...(tool.vendor ? { vendor: tool.vendor } : {}),
      installableHere: isDebugToolCompatible(tool),
      ...(tool.alias ? { isDefaultForAlias: getDefaultToolIdForAlias(manifest, envData, tool.alias) === tool.tool } : {}),
      installed: null,
      ...(tool.version !== undefined && !isIgnoredReferenceVersion(tool.version) ? { referenceVersion: String(tool.version).trim() } : {}),
      updateAvailable: false,
      ...(getConfiguredDebugToolPath(envData, tool.tool) ? { configuredPath: getConfiguredDebugToolPath(envData, tool.tool) } : {}),
    };
    const quick = detectWithoutSpawn(tool, envData);
    if (quick.detectedPath) {
      base.detectedPath = quick.detectedPath;
    }
    if (!opts.probe) {
      return { ...base, installed: quick.installed };
    }
    const runOptions = runOptionsNow();
    if (opts.signal?.aborted || !runOptions) {
      return { ...base, installed: quick.installed, note: opts.signal?.aborted ? STOPPED : OUT_OF_TIME };
    }
    try {
      const outcome = await probeDebugToolStatus(manifest, tool, envData, runOptions);
      return { ...base, ...outcomeFields(outcome) };
    } catch (error) {
      return { ...base, installed: quick.installed, note: `Probe failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  };

  const describeAlias = async (alias: { alias: string; name?: string }): Promise<DebugToolStatus> => {
    const defaultTool = getDefaultToolIdForAlias(manifest, envData, alias.alias);
    const selected = allTools.find(tool => tool.tool === defaultTool);
    const base: DebugToolStatus = {
      id: alias.alias,
      isAlias: true,
      ...(alias.name ? { name: alias.name } : {}),
      ...(selected?.type ? { type: selected.type } : {}),
      installableHere: allTools.some(tool => tool.alias === alias.alias && isDebugToolCompatible(tool)),
      ...(defaultTool ? { defaultTool } : {}),
      installed: null,
      updateAvailable: false,
      ...(getConfiguredDebugToolPath(envData, alias.alias) ? { configuredPath: getConfiguredDebugToolPath(envData, alias.alias) } : {}),
    };
    const quick = selected ? detectWithoutSpawn(selected, envData) : { installed: null };
    // Like a tool row, the install root the answer may rest on is always shown.
    if (quick.detectedPath) {
      base.detectedPath = quick.detectedPath;
    }
    if (!opts.probe) {
      return { ...base, installed: quick.installed };
    }
    const runOptions = runOptionsNow();
    if (opts.signal?.aborted || !runOptions) {
      return { ...base, installed: quick.installed, note: opts.signal?.aborted ? STOPPED : OUT_OF_TIME };
    }
    try {
      const outcome = await probeDebugToolAliasStatus(manifest, envData, alias.alias, runOptions);
      if (!outcome) {
        return { ...base, installed: false };
      }
      return { ...base, ...outcomeFields(outcome) };
    } catch (error) {
      return { ...base, note: `Probe failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  };

  // PowerShell spawns are heavy on Windows, so fewer run at once there.
  const limit = opts.concurrency ?? (process.platform === 'win32' ? 4 : 8);
  const jobs: Array<() => Promise<DebugToolStatus>> = [
    ...aliasRows.map(alias => () => describeAlias(alias)),
    ...toolRows.map(tool => () => describeTool(tool)),
  ];
  return mapLimited(jobs, limit, job => job());
}
