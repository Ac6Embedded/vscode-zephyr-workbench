import * as sevenBin from '7zip-bin';
import { FileDownloader, getApi } from "@microsoft/vscode-file-downloader-api";
import { ExecException, exec } from "child_process";
import * as fs from 'fs';
import * as node7zip from "node-7z";
import os from 'os';
import path from "path";
import * as sudo from 'sudo-prompt';
import * as vscode from "vscode";
import { ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY, ZEPHYR_WORKBENCH_OPENOCD_EXECPATH_SETTING_KEY, ZEPHYR_WORKBENCH_OPENOCD_SEARCH_DIR_SETTING_KEY, ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from './constants';
import { execShellCommand, execShellCommandWithEnv, expandEnvVariables, getShellArgs, getShellExe, classifyShell, normalizePathForShell } from "./execUtils";
import { fileExists, findDefaultEnvScriptPath, findDefaultOpenOCDPath, findDefaultOpenOCDScriptPath, getEnvScriptFilename, getInstallDirRealPath, getInternalDirRealPath, getInternalZephyrSDK } from "./utils";
import { getZephyrTerminal } from "./zephyrTerminalUtils";

export let output = vscode.window.createOutputChannel("Installing Host Tools");

export async function checkHostTools(): Promise<boolean> {
  let hostToolsPath = path.join(getInternalDirRealPath(), 'tools');

  try {
    const stats = await fs.promises.stat(hostToolsPath);
    return stats.isDirectory();
  } catch (error: unknown) {
    if (isNodeJsError(error) && error.code === 'ENOENT') {
      return false;
    } else {
      throw error;
    }
  }
}

export function removeHostTools() {
  let tmpPath = path.join(getInternalDirRealPath(), 'tmp');
  let hostToolsPath = path.join(getInternalDirRealPath(), 'tools');
  let venvPath = path.join(getInternalDirRealPath(), '.venv');

  if(fs.existsSync(tmpPath)) {
    fs.rmdirSync(tmpPath, { recursive: true });
  }
  if(fs.existsSync(hostToolsPath)) {
    fs.rmdirSync(hostToolsPath, { recursive: true });
  }
  if(fs.existsSync(venvPath)) {
    fs.rmdirSync(venvPath, { recursive: true });
  }
}

function isNodeJsError(error: unknown): error is NodeJS.ErrnoException {
  return (error as NodeJS.ErrnoException).code !== undefined;
}

export async function checkEnvFile(): Promise<boolean> {
  let envPath = path.join(getInternalDirRealPath(), getEnvScriptFilename());

  try {
    const stats = await fs.promises.stat(envPath);
    return stats.isFile();
  } catch (error: unknown) {
    if (isNodeJsError(error) && error.code === 'ENOENT') {
      return false;
    } else {
      throw error;
    }
  }
}

export async function autoSetHostToolsSettings(): Promise<void> {
  return new Promise(async (resolve) => {
    // Set default environment script
    let envPath = findDefaultEnvScriptPath();
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).update(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, envPath, vscode.ConfigurationTarget.Global);

    // Set default internal Zephyr SDK
    let sdk = await getInternalZephyrSDK();
    if(sdk) {
      let zephyrSDKPaths: string[] | undefined = await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY);
      if(!zephyrSDKPaths || zephyrSDKPaths.length === 0) {
        // If the setting is undefined
        let listSDKs: string[] = [];
        listSDKs.push(sdk.rootUri.fsPath);
        await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).update(ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY, listSDKs, vscode.ConfigurationTarget.Global);
      } else {
        // If the first entry is not the local internal sdk, push it first
        if(zephyrSDKPaths.length > 0) {
          if(zephyrSDKPaths.at(0) !== sdk.rootUri.fsPath) {
            zephyrSDKPaths.unshift(sdk.rootUri.fsPath);
          }
          await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).update(ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY, zephyrSDKPaths, vscode.ConfigurationTarget.Global);
        }
      }
    }
    resolve();
  });
}

