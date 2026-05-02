import * as fs from 'fs/promises';
import * as path from 'path';
import * as ts from 'typescript';
import * as vscode from 'vscode';

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === 'object' && 'code' in error;
}

async function removeEmptyVscodeFolder(vscodeFolderPath: string): Promise<boolean> {
  try {
    const remainingEntries = await fs.readdir(vscodeFolderPath);
    if (remainingEntries.length > 0) {
      return false;
    }
    await fs.rmdir(vscodeFolderPath);
    return true;
  } catch (error) {
    if (isErrnoException(error) && (error.code === 'ENOENT' || error.code === 'ENOTEMPTY')) {
      return false;
    }
    throw error;
  }
}

export async function cleanupEmptyWorkspaceSettings(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
  const vscodeFolderPath = path.join(workspaceFolder.uri.fsPath, '.vscode');
  const settingsPath = path.join(vscodeFolderPath, 'settings.json');

  try {
    const serialized = await fs.readFile(settingsPath, 'utf8');
    const parsed = ts.parseConfigFileTextToJson(settingsPath, serialized);
    const config = parsed.config;

    if (
      !parsed.error &&
      config &&
      typeof config === 'object' &&
      !Array.isArray(config) &&
      Object.keys(config).length === 0
    ) {
      await fs.unlink(settingsPath);
    }
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  await removeEmptyVscodeFolder(vscodeFolderPath);
}
