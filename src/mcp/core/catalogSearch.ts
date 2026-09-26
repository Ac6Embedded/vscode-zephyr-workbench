// The pure half of search_zephyr_catalog: entry shapes, in-process filtering,
// paging and the mapping of west failures onto the error contract. Kept free
// of any `vscode` import so it is unit tested directly; the host half, which
// runs west and reads the workspace, lives in host/catalogSources.ts.

import { isUnknownWestCommand, isWestMissing } from '../../utils/zephyr/westFailures';
import { cleanForLog } from './ansi';
import { McpToolError } from './errors';

export const CATALOG_KINDS = ['board', 'shield', 'snippet', 'sample', 'test', 'project', 'revision', 'template', 'blob'] as const;
export type CatalogKind = typeof CATALOG_KINDS[number];

/** Kinds listed once per west workspace and cached; the others are looked up on each call. */
export const LISTED_KINDS = ['board', 'shield', 'snippet', 'sample', 'test', 'blob'] as const;
export type ListedKind = typeof LISTED_KINDS[number];

export function isListedKind(kind: CatalogKind): kind is ListedKind {
  return (LISTED_KINDS as readonly string[]).includes(kind);
}

export interface BoardEntry {
  name: string;
  /** Every identifier `west build -b` accepts for this board, qualifiers and revisions included. */
  identifiers: string[];
  qualifiers: string[];
  revisions: string[];
  revision_default?: string;
  dir: string;
  vendor?: string;
  full_name?: string;
}

export interface ShieldEntry {
  name: string;
  dir?: string;
  vendor?: string;
  full_name?: string;
}

export interface SnippetEntry {
  name: string;
  dir: string;
  root: string;
  /**
   * Set for a snippet in the application folder on a Zephyr that no longer
   * searches that folder by itself: west build -S only finds it once the
   * application adds its folder to SNIPPET_ROOT.
   */
  needs_snippet_root?: boolean;
}

export interface SampleEntry {
  name: string;
  kind: 'sample' | 'test';
  path: string;
  display_path: string;
  source: 'zephyr' | 'rust_module' | 'workspace';
  title?: string;
  description?: string;
}

/** A west project of a manifest. `selected` says whether the workspace imports it. */
export interface ProjectEntry {
  name: string;
  selected?: boolean;
}

/** A git tag or branch of a Zephyr repository. */
export interface RevisionEntry {
  name: string;
  type: 'tag' | 'branch';
  /** The revision the workspace manifest uses now. */
  current?: boolean;
}

/** A bundled workspace template: the west projects it adds to the base modules. */
export interface TemplateEntry {
  name: string;
  modules: string[];
  default?: boolean;
}

/** A binary blob a module of the workspace declares. */
export interface BlobEntry {
  /** The blob's path, relative to <module>/zephyr/blobs. */
  name: string;
  module: string;
  status: 'present' | 'outdated' | 'missing';
  type?: string;
  license?: string;
  url?: string;
}

export type CatalogEntry = BoardEntry | ShieldEntry | SnippetEntry | SampleEntry
  | ProjectEntry | RevisionEntry | TemplateEntry | BlobEntry;

/** Kinds whose entries carry a vendor, so the vendor filter means something. */
export const VENDOR_KINDS: readonly CatalogKind[] = ['board', 'shield'];

/** The text a pattern is matched against for one entry. */
export function searchableText(entry: CatalogEntry): string[] {
  const texts = [entry.name];
  if ('identifiers' in entry) {
    texts.push(...entry.identifiers);
  }
  if ('vendor' in entry && entry.vendor) {
    texts.push(entry.vendor);
  }
  if ('full_name' in entry && entry.full_name) {
    texts.push(entry.full_name);
  }
  if ('display_path' in entry) {
    texts.push(entry.display_path);
  }
  if ('module' in entry) {
    texts.push(entry.module);
  }
  if ('modules' in entry) {
    texts.push(...entry.modules);
  }
  return texts;
}

