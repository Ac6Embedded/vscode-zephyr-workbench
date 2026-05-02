import * as path from 'path';
import * as vscode from 'vscode';
import {
  ZEPHYR_WORKBENCH_SETTING_SECTION_KEY,
  ZEPHYR_WORKSPACE_APPLICATION_PATH_KEY,
  ZEPHYR_WEST_WORKSPACE_APPLICATIONS_SETTING_KEY,
  ZEPHYR_WEST_WORKSPACE_SELECTED_APPLICATION_SETTING_KEY,
} from '../../constants';
import {
  resolveConfiguredPath,
  resolveConfiguredPathValue,
} from '../execUtils';
import { cleanupEmptyWorkspaceSettings } from '../vscodeWorkspaceCleanup';

export type WorkspaceApplicationSettings = Record<string, any> & {
  path: string;
};

function normalizeForCompare(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function isPathWithin(parentPath: string, childPath: string): boolean {
  const parent = normalizeForCompare(parentPath);
  const child = normalizeForCompare(childPath);

  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function toSlashPath(value: string): string {
  return value.replace(/\\/g, '/');
}

export function toWorkspaceApplicationStoragePath(
  applicationRootPath: string,
  workspaceFolder: vscode.WorkspaceFolder,
): string {
  const relativePath = path.relative(workspaceFolder.uri.fsPath, applicationRootPath);
  if (!relativePath || relativePath === '') {
    return '.';
  }
  return toSlashPath(relativePath);
}

export function resolveWorkspaceApplicationPath(
  entry: WorkspaceApplicationSettings,
  workspaceFolder: vscode.WorkspaceFolder,
): string | undefined {
  const rawPath = entry[ZEPHYR_WORKSPACE_APPLICATION_PATH_KEY];
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    return undefined;
  }

  const resolved = resolveConfiguredPath(rawPath, workspaceFolder) ?? rawPath;
  if (path.isAbsolute(resolved)) {
    return path.normalize(resolved);
  }

  return path.normalize(path.join(workspaceFolder.uri.fsPath, resolved));
}

export function readWorkspaceApplicationEntries(
  workspaceFolder: vscode.WorkspaceFolder,
): WorkspaceApplicationSettings[] {
  const rawEntries = vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
    .get<unknown[]>(ZEPHYR_WEST_WORKSPACE_APPLICATIONS_SETTING_KEY, []);

  if (!Array.isArray(rawEntries)) {
    return [];
  }

  return rawEntries.flatMap(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return [];
    }

    const appEntry = entry as WorkspaceApplicationSettings;
    return typeof appEntry[ZEPHYR_WORKSPACE_APPLICATION_PATH_KEY] === 'string'
      ? [appEntry]
      : [];
  });
}

export function getWorkspaceApplicationSetting<T>(
  entry: Record<string, any>,
  key: string,
  defaultValue?: T,
): T | undefined {
  if (Object.prototype.hasOwnProperty.call(entry, key)) {
    return entry[key] as T;
  }

  const prefixedKey = `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${key}`;
  if (Object.prototype.hasOwnProperty.call(entry, prefixedKey)) {
    return entry[prefixedKey] as T;
  }

  return defaultValue;
}

export function getWorkspaceApplicationPathSetting(
  entry: WorkspaceApplicationSettings,
  key: string,
  workspaceFolder: vscode.WorkspaceFolder,
): string | undefined {
  const rawValue = getWorkspaceApplicationSetting<string>(entry, key);
  return typeof rawValue === 'string'
    ? resolveConfiguredPath(rawValue, workspaceFolder) ?? rawValue
    : undefined;
}

export function getWorkspaceApplicationPathSettingValue(
  entry: WorkspaceApplicationSettings,
  key: string,
  workspaceFolder: vscode.WorkspaceFolder,
): string | string[] | undefined {
  const rawValue = getWorkspaceApplicationSetting<string | string[]>(entry, key);
  return resolveConfiguredPathValue(rawValue, workspaceFolder);
}

export function findWorkspaceApplicationEntry(
  workspaceFolder: vscode.WorkspaceFolder,
  applicationRootPath: string,
): WorkspaceApplicationSettings | undefined {
  const targetPath = normalizeForCompare(applicationRootPath);
  return readWorkspaceApplicationEntries(workspaceFolder).find(entry => {
    const resolvedPath = resolveWorkspaceApplicationPath(entry, workspaceFolder);
    return resolvedPath ? normalizeForCompare(resolvedPath) === targetPath : false;
  });
}

export function findContainingWorkspaceApplicationEntry(
  workspaceFolder: vscode.WorkspaceFolder,
  resourcePath: string,
): WorkspaceApplicationSettings | undefined {
  const candidates = readWorkspaceApplicationEntries(workspaceFolder)
    .map(entry => ({ entry, appPath: resolveWorkspaceApplicationPath(entry, workspaceFolder) }))
    .filter((candidate): candidate is { entry: WorkspaceApplicationSettings; appPath: string } => !!candidate.appPath)
    .filter(candidate => isPathWithin(candidate.appPath, resourcePath))
    .sort((a, b) => b.appPath.length - a.appPath.length);

  return candidates[0]?.entry;
}

