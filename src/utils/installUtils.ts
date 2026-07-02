import * as sevenBin from '7zip-bin';
import { FileDownloader, getApi } from "@microsoft/vscode-file-downloader-api";
import * as fs from 'fs';
import { ExecException, exec, spawn } from "child_process";
import * as node7zip from "node-7z";
import os from 'os';
import path from "path";
import * as sudo from 'sudo-prompt';
import * as vscode from "vscode";
import yaml from 'yaml';
import { ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY, ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY } from '../constants';
import { execShellCommand, execShellCommandCapturingExit, execShellCommandWithEnv, getConfiguredWorkbenchPath, getShellArgs, getShellExe, execCommandWithEnv, resolveConfiguredPath, toPortableWorkspaceFolderPath } from "./execUtils";
import { detectGuiSudoAvailability } from "./environmentUtils";
import { syncAutoDetectEnv } from "./debugTools/autoDetectSyncUtils";
import { fileExists, findDefaultEnvScriptPath, getEnvScriptFilename, getInstallDirRealPath, getInternalDirRealPath, getInternalZephyrSdkInstallation, getWestWorkspace } from "./utils";
import { getRunner } from "./debugTools/debugUtils";
import { getZephyrTerminal } from "./zephyr/zephyrTerminalUtils";
import { ensurePowershellExecutionPolicy, quotePathForPwshCommand } from "./powershellUtils";
import { setDebugToolAliasDefault } from './debugTools/debugToolEnvUtils';

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

/**
 * Path of the stamp file the installer writes only when every install step
 * succeeded. Its absence next to an existing tools/ directory marks a partial
 * install that must be re-run.
 */
export function getZinstallerVersionStampPath(): string {
  return path.join(getInternalDirRealPath(), 'zinstaller_version');
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

  // Remove the completion stamp too: it is rewritten by a fully-successful
  // install, so a failed reinstall must not keep advertising the old install
  // as complete (the stamp gates the "already installed" short-circuit).
  try {
    const stampPath = getZinstallerVersionStampPath();
    if (fs.existsSync(stampPath)) {
      fs.unlinkSync(stampPath);
    }
  } catch (error) {
    failed.push({ path: getZinstallerVersionStampPath(), error });
  }

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
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).update(
      ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY,
      envPath,
      vscode.ConfigurationTarget.Global,
    );

    // Set default internal Zephyr SDK
    let sdk = await getInternalZephyrSdkInstallation();
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
      await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).update(
        ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY,
        envPath,
        vscode.ConfigurationTarget.Global,
      );
    }

    // Set default internal Zephyr SDK
    let sdk = await getInternalZephyrSdkInstallation();
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

/**
 * TODO: verify script checksum to avoid hack
 */
export async function verifyInstallScript(): Promise<void> {
  return;
}

/**
 * TODO: better progress tracking and support cancel token
 * @param context
 * @returns true when the host tools setup ended up fully usable (no failed
 *          install step and the environment file exists), false otherwise.
 */
export async function runInstallHostTools(context: vscode.ExtensionContext,
                                          listToolchains: string,
                                          progress: vscode.Progress<{
                                            message?: string | undefined;
                                            increment?: number | undefined;
                                          }>,
                                          token: vscode.CancellationToken,
                                          selectTools?: string[],
                                          pythonOpts?: HostToolsPythonOptions): Promise<boolean> {
  return installHostToolsWithOutcome(context, listToolchains, progress, false, selectTools, pythonOpts);
}

export async function forceInstallHostTools(context: vscode.ExtensionContext,
                                            listToolchains: string,
                                            progress: vscode.Progress<{
                                            message?: string | undefined;
                                            increment?: number | undefined;
                                          }>,
                                          token: vscode.CancellationToken,
                                          pythonOpts?: HostToolsPythonOptions): Promise<boolean> {
  return installHostToolsWithOutcome(context, listToolchains, progress, true, undefined, pythonOpts);
}

