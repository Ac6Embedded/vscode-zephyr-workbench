import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import * as vscode from 'vscode';

import { getBoardsDirectories, westTmpBuildCmakeOnlyCommand } from '../../commands/WestCommands';
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
  const boardDirs = await getBoardsDirectories(westWorkspace, boardRoots);
  return parseBoardsFromDirectories(boardDirs);
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

async function parseBoardsFromDirectories(boardDirs: string[]): Promise<ZephyrBoard[]> {
  const listBoards: ZephyrBoard[] = [];

  const dirPromises = boardDirs.map(async dir => {
    const dirUri = vscode.Uri.file(dir);
    try {
      const files = await vscode.workspace.fs.readDirectory(dirUri);
      const boardPromises = files
        .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.yaml'))
        .map(([name]) => {
          const boardDescUri = vscode.Uri.joinPath(dirUri, name);
          const boardFile = fs.readFileSync(boardDescUri.fsPath, 'utf8');
          const data = yaml.parse(boardFile);
          if (data.identifier) {
            return new ZephyrBoard(boardDescUri).expandTargets();
          }
          return [];
        });
      const boards = await Promise.all(boardPromises);
      listBoards.push(...boards.flat());
    } catch (error) {
      console.error(`Error reading directory: ${dirUri.fsPath}`, error);
    }
  });

  await Promise.all(dirPromises);
  return listBoards;
}

function readZephyrSettings(buildDir: string): Record<string, string> {
  const settings: Record<string, string> = {};
  const filePath = path.join(buildDir, 'zephyr_settings.txt');
  try {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const lines = fileContent.split(/\r?\n/);

    lines.forEach(line => {
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
