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

async function collectBoardRoots(
  westWorkspace: WestWorkspace,
  resource?: ZephyrApplication | string,
  buildConfig?: ZephyrBuildConfig,
  generatedBuildDir?: string,
): Promise<string[]> {
  const boardRoots: string[] = [westWorkspace.rootUri.fsPath];

  if (westWorkspace.envVars['BOARD_ROOT']) {
    for (const boardDir of westWorkspace.envVars['BOARD_ROOT']) {
      boardRoots.push(boardDir);
    }
  }

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

  const buildDir = buildConfig.getBuildDir(project);
  let envVars: Record<string, string> | undefined;
  const settingsPath = buildConfig.getBuildArtifactPath(project, 'zephyr_settings.txt');

  if (settingsPath) {
    envVars = readZephyrSettings(path.dirname(settingsPath));
  } else if (fileExists(buildDir)) {
    envVars = readZephyrSettings(buildDir);
  } else if (generatedBuildDir && fileExists(generatedBuildDir)) {
    envVars = readZephyrSettings(generatedBuildDir);
  } else {
    const tmpBuildDir = await westTmpBuildCmakeOnlyCommand(project, westWorkspace, buildConfig);
    if (tmpBuildDir) {
      envVars = readZephyrSettings(tmpBuildDir);
      deleteFolder(tmpBuildDir);
    }
  }

  if (!envVars?.BOARD_ROOT) {
    return [];
  }

  return [envVars.BOARD_ROOT];
}

function expandWestBoardInfo(boardInfo: WestBoardInfo): ZephyrBoard[] {
  const qualifierSuffixes = getSelectableQualifierSuffixes(boardInfo);
  const revisions = boardInfo.revisions.length > 0 ? boardInfo.revisions : [undefined];

  const boards: ZephyrBoard[] = [];
  for (const qualifierSuffix of qualifierSuffixes) {
    const baseIdentifier = `${boardInfo.name}${qualifierSuffix}`;
    const baseBoard = new ZephyrBoard(vscode.Uri.file(boardInfo.dir), baseIdentifier);
    boards.push(baseBoard);

    for (const revision of revisions) {
      if (!revision) {
        continue;
      }
      boards.push(baseBoard.withIdentifier(`${boardInfo.name}@${revision}${qualifierSuffix}`));
    }
  }

  return boards;
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

function readZephyrSettings(buildDir: string): Record<string, string> {
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