export async function setDefaultSettings(): Promise<void> {
  return new Promise(async (resolve) => {
    // Set default environment script
    let envPathSetting = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, "");
    if(!(envPathSetting && envPathSetting.length > 0)) {
      let envPath = findDefaultEnvScriptPath();
      await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).update(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, envPath, vscode.ConfigurationTarget.Global);
    }

    // Set default internal Zephyr SDK
    let sdk = await getInternalZephyrSDK();
    if(sdk) {
      let zephyrSDKPaths: string[] | undefined = await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY);
      if(!zephyrSDKPaths || zephyrSDKPaths.length === 0) {
        // If the setting is undefined
        let listSDKs: string[] = [];
        listSDKs.push(sdk.rootUri.fsPath);
        await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).update(ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY, listSDKs, vscode.ConfigurationTarget.Global);
      } else {
        // If the first entry is not the local internal sdk, push it first
        if(zephyrSDKPaths.length > 0) {
          if(zephyrSDKPaths.at(0) !== sdk.rootUri.fsPath) {
            zephyrSDKPaths.unshift(sdk.rootUri.fsPath);
          }
          await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).update(ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY, zephyrSDKPaths, vscode.ConfigurationTarget.Global);
        }
      }
    }
    resolve();
  });
}

export async function setOpenOCDSettings(): Promise<void> {
  let openocdExecPath = findDefaultOpenOCDPath();
  let openocdScriptsPath = findDefaultOpenOCDScriptPath();

  if(openocdExecPath.length > 0) {
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).update(ZEPHYR_WORKBENCH_OPENOCD_EXECPATH_SETTING_KEY, openocdExecPath, vscode.ConfigurationTarget.Global);
  }

  if(openocdScriptsPath.length > 0) {
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).update(ZEPHYR_WORKBENCH_OPENOCD_SEARCH_DIR_SETTING_KEY, openocdScriptsPath, vscode.ConfigurationTarget.Global);
  }
}

/**
 * TODO: verify script checksum to avoid hack
 */
export async function verifyInstallScript(): Promise<void> {
  return;
}

/**
 * TODO: better progress tracking and support cancel token
 * @param context 
 */
export async function runInstallHostTools(context: vscode.ExtensionContext, 
                                          skipSdk: boolean, 
                                          listToolchains: string,
                                          progress: vscode.Progress<{
                                            message?: string | undefined;
                                            increment?: number | undefined;
                                          }>, 
                                          token: vscode.CancellationToken) {
  const activeTerminal = await getZephyrTerminal();
  activeTerminal.show();

  // To implement: token.onCancellationRequested()

  progress.report({ message: "Installing host tools into user directory" });
  if(await checkHostTools()) {
    progress.report({ message: "Host tools already installed", increment: 100 });
  } else {
    await installHostTools(context, skipSdk, listToolchains);
  }

  progress.report({ message: "Check if environment is well set up", increment: 80 });
  if(await checkHostTools()) {
    progress.report({ message: "Successfully Installing host tools", increment: 90 });
    if(await checkEnvFile()) {
      autoSetHostToolsSettings();
      vscode.window.showInformationMessage("Setup Zephyr environment successful");
      progress.report({ message: "Auto-detect environment file", increment: 100 });
    }

  } else {
    progress.report({ message: "Installing host tools has failed", increment: 100 });
  }
}

export async function forceInstallHostTools(context: vscode.ExtensionContext, 
                                            skipSdk: boolean, 
                                            listToolchains: string,
                                            progress: vscode.Progress<{
                                            message?: string | undefined;
                                            increment?: number | undefined;
                                          }>, 
                                          token: vscode.CancellationToken) {
  const activeTerminal = await getZephyrTerminal();
  activeTerminal.show();

  removeHostTools();
  progress.report({ message: "Reinstalling host tools into user directory" });
  await installHostTools(context, true, listToolchains);

  progress.report({ message: "Check if environment is well set up", increment: 80 });
  if(await checkHostTools()) {
    progress.report({ message: "Successfully Installing host tools", increment: 90 });
    if(await checkEnvFile()) {
      autoSetHostToolsSettings();
      vscode.window.showInformationMessage("Setup Zephyr environment successful");
      progress.report({ message: "Auto-detect environment file", increment: 100 });
    }

  } else {
    progress.report({ message: "Installing host tools has failed", increment: 100 });
  }
}

