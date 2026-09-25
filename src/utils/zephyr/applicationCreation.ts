// Creating an application from a sample or test, shared by the Add
// Application wizard and the AI agent tools.
//
// Nothing here shows UI. createApplication copies the template and writes the
// settings exactly as the create-app command always did, and reports a refusal
// as an ApplicationCreationError whose message is the text the command shows.
// The command keeps its progress notification, its optional venv step, its
// messages and adding the new folder to the window; an agent tool adds the
// folder through its own scheduler instead.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { normalizeZephyrSdkVariant, RustToolchainInstallation, ToolchainInstallation, ZephyrSdkInstallation, ZephyrSdkVariantId } from '../../models/ToolchainInstallations';
import { WestWorkspace } from '../../models/WestWorkspace';
import { ZephyrBoard } from '../../models/ZephyrBoard';
import { setDefaultProjectSettings, setDefaultWorkspaceApplicationSettings } from '../../providers/ZephyrTaskProvider';
import { IntelliSenseProviderId } from '../intellisense/providerAvailability';
import { copySampleSync, createWorkspaceFolderReference, fileExists, getWorkspaceFolder } from '../utils';
import { checkSdkCompatibility, SdkCompatVerdict } from './sdkCompatUtils';

export type ApplicationKind = 'workspace' | 'freestanding';

/** Why createApplication stopped. The message is the one the Add Application wizard shows. */
export class ApplicationCreationError extends Error {
  constructor(
    readonly code: 'destination-exists' | 'workspace-not-open' | 'settings-missing',
    message: string,
  ) {
    super(message);
    this.name = 'ApplicationCreationError';
  }
}

export function hasPathSpace(value: string): boolean {
  return value.includes(' ');
}

/**
 * The folder that receives a west workspace application: the applications
 * subfolder of the workspace root, or the root itself when the subfolder is
 * empty. Leading and trailing separators of the subfolder are ignored.
 */
export function workspaceApplicationParentPath(westWorkspaceRootPath: string, applicationsSubfolder: string): string {
  const subfolder = applicationsSubfolder.trim().replace(/^[\\/]+|[\\/]+$/g, '');
  return subfolder.length > 0
    ? path.join(westWorkspaceRootPath, subfolder)
    : westWorkspaceRootPath;
}

export function getRequestedToolchainVariant(rawVariant: unknown): ZephyrSdkVariantId {
  return normalizeZephyrSdkVariant(typeof rawVariant === 'string' ? rawVariant : undefined);
}

// The webview's SDK Variant radio always speaks 'zephyr' / 'zephyr/llvm'.
// A Rust entry stores the C variant derived from its linked toolchain (the
// radio applies to SDK links); the rust path itself is stored separately.
export function toRequestedVariantFor(
  toolchainInstallation: unknown,
  toolchainVariant: ZephyrSdkVariantId,
): string {
  if (toolchainInstallation instanceof RustToolchainInstallation
    && toolchainInstallation.cToolchainType === 'gnuarmemb') {
    return 'gnuarmemb';
  }
  return toolchainVariant;
}

function getStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isMissingValue(value: unknown): boolean {
  return getStringValue(value).length === 0;
}

/**
 * The first problem with a create request from the Add Application wizard, in
 * the words the wizard shows, or undefined when there is none.
 */
export function findCreateParameterError(message: any, projectParentPath: string): string | undefined {
  if (isMissingValue(message.westWorkspaceRootPath)) {
    return 'Missing west workspace, please select a west workspace';
  }

  if (isMissingValue(message.toolchainInstallationPath)) {
    return 'Missing toolchain, please select a toolchain for your project. Use "Add new toolchain..." in the toolchain list to install one.';
  }

  if (isMissingValue(message.projectName)) {
    return 'The project name is empty or invalid';
  }

  const projectName = getStringValue(message.projectName);
  if (hasPathSpace(projectName)) {
    return 'The project name cannot contain spaces.';
  }

  const applicationType = getStringValue(message.appLocationType) === 'workspace'
    ? 'workspace'
    : 'freestanding';
  const applicationsSubfolder = getStringValue(message.applicationsSubfolder).trim();
  if (applicationType === 'workspace' && hasPathSpace(applicationsSubfolder)) {
    return 'The applications subfolder cannot contain spaces.';
  }

  if (hasPathSpace(projectParentPath)) {
    return 'The project location cannot contain spaces.';
  }

  if (hasPathSpace(path.join(projectParentPath, projectName))) {
    return 'The application path cannot contain spaces.';
  }

  // A board can be picked from the list (boardYamlPath) or typed by hand
  // (boardIdentifier only); accept either.
  if (isMissingValue(message.boardYamlPath) && isMissingValue(message.boardIdentifier)) {
    return 'Missing target board';
  }

  if (isMissingValue(message.samplePath)) {
    return 'Missing selected sample or test app, it serves as base for your project';
  }

  return undefined;
}