async function installHostToolsWithOutcome(
  context: vscode.ExtensionContext,
  listToolchains: string,
  progress: vscode.Progress<{ message?: string | undefined; increment?: number | undefined }>,
  force: boolean,
  selectTools?: string[],
  pythonOpts?: HostToolsPythonOptions
): Promise<boolean> {
  const activeTerminal = await getZephyrTerminal();
  activeTerminal.show();

  // To implement: token.onCancellationRequested()

  // A selection means "repair these parts": it never wipes the install like
  // force does, and it must bypass the already-installed short-circuit.
  const selection = sanitizeSelectedHostTools(selectTools);

  let result: HostToolsInstallResult = { ran: false };
  if (force) {
    removeHostTools();
    progress.report({ message: "Reinstalling host tools into user directory" });
    result = await installHostTools(context, listToolchains, undefined, pythonOpts);
  } else if (selection.length > 0) {
    progress.report({ message: "Installing selected host tools parts" });
    result = await installHostTools(context, listToolchains, selection, pythonOpts);
  } else {
    progress.report({ message: "Installing host tools into user directory" });
    // The tools directory alone is not proof of a completed install: the script
    // creates it before installing anything. The version stamp is written only
    // when every step succeeded, so "tools present but stamp missing" means a
    // partial install and the installer must run again. The env-file check heals
    // a manually removed env script the same way (the installer regenerates it).
    if (await checkHostTools() && await checkEnvFile() && fileExists(getZinstallerVersionStampPath())) {
      progress.report({ message: "Host tools already installed", increment: 100 });
    } else {
      result = await installHostTools(context, listToolchains, undefined, pythonOpts);
    }
  }

  progress.report({ message: "Check if environment is well set up", increment: 80 });
  return reportHostToolsInstallOutcome(context, result, progress, selection.length > 0);
}

/**
 * Single place the install result is turned into user feedback for both the
 * install and force-reinstall flows.
 *
 * The folder checks alone cannot detect a partial failure: the installer
 * creates the tools directory before installing anything, so checkHostTools()
 * is true after any run. On Windows the captured exit code is therefore the
 * authoritative signal (0 = no step failed, 1 = at least one step failed; the
 * script prints a per-step summary in the terminal and keeps going on
 * individual failures).
 */
async function reportHostToolsInstallOutcome(
  context: vscode.ExtensionContext,
  result: HostToolsInstallResult,
  progress: vscode.Progress<{ message?: string | undefined; increment?: number | undefined }>,
  selective: boolean = false
): Promise<boolean> {
  const toolsOk = await checkHostTools();
  const envOk = await checkEnvFile();

  // Keep whatever DID install usable, even when some steps failed.
  if (envOk) {
    autoSetHostToolsSettings();
    await syncAutoDetectEnv(context);
  }

  if (result.ran && typeof result.exitCode === 'number' && result.exitCode !== 0) {
    progress.report({ message: "Host tools installed with some failures", increment: 100 });
    vscode.window.showWarningMessage(
      "Zephyr host tools: some installation steps failed. See the terminal output for the per-step summary, " +
      "then re-run 'Install Host Tools' to retry the failed steps.");
    return false;
  }

  if (result.ran && result.exitCode === undefined && process.platform === 'win32') {
    // The task ended without an exit code: the installer process never started
    // or was killed before finishing. Do not report success on folder checks.
    progress.report({ message: "Installing host tools has failed", increment: 100 });
    reportInstallError('Host tools installation failed', new Error('The installer did not complete (no exit code); it may have been cancelled.'));
    return false;
  }

  if (!toolsOk) {
    progress.report({ message: "Installing host tools has failed", increment: 100 });
    reportInstallError('Host tools installation failed', new Error('Host tools not found after installation'));
    return false;
  }

  if (!envOk) {
    // Previously a silent dead zone: tools folder present but no env script.
    progress.report({ message: "Installing host tools has failed", increment: 100 });
    reportInstallError('Host tools installation incomplete', new Error('Environment file missing after installation. The installer likely stopped before generating it; re-run "Install Host Tools".'));
    return false;
  }

  progress.report({ message: "Successfully Installing host tools", increment: 90 });
  if (selective) {
    // A parts install can succeed without the whole tool set being present;
    // do not overclaim a fully set up environment.
    vscode.window.showInformationMessage("Selected host tools parts installed successfully");
  } else {
    vscode.window.showInformationMessage("Setup Zephyr environment successful");
  }
  // Host tools done; OpenOCD runner install handled separately with its own progress.
  progress.report({ message: "Auto-detect environment file", increment: 100 });
  return true;
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

function splitDebugToolsByPrivilege(context: vscode.ExtensionContext, listTools: any[]): { rootTools: any[]; nonRootTools: any[] } {
  try {
    const debugToolsYamlPath = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'runners', 'debug-tools.yml').fsPath;
    const data = yaml.parse(fs.readFileSync(debugToolsYamlPath, 'utf8')) || {};
    const debugTools = Array.isArray(data.debug_tools) ? data.debug_tools : [];
    const rootToolIds = new Set<string>(
      debugTools
        .filter((tool: any) => tool?.root === true && typeof tool?.tool === 'string')
        .map((tool: any) => tool.tool)
    );

    return {
      rootTools: listTools.filter(tool => rootToolIds.has(tool?.tool)),
      nonRootTools: listTools.filter(tool => !rootToolIds.has(tool?.tool)),
    };
  } catch {
    return {
      rootTools: [],
      nonRootTools: listTools,
    };
  }
}

