import fs from 'fs';
import os from 'os';
import path from "path";
import * as vscode from "vscode";
import { WestWorkspace } from "../models/WestWorkspace";
import { ZephyrApplication } from "../models/ZephyrApplication";
import { ZephyrBoard } from "../models/ZephyrBoard";
import { ArmGnuToolchain, normalizeArmGnuTargetTriple, ZephyrSDK, IARToolchain } from "../models/ZephyrSDK";
import { ZephyrAppTemplateKind, ZephyrSample } from "../models/ZephyrSample";
import { getEnvVarFormat, getOutputChannel, getShell } from "./execUtils";
import { checkHostTools, checkEnvFile } from "./installUtils";
import {
  ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY,
  ZEPHYR_PROJECT_IAR_SETTING_KEY,
  ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY,
  ZEPHYR_WORKBENCH_LIST_ARM_GNU_TOOLCHAINS_SETTING_KEY,
  ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY,
  ZEPHYR_WORKBENCH_SETTING_SECTION_KEY,
  ZEPHYR_WORKBENCH_LIST_IARS_SETTING_KEY,
  ZINSTALLER_MINIMUM_VERSION,
} from '../constants';
import { checkOrCreateTask, ZephyrTaskProvider } from '../providers/ZephyrTaskProvider';
import { readInstalledZinstallerVersion, versionAtLeast } from './env/zinstallerVersionUtils';

let zephyrTasksFetchPromise: Promise<vscode.Task[]> | undefined;
const APP_TEMPLATE_METADATA_FILES: Record<string, ZephyrAppTemplateKind> = {
  'sample.yaml': 'sample',
  'testcase.yaml': 'test',
  'testcases.yml': 'test',
};

export function msleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function normalizePath(pathToNormalize: string) {
  let newpath = path.normalize(pathToNormalize);
  if (newpath.includes(' ')) {
    return `"${newpath}"`;
  }
  return newpath;
}

export function getInternalDirVSCodePath(): string {
  if (!isPortableMode()) {
    return path.join('${userHome}', '.zinstaller');
  } else {
    return path.join('${env:VSCODE_PORTABLE}', '.zinstaller');
  }
}

export function getInternalDirPath(): string {
  if (!isPortableMode()) {
    return path.join(os.homedir(), '.zinstaller');
  } else {
    return path.join(getEnvVarFormat(getShell(), 'VSCODE_PORTABLE'), '.zinstaller');
  }
}

export function getInternalDirRealPath(): string {
  return path.join(getInstallDirRealPath(), '.zinstaller');
}

export function getInternalToolsDirRealPath(): string {
  return path.join(getInternalDirRealPath(), 'tools');
}

export function getInstallDirRealPath(): string {
  if (isPortableMode()) {
    if (process.env['VSCODE_PORTABLE']) {
      return process.env['VSCODE_PORTABLE'];
    }
  }
  return os.homedir();
}

export function getEnvScriptFilename(): string {
  let scriptName: string = "";
  switch (getShell()) {
    case 'bash': {
      scriptName = 'env.sh';
      break;
    }
    case 'powershell.exe': {
      scriptName = 'env.ps1';
      break;
    }
    case 'cmd.exe': {
      scriptName = 'env.bat';
      break;
    }
    default: {
      scriptName = 'env.sh';
      break;
    }
  }
  return scriptName;
}

export function findDefaultEnvScriptPath(): string {
  return path.join(getInternalDirPath(), getEnvScriptFilename());
}

export function findDefaultOpenOCDPath(): string {
  let openOCDExecFilePath = path.join(getInternalDirPath(), 'tools', 'openocd', 'bin', 'openocd');
  return openOCDExecFilePath;
}

export function findDefaultOpenOCDScriptPath(): string {
  let openOCDScriptsDirPath = path.join(getInternalDirPath(), 'tools', 'openocd', 'scripts');
  return openOCDScriptsDirPath;
}


export function copyFolderInto(srcPath: string, destParentPath: string): string {
  const destPath = path.join(destParentPath, path.basename(srcPath));
  fs.cpSync(srcPath, destPath, { recursive: true });
  return destPath;
}

export function copyFolder(srcPath: string, destPath: string): string {
  fs.cpSync(srcPath, destPath, { recursive: true });
  return destPath;
}

