// The host half of search_zephyr_catalog: where each kind of entry comes from,
// and the per-window cache in front of it.
//
// Boards, shields and blobs come from west, which is slow (seconds, much more
// on Windows), so a listing is cached and shared by every call that asks for
// it while it runs. Samples, tests and snippets are read from the filesystem.
// Projects come from the workspace manifest, or from GitHub for a repository,
// revisions from git ls-remote, and templates from the bundled template file,
// each looked up on every call. Nothing here shows UI, starts a task or writes
// a file, and no root an agent supplies ever reaches the west command line:
// roots come only from settings and from build folders that already exist.

import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import {
  boardRootShellArg, getSnippetRoots, getWestBlobs, getWestBoards, getWestShields, WestCommandError, WestRunOptions,
} from '../../commands/WestCommands';
import {
  ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY,
} from '../../constants';
import { WestWorkspace } from '../../models/WestWorkspace';
import { ZephyrApplication } from '../../models/ZephyrApplication';
import { getConfiguredWorkbenchPath, getGitBranches, getGitTags } from '../../utils/execUtils';
import { getAppTemplateDisplayPath, getListSamples } from '../../utils/utils';
import { collectBoardRootsReadOnly, selectableBoardIdentifiers } from '../../utils/zephyr/boardDiscovery';
import { findSnippets, readBoardYmlMetadata } from '../../utils/zephyr/catalogFiles';
import { getUpstreamProjectNames, loadTemplateConfig } from '../../utils/zephyr/manifestUtils';
import { resolveBaseModules } from '../../utils/zephyr/templateData';
import { getWorkspaceDetails, manifestWorkspaceOf, readProjectFilterTokens, WestManagerWorkspaceDetails } from '../../utils/zephyr/westManifestEdit';
import { assertSafeShellFragment, isInside, isPlainPath, isPlainShellArgument, normalizeForCompare } from '../core/argSafety';
import {
  BlobEntry, BoardEntry, CatalogEntry, ListedKind, SampleEntry, ShieldEntry, SnippetEntry, TemplateEntry, westFailureToToolError,
} from '../core/catalogSearch';
import { McpToolError, toToolError } from '../core/errors';
import { TtlCache } from '../core/ttlCache';

export type CatalogSource = 'west boards' | 'west shields' | 'west blobs list' | 'filesystem';

export interface CatalogListing {
  source: CatalogSource;
  entries: CatalogEntry[];
  /** Configured roots left out because they are not safe on a shell command line. */
  skippedRoots: string[];
}

export interface CatalogResult extends CatalogListing {
  /** True when the listing came from the cache instead of a run this call waited on. */
  cached: boolean;
  listedAt: number;
}

/** Long enough to be worth caching, short enough that a stale list does not linger. */
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 32;
/**
 * Past this, west is stopped. A tool call waits less than this and leaves the
 * run going, so a retry picks up the result instead of starting over.
 */
export const WEST_LIST_TIMEOUT_MS = 120_000;
/** board.yml files read at once while adding vendors and full names. */
const METADATA_BATCH_SIZE = 64;