/**
 * The SDK <-> Zephyr compatibility of a toolchain picked for an application of
 * this west workspace, for a Zephyr SDK only (the other families carry no SDK
 * version to check). Undefined when there is nothing to check. Never throws.
 */
export function sdkCompatibilityFor(
  westWorkspace: WestWorkspace,
  toolchainInstallation: unknown,
): { verdict: SdkCompatVerdict; sdkVersion: string } | undefined {
  try {
    if (toolchainInstallation instanceof ZephyrSdkInstallation) {
      const sdkVersion = toolchainInstallation.version;
      return { verdict: checkSdkCompatibility(sdkVersion, westWorkspace.kernelUri.fsPath), sdkVersion };
    }
  } catch {
    // Unknown compatibility must never break app creation/import.
  }
  return undefined;
}

/**
 * Throw unless the settings of a freestanding application reached its own
 * .vscode folder, which is what makes the folder an application once VS Code
 * opens it.
 */
export async function assertFreestandingApplicationFilesCreated(applicationRootPath: string): Promise<void> {
  const requiredFiles = [
    path.join(applicationRootPath, '.vscode', 'settings.json'),
    path.join(applicationRootPath, '.vscode', 'c_cpp_properties.json'),
  ];
  const missingFiles = requiredFiles.filter(requiredFile => !fileExists(requiredFile));
  if (missingFiles.length === 0) {
    return;
  }

  throw new ApplicationCreationError('settings-missing',
    `Freestanding application settings were not created in '${applicationRootPath}'. Missing: ${missingFiles.map(file => path.basename(file)).join(', ')}`);
}