export function copyFolderSync(srcDir: string, destDir: string, excludeDirs: string[] = []) {
  if (!fs.existsSync(srcDir)) {
    throw new Error(`Source directory "${srcDir}" does not exist.`);
  }

  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const items = fs.readdirSync(srcDir);
  for (const item of items) {
    const srcPath = path.join(srcDir, item);
    const destPath = path.join(destDir, item);
    const isDirectory = fs.lstatSync(srcPath).isDirectory();

    if (excludeDirs.includes(item)) {
      continue;
    }

    if (isDirectory) {
      copyFolderSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export function fileExists(path: string): boolean {
  return fs.existsSync(path);
}

function isRetryableDeleteError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EPERM';
}

export function deleteFolder(dir: string): void {
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 60,
        retryDelay: 250,
      });
    } catch (error) {
      if (!isRetryableDeleteError(error) || fs.existsSync(dir)) {
        console.warn(`Failed to delete folder "${dir}":`, error);
      }

      if (isRetryableDeleteError(error)) {
        try {
          vscode.window.showWarningMessage(
            `Could not fully delete "${path.basename(dir)}" because it is in use. Close the terminal or tools using that build folder and retry.`,
          );
        } catch {
          // Ignore UI notification failures from background cleanup paths.
        }
        return;
      }

      throw error;
    }
  }
}

export function getBase64(imgPath: string): string {
  const base64 = fs.readFileSync(imgPath, "base64");
  return base64;
}

export function isPortableMode(): boolean {
  return process.env['VSCODE_PORTABLE'] !== undefined;
}

export function getPortableModePath(): string {
  if (process.env['VSCODE_PORTABLE']) {
    return process.env['VSCODE_PORTABLE'];
  }
  return "";
}

export function formatWindowsPath(path: string): string {
  return path.replace(/\\/g, '\\\\');
}

export function getWorkspaceFolder(path: string): vscode.WorkspaceFolder | undefined {
  const folderUri: vscode.Uri = vscode.Uri.file(path);
  return vscode.workspace.getWorkspaceFolder(folderUri);
}

export function isWorkspaceFolder(path: string): boolean {
  const folderUri: vscode.Uri = vscode.Uri.file(path);

  // Verify workspace folder does not already exists
  if (vscode.workspace.workspaceFolders) {
    for (let workspaceFolder of vscode.workspace.workspaceFolders) {
      if (workspaceFolder.uri.fsPath === folderUri.fsPath) {
        return true;
      }
    }
  }
  return false;
}



export async function addWorkspaceFolder(path: string): Promise<boolean> {
  // Check if the folder is already in the workspace not to duplicate folder
  if (isWorkspaceFolder(path)) {
    return false;
  }

  const folderUri: vscode.Uri = vscode.Uri.file(path);

  const folderAddedPromise = new Promise<boolean>((resolve) => {
    const disposable = vscode.workspace.onDidChangeWorkspaceFolders(event => {
      if (event.added.some(folder => folder.uri.fsPath === folderUri.fsPath)) {
        disposable.dispose();
        resolve(true);
      }
    });

    // Set a timeout to wait before return error
    setTimeout(() => {
      disposable.dispose();
      resolve(false);
    }, 20000);
  });

  const result = vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders ?
    vscode.workspace.workspaceFolders.length : 0, null, { uri: folderUri, name: undefined });

  // If the update failed, resolve the promise immediately
  if (!result) {
    return false;
  }

  // Wait for the folder to be added to the workspace
  return folderAddedPromise;
}

export function removeWorkspaceFolder(workspaceFolder: vscode.WorkspaceFolder) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    const index = workspaceFolders.indexOf(workspaceFolder);
    if (index !== -1) {
      vscode.workspace.updateWorkspaceFolders(index, 1);
    } else {
      vscode.window.showErrorMessage('Workspace folder not found.');
    }
  } else {
    vscode.window.showErrorMessage('No workspace folders to remove.');
  }
}


export function getBoard(boardYamlPath: string, identifierOverride?: string): ZephyrBoard {
  return new ZephyrBoard(vscode.Uri.file(boardYamlPath), identifierOverride);
}

export function copySampleSync(sampleDir: string, destDir: string): string {
  copyFolderSync(sampleDir, destDir, ['.vscode', 'build', ...Object.keys(APP_TEMPLATE_METADATA_FILES)]);
  return destDir;
}

