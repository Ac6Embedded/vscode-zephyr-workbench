import * as sevenBin from '7zip-bin';
import { FileDownloader, getApi } from "@microsoft/vscode-file-downloader-api";
import * as fs from 'fs';
import { ExecException, exec, spawn } from "child_process";
import * as node7zip from "node-7z";
import os from 'os';
import path from "path";
import * as sudo from 'sudo-prompt';
import * as vscode from "vscode";
import { ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY, ZEPHYR_WORKBENCH_OPENOCD_EXECPATH_SETTING_KEY, ZEPHYR_WORKBENCH_OPENOCD_SEARCH_DIR_SETTING_KEY, ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY } from '../constants';
import { execShellCommand, execShellCommandWithEnv, expandEnvVariables, getShellArgs, getShellExe, classifyShell, normalizePathForShell, execCommandWithEnv } from "./execUtils";
import { syncAutoDetectEnv } from "./autoDetectSyncUtils";
import { fileExists, findDefaultEnvScriptPath, findDefaultOpenOCDPath, findDefaultOpenOCDScriptPath, getEnvScriptFilename, getInstallDirRealPath, getInternalDirRealPath, getInternalZephyrSDK, getWestWorkspace } from "./utils";
import { getRunner } from "./debugUtils";
import { getZephyrTerminal } from "./zephyrTerminalUtils";
import { ensurePowershellExecutionPolicy } from "./powershellUtils";

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
  const tmpPath = path.join(getInternalDirRealPath(), 'tmp');
  const hostToolsPath = path.join(getInternalDirRealPath(), 'tools');
  const venvPath = path.join(getInternalDirRealPath(), '.venv');

  type Failed = { path: string; error: unknown };
  const failed: Failed[] = [];

  const tryRemoveDir = (dirPath: string) => {
    try {
      if (fs.existsSync(dirPath)) {
        fs.rmdirSync(dirPath, { recursive: true });
      }
    } catch (error) {
      failed.push({ path: dirPath, error });
    }
  };

  tryRemoveDir(tmpPath);
  tryRemoveDir(hostToolsPath);
  tryRemoveDir(venvPath);

  if (failed.length > 0) {
    try {
      output.appendLine("WARN: Cleanup encountered errors while removing previous host tools.");
      failed.forEach(f => {
        const err = f.error as NodeJS.ErrnoException;
        const code = err && (err as any).code ? (err as any).code : 'UNKNOWN';
        const msg = err && err.message ? err.message : String(err);
        output.appendLine(`  - ${f.path} -> ${code}: ${msg}`);
      });
    } catch { /* ignore logging failures */ }

    // Show a simple notification with an action to open the log
    try {
      vscode.window
        .showWarningMessage(
          'Cleanup encountered errors removing previous host tools. You might need to restart VSCode or your computer and try again.',
          'Open log'
        )
        .then(selection => {
          if (selection === 'Open log') {
            try { output.show(); } catch {}
          }
        });
    } catch { /* ignore UI failures */ }
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
    await installHostTools(context, listToolchains);
  }

  progress.report({ message: "Check if environment is well set up", increment: 80 });
  if(await checkHostTools()) {
    progress.report({ message: "Successfully Installing host tools", increment: 90 });
    if(await checkEnvFile()) {
      autoSetHostToolsSettings();
      await syncAutoDetectEnv(context);
      vscode.window.showInformationMessage("Setup Zephyr environment successful");
      // Host tools done; OpenOCD runner install handled separately with its own progress.
      progress.report({ message: "Auto-detect environment file", increment: 100 });
    }

  } else {
    progress.report({ message: "Installing host tools has failed", increment: 100 });
  }
}

export async function forceInstallHostTools(context: vscode.ExtensionContext, 
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
  await installHostTools(context, listToolchains);

  progress.report({ message: "Check if environment is well set up", increment: 80 });
  if(await checkHostTools()) {
    progress.report({ message: "Successfully Installing host tools", increment: 90 });
    if(await checkEnvFile()) {
      autoSetHostToolsSettings();
      await syncAutoDetectEnv(context);
      vscode.window.showInformationMessage("Setup Zephyr environment successful");
      // Host tools done; OpenOCD runner install handled separately with its own progress.
      progress.report({ message: "Auto-detect environment file", increment: 100 });
    }

  } else {
    progress.report({ message: "Installing host tools has failed", increment: 100 });
  }
}