/**
 * Single place install/elevation failures surface to the user: append the error to the
 * "Installing Host Tools" output channel, auto-reveal that channel, and show a dismissable
 * error notification with an "Open log" action. Replaces the previous silent catches and
 * the vanishing "...has failed" progress messages.
 */
export function reportInstallError(title: string, error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  output.appendLine(`ERROR: ${title}: ${msg}`);
  output.show(true);
  vscode.window.showErrorMessage(`${title}: ${msg}`, 'Open log').then(selection => {
    if (selection === 'Open log') {
      output.show();
    }
  });
}

/** Append a captured stdout/stderr block to the output channel, skipping empty content. */
function appendElevatedBlock(header: string, content?: string | Buffer): void {
  const text = typeof content === 'undefined'
    ? undefined
    : (typeof content === 'string' ? content : content.toString('utf8'));
  const trimmed = text?.trim();
  if (!trimmed) {
    return;
  }
  output.appendLine(`--- ${header} ---`);
  for (const line of trimmed.split(/\r?\n/)) {
    output.appendLine(line);
  }
}

/**
 * Run `command` with root privileges. Resolves on success and throws on failure (callers
 * report via reportInstallError).
 *
 * Strategy:
 *  - Where a graphical sudo prompt can plausibly work (desktop Linux, macOS), try
 *    sudo-prompt first. If it fails (e.g. no polkit agent on the extension host), fall
 *    through to the terminal path transparently.
 *  - In WSL, remote, or headless Linux, skip straight to an interactive terminal running
 *    `sudo <command>`, where sudo prompts on stdin and all output is visible live.
 *
 * The terminal path resolves only when the task process exits 0; a non-zero exit throws.
 */
async function runElevatedCommand(
  command: string,
  opts: { taskName: string; shellOpts: vscode.ShellExecutionOptions }
): Promise<void> {
  await focusInstallerOutputChannel();
  const availability = detectGuiSudoAvailability();

  if (availability.available) {
    try {
      await runSudoPromptGui(command, opts.taskName);
      return;
    } catch (guiError) {
      const msg = guiError instanceof Error ? guiError.message : String(guiError);
      output.appendLine(`Graphical sudo unavailable (${msg}); falling back to terminal sudo.`);
    }
  } else {
    const why = availability.reason === 'remote' ? 'remote/WSL session' : 'no graphical session';
    output.appendLine(`${opts.taskName}: ${why} detected; using terminal sudo.`);
  }

  // Interactive terminal fallback: sudo prompts for the password on the terminal's stdin.
  output.appendLine('You will be prompted for your sudo password in the integrated terminal.');
  vscode.window.showInformationMessage(`${opts.taskName}: enter your sudo password in the terminal.`);
  const exitCode = await execShellCommandCapturingExit(opts.taskName, `sudo ${command}`, opts.shellOpts);
  if (exitCode !== 0) {
    throw new Error(`${opts.taskName} failed (exit code ${exitCode ?? 'unknown'}). See terminal/log for details.`);
  }
}

