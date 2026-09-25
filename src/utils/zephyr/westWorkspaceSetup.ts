// Creating, importing and tidying up west workspaces: the steps the Add West
// Workspace wizard and the west workspace commands run, shared with the
// manage_west_workspace and remove_or_delete tools. Nothing here shows UI:
// each function returns what happened or the reason it cannot go ahead, and
// the commands keep their progress, messages and prompts.

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as vscode from 'vscode';
import { ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY } from '../../constants';
import { WestWorkspace } from '../../models/WestWorkspace';
import { getConfiguredVenvPath } from '../execUtils';
import { createWorkspaceVenv, VenvRunner } from '../installUtils';
import { createWorkspaceFolderReference, fileExists, getWorkspaceFolder, isWorkspaceFolder } from '../utils';

/** Where the wizard gets a new workspace from. 'local' imports an existing one. */
export type WorkspaceSourceType = 'remote' | 'local' | 'manifest' | 'template';

/**
 * The folder the wizard would create or import the workspace in, and why it
 * cannot, in the words the wizard shows. A new workspace goes into `subfolder`
 * of `location` (the location itself when empty), which must be empty and not
 * look like a workspace already; a local import expects the workspace root.
 */
export function resolveWorkspaceDestination(
  location: string, srcType: WorkspaceSourceType | string, subfolder = '',
): { workspacePath: string; problem?: string } {
  let workspacePath = location;
  // Not applicable to local import, which points at an existing workspace.
  const folder = srcType !== 'local' ? subfolder.trim() : '';
  if (folder.length > 0) {
    workspacePath = path.join(workspacePath, folder);
    if (fs.existsSync(workspacePath) && fs.readdirSync(workspacePath).length > 0) {
      return { workspacePath, problem: `The subfolder "${folder}" already exists and is not empty. Please choose a different name.` };
    }
  }

  const hasDeps = fs.existsSync(path.join(workspacePath, 'deps'));
  const hasManifestDir = fs.existsSync(path.join(workspacePath, 'manifest'));
  const hasWestDir = fs.existsSync(path.join(workspacePath, '.west'));
  const looksLikeWestWorkspace = hasDeps || hasManifestDir || hasWestDir;

  // For remote/template/manifest init: require an empty folder (not an existing west workspace)
  if (srcType !== 'local') {
    if (looksLikeWestWorkspace) {
      return { workspacePath, problem: 'The selected folder already contains a west workspace. Please select an empty folder.' };
    }
  } else if (!hasWestDir) {
    // For local import: expect an existing west workspace folder
    return { workspacePath, problem: "Local import expects an existing west workspace folder (missing '.west'). Please select the workspace root." };
  }
  return { workspacePath };
}

/** Why west init cannot start in `workspacePath`, as the west.init command says it. */
export function westInitProblem(workspacePath: string | undefined): string | undefined {
  return workspacePath && !isWorkspaceFolder(workspacePath)
    ? undefined
    : 'The west workspace location folder is invalid or already exists';
}

/** Why `workspacePath` cannot be imported as a west workspace, as the import command says it. */
export function westWorkspaceImportProblem(workspacePath: string | undefined): string | undefined {
  if (!workspacePath || isWorkspaceFolder(workspacePath)) {
    return 'The west workspace location folder is invalid or already exists';
  }
  return WestWorkspace.isWestWorkspacePath(workspacePath) ? undefined : 'The folder is not a West workspace';
}

export interface WestInitOptions {
  enableRust: boolean;
  /** A dedicated venv for the workspace, after west update. */
  createVenv: boolean;
  /** west blobs fetch, after the venv. */
  fetchBlobs: boolean;
}

/**
 * The steps of a new workspace, run in this order. The UI runs today's west
 * commands; an agent job runs the same west tasks captured in a terminal and
 * never creates a venv or fetches blobs as part of a creation.
 */
export interface WestInitSteps {
  init(): Promise<void>;
  enableRust(): Promise<void>;
  update(): Promise<void>;
  boards(): Promise<void>;
  createVenv(): Promise<void>;
  /** Reports its own progress: it only does so when the Zephyr version has west blobs. */
  fetchBlobs(): Promise<void>;
  /** Add the folder to the window and set it up. Always last: adding the first folder can restart the extensions. */
  register(): Promise<void>;
}

