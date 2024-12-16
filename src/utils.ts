import fs from 'fs';
import * as fsPromise from 'fs/promises';
import os from 'os';
import path from "path";
import yaml from 'yaml';
import * as vscode from "vscode";
import { WestWorkspace } from "./WestWorkspace";
import { ZephyrAppProject } from "./ZephyrAppProject";
import { ZephyrBoard } from "./ZephyrBoard";
import { ZephyrSDK } from "./ZephyrSDK";
import { ZephyrSample } from "./ZephyrSample";
import { getEnvVarFormat, getShell } from "./execUtils";
import { checkHostTools } from "./installUtils";
import { ZEPHYR_BUILD_CONFIG_WEST_ARGS_SETTING_KEY, ZEPHYR_PROJECT_BOARD_SETTING_KEY, ZEPHYR_PROJECT_EXTRA_WEST_ARGS_SETTING_KEY, ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from './constants';
import { ZephyrProject } from './ZephyrProject';
import { getBoardsDirectories, getBoardsDirectoriesFromIdentifier, westTmpBuildSystemCommand } from './WestCommands';
import { checkOrCreateTask, TaskConfig, ZephyrTaskProvider } from './ZephyrTaskProvider';
import { ZephyrProjectBuildConfiguration } from './ZephyrProjectBuildConfiguration';
import { addConfig, saveConfigEnv, saveConfigSetting, saveEnv } from './zephyrEnvUtils';

export function normalizePath(pathToNormalize: string) {
  let newpath = path.normalize(pathToNormalize);
  if (newpath.includes(' ')) {
    return `"${newpath}"`;
  }
  return newpath;
}

export function getInternalDirVSCodePath(): string {
  if(!isPortableMode()) {
    return path.join('${userHome}', '.zinstaller');
  } else {
    return path.join('${env:VSCODE_PORTABLE}', '.zinstaller');
  }
}

export function getInternalDirPath(): string {
  if(!isPortableMode()) {
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
  if(isPortableMode()) {
    if(process.env['VSCODE_PORTABLE']) {
      return process.env['VSCODE_PORTABLE'];
    }
  } 
  return os.homedir();
}

export function getEnvScriptFilename(): string {
  let scriptName: string = "";
  switch(getShell()) {
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
  fs.cpSync(srcPath, destPath, {recursive: true});
  return destPath;
}

export function copyFolder(srcPath: string, destPath: string): string {
  fs.cpSync(srcPath, destPath, {recursive: true});
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

export function deleteFolder(path: string) {
  fs.rmSync(path, { recursive: true });
}

export function getBase64(imgPath: string): string {
  const base64 = fs.readFileSync(imgPath, "base64");
  return base64;
}

export function isPortableMode(): boolean {
  return process.env['VSCODE_PORTABLE'] !== undefined;
}

export function getPortableModePath(): string {
  if(process.env['VSCODE_PORTABLE']) {
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
  if(vscode.workspace.workspaceFolders) {
    for(let workspaceFolder of vscode.workspace.workspaceFolders) {
      if(workspaceFolder.uri.fsPath === folderUri.fsPath) {
        return true;
      }
    }
  }
  return false;
}



export async function addWorkspaceFolder(path: string): Promise<boolean> {
  // Check if the folder is already in the workspace not to duplicate folder
  if(isWorkspaceFolder(path)) {
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

  const result =  vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders ? 
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


export async function getBoardFromIdentifier(boardIdentifier: string, westWorkspace: WestWorkspace, resource?: ZephyrProject | string, buildConfig?: ZephyrProjectBuildConfiguration | undefined): Promise<ZephyrBoard> {
  for(let board of await getSupportedBoards(westWorkspace, resource, buildConfig)) {
    if(boardIdentifier === board.identifier) {
      return board;
    }
  }
  throw new Error(`No board named ${boardIdentifier} found`);
}

export function getBoard(boardYamlPath: string): ZephyrBoard {
  return new ZephyrBoard(vscode.Uri.file(boardYamlPath));
}

export function copySampleSync(sampleDir: string, destDir: string): string {
  copyFolderSync(sampleDir, destDir, ['.vscode', 'build', 'sample.yaml']);
  return destDir;
}

export async function getSample(filePath: string): Promise<ZephyrSample> {
  const sampleFolderUri = vscode.Uri.file(filePath);
  const name = path.basename(filePath);
  const sampleYamlPath = vscode.Uri.joinPath(sampleFolderUri, "sample.yaml");
  try {
    await vscode.workspace.fs.stat(sampleYamlPath);
    return new ZephyrSample(name, sampleFolderUri);
  } catch (error) {
    throw new Error('Cannot parse the sample folder');
  }
  
}

export async function getListSamples(westWorkspace: WestWorkspace): Promise<ZephyrSample[]> {
  let samplesList: ZephyrSample[] = [];
  if(westWorkspace) {
    const samplesUri = westWorkspace.samplesDirUri;
    // Recursively parse from Zephyr sample directory
    await parseSamples(samplesUri, samplesList);

    // Parse only from Workspace directory
    await parseWorkspaceSamples(westWorkspace.rootUri, samplesList);
  }
  return new Promise((resolve) => {
    resolve(samplesList);
  });
}

export async function parseSamples(directory: vscode.Uri, projectList: ZephyrSample[], relativePath = ''): Promise<void> {
  try {
    const files = await vscode.workspace.fs.readDirectory(directory);

    for (const [name, type] of files) {
      const filePath = vscode.Uri.joinPath(directory, name);
      const fullPath = path.join(relativePath, name); // Keep track of the full path

      if (type === vscode.FileType.Directory) {
        const sampleYamlPath = vscode.Uri.joinPath(filePath, "sample.yaml");
        try {
          await vscode.workspace.fs.stat(sampleYamlPath);
          projectList.push(new ZephyrSample(name, filePath));
        } catch (error) {
          await parseSamples(filePath, projectList, fullPath);
        }
      }
    }
  } catch (error) {
  }
}

export async function parseWorkspaceSamples(directory: vscode.Uri, projectList: ZephyrSample[], relativePath = ''): Promise<void> {
  try {
    const files = await vscode.workspace.fs.readDirectory(directory);

    for (const [name, type] of files) {
      const filePath = vscode.Uri.joinPath(directory, name);
      const fullPath = path.join(relativePath, name); // Keep track of the full path

      if (type === vscode.FileType.Directory) {
        const sampleYamlPath = vscode.Uri.joinPath(filePath, "sample.yaml");
        try {
          await vscode.workspace.fs.stat(sampleYamlPath);
          projectList.push(new ZephyrSample(name, filePath));
        } catch (error) {
          
        }
      }
    }
  } catch (error) {
  }
}

export async function getListProject(appsPath: string | undefined): Promise<ZephyrAppProject[]> {
  let listProjects: ZephyrAppProject[] = [];
  if(appsPath) {
    let appsUri = vscode.Uri.file(appsPath);
    const files = await vscode.workspace.fs.readDirectory(appsUri);
    for (const [name, type] of files) {
      const filePath = vscode.Uri.joinPath(appsUri, name);

      if (type === vscode.FileType.Directory) {
        const projConfPath = vscode.Uri.joinPath(filePath, "prj.conf");
        try {
          await vscode.workspace.fs.stat(projConfPath);
          let project: ZephyrAppProject = new ZephyrAppProject(vscode.workspace.getWorkspaceFolder(filePath), filePath.fsPath);
          listProjects.push(project);
        } catch (error) {
          // Not a project folder
        }
      }
    }
  }
  return new Promise((resolve, reject) => {
    resolve(listProjects);
  });
}

export function getWestWorkspaces(): WestWorkspace[] {
  if(vscode.workspace.workspaceFolders) {
    const westWorkspaces: WestWorkspace[] = [];
    for(let workspaceFolder of vscode.workspace.workspaceFolders) {
      if(WestWorkspace.isWestWorkspaceFolder(workspaceFolder)) {
        const westWorkspace = new WestWorkspace(workspaceFolder.name, workspaceFolder.uri);
        westWorkspaces.push(westWorkspace);
      }
    }
    return westWorkspaces;
  } 
  return [];
}

export function getWestWorkspace(workspacePath: string): WestWorkspace {
  if(fileExists(workspacePath)) {
    return new WestWorkspace(path.basename(workspacePath), vscode.Uri.file(workspacePath));
  }
  throw new Error('Cannot parse the west workspace');
}

export function getZephyrSDK(sdkPath: string): ZephyrSDK {
  if(fileExists(sdkPath)) {
    return new ZephyrSDK(vscode.Uri.file(sdkPath));
  }
  throw new Error('Cannot parse the Zephyr SDK');
}

export async function getZephyrProject(projectPath: string): Promise<ZephyrProject> {
  for(let workspaceFolder of vscode.workspace.workspaceFolders as vscode.WorkspaceFolder[]) {
    if(await ZephyrAppProject.isZephyrProjectWorkspaceFolder(workspaceFolder)) {
      if(workspaceFolder.uri.fsPath === projectPath) {
        return new ZephyrAppProject(workspaceFolder, workspaceFolder.uri.fsPath);
      }
    }
  }
  throw new Error(`Cannot find project ${projectPath}`);
}

export async function getListZephyrSDKs(): Promise<ZephyrSDK[]> {
  return new Promise(async (resolve, reject) => {
    let zephyrSDKPaths: string[] | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY);
    if(!zephyrSDKPaths) {
      reject('No SDK definition found');
    }

    let sdks: ZephyrSDK[] = [];
    for(const path of zephyrSDKPaths as string[]) {
      if(ZephyrSDK.isSDKPath(path)) {
        let uri = vscode.Uri.file(path);
        const sdk = new ZephyrSDK(uri);
        sdks.push(sdk);
      }
    }
    resolve(sdks);
  });
}

export async function getInternalZephyrSDK(): Promise<ZephyrSDK | undefined> {
  return new Promise(async (resolve) => {
    if(await checkHostTools()) {
      const files = fs.readdirSync(getInternalDirRealPath(), { withFileTypes: true, recursive: false });
      for(const file of files) {
        let filePath = path.join(file.path, file.name);
        if(file.isDirectory() && ZephyrSDK.isSDKPath(filePath)) {
          let uri = vscode.Uri.file(filePath);
          const sdk = new ZephyrSDK(uri);
          resolve(sdk);
        }
      }
    }
    resolve(undefined);
  });
}

async function fetchTasksFromWorkspaceFolder(workspaceFolder: vscode.WorkspaceFolder) {
  try {
      // Fetch all tasks
      const allTasks = await vscode.tasks.fetchTasks();
      
      // Filter tasks that belong to the given workspace folder
      const tasksInWorkspaceFolder = allTasks.filter(task => {
          const folder = task.scope as vscode.WorkspaceFolder;
          return folder && folder.uri.toString() === workspaceFolder.uri.toString();
      });

      return tasksInWorkspaceFolder;
  } catch (error) {
      console.error('Error fetching tasks:', error);
      return [];
  }
}

export async function findTask(taskLabel: string, workspaceFolder: vscode.WorkspaceFolder): Promise<vscode.Task | undefined> {
  const tasks = await vscode.tasks.fetchTasks({ type: 'zephyr-workbench' });
  return tasks.find(task => {
    const folder = task.scope as vscode.WorkspaceFolder;
    return folder && folder.uri.toString() === workspaceFolder.uri.toString() && task.name === taskLabel;
  });
}

export async function findOrCreateTask(taskLabel: string, workspaceFolder: vscode.WorkspaceFolder): Promise<vscode.Task | undefined> {
  const taskExists = await checkOrCreateTask(workspaceFolder, taskLabel);
  if(taskExists) {
    const tasks = await vscode.tasks.fetchTasks({ type: 'zephyr-workbench' });
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
export async function findConfigTask(taskLabel: string, project: ZephyrProject, configName: string): Promise<vscode.Task | undefined> {
  const taskExists = await checkOrCreateTask(project.workspaceFolder, taskLabel);
  if(taskExists) {
    const tasks = await vscode.tasks.fetchTasks({ type: 'zephyr-workbench' });
    const task = tasks.find(task => {
      const folder = task.scope as vscode.WorkspaceFolder;
      return folder && folder.uri.toString() === project.workspaceFolder.uri.toString() && task.name === taskLabel;
    });
    if(task) {
      // If task found is already set for the chosen build configuration
      if(task.definition.config === configName) {
        return task;
      } else {
        // Else, if the build config differs, create temporary task to
        // avoid messing with tasks.json
        for(let config of project.configs) {
          if(configName === config.name) {
            const buildDirVar = getEnvVarFormat(getShell(), 'BUILD_DIR');
            let args: string[] = [];
            for(let arg of task.definition.args) {
              // - Do not add user any --build-dir option, use value from BUILD_DIR variable
              // - To avoid error with legacy project, if --board argument is set, remove it, west will
              // use BOARD environment variable instead
              if (!arg.startsWith('--build-dir') && !arg.startsWith('--board')) {
                args.push(arg);
              }
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
  return new Promise(async (resolve, reject) => {
    let listBoards: ZephyrBoard[] = [];
    await parseSupportedBoards(westWorkspace, westWorkspace.boardsDirUri, listBoards, westWorkspace.rootUri.fsPath)
     .then(() => {
      resolve(listBoards);
     })
     .catch(() => {
      reject();
     });
  });
}

export async function getSupportedBoards(westWorkspace: WestWorkspace, resource?: ZephyrProject | string, buildConfig?: ZephyrProjectBuildConfiguration | undefined): Promise<ZephyrBoard[]> {
  return new Promise(async (resolve, reject) => {
    let listBoards: ZephyrBoard[] = [];
    // Add West workspace root directory for search
    let boardRoots: string[] = [westWorkspace.rootUri.fsPath];

    // Add user custom board directory for search
    if(westWorkspace.envVars['BOARD_ROOT']) {
      for(let boardDir of westWorkspace.envVars['BOARD_ROOT']) {
        boardRoots.push(boardDir);
      }
    }

    if(resource) {
      if(resource instanceof ZephyrProject) {
        let buildDir = resource.buildDir;
        if(buildConfig) {
          buildDir = buildConfig.getBuildDir(resource);
        }
        // Search the BOARD_ROOT definition from the zephyr_settings.txt 
        // By looking into an existing buildDir or generating a tmp buildDir from dry run
        let envVars: Record<string, string> | undefined;
        if(fileExists(buildDir)) {
          envVars = readZephyrSettings(buildDir);
        } else {
          const tmpBuildDir = await westTmpBuildSystemCommand(resource, westWorkspace);
          if(tmpBuildDir) {
            envVars = readZephyrSettings(tmpBuildDir);
            deleteFolder(tmpBuildDir);
          }
        }
        if(envVars) {
          let keys = Object.keys(envVars);
          for(let key of keys) {
            if(key === 'BOARD_ROOT') {
              boardRoots.push(envVars[key]);
            }
          }
        }
      } else {
        boardRoots.push(resource);
      }
    }
    let boardDirs = await getBoardsDirectories(westWorkspace, boardRoots);

    const dirPromises = boardDirs.map(async (dir) => {
      let dirUri = vscode.Uri.file(dir);
      try {
        const files = await vscode.workspace.fs.readDirectory(dirUri);
        const boardPromises = files
          .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.yaml'))
          .map(([name]) => {
            const boardDescUri = vscode.Uri.joinPath(dirUri, name);
            const boardFile = fs.readFileSync(boardDescUri.fsPath, 'utf8');
            const data = yaml.parse(boardFile);
            if(data.identifier) {
              return new ZephyrBoard(boardDescUri);
            }
            return undefined;
        });
        const boards = await Promise.all(boardPromises);
        listBoards.push(...boards.filter(board => board !== undefined));
      } catch (error) {
        console.error(`Error reading directory: ${dirUri.fsPath}`, error);
      }
    });
    
    await Promise.all(dirPromises);
    resolve(listBoards);
  });
}

async function findBoardDirectories(dirUri: vscode.Uri): Promise<vscode.Uri[]> {
  let boardDirs: vscode.Uri[] = [];
  const entries = await vscode.workspace.fs.readDirectory(dirUri);

  let containsBoardFile = false;

  for (const [name, type] of entries) {
    const entryUri = vscode.Uri.joinPath(dirUri, name);

    if (type === vscode.FileType.File && (name === 'board.cmake' || name === 'board.yml')) {
      containsBoardFile = true;
    }
    if (type === vscode.FileType.Directory) {
      const subBoardDirs = await findBoardDirectories(entryUri);
      boardDirs = boardDirs.concat(subBoardDirs);
    }
  }

  if (containsBoardFile) {
    boardDirs.push(dirUri);
  }

  return boardDirs;
}

export async function parseSupportedBoards(westWorkspace: WestWorkspace, directory: vscode.Uri, listBoards: ZephyrBoard[], rootPath: string, relativePath = ''): Promise<void> {
  try {
    const files = await vscode.workspace.fs.readDirectory(directory);

    for (const [name, type] of files) {
      const filePath = vscode.Uri.joinPath(directory, name);
      const fullPath = path.join(relativePath, name); // Keep track of the full path

      if (type === vscode.FileType.Directory) {
        let boardFilePath: vscode.Uri;
        if(westWorkspace.versionArray['VERSION_MAJOR'] >= '3' &&
          westWorkspace.versionArray['VERSION_MINOR'] >= '6' &&
          westWorkspace.versionArray['PATCHLEVEL'] > '0' 
        ) {
          boardFilePath = vscode.Uri.joinPath(filePath, "board.yml");
        } else {
          boardFilePath = vscode.Uri.joinPath(filePath, "board.cmake");
        }
        
        try {
          await vscode.workspace.fs.stat(boardFilePath);
          for( const [name, type] of await vscode.workspace.fs.readDirectory(filePath)) {
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
  const v1Parts = v1.replace(/^v/, '').split('.').map(Number);
  const v2Parts = v2.replace(/^v/, '').split('.').map(Number);

  for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
      const v1Part = v1Parts[i] || 0;
      const v2Part = v2Parts[i] || 0;

      if (v1Part > v2Part) {
        return 1;
      }
      if (v1Part < v2Part) {
        return -1;
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

export function readZephyrSettings(buildDir: string): Record<string, string>  {
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
  } catch (e) {
    console.error(`Cannot read ${filePath}`);
  }
  return settings;
}

/**
 * For legacy compatibility:
 * Temporary convert method to upgrade legacy settings.json
 * Code to remove when no legacy project exists anymore
 */
export async function convertLegacySettings(project: ZephyrProject): Promise<void> {
  let boardIdentifier = project.boardId;
  let config = new ZephyrProjectBuildConfiguration('primary');
  config.boardIdentifier = boardIdentifier;
  project.addBuildConfiguration(config);

  // Update settings.json
  await addConfig(project.workspaceFolder, config);
  // Remove board from settings
  await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, project.workspaceFolder).update(ZEPHYR_PROJECT_BOARD_SETTING_KEY, undefined, vscode.ConfigurationTarget.WorkspaceFolder);

  // Copy envs
  for(let key of Object.keys(project.envVars)) {
    config.envVars[key] = project.envVars[key];
    if(config.envVars[key].length > 0) {
      await saveConfigEnv(project.workspaceFolder, config.name, key, config.envVars[key]);
    }
    // Remove env settings
    await saveEnv(project.workspaceFolder, key, undefined);
  }

  // Copy args
  config.westArgs = project.westArgs;
  await saveConfigSetting(project.workspaceFolder, config.name, ZEPHYR_BUILD_CONFIG_WEST_ARGS_SETTING_KEY, config.westArgs);
  // Remove west-args settings
  await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, project.workspaceFolder).update(ZEPHYR_PROJECT_EXTRA_WEST_ARGS_SETTING_KEY, undefined);

  // Update tasks.json
  await convertLegacyTasks(project.workspaceFolder);
}

/**
 * For legacy compatibility:
 * Temporary convert method to upgrade legacy tasks.json
 * Code to remove when no legacy project exists anymore
 */
export async function convertLegacyTasks(workspaceFolder: vscode.WorkspaceFolder) {
  function msleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  const vscodeFolderPath = path.join(workspaceFolder.uri.fsPath, '.vscode');
  const tasksJsonPath = path.join(vscodeFolderPath, 'tasks.json');

  
  const data = await fsPromise.readFile(tasksJsonPath, 'utf8');
  const config: TaskConfig = JSON.parse(data);
  let needUpdate = false;
  const newTasks = config.tasks.map(task => {
    if(task.config === undefined) {
      if(task.type === ZephyrTaskProvider.ZephyrType) {
        task.config = "primary";
        task.args = task.args.filter(arg => (arg !== "--board ${config:zephyr-workbench.board}") &&
                                            (arg !== "--build-dir ${workspaceFolder}/build/${config:zephyr-workbench.board}"));
        task.args.push("--board ${config:zephyr-workbench.build.configurations.0.board}",);
        task.args.push("--build-dir ${workspaceFolder}/build/${config:zephyr-workbench.build.configurations.0.name}");
        needUpdate = true;
      }
    }
    return task;
  }); 

  if(needUpdate) {
    config.tasks = newTasks;
    await fsPromise.writeFile(tasksJsonPath, JSON.stringify(config, null, 2), 'utf8');
    // Sleep to let VS Code time to reload the tasks.json
    await msleep(500); 
  }
}