/**
 * Elevate `command` via sudo-prompt's graphical password dialog. Captures stdout/stderr
 * into the output channel and rejects on error WITHOUT showing its own dialog, so that
 * runElevatedCommand can fall back to the terminal transparently.
 */
function runSudoPromptGui(command: string, taskName: string): Promise<void> {
  output.appendLine(`${taskName} (graphical elevation). This might take a while; root logs appear once the step completes.`);
  return new Promise<void>((resolve, reject) => {
    sudo.exec(command, { name: 'Zephyr Workbench Installer' }, (error, stdout, stderr) => {
      appendElevatedBlock('root stdout', stdout);
      appendElevatedBlock('root stderr', stderr);

      if (error) {
        reject(error);
        return;
      }

      output.appendLine(`${taskName} finished.`);
      resolve();
    });
  });
}

async function runElevatedDebugToolsCommand(
  command: string,
  shellOpts: vscode.ShellExecutionOptions
): Promise<void> {
  await runElevatedCommand(command, { taskName: 'Installing root-required runners', shellOpts });
}

/**
 * Result of launching the host-tools install script.
 * `ran` is false when the script was never started (unsupported platform,
 * blocked execution policy, missing script). `exitCode` is only populated on
 * win32, where the installer never aborts on a single failed step and exits
 * 0 (no step failed) or 1 (at least one step failed); the per-step summary is
 * printed in the terminal by the script itself.
 */
export interface HostToolsInstallResult {
  ran: boolean;
  exitCode?: number;
}

/**
 * Selectable host-tools parts, mirroring the selectable step names in
 * install.ps1. Used to whitelist -Tools values before they enter a shell
 * command line.
 */
export const HOST_TOOLS_SELECTABLE_PARTS = ['gperf', 'cmake', 'ninja', 'dtc', 'git', 'python', 'venv'] as const;

/**
 * Python source options for the host-tools installer: use the PATH-detected
 * system Python or a specific one instead of downloading the portable
 * WinPython. Mutually exclusive; useSystemPython wins when both are set.
 */
export interface HostToolsPythonOptions {
  useSystemPython?: boolean;
  pythonExePath?: string;
}

function sanitizeSelectedHostTools(selectTools?: string[]): string[] {
  if (!selectTools || selectTools.length === 0) {
    return [];
  }
  const valid = new Set<string>(HOST_TOOLS_SELECTABLE_PARTS);
  return selectTools
    .map(t => String(t ?? '').trim().toLowerCase())
    .filter(t => valid.has(t));
}

