// Importing an existing application folder, shared by the Add Application
// wizard and the AI agent tools.
//
// Nothing here shows UI. The import-app and import-local commands keep every
// message and refresh; these functions do the settings work and report a
// refusal as an ApplicationImportError whose message is the text the command
// shows, or as an IncompleteImportError the command ignores, as it always has.

import * as vscode from 'vscode';
import { ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY } from '../../constants';
import { ToolchainInstallation } from '../../models/ToolchainInstallations';
import { WestWorkspace } from '../../models/WestWorkspace';
import { ZephyrApplication } from '../../models/ZephyrApplication';
import { ZephyrBoard } from '../../models/ZephyrBoard';
import { setDefaultProjectSettings, setDefaultWorkspaceApplicationSettings } from '../../providers/ZephyrTaskProvider';
import { IntelliSenseProviderId } from '../intellisense/providerAvailability';
import { createWorkspaceFolderReference, getWestWorkspaces, getWorkspaceFolder } from '../utils';
import { ApplicationKind, ApplicationVenvStep, assertFreestandingApplicationFilesCreated } from './applicationCreation';
import {
  findContainingWorkspaceApplicationEntry,
  isPathWithin,
  resolveWorkspaceApplicationPath,
  setSelectedWorkspaceApplicationPath,
} from './workspaceApplications';

/** Why an import was refused. The message is the one the workbench shows. */
export class ApplicationImportError extends Error {
  constructor(
    readonly code: 'workspace-not-open' | 'needs-board-and-toolchain' | 'workspace-application' | 'not-an-application' | 'invalid-location',
    message: string,
  ) {
    super(message);
    this.name = 'ApplicationImportError';
  }
}

/**
 * A freestanding import without a west workspace, a board or a toolchain.
 * The wizard sends one only when it means "keep the existing settings", so the
 * command ignores it; `missing` names what was not given.
 */
export class IncompleteImportError extends Error {
  constructor(readonly missing: ReadonlyArray<'west_workspace' | 'board' | 'toolchain'>) {
    super(`A freestanding application import needs ${missing.join(', ')}.`);
    this.name = 'IncompleteImportError';
  }
}

/**
 * registered: a freestanding folder got its settings; linked: a west workspace
 * application was declared or updated in its workspace; selected: a declared
 * one became the selected application; reopened: a folder that already had
 * its settings was added back to the window.
 */
export type ImportOutcome = 'registered' | 'linked' | 'selected' | 'reopened';

export interface ImportApplicationOptions {
  appRoot: string;
  /** The west workspace to link to; defaults to the open one that contains appRoot. */
  westWorkspace?: WestWorkspace;
  board?: ZephyrBoard;
  toolchain?: ToolchainInstallation;
  toolchainVariant?: string;
  settingsPathMode?: 'relative' | 'absolute';
  intellisenseProvider?: IntelliSenseProviderId;
  createVenv?: ApplicationVenvStep;
}

export interface ImportedApplication {
  kind: ApplicationKind;
  outcome: Exclude<ImportOutcome, 'reopened'>;
  /** The application root: for a selection, the declared application containing the imported path. */
  appRoot: string;
  westWorkspace: WestWorkspace;
  /** Where the settings live; for a freestanding application, a folder VS Code may not have opened yet. */
  settingsFolder: vscode.WorkspaceFolder;
}

/** The open west workspace folder that contains `appRoot`, as the import commands detect it. */
export function findContainingWestWorkspace(appRoot: string): WestWorkspace | undefined {
  return getWestWorkspaces().find(candidate => isPathWithin(candidate.rootUri.fsPath, appRoot));
}

/**
 * Register an existing application, as the import-app command does. Inside an
 * open west workspace it is declared in the workspace settings (linked), or,
 * without a board or a toolchain, the declared application containing it is
 * selected. Anywhere else it gets freestanding settings in its own .vscode
 * folder, which is not added to the window here.
 */
