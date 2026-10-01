import fs from 'fs';
import path from 'path';

import { getWestBoards, WestCommandError, type WestBoardInfo, type WestRunOptions } from '../../commands/WestCommands';
import { matchTwisterIdentifier, ZephyrBoard } from '../../models/ZephyrBoard';
import type { ZephyrApplication } from '../../models/ZephyrApplication';
import type { ZephyrBuildConfig } from '../../models/ZephyrBuildConfig';
import type { WestWorkspace } from '../../models/WestWorkspace';
import { getOutputChannel, makeConfiguredVariableResolver } from '../execUtils';
import {
  readBoardYmlMetadata,
  readCMakeListsPaths,
  readModuleBoardRoot,
  readTwisterBoardFiles,
  readZephyrSettingsValues,
  type TwisterBoardFile,
} from './catalogFiles';
import { normalizeWestFlagDValue, tokenizeWestArgs } from './westArgUtils';

/** Board folders read at once while labelling, as in the other catalog walks. */
const FOLDER_BATCH_SIZE = 64;

export function findBoardByHierarchicalIdentifier(boardIdentifier: string, boards: ZephyrBoard[]): ZephyrBoard | undefined {
  let candidate = String(boardIdentifier);
  let found = boards.find(b => b.identifier === candidate);
  if (found) {
    return found;
  }

  while (candidate.length > 0) {
    const lastSlash = candidate.lastIndexOf('/');
    if (lastSlash === -1) {
      break;
    }
    candidate = candidate.substring(0, lastSlash);
    found = boards.find(b => b.identifier === candidate);
    if (found) {
      return found;
    }
  }

  return undefined;
}

export async function getBoardFromIdentifier(
  boardIdentifier: string,
  westWorkspace: WestWorkspace,
  application?: ZephyrApplication,
  buildConfig?: ZephyrBuildConfig,
): Promise<ZephyrBoard> {
  const boards = await getSupportedBoards(westWorkspace, application, buildConfig);
  const board = findBoardByHierarchicalIdentifier(boardIdentifier, boards);
  if (board) {
    return board;
  }
  throw new Error(`No board named ${boardIdentifier} found`);
}

/**
 * Every board target a user can pick: `west boards` over the roots of
 * collectBoardRoots, labelled by describeWestBoards.
 */
export async function getSupportedBoards(
  westWorkspace: WestWorkspace,
  application?: ZephyrApplication,
  buildConfig?: ZephyrBuildConfig,
  generatedBuildDir?: string,
  westOpts: WestRunOptions = {},
): Promise<ZephyrBoard[]> {
  const boardRoots = collectBoardRoots(westWorkspace, application, buildConfig, generatedBuildDir);
  return describeWestBoards(await listWestBoards(westWorkspace, boardRoots, westOpts));
}

/** The workspace root plus the workspace BOARD_ROOT setting, the roots every board search starts from. */
function workspaceBoardRoots(westWorkspace: WestWorkspace): string[] {
  const boardRoots: string[] = [westWorkspace.rootUri.fsPath];
  const configured: unknown = westWorkspace.envVars?.['BOARD_ROOT'];
  if (Array.isArray(configured)) {
    boardRoots.push(...configured.filter((entry): entry is string => typeof entry === 'string'));
  } else if (typeof configured === 'string' && configured.length > 0) {
    boardRoots.push(configured);
  }
  return boardRoots;
}

/**
 * The folders `west boards` searches for boards, each one holding a `boards/`
 * folder: the west workspace root and its BOARD_ROOT setting, then, for an
 * application's build configuration, the board roots its build adds (see
 * applicationBoardRoots), each folder once. `west boards` adds Zephyr's own
 * boards and the board roots of the manifest's modules by itself. Nothing is
 * run or written, so any caller can use it, an agent tool included.
 */
export function collectBoardRoots(
  westWorkspace: WestWorkspace,
  application?: ZephyrApplication,
  buildConfig?: ZephyrBuildConfig,
  generatedBuildDir?: string,
): string[] {
  const boardRoots = workspaceBoardRoots(westWorkspace);
  if (application && buildConfig) {
    boardRoots.push(...applicationBoardRoots(westWorkspace, application, buildConfig, generatedBuildDir));
  }
  return uniqueRoots(boardRoots);
}

/**
 * The board roots an application's build adds to the workspace ones, read
 * where Zephyr takes them from, without configuring anything:
 * - BOARD_ROOT among the configuration's CMake arguments (-D flags and west
 *   arguments), a relative path being relative to the application;
 * - BOARD_ROOT set or appended in the application's CMakeLists.txt;
 * - the board_root of each module of EXTRA_ZEPHYR_MODULES, from the
 *   configuration setting, its CMake arguments or the CMakeLists.txt;
 * - the BOARD_ROOT lines an existing build recorded in zephyr_settings.txt.
 * A folder without a `boards/` folder is left out, as Zephyr warns about it.
 */