export interface WestInitHooks {
  report?(increment: number, message: string): void;
  /** Checked after every step; true stops the creation with a 'cancelled' error. */
  isCancelled?(): boolean;
}

/**
 * Create a west workspace: west init, the optional Rust module, west update,
 * west boards, the optional venv and blobs, then registration. A step that
 * throws stops the rest. Cancellation throws an Error whose cause is 'cancelled'.
 */
export async function initWestWorkspace(options: WestInitOptions, steps: WestInitSteps, hooks: WestInitHooks = {}): Promise<void> {
  const report = (increment: number, message: string) => hooks.report?.(increment, message);
  const checkCancelled = () => {
    if (hooks.isCancelled?.()) {
      throw new Error('West workspace import cancelled.', { cause: 'cancelled' });
    }
  };

  report(5, 'Initializing manifest...');
  await steps.init();
  checkCancelled();
  if (options.enableRust) {
    report(2, 'Enabling Rust module...');
    await steps.enableRust();
    checkCancelled();
  }
  report(5, 'Updating projects...');
  await steps.update();
  checkCancelled();
  report(10, 'Loading boards...');
  await steps.boards();
  checkCancelled();
  // Optional dedicated per-workspace venv (Advanced import option). Created
  // BEFORE registration: adding the first folder can reload the window and
  // abort the caller, so the long-running install must finish first. It runs
  // after `west update` so `west packages` / requirements.txt can resolve the
  // Zephyr tree.
  if (options.createVenv) {
    report(5, 'Creating workspace virtual environment...');
    await steps.createVenv();
    checkCancelled();
  }
  // Fetch binary blobs after the workspace is populated (and after the
  // dedicated venv when one was requested), but before registration.
  if (options.fetchBlobs) {
    await steps.fetchBlobs();
    checkCancelled();
  }
  await steps.register();
}

/**
 * Persist a workspace venv at the workspace-folder scope, so every application
 * of the workspace inherits it (see WestWorkspace.venvPath). False when the
 * folder is not in the window yet: the on-disk `<root>/.venv` is then picked
 * up by WestWorkspace's auto-detection.
 */
export async function storeWorkspaceVenvPath(workspacePath: string, venvPath: string): Promise<boolean> {
  const workspaceFolder = createWorkspaceFolderReference(workspacePath);
  try {
    await vscode.workspace
      .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
      .update(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY, venvPath, vscode.ConfigurationTarget.WorkspaceFolder);
    return true;
  } catch {
    // Folder not registered yet (created during import, pre-registration):
    // the on-disk `<root>/.venv` is picked up by WestWorkspace auto-detection.
    return false;
  }
}

/**
 * Create a dedicated venv for a west workspace and persist its path at the
 * workspace-folder scope. Uses a folder reference rather than
 * getWorkspaceFolder so it also works during import, before the folder is
 * registered (adding the first folder can reload the window). With a runner,
 * see VenvRunner: failures throw a VenvSetupError and nothing is shown.
 */
export async function createAndStoreWorkspaceVenv(
  context: vscode.ExtensionContext, workspacePath: string, runner?: VenvRunner,
): Promise<string | undefined> {
  const workspaceFolder = createWorkspaceFolderReference(workspacePath);
  const venvPath = await createWorkspaceVenv(context, workspaceFolder, runner);
  if (venvPath) {
    await storeWorkspaceVenvPath(workspacePath, venvPath);
  }
  return venvPath;
}