/**
 * Keep the entries that match. `matches` is a compiled wildcard matcher, never
 * a regular expression, and any one field matching is enough. `vendor` is an
 * exact, case-insensitive comparison, so "st" does not also pick "stm".
 */
export function filterCatalog<T extends CatalogEntry>(
  entries: readonly T[],
  filters: { matches?: (text: string) => boolean; vendor?: string },
): T[] {
  const vendor = filters.vendor?.trim().toLowerCase();
  return entries.filter(entry => {
    if (vendor !== undefined) {
      const own = 'vendor' in entry ? entry.vendor : undefined;
      if (!own || own.toLowerCase() !== vendor) {
        return false;
      }
    }
    return !filters.matches || searchableText(entry).some(text => filters.matches?.(text));
  });
}

/**
 * One page of entries: at most `limit`, starting at `offset`, and stopping
 * early once the page would pass `budgetChars` of JSON, because the result is
 * sent as text and as structured content and clients cap its size. At least
 * one entry is always returned so paging can never stall.
 */
export function pageEntries<T>(
  entries: readonly T[],
  offset: number,
  limit: number,
  budgetChars: number,
): { page: T[]; nextOffset?: number } {
  const page: T[] = [];
  let used = 0;
  for (const entry of entries.slice(offset, offset + limit)) {
    const size = JSON.stringify(entry).length;
    if (page.length > 0 && used + size > budgetChars) {
      break;
    }
    page.push(entry);
    used += size;
  }
  const next = offset + page.length;
  return next < entries.length ? { page, nextOffset: next } : { page };
}

/** How a failed west run is described to this module, without its vscode-bound class. */
export interface WestFailure {
  message: string;
  stderr: string;
  stopped?: 'timeout' | 'aborted';
}

/** The last part of west's stderr, which is where Python puts the actual error. */
function stderrTail(stderr: string): string {
  const text = cleanForLog(stderr).trim();
  return text.length > 1500 ? `...${text.slice(-1500)}` : text;
}

/** Map a failed `west boards`, `west shields` or `west blobs list` run onto the error contract. */
export function westFailureToToolError(command: 'west boards' | 'west shields' | 'west blobs list', failure: WestFailure): McpToolError {
  const tail = stderrTail(failure.stderr);
  if (failure.stopped === 'timeout') {
    return new McpToolError('TIMEOUT', `${command} did not finish in time and was stopped.`, {
      hint: 'Retry once. If it times out again, call get_status to check that the west workspace and its Python environment are ready.',
    });
  }
  if (failure.stopped === 'aborted') {
    return new McpToolError('TIMEOUT', `${command} was cancelled.`);
  }
  // A missing west comes first: fish reports it as an "Unknown command", which
  // would otherwise read as a Zephyr too old for west shields.
  if (isWestMissing(failure.stderr)) {
    return new McpToolError('ENV_NOT_READY', 'west could not be started in the Zephyr environment.', {
      hint: 'The Python environment that provides west is missing or broken. Ask the user to run the Zephyr Workbench command "Install Host Tools", then retry. get_status shows what else is missing.',
      details: tail ? { stderr: tail } : undefined,
    });
  }
  if (command === 'west blobs list' && isUnknownWestCommand(failure.stderr)) {
    return new McpToolError('DEPENDENCY_MISSING', 'This west workspace has no "west blobs" command.', {
      hint: 'west blobs needs Zephyr 3.2 or newer.',
      details: tail ? { stderr: tail } : undefined,
    });
  }
  if (command === 'west shields' && isUnknownWestCommand(failure.stderr)) {
    return new McpToolError('DEPENDENCY_MISSING', 'This west workspace has no "west shields" command.', {
      hint: 'west shields needs Zephyr 3.7 or newer. Search boards, snippets or samples instead, or ask the user to update Zephyr.',
      details: tail ? { stderr: tail } : undefined,
    });
  }
  return new McpToolError('INTERNAL', `${command} failed: ${tail || failure.message}`, {
    hint: 'Call get_status to check that the west workspace is ready, then retry with refresh true.',
  });
}