export async function installHostTools(context: vscode.ExtensionContext, listTools: string = "", selectTools?: string[], pythonOpts?: HostToolsPythonOptions): Promise<HostToolsInstallResult> {
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
          return { ran: false };
        }
        installScript = 'install.ps1';
        installCmd = `powershell --% -File ${quotePathForPwshCommand(vscode.Uri.joinPath(installDirUri, installScript).fsPath)}`;
        installArgs += ` -InstallDir ${quotePathForPwshCommand(destDir)}`;
        {
          // Selective install: append -Tools a,b (whitelisted names only, no
          // spaces, so no quoting is needed after the --% verbatim token).
          const selected = sanitizeSelectedHostTools(selectTools);
          if (selected.length > 0) {
            installArgs += ` -Tools ${selected.join(',')}`;
          }
          // Python source: system PATH python or a specific one instead of
          // the portable download (quoted like -InstallDir above).
          if (pythonOpts?.useSystemPython) {
            installArgs += ' -UseSystemPython';
          } else if (pythonOpts?.pythonExePath && pythonOpts.pythonExePath.trim().length > 0) {
            installArgs += ` -PythonExePath ${quotePathForPwshCommand(pythonOpts.pythonExePath.trim())}`;
          }
        }
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
        return { ran: false };
      }
    }


    let shellOpts: vscode.ShellExecutionOptions = {
      cwd: os.homedir(),
      executable: shell,
      shellArgs: getShellArgs(shell),
    };

    if(process.platform === 'linux') {
      const rootCommand = `${installCmd} --only-root${installArgs}`;
      const nonRootCommand = `${installCmd} --only-without-root${installArgs}`;

      // Root step: GUI prompt where possible, otherwise interactive terminal sudo.
      // Failures propagate so the caller reports them (no more silent catch).
      await runElevatedCommand(rootCommand, { taskName: 'Installing sudo host tools', shellOpts });

      // Brief pause so the root step's effects settle before the non-root step.
      await new Promise<void>(resolve => setTimeout(resolve, 2000));

      // Non-root step runs without sudo and already works in every environment.
      await runNonRootHostToolsCommand(nonRootCommand, shellOpts);
      return { ran: true };
    } else if (process.platform === 'win32') {
      // Capture the exit code: the hardened installer never aborts on a single
      // failed step; it exits 1 when at least one step failed and prints the
      // per-step summary in the terminal.
      const exitCode = await execShellCommandCapturingExit('Installing Host tools', installCmd + " " + installArgs, shellOpts);
      return { ran: true, exitCode };
    } else {
      await execShellCommand('Installing Host tools', installCmd + " " + installArgs, shellOpts);
      return { ran: true };
    }
  } else {
    vscode.window.showErrorMessage("Cannot find installation script");
    return { ran: false };
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
        installCmd = `powershell -File ${quotePathForPwshCommand(vscode.Uri.joinPath(installDirUri, installScript).fsPath)}`;
        installArgs += ` -InstallDir ${quotePathForPwshCommand(destDir)}`;
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
      // The script refuses to delete the venv when it cannot rebuild it
      // (network canary failed, no working python) and exits 1: surface that
      // instead of silently completing the progress notification.
      const exitCode = await execShellCommandCapturingExit('Installing Venv', installCmd + " -ReinstallVenv " + installArgs, shellOpts);
      if (exitCode !== 0) {
        vscode.window.showErrorMessage('Reinstalling the virtual environment failed. See the terminal output for details.');
      }
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
        installCmd = `powershell -File ${quotePathForPwshCommand(vscode.Uri.joinPath(installDirUri, installScript).fsPath)}`;
        installArgs += `-InstallDir ${quotePathForPwshCommand(destDir)}`;
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

    const buildInstallCommand = (tools: any[]) => {
      const toolsCmdArg = tools.map(tool => tool.tool).join(toolsSeparator);
      return `${installCmd} ${installArgs} ${toolsCmdArg}`.trim();
    };

    const { rootTools, nonRootTools } = splitDebugToolsByPrivilege(context, listTools);

    if ((process.platform === 'linux' || process.platform === 'darwin') && rootTools.length > 0) {
      await runElevatedDebugToolsCommand(buildInstallCommand(rootTools), shellOpts);

      if (nonRootTools.length > 0) {
        await execShellCommandWithEnv('Installing Host debug tools', buildInstallCommand(nonRootTools), shellOpts);
      }
      return;
    }

    // Run in a shell session that sources the configured env script
    // so pip-based runners install into the managed venv and PATH is consistent.
    await execShellCommandWithEnv('Installing Host debug tools', buildInstallCommand(listTools), shellOpts);

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

  destDir = getInstallDirRealPath();
  installArgs += ` -D ${destDir}`;

  switch(process.platform) {
    case 'linux': {
      installScript = 'install-debug-tools.sh';
      installCmd = `bash ${vscode.Uri.joinPath(scriptsDirUri, installScript).fsPath}`;
      break;
    }
    case 'win32': {
      const ok = await ensurePowershellExecutionPolicy();
      if (!ok) { return; }
      installScript = 'install-debug-tools.ps1';
      installCmd = `powershell -File ${vscode.Uri.joinPath(scriptsDirUri, installScript).fsPath}`;
      installArgs += ' -Tools ';
      break;
    }
    case 'darwin': {
      installScript = 'install-debug-tools-mac.sh';
      installCmd = `bash ${vscode.Uri.joinPath(scriptsDirUri, installScript).fsPath}`;
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
      const debugToolsPath = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'runners', 'debug-tools.yml').fsPath;
      const manifest = yaml.parse(fs.readFileSync(debugToolsPath, 'utf8'));
      setDebugToolAliasDefault({
        manifest,
        alias: 'openocd',
        toolId: 'openocd-zephyr',
        executableName: execName,
      });
      vscode.window.showInformationMessage('OpenOCD runner installation successful');
    } else {
      vscode.window.showErrorMessage('OpenOCD runner installation failed');
    }
  } catch {
    // On any unexpected error, show a failure popup (no logs)
    vscode.window.showErrorMessage('OpenOCD runner installation failed');
  }
}