function applicationBoardRoots(
  westWorkspace: WestWorkspace,
  application: ZephyrApplication,
  buildConfig: ZephyrBuildConfig,
  generatedBuildDir?: string,
): string[] {
  const appRoot = application.appRootPath;
  const definitions = cmakeDefinitions(application, buildConfig);
  const cmakeListsVariables = {
    CMAKE_CURRENT_SOURCE_DIR: appRoot,
    CMAKE_CURRENT_LIST_DIR: appRoot,
    CMAKE_SOURCE_DIR: appRoot,
    'ENV{ZEPHYR_BASE}': westWorkspace.kernelUri.fsPath,
  };
  const extraModules = [
    ...listSetting(buildConfig.envVars.EXTRA_ZEPHYR_MODULES),
    ...(definitions.get('EXTRA_ZEPHYR_MODULES') ?? []),
    ...(definitions.get('ZEPHYR_EXTRA_MODULES') ?? []),
    ...readCMakeListsPaths(appRoot, 'EXTRA_ZEPHYR_MODULES', cmakeListsVariables),
  ].filter(moduleDir => path.isAbsolute(moduleDir));
  const settingsFiles = [
    buildConfig.getBuildArtifactPath(application, 'zephyr_settings.txt'),
    generatedBuildDir ? path.join(generatedBuildDir, 'zephyr_settings.txt') : undefined,
  ];
  const candidates = [
    ...(definitions.get('BOARD_ROOT') ?? []).map(root => path.resolve(appRoot, root)),
    ...readCMakeListsPaths(appRoot, 'BOARD_ROOT', cmakeListsVariables),
    ...extraModules.map(readModuleBoardRoot),
    ...settingsFiles.flatMap(file => (file ? readZephyrSettingsValues(file, 'BOARD_ROOT') : [])),
  ];
  return candidates.filter((root): root is string => !!root && isDirectory(path.join(root, 'boards')));
}

/**
 * The values of the -D definitions among a configuration's CMake arguments,
 * its -D flags and its west arguments, by variable name and split on `;` as
 * CMake lists are. VS Code variables such as ${workspaceFolder} are resolved;
 * a value still using a variable is left out.
 */