export async function getInstallHostToolsArgs(option: string, listSdks: string[]) {
  if(option === 'skip') {
    switch(process.platform) {
      case 'linux': 
      case 'darwin':
        return '--skip-sdk';
      case 'win32':
        return '-SkipSdk ';
    }
  } else if(option === 'all') {
    return '';
  } else {
    if(listSdks) {
      switch(process.platform) {
        case 'linux': 
        case 'darwin':
          return `--select-sdk="${listSdks.join(' ')}"`;
        case 'win32':
          return `-SelectSdk "${listSdks.join(' ')}"`;
      }
    }
  }
}

export async function installHostTools(context: vscode.ExtensionContext, skipSdk: boolean = false, listTools: string = "") {
  let installDirUri = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'hosttools');
  if(installDirUri) {
    let installScript: string = "";
    let installCmd: string = "";
    let installArgs: string = "";
    let destDir: string = "";
    let shell: string = "";

    destDir = getInstallDirRealPath();
    switch(process.platform) {
      case 'linux': {
        installScript = 'install.sh';
        installCmd = `bash ${vscode.Uri.joinPath(installDirUri, installScript).fsPath}`;
        if(skipSdk) {
          installArgs += ' --skip-sdk';
        } else if(listTools.length > 0) {
          installArgs += ` --select-sdk="${listTools}"`;
        }
        installArgs += ' --portable';
        installArgs += ` ${destDir}`;
        shell = 'bash';
        break; 
      }
      case 'win32': {
        installScript = 'install.ps1';
        installCmd = `powershell -ExecutionPolicy Bypass --% -File ${vscode.Uri.joinPath(installDirUri, installScript).fsPath}`;
        if(skipSdk) {
          installArgs += ' -SkipSdk ';
        } else if(listTools.length > 0) {
          installArgs += ` -SelectSdk "${listTools}"`;
        }
        installArgs += ' --Portable';
        installArgs += ` -InstallDir ${destDir}`;
        shell = 'powershell.exe';
        break; 
      }
      case 'darwin': {
        installScript = 'install-mac.sh';
        installCmd = `bash ${vscode.Uri.joinPath(installDirUri, installScript).fsPath}`;
        if(skipSdk) {
          installArgs += ' --skip-sdk';
        } else if(listTools.length > 0) {
          installArgs += ` --select-sdk="${listTools}"`;
        }
        installArgs += ' --portable';
        installArgs += ` ${destDir}`;
        shell = 'bash';
        break; 
      }
      default: {
        vscode.window.showErrorMessage("Platform not supported !");
        return;
      }
    }


    let shellOpts: vscode.ShellExecutionOptions = {
      cwd: os.homedir(),
      executable: shell,
      shellArgs: getShellArgs(shell),
    };
    
    if(process.platform === 'linux') {
      const options = {
        name: 'Zephyr Workbench Installer',
      };
      output.show();
      sudo.exec(`${installCmd} --only-root`, options, async (error, stdout, stderr) => {
        if (error) {
          output.append(`Error executing installer: ${error.message}`);
          vscode.window.showErrorMessage(`Error executing installer: ${error.message}`);
        } else {
          output.append(`${stdout}`);
          if (stderr) {
            output.append(`${stderr}`);
          }
        }
      });

      await execShellCommand('Installing Host tools', installCmd + " --only-without-root " + installArgs, shellOpts);
    } else {
      await execShellCommand('Installing Host tools', installCmd + " " + installArgs, shellOpts);
    }
  } else {
    vscode.window.showErrorMessage("Cannot find installation script");
  }
}