const SPDX_VENV_EXTRA_PACKAGES = [
  'ntia-conformance-checker',
  'cve-bin-tool',
  'sbom2doc',
];

interface CreateLocalManagedVenvOptions {
  venvDirName: string;
  westWorkspacePathOverride?: string;
  venvBasePathOverride?: string;
  extraPackages?: string[];
}

function getManagedVenvPath(destDir: string, venvDirName: string): string {
  return path.join(destDir, venvDirName);
}

function getManagedVenvBinPath(venvDir: string): string {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts')
    : path.join(venvDir, 'bin');
}

function getManagedVenvPythonPath(venvDir: string): string {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python3');
}

function prependPathEntry(currentPath: string | undefined, entry: string): string {
  return currentPath && currentPath.length > 0
    ? `${entry}${path.delimiter}${currentPath}`
    : entry;
}

async function installPythonPackagesInManagedVenv(
  venvDir: string,
  packages: string[],
  cwd: string,
): Promise<void> {
  if (packages.length === 0) {
    return;
  }

  const pythonPath = getManagedVenvPythonPath(venvDir);
  if (!fileExists(pythonPath)) {
    throw new Error(`Python executable not found in virtual environment: ${pythonPath}`);
  }

  output.show(true);
  output.appendLine(`Installing Python packages into ${venvDir}`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      pythonPath,
      ['-m', 'pip', 'install', '--upgrade', 'pip', ...packages],
      {
        cwd,
        env: {
          ...process.env,
          VIRTUAL_ENV: venvDir,
          PATH: prependPathEntry(process.env.PATH, getManagedVenvBinPath(venvDir)),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    child.stdout?.on('data', (data: Buffer) => {
      output.append(data.toString());
    });

    child.stderr?.on('data', (data: Buffer) => {
      output.append(data.toString());
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        output.appendLine('Python package installation finished.');
        resolve();
      } else {
        reject(new Error(`pip install exited with code ${code}`));
      }
    });
  });
}

