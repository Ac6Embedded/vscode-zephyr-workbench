import * as sevenBin from '7zip-bin';
import * as fs from 'fs';
import { ExecException, exec, spawn } from "child_process";
import * as node7zip from "node-7z";
import os from 'os';
import path from "path";
import * as sudo from 'sudo-prompt';
import * as vscode from "vscode";
import yaml from 'yaml';
import { ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY, ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY } from '../constants';
import { buildEnvSourcedShellTask, buildShellTask, execShellCommand, execShellCommandCapturingExit, executeTaskCollectExitCode, getConfiguredWorkbenchPath, getShellArgs, getShellExe, execCommandWithEnv, killProcessTree, logShellCommand, resolveConfiguredPath, toPortableWorkspaceFolderPath } from "./execUtils";
import { quoteIfNeeded } from "./shellQuoting";
import { detectGuiSudoAvailability } from "./environmentUtils";
import { syncAutoDetectEnv } from "./debugTools/autoDetectSyncUtils";
import { fileExists, findDefaultEnvScriptPath, getEnvScriptFilename, getInstallDirRealPath, getInternalDirRealPath, getInternalZephyrSdkInstallation, getWestWorkspace } from "./utils";
import { getRunner } from "./debugTools/debugUtils";
import { getZephyrTerminal } from "./zephyr/zephyrTerminalUtils";
import { allowPowershellScriptsForCurrentUser, ensurePowershellExecutionPolicy, quotePathForPwshCommand } from "./powershellUtils";
import { setDebugToolAliasDefault } from './debugTools/debugToolEnvUtils';
import { getSelectablePartIds } from './hostToolsPartsRegistry';
import { probeHomebrew } from './hostToolsStatusUtils';
import { downloadFile } from './downloadUtils';

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
 * @param context
 * @param token cancellation token from the progress notification; cancelling it
 *              terminates the running installer process (see the launch paths in
 *              installHostTools) and reports a neutral "cancelled" outcome.
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
  return installHostToolsWithOutcome(context, listToolchains, progress, false, token, selectTools, pythonOpts);
}

export async function forceInstallHostTools(context: vscode.ExtensionContext,
                                            listToolchains: string,
                                            progress: vscode.Progress<{
                                            message?: string | undefined;
                                            increment?: number | undefined;
                                          }>,
                                          token: vscode.CancellationToken,
                                          pythonOpts?: HostToolsPythonOptions): Promise<boolean> {
  return installHostToolsWithOutcome(context, listToolchains, progress, true, token, undefined, pythonOpts);
}

async function installHostToolsWithOutcome(
  context: vscode.ExtensionContext,
  listToolchains: string,
  progress: vscode.Progress<{ message?: string | undefined; increment?: number | undefined }>,
  force: boolean,
  token: vscode.CancellationToken,
  selectTools?: string[],
  pythonOpts?: HostToolsPythonOptions
): Promise<boolean> {
  const activeTerminal = await getZephyrTerminal();
  activeTerminal.show();

  // A selection means "repair these parts": it never wipes the install like
  // force does, and it must bypass the already-installed short-circuit.
  const selection = sanitizeSelectedHostTools(selectTools);
  if (selectTools && selectTools.length > 0) {
    // Log the boundary decision: silently dropped parts are invisible in the
    // terminal command line and painful to diagnose without this.
    output.appendLine(`Selective host tools install requested: [${selectTools.join(', ')}] -> running: [${selection.join(', ')}]${pythonOpts ? ` (python options: ${JSON.stringify(pythonOpts)})` : ''}`);
    const dropped = selectTools.map(t => String(t ?? '').trim().toLowerCase()).filter(t => !selection.includes(t));
    if (dropped.length > 0) {
      output.appendLine(`WARN: unknown host tools part name(s) ignored: ${dropped.join(', ')}`);
    }
  }

  if (token.isCancellationRequested) {
    return reportHostToolsInstallCancelled(progress);
  }

  let result: HostToolsInstallResult = { ran: false };
  if (force) {
    removeHostTools();
    progress.report({ message: "Reinstalling host tools into user directory" });
    result = await installHostTools(context, listToolchains, undefined, pythonOpts, token);
  } else if (selection.length > 0) {
    progress.report({ message: "Installing selected host tools parts" });
    result = await installHostTools(context, listToolchains, selection, pythonOpts, token);
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
      result = await installHostTools(context, listToolchains, undefined, pythonOpts, token);
    }
  }

  // A cancel terminates the installer mid-run, so the process usually exits with
  // no code (result.cancelled) or the token is simply flagged. Report it as a
  // neutral outcome instead of letting reportHostToolsInstallOutcome surface the
  // aborted run as an installation failure.
  if (result.cancelled || token.isCancellationRequested) {
    return reportHostToolsInstallCancelled(progress);
  }

  progress.report({ message: "Check if environment is well set up", increment: 80 });
  return reportHostToolsInstallOutcome(context, result, progress, selection.length > 0);
}

/**
 * Neutral feedback for a user-initiated cancel: not a success, not an error.
 * Any parts that did install before the cancel are left in place.
 */
function reportHostToolsInstallCancelled(
  progress: vscode.Progress<{ message?: string | undefined; increment?: number | undefined }>
): boolean {
  progress.report({ message: "Host tools installation cancelled", increment: 100 });
  output.appendLine('Host tools installation cancelled by user.');
  vscode.window.showInformationMessage('Host tools installation cancelled.');
  return false;
}

/**
 * Single place the install result is turned into user feedback for both the
 * install and force-reinstall flows.
 *
 * The folder checks alone cannot detect a partial failure: the installer
 * creates the tools directory before installing anything, so checkHostTools()
 * is true after any run. The captured exit code is therefore the
 * authoritative signal on every platform (0 = no step failed, non-zero = at
 * least one step failed or a selected part was skipped; the script prints a
 * per-step summary in the terminal and keeps going on individual failures).
 * On linux the exit code aggregates the elevated and non-root invocations.
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

  if (result.ran && result.exitCode === undefined) {
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

/**
 * Run the non-root installer command and resolve with its exit code (never
 * rejects on a non-zero exit). Reporting is reportHostToolsInstallOutcome's
 * single job, so this only logs; a launch failure resolves as 1.
 */