export async function getSample(filePath: string): Promise<ZephyrSample> {
  const sampleFolderUri = vscode.Uri.file(filePath);
  const name = path.basename(filePath);
  try {
    const kind = await findAppTemplateKind(sampleFolderUri);
    if (!kind) {
      throw new Error('Missing app template metadata');
    }
    return new ZephyrSample(name, sampleFolderUri, kind);
  } catch (error) {
    throw new Error('Cannot parse the sample or test folder');
  }

}

export async function getListSamples(westWorkspace: WestWorkspace): Promise<ZephyrSample[]> {
  let samplesList: ZephyrSample[] = [];
  if (westWorkspace) {
    await parseAppTemplates(westWorkspace.samplesDirUri, samplesList);
    await parseAppTemplates(westWorkspace.testsDirUri, samplesList);

    // Parse only from Workspace directory
    await parseWorkspaceAppTemplates(westWorkspace.rootUri, samplesList);
  }
  return new Promise((resolve) => {
    resolve(samplesList);
  });
}

function isPathWithin(parentPath: string, childPath: string): boolean {
  const normalizedParentPath = path.normalize(parentPath);
  const normalizedChildPath = path.normalize(childPath);

  const comparableParentPath = process.platform === 'win32'
    ? normalizedParentPath.toLowerCase()
    : normalizedParentPath;
  const comparableChildPath = process.platform === 'win32'
    ? normalizedChildPath.toLowerCase()
    : normalizedChildPath;

  return comparableChildPath === comparableParentPath
    || comparableChildPath.startsWith(`${comparableParentPath}${path.sep}`);
}

function toDisplayPath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/');
}

export function getAppTemplateDisplayPath(
  templatePath: string,
  westWorkspace: Pick<WestWorkspace, 'rootUri' | 'kernelUri' | 'zephyrBase'>
): string {
  if (isPathWithin(westWorkspace.kernelUri.fsPath, templatePath)) {
    const kernelRelativePath = path.relative(westWorkspace.kernelUri.fsPath, templatePath);
    return toDisplayPath(path.join(westWorkspace.zephyrBase, kernelRelativePath));
  }

  if (isPathWithin(westWorkspace.rootUri.fsPath, templatePath)) {
    const workspaceRelativePath = path.relative(westWorkspace.rootUri.fsPath, templatePath);
    return toDisplayPath(workspaceRelativePath);
  }

  return toDisplayPath(path.normalize(templatePath));
}

async function findAppTemplateKind(directory: vscode.Uri): Promise<ZephyrAppTemplateKind | undefined> {
  for (const [metadataFile, kind] of Object.entries(APP_TEMPLATE_METADATA_FILES)) {
    const metadataPath = vscode.Uri.joinPath(directory, metadataFile);
    try {
      await vscode.workspace.fs.stat(metadataPath);
      return kind;
    } catch (error) {
    }
  }
  return undefined;
}

function pushUniqueAppTemplate(projectList: ZephyrSample[], name: string, directory: vscode.Uri, kind: ZephyrAppTemplateKind) {
  if (projectList.some(project => project.rootDir.fsPath === directory.fsPath)) {
    return;
  }
  projectList.push(new ZephyrSample(name, directory, kind));
}

export async function parseAppTemplates(directory: vscode.Uri, projectList: ZephyrSample[], relativePath = ''): Promise<void> {
  try {
    const files = await vscode.workspace.fs.readDirectory(directory);

    for (const [name, type] of files) {
      const filePath = vscode.Uri.joinPath(directory, name);
      const fullPath = path.join(relativePath, name); // Keep track of the full path

      if (type === vscode.FileType.Directory) {
        const kind = await findAppTemplateKind(filePath);
        if (kind) {
          pushUniqueAppTemplate(projectList, name, filePath, kind);
        } else {
          await parseAppTemplates(filePath, projectList, fullPath);
        }
      }
    }
  } catch (error) {
  }
}

export async function parseWorkspaceAppTemplates(directory: vscode.Uri, projectList: ZephyrSample[], relativePath = ''): Promise<void> {
  try {
    const files = await vscode.workspace.fs.readDirectory(directory);

    for (const [name, type] of files) {
      const filePath = vscode.Uri.joinPath(directory, name);

      if (type === vscode.FileType.Directory) {
        const kind = await findAppTemplateKind(filePath);
        if (kind) {
          pushUniqueAppTemplate(projectList, name, filePath, kind);
        }
      }
    }
  } catch (error) {
  }
}