async function createLocalManagedVenv(
  context: vscode.ExtensionContext,
  workbenchFolder: vscode.WorkspaceFolder,
  options: CreateLocalManagedVenvOptions,
): Promise<string | undefined> {
  const installDirUri = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'hosttools');
  let envScript = getConfiguredWorkbenchPath(
    ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY,
    workbenchFolder,
  );

  if (!envScript) {
    vscode.window.showErrorMessage("Cannot find installation script");
    return undefined;
  }

  const destDir = options.venvBasePathOverride ?? workbenchFolder.uri.fsPath;
  const venvDir = getManagedVenvPath(destDir, options.venvDirName);
  let installScript = '';
  let installCmd = '';
  let installArgs = '';
  let shell = '';

  switch (process.platform) {
    case 'linux': {
      installScript = 'install.sh';
      const scriptPath = vscode.Uri.joinPath(installDirUri, installScript).fsPath;
      installCmd = `bash ${scriptPath}`;
      installArgs = ` --create-venv --venv-path "${venvDir}" ${getInstallDirRealPath()}`;
      shell = 'bash';
      break;
    }
    case 'win32': {
      const ok = await ensurePowershellExecutionPolicy();
      if (!ok) {
        return undefined;
      }
      installScript = 'install.ps1';
      const scriptPath = vscode.Uri.joinPath(installDirUri, installScript).fsPath;
      installCmd = `powershell -File "${scriptPath}"`;
      installArgs = ` -CreateVenv -VenvPath "${venvDir}" "${getInstallDirRealPath()}"`;
      shell = 'powershell.exe';
      break;
    }
    case 'darwin': {
      installScript = 'install-mac.sh';
      const scriptPath = vscode.Uri.joinPath(installDirUri, installScript).fsPath;
      installCmd = `bash ${scriptPath}`;
      installArgs = ` --create-venv --venv-path "${venvDir}" ${getInstallDirRealPath()}`;
      shell = 'bash';
      break;
    }
    default: {
      vscode.window.showErrorMessage("Platform not supported !");
      return undefined;
    }
  }

  const westWorkspacePath = options.westWorkspacePathOverride
    ? resolveConfiguredPath(options.westWorkspacePathOverride, workbenchFolder)
    : getConfiguredWorkbenchPath(ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY, workbenchFolder);
  let zephyrBase = path.join(destDir, 'zephyr');
  try {
    if (westWorkspacePath && fileExists(westWorkspacePath)) {
      zephyrBase = getWestWorkspace(westWorkspacePath).kernelUri.fsPath;
    }
  } catch {}

  const shellOpts: vscode.ShellExecutionOptions = {
    cwd: os.homedir(),
    env: { ENV_FILE: envScript, ZEPHYR_BASE: zephyrBase },
    executable: shell,
    shellArgs: getShellArgs(shell),
  };

  await execShellCommand('Creating local virtual environment', installCmd + installArgs, shellOpts);

  if (!fileExists(venvDir)) {
    return undefined;
  }

  await installPythonPackagesInManagedVenv(
    venvDir,
    options.extraPackages ?? [],
    workbenchFolder.uri.fsPath,
  );

  return toPortableWorkspaceFolderPath(venvDir, workbenchFolder);
}

export async function createLocalVenv(
  context: vscode.ExtensionContext,
  workbenchFolder: vscode.WorkspaceFolder,
  westWorkspacePathOverride?: string,
  venvBasePathOverride?: string
): Promise<string | undefined> {
  return createLocalManagedVenv(context, workbenchFolder, {
    venvDirName: '.venv',
    westWorkspacePathOverride,
    venvBasePathOverride,
  });
}

export async function createLocalVenvSPDX(
  context: vscode.ExtensionContext,
  workbenchFolder: vscode.WorkspaceFolder
): Promise<string | undefined> {
  return createLocalManagedVenv(context, workbenchFolder, {
    venvDirName: '.venv-spdx',
    extraPackages: SPDX_VENV_EXTRA_PACKAGES,
  });
}

export function findManagedVenvDirectory(
  destDir: string,
  venvDirName: string,
): string | undefined {
  const venvDir = getManagedVenvPath(destDir, venvDirName);
  return fileExists(venvDir) ? venvDir : undefined;
}

export function findManagedVenvExecutablePath(
  destDir: string,
  venvDirName: string,
  executableName: string,
): string | undefined {
  const venvDir = findManagedVenvDirectory(destDir, venvDirName);
  if (!venvDir) {
    return undefined;
  }

  const executablePath = path.join(
    getManagedVenvBinPath(venvDir),
    process.platform === 'win32' ? `${executableName}.exe` : executableName,
  );

  return fileExists(executablePath) ? executablePath : undefined;
}

export function findVenvSPDXDirectory(destDir: string): string | undefined {
  return findManagedVenvDirectory(destDir, '.venv-spdx');
}

export function findVenvSPDXExecutablePath(
  destDir: string,
  executableName: string,
): string | undefined {
  return findManagedVenvExecutablePath(destDir, '.venv-spdx', executableName);
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
  const parsedUrl = new URL(url);
  const fileName = path.basename(parsedUrl.pathname);

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
      const parts = entry.file.split(/[\\/]/).filter(Boolean);
      if (parts.length > 0) {
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
  if(filePath.includes(".7z") || filePath.includes(".zip")) {
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
