import type { DebugToolAliasEntry, DebugToolEntry, DebugToolsManifest } from './debugToolVersionUtils';

/*
 * Pure lookups over scripts/runners/debug-tools.yml and env.yml, shared by the
 * Install Runners panel and the agent environment check. No vscode import and
 * no process spawns, so it is unit tested directly.
 *
 * Every tool and runner fact comes from the manifest: nothing here names a
 * vendor, so a tool added to the YAML is covered without a code change.
 */

/** The manifest fields read here beyond what the version probe needs. */
export interface ManifestDebugTool extends DebugToolEntry {
  name?: string;
  type?: string;
  vendor?: string;
  os?: Partial<Record<'windows' | 'linux' | 'darwin', unknown>>;
  /**
   * Zephyr runner names this tool serves when they differ from its id and
   * alias, for example a GDB server shipped inside a larger vendor package.
   */
  runners?: string[];
  group?: string;
  website?: string | null;
  /** The installer needs administrator rights (sudo on Linux and macOS, UAC on Windows). */
  root?: boolean;
  /** The panel does not let the user edit its path. */
  no_edit?: boolean;
  /** Set for J-Link: its install scripts download from SEGGER and accept the SEGGER terms of use. */
  ['segger-sources']?: Record<string, string>;
}

/** A vendor pack of the manifest: a set of tools installed together. */
export interface ManifestDebugToolPack {
  pack: string;
  name?: string;
  tools?: string[];
}

/** The env.yml fields the runners panel reads. */
export interface DebugToolEnvData {
  runners?: Record<string, { default?: string; path?: string; do_not_use?: boolean } | undefined>;
  env?: Record<string, string | undefined>;
}

function tools(manifest: DebugToolsManifest): ManifestDebugTool[] {
  return (manifest.debug_tools ?? []) as ManifestDebugTool[];
}

function aliases(manifest: DebugToolsManifest): DebugToolAliasEntry[] {
  return manifest.aliases ?? [];
}

/** The vendor packs of the manifest. */
export function getDebugToolPacks(manifest: DebugToolsManifest): ManifestDebugToolPack[] {
  const packs = (manifest as { packs?: unknown }).packs;
  return Array.isArray(packs)
    ? packs.filter((pack): pack is ManifestDebugToolPack => !!pack && typeof (pack as ManifestDebugToolPack).pack === 'string')
    : [];
}

/**
 * A tool the workbench only detects: its manifest gives no download for any
 * OS (STM32CubeProgrammer, STM32CubeCLT, LinkServer, a custom OpenOCD). The
 * user installs it from its vendor's site.
 */
export function isDebugToolDetectOnly(tool: { os?: unknown }): boolean {
  const os = tool.os as Record<string, unknown> | undefined;
  return !os || typeof os !== 'object' || Object.values(os).every(value => !value);
}

/** The terms the installer of a tool accepts on the user's behalf, if any. */
export function getDebugToolLicense(tool: ManifestDebugTool): { name: string; url?: string } | undefined {
  if (tool['segger-sources']) {
    return { name: 'SEGGER J-Link terms of use', ...(tool.website ? { url: tool.website } : {}) };
  }
  return undefined;
}

/** Whether the user may set the path of a tool or alias, as the Install Runners panel allows. */
export function isDebugToolPathEditable(manifest: DebugToolsManifest, id: string): boolean {
  if (aliases(manifest).some(alias => alias.alias === id)) {
    return true;
  }
  const tool = tools(manifest).find(t => t.tool === id);
  // An alias variant has no path of its own: the alias row holds it.
  return !!tool && !tool.alias && tool.no_edit !== true;
}

/**
 * What installing a pack means, as the Install Runners panel does it: the
 * tools this OS can install are installed, the others with a website are
 * vendor pages for the user, and the rest are skipped.
 */
export function expandDebugToolPack(
  manifest: DebugToolsManifest,
  packId: string,
  platform: NodeJS.Platform = process.platform,
): { install: ManifestDebugTool[]; vendorPages: ManifestDebugTool[]; skipped: string[] } | undefined {
  const pack = getDebugToolPacks(manifest).find(p => p.pack === packId);
  if (!pack) {
    return undefined;
  }
  const install: ManifestDebugTool[] = [];
  const vendorPages: ManifestDebugTool[] = [];
  const skipped: string[] = [];
  for (const id of pack.tools ?? []) {
    const tool = tools(manifest).find(t => t.tool === id);
    if (!tool) {
      skipped.push(id);
    } else if (isDebugToolCompatible(tool, platform)) {
      install.push(tool);
    } else if (tool.website) {
      vendorPages.push(tool);
    } else {
      skipped.push(id);
    }
  }
  return { install, vendorPages, skipped };
}

