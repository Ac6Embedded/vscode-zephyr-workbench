// How the flash and debug runner tools read for an agent: the rows list_runners
// returns, and the state an install job reports afterwards. Read-only: nothing
// here writes env.yml or downloads anything.

import * as path from 'path';
import { ZephyrApplication } from '../../../models/ZephyrApplication';
import { DebugToolStatus } from '../../../utils/debugTools/debugToolStatusUtils';
import {
  DebugToolEnvData, getDebugToolLicense, getDebugToolPacks, isDebugToolCompatible, isDebugToolDetectOnly,
  isDebugToolPathEditable, ManifestDebugTool,
} from '../../../utils/debugTools/debugToolManifestUtils';
import { DebugToolsManifest } from '../../../utils/debugTools/debugToolVersionUtils';
import { getEnvYamlPath, loadEnvYamlState } from '../../../utils/env/envYamlFileUtils';
import { getExtraPaths } from '../../../utils/env/envYamlUtils';
import { PyOCDTargetInfo } from '../../../utils/execUtils';
import { getWestWorkspace } from '../../../utils/utils';
import { normalizeForCompare } from '../../core/argSafety';
import { McpToolError } from '../../core/errors';
import { ToolContext } from '../../core/toolSpec';
import { runnerTools } from '../runnerTools';
import { HostDeps } from './deps';
import { fullToolHint } from './toolchainArgs';

type Ctx = ToolContext<HostDeps>;

/** Each version command is killed after this long. */
const PROBE_TIMEOUT_MS = 15000;
/** No version command starts after this long into the call. */
const PROBE_BUDGET_MS = 30000;
/** The most pyOCD targets a search returns. */
export const MAX_PYOCD_TARGETS = 50;