/** Append the debug preset to the application's prj.conf, once. */
export async function debugPresetContent(projectRoot: string): Promise<void> {
  const prjConfPath = path.join(projectRoot, 'prj.conf');
  let content = '';
  if (fs.existsSync(prjConfPath)) {
    content = fs.readFileSync(prjConfPath, 'utf8');
  }

  // Avoid adding the block more than once.
  if (/^\s*CONFIG_DEBUG_OPTIMIZATIONS=y\s*$/m.test(content)) {
    return;
  }

  // Remove placeholder comments like "# nothing here" when debug preset is enabled.
  content = content
    .split(/\r?\n/)
    .filter(line => !/^\s*#\s*nothing\s+here\s*$/i.test(line))
    .join('\n');

  if (content.length > 0 && !content.endsWith('\n')) {
    content += '\n';
  }

  const block = [
    '',
    '# Added automatically by Workbench for Zephyr',
    '#--- DEBUG PRESET - BEGIN ---#',
    '# Set to -Og',
    'CONFIG_DEBUG_OPTIMIZATIONS=y',
    '# Thread awareness support',
    'CONFIG_DEBUG_THREAD_INFO=y',
    '# Generate stack usage per-function',
    'CONFIG_STACK_USAGE=y',
    '# Other options in case not set by default',
    'CONFIG_BUILD_OUTPUT_HEX=y',
    'CONFIG_BUILD_OUTPUT_META=y',
    'CONFIG_OUTPUT_SYMBOLS=y',
    'CONFIG_OUTPUT_STAT=y',
    'CONFIG_OUTPUT_DISASSEMBLY=y',
    'CONFIG_OUTPUT_PRINT_MEMORY_USAGE=y',
    '#--- DEBUG PRESET - END ---#',
    ''
  ].join('\n');

  fs.writeFileSync(prjConfPath, `${content}${block}`, 'utf8');
}

/**
 * Creates the application's own venv between copying the template and writing
 * the settings, and returns the venv path to store. `appRootPath` is given for
 * a west workspace application only, whose venv goes in its own folder rather
 * than in the settings folder.
 */
export type ApplicationVenvStep = (
  settingsFolder: vscode.WorkspaceFolder, westWorkspaceRootPath: string, appRootPath?: string,
) => Promise<string | undefined>;

export interface CreateApplicationOptions {
  westWorkspace: WestWorkspace;
  /** The sample or test folder copied into the new application. */
  templatePath: string;
  board: ZephyrBoard;
  toolchain: ToolchainInstallation;
  kind: ApplicationKind;
  /**
   * The folder that receives the application folder. Empty keeps the
   * template where it is and configures it in place.
   */
  parentDir: string;
  name: string;
  toolchainVariant?: string;
  settingsPathMode?: 'relative' | 'absolute';
  intellisenseProvider?: IntelliSenseProviderId;
  debugPreset?: boolean;
  createVenv?: ApplicationVenvStep;
}

export interface CreatedApplication {
  appRoot: string;
  kind: ApplicationKind;
  /**
   * The folder whose .vscode receives the settings: the west workspace folder
   * for a workspace application, the application folder otherwise, which VS
   * Code may not have opened yet.
   */
  settingsFolder: vscode.WorkspaceFolder;
}

/**
 * Copy the template and write the application's settings, as the create-app
 * command does. A west workspace application is declared in the settings of
 * its (open) workspace folder; a freestanding one gets its own .vscode folder
 * and is not added to the window here.
 */
export async function createApplication(options: CreateApplicationOptions): Promise<CreatedApplication> {
  const { westWorkspace, board, toolchain, kind, parentDir, name } = options;
  const settingsOptions = {
    toolchainVariant: options.toolchainVariant,
    intellisenseProvider: options.intellisenseProvider,
    pathMode: options.settingsPathMode,
  };

  let appRoot: string;
  if (parentDir.length === 0) {
    appRoot = options.templatePath;
  } else {
    if (kind === 'workspace' && !fileExists(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    const projectPath = path.join(parentDir, name);
    if (fileExists(projectPath)) {
      throw new ApplicationCreationError('destination-exists',
        `The folder [${projectPath}] already exists. Please change the project name or its location.`);
    }
    appRoot = copySampleSync(options.templatePath, projectPath);
  }

  if (kind === 'workspace') {
    const workspaceFolder = getWorkspaceFolder(westWorkspace.rootUri.fsPath);
    if (!workspaceFolder) {
      throw new ApplicationCreationError('workspace-not-open', 'The selected west workspace is not open in VS Code.');
    }

    if (options.debugPreset) {
      await debugPresetContent(appRoot);
    }

    const venvPath = await options.createVenv?.(workspaceFolder, westWorkspace.rootUri.fsPath, appRoot);

    await setDefaultWorkspaceApplicationSettings(workspaceFolder, appRoot, westWorkspace, board, toolchain, {
      ...settingsOptions,
      venvPath,
    });
    return { appRoot, kind, settingsFolder: workspaceFolder };
  }

  // Freestanding settings are app-local by contract. Write them against the
  // new path directly; adding the folder to VS Code is a UI step and may
  // lag/fail when the current window is a plain folder window rather than a
  // saved multi-root workspace.
  const workspaceFolder = createWorkspaceFolderReference(appRoot);
  if (options.debugPreset) {
    await debugPresetContent(workspaceFolder.uri.fsPath);
  }
  const venvPath = await options.createVenv?.(workspaceFolder, westWorkspace.rootUri.fsPath);

  await setDefaultProjectSettings(workspaceFolder, westWorkspace, board, toolchain, {
    ...settingsOptions,
    venvPath,
  });
  await assertFreestandingApplicationFilesCreated(appRoot);
  return { appRoot, kind, settingsFolder: workspaceFolder };
}