export function getSelectedWorkspaceApplicationPath(
  workspaceFolder: vscode.WorkspaceFolder,
): string | undefined {
  const rawPath = vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
    .get<string>(ZEPHYR_WEST_WORKSPACE_SELECTED_APPLICATION_SETTING_KEY, '');

  if (!rawPath || rawPath.trim().length === 0) {
    return undefined;
  }

  const resolved = resolveConfiguredPath(rawPath, workspaceFolder) ?? rawPath;
  return path.isAbsolute(resolved)
    ? path.normalize(resolved)
    : path.normalize(path.join(workspaceFolder.uri.fsPath, resolved));
}

export function getEffectiveWorkspaceApplicationEntry(
  workspaceFolder: vscode.WorkspaceFolder,
): WorkspaceApplicationSettings | undefined {
  const entries = readWorkspaceApplicationEntries(workspaceFolder);
  if (entries.length === 0) {
    return undefined;
  }

  if (entries.length === 1) {
    return entries[0];
  }

  const selectedPath = getSelectedWorkspaceApplicationPath(workspaceFolder);
  if (!selectedPath) {
    return undefined;
  }

  return entries.find(entry => {
    const appPath = resolveWorkspaceApplicationPath(entry, workspaceFolder);
    return appPath ? normalizeForCompare(appPath) === normalizeForCompare(selectedPath) : false;
  });
}

export async function setSelectedWorkspaceApplicationPath(
  workspaceFolder: vscode.WorkspaceFolder,
  applicationRootPath: string | undefined,
): Promise<void> {
  const value = applicationRootPath
    ? toWorkspaceApplicationStoragePath(applicationRootPath, workspaceFolder)
    : undefined;

  await vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
    .update(
      ZEPHYR_WEST_WORKSPACE_SELECTED_APPLICATION_SETTING_KEY,
      value,
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
}

export async function updateWorkspaceApplicationEntry(
  workspaceFolder: vscode.WorkspaceFolder,
  applicationRootPath: string,
  updater: (entry: WorkspaceApplicationSettings | undefined) => Record<string, any>,
): Promise<WorkspaceApplicationSettings> {
  const entries = readWorkspaceApplicationEntries(workspaceFolder);
  const targetPath = normalizeForCompare(applicationRootPath);
  const index = entries.findIndex(entry => {
    const resolvedPath = resolveWorkspaceApplicationPath(entry, workspaceFolder);
    return resolvedPath ? normalizeForCompare(resolvedPath) === targetPath : false;
  });

  const previousEntry = index === -1 ? undefined : entries[index];
  const nextEntry: WorkspaceApplicationSettings = {
    ...updater(previousEntry),
    [ZEPHYR_WORKSPACE_APPLICATION_PATH_KEY]: toWorkspaceApplicationStoragePath(applicationRootPath, workspaceFolder),
  };
  // A workspace application is already scoped by the containing west workspace;
  // persisting the workspace path again makes the entry harder to move/rename.
  delete nextEntry.westWorkspace;
  delete nextEntry[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.westWorkspace`];

  if (index === -1) {
    entries.push(nextEntry);
  } else {
    entries[index] = nextEntry;
  }

  await vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
    .update(
      ZEPHYR_WEST_WORKSPACE_APPLICATIONS_SETTING_KEY,
      entries,
      vscode.ConfigurationTarget.WorkspaceFolder,
    );

  return nextEntry;
}

export async function removeWorkspaceApplicationEntry(
  workspaceFolder: vscode.WorkspaceFolder,
  applicationRootPath: string,
): Promise<boolean> {
  const entries = readWorkspaceApplicationEntries(workspaceFolder);
  const targetPath = normalizeForCompare(applicationRootPath);
  const filteredEntries = entries.filter(entry => {
    const resolvedPath = resolveWorkspaceApplicationPath(entry, workspaceFolder);
    return resolvedPath ? normalizeForCompare(resolvedPath) !== targetPath : true;
  });

  if (filteredEntries.length === entries.length) {
    return false;
  }

  await vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
    .update(
      ZEPHYR_WEST_WORKSPACE_APPLICATIONS_SETTING_KEY,
      filteredEntries.length > 0 ? filteredEntries : undefined,
      vscode.ConfigurationTarget.WorkspaceFolder,
    );

  const selectedPath = getSelectedWorkspaceApplicationPath(workspaceFolder);
  // Selection is only meaningful when multiple workspace applications remain.
  // Clearing it when the list drops to zero/one keeps settings compact and
  // avoids leaving a stale pointer to an application that no longer exists.
  if (filteredEntries.length <= 1 || (selectedPath && normalizeForCompare(selectedPath) === targetPath)) {
    await setSelectedWorkspaceApplicationPath(workspaceFolder, undefined);
  }

  await cleanupEmptyWorkspaceSettings(workspaceFolder);

  return true;
}