/** Whether the panel can install this tool on `platform` (its manifest `os` entry is set). */
export function isDebugToolCompatible(tool: { os?: unknown }, platform: NodeJS.Platform = process.platform): boolean {
  const os = tool.os as Partial<Record<string, unknown>> | undefined;
  if (os) {
    switch (platform) {
      case 'linux':
        return os.linux ? true : false;
      case 'win32':
        return os.windows ? true : false;
      case 'darwin':
        return os.darwin ? true : false;
    }
  }
  return false;
}

/**
 * The tool an alias (such as openocd) resolves to: the env.yml default the
 * user chose, then the manifest default, then the first variant.
 */
export function getDefaultToolIdForAlias(
  manifest: DebugToolsManifest,
  envData: DebugToolEnvData | undefined,
  alias: string,
): string | undefined {
  const manifestDefault = aliases(manifest).find(a => a.alias === alias)?.default;
  const firstAliasTool = tools(manifest).find(t => t.alias === alias)?.tool;
  return envData?.runners?.[alias]?.default || manifestDefault || firstAliasTool;
}

/**
 * The entry an alias row is probed with: the alias owns the shared version
 * command, and the selected variant supplies the reference version.
 */
export function buildAliasProbeTool(
  manifest: DebugToolsManifest,
  envData: DebugToolEnvData | undefined,
  alias: string,
): DebugToolEntry | undefined {
  const aliasEntry = aliases(manifest).find(entry => entry.alias === alias);
  if (!aliasEntry) {
    return undefined;
  }
  const selectedToolId = getDefaultToolIdForAlias(manifest, envData, alias);
  const selectedTool = tools(manifest).find(tool => tool.tool === selectedToolId);
  return {
    tool: alias,
    version: selectedTool?.version,
    ['version-command']: aliasEntry['version-command'],
    ['version-file']: aliasEntry['version-file'],
    ['version-regex']: aliasEntry['version-regex'],
  };
}

/** The path the user configured for a tool or alias in env.yml, if any. */
export function getConfiguredDebugToolPath(envData: DebugToolEnvData | undefined, toolId: string): string | undefined {
  const p = envData?.runners?.[toolId]?.path;
  return typeof p === 'string' && p.length > 0 ? p : undefined;
}

/**
 * Manifest ids that report whether a Zephyr runner's host tool is installed:
 * an alias with the runner's name (its row follows the selected variant),
 * else every tool whose id equals the runner or that lists it under `runners`.
 */
export function findDebugToolIdsForRunner(manifest: DebugToolsManifest, runner: string): string[] {
  if (aliases(manifest).some(a => a.alias === runner)) {
    return [runner];
  }
  return tools(manifest)
    .filter(t => t.tool === runner || (Array.isArray(t.runners) && t.runners.includes(runner)))
    .map(t => t.tool);
}

/** Every name a caller may use to pick tools: tool ids, alias ids, and the runner names the manifest maps. */
export function listDebugToolSelectors(manifest: DebugToolsManifest): string[] {
  const names = new Set<string>();
  for (const tool of tools(manifest)) {
    names.add(tool.tool);
    for (const runner of Array.isArray(tool.runners) ? tool.runners : []) {
      names.add(runner);
    }
  }
  for (const alias of aliases(manifest)) {
    names.add(alias.alias);
  }
  return [...names].sort();
}

/**
 * Turn caller-supplied names into manifest ids. Each name may be a tool id,
 * an alias id, or a runner the manifest maps to a tool. Unknown names are
 * returned separately so the caller can refuse them.
 */
export function resolveDebugToolSelectors(
  manifest: DebugToolsManifest,
  selectors: readonly string[],
): { ids: string[]; unknown: string[] } {
  const ids = new Set<string>();
  const unknown: string[] = [];
  for (const selector of selectors) {
    if (tools(manifest).some(t => t.tool === selector) || aliases(manifest).some(a => a.alias === selector)) {
      ids.add(selector);
      continue;
    }
    const mapped = findDebugToolIdsForRunner(manifest, selector);
    if (mapped.length > 0) {
      mapped.forEach(id => ids.add(id));
    } else {
      unknown.push(selector);
    }
  }
  return { ids: [...ids], unknown };
}