export async function installVenv(context: vscode.ExtensionContext) {
  let installDirUri = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'hosttools');
  if(installDirUri) {
    let installScript: string = "";
    let installCmd: string = "";
    let installArgs: string = "";
    let destDir: string = "";
    let shell: string = "";

    destDir = getInstallDirRealPath();
    switch(process.platform) {
      case 'linux': {
        installScript = 'install.sh';
        installCmd = `bash ${vscode.Uri.joinPath(installDirUri, installScript).fsPath}`;
        installArgs += ` ${destDir}`;
        shell = 'bash';
        break; 
      }
      case 'win32': {
        installScript = 'install.ps1';
        installCmd = `powershell -ExecutionPolicy Bypass -File ${vscode.Uri.joinPath(installDirUri, installScript).fsPath}`;
        installArgs += ` -InstallDir ${destDir}`;
        shell = 'powershell.exe';
        break; 
      }
      case 'darwin': {
        installScript = 'install-mac.sh';
        installCmd = `bash ${vscode.Uri.joinPath(installDirUri, installScript).fsPath}`;
        installArgs += ` ${destDir}`;
        shell = 'bash';
        break; 
      }
      default: {
        vscode.window.showErrorMessage("Platform not supported !");
        return;
      }
    }

    let shellOpts: vscode.ShellExecutionOptions = {
      cwd: os.homedir(),
      executable: shell,
      shellArgs: getShellArgs(shell),
    };
    
    if(process.platform === 'linux' || process.platform === 'darwin') {
      await execShellCommand('Installing Venv', installCmd + " --reinstall-venv " + installArgs, shellOpts);
    } else {
      await execShellCommand('Installing Venv', installCmd + " -ReinstallVenv " + installArgs, shellOpts);
    }
  } else {
    vscode.window.showErrorMessage("Cannot find installation script");
  }
}

export async function verifyHostTools(context: vscode.ExtensionContext) {
  let installDirUri = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'hosttools');
  if(installDirUri) {
    let installScript: string = "";
    let installCmd: string = "";
    let installArgs: string = "";
    let destDir: string = "";
    let shell: string = "";

    destDir = getInstallDirRealPath();
    switch(process.platform) {
      case 'linux': {
        installScript = 'install.sh';
        installCmd = `bash ${vscode.Uri.joinPath(installDirUri, installScript).fsPath}`;
        installArgs += `${destDir}`;
        shell = 'bash';
        break; 
      }
      case 'win32': {
        installScript = 'install.ps1';
        installCmd = `powershell -ExecutionPolicy Bypass -File ${vscode.Uri.joinPath(installDirUri, installScript).fsPath}`;
        installArgs += `-InstallDir ${destDir}`;
        shell = 'powershell.exe';
        break; 
      }
      case 'darwin': {
        installScript = 'install-mac.sh';
        installCmd = `bash ${vscode.Uri.joinPath(installDirUri, installScript).fsPath}`;
        installArgs += `${destDir}`;
        shell = 'bash';
        break; 
      }
      default: {
        vscode.window.showErrorMessage("Platform not supported !");
        return;
      }
    }

    let shellOpts: vscode.ShellExecutionOptions = {
      cwd: os.homedir(),
      executable: shell,
      shellArgs: getShellArgs(shell),
    };
    
    if(process.platform === 'linux' || process.platform === 'darwin') {
      await execShellCommandWithEnv('Installing Host tools', installCmd + " --only-check " + installArgs, shellOpts);
    } else {
      await execShellCommandWithEnv('Installing Host tools', installCmd + " -OnlyCheck " + installArgs, shellOpts);
    }
  } else {
    vscode.window.showErrorMessage("Cannot find installation script");
  }
}