async function runNonRootHostToolsCommand(
  command: string,
  shellOpts: vscode.ShellExecutionOptions
): Promise<void> {
  const executable = shellOpts.executable ?? getShellExe();
  const args = [...(shellOpts.shellArgs ?? []), command];
  const cwd = shellOpts.cwd ?? os.homedir();
  const env = { ...process.env, ...(shellOpts.env ?? {}) };

  output.appendLine('Starting non-root host tools installation...');

  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout?.on('data', (data: Buffer) => {
      output.append(data.toString());
    });

    child.stderr?.on('data', (data: Buffer) => {
      output.append(data.toString());
    });

    child.on('error', (error) => {
      const message = `Failed to launch non-root installer: ${error.message}`;
      output.appendLine(message);
      vscode.window.showErrorMessage(message, 'Open log').then(selection => {
        if (selection === 'Open log') {
          output.show();
        }
      });
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (code === 0) {
        output.appendLine('Non-root host tools installation finished.');
        resolve();
      } else {
        const message = code !== null
          ? `Non-root host tools installation failed with exit code ${code}.`
          : `Non-root host tools installation was interrupted${signal ? ` (${signal})` : ''}.`;
        output.appendLine(message);
        vscode.window.showErrorMessage(message, 'Open log').then(selection => {
          if (selection === 'Open log') {
            output.show();
          }
        });
        reject(new Error(message));
      }
    });
  });
}

async function focusInstallerOutputChannel(): Promise<void> {
  try {
    await vscode.commands.executeCommand('workbench.action.closePanel');
  } catch {
    // Panel may already be closed; ignore.
  }

  await new Promise<void>(resolve => setTimeout(resolve, 100));
  output.show(false);
  try {
    await vscode.commands.executeCommand('workbench.panel.output.focus');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    output.appendLine(`WARN: Unable to focus output panel automatically (${message}).`);
  }
}

export async function installHostTools(context: vscode.ExtensionContext, listTools: string = "") {
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
        // Ensure execution policy permits running our script
        const ok = await ensurePowershellExecutionPolicy();
        if (!ok) {
          const action = 'Install Host Tools';
          vscode.window.showInformationMessage('Please enable PowerShell script execution (RemoteSigned), then click Install Host Tools.', action)
            .then(async (sel) => {
              if (sel === action) {
                try { await vscode.commands.executeCommand('zephyr-workbench.install-host-tools.open-manager', false); } catch {}
              }
            });
          return;
        }
        installScript = 'install.ps1';
        installCmd = `powershell --% -File ${vscode.Uri.joinPath(installDirUri, installScript).fsPath}`;
        installArgs += ` -InstallDir ${destDir}`;
        shell = 'powershell.exe';
        // TODO: check if powershell 7 is installed and used by default then use pwsh.exe instead
        break; 
      }
      case 'darwin': {
        installScript = 'install-mac.sh';
        installCmd = `bash ${vscode.Uri.joinPath(installDirUri, installScript).fsPath}`;
        if(listTools.length > 0) {
          installArgs += ` --select-sdk="${listTools}"`;
        }
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
      const rootCommand = `${installCmd} --only-root${installArgs}`;
      const nonRootCommand = `${installCmd} --only-without-root${installArgs}`;

      await focusInstallerOutputChannel();
      output.appendLine('Installing sudo host tools... This might take a while. Root logs will appear once the step completes.');
      const toText = (content?: string | Buffer): string | undefined => {
        if (typeof content === 'undefined') {
          return undefined;
        }
        return typeof content === 'string' ? content : content.toString('utf8');
      };

      const appendBlock = (header: string, content?: string | Buffer) => {
        const text = toText(content);
        if (!text) {
          return;
        }
        const trimmed = text.trim();
        if (!trimmed) {
          return;
        }
        output.appendLine(`--- ${header} ---`);
        for (const line of trimmed.split(/\r?\n/)) {
          output.appendLine(line);
        }
      };

      const logOutputs = (stdout?: string | Buffer, stderr?: string | Buffer) => {
        appendBlock('root stdout', stdout);
        appendBlock('root stderr', stderr);
      };

      try {
        await new Promise<void>((resolve, reject) => {
          sudo.exec(rootCommand, options, (error, stdout, stderr) => {
            if (error) {
              output.appendLine(`Error executing installer: ${error.message}`);
              logOutputs(stdout, stderr);
              vscode.window.showErrorMessage(`Error executing installer: ${error.message}`, 'Open log').then(selection => {
                if (selection === 'Open log') {
                  output.show();
                }
              });
              reject(error);
              return;
            }

            logOutputs(stdout, stderr);
            output.appendLine('Root host tools step finished.');
            vscode.window.showInformationMessage('Host tools root step finished.', 'Open log').then(selection => {
              if (selection === 'Open log') {
                output.show();
              }
            });
            resolve();
          });
        });
      } catch {
        return;
      }

      await new Promise<void>(resolve => setTimeout(resolve, 2000));
      try {
        await runNonRootHostToolsCommand(nonRootCommand, shellOpts);
      } catch {
        return;
      }
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
        const ok = await ensurePowershellExecutionPolicy();
        if (!ok) { return; }
        installScript = 'install.ps1';
        installCmd = `powershell -File ${vscode.Uri.joinPath(installDirUri, installScript).fsPath}`;
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
        const ok = await ensurePowershellExecutionPolicy();
        if (!ok) { return; }
        installScript = 'install.ps1';
        installCmd = `powershell -File ${vscode.Uri.joinPath(installDirUri, installScript).fsPath}`;
        installArgs += `-InstallDir ${destDir}`;
        shell = 'powershell.exe';
        const pwshInstalled = await checkPwshInstalled();
        if (pwshInstalled) {
          return;
          //shell = 'pwsh.exe';
          //installCmd = `pwsh --% -File ${vscode.Uri.joinPath(installDirUri, installScript).fsPath}`;
        }
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
  let scriptsDirUri = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'runners');
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
        const ok = await ensurePowershellExecutionPolicy();
        if (!ok) { return; }
        installScript = 'install-debug-tools.ps1';
        installCmd = `powershell -File ${vscode.Uri.joinPath(scriptsDirUri, installScript).fsPath}`;
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
    // Run in a shell session that sources the configured env script
    // so pip-based runners install into the managed venv and PATH is consistent.
    await execShellCommandWithEnv('Installing Host debug tools', installCmd + " " + installCmdArgs, shellOpts);

  } else {
    vscode.window.showErrorMessage("Cannot find installation script");
  }
}