export async function getListApplications(appsPath: string | undefined): Promise<ZephyrApplication[]> {
  const applications: ZephyrApplication[] = [];
  if (appsPath) {
    const appsUri = vscode.Uri.file(appsPath);
    const files = await vscode.workspace.fs.readDirectory(appsUri);
    for (const [name, type] of files) {
      const filePath = vscode.Uri.joinPath(appsUri, name);

      if (type === vscode.FileType.Directory) {
        const projConfPath = vscode.Uri.joinPath(filePath, "prj.conf");
        try {
          await vscode.workspace.fs.stat(projConfPath);
          const application = new ZephyrApplication(vscode.workspace.getWorkspaceFolder(filePath), filePath.fsPath);
          applications.push(application);
        } catch (error) {
          // Not an application folder
        }
      }
    }
  }
  return new Promise((resolve) => {
    resolve(applications);
  });
}

export function getWestWorkspaces(): WestWorkspace[] {
  if (vscode.workspace.workspaceFolders) {
    const westWorkspaces: WestWorkspace[] = [];
    for (let workspaceFolder of vscode.workspace.workspaceFolders) {
      if (WestWorkspace.isWestWorkspaceFolder(workspaceFolder)) {
        try {
          const westWorkspace = new WestWorkspace(workspaceFolder.name, workspaceFolder.uri);
          westWorkspaces.push(westWorkspace);
        } catch (error) {
          getOutputChannel().appendLine(
            `[Zephyr Workbench] Skipping workspace "${workspaceFolder.uri.fsPath}": ${
              error instanceof Error ? error.stack ?? error.message : String(error)
            }`
          );
        }
      }
    }
    return westWorkspaces;
  }
  return [];
}

export function getWestWorkspace(workspacePath: string): WestWorkspace {
  if (WestWorkspace.isWestWorkspacePath(workspacePath)) {
    return new WestWorkspace(path.basename(workspacePath), vscode.Uri.file(workspacePath));
  }
  throw new Error('The selected folder is not a valid west workspace');
}

export function getZephyrSDK(sdkPath: string): ZephyrSDK {
  if (fileExists(sdkPath)) {
    return new ZephyrSDK(vscode.Uri.file(sdkPath));
  }
  throw new Error('Cannot parse the Zephyr SDK');
}

export function tryGetZephyrSDK(sdkPath: string | undefined): ZephyrSDK | undefined {
  if (!sdkPath) {
    return undefined;
  }
  if (fileExists(sdkPath)) {
    return new ZephyrSDK(vscode.Uri.file(sdkPath));
  }
  return undefined;
}

// TEMPORARY retrocompat — remove a few months after 2026-04.
// Projects that stored "zephyr_sdk" are migrated on first read to the new variant value "zephyr".
export function migrateToolchainVariant(cfg: vscode.WorkspaceConfiguration, raw: string): string {
  if (raw === 'zephyr_sdk') {
    cfg.update('toolchain', 'zephyr', vscode.ConfigurationTarget.WorkspaceFolder);
    return 'zephyr';
  }
  return raw;
}

export function findIarEntry(iarPath: string): IARToolchain | undefined {
  const list: any[] = vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
    .get(ZEPHYR_WORKBENCH_LIST_IARS_SETTING_KEY, []);
  const hit = list.find(e => e.iarPath === iarPath);
  if (!hit) { return; }
  if (!IARToolchain.isIarPath(hit.iarPath)) { return; }
  return new IARToolchain(hit.zephyrSdkPath, hit.iarPath, hit.token);
}

export function findArmGnuEntry(toolchainPath: string): ArmGnuToolchain | undefined {
  const list: any[] = vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
    .get(ZEPHYR_WORKBENCH_LIST_ARM_GNU_TOOLCHAINS_SETTING_KEY, []);
  const hit = list.find(entry => entry.toolchainPath === toolchainPath);
  if (!hit) { return; }
  if (!ArmGnuToolchain.isArmGnuPath(hit.toolchainPath)) { return; }
  return new ArmGnuToolchain(
    hit.toolchainPath,
    normalizeArmGnuTargetTriple(hit.targetTriple, hit.toolchainPath),
    hit.version,
  );
}


