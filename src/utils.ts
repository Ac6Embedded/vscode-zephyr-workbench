import fs from 'fs';
import os from 'os';
import path from "path";
import * as vscode from "vscode";
import { WestWorkspace } from "./WestWorkspace";
import { ZephyrAppProject } from "./ZephyrAppProject";
import { ZephyrBoard } from "./ZephyrBoard";
import { ZephyrSDK } from "./ZephyrSDK";
import { ZephyrSample } from "./ZephyrSample";
import { getEnvVarFormat, getShell } from "./execUtils";
import { checkHostTools } from "./installUtils";
import { ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from './constants';

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


export async function getBoardFromId(boardId: string, westWorkspace: WestWorkspace): Promise<ZephyrBoard> {
  for(let board of await getSupportedBoards(westWorkspace)) {
    if(boardId === board.identifier) {
      return board;
    }
  }
  throw new Error(`No board named ${boardId} found`);
}

export function getBoard(boardYamlPath: string): ZephyrBoard {
  return new ZephyrBoard(vscode.Uri.file(boardYamlPath));
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

export async function findTask(taskLabel: string, workspaceFolder: vscode.WorkspaceFolder): Promise<vscode.Task | undefined> {
  const tasks = await vscode.tasks.fetchTasks();
  return tasks.find(task => task.name === taskLabel && task.scope === workspaceFolder);
}

export async function getSupportedBoards(westWorkspace: WestWorkspace): Promise<ZephyrBoard[]> {
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