export async function installHostDebugTools(context: vscode.ExtensionContext, listTools: any[]) {
  let scriptsDirUri = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'hosttools');
  if(scriptsDirUri) {
    let installScript: string = "";
    let installCmd: string = "";
    let installArgs: string = "";
    let destDir: string = "";
    let shell: string = "";

    destDir = getInstallDirRealPath();
    installArgs += ` -D ${destDir}`;

    switch(process.platform) {
      case 'linux': {
        installScript = 'install-debug-tools.sh';
        installCmd = `bash ${vscode.Uri.joinPath(scriptsDirUri, installScript).fsPath}`;
        shell = 'bash';
        break; 
      }
      case 'win32': {
        installScript = 'install-debug-tools.ps1';
        installCmd = `powershell -ExecutionPolicy Bypass -File ${vscode.Uri.joinPath(scriptsDirUri, installScript).fsPath}`;
        shell = 'powershell.exe';
        installArgs += ' -Tools ';
        break; 
      }
      case 'darwin': {
        installScript = 'install-debug-tools-mac.sh';
        installCmd = `bash ${vscode.Uri.joinPath(scriptsDirUri, installScript).fsPath}`;
        shell = 'bash';
        break; 
      }
      default: {
        vscode.window.showErrorMessage("Platform not supported !");
        return;
      }
    }

    let shellOpts: vscode.ShellExecutionOptions = {
      cwd: os.homedir(),
      executable: shell,
      shellArgs: getShellArgs(shell),
    };

    // Run install commands for every tools
    let toolsSeparator = ' ';
    if(process.platform === 'win32') {
      toolsSeparator = ',';
    }

    const toolsCmdArg = listTools.map(tool => tool.tool).join(toolsSeparator);
    const installCmdArgs = `${installArgs} ${toolsCmdArg}`;
    await execShellCommand('Installing Host debug tools', installCmd + " " + installCmdArgs, shellOpts);

  } else {
    vscode.window.showErrorMessage("Cannot find installation script");
  }
}

export async function createLocalVenv(context: vscode.ExtensionContext, workbenchFolder: vscode.WorkspaceFolder): Promise<string | undefined> {
  let installDirUri = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'hosttools');
  let envScript: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
  if(installDirUri && envScript) {
    let installScript: string = "";
    let installCmd: string = "";
    let installArgs: string = "";
    let destDir: string = "";
    let shell: string = "";
    
    destDir = workbenchFolder.uri.fsPath;
    switch(process.platform) {
      case 'linux': {
        installScript = 'create_venv.sh';
        installCmd = `bash ${vscode.Uri.joinPath(installDirUri, installScript).fsPath}`;
        installArgs += ` ${destDir}`;
        shell = 'bash';
        break; 
      }
      case 'win32': {
        installScript = 'create_venv.ps1';
        installCmd = `powershell -ExecutionPolicy Bypass -File ${vscode.Uri.joinPath(installDirUri, installScript).fsPath}`;
        installArgs += ` -InstallDir ${destDir}`;
        shell = 'powershell.exe';
        break; 
      }
      case 'darwin': {
        installScript = 'create_venv.sh';
        installCmd = `bash ${vscode.Uri.joinPath(installDirUri, installScript).fsPath}`;
        installArgs += ` ${destDir}`;
        shell = 'bash';
        break; 
      }
      default: {
        vscode.window.showErrorMessage("Platform not supported !");
        return undefined;
      }
    }

    envScript = expandEnvVariables(envScript);

    let shellOpts: vscode.ShellExecutionOptions = {
      cwd: os.homedir(),
      env: { ENV_FILE: envScript },
      executable: shell,
      shellArgs: getShellArgs(shell),
    };
    
    await execShellCommand('Creating local virtual environment', installCmd + installArgs, shellOpts);
    return findVenvActivateScript(destDir);

  } else {
    vscode.window.showErrorMessage("Cannot find installation script");
  }
  return undefined;
}

export function findVenvActivateScript(destDir: string): string | undefined {
  let venvPath;
  if(process.platform === 'linux' || process.platform === 'darwin') {
    venvPath = path.join(destDir, '.venv', 'bin', 'activate');
  } else {
    venvPath = path.join(destDir, '.venv', 'Scripts', 'activate.bat');
  }
  if(fileExists(venvPath)) {
    return venvPath;
  }
  return undefined;
}

