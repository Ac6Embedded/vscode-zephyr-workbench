// Read-only readers for the files that describe what a west workspace offers:
// snippet.yml, board.yml, a board's twister files and sample.yaml, plus
// Zephyr's snippets.cmake for where snippets are searched, and the files that
// add board roots: a module's zephyr/module.yml, an application's
// CMakeLists.txt and a build's zephyr_settings.txt. They never run west and
// never write, and they are kept free of any `vscode` import so they are unit
// tested directly and can run while no terminal or task is available.

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

export interface TwisterBoardFile {
  /** The `<board>.yaml` file. */
  file: string;
  /** Its content: identifier, name, arch, vendor, supported features... */
  data: Record<string, unknown>;
}

/**
 * The twister files of a board folder, the `<board>.yaml` files describing
 * each target the board is tested on, by the identifier each one declares
 * (`mps2/an385`, or the bare board name for a single target). Files are read
 * in name order and the first one wins a duplicate identifier; a file that
 * cannot be read or declares no identifier is left out.
 */
export async function readTwisterBoardFiles(boardDir: string): Promise<Map<string, TwisterBoardFile>> {
  let names: string[] = [];
  try {
    names = (await fs.promises.readdir(boardDir, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.yaml'))
      .map(entry => entry.name)
      .sort();
  } catch {
    // A folder that cannot be listed has no twister files.
  }
  const parsed = await Promise.all(names.map(async name => {
    const file = path.join(boardDir, name);
    return { file, data: asRecord(await readYaml(file)) };
  }));
  const byIdentifier = new Map<string, TwisterBoardFile>();
  for (const { file, data } of parsed) {
    const identifier = nonEmptyString(data?.identifier);
    if (data && identifier && !byIdentifier.has(identifier)) {
      byIdentifier.set(identifier, { file, data });
    }
  }
  return byIdentifier;
}

/**
 * The board root a Zephyr module declares with `build: settings: board_root`
 * in its zephyr/module.yml, or module.yaml, which Zephyr reads when the first
 * is missing. The setting is relative to the module folder.
 */
export function readModuleBoardRoot(moduleDir: string): string | undefined {
  for (const name of ['module.yml', 'module.yaml']) {
    let data: unknown;
    try {
      data = yaml.parse(fs.readFileSync(path.join(moduleDir, 'zephyr', name), 'utf8'));
    } catch {
      continue;
    }
    const boardRoot = nonEmptyString(asRecord(asRecord(asRecord(data)?.build)?.settings)?.board_root);
    return boardRoot ? path.resolve(moduleDir, boardRoot) : undefined;
  }
  return undefined;
}

/**
 * The paths an application's CMakeLists.txt gives a list variable with
 * `set(<name> ...)` or `list(APPEND|PREPEND <name> ...)`, as Zephyr documents
 * for BOARD_ROOT and EXTRA_ZEPHYR_MODULES before find_package(Zephyr).
 * `${VAR}` and `$ENV{VAR}` are replaced from `variables` (keyed `VAR` and
 * `ENV{VAR}`). A value still using another variable, or a relative one, which
 * Zephyr rejects there, is left out rather than guessed.
 */
export function readCMakeListsPaths(appRoot: string, name: string, variables: Record<string, string>): string[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(appRoot, 'CMakeLists.txt'), 'utf8');
  } catch {
    return [];
  }
  const withoutComments = text.replace(/#.*$/gm, '');
  // Command names are case-insensitive in CMake, variable names and keywords are not.
  const command = new RegExp(`\\b([Ss][Ee][Tt]|[Ll][Ii][Ss][Tt])\\s*\\(\\s*((?:APPEND|PREPEND)\\s+)?${name}\\s([^)]*)\\)`, 'g');
  const found: string[] = [];
  for (const match of withoutComments.matchAll(command)) {
    if (match[1].toLowerCase() === 'list' && !match[2]) {
      continue;
    }
    for (const argument of match[3].match(/"[^"]*"|[^\s"]+/g) ?? []) {
      if (argument === 'CACHE' || argument === 'PARENT_SCOPE') {
        break;
      }
      const value = argument.replace(/^"|"$/g, '')
        .replace(/\$(ENV)?\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, env, variable) => variables[env ? `ENV{${variable}}` : variable] ?? whole);
      for (const entry of value.split(';')) {
        if (entry.length > 0 && !entry.includes('$') && path.isAbsolute(entry)) {
          found.push(path.normalize(entry));
        }
      }
    }
  }
  return found;
}

/**
 * Every value a build recorded for a key in its zephyr_settings.txt, which
 * holds one `"KEY":"value"` line per setting a Zephyr module declares, so a
 * key such as BOARD_ROOT appears once per module that has one.
 */
export function readZephyrSettingsValues(settingsFile: string, key: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(settingsFile, 'utf8');
  } catch {
    return [];
  }
  const values: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^"([^"]+)":"([^"]+)"$/);
    if (match && match[1] === key) {
      values.push(match[2]);
    }
  }
  return values;
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
