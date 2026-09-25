import fs from 'fs';
import path from 'path';
import * as vscode from 'vscode';

import { getWestBoards, westTmpBuildCmakeOnlyCommand, type WestBoardInfo } from '../../commands/WestCommands';
import { ZephyrBoard } from '../../models/ZephyrBoard';
import { ZephyrApplication } from '../../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../../models/ZephyrBuildConfig';
import { WestWorkspace } from '../../models/WestWorkspace';
import { deleteFolder, fileExists } from '../utils';

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
  resource?: ZephyrApplication | string,
  buildConfig?: ZephyrBuildConfig,
): Promise<ZephyrBoard> {
  const boards = await getSupportedBoards(westWorkspace, resource, buildConfig);
  const board = findBoardByHierarchicalIdentifier(boardIdentifier, boards);
  if (board) {
    return board;
  }
  throw new Error(`No board named ${boardIdentifier} found`);
}

export async function getSupportedBoards(
  westWorkspace: WestWorkspace,
  resource?: ZephyrApplication | string,
  buildConfig?: ZephyrBuildConfig,
  generatedBuildDir?: string,
): Promise<ZephyrBoard[]> {
  const boardRoots = await collectBoardRoots(westWorkspace, resource, buildConfig, generatedBuildDir);
  const westBoards = await getWestBoards(westWorkspace, boardRoots);
  return westBoards.flatMap(expandWestBoardInfo);
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
 * The build folder whose zephyr_settings.txt describes this configuration,
 * when a configure already produced one. Never creates anything.
 */
function existingSettingsDir(
  project: ZephyrApplication,
  buildConfig: ZephyrBuildConfig,
  generatedBuildDir?: string,
): string | undefined {
  const settingsPath = buildConfig.getBuildArtifactPath(project, 'zephyr_settings.txt');
  if (settingsPath) {
    return path.dirname(settingsPath);
  }
  const buildDir = buildConfig.getBuildDir(project);
  if (fileExists(buildDir)) {
    return buildDir;
  }
  if (generatedBuildDir && fileExists(generatedBuildDir)) {
    return generatedBuildDir;
  }
  return undefined;
}

function boardRootsFromSettings(envVars: Record<string, string> | undefined): string[] {
  return envVars?.BOARD_ROOT ? [envVars.BOARD_ROOT] : [];
}

/**
 * The board roots getSupportedBoards would search, without its side effects:
 * an application's own BOARD_ROOT is read only from a build that already
 * exists, and a configuration that was never configured contributes nothing.
 * getSupportedBoards instead runs a temporary CMake configure in that case,
 * which starts a VS Code task and writes into the application folder, so
 * anything headless (such as an agent tool call) uses this instead.
 */
export function collectBoardRootsReadOnly(
  westWorkspace: WestWorkspace,
  application?: ZephyrApplication,
  buildConfig?: ZephyrBuildConfig,
): string[] {
  const boardRoots = workspaceBoardRoots(westWorkspace);
  if (application && buildConfig) {
    const settingsDir = existingSettingsDir(application, buildConfig);
    if (settingsDir) {
      boardRoots.push(...boardRootsFromSettings(readZephyrSettings(settingsDir)));
    }
  }
  return boardRoots;
}

async function collectBoardRoots(
  westWorkspace: WestWorkspace,
  resource?: ZephyrApplication | string,
  buildConfig?: ZephyrBuildConfig,
  generatedBuildDir?: string,
): Promise<string[]> {
  const boardRoots = workspaceBoardRoots(westWorkspace);

  if (!resource) {
    return boardRoots;
  }

  if (resource instanceof ZephyrApplication) {
    const discoveredBoardRoots = await readProjectBoardRoots(resource, westWorkspace, buildConfig, generatedBuildDir);
    boardRoots.push(...discoveredBoardRoots);
    return boardRoots;
  }

  boardRoots.push(resource);
  return boardRoots;
}

async function readProjectBoardRoots(
  project: ZephyrApplication,
  westWorkspace: WestWorkspace,
  buildConfig?: ZephyrBuildConfig,
  generatedBuildDir?: string,
): Promise<string[]> {
  if (!buildConfig) {
    return [];
  }

  let envVars: Record<string, string> | undefined;
  const settingsDir = existingSettingsDir(project, buildConfig, generatedBuildDir);

  if (settingsDir) {
    envVars = readZephyrSettings(settingsDir);
  } else {
    const tmpBuildDir = await westTmpBuildCmakeOnlyCommand(project, westWorkspace, buildConfig);
    if (tmpBuildDir) {
      envVars = readZephyrSettings(tmpBuildDir);
      deleteFolder(tmpBuildDir);
    }
  }

  return boardRootsFromSettings(envVars);
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

function expandWestBoardInfo(boardInfo: WestBoardInfo): ZephyrBoard[] {
  return selectableBoardVariants(boardInfo).flatMap(variant => {
    const baseBoard = new ZephyrBoard(vscode.Uri.file(boardInfo.dir), variant.identifier);
    return [baseBoard, ...variant.revisionIdentifiers.map(identifier => baseBoard.withIdentifier(identifier))];
  });
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

/** Key and value pairs of `<buildDir>/zephyr_settings.txt`, empty when the file is missing. */
export function readZephyrSettings(buildDir: string): Record<string, string> {
  const settings: Record<string, string> = {};
  const filePath = path.join(buildDir, 'zephyr_settings.txt');
  try {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const lines = fileContent.split(/\r?\n/);

    lines.forEach((line: string) => {
      if (line.startsWith('#') || line.trim() === '') {
        return;
      }
      const match = line.match(/^"([^"]+)":"([^"]+)"$/);
      if (match) {
        const key = match[1];
        const value = match[2];
        settings[key] = value;
      }
    });
  } catch {
    console.log(`Cannot read ${filePath}`);
  }
  return settings;
}