export async function getZephyrApplication(projectPath: string): Promise<ZephyrApplication> {
  const projectFolders = await ZephyrApplication.getApplicationWorkspaceFolders(vscode.workspace.workspaceFolders as vscode.WorkspaceFolder[]);
  for (const workspaceFolder of projectFolders) {
    if (workspaceFolder.uri.fsPath === projectPath) {
      return new ZephyrApplication(workspaceFolder, workspaceFolder.uri.fsPath);
    }
  }
  vscode.window.showInformationMessage("This is not a Zephyr application " +`${projectPath}`);
  throw new Error(`Cannot find project ${projectPath}`);
}

export async function getListZephyrSDKs(): Promise<ZephyrSDK[]> {
  const zephyrSDKPaths: string[] | undefined = vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
    .get(ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY);

  if (!zephyrSDKPaths) {
    throw new Error('No SDK definition found');
  }

  const sdks: ZephyrSDK[] = [];
  for (const path of zephyrSDKPaths) {
    if (ZephyrSDK.isSDKPath(path)) {
      const uri = vscode.Uri.file(path);
      sdks.push(new ZephyrSDK(uri));
    }
  }

  return sdks;
}

export async function getListIARs(): Promise<IARToolchain[]> {
  return new Promise((resolve) => {
    const iars: any[] = vscode.workspace
      .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
      .get(ZEPHYR_WORKBENCH_LIST_IARS_SETTING_KEY) ?? [];

    const valid = iars.filter(i => IARToolchain.isIarPath(i.iarPath));
    const toolchains = valid.map(i => new IARToolchain(i.zephyrSdkPath, i.iarPath, i.token));
    resolve(toolchains);
  });
}

export async function getListArmGnuToolchains(): Promise<ArmGnuToolchain[]> {
  return new Promise((resolve) => {
    const armGnuToolchains: any[] = vscode.workspace
      .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
      .get(ZEPHYR_WORKBENCH_LIST_ARM_GNU_TOOLCHAINS_SETTING_KEY) ?? [];

    const valid = armGnuToolchains.filter(toolchain => ArmGnuToolchain.isArmGnuPath(toolchain.toolchainPath));
    const toolchains = valid.map(toolchain => new ArmGnuToolchain(
      toolchain.toolchainPath,
      normalizeArmGnuTargetTriple(toolchain.targetTriple, toolchain.toolchainPath),
      toolchain.version,
    ));
    resolve(toolchains);
  });
}

export function getIarToolchainForSdk(sdkPath: string): IARToolchain | undefined {
  const raw = vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
    .get<any[]>(ZEPHYR_WORKBENCH_LIST_IARS_SETTING_KEY) ?? [];

  const hit = raw.find(i => i.iarPath === sdkPath);
  if (!hit) { return; }

  if (!IARToolchain.isIarPath(hit.iarPath)) {
    vscode.window.showWarningMessage(`IAR toolchain at ${hit.iarPath} is no longer valid`);
    return;
  }

  return new IARToolchain(hit.zephyrSdkPath, hit.iarPath, hit.token);
}

export function getArmGnuToolchainForPath(toolchainPath: string): ArmGnuToolchain | undefined {
  const raw = vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
    .get<any[]>(ZEPHYR_WORKBENCH_LIST_ARM_GNU_TOOLCHAINS_SETTING_KEY) ?? [];

  const hit = raw.find(entry => entry.toolchainPath === toolchainPath);
  if (!hit) { return; }

  if (!ArmGnuToolchain.isArmGnuPath(hit.toolchainPath)) {
    vscode.window.showWarningMessage(`Arm GNU toolchain at ${hit.toolchainPath} is no longer valid`);
    return;
  }

  return new ArmGnuToolchain(
    hit.toolchainPath,
    normalizeArmGnuTargetTriple(hit.targetTriple, hit.toolchainPath),
    hit.version,
  );
}