export function manifestOf(ctx: Ctx): DebugToolsManifest {
  try {
    return ctx.deps.services.debugToolsManifest();
  } catch (error) {
    throw new McpToolError('INTERNAL', `The workbench runner manifest (debug-tools.yml) could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function manifestTools(manifest: DebugToolsManifest): ManifestDebugTool[] {
  return (manifest.debug_tools ?? []) as ManifestDebugTool[];
}

/** env.yml as the runners panel reads it; undefined when it is missing or unreadable. */
export function runnerEnvData(): DebugToolEnvData | undefined {
  return loadEnvYamlState().data as DebugToolEnvData | undefined;
}

/**
 * The installed state of these tools or aliases. Their version commands run
 * when the Zephyr environment can be sourced, each bounded, and none starts
 * late in the call; otherwise only the filesystem is read.
 */
export async function probeRunnerTools(ctx: Ctx, toolIds: readonly string[], probe = true): Promise<{ rows: DebugToolStatus[]; probed: boolean }> {
  if (toolIds.length === 0) {
    return { rows: [], probed: false };
  }
  const probed = probe && runnerTools.envSourcedReady();
  const rows = await ctx.deps.services.debugToolsStatus(probed ? 'full' : 'quick', {
    toolIds,
    timeoutMs: PROBE_TIMEOUT_MS,
    deadline: ctx.startedAt + PROBE_BUDGET_MS,
  });
  return { rows, probed };
}

/** What to do about a tool that is not installed, or undefined when it is. */
export function missingToolHint(tool: ManifestDebugTool | undefined, id: string, platform: NodeJS.Platform): string | undefined {
  if (tool && isDebugToolDetectOnly(tool)) {
    return `${tool.name ?? id} is installed by the user from its vendor${tool.website ? ` (${tool.website})` : ''}; once it is, record its path with manage_runners {"action": "set_path", "tool": "${tool.alias ?? id}", "path": "..."} if it is not found on its own.`;
  }
  if (tool && !isDebugToolCompatible(tool, platform)) {
    return `The workbench cannot install ${tool.name ?? id} on this OS.`;
  }
  return `Install it with manage_runners {"action": "install", "tools": ["${id}"]}.`;
}

/** One tool behind a runner, for list_runners include tools. */
export function runnerToolDto(row: DebugToolStatus, manifest: DebugToolsManifest, platform: NodeJS.Platform) {
  const tool = manifestTools(manifest).find(t => t.tool === (row.isAlias ? row.defaultTool : row.id));
  const path = row.configuredPath ?? row.detectedPath;
  return {
    id: row.id,
    ...(row.name ? { name: row.name } : {}),
    ...(row.isAlias && row.defaultTool ? { default_tool: row.defaultTool } : {}),
    installed: row.installed,
    ...(row.version ? { version: row.version } : {}),
    ...(row.updateAvailable ? { update_available: true } : {}),
    ...(path ? { path } : {}),
    installable_here: row.installableHere,
    ...(row.note ? { note: row.note } : {}),
    ...(row.installed === false ? { hint: missingToolHint(tool, row.id, platform) } : {}),
  };
}

/** Every tool of the manifest, for list_runners all_tools. */
export function allToolsView(
  manifest: DebugToolsManifest, envData: DebugToolEnvData | undefined, rows: readonly DebugToolStatus[], platform: NodeJS.Platform,
) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const addToPath = (id: string) => envData?.runners?.[id]?.do_not_use !== true;
  const tools = manifestTools(manifest).map(tool => {
    const row = byId.get(tool.tool);
    const license = getDebugToolLicense(tool);
    const detectOnly = isDebugToolDetectOnly(tool);
    return {
      id: tool.tool,
      ...(tool.name ? { name: tool.name } : {}),
      ...(tool.alias ? { alias: tool.alias } : {}),
      ...(tool.group ? { group: tool.group } : {}),
      ...(tool.type ? { type: tool.type } : {}),
      installed: row?.installed ?? null,
      ...(row?.version ? { version: row.version } : {}),
      ...(row?.referenceVersion ? { reference_version: row.referenceVersion } : {}),
      update_available: row?.updateAvailable ?? false,
      ...(row?.configuredPath ? { configured_path: row.configuredPath } : {}),
      ...(row?.detectedPath ? { detected_path: row.detectedPath } : {}),
      ...(row?.isDefaultForAlias !== undefined ? { default_for_alias: row.isDefaultForAlias } : {}),
      ...(tool.alias ? {} : { add_to_path: addToPath(tool.tool) }),
      path_editable: isDebugToolPathEditable(manifest, tool.tool),
      installable_here: isDebugToolCompatible(tool, platform),
      needs_admin: tool.root === true,
      ...(license ? { license } : {}),
      ...(detectOnly ? { vendor_download: { ...(tool.website ? { website: tool.website } : {}) } } : {}),
      ...(row?.note ? { note: row.note } : {}),
    };
  });
  const aliases = (manifest.aliases ?? []).map(alias => {
    const row = byId.get(alias.alias);
    return {
      alias: alias.alias,
      ...(alias.name ? { name: alias.name } : {}),
      ...(row?.defaultTool ? { default_tool: row.defaultTool } : {}),
      ...(alias.default ? { manifest_default: alias.default } : {}),
      variants: manifestTools(manifest).filter(tool => tool.alias === alias.alias).map(tool => tool.tool),
      installed: row?.installed ?? null,
      ...(row?.version ? { version: row.version } : {}),
      ...(row?.configuredPath ? { configured_path: row.configuredPath } : {}),
      ...(row?.detectedPath ? { detected_path: row.detectedPath } : {}),
      add_to_path: addToPath(alias.alias),
      ...(row?.note ? { note: row.note } : {}),
    };
  });
  const packs = getDebugToolPacks(manifest).map(pack => ({ pack: pack.pack, ...(pack.name ? { name: pack.name } : {}), tools: pack.tools ?? [] }));
  return {
    platform,
    env_file: getEnvYamlPath(),
    tools,
    aliases,
    packs,
    extra_paths: getExtraPaths('EXTRA_RUNNERS'),
  };
}

/** A target as an agent reads it. */
function targetDto(target: PyOCDTargetInfo) {
  return {
    name: target.name,
    ...(target.vendor ? { vendor: target.vendor } : {}),
    ...(target.partNumber ? { part_number: target.partNumber } : {}),
    ...(target.source ? { source: target.source } : {}),
  };
}

/** The targets whose name, part number or vendor contains `text`, case-insensitive. */
export function matchPyocdTargets(targets: readonly PyOCDTargetInfo[], text: string) {
  const wanted = text.trim().toLowerCase();
  const matches = targets.filter(target => target.name.toLowerCase().includes(wanted)
    || (target.partNumber ?? '').toLowerCase().includes(wanted)
    || (target.vendor ?? '').toLowerCase().includes(wanted));
  return { total: matches.length, targets: matches.slice(0, MAX_PYOCD_TARGETS).map(targetDto) };
}

const samePath = (a: string, b: string) => normalizeForCompare(path.resolve(a)) === normalizeForCompare(path.resolve(b));

/** Whose venv pyOCD is missing from: the application's, and the west workspace when the venv is the workspace's. */
export interface PyocdVenvOwner {
  appPath?: string;
  westWorkspace?: string;
}

/** The owner of the venv an application's debug session runs pyocd from. */
export function pyocdVenvOwner(app: ZephyrApplication, venvPath: string | undefined): PyocdVenvOwner {
  let shared: string | undefined;
  if (venvPath && app.westWorkspaceRootPath) {
    try {
      shared = getWestWorkspace(app.westWorkspaceRootPath).venvPath;
    } catch {
      // A west workspace that cannot be read has no venv of its own here.
    }
  }
  return { appPath: app.appRootPath, ...(shared && venvPath && samePath(shared, venvPath) ? { westWorkspace: app.westWorkspaceRootPath } : {}) };
}

/**
 * What to do about pyOCD missing from this venv (undefined: the one of the
 * host tools). manage_runners install runs pip in the global venv only, so it
 * cannot fix the venv of an application or a west workspace: the installers
 * of those venvs claim them as their writer, so nothing builds with them
 * meanwhile, and Zephyr's Python requirements they install include pyOCD.
 */
export function pyocdMissingHint(ctx: Ctx, venvPath: string | undefined, owner: PyocdVenvOwner = {}): string {
  const globalVenv = runnerTools.globalVenv();
  if (!venvPath || (globalVenv && samePath(venvPath, globalVenv))) {
    return fullToolHint(ctx, 'manage_runners',
      'Install it with manage_runners {"action": "install", "tools": ["pyocd"]}.',
      'Ask the user to install it with the Zephyr Workbench command "Install Runners", or to allow manage_runners in the AI Manager.');
  }
  const installer = owner.westWorkspace
    ? fullToolHint(ctx, 'manage_west_workspace',
      `Install it there with manage_west_workspace ${JSON.stringify({ action: 'install_python_deps', west_workspace: owner.westWorkspace })}, which installs the Python packages of the workspace, pyOCD among them.`,
      'Ask the user to install it there, or to allow manage_west_workspace in the AI Manager, whose action "install_python_deps" installs it.')
    : owner.appPath
      ? fullToolHint(ctx, 'manage_app',
        `Install it with manage_app ${JSON.stringify({ action: 'create_venv', app_path: owner.appPath })}, which gives the application a venv in its .venv folder with Zephyr's Python requirements, pyOCD among them.`,
        'Ask the user to install it there, or to allow manage_app in the AI Manager, whose action "create_venv" gives the application a venv with pyOCD.')
      : 'Ask the user to run "pip install -U pyocd" in it.';
  const pip = owner.appPath
    ? fullToolHint(ctx, 'run_command',
      ` Otherwise run_command ${JSON.stringify({ action: 'run', app_path: owner.appPath, command: 'pip install -U pyocd' })} installs it alone.`, '')
    : '';
  return `manage_runners install puts pyOCD in ${globalVenv ? `the global Python environment ${globalVenv}` : 'the Python environment of the host tools'} only, not in ${venvPath}. `
    + `${installer}${pip}`;
}

/**
 * The pyOCD state list_runners include pyocd reports, read from the venv a
 * debug session uses. Never downloads the pack index: when it is missing the
 * answer says so.
 */
export async function pyocdView(ctx: Ctx, options: { venvPath?: string; owner?: PyocdVenvOwner; boardTarget?: string | null; search?: string }) {
  const { pyocd } = runnerTools;
  const version = await pyocd.version(options.venvPath);
  if (!version) {
    return {
      installed: false,
      ...(options.venvPath ? { venv_path: options.venvPath } : {}),
      hint: `pyOCD is not installed in this Python environment. ${pyocdMissingHint(ctx, options.venvPath, options.owner)}`,
    };
  }
  const notes: string[] = [];
  const index = await pyocd.hasIndex(options.venvPath);
  let packs: Array<{ pack: string; version?: string }> = [];
  try {
    packs = (await pyocd.installedPacks(options.venvPath)).map(pack => ({ pack: pack.pack, ...(pack.version ? { version: pack.version } : {}) }));
  } catch (error) {
    notes.push(`The installed packs could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  let targets: PyOCDTargetInfo[] | undefined;
  if (options.boardTarget || options.search) {
    try {
      targets = await pyocd.targets(options.venvPath);
    } catch (error) {
      notes.push(`The pyOCD targets could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let board: Record<string, unknown> | undefined;
  if (options.boardTarget !== undefined) {
    const name = options.boardTarget;
    const known = name && targets ? targets.find(target => target.name.toLowerCase() === name.toLowerCase()) : undefined;
    board = name
      ? {
        target: name,
        ...(targets ? { available: !!known } : {}),
        ...(known?.source ? { source: known.source } : {}),
        ...(targets && !known ? { hint: `pyOCD has no support for ${name} yet. Install its pack with manage_runners {"action": "pyocd_install_pack", "pyocd_target": "${name}"}.` } : {}),
      }
      : { target: null, note: 'The runners.yaml of this build names no pyOCD target.' };
  }
  if (index === false) {
    notes.push('The CMSIS pack index was never downloaded. manage_runners action "pyocd_install_pack" downloads it first, or action "pyocd_update_index" downloads it alone.');
  }
  return {
    installed: true,
    version,
    ...(options.venvPath ? { venv_path: options.venvPath } : {}),
    pack_index: index ?? null,
    installed_packs: packs,
    ...(board ? { board } : {}),
    ...(options.search !== undefined && targets ? { search: { text: options.search, ...matchPyocdTargets(targets, options.search) } } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}