export async function importApplication(options: ImportApplicationOptions): Promise<ImportedApplication> {
  const { appRoot, board, toolchain } = options;
  const settingsOptions = {
    toolchainVariant: options.toolchainVariant,
    intellisenseProvider: options.intellisenseProvider,
    pathMode: options.settingsPathMode,
  };
  const detectedWestWorkspace = options.westWorkspace ?? findContainingWestWorkspace(appRoot);
  const isWorkspaceApplication = !!detectedWestWorkspace
    && isPathWithin(detectedWestWorkspace.rootUri.fsPath, appRoot);

  if (isWorkspaceApplication && detectedWestWorkspace) {
    const workspaceFolder = getWorkspaceFolder(detectedWestWorkspace.rootUri.fsPath);
    if (!workspaceFolder) {
      throw new ApplicationImportError('workspace-not-open', 'The detected west workspace is not open in VS Code.');
    }

    if (!board || !toolchain) {
      const existingEntry = findContainingWorkspaceApplicationEntry(workspaceFolder, appRoot);
      if (existingEntry) {
        const appPath = resolveWorkspaceApplicationPath(existingEntry, workspaceFolder) ?? appRoot;
        await setSelectedWorkspaceApplicationPath(workspaceFolder, appPath);
        return {
          kind: 'workspace', outcome: 'selected', appRoot: appPath, westWorkspace: detectedWestWorkspace, settingsFolder: workspaceFolder,
        };
      }
      throw new ApplicationImportError('needs-board-and-toolchain',
        'Importing a West workspace application requires a board and toolchain the first time it is linked.');
    }

    const venvPath = await options.createVenv?.(workspaceFolder, detectedWestWorkspace.rootUri.fsPath, appRoot);

    await setDefaultWorkspaceApplicationSettings(workspaceFolder, appRoot, detectedWestWorkspace, board, toolchain, {
      ...settingsOptions,
      venvPath,
    });
    return { kind: 'workspace', outcome: 'linked', appRoot, westWorkspace: detectedWestWorkspace, settingsFolder: workspaceFolder };
  }

  const workspaceFolder = createWorkspaceFolderReference(appRoot);
  const westWorkspace = options.westWorkspace;
  if (!westWorkspace || !board || !toolchain) {
    throw new IncompleteImportError([
      ...(!westWorkspace ? ['west_workspace' as const] : []),
      ...(!board ? ['board' as const] : []),
      ...(!toolchain ? ['toolchain' as const] : []),
    ]);
  }

  const venvPath = await options.createVenv?.(workspaceFolder, westWorkspace.rootUri.fsPath);

  await setDefaultProjectSettings(workspaceFolder, westWorkspace, board, toolchain, {
    ...settingsOptions,
    venvPath,
  });
  await assertFreestandingApplicationFilesCreated(appRoot);
  return { kind: 'freestanding', outcome: 'registered', appRoot, westWorkspace, settingsFolder: workspaceFolder };
}

export interface ImportLocalOptions {
  /** Add the folder to the window. The commands pass addWorkspaceFolder; an agent tool its own scheduler. */
  addFolder(folderPath: string): Promise<unknown>;
  /**
   * Give a folder brought back into the window its own venv, returning the
   * path to store. Only runs when the folder is open by then.
   */
  createVenv?(folder: vscode.WorkspaceFolder): Promise<string | undefined>;
}

export interface LocalImport {
  outcome: 'reopened' | 'selected';
  appRoot: string;
  /** For a selection, the west workspace folder that declares the application. */
  westWorkspaceFolder?: vscode.WorkspaceFolder;
}

/**
 * Bring back an application from its existing settings, as the import-local
 * command does: a folder that has its own workbench settings is added to the
 * window again, and a folder declared in an open west workspace becomes its
 * selected application.
 */
export async function importLocalApplication(projectPath: string, options: ImportLocalOptions): Promise<LocalImport> {
  if (!projectPath) {
    throw new ApplicationImportError('invalid-location', 'The selected location folder is invalid');
  }
  if (ZephyrApplication.isApplicationPath(projectPath)) {
    await options.addFolder(projectPath);
    // Optionally create a local venv for the imported project
    if (options.createVenv) {
      const workspaceFolder = getWorkspaceFolder(projectPath);
      if (workspaceFolder) {
        const venvPath = await options.createVenv(workspaceFolder);
        if (venvPath) {
          await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
            .update(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY, venvPath, vscode.ConfigurationTarget.WorkspaceFolder);
        }
      }
    }
    return { outcome: 'reopened', appRoot: projectPath };
  }

  const containingWorkspace = vscode.workspace.workspaceFolders?.find(folder =>
    WestWorkspace.isWestWorkspaceFolder(folder)
    && isPathWithin(folder.uri.fsPath, projectPath)
  );
  const existingEntry = containingWorkspace
    ? findContainingWorkspaceApplicationEntry(containingWorkspace, projectPath)
    : undefined;
  if (containingWorkspace && existingEntry) {
    const appPath = resolveWorkspaceApplicationPath(existingEntry, containingWorkspace) ?? projectPath;
    await setSelectedWorkspaceApplicationPath(containingWorkspace, appPath);
    return { outcome: 'selected', appRoot: appPath, westWorkspaceFolder: containingWorkspace };
  }
  if (containingWorkspace && ZephyrApplication.isApplicationPathLike(projectPath)) {
    throw new ApplicationImportError('workspace-application',
      'This is a West workspace application. Select its workspace, board, and toolchain to link it first.');
  }
  throw new ApplicationImportError('not-an-application', 'The folder is not a Zephyr project');
}
