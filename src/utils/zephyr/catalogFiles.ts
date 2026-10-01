// Read-only readers for the files that describe what a west workspace offers:
// snippet.yml, board.yml, a board's twister files and the test definition
// files of samples and tests, plus Zephyr's snippets.cmake for where snippets
// are searched, a module's zephyr/module.yml for its board root and its
// sample and test folders, and the files that add board roots: an
// application's CMakeLists.txt and a build's zephyr_settings.txt. They never
// run west and never write, and they are kept free of any `vscode` import so
// they are unit tested directly and can run while no terminal or task is
// available.

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'yaml';
import { APP_TEMPLATE_METADATA_FILES, AppTemplateKind, findAppTemplateMetadataFile } from './appTemplateMetadata';

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
/** Directories read concurrently by a walk. */
const WALK_BATCH_SIZE = 64;
/** Guards against a root that points at a huge tree by mistake. */
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
 * Read `root` and every folder below it, WALK_BATCH_SIZE at a time, handing
 * each folder and its entries to `visit`, whose subfolders are read next
 * unless it returns false. Directory links are not followed, as in the build
 * system's and twister's own walks, and a folder that cannot be read is
 * skipped. Folders deeper than `maxDepth` below `root` are not read.
 */
async function walkFolders(
  root: string,
  visit: (dir: string, entries: fs.Dirent[]) => boolean | Promise<boolean>,
  maxDepth = MAX_WALK_DEPTH,
): Promise<void> {
  let queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
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
      if (!await visit(dir, entries) || depth >= maxDepth) {
        return [];
      }
      return entries.filter(entry => entry.isDirectory()).map(entry => ({ dir: path.join(dir, entry.name), depth: depth + 1 }));
    }));
    queue = queue.concat(...children);
  }
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
  await walkFolders(path.join(root, 'snippets'), async (dir, entries) => {
    if (entries.some(entry => entry.isFile() && entry.name === SNIPPET_YML)) {
      const data = asRecord(await readYaml(path.join(dir, SNIPPET_YML)));
      const name = nonEmptyString(data?.name);
      if (name && SNIPPET_NAME.test(name)) {
        found.push({ name, dir, root });
      }
    }
    // A snippet folder can still hold further snippets below it, and the
    // build system walks the whole tree, so the walk does too.
    return true;
  });
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
 * A Zephyr module's zephyr/module.yml, or module.yaml, which Zephyr reads when
 * the first is missing; undefined when the folder has neither.
 */