export async function createLocalVenvSPDX(
  context: vscode.ExtensionContext,
  workbenchFolder: vscode.WorkspaceFolder
): Promise<string | undefined> {

  const installDirUri = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'hosttools');
  let   envScript     = vscode.workspace
                          .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
                          .get<string>(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);

  if (!envScript) {
    vscode.window.showErrorMessage('Cannot find installation script');
    return undefined;
  }

  /* ── detect the shell the user is *actually* running ─────────────────── */
  const shellExe  = getShellExe();          // full path to current shell
  const shellKind = classifyShell(shellExe);/* bash | zsh | fish | cmd.exe |
                                              * powershell.exe | dash */

  /* ── pick the right helper script and command line ───────────────────── */
  const destDir = workbenchFolder.uri.fsPath;
  let installScript: string;
  let installCmd   : string;
  let installArgs  = '';

  if (['bash', 'zsh', 'dash', 'fish'].includes(shellKind)) {
    installScript = 'create_venv_spdx.sh';
    const script   = normalizePathForShell(
      shellKind,
      vscode.Uri.joinPath(installDirUri, installScript).fsPath);
      const dest     = normalizePathForShell(shellKind, destDir);
      installCmd  = `bash ${script} ${dest}`;
  } else { // powershell.exe *or* cmd.exe fallback to PowerShell script
    installScript = 'create_venv_spdx.ps1';
    installCmd    = `powershell -ExecutionPolicy Bypass -File "${vscode.Uri.joinPath(installDirUri, installScript).fsPath}"`;
    installArgs   = ` -InstallDir "${destDir}"`;
  }

  /* ── run it via the detected shell, propagating the ENV_FILE variable ── */
  const shellOpts: vscode.ShellExecutionOptions = {
    cwd        : os.homedir(),
    env        : { ENV_FILE: expandEnvVariables(envScript) },
    executable : shellExe,
    shellArgs  : getShellArgs(shellKind)
  };

  if (!shellOpts.shellArgs?.length && ['bash','zsh','dash','fish'].includes(shellKind)) {
    shellOpts.shellArgs = ['-c'];
  }

  await execShellCommand(
    'Creating local virtual environment',
    installCmd + installArgs,
    shellOpts
  );

  return findVenvSPDXActivateScript(destDir, shellKind);
}

export function findVenvSPDXActivateScript(
  destDir   : string,
  shellKind?: string
): string | undefined {

  const kind = shellKind ?? classifyShell(getShellExe());
  const usesPosixLayout =
        ['bash', 'zsh', 'dash', 'fish'].includes(kind);

  const venvPath = usesPosixLayout
    ? path.join(destDir, '.venv-spdx', 'bin', 'activate')
    : path.join(destDir, '.venv-spdx', 'Scripts', 'activate.bat');

  return fileExists(venvPath) ? venvPath : undefined;
}

export async function cleanupDownloadDir(context: vscode.ExtensionContext) {
  const fileDownloader: FileDownloader = await getApi();
  await fileDownloader.deleteAllItems(context);
}

export async function download(url: string, destDir: string, context: vscode.ExtensionContext, progress: vscode.Progress<{
	message?: string | undefined;
	increment?: number | undefined;
}>, token: vscode.CancellationToken): Promise<vscode.Uri> {
  const fileDownloader: FileDownloader = await getApi();
  const fileName = path.basename(url);

  const progressCallback = (downloadedBytes: number, totalBytes: number | undefined) => {
    if(totalBytes) {
      const increment = (downloadedBytes / totalBytes) * 100;
      progress.report({
        message: `Downloading... ${Math.round(increment)}%`,
      });
    }
  };

  const destFileUri: vscode.Uri | undefined = await fileDownloader.tryGetItem(fileName, context);
  if(destFileUri) {
    const overwriteItem = 'Overwrite';
    const cancelItem = 'Use existing';
    const choice = await vscode.window.showInformationMessage(fileName + ' already exists, Do you want to download it again ?', overwriteItem, cancelItem);
    if(choice === cancelItem) {
      return destFileUri;
    }
  }
 
  const file: vscode.Uri = await fileDownloader.downloadFile(
    vscode.Uri.parse(url),
    fileName,
    context,
    token,
    progressCallback
  );

  return file;
}