// Silent variant used for post-host-tools flow: hides terminal/logs and reports only final result.
export async function installHostDebugToolsSilent(context: vscode.ExtensionContext, listTools: any[]): Promise<void> {
  const scriptsDirUri = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'runners');
  if (!scriptsDirUri) {
    vscode.window.showErrorMessage("Cannot find installation script");
    return;
  }

  let installScript = '';
  let installCmd = '';
  let installArgs = '';
  let destDir = '';
  let shell = '';

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
      const ok = await ensurePowershellExecutionPolicy();
      if (!ok) { return; }
      installScript = 'install-debug-tools.ps1';
      installCmd = `powershell -File ${vscode.Uri.joinPath(scriptsDirUri, installScript).fsPath}`;
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

  // Build tools arg list (comma-separated on Windows, space-separated elsewhere)
  let toolsSeparator = ' ';
  if(process.platform === 'win32') {
    toolsSeparator = ',';
  }
  const toolsCmdArg = listTools.map(tool => tool.tool).join(toolsSeparator);
  const fullCmd = `${installCmd} ${installArgs} ${toolsCmdArg}`.trim();

  // Run via child_process exec with env sourcing to avoid opening any terminal/log panel
  await new Promise<void>((resolve, reject) => {
    execCommandWithEnv(fullCmd, undefined, (error) => {
      if (error) { reject(error); return; }
      resolve();
    }).catch(err => reject(err));
  });
}

// Install OpenOCD runner silently and show only a success/failure popup
export async function installOpenOcdRunnerSilently(context: vscode.ExtensionContext): Promise<void> {
  try {
    // Run the same installer that the Debug Tools panel uses, but silently
    await installHostDebugToolsSilent(context, [{ tool: 'openocd-zephyr' }]);

    // Verify installation by checking expected executable path
    const runner = getRunner('openocd');
    let execName = 'openocd';
    if (runner && runner.executable) { execName = runner.executable; }
    const exePath = path.join(getInternalDirRealPath(), 'tools', 'openocds', 'openocd-zephyr', 'bin', execName);

    if (fileExists(exePath)) {
      vscode.window.showInformationMessage('OpenOCD runner installation successful');
    } else {
      vscode.window.showErrorMessage('OpenOCD runner installation failed');
    }
  } catch {
    // On any unexpected error, show a failure popup (no logs)
    vscode.window.showErrorMessage('OpenOCD runner installation failed');
  }
}