function readModuleYml(moduleDir: string): Record<string, unknown> | undefined {
  for (const name of ['module.yml', 'module.yaml']) {
    try {
      return asRecord(yaml.parse(fs.readFileSync(path.join(moduleDir, 'zephyr', name), 'utf8')));
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * The board root a Zephyr module declares with `build: settings: board_root`
 * in its module.yml. The setting is relative to the module folder.
 */
export function readModuleBoardRoot(moduleDir: string): string | undefined {
  const boardRoot = nonEmptyString(asRecord(asRecord(readModuleYml(moduleDir)?.build)?.settings)?.board_root);
  return boardRoot ? path.resolve(moduleDir, boardRoot) : undefined;
}

/**
 * The sample and test folders a Zephyr module declares under `samples:` and
 * `tests:` in its module.yml, relative to the module folder. Zephyr hands
 * them to twister as test roots (zephyr_module.py --twister-out).
 */
function readModuleTemplateRoots(moduleDir: string): { dir: string; kind: AppTemplateKind }[] {
  const data = readModuleYml(moduleDir);
  const folders = (key: string): string[] => {
    const value = data?.[key];
    return Array.isArray(value) ? value.map(nonEmptyString).filter((entry): entry is string => !!entry) : [];
  };
  return [
    ...folders('samples').map(folder => ({ dir: path.resolve(moduleDir, folder), kind: 'sample' as const })),
    ...folders('tests').map(folder => ({ dir: path.resolve(moduleDir, folder), kind: 'test' as const })),
  ];
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

export interface SampleMetadata {
  title?: string;
  description?: string;
}

/** Longest description returned, because some samples carry whole paragraphs. */
const MAX_DESCRIPTION_CHARS = 300;

/**
 * The human title and description of a sample (`sample.name` and
 * `sample.description`), from its sample.yaml or, since Zephyr 4.5, its
 * tests.yaml. Tests usually have neither.
 */
export async function readSampleMetadata(sampleDir: string): Promise<SampleMetadata> {
  let sample: Record<string, unknown> | undefined;
  for (const file of Object.keys(APP_TEMPLATE_METADATA_FILES)) {
    sample = asRecord(asRecord(await readYaml(path.join(sampleDir, file)))?.sample);
    if (sample) {
      break;
    }
  }
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

/** Where a sample or test was found. */
export type AppTemplateOrigin = 'zephyr' | 'module' | 'workspace';

/** A sample or test an application can start from. */
export interface AppTemplate {
  /** The folder name. */
  name: string;
  /** The folder, holding a test definition file and a CMakeLists.txt. */
  dir: string;
  kind: AppTemplateKind;
  /** Zephyr's samples or tests folder, a folder a module declares, or elsewhere in the workspace. */
  origin: AppTemplateOrigin;
}

export interface AppTemplateWorkspace {
  /** The west workspace folder. */
  root: string;
  zephyrBase: string;
  /** The manifest repository. */
  manifestDir: string;
}

/** West puts its projects no deeper than this in a workspace (deps/modules/lib/gui/lvgl is 5). */
const MAX_PROJECT_DEPTH = 6;

/** The test definition file of a folder that holds one and a CMakeLists.txt to build it. */
function appTemplateFile(entries: fs.Dirent[]): string | undefined {
  const files = entries.filter(entry => entry.isFile()).map(entry => entry.name);
  return files.includes('CMakeLists.txt') ? findAppTemplateMetadataFile(files) : undefined;
}

/** True when `dir` is a sample or test an application can start from. */
export async function isAppTemplateFolder(dir: string): Promise<boolean> {
  try {
    return appTemplateFile(await fs.promises.readdir(dir, { withFileTypes: true })) !== undefined;
  } catch {
    return false;
  }
}

/**
 * The kind of a template found outside a samples or tests root: the one its
 * file name declares, else sample when its tests.yaml has a `sample:` block
 * or when it lies in a `samples` folder below `walkRoot`, else test.
 */
async function undeclaredTemplateKind(dir: string, file: string, walkRoot: string): Promise<AppTemplateKind> {
  const declared = APP_TEMPLATE_METADATA_FILES[file];
  if (declared !== 'contextual') {
    return declared;
  }
  const data = asRecord(await readYaml(path.join(dir, file)));
  if (data && 'sample' in data) {
    return 'sample';
  }
  return path.relative(walkRoot, dir).split(path.sep).includes('samples') ? 'sample' : 'test';
}

/**
 * The templates in `root` and below it, of the given kind, or of the kind
 * undeclaredTemplateKind finds when none is given. As twister does, the walk
 * goes on below a template: Zephyr 4.5 keeps the images of a multi-image test
 * in subfolders, under a tests.yaml that only lists them as
 * required_applications and has no CMakeLists.txt. Build folders and dot
 * folders are skipped.
 */
async function findTemplatesUnder(root: string, origin: AppTemplateOrigin, kind?: AppTemplateKind, maxDepth?: number): Promise<AppTemplate[]> {
  const found: AppTemplate[] = [];
  await walkFolders(root, async (dir, entries) => {
    if ((dir !== root && path.basename(dir).startsWith('.')) || entries.some(entry => entry.name === 'CMakeCache.txt')) {
      return false;
    }
    const file = appTemplateFile(entries);
    if (file) {
      found.push({ name: path.basename(dir), dir, kind: kind ?? await undeclaredTemplateKind(dir, file, root), origin });
    }
    return true;
  }, maxDepth);
  return found;
}

/**
 * The git checkouts of a west workspace, where west clones its projects,
 * found without running west: folders holding a .git, not looked into. A
 * folder holding a CMakeLists.txt or CMakeCache.txt is an application or a
 * build, and dot folders such as .west and .venv hold no project either. A
 * project left on disk after it was made inactive is still found.
 */
async function findCheckouts(root: string): Promise<string[]> {
  const found: string[] = [];
  await walkFolders(root, (dir, entries) => {
    if (dir === root) {
      return true;
    }
    if (path.basename(dir).startsWith('.')) {
      return false;
    }
    const names = entries.map(entry => entry.name);
    if (names.includes('.git')) {
      found.push(dir);
      return false;
    }
    return !names.includes('CMakeLists.txt') && !names.includes('CMakeCache.txt');
  }, MAX_PROJECT_DEPTH);
  return found;
}

/**
 * Every sample and test of a west workspace an application can start from,
 * found as twister finds test suites, without running west:
 * - in the samples and tests folders of Zephyr, twister's default roots;
 * - in the `samples:` and `tests:` folders each module lists in its
 *   module.yml (MCUboot, the Rust module, the nRF Connect SDK...);
 * - in the manifest repository when it lists none, where a workspace whose
 *   manifest is the application repository keeps its own;
 * - in the top-level folders of the workspace.
 * A template is a folder holding a test definition file and a CMakeLists.txt.
 * Its kind comes from the folder it was found under, the same for every
 * Zephyr version, since the file name only tells it apart up to Zephyr 4.4.
 * A folder found twice is returned once, from the first source above.
 */
export async function findAppTemplates(workspace: AppTemplateWorkspace): Promise<AppTemplate[]> {
  const zephyrBase = path.resolve(workspace.zephyrBase);
  const manifestDir = path.resolve(workspace.manifestDir);
  // A manifest repository that lists its folders is searched as the module it is.
  const searchManifest = manifestDir !== zephyrBase && readModuleTemplateRoots(manifestDir).length === 0;
  const found = await Promise.all([
    findTemplatesUnder(path.join(zephyrBase, 'samples'), 'zephyr', 'sample'),
    findTemplatesUnder(path.join(zephyrBase, 'tests'), 'zephyr', 'test'),
    findCheckouts(workspace.root)
      .then(checkouts => Promise.all(checkouts.flatMap(readModuleTemplateRoots).map(root => findTemplatesUnder(root.dir, 'module', root.kind))))
      .then(lists => lists.flat()),
    searchManifest ? findTemplatesUnder(manifestDir, 'workspace') : [],
    findTemplatesUnder(workspace.root, 'workspace', undefined, 1),
  ]);
  const byFolder = new Map<string, AppTemplate>();
  for (const template of found.flat()) {
    const key = process.platform === 'win32' ? template.dir.toLowerCase() : template.dir;
    if (!byFolder.has(key)) {
      byFolder.set(key, template);
    }
  }
  return [...byFolder.values()];
}
