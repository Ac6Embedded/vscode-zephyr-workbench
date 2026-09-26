// Read-only readers for the files that describe what a west workspace offers:
// snippet.yml, board.yml and sample.yaml, plus Zephyr's snippets.cmake for
// where snippets are searched. They never run west and never write,
// and they are kept free of any `vscode` import so they are unit tested
// directly and can run while no terminal or task is available.

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'yaml';

export interface SnippetInfo {
  /** The snippet name from snippet.yml, which is what `west build -S` takes. */
  name: string;
  /** Folder holding the snippet.yml. */
  dir: string;
  /** The snippet root it was found under (the folder that holds `snippets/`). */
  root: string;
}

/** Zephyr's own rule for snippet names (scripts/snippets.py SNIPPET_NAME_RE). */
const SNIPPET_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SNIPPET_YML = 'snippet.yml';
/** Directories read concurrently, as in the sample discovery. */
const WALK_BATCH_SIZE = 64;
/** Guards against a snippet root that points at a huge tree by mistake. */
const MAX_WALK_DEPTH = 16;
const MAX_WALK_DIRS = 20000;

/**
 * Parsed YAML, or undefined when the file is missing or malformed. A bad file
 * is skipped rather than reported: one broken snippet or board definition must
 * not hide every other entry.
 */
async function readYaml(filePath: string): Promise<unknown> {
  try {
    return yaml.parse(await fs.promises.readFile(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Every snippet under `<root>/snippets` for each root, at any depth, named by
 * the `name:` key of its snippet.yml. This is how Zephyr itself discovers
 * snippets, so nested ones such as snippets/espressif/flash-2M (named
 * espressif-flash-2M) are found, and grouping folders that hold no snippet.yml
 * are not reported. Directory symlinks are not followed, matching the build
 * system's own walk. A root with no `snippets` folder contributes nothing.
 */
export async function findSnippets(roots: string[]): Promise<SnippetInfo[]> {
  const seenRoots = new Set<string>();
  const found: SnippetInfo[] = [];
  for (const root of roots) {
    if (!root) {
      continue;
    }
    const key = path.resolve(root);
    if (seenRoots.has(key)) {
      continue;
    }
    seenRoots.add(key);
    found.push(...await findSnippetsUnder(root));
  }
  return found.sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir));
}

async function findSnippetsUnder(root: string): Promise<SnippetInfo[]> {
  const found: SnippetInfo[] = [];
  let queue: { dir: string; depth: number }[] = [{ dir: path.join(root, 'snippets'), depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_WALK_DIRS) {
    const batch = queue.splice(0, WALK_BATCH_SIZE);
    visited += batch.length;
    const children = await Promise.all(batch.map(async ({ dir, depth }) => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      if (entries.some(entry => entry.isFile() && entry.name === SNIPPET_YML)) {
        const data = asRecord(await readYaml(path.join(dir, SNIPPET_YML)));
        const name = nonEmptyString(data?.name);
        if (name && SNIPPET_NAME.test(name)) {
          found.push({ name, dir, root });
        }
      }
      // A snippet folder can still hold further snippets below it, and the
      // build system walks the whole tree, so the walk does too.
      return depth >= MAX_WALK_DEPTH
        ? []
        : entries.filter(entry => entry.isDirectory()).map(entry => ({ dir: path.join(dir, entry.name), depth: depth + 1 }));
    }));
    queue = queue.concat(...children);
  }
  return found;
}

/**
 * True when this Zephyr's build system searches the application folder for
 * snippets by itself. Zephyr 4.4 stopped doing so, to match the other *_ROOT
 * lists. The change landed while VERSION read 4.3.99, so a version check
 * misreads main checkouts; instead this looks at snippets.cmake, which names
 * SNIPPET_APP_DIR for as long as it adds that folder. An unreadable file
 * counts as the newer behaviour.
 */
export function zephyrSearchesAppSnippets(zephyrBase: string): boolean {
  try {
    return fs.readFileSync(path.join(zephyrBase, 'cmake', 'modules', 'snippets.cmake'), 'utf8').includes('SNIPPET_APP_DIR');
  } catch {
    return false;
  }
}

export interface BoardYmlMetadata {
  vendor?: string;
  full_name?: string;
}

/**
 * Vendor and full name of one board from the board.yml in its folder
 * (hardware model v2). A folder may define several boards under `boards:`,
 * so the entry is picked by name. Older boards without board.yml return
 * nothing rather than guessing.
 */
export async function readBoardYmlMetadata(boardDir: string, boardName: string): Promise<BoardYmlMetadata> {
  const data = asRecord(await readYaml(path.join(boardDir, 'board.yml')));
  if (!data) {
    return {};
  }
  const single = asRecord(data.board);
  const many = Array.isArray(data.boards) ? data.boards.map(asRecord).filter((b): b is Record<string, unknown> => !!b) : [];
  const entries = single ? [single, ...many] : many;
  const entry = entries.find(candidate => candidate.name === boardName) ?? (entries.length === 1 ? entries[0] : undefined);
  if (!entry) {
    return {};
  }
  const vendor = nonEmptyString(entry.vendor);
  const fullName = nonEmptyString(entry.full_name);
  return {
    ...(vendor ? { vendor } : {}),
    ...(fullName ? { full_name: fullName } : {}),
  };
}

export interface SampleYamlMetadata {
  title?: string;
  description?: string;
}

/** Longest description returned, because some samples carry whole paragraphs. */
const MAX_DESCRIPTION_CHARS = 300;

/**
 * The human title and description of a sample from its sample.yaml
 * (`sample.name` and `sample.description`). Tests usually have neither.
 */
export async function readSampleYamlMetadata(sampleDir: string): Promise<SampleYamlMetadata> {
  const data = asRecord(await readYaml(path.join(sampleDir, 'sample.yaml')));
  const sample = asRecord(data?.sample);
  if (!sample) {
    return {};
  }
  const title = nonEmptyString(sample.name);
  let description = nonEmptyString(sample.description)?.replace(/\s+/g, ' ');
  if (description && description.length > MAX_DESCRIPTION_CHARS) {
    description = `${description.slice(0, MAX_DESCRIPTION_CHARS - 3)}...`;
  }
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  };
}
