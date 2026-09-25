// search_zephyr_catalog: what a west workspace offers, and what a new one can
// be made from. Read-only. A board, shield, snippet, sample, test or blob
// listing comes from west or the filesystem once and is cached; projects,
// revisions and templates are looked up on each call. Every filter an agent
// supplies is applied here, in-process, and never reaches west or a shell; a
// repository URL or revision is checked against a strict shape before the
// server sees it.

import { readSampleYamlMetadata } from '../../../utils/zephyr/catalogFiles';
import { ZEPHYR_LANG_RUST_PROJECT_NAME } from '../../../utils/zephyr/manifestUtils';
import {
  CATALOG_KINDS, CatalogEntry, CatalogKind, filterCatalog, isListedKind, ListedKind, pageEntries, ProjectEntry, RevisionEntry,
  SampleEntry, SnippetEntry, VENDOR_KINDS,
} from '../../core/catalogSearch';
import { McpToolError } from '../../core/errors';
import { assertGitRevision, assertGitUrl } from '../../core/gitArgs';
import { matcherFor } from '../../core/match';
import { ToolContext, ToolHandler } from '../../core/toolSpec';
import { CatalogResult } from '../catalogSources';
import { HostDeps } from './deps';
import { remainingWaitMs } from './progress';

type Ctx = ToolContext<HostDeps>;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/**
 * Characters of entries per page. The result goes out as text and as
 * structured content, and the tool declares 100000 characters at most.
 */
const PAGE_BUDGET = 40000;
const HEARTBEAT_MS = 5000;
const MAX_VENDOR_LENGTH = 100;
/**
 * The wait setting is how long an action holds on before handing back a job,
 * and 0 is valid there. A search has no job to hand back, so it always waits
 * at least this long, enough for a filesystem listing or a cached one.
 */
const MIN_WAIT_SEC = 10;

/** What the progress message says is running, per kind. */
const LISTING: Record<CatalogKind, string> = {
  board: 'Running west boards',
  shield: 'Running west shields',
  snippet: 'Reading snippet.yml files',
  sample: 'Looking for samples',
  test: 'Looking for tests',
  blob: 'Running west blobs list',
  project: 'Reading the west projects',
  revision: 'Asking the server for tags and branches',
  template: 'Reading the workspace templates',
};

/** The upstream Zephyr repository, which the revision and project lookups of a new workspace default to. */
const UPSTREAM_ZEPHYR_URL = 'https://github.com/zephyrproject-rtos/zephyr';
/** At most this long per ls-remote or GitHub request, and never past the call's own budget. */
const REMOTE_TIMEOUT_MS = 30_000;
/** Kept back from the call budget, so the answer is sent before the agent gives up. */
const REMOTE_MARGIN_MS = 3_000;

/**
 * Wait for a listing within the call's time budget, with a progress heartbeat
 * so clients that reset their timeout on progress keep the call alive. Giving
 * up does not stop the listing: it keeps running and fills the cache, so
 * calling again picks up its result instead of starting west over. A retry of
 * a refresh must drop refresh for that: with it, a listing that finished in
 * between would be thrown away and west started again.
 */