export async function createLocalVenv(context: vscode.ExtensionContext, workbenchFolder: vscode.WorkspaceFolder): Promise<string | undefined> {
  // Prefer hosttools installer for Windows to create venv directly; legacy scripts on others
  let installDirUri = vscode.Uri.joinPath(
    context.extensionUri,
    'scripts',
    process.platform === 'win32' ? 'hosttools' : 'venv'
  );
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
        // Use hosttools installer with create-venv and explicit venv path
        installDirUri = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'hosttools');
        installScript = 'install.sh';
        const scriptPath = vscode.Uri.joinPath(installDirUri, installScript).fsPath;
        const venvPath   = path.join(destDir, '.venv');
        installCmd = `bash ${scriptPath}`;
        // Pass the install base dir (zinstaller parent) as the final arg
        installArgs = ` --create-venv --venv-path "${venvPath}" ${getInstallDirRealPath()}`;
        shell = 'bash';
        break; 
      }
      case 'win32': {
        const ok = await ensurePowershellExecutionPolicy();
        if (!ok) { return undefined; }
        // Use the hosttools installer with CreateVenv mode
        installScript = 'install.ps1';
        const scriptPath = vscode.Uri.joinPath(installDirUri, installScript).fsPath;
        const venvPath   = path.join(destDir, '.venv');
        installCmd = `powershell -File "${scriptPath}"`;
        // Provide the install base dir (zinstaller parent) as positional arg
        installArgs = ` -CreateVenv -VenvPath "${venvPath}" "${getInstallDirRealPath()}"`;
        shell = 'powershell.exe';
        break; 
      }
      case 'darwin': {
        // Use hosttools mac installer with create-venv and explicit venv path
        installDirUri = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'hosttools');
        installScript = 'install-mac.sh';
        const scriptPath = vscode.Uri.joinPath(installDirUri, installScript).fsPath;
        const venvPath   = path.join(destDir, '.venv');
        installCmd = `bash ${scriptPath}`;
        // Pass the install base dir (zinstaller parent) as the final arg
        installArgs = ` --create-venv --venv-path "${venvPath}" ${getInstallDirRealPath()}`;
        shell = 'bash';
        break; 
      }
      default: {
        vscode.window.showErrorMessage("Platform not supported !");
        return undefined;
      }
    }

    envScript = expandEnvVariables(envScript);

    // Add ZEPHYR_BASE so install scripts can use workspace's Zephyr tree
    const westWorkspacePath = vscode.workspace
      .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workbenchFolder)
      .get<string>(ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY, '');
    let zephyrBase = path.join(destDir, 'zephyr');
    try {
      if (westWorkspacePath && fileExists(westWorkspacePath)) {
        zephyrBase = getWestWorkspace(westWorkspacePath).kernelUri.fsPath;
      }
    } catch {}

    let shellOpts: vscode.ShellExecutionOptions = {
      cwd: os.homedir(),
      env: { ENV_FILE: envScript, ZEPHYR_BASE: zephyrBase },
      executable: shell,
      shellArgs: getShellArgs(shell),
    };
    
    await execShellCommand('Creating local virtual environment', installCmd + installArgs, shellOpts);
    const venvDir = path.join(destDir, '.venv');
    return fileExists(venvDir) ? venvDir : undefined;

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

  const shellExe  = getShellExe();
  const shellKind = classifyShell(shellExe);

  const destDir = workbenchFolder.uri.fsPath;
  const hostToolsPath = getInternalDirRealPath();
  const hostToolsDirEsc = hostToolsPath.replace(/\\/g, '\\\\');
  let installScript: string;
  let installCmd   : string;
  let installArgs  = '';

  if (['bash', 'zsh', 'dash', 'fish'].includes(shellKind)) {
    installScript = 'create_venv_spdx.sh';
    const script   = normalizePathForShell(
      shellKind,
      vscode.Uri.joinPath(installDirUri, installScript).fsPath);
      const dest     = normalizePathForShell(shellKind, destDir);
      const hostToolsPathNorm = normalizePathForShell(shellKind, hostToolsPath);
      installCmd  = `bash ${script} ${dest} ${hostToolsPathNorm}`;
  } else {
    if (process.platform === 'win32') {
      const ok = await ensurePowershellExecutionPolicy();
      if (!ok) { return undefined; }
    }
    installScript = 'create_venv_spdx.ps1';
    installCmd    = `powershell -File "${vscode.Uri.joinPath(installDirUri, installScript).fsPath}"`;
    installArgs   = ` -InstallDir "${destDir}" -HostToolsDir "${hostToolsDirEsc}"`;
  }

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
		exec(cmd, (error: ExecException | null, stdout: string | Buffer, stderr: string | Buffer) => {
      if (error) {
        reject('Homebrew not installed in system');
      } else {
        resolve(true);
      }
    });
  });
}

export async function checkPwshInstalled(): Promise<boolean> {
  const cmd = 'pwsh --version';
  return new Promise<boolean>((resolve, reject) => {
		exec(cmd, (error) => {
      if (!error) {
        console.log('PowerShell 7 is installed');
        resolve(true);
      } else {
        console.log('PowerShell 7 is NOT installed');
        resolve(false);
      }
    });
  });
}