export function getConfiguredToolchainEnv(cfg: vscode.WorkspaceConfiguration): Record<string, string> {
  const toolchainKind = migrateToolchainVariant(
    cfg,
    cfg.get<string>(ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY) ?? 'zephyr',
  );

  if (toolchainKind === 'iar') {
    const selectedIarPath = cfg.get<string>(ZEPHYR_PROJECT_IAR_SETTING_KEY, '');
    const iarEntry = findIarEntry(selectedIarPath);
    if (!iarEntry) {
      return {};
    }

    const armSubdir =
      process.platform === 'win32'
        ? path.join(iarEntry.iarPath, 'arm')
        : path.posix.join(iarEntry.iarPath, 'arm');

    return {
      IAR_TOOLCHAIN_PATH: armSubdir,
      ZEPHYR_TOOLCHAIN_VARIANT: 'iar',
      IAR_LMS_BEARER_TOKEN: iarEntry.token ?? '',
    };
  }

  if (toolchainKind === 'gnuarmemb') {
    const selectedArmGnuPath = cfg.get<string>(ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY, '');
    const armGnuEntry = findArmGnuEntry(selectedArmGnuPath);
    if (!armGnuEntry) {
      return {};
    }

    return {
      GNUARMEMB_TOOLCHAIN_PATH: armGnuEntry.toolchainPath,
      ZEPHYR_TOOLCHAIN_VARIANT: 'gnuarmemb',
    };
  }

  return { ZEPHYR_TOOLCHAIN_VARIANT: toolchainKind };
}

export async function getInternalZephyrSDK(): Promise<ZephyrSDK | undefined> {
  if (await checkHostTools()) {
    const files = fs.readdirSync(getInternalDirRealPath(), { withFileTypes: true, recursive: false });
    for (const file of files) {
      const filePath = path.join(file.path, file.name);
      if (file.isDirectory() && ZephyrSDK.isSDKPath(filePath)) {
        const uri = vscode.Uri.file(filePath);
        return new ZephyrSDK(uri);
      }
    }
  }

  return undefined;
}

async function getZephyrWorkbenchTasks(): Promise<vscode.Task[]> {
  if (!zephyrTasksFetchPromise) {
    const fetchPromise = Promise.resolve(vscode.tasks.fetchTasks({ type: 'zephyr-workbench' }));
    zephyrTasksFetchPromise = fetchPromise;

    fetchPromise.finally(() => {
      if (zephyrTasksFetchPromise === fetchPromise) {
        zephyrTasksFetchPromise = undefined;
      }
    });
  }

  return zephyrTasksFetchPromise;
}

export async function findTask(taskLabel: string, workspaceFolder: vscode.WorkspaceFolder): Promise<vscode.Task | undefined> {
  const tasks = await getZephyrWorkbenchTasks();
  return tasks.find(task => {
    const folder = task.scope as vscode.WorkspaceFolder;
    return folder && folder.uri.toString() === workspaceFolder.uri.toString() && task.name === taskLabel;
  });
}

export async function findOrCreateTask(taskLabel: string, workspaceFolder: vscode.WorkspaceFolder): Promise<vscode.Task | undefined> {
  const taskExists = await checkOrCreateTask(workspaceFolder, taskLabel);
  if (taskExists) {
    const tasks = await getZephyrWorkbenchTasks();
    return tasks.find(task => {
      const folder = task.scope as vscode.WorkspaceFolder;
      return folder && folder.uri.toString() === workspaceFolder.uri.toString() && task.name === taskLabel;
    });
  }
  return undefined;
}

/**
 * Find zephyr-workbench task for the project and adapt it for configuration.
 * 
 * @param taskLabel 
 * @param project 
 * @param configName 
 * @returns 
 */
export async function findConfigTask(taskLabel: string, project: ZephyrApplication, configName: string): Promise<vscode.Task | undefined> {
  const taskExists = await checkOrCreateTask(project.appWorkspaceFolder, taskLabel);
  if (taskExists) {
    const tasks = await getZephyrWorkbenchTasks();
    const task = tasks.find(task => {
      const folder = task.scope as vscode.WorkspaceFolder;
      return folder && folder.uri.toString() === project.appWorkspaceFolder.uri.toString() && task.name === taskLabel;
    });
    if (task) {
      // If task found is already set for the chosen build configuration
      if (task.definition.config === configName) {
        return task;
      } else {
        // Else, if the build config differs, create temporary task to
        // avoid messing with tasks.json
        for (let config of project.buildConfigs) {
          if (configName === config.name) {
            const buildDirVar = getEnvVarFormat(getShell(), 'BUILD_DIR');
            let args: string[] = [];
            for (let arg of task.definition.args) {
              // - Do not add user any --build-dir option, use value from BUILD_DIR variable
              // - To avoid error with legacy project, if --board argument is set, remove it, west will
              // use BOARD environment variable instead
              if (!arg.startsWith('--build-dir') && !arg.startsWith('--board')) {
                args.push(arg);
              }
            }
            // Explicitly set board for temporary tasks so west can build if needed
            // (multi-build configs might not be built yet)
            if (config.boardIdentifier && config.boardIdentifier.length > 0) {
              args.push(`--board ${config.boardIdentifier}`);
            }
            args.push(`--build-dir ${buildDirVar}`);

            // Create temporary task with the args adapted to the config
            const taskDefinition = {
              ...task.definition,
              config: configName,
              args: args
            };

            const tmpTask = new vscode.Task(
              taskDefinition,
              task.scope as vscode.WorkspaceFolder,
              `${task.name} [${config.name}]`,
              task.source,
              task.execution
            );

            // Resolve the zephyr-workbench task to run task with correct env
            const newTask = ZephyrTaskProvider.resolve(tmpTask);

            vscode.window.showWarningMessage('Task execution: Arguments "--board" and "--build-dir" are ignored.');
            return newTask;
          }
        }
      }
    }
  }
  return undefined;
}