function unique(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter(entry => {
    const key = normalizeForCompare(entry);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * Roots go onto the west command line, quoted only for whitespace, and come
 * from settings an agent may have been able to influence. Anything that could
 * break out of the argument is left out and reported instead. Only plain paths
 * pass, checked both as set and as the exact argument the active shell gets,
 * because the workbench rewrites a root on the way (a `%NAME%` in it becomes
 * `${NAME}` for bash, where `%IFS%` would split it into several arguments).
 */
export function shellSafeRoots(roots: string[]): { safe: string[]; skipped: string[] } {
  const safe: string[] = [];
  const skipped: string[] = [];
  for (const root of roots) {
    let ok = path.isAbsolute(root) && isPlainPath(root) && isPlainShellArgument(boardRootShellArg(root));
    if (ok) {
      try {
        assertSafeShellFragment(root, 'board root');
      } catch {
        ok = false;
      }
    }
    (ok ? safe : skipped).push(root);
  }
  return { safe, skipped };
}

/**
 * The same check execWestCommandWithEnv makes, done up front so a missing or
 * deleted environment script is reported as a setup gap with its fix.
 */
function assertEnvScript(workspace: WestWorkspace): void {
  const envScript = getConfiguredWorkbenchPath(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, workspace.rootUri);
  if (!envScript || !fs.existsSync(envScript)) {
    throw toToolError(new Error(
      envScript ? `The Zephyr environment script "${envScript}" does not exist.` : 'The Zephyr environment script is not set.',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` },
    ));
  }
}

function westError(command: 'west boards' | 'west shields' | 'west blobs list', error: unknown): Error {
  if (error instanceof WestCommandError) {
    return westFailureToToolError(command, { message: error.message, stderr: error.stderr, stopped: error.stopped });
  }
  // execWestCommandWithEnv names the venv setting as the cause when the
  // configured Python environment is gone: a setup gap like a missing env
  // script, which toToolError alone would report as a crash.
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  if (cause === `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY}`) {
    return new McpToolError('ENV_NOT_READY', `${command} cannot run: the configured Python virtual environment does not exist.`, {
      hint: `Ask the user to fix the ${cause} setting or run the Zephyr Workbench command "Install Host Tools", then retry. get_status shows what else is missing.`,
    });
  }
  return toToolError(error);
}

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function withTimeout<T>(pending: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new McpToolError('TIMEOUT', message)), timeoutMs);
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

async function inBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index += size) {
    await Promise.all(items.slice(index, index + size).map(run));
  }
}

/** The west projects of a workspace manifest, with what the workspace imports and its .west/config. */
export interface WorkspaceProjects {
  details: WestManagerWorkspaceDetails;
  /** manifest.project-filter of .west/config. */
  projectFilter: string[];
  /** Whether the Rust module is checked out, which needs west update after enabling it. */
  rustModulePresent: boolean;
}

/** Tags and branches of a repository; a side that failed carries its error instead. */
export interface RevisionListing {
  tags: string[] | Error;
  branches: string[] | Error;
}

export class CatalogSources {
  private readonly cache = new TtlCache<CatalogListing>({ ttlMs: CACHE_TTL_MS, maxEntries: CACHE_MAX_ENTRIES });
  /**
   * Bumped by invalidate(root) and part of every cache key of that root, so a
   * west update, a manifest edit or a *_ROOT change is never answered from a
   * listing made before it. The old entries simply age out.
   */
  private readonly generations = new Map<string, number>();

  /** Forget every listing of the west workspace at `root`. */
  invalidate(root: string): void {
    const key = normalizeForCompare(root);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }

  /**
   * Every entry of one kind in a west workspace, plus an application's own
   * roots when one is given. The promise is shared with any call already
   * waiting on the same listing, and a west run outlives a caller that gives
   * up on it, so the next call gets its result.
   */
  async list(kind: ListedKind, workspace: WestWorkspace, app: ZephyrApplication | undefined, refresh: boolean): Promise<CatalogResult> {
    const { key, load } = this.plan(kind, workspace, app, refresh);
    const result = await this.cache.get(key, load, refresh);
    return { ...result.value, cached: result.cached, listedAt: result.storedAt };
  }

  private plan(kind: ListedKind, workspace: WestWorkspace, app: ZephyrApplication | undefined, refresh: boolean): {
    key: string;
    load: () => Promise<CatalogListing>;
  } {
    // Samples and tests come from one walk, so they share one listing.
    const listingKind = kind === 'sample' || kind === 'test' ? 'samples' : kind;
    let roots: string[] = [];
    let skipped: string[] = [];
    // Folders searched, whose snippets west build -S only finds once the
    // application adds them to SNIPPET_ROOT itself.
    let optInRoots: string[] = [];
    if (kind === 'board' || kind === 'shield') {
      // Every configuration with a build contributes its BOARD_ROOT; one that
      // was never configured contributes nothing rather than being configured.
      const configs = app && app.buildConfigs.length > 0 ? app.buildConfigs : [undefined];
      const { safe, skipped: unsafe } = shellSafeRoots(unique(configs.flatMap(config => collectBoardRootsReadOnly(workspace, app, config))));
      roots = safe;
      skipped = unsafe;
    } else if (kind === 'snippet') {
      roots = unique(getSnippetRoots(workspace, app));
      // A Zephyr that no longer searches the application folder by itself
      // still gets it listed, so an application that wires it up is covered,
      // but its entries say what they need.
      if (app && !roots.some(root => normalizeForCompare(root) === normalizeForCompare(app.appRootPath))) {
        optInRoots = [app.appRootPath];
      }
    }
    // The workspace version and its west config date make a `west update` to
    // a new release, or a manifest change, miss the cache without a refresh.
    const rootKey = normalizeForCompare(workspace.rootUri.fsPath);
    const key = JSON.stringify([
      listingKind,
      rootKey,
      this.generations.get(rootKey) ?? 0,
      workspace.version,
      mtimeOf(workspace.westConfUri.fsPath),
      roots.map(root => normalizeForCompare(root)).sort(),
      optInRoots.map(root => normalizeForCompare(root)),
    ]);
    // A refresh also probes west's --format again, so fields a `west update`
    // added are not hidden by the format an older Zephyr needed.
    const runOpts = { timeoutMs: WEST_LIST_TIMEOUT_MS, reprobe: refresh };
    const load = async (): Promise<CatalogListing> => {
      switch (listingKind) {
        case 'board':
          return { source: 'west boards', entries: await this.loadBoards(workspace, roots, runOpts), skippedRoots: skipped };
        case 'shield':
          return { source: 'west shields', entries: await this.loadShields(workspace, roots, runOpts), skippedRoots: skipped };
        case 'snippet':
          return { source: 'filesystem', entries: await this.loadSnippets(roots, optInRoots), skippedRoots: [] };
        case 'blob':
          return { source: 'west blobs list', entries: await this.loadBlobs(workspace, runOpts), skippedRoots: [] };
        default:
          return { source: 'filesystem', entries: await this.loadSamples(workspace), skippedRoots: [] };
      }
    };
    return { key, load };
  }

  private async loadBoards(workspace: WestWorkspace, roots: string[], runOpts: WestRunOptions): Promise<BoardEntry[]> {
    assertEnvScript(workspace);
    let infos;
    try {
      infos = await getWestBoards(workspace, roots, runOpts);
    } catch (error) {
      throw westError('west boards', error);
    }
    const seen = new Set<string>();
    const entries: BoardEntry[] = [];
    for (const info of infos) {
      const key = `${info.name}|${info.dir}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      entries.push({
        name: info.name,
        identifiers: selectableBoardIdentifiers(info),
        qualifiers: info.qualifiers,
        revisions: info.revisions,
        ...(info.revisionDefault ? { revision_default: info.revisionDefault } : {}),
        dir: info.dir,
      });
    }
    // Vendor and full name come from board.yml rather than from extra west
    // format fields, which older Zephyr versions reject and the UI relies on.
    await inBatches(entries, METADATA_BATCH_SIZE, async entry => {
      Object.assign(entry, await readBoardYmlMetadata(entry.dir, entry.name));
    });
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async loadShields(workspace: WestWorkspace, roots: string[], runOpts: WestRunOptions): Promise<ShieldEntry[]> {
    assertEnvScript(workspace);
    let shields;
    try {
      shields = await getWestShields(workspace, roots, runOpts);
    } catch (error) {
      throw westError('west shields', error);
    }
    return shields
      .map(shield => ({
        name: shield.name,
        ...(shield.dir ? { dir: shield.dir } : {}),
        ...(shield.vendor ? { vendor: shield.vendor } : {}),
        ...(shield.fullName ? { full_name: shield.fullName } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private async loadBlobs(workspace: WestWorkspace, runOpts: WestRunOptions): Promise<BlobEntry[]> {
    assertEnvScript(workspace);
    let blobs;
    try {
      blobs = await getWestBlobs(workspace, runOpts);
    } catch (error) {
      throw westError('west blobs list', error);
    }
    return blobs
      .map((blob): BlobEntry => ({
        name: blob.path,
        module: blob.module,
        status: blob.status,
        ...(blob.type ? { type: blob.type } : {}),
        ...(blob.license ? { license: blob.license } : {}),
        ...(blob.url ? { url: blob.url } : {}),
      }))
      .sort((a, b) => a.module.localeCompare(b.module) || a.name.localeCompare(b.name));
  }

  /** The west projects the workspace manifest can import, and which it does. */
  workspaceProjects(workspace: WestWorkspace): WorkspaceProjects {
    return {
      details: getWorkspaceDetails(manifestWorkspaceOf(workspace)),
      projectFilter: readProjectFilterTokens(workspace.westConfUri.fsPath),
      rustModulePresent: fs.existsSync(workspace.rustModuleUri.fsPath),
    };
  }

  /** The projects the west.yml of a GitHub Zephyr repository lists at `revision`, sorted. */
  upstreamProjects(url: string, revision: string, timeoutMs: number): Promise<string[]> {
    return withTimeout(getUpstreamProjectNames(url, revision), timeoutMs,
      `GitHub did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
  }

  /**
   * Tags and branches of `url`, asked for in parallel under one deadline, with
   * git never prompting for credentials. A side that fails, or runs out of
   * time, carries its error so the other can still be returned.
   */
  async revisions(url: string, timeoutMs: number): Promise<RevisionListing> {
    const opts = { nonInteractive: true, timeoutMs };
    const [tags, branches] = await Promise.allSettled([getGitTags(url, opts), getGitBranches(url, opts)]);
    const settled = (result: PromiseSettledResult<string[]>) => (result.status === 'fulfilled'
      ? result.value
      : result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
    return { tags: settled(tags), branches: settled(branches) };
  }

  /** The bundled workspace templates, and the base modules a revision gets, when one is given. */
  templates(extensionUri: vscode.Uri, revision?: string): { templates: TemplateEntry[]; baseModules?: string[] } {
    const config = loadTemplateConfig(extensionUri);
    return {
      templates: config.templates.map(template => ({
        name: template.label,
        modules: [...template.modules],
        ...(template.isDefault ? { default: true } : {}),
      })),
      ...(revision !== undefined ? { baseModules: resolveBaseModules(config.baseModules, revision) } : {}),
    };
  }

  private async loadSnippets(roots: string[], optInRoots: string[]): Promise<SnippetEntry[]> {
    const optIn = new Set(optInRoots.map(root => normalizeForCompare(root)));
    return (await findSnippets([...roots, ...optInRoots])).map(snippet => ({
      name: snippet.name,
      dir: snippet.dir,
      root: snippet.root,
      ...(optIn.has(normalizeForCompare(snippet.root)) ? { needs_snippet_root: true } : {}),
    }));
  }

  private async loadSamples(workspace: WestWorkspace): Promise<SampleEntry[]> {
    const kernel = workspace.kernelUri.fsPath;
    const rustModule = workspace.rustModuleUri.fsPath;
    return (await getListSamples(workspace))
      .map((sample): SampleEntry => {
        const samplePath = sample.rootDir.fsPath;
        return {
          name: sample.name,
          kind: sample.kind,
          path: samplePath,
          display_path: getAppTemplateDisplayPath(samplePath, workspace),
          source: isInside(samplePath, rustModule) ? 'rust_module' : isInside(samplePath, kernel) ? 'zephyr' : 'workspace',
        };
      })
      .sort((a, b) => a.display_path.localeCompare(b.display_path));
  }
}