function waitForListing(ctx: Ctx, pending: Promise<CatalogResult>, kind: ListedKind, refresh: boolean): Promise<CatalogResult> {
  const budgetMs = remainingWaitMs(ctx, Math.max(MIN_WAIT_SEC, ctx.deps.defaultWaitSeconds));
  const nextCall = refresh ? 'the next call without refresh' : 'the next call with the same arguments';
  const retry = refresh
    ? 'Call search_zephyr_catalog again in a few seconds with the same arguments but without refresh, which picks up the listing that is building now.'
    : 'Call search_zephyr_catalog again with the same arguments in a few seconds.';
  return new Promise((resolve, reject) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const onAbort = () => finish(() => reject(new McpToolError('TIMEOUT',
      `The call was cancelled before the listing finished. The listing keeps running, so ${nextCall} gets its result.`)));
    const finish = (outcome: () => void) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      ctx.signal.removeEventListener('abort', onAbort);
      outcome();
    };

    pending.then(result => finish(() => resolve(result)), error => finish(() => reject(error)));
    heartbeat = setInterval(() => ctx.progress({
      progress: Math.round((Date.now() - ctx.startedAt) / 1000),
      message: `${LISTING[kind]}...`,
    }), HEARTBEAT_MS);
    timer = setTimeout(() => finish(() => reject(new McpToolError('TIMEOUT',
      `The ${kind} list is not ready after ${Math.round((Date.now() - ctx.startedAt) / 1000)} seconds. It keeps building in the background, so ${nextCall} gets it.`, {
        hint: retry,
      }))), budgetMs);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal.aborted) {
      onAbort();
    }
  });
}

/** Sample title and description, read only for the entries being returned. */
async function withSampleMetadata(entries: SampleEntry[]): Promise<SampleEntry[]> {
  // New objects: the listing entries are shared with the cache.
  return Promise.all(entries.map(async entry => ({ ...entry, ...await readSampleYamlMetadata(entry.path) })));
}

function coverageNote(kind: CatalogKind): string | undefined {
  switch (kind) {
    case 'sample':
    case 'test':
      return 'Samples and tests are looked for under the samples and tests folders of Zephyr, the Rust module samples and the top-level folders of the west workspace; those inside other modules are not listed.';
    case 'snippet':
      return 'Snippets are looked for under the snippets folder of Zephyr, of each SNIPPET_ROOT setting and of the application; snippet roots declared by other modules are not listed.';
    default:
      return undefined;
  }
}

/** Which of url, revision, app_path and west_workspace each kind takes; the rest are refused. */
function checkKindArgs(kind: CatalogKind, args: Record<string, unknown>): void {
  const url = str(args.url);
  const revision = str(args.revision);
  const workspaceGiven = args.west_workspace !== undefined || args.app_path !== undefined;
  const refuse = (message: string, hint?: string) => new McpToolError('INVALID_ARGUMENT', message, { hint });
  if (url !== undefined && kind !== 'revision' && kind !== 'project') {
    throw refuse(`url only applies to kind "revision" or "project", not "${kind}".`);
  }
  if (revision !== undefined && kind !== 'template' && !(kind === 'project' && url !== undefined)) {
    throw refuse(kind === 'project'
      ? 'revision only applies to kind "project" together with url. A west workspace uses the revision of its manifest.'
      : `revision only applies to kind "template", or to kind "project" with url, not "${kind}".`);
  }
  if (url !== undefined && workspaceGiven) {
    throw refuse('Pass url, or west_workspace and app_path, not both.',
      'Pass url to ask about a repository, or west_workspace to use the repository of that workspace.');
  }
  if (kind === 'template' && workspaceGiven) {
    throw refuse('kind "template" lists the bundled templates and takes no west_workspace or app_path.');
  }
  if (kind === 'project' && url !== undefined && revision === undefined) {
    throw refuse('kind "project" with url also needs revision.',
      'Call search_zephyr_catalog with kind "revision" and the same url to list the revisions.');
  }
  if (url !== undefined) {
    assertGitUrl(url);
  }
  if (revision !== undefined) {
    assertGitRevision(revision);
  }
}

/** Milliseconds a remote lookup may take within this call. */
function remoteTimeoutMs(ctx: Ctx): number {
  const budget = remainingWaitMs(ctx, Math.max(MIN_WAIT_SEC, ctx.deps.defaultWaitSeconds)) - REMOTE_MARGIN_MS;
  return Math.max(1000, Math.min(REMOTE_TIMEOUT_MS, budget));
}