/**
 * @deprecated Use the getSupportedBoards instead.
 */
export async function getSupportedBoards2(westWorkspace: WestWorkspace): Promise<ZephyrBoard[]> {
  const listBoards: ZephyrBoard[] = [];
  await parseSupportedBoards(
    westWorkspace,
    westWorkspace.boardsDirUri,
    listBoards,
    westWorkspace.rootUri.fsPath
  );
  return listBoards;
}

export async function parseSupportedBoards(westWorkspace: WestWorkspace, directory: vscode.Uri, listBoards: ZephyrBoard[], rootPath: string, relativePath = ''): Promise<void> {
  try {
    const files = await vscode.workspace.fs.readDirectory(directory);

    for (const [name, type] of files) {
      const filePath = vscode.Uri.joinPath(directory, name);
      const fullPath = path.join(relativePath, name); // Keep track of the full path

      if (type === vscode.FileType.Directory) {
        let boardFilePath: vscode.Uri;
        if (westWorkspace.versionArray['VERSION_MAJOR'] >= '3' &&
          westWorkspace.versionArray['VERSION_MINOR'] >= '6' &&
          westWorkspace.versionArray['PATCHLEVEL'] > '0'
        ) {
          boardFilePath = vscode.Uri.joinPath(filePath, "board.yml");
        } else {
          boardFilePath = vscode.Uri.joinPath(filePath, "board.cmake");
        }

        try {
          await vscode.workspace.fs.stat(boardFilePath);
          for (const [name, type] of await vscode.workspace.fs.readDirectory(filePath)) {
            if (type === vscode.FileType.File && name.endsWith('.yaml')) {
              const boardDescUri = vscode.Uri.joinPath(filePath, name);
              listBoards.push(new ZephyrBoard(boardDescUri));
            }
          }
        } catch (error) {
          await parseSupportedBoards(westWorkspace, filePath, listBoards, rootPath, fullPath);
        }
      }
    }
  } catch (error) {
  }
}

/**
 * Compares two version strings in semantic versioning format.
 * @param v1 - The first version string.
 * @param v2 - The second version string.
 * @returns A number: 1 if v1 > v2, -1 if v1 < v2, 0 if equal.
 */