function cmakeDefinitions(application: ZephyrApplication, buildConfig: ZephyrBuildConfig): Map<string, string[]> {
  const flags = [
    ...buildConfig.westFlagsD,
    ...tokenizeWestArgs(buildConfig.westArgs).filter(token => token.startsWith('-D')).map(normalizeWestFlagDValue),
  ];
  const resolveVariable = makeConfiguredVariableResolver(application.appWorkspaceFolder);
  const definitions = new Map<string, string[]>();
  for (const flag of flags) {
    const match = flag.match(/^([A-Za-z_][A-Za-z0-9_]*)(?::[A-Za-z]+)?=(.*)$/s);
    if (!match) {
      continue;
    }
    const value = match[2]
      .replace(/^(["'])(.*)\1$/s, '$2')
      .replace(/\$\{([^}]+)\}/g, (whole, name: string) => resolveVariable(name) ?? whole);
    const entries = value.split(';').filter(entry => entry.length > 0 && !entry.includes('${'));
    definitions.set(match[1], [...(definitions.get(match[1]) ?? []), ...entries]);
  }
  return definitions;
}

/** A setting holding a list of paths, stored as an array or as one `;`-separated string. */
function listSetting(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? value.split(';') : [];
  return entries.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function isDirectory(folder: string): boolean {
  try {
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

/** The roots with each folder once, however it is spelled, keeping the first spelling. */
function uniqueRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  return roots.filter(root => {
    const resolved = path.resolve(root);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * `west boards` over the given roots. Since Zephyr 4.0, west lists nothing
 * when two roots define a board of the same name, so a root added for the
 * application must not cost the whole list: west runs again over the
 * workspace roots only, which is what was searched before those were added.
 */
async function listWestBoards(westWorkspace: WestWorkspace, boardRoots: string[], westOpts: WestRunOptions): Promise<WestBoardInfo[]> {
  try {
    return await getWestBoards(westWorkspace, boardRoots, westOpts);
  } catch (error) {
    const workspaceRoots = uniqueRoots(workspaceBoardRoots(westWorkspace));
    if (!(error instanceof WestCommandError) || !/defined multiple times/.test(error.stderr) || workspaceRoots.length === boardRoots.length) {
      throw error;
    }
    getOutputChannel().appendLine(`[Zephyr Workbench] west boards: ${error.stderr.trim()}`);
    getOutputChannel().appendLine('[Zephyr Workbench] Listing the boards of the west workspace only.');
    return getWestBoards(westWorkspace, workspaceRoots, westOpts);
  }
}

/**
 * One ZephyrBoard per target a user can pick from a `west boards` listing,
 * with the name and arch of the twister file of that exact target
 * (matchTwisterIdentifier). A target without one is labelled with its board's
 * full_name from board.yml (Zephyr 4.0 and later), else with the board name,
 * on one line whatever the YAML holds. Each folder is read once, however many
 * targets or boards share it. A target
 * west reports twice, as Zephyr 3.6 and older do for a board several roots
 * define, is listed once.
 */
export async function describeWestBoards(westBoards: WestBoardInfo[]): Promise<ZephyrBoard[]> {
  const folders = new Map<string, Promise<Map<string, TwisterBoardFile>>>();
  const twisterFilesOf = (dir: string) => {
    let files = folders.get(dir);
    if (!files) {
      files = readTwisterBoardFiles(dir);
      folders.set(dir, files);
    }
    return files;
  };
  const described: ZephyrBoard[] = [];
  for (let index = 0; index < westBoards.length; index += FOLDER_BATCH_SIZE) {
    const batch = await Promise.all(westBoards.slice(index, index + FOLDER_BATCH_SIZE)
      .map(async boardInfo => describeWestBoard(boardInfo, await twisterFilesOf(boardInfo.dir))));
    described.push(...batch.flat());
  }
  const seen = new Set<string>();
  return described.filter(board => !seen.has(board.identifier) && seen.add(board.identifier));
}

async function describeWestBoard(boardInfo: WestBoardInfo, twisterFiles: Map<string, TwisterBoardFile>): Promise<ZephyrBoard[]> {
  const identifiers = new Set(twisterFiles.keys());
  let boardYml: ReturnType<typeof readBoardYmlMetadata> | undefined;
  const readBoardYml = () => (boardYml ??= readBoardYmlMetadata(boardInfo.dir, boardInfo.name));
  const boards: ZephyrBoard[] = [];
  for (const variant of selectableBoardVariants(boardInfo)) {
    const match = matchTwisterIdentifier(variant.identifier, identifiers);
    const definition = match ? twisterFiles.get(match) : undefined;
    let name = typeof definition?.data.name === 'string' ? definition.data.name : undefined;
    if (!name?.trim()) {
      name = (await readBoardYml()).full_name ?? boardInfo.name;
    }
    const board = ZephyrBoard.fromDiscovery(boardInfo.dir, variant.identifier, name.replace(/\s+/g, ' ').trim(), definition);
    // The vendor is the board's, so board.yml gives it to a target without a twister file of its own.
    const vendor = board.vendor ? undefined : (await readBoardYml()).vendor;
    if (vendor) {
      board.vendor = vendor;
    }
    boards.push(board, ...variant.revisionIdentifiers.map(identifier => board.withIdentifier(identifier)));
  }
  return boards;
}

interface SelectableBoardVariant {
  /** `<board>[/<qualifiers>]`, what `west build -b` takes for the default revision. */
  identifier: string;
  /** The same target pinned to each revision the board declares. */
  revisionIdentifiers: string[];
}

function selectableBoardVariants(boardInfo: WestBoardInfo): SelectableBoardVariant[] {
  return getSelectableQualifierSuffixes(boardInfo).map(qualifierSuffix => ({
    identifier: `${boardInfo.name}${qualifierSuffix}`,
    revisionIdentifiers: boardInfo.revisions
      .filter(revision => revision.length > 0)
      .map(revision => `${boardInfo.name}@${revision}${qualifierSuffix}`),
  }));
}

/**
 * Every board identifier a user can select for one `west boards` entry, in
 * picker order: each qualifier target, each followed by its revision-pinned
 * forms. Pure, so a caller that only needs identifiers never has to build a
 * ZephyrBoard (which reads and parses YAML) per identifier.
 */
export function selectableBoardIdentifiers(boardInfo: WestBoardInfo): string[] {
  return selectableBoardVariants(boardInfo).flatMap(variant => [variant.identifier, ...variant.revisionIdentifiers]);
}

function getSelectableQualifierSuffixes(boardInfo: WestBoardInfo): string[] {
  if (boardInfo.qualifiers.length === 0) {
    return [''];
  }

  // Zephyr allows the plain board name when the board effectively resolves to
  // a single SoC target. In practice that means one qualifier with no deeper
  // cluster/variant path, so keep the picker aligned with normal `west build -b <board>`
  // usage instead of always surfacing the raw SoC qualifier.
  if (boardInfo.qualifiers.length === 1 && !boardInfo.qualifiers[0].includes('/')) {
    return [''];
  }

  return boardInfo.qualifiers.map(qualifier => `/${qualifier}`);
}