/** Point a west workspace at a venv, or clear its own with an empty path, as Set Venv Path does. */
export async function setWorkspaceVenvPath(workspaceFolder: vscode.WorkspaceFolder, venvPath: string): Promise<void> {
  await vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
    .update(
      ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY,
      venvPath.length > 0 ? venvPath : undefined,
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
}

/** The venv folder the workbench creates for a west workspace. */
export function managedWorkspaceVenvDir(workspacePath: string): string {
  return path.join(workspacePath, '.venv');
}

/**
 * Drop the dedicated venv of a west workspace: clear its venv.path setting,
 * then delete the managed `<root>/.venv` if present. A user-pointed external
 * venv lives elsewhere and is left untouched. `root` is the workspace root,
 * the folder's own path unless given. Returns the folder handed to `remove`,
 * if any.
 */
export async function removeWorkspaceVenv(
  workspaceFolder: vscode.WorkspaceFolder, remove: (dir: string) => unknown, root: string = workspaceFolder.uri.fsPath,
): Promise<string | undefined> {
  await setWorkspaceVenvPath(workspaceFolder, '');
  const managedVenvDir = managedWorkspaceVenvDir(root);
  if (fileExists(managedVenvDir)) {
    await remove(managedVenvDir);
    return managedVenvDir;
  }
  return undefined;
}

/**
 * Take a west workspace out of the window, then delete its folder, as the
 * workspace's Delete command does. Nothing happens when no window folder holds
 * it, unless the caller passes the folder itself. Returns what `remove` returned.
 */
export async function deleteWestWorkspace<T>(
  root: string,
  ops: { unregister(folder: vscode.WorkspaceFolder): unknown; remove(dir: string): T | Promise<T> },
  folder: vscode.WorkspaceFolder | undefined = getWorkspaceFolder(root),
): Promise<T | undefined> {
  if (!folder) {
    return undefined;
  }
  await ops.unregister(folder);
  return ops.remove(root);
}

/**
 * The folder settings a new west workspace gets once it is in the window: the
 * CMake extension must not scan for kits in it.
 */
export const WEST_WORKSPACE_FOLDER_SETTINGS: Readonly<Record<string, unknown>> = {
  'cmake.enableAutomaticKitScan': false,
};

/**
 * Write settings straight into `<folder>/.vscode/settings.json`, for a folder
 * that is not in the window yet and whose registration may restart the
 * extensions before the settings API could be used. Keeps every other setting,
 * and leaves a file it cannot parse untouched. Returns what it did.
 */
export async function writeFolderSettingsFile(
  folderPath: string, entries: Readonly<Record<string, unknown>>,
): Promise<'written' | 'unchanged' | 'unparsable'> {
  const settingsDir = path.join(folderPath, '.vscode');
  const settingsPath = path.join(settingsDir, 'settings.json');
  let config: Record<string, unknown> = {};
  let previous: string | undefined;
  if (fs.existsSync(settingsPath)) {
    previous = await fs.promises.readFile(settingsPath, 'utf8');
    // settings.json may hold comments and trailing commas.
    const parsed = ts.parseConfigFileTextToJson(settingsPath, previous);
    if (parsed.error || !parsed.config || typeof parsed.config !== 'object' || Array.isArray(parsed.config)) {
      return 'unparsable';
    }
    config = parsed.config as Record<string, unknown>;
  }
  const next = { ...config, ...entries };
  const serialized = JSON.stringify(next, null, 2);
  if (previous !== undefined && Object.entries(entries).every(([key, value]) => JSON.stringify(config[key]) === JSON.stringify(value))) {
    return 'unchanged';
  }
  await fs.promises.mkdir(settingsDir, { recursive: true });
  await fs.promises.writeFile(settingsPath, serialized, 'utf8');
  return 'written';
}

export type WorkspaceVenvSource = 'setting' | 'auto' | 'global';

/**
 * The Python venv a west workspace builds with and where it comes from: its
 * own venv.path setting, the `<root>/.venv` found on disk, or the global venv
 * (path undefined when none is set either).
 */
export function describeWorkspaceVenv(westWorkspace: WestWorkspace): { path?: string; source: WorkspaceVenvSource } {
  const rootUri = westWorkspace.rootUri;
  const folder = getWorkspaceFolder(rootUri.fsPath);
  let folderValue: unknown;
  if (folder && path.normalize(folder.uri.fsPath) === path.normalize(rootUri.fsPath)) {
    try {
      folderValue = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, folder)
        .inspect?.(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY)?.workspaceFolderValue;
    } catch {
      folderValue = undefined;
    }
  }
  const venvPath = westWorkspace.venvPath;
  if (venvPath && typeof folderValue === 'string' && folderValue.trim().length > 0) {
    return { path: venvPath, source: 'setting' };
  }
  if (venvPath && path.normalize(venvPath) === path.normalize(managedWorkspaceVenvDir(rootUri.fsPath))) {
    return { path: venvPath, source: 'auto' };
  }
  const global = venvPath ?? getConfiguredVenvPath();
  return global ? { path: global, source: 'global' } : { source: 'global' };
}