export async function extractTar(filePath: string, destPath: string, progress: vscode.Progress<{
  message?: string | undefined;
  increment?: number | undefined;
}>, token: vscode.CancellationToken) {
  try {
    const cmd = `tar -xf "${filePath}" -C "${destPath}"`;
    progress.report({
      message: `Extracting...`
    });
    await execCommand(cmd);
    progress.report({
      message: `Extracting...`,
    });
  } catch (error) {
    throw new Error('Cannot extract archive');
  }
}

export async function extract7z(filePath: string, destPath: string, progress: vscode.Progress<{
  message?: string | undefined;
  increment?: number | undefined;
}>, token: vscode.CancellationToken): Promise<void> {
  return new Promise(async (resolve, reject) => {
    const pathTo7zip = sevenBin.path7za;
    const seven = node7zip.extractFull(filePath, destPath, {
      $bin: pathTo7zip,
      $progress: true,
      recursive: true
    });

    seven.on('progress', function (extractProgress) {
      progress.report({
        message: `Extracting... ${extractProgress.percent}%`,
        increment: 1
      });
    });

    seven.on('end', function () {
      resolve();
    });

    seven.on('error', function () {
      reject('Extract failed');
    });
  });
}

export async function getFirstDirectoryName7z(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const folderNames: Set<string> = new Set();
    const pathTo7zip = sevenBin.path7za;
    const stream = node7zip.list(filePath, {
      $bin: pathTo7zip,
      recursive: true
    });

    stream.on('data', (entry) => {
      const parts = entry.file.split(path.sep);
      if (parts.length === 1) {
        folderNames.add(parts[0]);
      }
    });
  
    stream.on('error', () => {
      reject();
    });

    stream.on('end', () => {
      const rootFolder = getFirstItemOfSet(folderNames) as string;
      resolve(rootFolder);
    });
  });
}

export function getFirstItemOfSet(set: Set<string>) {
  for(let item of set) {
    if(item) {
       return item;
    }   
  }
  return undefined;
}

export async function extract(filePath: string, destPath: string, progress: vscode.Progress<{
  message?: string | undefined;
  increment?: number | undefined;
}>, token: vscode.CancellationToken) {
  if(filePath.includes(".7z")) {
    await extract7z(filePath, destPath, progress, token);
  } else if(filePath.includes(".tar")) {
    await extractTar(filePath, destPath, progress, token);
  } else {
    return Promise.reject(new Error("Unsupported file format"));
  }
}

export async function runSetupScript(filePath: string) {
  let setupScript = '';
  let cmd = '';
  let shell = '';
  switch(process.platform) {
    case 'linux': {
      setupScript = 'setup.sh';
      cmd = `yes | ${path.join(filePath, setupScript)}`;
      shell = 'bash';
      break; 
    }
    case 'win32': {
      setupScript = 'setup.cmd';
      cmd = `${path.join(filePath, setupScript)} /c`;
      shell = 'powershell.exe';
      break; 
    }
    case 'darwin': {
      setupScript = 'setup.sh';
      cmd = `yes | ${path.join(filePath, setupScript)}`;
      shell = 'bash';
      break; 
    }
    default: {
      vscode.window.showErrorMessage("Platform not supported !");
      return;
    }
  }

  let shellOpts: vscode.ShellExecutionOptions = {
    cwd: filePath,
    executable: shell,
    shellArgs: getShellArgs(shell),
  };
  await execShellCommand('Setup SDK',cmd, shellOpts);
}

export function execCommand(command: string, options?: { cwd?: string }): Promise<string> {
	return new Promise((resolve, reject) => {
		exec(command, options, (error: ExecException | null, stdout: string | Buffer, stderr: string | Buffer) => {
			if (error) {
				reject(error);
				return;
			}
			if (stderr) {
				reject(new Error(stderr.toString()));
				return;
			}
			resolve(stdout.toString());
		});
	});
}

export async function checkHomebrew(): Promise<boolean> {
  const cmd = 'brew --version';
  return new Promise<boolean>((resolve, reject) => {
    exec(cmd, (error: any, stdout, stderr) => {
      if (error) {
        reject('Homebrew not installed in system');
      } else {
        resolve(true);
      }
    });
  });
}