async function runNonRootHostToolsCommand(
  command: string,
  shellOpts: vscode.ShellExecutionOptions,
  token?: vscode.CancellationToken
): Promise<number> {
  const executable = shellOpts.executable ?? getShellExe();
  const args = [...(shellOpts.shellArgs ?? []), command];
  const cwd = shellOpts.cwd ?? os.homedir();
  const env = { ...process.env, ...(shellOpts.env ?? {}) };

  output.appendLine('Starting non-root host tools installation...');

  return await new Promise<number>((resolve) => {
    // Spawn detached so the whole install.sh -> pip/cmake tree lands in its own
    // process group and can be killed as a unit on cancel (see killProcessTree).
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });

    let cancelled = false;
    let escalation: NodeJS.Timeout | undefined;
    const cancellation = token?.onCancellationRequested(() => {
      cancelled = true;
      output.appendLine('Cancelling non-root host tools installation...');
      killProcessTree(child, 'SIGTERM');
      // Escalate if part of the tree survives the polite signal.
      escalation = setTimeout(() => killProcessTree(child, 'SIGKILL'), 5000);
    });

    const cleanup = () => {
      if (escalation) {
        clearTimeout(escalation);
      }
      cancellation?.dispose();
    };

    child.stdout?.on('data', (data: Buffer) => {
      output.append(data.toString());
    });

    child.stderr?.on('data', (data: Buffer) => {
      output.append(data.toString());
    });

    child.on('error', (error) => {
      cleanup();
      output.appendLine(`Failed to launch non-root installer: ${error.message}`);
      resolve(1);
    });

    child.on('close', (code, signal) => {
      cleanup();
      if (cancelled) {
        output.appendLine('Non-root host tools installation cancelled.');
        resolve(code ?? 1);
      } else if (code === 0) {
        output.appendLine('Non-root host tools installation finished.');
        resolve(0);
      } else {
        const message = code !== null
          ? `Non-root host tools installation failed with exit code ${code}.`
          : `Non-root host tools installation was interrupted${signal ? ` (${signal})` : ''}.`;
        output.appendLine(message);
        resolve(code ?? 1);
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
 * Run `command` with root privileges and resolve with its exit code (never
 * rejects; 0 means success).
 *
 * Strategy:
 *  - Where a graphical sudo prompt can plausibly work (desktop Linux, macOS), try
 *    sudo-prompt first. If it fails (e.g. no polkit agent on the extension host), fall
 *    through to the terminal path transparently.
 *  - In WSL, remote, or headless Linux, skip straight to an interactive terminal running
 *    `sudo <command>`, where sudo prompts on stdin and all output is visible live.
 *
 * GUI success maps to 0; the terminal path returns the task's captured exit
 * code (a cancelled password prompt exits non-zero).
 */
async function runElevatedCommand(
  command: string,
  opts: { taskName: string; shellOpts: vscode.ShellExecutionOptions },
  token?: vscode.CancellationToken
): Promise<number> {
  await focusInstallerOutputChannel();
  const availability = detectGuiSudoAvailability();

  if (availability.available) {
    try {
      await runSudoPromptGui(command, opts.taskName);
      return 0;
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
  const exitCode = await execShellCommandCapturingExit(opts.taskName, `sudo ${command}`, opts.shellOpts, token);
  if (exitCode !== 0) {
    output.appendLine(`${opts.taskName} failed (exit code ${exitCode ?? 'unknown'}). See terminal/log for details.`);
  }
  return typeof exitCode === 'number' ? exitCode : 1;
}

/**
 * Elevate `command` via sudo-prompt's graphical password dialog. Captures stdout/stderr
 * into the output channel and rejects on error WITHOUT showing its own dialog, so that
 * runElevatedCommand can fall back to the terminal transparently.
 *
 * Cancellation limitation: sudo-prompt's `sudo.exec` exposes no PID or handle, so an
 * in-flight graphical elevation cannot be force-killed. Cancel is handled at the step
 * boundary instead (installHostTools skips the non-root step once the token trips).
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
  // Debug-tools callers still expect throw-on-failure semantics.
  const exitCode = await runElevatedCommand(command, { taskName: 'Installing root-required runners', shellOpts });
  if (exitCode !== 0) {
    throw new Error(`Installing root-required runners failed (exit code ${exitCode}). See terminal/log for details.`);
  }
}

/**
 * Result of launching the host-tools install script.
 * `ran` is false when the script was never started (unsupported platform,
 * blocked execution policy, missing script, Homebrew missing on darwin).
 * `exitCode` is populated on every platform whenever `ran` is true: the
 * installers never abort on a single failed step and exit 0 (no step failed)
 * or non-zero (at least one step failed or a selected part was skipped); the
 * per-step summary is printed in the terminal by the script itself. On linux
 * the value aggregates the two invocations (root exit when non-zero,
 * otherwise the non-root exit; a skipped root step counts as 0).
 */
export interface HostToolsInstallResult {
  ran: boolean;
  exitCode?: number;
  // True when a launch path was terminated by the cancellation token. The
  // outcome is then reported as a neutral cancel rather than a failure.
  cancelled?: boolean;
}

/**
 * Python and environment options for the host-tools installer: use the
 * PATH-detected system Python, a specific one, or (linux only) force the
 * portable AppImage python instead of the auto system-with-fallback default.
 * Precedence: useSystemPython > pythonExePath > usePortablePython. Optionally
 * the zephyr git ref (tag or branch) whose scripts/requirements*.txt are
 * installed into the global venv.
 */
export interface HostToolsPythonOptions {
  useSystemPython?: boolean;
  pythonExePath?: string;
  usePortablePython?: boolean;
  requirementsRef?: string;
}

/** Git refs are URL path segments here: restrict to safe characters. */
export function sanitizeRequirementsRef(ref?: string): string {
  const trimmed = String(ref ?? '').trim();
  if (trimmed.length > 0 && /^[A-Za-z0-9._/-]+$/.test(trimmed)) {
    return trimmed;
  }
  return '';
}

function sanitizeSelectedHostTools(selectTools?: string[]): string[] {
  if (!selectTools || selectTools.length === 0) {
    return [];
  }
  // Whitelist from the per-OS parts registry (single source shared with the
  // Advanced panel rows, so UI and command line cannot drift).
  const valid = new Set<string>(getSelectablePartIds(process.platform));
  return selectTools
    .map(t => String(t ?? '').trim().toLowerCase())
    .filter(t => valid.has(t));
}

/**
 * Selection/python/requirements arguments for the host-tools installer,
 * shared by every platform branch. `selected` must already be sanitized.
 * win32 emits -Tools/-UseSystemPython/-PythonExePath/-RequirementsRef;
 * linux/darwin emit the --tools/--use-system-python/--python-exe-path/
 * --portable-python/--requirements-ref equivalents. Returns '' or a string
 * starting with a space.
 */
export function buildHostToolsSelectionArgs(
  platform: NodeJS.Platform,
  selected: string[],
  pythonOpts?: HostToolsPythonOptions
): string {
  let args = '';
  if (platform === 'win32') {
    // Selective install: append -Tools a,b (whitelisted names only, no
    // spaces, so no quoting is needed after the --% verbatim token).
    if (selected.length > 0) {
      args += ` -Tools ${selected.join(',')}`;
    }
    // Python source: system PATH python or a specific one instead of
    // the portable download (quoted like -InstallDir).
    if (pythonOpts?.useSystemPython) {
      args += ' -UseSystemPython';
    } else if (pythonOpts?.pythonExePath && pythonOpts.pythonExePath.trim().length > 0) {
      args += ` -PythonExePath ${quotePathForPwshCommand(pythonOpts.pythonExePath.trim())}`;
    }
    // Zephyr ref providing the venv requirements (safe charset, no
    // spaces, so no quoting is needed after the --% verbatim token).
    const requirementsRef = sanitizeRequirementsRef(pythonOpts?.requirementsRef);
    if (requirementsRef.length > 0) {
      args += ` -RequirementsRef ${requirementsRef}`;
    }
    return args;
  }

  // linux/darwin: the command is one string handed to `bash -c`, so paths
  // must be double-quoted and shell metacharacters rejected.
  if (selected.length > 0) {
    args += ` --tools ${selected.join(',')}`;
  }
  if (pythonOpts?.useSystemPython) {
    args += ' --use-system-python';
  } else if (pythonOpts?.pythonExePath && pythonOpts.pythonExePath.trim().length > 0) {
    const p = pythonOpts.pythonExePath.trim();
    if (/["`$\\]/.test(p)) {
      output.appendLine(`WARN: custom python path ignored (characters not supported on the shell command line): ${p}`);
    } else {
      args += ` --python-exe-path "${p}"`;
    }
  } else if (platform === 'linux' && pythonOpts?.usePortablePython) {
    args += ' --portable-python';
  }
  const requirementsRef = sanitizeRequirementsRef(pythonOpts?.requirementsRef);
  if (requirementsRef.length > 0) {
    args += ` --requirements-ref ${requirementsRef}`;
  }
  return args;
}

export async function installHostTools(context: vscode.ExtensionContext, listTools: string = "", selectTools?: string[], pythonOpts?: HostToolsPythonOptions, token?: vscode.CancellationToken): Promise<HostToolsInstallResult> {
  let installDirUri = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'hosttools');
  if(installDirUri) {
    let installScript: string = "";
    let installCmd: string = "";
    let installArgs: string = "";
    let destDir: string = "";
    let shell: string = "";

    destDir = getInstallDirRealPath();
    const selected = sanitizeSelectedHostTools(selectTools);
    switch(process.platform) {
      case 'linux': {
        installScript = 'install.sh';
        installCmd = `bash ${vscode.Uri.joinPath(installDirUri, installScript).fsPath}`;
        installArgs += buildHostToolsSelectionArgs('linux', selected, pythonOpts);
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
        installArgs += buildHostToolsSelectionArgs('win32', selected, pythonOpts);
        shell = 'powershell.exe';
        // TODO: check if powershell 7 is installed and used by default then use pwsh.exe instead
        break;
      }
      case 'darwin': {
        // Refuse early (clear hint beats a run full of failed brew steps),
        // but only when the run actually needs Homebrew: a selective install
        // of just the venv with a system/custom python is explicitly
        // supported by install-mac.sh without brew.
        // (listTools is unused on darwin: the legacy --select-sdk flag was
        // never a valid install-mac.sh option and made the script exit 1.)
        const brewPython = !pythonOpts?.useSystemPython
          && !(pythonOpts?.pythonExePath && pythonOpts.pythonExePath.trim().length > 0);
        const brewNeeded = selected.length === 0
          || selected.some(t => t !== 'venv' && t !== 'python')
          || (selected.includes('python') && brewPython);
        if (brewNeeded) {
          const brew = await probeHomebrew();
          if (!brew.ok) {
            vscode.window.showErrorMessage('Homebrew is not installed or not in your PATH. Install it from https://brew.sh, then retry.');
            return { ran: false };
          }
        }
        installScript = 'install-mac.sh';
        installCmd = `bash ${vscode.Uri.joinPath(installDirUri, installScript).fsPath}`;
        installArgs += buildHostToolsSelectionArgs('darwin', selected, pythonOpts);
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

      // The elevated invocation only runs the `system` step, so it is skipped
      // entirely (no sudo prompt at all) when a selection leaves that row out.
      const runRoot = selected.length === 0 || selected.includes('system');
      if (runRoot) {
        // Root step: GUI prompt where possible, otherwise interactive terminal sudo.
        const rootExit = await runElevatedCommand(rootCommand, { taskName: 'Installing sudo host tools', shellOpts }, token);
        if (token?.isCancellationRequested) {
          return { ran: true, exitCode: rootExit, cancelled: true };
        }
        if (rootExit !== 0) {
          // A failed or cancelled root step still skips the non-root step
          // (previous semantics), but now flows through the standard outcome
          // reporting instead of a raw throw.
          return { ran: true, exitCode: rootExit };
        }
        // Brief pause so the root step's effects settle before the non-root step.
        await new Promise<void>(resolve => setTimeout(resolve, 2000));
      } else {
        output.appendLine('Selection does not include the System packages row: skipping the elevated step (no sudo prompt).');
      }

      // A cancel during (or right after) the root step must not start the
      // non-root step. The graphical sudo dialog cannot be force-killed, so this
      // guard is what keeps cancel responsive on that path.
      if (token?.isCancellationRequested) {
        return { ran: true, cancelled: true };
      }

      // Non-root step runs without sudo and already works in every environment.
      const nonRootExit = await runNonRootHostToolsCommand(nonRootCommand, shellOpts, token);
      return { ran: true, exitCode: nonRootExit, cancelled: token?.isCancellationRequested };
    } else {
      // Capture the exit code: the hardened installers never abort on a single
      // failed step; they exit non-zero when at least one step failed (or a
      // selected part was skipped) and print the per-step summary themselves.
      const exitCode = await execShellCommandCapturingExit('Installing Host tools', installCmd + " " + installArgs, shellOpts, token);
      return { ran: true, exitCode, cancelled: token?.isCancellationRequested };
    }
  } else {
    vscode.window.showErrorMessage("Cannot find installation script");
    return { ran: false };
  }
}

export async function installVenv(context: vscode.ExtensionContext, requirementsRef?: string) {
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
    
    // Optional zephyr ref for the venv requirements, honored on every OS.
    // The scripts refuse to delete the venv when they cannot rebuild it (no
    // working python) and exit 1: surface that instead of silently completing
    // the progress notification.
    const ref = sanitizeRequirementsRef(requirementsRef);
    if(process.platform === 'linux' || process.platform === 'darwin') {
      const refArg = ref.length > 0 ? ` --requirements-ref ${ref}` : '';
      const exitCode = await execShellCommandCapturingExit('Installing Venv', installCmd + " --reinstall-venv" + refArg + " " + installArgs, shellOpts);
      if (exitCode !== 0) {
        vscode.window.showErrorMessage('Reinstalling the virtual environment failed. See the terminal output for details.');
      }
    } else {
      const refArg = ref.length > 0 ? ` -RequirementsRef ${ref}` : '';
      const exitCode = await execShellCommandCapturingExit('Installing Venv', installCmd + " -ReinstallVenv" + refArg + " " + installArgs, shellOpts);
      if (exitCode !== 0) {
        vscode.window.showErrorMessage('Reinstalling the virtual environment failed. See the terminal output for details.');
      }
    }
  } else {
    vscode.window.showErrorMessage("Cannot find installation script");
  }
}

/**
 * How the paths of an install-debug-tools command are quoted, which depends
 * on what runs it:
 *  - 'shell-execution': a VS Code ShellExecution task, whose `powershell
 *    -Command` round trip strips plain quotes, so Windows paths carry escaped
 *    quotes (quotePathForPwshCommand) and POSIX paths stay bare, as before.
 *  - 'argv': a process spawned with the command as one argument (an agent's
 *    captured task, child_process.exec), where node escapes plain double
 *    quotes correctly and the escaped form would be double-escaped into garbage.
 */
export type DebugToolsCommandQuoting = 'shell-execution' | 'argv';

/**
 * The install-debug-tools command line for these tool ids, and the shell it
 * is written for; undefined on a platform the scripts do not support.
 */
export function buildDebugToolsInstallCommand(
  scriptsDir: string,
  toolIds: readonly string[],
  options: { platform?: NodeJS.Platform; destDir?: string; quoting?: DebugToolsCommandQuoting } = {},
): { command: string; shell: string } | undefined {
  const platform = options.platform ?? process.platform;
  const destDir = options.destDir ?? getInstallDirRealPath();
  const argv = options.quoting === 'argv';
  const posixPath = (value: string) => (argv ? quoteIfNeeded(value) : value);
  let installCmd: string;
  let installArgs: string;
  let shell: string;
  switch (platform) {
    case 'linux':
    case 'darwin': {
      const script = path.join(scriptsDir, platform === 'linux' ? 'install-debug-tools.sh' : 'install-debug-tools-mac.sh');
      installCmd = `bash ${posixPath(script)}`;
      installArgs = ` -D ${posixPath(destDir)}`;
      shell = 'bash';
      break;
    }
    case 'win32': {
      const quote = (value: string) => (argv ? `"${value}"` : quotePathForPwshCommand(value));
      installCmd = `powershell -File ${quote(path.join(scriptsDir, 'install-debug-tools.ps1'))}`;
      installArgs = ` -D ${quote(destDir)} -Tools `;
      shell = 'powershell.exe';
      break;
    }
    default:
      return undefined;
  }
  // Comma-separated on Windows (the script splits -Tools), space-separated elsewhere.
  const toolsArg = toolIds.join(platform === 'win32' ? ',' : ' ');
  return { command: `${installCmd} ${installArgs} ${toolsArg}`.trim(), shell };
}

/**
 * What installing debug tools runs. On Linux and macOS the tools that need
 * root go through an elevated command of their own, without the Zephyr
 * environment; everything else, and every tool on Windows (whose vendor
 * installers raise UAC themselves), runs in a shell that sources the Zephyr
 * environment so pip-based runners install into the managed venv.
 */
export interface HostDebugToolsInstallPlan {
  root?: { command: string; toolIds: string[]; shellOpts: vscode.ShellExecutionOptions };
  nonRoot?: {
    command: string;
    toolIds: string[];
    shellOpts: vscode.ShellExecutionOptions;
    /**
     * The shell the env-sourced task is forced to: PowerShell on Windows, so
     * a Git Bash or Cygwin default profile cannot mangle the backslash .ps1
     * and -D paths (the env script is swapped to env.ps1 to match).
     */
    executableOverride?: string;
  };
}

/** Plan an install of `toolIds`; undefined on a platform the scripts do not support. */
export function planHostDebugToolsInstall(
  scriptsDir: string,
  toolIds: readonly string[],
  rootToolIds: ReadonlySet<string>,
  options: { platform?: NodeJS.Platform; destDir?: string; quoting?: DebugToolsCommandQuoting } = {},
): HostDebugToolsInstallPlan | undefined {
  const platform = options.platform ?? process.platform;
  const command = (ids: readonly string[]) => buildDebugToolsInstallCommand(scriptsDir, ids, { ...options, platform });
  const probe = command(toolIds);
  if (!probe) {
    return undefined;
  }
  const shellOpts: vscode.ShellExecutionOptions = {
    cwd: os.homedir(),
    executable: probe.shell,
    shellArgs: getShellArgs(probe.shell),
  };
  const elevated = platform === 'linux' || platform === 'darwin';
  const rootIds = elevated ? toolIds.filter(id => rootToolIds.has(id)) : [];
  const otherIds = toolIds.filter(id => !rootIds.includes(id));
  return {
    ...(rootIds.length > 0 ? { root: { command: command(rootIds)!.command, toolIds: rootIds, shellOpts } } : {}),
    ...(otherIds.length > 0 ? {
      nonRoot: {
        command: command(otherIds)!.command,
        toolIds: otherIds,
        shellOpts,
        ...(platform === 'win32' ? { executableOverride: 'powershell.exe' } : {}),
      },
    } : {}),
  };
}

export async function installHostDebugTools(context: vscode.ExtensionContext, listTools: any[]): Promise<void> {
  const scriptsDir = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'runners').fsPath;
  if (process.platform !== 'linux' && process.platform !== 'win32' && process.platform !== 'darwin') {
    vscode.window.showErrorMessage("Platform not supported !");
    return;
  }
  if (process.platform === 'win32') {
    const ok = await ensurePowershellExecutionPolicy();
    if (!ok) { return; }
  }

  const { rootTools } = splitDebugToolsByPrivilege(context, listTools);
  const plan = planHostDebugToolsInstall(
    scriptsDir,
    listTools.map(tool => tool.tool),
    new Set(rootTools.map(tool => tool.tool)),
    { quoting: 'shell-execution' },
  );
  if (!plan) {
    return;
  }

  if (plan.root) {
    await runElevatedDebugToolsCommand(plan.root.command, plan.root.shellOpts);
  }
  if (plan.nonRoot) {
    const exitCode = await runDebugToolsInstallTask(plan.nonRoot);
    // The installer's exit code is read, so a failed install is reported
    // instead of looking like success.
    if (typeof exitCode === 'number' && exitCode !== 0) {
      throw new Error(`Installing the runners failed (exit code ${exitCode}). See the terminal for details.`);
    }
  }
}

/** The env-sourced task that installs the tools of a plan that need no root. */
export function buildDebugToolsInstallTask(nonRoot: NonNullable<HostDebugToolsInstallPlan['nonRoot']>): vscode.Task {
  return buildEnvSourcedShellTask('Installing Host debug tools', nonRoot.command, nonRoot.shellOpts, nonRoot.executableOverride);
}

async function runDebugToolsInstallTask(nonRoot: NonNullable<HostDebugToolsInstallPlan['nonRoot']>): Promise<number | undefined> {
  const task = buildDebugToolsInstallTask(nonRoot);
  logShellCommand('Installing Host debug tools', (task.execution as vscode.ShellExecution).commandLine ?? '', nonRoot.shellOpts.cwd);
  return executeTaskCollectExitCode(task);
}

/**
 * What follows an install of debug tools, in the Install Runners panel and
 * for an agent alike: each installed runner found in the internal tools
 * folder records its path, and the auto-detect entries of env.yml follow the
 * manifest. Never throws: the tools are installed by now.
 */
export async function refreshRunnersAfterInstall(context: vscode.ExtensionContext, toolIds: readonly string[]): Promise<void> {
  for (const toolId of toolIds) {
    try {
      const runner = getRunner(toolId);
      if (runner && runner.executable) {
        const runnerPath = path.join(getInternalDirRealPath(), 'tools', runner.name, runner.binDirPath, runner.executable);
        if (fileExists(runnerPath)) {
          runner.serverPath = runnerPath;
          await runner.updateSettings();
        }
      }
    } catch {
      // One runner that cannot be refreshed must not hide the others.
    }
  }
  await syncAutoDetectEnv(context);
}

/**
 * An install batch of the Install Runners panel. The runners are refreshed
 * whatever the outcome, as the agent install does: a pack that fails halfway
 * has installed the tools before the failing one. Then the panel is told the
 * batch ended, so it stops waiting and shows what is installed now.
 */
export async function runPanelDebugToolsInstall(
  context: vscode.ExtensionContext,
  listTools: { tool: string }[],
  post: (message: Record<string, string>) => unknown,
  deps = { install: installHostDebugTools, refresh: refreshRunnersAfterInstall, reportError: reportInstallError },
): Promise<void> {
  try {
    await deps.install(context, listTools);
  } catch (installError) {
    deps.reportError('Debug tools installation failed', installError);
  }
  try {
    await deps.refresh(context, listTools.map(tool => tool.tool));
  } catch {
    // The tools are installed by now; the next activation detects them.
  }
  for (const tool of listTools) {
    post({ command: 'exec-done', tool: `${tool.tool}` });
  }
  // The whole install batch has finished (single or pack).
  post({ command: 'exec-install-finished' });
}

/**
 * Run `command` as root through the graphical sudo prompt only, logging its
 * output through `log`, and resolve with its exit code (0 on success, 1 on
 * any failure, including a dismissed prompt). No terminal fallback and no
 * notification: for a caller nobody can type a password into, such as an
 * agent job, which checks detectGuiSudoAvailability before it starts.
 */
export function runElevatedCommandHeadless(command: string, taskName: string, log: (text: string) => void): Promise<number> {
  log(`${taskName} (graphical elevation). The root output appears once the step completes.\n`);
  return new Promise<number>(resolve => {
    sudo.exec(command, { name: 'Zephyr Workbench Installer' }, (error, stdout, stderr) => {
      for (const [header, content] of [['root stdout', stdout], ['root stderr', stderr]] as const) {
        const text = typeof content === 'undefined' ? '' : (typeof content === 'string' ? content : content.toString('utf8'));
        if (text.trim()) {
          log(`--- ${header} ---\n${text.trim()}\n`);
        }
      }
      if (error) {
        log(`${taskName} failed: ${error.message}\n`);
        resolve(1);
        return;
      }
      log(`${taskName} finished.\n`);
      resolve(0);
    });
  });
}

// Silent variant used for post-host-tools flow: hides terminal/logs and reports only final result.
export async function installHostDebugToolsSilent(context: vscode.ExtensionContext, listTools: any[]): Promise<void> {
  const scriptsDirUri = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'runners');
  if (!scriptsDirUri) {
    vscode.window.showErrorMessage("Cannot find installation script");
    return;
  }

  if (process.platform !== 'linux' && process.platform !== 'win32' && process.platform !== 'darwin') {
    vscode.window.showErrorMessage("Platform not supported !");
    return;
  }
  if (process.platform === 'win32') {
    const ok = await ensurePowershellExecutionPolicy();
    if (!ok) { return; }
  }

  // child_process.exec path (unlike installHostDebugTools' ShellExecution):
  // node escapes plain double quotes correctly here.
  const built = buildDebugToolsInstallCommand(scriptsDirUri.fsPath, listTools.map(tool => tool.tool), { quoting: 'argv' });
  if (!built) {
    return;
  }
  const fullCmd = built.command;

  // Run via child_process exec with env sourcing to avoid opening any terminal/log panel.
  // win32 forces PowerShell so a Git Bash/Cygwin default profile cannot mangle
  // the backslash .ps1/-D paths.
  await new Promise<void>((resolve, reject) => {
    execCommandWithEnv(fullCmd, undefined, (error) => {
      if (error) { reject(error); return; }
      resolve();
    }, process.platform === 'win32' ? 'powershell.exe' : undefined).catch(err => reject(err));
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

/**
 * Runs a venv setup for a caller other than the UI, such as an agent job.
 * Given one, createLocalVenv / createWorkspaceVenv run their tasks through
 * runTask, send their progress text to onOutput, show nothing, open no modal,
 * and throw a VenvSetupError instead of returning undefined.
 */
export interface VenvRunner {
  /** Runs the task to its end and resolves with its exit code, undefined when none was reported. */
  runTask(task: vscode.Task): Promise<number | undefined>;
  onOutput?(chunk: string): void;
  /**
   * Cancels the setup: the pip or west step running is killed and no later
   * step starts. runTask stops its own task on it.
   */
  signal?: AbortSignal;
  nonInteractive: true;
}

/**
 * Why a venv setup run with a VenvRunner failed: ENV_NOT_READY when the host
 * tools env script is not set, EXECUTION_POLICY when PowerShell may not run
 * the installer script, FAILED for everything else.
 */
export class VenvSetupError extends Error {
  constructor(
    readonly code: 'ENV_NOT_READY' | 'FAILED' | 'EXECUTION_POLICY',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'VenvSetupError';
  }
}

/** Where the venv setup steps report: the output channel for the UI, onOutput for a runner. */
interface VenvSetupLog {
  show(): void;
  append(text: string): void;
  appendLine(text: string): void;
}

function venvSetupLog(runner?: VenvRunner): VenvSetupLog {
  if (!runner) {
    return {
      show: () => output.show(true),
      append: text => output.append(text),
      appendLine: text => output.appendLine(text),
    };
  }
  const emit = (text: string) => {
    try { runner.onOutput?.(text); } catch { /* a display error must not fail the setup */ }
  };
  return { show: () => undefined, append: emit, appendLine: text => emit(`${text}\n`) };
}

/** A step failure as the runner's VenvSetupError, unchanged for the UI. */
function asVenvSetupFailure(error: unknown, runner?: VenvRunner): unknown {
  if (!runner || error instanceof VenvSetupError) {
    return error;
  }
  return new VenvSetupError('FAILED', error instanceof Error ? error.message : String(error), { cause: error });
}

const VENV_SETUP_CANCELLED = 'Cancelled.';

/** Stop before the next step once the runner's caller has cancelled the setup. */
function throwIfVenvSetupCancelled(runner?: VenvRunner): void {
  if (runner?.signal?.aborted) {
    throw new VenvSetupError('FAILED', VENV_SETUP_CANCELLED);
  }
}

interface CreateLocalManagedVenvOptions {
  venvDirName: string;
  westWorkspacePathOverride?: string;
  venvBasePathOverride?: string;
  extraPackages?: string[];
  // How to install Zephyr's own dependencies into the venv:
  //  - 'pip'  (default): let the installer run `pip install -r requirements.txt`.
  //  - 'west': skip requirements.txt in the installer and instead resolve
  //            module-aware deps with `west packages pip --install` afterwards.
  // The `tools.yml` base packages (west, pyelftools, ...) are always installed.
  zephyrDeps?: 'pip' | 'west';
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

export function getManagedVenvWestPath(venvDir: string): string {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'west.exe')
    : path.join(venvDir, 'bin', 'west');
}

// `west packages pip --install` (module-aware Python dependency resolution)
// exists from Zephyr ~3.6. Below that, fall back to Zephyr's requirements.txt.
// Threshold is approximate — the create flow also degrades to the requirements
// fallback if the `west packages` invocation fails on an unexpected version.
export function zephyrVersionSupportsWestPackages(versionArray: { [key: string]: string }): boolean {
  const major = parseInt(versionArray?.['VERSION_MAJOR'] ?? '', 10);
  const minor = parseInt(versionArray?.['VERSION_MINOR'] ?? '', 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return false;
  }
  return major > 3 || (major === 3 && minor >= 6);
}

function prependPathEntry(currentPath: string | undefined, entry: string): string {
  return currentPath && currentPath.length > 0
    ? `${entry}${path.delimiter}${currentPath}`
    : entry;
}

// Env for a process that should run "inside" a managed venv without sourcing the
// Zephyr env script: activate by setting VIRTUAL_ENV and putting the venv bin dir
// first on PATH. Extra keys (e.g. ZEPHYR_BASE) are merged last.
export function managedVenvProcessEnv(
  venvDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    VIRTUAL_ENV: venvDir,
    PATH: prependPathEntry(process.env.PATH, getManagedVenvBinPath(venvDir)),
    ...extraEnv,
  };
}

// Spawn a command, streaming stdout/stderr to the setup log (the output channel
// for the UI), and resolve on exit code 0 (reject otherwise). Shared by the
// pip/west venv-provisioning steps. A runner's signal kills the command with
// everything it started and rejects as soon as it has exited.
function runManagedVenvProcess(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  log: VenvSetupLog,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(VENV_SETUP_CANCELLED));
      return;
    }
    // With a signal the command gets its own process group, so a cancel
    // reaches the pip processes it starts too (see killProcessTree).
    const child = spawn(command, args, {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
      ...(signal ? { detached: process.platform !== 'win32' } : {}),
    });
    const onAbort = () => {
      killProcessTree(child, 'SIGTERM');
      // Escalate if part of the tree survives the polite signal.
      setTimeout(() => killProcessTree(child, 'SIGKILL'), 5000).unref();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const stopListening = () => signal?.removeEventListener('abort', onAbort);

    child.stdout?.on('data', (data: Buffer) => log.append(data.toString()));
    child.stderr?.on('data', (data: Buffer) => log.append(data.toString()));

    child.on('error', error => {
      stopListening();
      reject(error);
    });
    // Not 'close': a killed command's children may hold its output open.
    child.on('exit', () => {
      if (signal?.aborted) {
        stopListening();
        reject(new Error(VENV_SETUP_CANCELLED));
      }
    });
    child.on('close', (code) => {
      stopListening();
      if (signal?.aborted) {
        reject(new Error(VENV_SETUP_CANCELLED));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${path.basename(command)} exited with code ${code}`));
      }
    });
  });
}

async function installPythonPackagesInManagedVenv(
  venvDir: string,
  packages: string[],
  cwd: string,
  log: VenvSetupLog,
  signal?: AbortSignal,
): Promise<void> {
  if (packages.length === 0) {
    return;
  }

  const pythonPath = getManagedVenvPythonPath(venvDir);
  if (!fileExists(pythonPath)) {
    throw new Error(`Python executable not found in virtual environment: ${pythonPath}`);
  }

  log.show();
  log.appendLine(`Installing Python packages into ${venvDir}`);

  await runManagedVenvProcess(
    pythonPath,
    ['-m', 'pip', 'install', '--upgrade', 'pip', ...packages],
    cwd,
    managedVenvProcessEnv(venvDir),
    log,
    signal,
  );
  log.appendLine('Python package installation finished.');
}

// Legacy path: install Zephyr's own requirements.txt directly with pip. Used for
// older Zephyr and as a fallback when `west packages` is unavailable/fails.
async function installZephyrRequirementsInManagedVenv(
  venvDir: string,
  cwd: string,
  zephyrBase: string,
  log: VenvSetupLog,
  signal?: AbortSignal,
): Promise<void> {
  const requirementsFile = path.join(zephyrBase, 'scripts', 'requirements.txt');
  if (!fileExists(requirementsFile)) {
    log.appendLine(`Zephyr requirements not found at ${requirementsFile}; skipping.`);
    return;
  }

  const pythonPath = getManagedVenvPythonPath(venvDir);
  if (!fileExists(pythonPath)) {
    throw new Error(`Python executable not found in virtual environment: ${pythonPath}`);
  }

  log.show();
  log.appendLine(`Installing Zephyr requirements from ${requirementsFile}`);
  await runManagedVenvProcess(
    pythonPath,
    ['-m', 'pip', 'install', '-r', requirementsFile],
    cwd,
    managedVenvProcessEnv(venvDir),
    log,
    signal,
  );
}

// Modern path: resolve module-aware Python dependencies with `west packages`,
// run against the freshly created venv from the west topdir. Degrades to the
// requirements.txt fallback if west is missing or the command fails.
async function installZephyrDepsViaWestPackages(
  venvDir: string,
  topdir: string,
  zephyrBase: string,
  log: VenvSetupLog,
  signal?: AbortSignal,
): Promise<void> {
  const westPath = getManagedVenvWestPath(venvDir);
  if (!fileExists(westPath)) {
    log.appendLine(`west not found in ${venvDir}; installing Zephyr requirements directly.`);
    await installZephyrRequirementsInManagedVenv(venvDir, topdir, zephyrBase, log, signal);
    return;
  }

  log.show();
  log.appendLine(`Installing Zephyr module dependencies via 'west packages' into ${venvDir}`);
  try {
    await runManagedVenvProcess(
      westPath,
      ['packages', 'pip', '--install'],
      topdir,
      managedVenvProcessEnv(venvDir, { ZEPHYR_BASE: zephyrBase }),
      log,
      signal,
    );
  } catch (e) {
    if (signal?.aborted) {
      // Cancelled, not failed: the fallback must not start.
      throw e;
    }
    log.appendLine(`'west packages' failed (${e}); falling back to Zephyr requirements.txt`);
    await installZephyrRequirementsInManagedVenv(venvDir, topdir, zephyrBase, log, signal);
  }
}

/** Bounds each PowerShell policy call made for a VenvRunner, which has no one to wait for. */
const RUNNER_POWERSHELL_POLICY_TIMEOUT_MS = 30000;

async function createLocalManagedVenv(
  context: vscode.ExtensionContext,
  workbenchFolder: vscode.WorkspaceFolder,
  options: CreateLocalManagedVenvOptions,
  runner?: VenvRunner,
): Promise<string | undefined> {
  const log = venvSetupLog(runner);
  const installDirUri = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'hosttools');
  let envScript = getConfiguredWorkbenchPath(
    ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY,
    workbenchFolder,
  );

  if (!envScript) {
    if (runner) {
      throw new VenvSetupError('ENV_NOT_READY', 'The Zephyr environment script is not set. Install the host tools first.');
    }
    vscode.window.showErrorMessage("Cannot find installation script");
    return undefined;
  }

  const destDir = options.venvBasePathOverride ?? workbenchFolder.uri.fsPath;
  const venvDir = getManagedVenvPath(destDir, options.venvDirName);
  let installScript = '';
  let installCmd = '';
  let installArgs = '';
  let shell = '';

  // In 'west' mode the installer skips its `pip install -r requirements.txt` step;
  // module-aware deps are installed with `west packages` after venv creation. The
  // `tools.yml` base packages are always installed regardless of this flag.
  const zephyrDepsFlagPosix = options.zephyrDeps === 'west' ? ' --zephyr-deps west' : '';
  const zephyrDepsFlagWin = options.zephyrDeps === 'west' ? ' -ZephyrDeps west' : '';

  switch (process.platform) {
    case 'linux': {
      installScript = 'install.sh';
      const scriptPath = vscode.Uri.joinPath(installDirUri, installScript).fsPath;
      installCmd = `bash ${scriptPath}`;
      installArgs = ` --create-venv --venv-path "${venvDir}"${zephyrDepsFlagPosix} ${getInstallDirRealPath()}`;
      shell = 'bash';
      break;
    }
    case 'win32': {
      if (runner) {
        // The same silent policy fix the UI makes, without its modal warning.
        if (!await allowPowershellScriptsForCurrentUser(RUNNER_POWERSHELL_POLICY_TIMEOUT_MS)) {
          throw new VenvSetupError(
            'EXECUTION_POLICY',
            'PowerShell script execution is disabled for the current user, so the venv installer cannot run. Set the policy to RemoteSigned (Set-ExecutionPolicy -Scope CurrentUser RemoteSigned) and retry.',
          );
        }
      } else {
        const ok = await ensurePowershellExecutionPolicy();
        if (!ok) {
          return undefined;
        }
      }
      installScript = 'install.ps1';
      const scriptPath = vscode.Uri.joinPath(installDirUri, installScript).fsPath;
      installCmd = `powershell -File "${scriptPath}"`;
      installArgs = ` -CreateVenv -VenvPath "${venvDir}"${zephyrDepsFlagWin} "${getInstallDirRealPath()}"`;
      shell = 'powershell.exe';
      break;
    }
    case 'darwin': {
      installScript = 'install-mac.sh';
      const scriptPath = vscode.Uri.joinPath(installDirUri, installScript).fsPath;
      installCmd = `bash ${scriptPath}`;
      installArgs = ` --create-venv --venv-path "${venvDir}"${zephyrDepsFlagPosix} ${getInstallDirRealPath()}`;
      shell = 'bash';
      break;
    }
    default: {
      if (runner) {
        throw new VenvSetupError('FAILED', `Creating a virtual environment is not supported on ${process.platform}.`);
      }
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

  const taskName = 'Creating local virtual environment';
  if (runner) {
    let exitCode: number | undefined;
    try {
      const task = buildShellTask(taskName, installCmd + installArgs, shellOpts);
      log.appendLine(`[command] ${taskName}`);
      log.appendLine(installCmd + installArgs);
      exitCode = await runner.runTask(task);
    } catch (error) {
      throw asVenvSetupFailure(error, runner);
    }
    // A cancelled installer reports no exit code, and has usually created
    // the venv folder already: going on would install into it regardless.
    throwIfVenvSetupCancelled(runner);
    if (exitCode === undefined) {
      throw new VenvSetupError('FAILED', 'The virtual environment installer ended without an exit code.');
    }
    if (exitCode !== 0) {
      throw new VenvSetupError('FAILED', `The virtual environment installer exited with code ${exitCode}.`);
    }
  } else {
    await execShellCommand(taskName, installCmd + installArgs, shellOpts);
  }

  if (!fileExists(venvDir)) {
    if (runner) {
      throw new VenvSetupError('FAILED', `The installer did not create the virtual environment at ${venvDir}.`);
    }
    return undefined;
  }

  try {
    await installPythonPackagesInManagedVenv(
      venvDir,
      options.extraPackages ?? [],
      workbenchFolder.uri.fsPath,
      log,
      runner?.signal,
    );

    // Modern Zephyr: resolve module-aware deps with `west packages` from the topdir
    // (the installer skipped requirements.txt for this mode). Older Zephyr keeps the
    // installer's requirements.txt install and does not enter this branch.
    if (options.zephyrDeps === 'west') {
      throwIfVenvSetupCancelled(runner);
      const topdir = westWorkspacePath && fileExists(westWorkspacePath)
        ? westWorkspacePath
        : destDir;
      await installZephyrDepsViaWestPackages(venvDir, topdir, zephyrBase, log, runner?.signal);
    }
  } catch (error) {
    // Unchanged for the UI; a runner gets a VenvSetupError.
    throw asVenvSetupFailure(error, runner);
  }
  // Nothing may record a venv whose setup was cancelled.
  throwIfVenvSetupCancelled(runner);

  return toPortableWorkspaceFolderPath(venvDir, workbenchFolder);
}

/**
 * Create a `.venv` for an application (in its folder, or under
 * venvBasePathOverride). Returns a portable `${workspaceFolder}`-relative venv
 * path, or undefined on failure after telling the user. With a runner, see
 * VenvRunner: it throws a VenvSetupError instead and shows nothing.
 */
export async function createLocalVenv(
  context: vscode.ExtensionContext,
  workbenchFolder: vscode.WorkspaceFolder,
  westWorkspacePathOverride?: string,
  venvBasePathOverride?: string,
  runner?: VenvRunner,
): Promise<string | undefined> {
  return createLocalManagedVenv(context, workbenchFolder, {
    venvDirName: '.venv',
    westWorkspacePathOverride,
    venvBasePathOverride,
  }, runner);
}

/**
 * Create a `.venv` at the root of a west workspace (topdir), shared by every
 * application of that workspace. Installs the `tools.yml` base packages always,
 * then Zephyr's own dependencies via a version-gated choice: `west packages`
 * (module-aware) on modern Zephyr, otherwise `pip install -r requirements.txt`.
 * Must run after `west update` so the Zephyr tree / manifest is present.
 *
 * Returns a portable `${workspaceFolder}`-relative venv path to store in
 * `venv.path` at the workspace-folder scope, or undefined on failure. With a
 * runner, see VenvRunner: failures throw a VenvSetupError instead.
 */
export async function createWorkspaceVenv(
  context: vscode.ExtensionContext,
  westWorkspaceFolder: vscode.WorkspaceFolder,
  runner?: VenvRunner,
): Promise<string | undefined> {
  const topdir = westWorkspaceFolder.uri.fsPath;

  let useWestPackages = false;
  try {
    useWestPackages = zephyrVersionSupportsWestPackages(getWestWorkspace(topdir).versionArray);
  } catch {
    // Version not resolvable (e.g. VERSION file missing) -> conservative pip path.
  }

  return createLocalManagedVenv(context, westWorkspaceFolder, {
    venvDirName: '.venv',
    westWorkspacePathOverride: topdir,
    zephyrDeps: useWestPackages ? 'west' : 'pip',
  }, runner);
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

// Downloaded archives live under the extension's global storage until the caller
// has extracted them. The second folder is where the File Downloader extension,
// used before, kept them.
const DOWNLOAD_DIR_NAMES = ['downloads', 'file-downloader-downloads'];

export async function cleanupDownloadDir(context: vscode.ExtensionContext) {
  for (const dirName of DOWNLOAD_DIR_NAMES) {
    await fs.promises.rm(path.join(context.globalStorageUri.fsPath, dirName), { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Delete only the given downloaded files, not the whole download folder that
 * cleanupDownloadDir empties, so a run does not remove what another install
 * running at the same time still needs. A file already gone is fine; the
 * others are all tried before an error names the ones that could not be deleted.
 */
export async function cleanupDownloadFiles(files: string[]): Promise<void> {
  const failed: string[] = [];
  for (const file of files) {
    try {
      await fs.promises.rm(file, { force: true });
    } catch {
      failed.push(file);
    }
  }
  if (failed.length > 0) {
    throw new Error(`Could not delete the downloaded files: ${failed.join(', ')}`);
  }
}

/**
 * Lets a caller vet every URL before it is fetched and learn every file it
 * downloaded, such as an agent job that deletes only its own downloads.
 */
export interface DownloadHooks {
  /** Throws to refuse a URL before anything is fetched. */
  beforeDownload?(url: string): void;
  /** Called with the path of each downloaded file. */
  onDownloaded?(filePath: string): void;
}

export async function download(url: string, destDir: string, context: vscode.ExtensionContext, progress: vscode.Progress<{
	message?: string | undefined;
	increment?: number | undefined;
}>, token: vscode.CancellationToken, hooks?: DownloadHooks): Promise<vscode.Uri> {
  hooks?.beforeDownload?.(url);
  const fileName = path.basename(new URL(url).pathname);
  const filePath = path.join(context.globalStorageUri.fsPath, DOWNLOAD_DIR_NAMES[0], fileName);

  let lastMessage = '';
  const onProgress = (receivedBytes: number, totalBytes: number | undefined) => {
    const message = totalBytes
      ? `Downloading... ${Math.round((receivedBytes / totalBytes) * 100)}%`
      : `Downloading... ${Math.round(receivedBytes / (1024 * 1024))} MB`;
    // Report changes only, not every received chunk.
    if (message !== lastMessage) {
      lastMessage = message;
      progress.report({ message });
    }
  };

  // Always downloads a fresh copy: a previous one may be stale.
  await downloadFile(url, filePath, { token, onProgress });
  hooks?.onDownloaded?.(filePath);
  return vscode.Uri.file(filePath);
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