/** Run a lookup with a progress heartbeat, so clients that reset their timeout on progress keep the call alive. */
async function withHeartbeat<T>(ctx: Ctx, kind: CatalogKind, work: () => Promise<T>): Promise<T> {
  const heartbeat = setInterval(() => ctx.progress({
    progress: Math.round((Date.now() - ctx.startedAt) / 1000),
    message: `${LISTING[kind]}...`,
  }), HEARTBEAT_MS);
  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
  }
}

interface Paging {
  matches?: (text: string) => boolean;
  offset: number;
  limit: number;
}

/** One page of entries, with the paging fields every kind returns. */
function pageOf<T extends CatalogEntry>(entries: readonly T[], paging: Paging) {
  const selected = filterCatalog(entries, { matches: paging.matches });
  const { page: items } = pageEntries(selected.slice(paging.offset, paging.offset + paging.limit), 0, paging.limit, PAGE_BUDGET);
  const next = paging.offset + items.length;
  return { total_matches: selected.length, items, ...(next < selected.length ? { next_offset: next } : {}) };
}

function lookupFailed(what: string, error: unknown): McpToolError {
  if (error instanceof McpToolError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new McpToolError(/did not finish|did not answer|timed? ?out/i.test(message) ? 'TIMEOUT' : 'DEPENDENCY_MISSING',
    `${what} failed: ${message}`, {
      hint: 'Check the URL and revision, and that this machine reaches the server; a private repository needs credentials usable without a prompt.',
    });
}

function manifestUnreadable(root: string, error: unknown): McpToolError {
  return new McpToolError('ENV_NOT_READY', `The manifest of "${root}" cannot be read: ${error instanceof Error ? error.message : String(error)}`, {
    hint: 'Ask the user to check the manifest file .west/config names, then retry.',
  });
}

async function searchProjects(args: Record<string, unknown>, ctx: Ctx, paging: Paging) {
  const { services } = ctx.deps;
  const url = str(args.url);
  if (url !== undefined) {
    const revision = str(args.revision) as string;
    let names: string[];
    try {
      names = await withHeartbeat(ctx, 'project', () => services.catalog.upstreamProjects(url, revision, remoteTimeoutMs(ctx)));
    } catch (error) {
      throw lookupFailed(`Reading the west.yml of ${url} at ${revision}`, error);
    }
    return {
      kind: 'project', url, revision, source: 'upstream west.yml',
      ...pageOf(names.map((name): ProjectEntry => ({ name })), paging),
      note: 'These are the projects the Zephyr west.yml lists at this revision; pass the extra ones to fetch as projects to manage_west_workspace action "create", which only the full toolset offers.',
    };
  }
  const { workspace, app } = await services.resolveWestWorkspace(str(args.west_workspace), str(args.app_path));
  let listing;
  try {
    listing = services.catalog.workspaceProjects(workspace);
  } catch (error) {
    throw manifestUnreadable(workspace.rootUri.fsPath, error);
  }
  const { details } = listing;
  const selected = new Set(details.selectedProjects);
  const entries = details.availableProjects.map((name): ProjectEntry => ({ name, selected: details.importAll || selected.has(name) }));
  return {
    kind: 'project',
    west_workspace: workspace.rootUri.fsPath,
    zephyr_version: workspace.version,
    ...(app ? { app_path: app.appRootPath } : {}),
    manifest: {
      path: details.manifestPath,
      zephyr_revision: details.zephyrRevision,
      repo_url: details.zephyrRepoUrl,
      import_all: details.importAll,
      topology_supported: details.supported,
      ...(details.unsupportedReason ? { unsupported_reason: details.unsupportedReason } : {}),
      rust_enabled: details.rustEnabled,
      rust_module_present: listing.rustModulePresent,
      project_sources: [details.zephyrWestPath, ...details.submanifestPaths],
    },
    west_config: {
      path: details.configPath,
      manifest_path: workspace.manifestPath,
      manifest_file: workspace.manifestFile,
      zephyr_base: workspace.zephyrBase,
      project_filter: listing.projectFilter,
    },
    ...pageOf(entries, paging),
    ...(details.rustEnabled && !listing.rustModulePresent
      ? { note: `${ZEPHYR_LANG_RUST_PROJECT_NAME} is enabled but not checked out yet: run west update with manage_west_workspace action "update", which only the full toolset offers.` }
      : {}),
  };
}

async function searchRevisions(args: Record<string, unknown>, ctx: Ctx, paging: Paging) {
  const { services } = ctx.deps;
  let url = str(args.url);
  let workspaceRoot: string | undefined;
  let current: string | undefined;
  const workspaceGiven = args.west_workspace !== undefined || args.app_path !== undefined;
  // With nothing named, the window's only workspace; with none or several, upstream Zephyr.
  if (url === undefined && (workspaceGiven || services.listWestWorkspaces().length === 1)) {
    const { workspace } = await services.resolveWestWorkspace(str(args.west_workspace), str(args.app_path));
    workspaceRoot = workspace.rootUri.fsPath;
    let details;
    try {
      details = services.catalog.workspaceProjects(workspace).details;
    } catch (error) {
      throw manifestUnreadable(workspaceRoot, error);
    }
    if (!details.zephyrRepoUrl) {
      throw new McpToolError('INVALID_ARGUMENT', `The manifest of "${workspaceRoot}" does not say where its Zephyr repository is.`, {
        hint: 'Pass url with the Zephyr repository instead.',
      });
    }
    // The manifest's own URL is checked like an agent's, since it reaches the server too.
    url = assertGitUrl(details.zephyrRepoUrl, 'the Zephyr repository URL of the manifest');
    current = details.zephyrRevision || undefined;
  }
  const repository = url ?? UPSTREAM_ZEPHYR_URL;
  const listing = await withHeartbeat(ctx, 'revision', () => services.catalog.revisions(repository, remoteTimeoutMs(ctx)));
  if (listing.tags instanceof Error && listing.branches instanceof Error) {
    throw lookupFailed(`Listing the revisions of ${repository}`, listing.tags);
  }
  const entries: RevisionEntry[] = [
    ...(Array.isArray(listing.tags) ? listing.tags.map((name): RevisionEntry => ({ name, type: 'tag' })) : []),
    ...(Array.isArray(listing.branches) ? listing.branches.map((name): RevisionEntry => ({ name, type: 'branch' })) : []),
  ].map(entry => (entry.name === current ? { ...entry, current: true } : entry));
  const missing = listing.tags instanceof Error ? { side: 'tags', error: listing.tags }
    : listing.branches instanceof Error ? { side: 'branches', error: listing.branches } : undefined;
  return {
    kind: 'revision',
    url: repository,
    ...(workspaceRoot ? { west_workspace: workspaceRoot } : {}),
    ...(current ? { current_revision: current } : {}),
    ...pageOf(entries, paging),
    ...(missing ? { note: `Only part of the list: the ${missing.side} could not be read (${missing.error.message}).` } : {}),
  };
}

function searchTemplates(args: Record<string, unknown>, ctx: Ctx, paging: Paging) {
  const revision = str(args.revision);
  let found;
  try {
    found = ctx.deps.services.catalog.templates(ctx.deps.extensionContext.extensionUri, revision);
  } catch (error) {
    throw new McpToolError('INTERNAL', error instanceof Error ? error.message : String(error));
  }
  return {
    kind: 'template',
    ...(revision !== undefined ? { revision, base_modules: found.baseModules } : {}),
    ...pageOf(found.templates, paging),
    note: revision !== undefined
      ? 'A minimal workspace fetches these base modules, plus the modules of the chosen templates and any extra projects.'
      : 'Pass revision to see the base modules every minimal workspace of that Zephyr revision gets on top of the template modules.',
  };
}

export const searchZephyrCatalog: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const { services } = ctx.deps;
  const requestedKind = str(args.kind);
  if (!requestedKind || !(CATALOG_KINDS as readonly string[]).includes(requestedKind)) {
    throw new McpToolError('INVALID_ARGUMENT', `kind must be one of ${CATALOG_KINDS.join(', ')}.`);
  }
  const kind = requestedKind as CatalogKind;
  const matches = matcherFor(str(args.pattern));
  const vendor = str(args.vendor)?.trim() || undefined;
  if (vendor !== undefined && !VENDOR_KINDS.includes(kind)) {
    throw new McpToolError('INVALID_ARGUMENT', `vendor only applies to kind "board" or "shield", not "${kind}".`, {
      hint: 'Drop vendor, or put the vendor name in pattern instead.',
    });
  }
  if (vendor !== undefined && vendor.length > MAX_VENDOR_LENGTH) {
    throw new McpToolError('INVALID_ARGUMENT', `vendor is longer than ${MAX_VENDOR_LENGTH} characters.`);
  }
  checkKindArgs(kind, args);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(num(args.limit) ?? DEFAULT_LIMIT)));
  const offset = Math.max(0, Math.floor(num(args.offset) ?? 0));

  if (!isListedKind(kind)) {
    const paging = { matches, offset, limit };
    switch (kind) {
      case 'project':
        return searchProjects(args, ctx, paging);
      case 'revision':
        return searchRevisions(args, ctx, paging);
      default:
        return searchTemplates(args, ctx, paging);
    }
  }

  const refresh = bool(args.refresh) ?? false;
  const { workspace, app } = await services.resolveWestWorkspace(str(args.west_workspace), str(args.app_path));
  if (kind === 'blob' && !workspace.supportsBlobs) {
    throw new McpToolError('INVALID_ARGUMENT', `west blobs needs Zephyr 3.2 or newer, and "${workspace.rootUri.fsPath}" is on ${workspace.version}.`, {
      hint: 'This workspace has no blobs west can list or fetch.',
    });
  }
  const listing = await waitForListing(ctx, services.catalog.list(kind, workspace, app, refresh), kind, refresh);

  const ofKind: CatalogEntry[] = kind === 'sample' || kind === 'test'
    ? listing.entries.filter(entry => (entry as SampleEntry).kind === kind)
    : listing.entries;
  const selected = filterCatalog(ofKind, { matches, vendor });
  let window = selected.slice(offset, offset + limit);
  if (kind === 'sample' || kind === 'test') {
    window = await withSampleMetadata(window as SampleEntry[]);
  }
  const { page } = pageEntries(window, 0, limit, PAGE_BUDGET);
  const next = offset + page.length;

  const notes: string[] = [];
  if (listing.skippedRoots.length > 0) {
    notes.push(`These configured board roots were left out because they are not safe to pass to west: ${listing.skippedRoots.join(', ')}.`);
  }
  if (selected.some(entry => (entry as SnippetEntry).needs_snippet_root)) {
    notes.push('Snippets marked needs_snippet_root are in the application folder, which this Zephyr only searches once the application adds that folder to SNIPPET_ROOT (in its CMakeLists.txt, or with snippet_root in a zephyr/module.yml); west build -S does not find them otherwise.');
  }
  if (kind === 'blob' && selected.some(entry => 'status' in entry && entry.status !== 'present')) {
    notes.push('Blobs whose status is missing or outdated are fetched with manage_west_workspace action "fetch_blobs", which only the full toolset offers.');
  }
  const coverage = selected.length === 0 ? coverageNote(kind) : undefined;
  if (coverage) {
    notes.push(coverage);
  }

  return {
    kind,
    west_workspace: workspace.rootUri.fsPath,
    zephyr_version: workspace.version,
    ...(app ? { app_path: app.appRootPath } : {}),
    source: listing.source,
    cached: listing.cached,
    listed_at: new Date(listing.listedAt).toISOString(),
    total_matches: selected.length,
    items: page,
    ...(next < selected.length ? { next_offset: next } : {}),
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  };
};