export function compareVersions(v1: string, v2: string): number {
  const parseVersion = (version: string) => {
    const normalized = version.trim().replace(/^v/, '').split('+', 1)[0];
    const [core, prerelease] = normalized.split('-', 2);
    const coreParts = core.split('.').map(part => Number(part));

    if (coreParts.some(part => Number.isNaN(part))) {
      return undefined;
    }

    const prereleaseParts = prerelease
      ? prerelease
        .split('.')
        .flatMap(part => part.match(/[A-Za-z]+|\d+/g) ?? [part])
      : [];

    return { coreParts, prereleaseParts };
  };

  const parsedV1 = parseVersion(v1);
  const parsedV2 = parseVersion(v2);

  if (!parsedV1 || !parsedV2) {
    return v1.localeCompare(v2);
  }

  for (let i = 0; i < Math.max(parsedV1.coreParts.length, parsedV2.coreParts.length); i++) {
    const v1Part = parsedV1.coreParts[i] || 0;
    const v2Part = parsedV2.coreParts[i] || 0;

    if (v1Part > v2Part) {
      return 1;
    }
    if (v1Part < v2Part) {
      return -1;
    }
  }

  const v1HasPrerelease = parsedV1.prereleaseParts.length > 0;
  const v2HasPrerelease = parsedV2.prereleaseParts.length > 0;

  if (v1HasPrerelease !== v2HasPrerelease) {
    return v1HasPrerelease ? -1 : 1;
  }

  for (let i = 0; i < Math.max(parsedV1.prereleaseParts.length, parsedV2.prereleaseParts.length); i++) {
    const v1Part = parsedV1.prereleaseParts[i];
    const v2Part = parsedV2.prereleaseParts[i];

    if (v1Part === undefined) {
      return -1;
    }
    if (v2Part === undefined) {
      return 1;
    }

    const v1IsNumber = /^\d+$/.test(v1Part);
    const v2IsNumber = /^\d+$/.test(v2Part);

    if (v1IsNumber && v2IsNumber) {
      const v1Number = Number(v1Part);
      const v2Number = Number(v2Part);

      if (v1Number > v2Number) {
        return 1;
      }
      if (v1Number < v2Number) {
        return -1;
      }
      continue;
    }

    if (v1IsNumber !== v2IsNumber) {
      return v1IsNumber ? -1 : 1;
    }

    const comparison = v1Part.localeCompare(v2Part);
    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}

/**
 * Helper function to get value from .config file
 * @param option 
 * @param configFile 
 * @returns 
 */
export function getConfigValue(configFile: string, option: string): string | undefined {
  try {
    const configContent = fs.readFileSync(configFile, 'utf-8');
    const regex = new RegExp(`^CONFIG_${option}="?(.*?)"?$`, 'm');
    const match = configContent.match(regex);
    return match ? match[1] : undefined;
  } catch (err) {
    return undefined;
  }
}

export async function readDirectoryRecursive(dirUri: vscode.Uri): Promise<vscode.Uri[]> {
  let files: vscode.Uri[] = [];

  const entries = await vscode.workspace.fs.readDirectory(dirUri);
  for (const [name, type] of entries) {
    const entryUri = vscode.Uri.joinPath(dirUri, name);

    if (type === vscode.FileType.Directory) {
      const subFiles = await readDirectoryRecursive(entryUri);
      files = files.concat(subFiles);
    } else if (type === vscode.FileType.File) {
      files.push(entryUri);
    }
  }

  return files;
}

export async function validateProjectLocation(location: string) {
  if(!fileExists(location)) {
    return "Invalid project path.";
  }
}

// Returns true if zinstaller_version is missing or below the minimum required
export function isZinstallerUpdateNeeded(): boolean {
  try {
    const current = readInstalledZinstallerVersion();
    if (!current) { return true; }
    return !versionAtLeast(current, ZINSTALLER_MINIMUM_VERSION);
  } catch {
    return true;
  }
}

export async function checkZinstallerVersion(
  context: vscode.ExtensionContext)
{
  // Prompt to install when host tools are not installed
  try {
    const hasTools = await checkHostTools();
    const hasEnv = await checkEnvFile();
    if (!hasTools || !hasEnv) {
      const installHostToolsItem = 'Install Host Tools';
      const choice = await vscode.window.showErrorMessage(
        'Host tools are missing, please install them first',
        installHostToolsItem
      );
      if (choice === installHostToolsItem) {
        try { await vscode.commands.executeCommand('zephyr-workbench.install-host-tools.open-manager'); } catch {}
      }
      return;
    }
  } catch {
    // If detection fails, continue to the version check
  }

  const current = readInstalledZinstallerVersion();
  const fileExists = !!current;

  // If version file exists and meets minimum, no action; otherwise prompt
  if (fileExists && versionAtLeast(current, ZINSTALLER_MINIMUM_VERSION)) { return; }


  const answer = await vscode.window.showWarningMessage(
    "Your host tools are outdated.⚠️The build system might not work properly.⚠️",
    "Reinstall Host Tools"
  );

  if (answer === "Reinstall Host Tools") {
    await vscode.commands.executeCommand(
      "zephyr-workbench.install-host-tools",
      true 
    );
  }
}

export function checkPathSpace(path: string, showVscode: boolean = true): boolean {
  if (!path) { return false; }
  if (/\s/.test(path)) {
    const msg = `Install path contains space: "${path}". This may not work with the installer.`;
    try { if (showVscode) { vscode.window.showWarningMessage(msg); } } catch {}
    console.warn(msg);
    return true;
  }
  return false;
}
