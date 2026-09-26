import { ChildProcess, exec, spawn, ExecOptions } from 'child_process';
import * as fs from 'fs';
import path from 'path';
import * as vscode from 'vscode';
import { WestWorkspace } from '../models/WestWorkspace';
import { prependRustBinPath } from '../models/ToolchainInstallations';
import { ZephyrApplication } from '../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../models/ZephyrBuildConfig';
import { ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY } from '../constants';
import { buildEnvSourcedShellTask, concatCommands, executeTask, executeTaskCollectExitCode, TaskLaunchDeclined, execShellCommandWithEnv, getConfiguredVenvPath, getConfiguredWorkbenchPath, getOutputChannel, getShellNullRedirect, getShellSourceCommand, getShellExe, classifyShell, getShellArgs, makeConfiguredVariableResolver, normalizePathForShell, execShellTaskWithEnvAndWait, isCygwin, killProcessTree, normalizeEnvVarsForShell, RawEnvVars, spawnCommandWithEnv } from '../utils/execUtils';
import { fileExists, getWestWorkspace, normalizePath, tryGetZephyrSdkInstallation } from '../utils/utils';
import { findSnippets, zephyrSearchesAppSnippets } from '../utils/zephyr/catalogFiles';
import { isUnknownWestCommand, isWestMissing } from '../utils/zephyr/westFailures';
import { composeWestBuildArgs, expandAndNormalizeWestArgs, hasWestBuildSourceDirArg } from '../utils/zephyr/westArgUtils';
import { ZEPHYR_LANG_RUST_PROJECT_NAME } from '../utils/zephyr/manifestUtils';
import { mergeOpenocdBuildFlag } from '../utils/debugTools/debugToolSelectionUtils';
import { BuildDirectTaskOptions, buildDirectTask, createCppPropertiesCompileCommandsRefresh } from '../providers/ZephyrTaskProvider';
import { quoteIfNeeded } from '../utils/shellQuoting';

/**
 * A workspace-level west command as execShellCommandWithEnv takes it. The
 * `west*Command` functions run their spec with execShellCommandWithEnv;
 * buildWestTask gives a caller that runs tasks its own way (an agent job, for
 * instance) exactly the same task.
 */
export interface WestCommandSpec {
  /** The task name, also the terminal title. */
  name: string;
  command: string;
  options: vscode.ShellExecutionOptions;
}

/** The env-sourced task execShellCommandWithEnv runs for `spec`. */
export function buildWestTask(spec: WestCommandSpec): vscode.Task {
  return buildEnvSourcedShellTask(spec.name, spec.command, spec.options);
}

function execWestSpec(spec: WestCommandSpec): Promise<void> {
  return execShellCommandWithEnv(spec.name, spec.command, spec.options);
}

/**
 * Where `west init -l` reads a local manifest file. If the manifest already
 * lives inside the workspace (e.g. the template flow wrote it under
 * <workspace>/manifest/ or <workspace>/<custom>/), it is used where it is.
 * An external file is used from a copy under the legacy <workspace>/manifest/
 * folder, named in `copyTo`.
 */
function westInitLocalManifestLocation(
  workspacePath: string,
  manifestPath: string,
): { manifestFile: string; manifestDir: string; copyTo?: string } {
  const manifestFile = path.basename(manifestPath);
  const absManifest = path.resolve(manifestPath);
  const absWorkspace = path.resolve(workspacePath);
  const insideWorkspace =
    absManifest === path.join(absWorkspace, manifestFile) ||
    absManifest.startsWith(absWorkspace + path.sep);

  if (insideWorkspace) {
    return { manifestFile, manifestDir: path.dirname(absManifest) };
  }
  const manifestDir = path.join(workspacePath, 'manifest');
  return { manifestFile, manifestDir, copyTo: path.join(manifestDir, manifestFile) };
}

/**
 * The file-system side of `west init` from a local manifest file outside the
 * workspace: copies it into <workspace>/manifest/, creating both folders,
 * unless a copy is already there. Does nothing for a remote init, a missing
 * manifest file, or a manifest already inside the workspace. Run it before
 * the westInitSpec task, as westInitCommand does.
 */
export function prepareWestInitManifest(srcUrl: string, workspacePath: string, manifestPath: string = ''): void {
  if (srcUrl || manifestPath === '' || !fileExists(manifestPath)) {
    return;
  }
  const { manifestDir, copyTo } = westInitLocalManifestLocation(workspacePath, manifestPath);
  if (!copyTo || copyTo === manifestPath) {
    return;
  }
  if (!fileExists(workspacePath)) {
    fs.mkdirSync(workspacePath);
  }
  if (!fileExists(manifestDir)) {
    fs.mkdirSync(manifestDir, { recursive: true });
  }
  if (!fileExists(copyTo)) {
    fs.cpSync(manifestPath, copyTo);
  }
}

/**
 * `west init` for a new workspace: from a manifest repository (srcUrl at
 * srcRev, with an optional manifest file name), or, when srcUrl is empty,
 * from a local manifest file. Writes nothing; see prepareWestInitManifest.
 * The command is empty when there is nothing to init from, which the task
 * builders reject with "Missing command to execute".
 */
export function westInitSpec(srcUrl: string, srcRev: string, workspacePath: string, manifestPath: string = ''): WestCommandSpec {
  let command = '';
  // If init remote repository
  if (srcUrl && srcUrl !== '') {
    workspacePath = normalizePath(workspacePath);
    workspacePath = normalizePathForShell(classifyShell(getShellExe()), workspacePath);
    command = `west init -m ${srcUrl} --mr ${srcRev} ${quoteIfNeeded(workspacePath)}`;
    if (manifestPath !== '') {
      manifestPath = normalizePath(manifestPath);
      manifestPath = normalizePathForShell(classifyShell(getShellExe()), manifestPath);
      command += ` --mf ${quoteIfNeeded(manifestPath)}`;
    }
  } else {
    if (manifestPath !== '' && fileExists(manifestPath)) {
      let { manifestFile, manifestDir } = westInitLocalManifestLocation(workspacePath, manifestPath);
      manifestFile = normalizePath(manifestFile);
      manifestFile = normalizePathForShell(classifyShell(getShellExe()), manifestFile);
      manifestDir = normalizePath(manifestDir);
      manifestDir = normalizePathForShell(classifyShell(getShellExe()), manifestDir);
      command = `west init -l --mf ${quoteIfNeeded(manifestFile)} ${quoteIfNeeded(manifestDir)}`;
    }
  }

  return {
    name: 'West Init for current workspace',
    command,
    options: {
      env: { ZEPHYR_PROJECT_DIRECTORY: workspacePath },
      cwd: "${userHome}"
    },
  };
}

export async function westInitCommand(srcUrl: string, srcRev: string, workspacePath: string, manifestPath: string = ''): Promise<void> {
  prepareWestInitManifest(srcUrl, workspacePath, manifestPath);
  await execWestSpec(westInitSpec(srcUrl, srcRev, workspacePath, manifestPath));
}

/**
 * Activate the optional zephyr-lang-rust module in a freshly initialized
 * workspace, so the following `west update` fetches it (placed under
 * modules/lang/rust). The module is declared in zephyr/submanifests/optional.yaml
 * with groups: [optional]; the project-filter overrides that inactivity. Manifests
 * importing zephyr through a name-allowlist must also list the project
 * (generateWestManifest handles this for template workspaces).
 */
export function westEnableRustModuleSpec(workspacePath: string): WestCommandSpec {
  return {
    name: 'West enable Rust module',
    command: `west config manifest.project-filter -- +${ZEPHYR_LANG_RUST_PROJECT_NAME}`,
    options: {
      env: { ZEPHYR_PROJECT_DIRECTORY: workspacePath },
      cwd: workspacePath,
    },
  };
}

export async function westEnableRustModuleCommand(workspacePath: string): Promise<void> {
  await execWestSpec(westEnableRustModuleSpec(workspacePath));
}

type NotificationProgress = vscode.Progress<{ message?: string; increment?: number }>;

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function projectNameFromPath(repoPath: string): string {
  const normalizedPath = repoPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const baseName = path.basename(normalizedPath);
  return baseName || normalizedPath || 'repository';
}

function createWestUpdateProgressReporter(progress: NotificationProgress) {
  let currentProject = '';
  let lastMessage = '';

  const reportMessage = (message: string) => {
    if (message !== lastMessage) {
      lastMessage = message;
      progress.report({ message });
    }
  };

  return (chunk: string) => {
    const lines = stripAnsi(chunk)
      .split(/\r|\n/)
      .map(line => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const projectMatch = line.match(/^={3}\s+updating\s+(.+?)(?:\s+\((.+?)\))?:?$/i);
      if (projectMatch) {
        currentProject = projectMatch[1].trim();
        reportMessage(`${currentProject}: updating`);
        continue;
      }

      const cloneMatch = line.match(/Cloning into (?:bare repository )?['"]?(.+?)['"]?(?:\.\.\.)?$/i);
      if (cloneMatch) {
        currentProject = projectNameFromPath(cloneMatch[1]);
        reportMessage(`${currentProject}: cloning`);
        continue;
      }

      const percentMatch = line.match(/\b(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files):\s+(\d+)%/i);
      if (percentMatch) {
        const phase = percentMatch[1];
        const percentage = percentMatch[2];
        reportMessage(`${currentProject ? `${currentProject}: ` : ''}${phase} ${percentage}%`);
        continue;
      }

      const westProjectStepMatch = line.match(/^-{3}\s+([^:]+):\s+(.+)$/);
      if (westProjectStepMatch) {
        currentProject = westProjectStepMatch[1].trim();
        reportMessage(`${currentProject}: ${westProjectStepMatch[2].trim()}`);
      }
    }
  };
}

function toTerminalText(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

function createWestUpdateTask(
  command: string,
  options: vscode.ShellExecutionOptions,
  progress: NotificationProgress,
): { task: vscode.Task; cancel: () => void; wasCancelled: () => boolean } {
  const output = getOutputChannel();
  output.appendLine(`[command] West Update for current workspace`);
  if (options.cwd) {
    output.appendLine(`[cwd] ${options.cwd}`);
  }
  output.appendLine(command);
  output.appendLine('');

  const reportWestOutput = createWestUpdateProgressReporter(progress);
  const writeEmitter = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<number>();
  let child: ReturnType<typeof spawnCommandWithEnv> | undefined;
  let closed = false;
  let cancelled = false;

  const closeTask = (code: number) => {
    if (closed) {
      return;
    }
    closed = true;
    closeEmitter.fire(code);
    writeEmitter.dispose();
    closeEmitter.dispose();
  };

  const cancel = () => {
    if (closed) {
      return;
    }
    cancelled = true;
    progress.report({ message: 'Cancelling west update...' });
    if (child && !child.killed) {
      child.kill();
      return;
    }
    closeTask(1);
  };

  const pty: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open: () => {
      writeEmitter.fire(toTerminalText(`[command] West Update for current workspace\n`));
      if (options.cwd) {
        writeEmitter.fire(toTerminalText(`[cwd] ${options.cwd}\n`));
      }
      writeEmitter.fire(toTerminalText(`${command}\n\n`));

      child = spawnCommandWithEnv(command, {
        cwd: options.cwd,
        env: {
          ...options.env,
          GIT_PROGRESS_DELAY: '0',
        },
      });

      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        output.append(text);
        writeEmitter.fire(toTerminalText(text));
        reportWestOutput(text);
      });

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        output.append(text);
        writeEmitter.fire(toTerminalText(text));
        reportWestOutput(text);
      });

      child.on('error', error => {
        const message = `${error}\n`;
        output.append(message);
        writeEmitter.fire(toTerminalText(message));
        closeTask(1);
      });

      child.on('close', code => {
        output.appendLine('');
        closeTask(code ?? (cancelled ? 1 : 0));
      });
    },
    close: cancel,
  };

  const task = new vscode.Task(
    { label: 'West Update for current workspace', type: 'zephyr-workbench-shell' },
    vscode.TaskScope.Workspace,
    'West Update for current workspace',
    'Zephyr Workbench',
    new vscode.CustomExecution(async () => pty),
  );
  task.presentationOptions.echo = true;
  task.presentationOptions.reveal = vscode.TaskRevealKind.Always;
  task.presentationOptions.panel = vscode.TaskPanelKind.Dedicated;

  return { task, cancel, wasCancelled: () => cancelled };
}

async function runWestUpdateWithProgress(
  command: string,
  options: vscode.ShellExecutionOptions,
  progress: NotificationProgress,
  cancellationToken?: vscode.CancellationToken,
): Promise<void> {
  const westUpdateTask = createWestUpdateTask(command, options, progress);
  if (cancellationToken?.isCancellationRequested) {
    throw new Error('West workspace import cancelled.', { cause: 'cancelled' });
  }

  const execution = await vscode.tasks.executeTask(westUpdateTask.task);
  await new Promise<void>((resolve, reject) => {
    const disposables: vscode.Disposable[] = [];
    const dispose = () => disposables.forEach(disposable => disposable.dispose());

    disposables.push(vscode.tasks.onDidEndTaskProcess(event => {
      if (event.execution !== execution) {
        return;
      }

      dispose();
      if (westUpdateTask.wasCancelled() || cancellationToken?.isCancellationRequested) {
        reject(new Error('West workspace import cancelled.', { cause: 'cancelled' }));
      } else if (event.exitCode === 0) {
        resolve();
      } else {
        reject(new Error(`west update failed with exit code ${event.exitCode ?? 'unknown'}`));
      }
    }));

    disposables.push(cancellationToken?.onCancellationRequested(() => {
      westUpdateTask.cancel();
      execution.terminate();
    }) ?? new vscode.Disposable(() => undefined));
  });
}

/**
 * `west update` as a plain task, the way westUpdateCommand runs it without a
 * progress notification. With one, westUpdateCommand runs the same options
 * through its own progress-reporting task instead.
 */
export function westUpdateSpec(workspacePath: string): WestCommandSpec {
  return {
    name: 'West Update for current workspace',
    command: "west update",
    options: {
      env: { ZEPHYR_PROJECT_DIRECTORY: workspacePath },
      cwd: `${workspacePath}`
    },
  };
}

export async function westUpdateCommand(workspacePath: string, progress?: NotificationProgress, cancellationToken?: vscode.CancellationToken): Promise<void> {
  const spec = westUpdateSpec(workspacePath);

  if (progress) {
    await runWestUpdateWithProgress("west update --fetch-opt=--progress", spec.options, progress, cancellationToken);
    return;
  }

  await execWestSpec(spec);
}

export function westPackagesInstallSpec(workspacePath: string): WestCommandSpec {
  return {
    name: "West - install Python dependencies for current workspace",
    command: "west packages pip --install",
    options: {
      env: { ZEPHYR_PROJECT_DIRECTORY: workspacePath },
      cwd: workspacePath
    },
  };
}

export async function westPackagesInstallCommand(workspacePath: string): Promise<void> {
  await execWestSpec(westPackagesInstallSpec(workspacePath));
}

// Fetch binary blobs declared by the workspace's modules (`west blobs fetch`).
// On Zephyr >= 4.2 pass `--auto-accept` so a blob with a click-through license
// can't hang this non-interactive task waiting on stdin; on 3.2-4.1 the flag
// doesn't exist and fetch never prompts, so it must be omitted (see
// WestWorkspace.supportsBlobsAutoAccept). Caller must gate on supportsBlobs.
// `modules` limits the fetch to those modules; the caller checks each name
// against the workspace's blob list, because they go onto the command line.
export function westBlobsFetchSpec(workspacePath: string, autoAccept: boolean, modules: string[] = []): WestCommandSpec {
  const command = autoAccept ? "west blobs fetch --auto-accept" : "west blobs fetch";
  return {
    name: "West - fetch binary blobs",
    command: modules.length > 0 ? `${command} ${modules.join(' ')}` : command,
    options: {
      env: { ZEPHYR_PROJECT_DIRECTORY: workspacePath },
      cwd: workspacePath
    },
  };
}

export async function westBlobsFetchCommand(workspacePath: string, autoAccept: boolean): Promise<void> {
  await execWestSpec(westBlobsFetchSpec(workspacePath, autoAccept));
}

// Delete fetched binary blobs from the workspace (`west blobs clean`).
export function westBlobsCleanSpec(workspacePath: string): WestCommandSpec {
  return {
    name: "West - clean binary blobs",
    command: "west blobs clean",
    options: {
      env: { ZEPHYR_PROJECT_DIRECTORY: workspacePath },
      cwd: workspacePath
    },
  };
}

export async function westBlobsCleanCommand(workspacePath: string): Promise<void> {
  await execWestSpec(westBlobsCleanSpec(workspacePath));
}

// List binary blobs (`west blobs list`) and print the table into the shared
// output channel. Uses the stdout-capturing runner (like getSupportedShields)
// rather than a task terminal so the result stays readable in one place.
export function westBlobsListCommand(westWorkspace: WestWorkspace): void {
  const output = getOutputChannel();
  output.appendLine(`[west blobs list] ${westWorkspace.name}`);
  output.show(true);
  execWestCommandWithEnv('west blobs list', westWorkspace, (error, stdout, stderr) => {
    const text = (error ? (stderr || String(error)) : stdout).trimEnd();
    if (text.length > 0) {
      output.appendLine(text);
    } else if (!error) {
      output.appendLine('No binary blobs declared for this workspace.');
    }
  });
}

export function westBoardsSpec(workspacePath: string): WestCommandSpec {
  const shellKind = classifyShell(getShellExe());
  const redirect = getShellNullRedirect(shellKind);

  return {
    name: 'West Boards for current workspace',
    command: `west boards ${redirect}`,
    options: {
      env: { ZEPHYR_PROJECT_DIRECTORY: workspacePath },
      cwd: workspacePath,
      executable: getShellExe(),
    },
  };
}

export async function westBoardsCommand(workspacePath: string): Promise<void> {
  await execWestSpec(westBoardsSpec(workspacePath));
}

export async function westTmpBuildCmakeOnlyCommand(
  zephyrProject : ZephyrApplication,
  westWorkspace : WestWorkspace,
  buildConfig?  : ZephyrBuildConfig
): Promise<string | undefined> {
  // Build into a disposable .tmp tree so discovery can inspect generated
  // CMake metadata without mutating the user's main build directory.
  if (!buildConfig?.boardIdentifier || !zephyrProject.appRootPath) {
    return undefined;
  }

  const activeZephyrSdkInstallation = tryGetZephyrSdkInstallation(zephyrProject.zephyrSdkPath);

  const shellKind = classifyShell(getShellExe());

  const tmpPath = normalizePathForShell(shellKind, path.join(zephyrProject.appRootPath, '.tmp'));

  const westArgs = makeWestArgs(zephyrProject, buildConfig.westArgs, buildConfig.westFlagsD);
  const sourceDirArg = hasWestBuildSourceDirArg(westArgs)
    ? ''
    : `--source-dir ${quoteIfNeeded(normalizePathForShell(shellKind, zephyrProject.appRootPath))}`;

  const rawEnvVars = buildConfig.envVars as RawEnvVars;
  const normEnvVars = normalizeEnvVarsForShell(rawEnvVars, shellKind);

  const redirect = getShellNullRedirect(shellKind);

  const command  = [
    'west build',
    '-t boards',
    '--cmake-only',
    `--board ${buildConfig.boardIdentifier}`,
    `--build-dir ${quoteIfNeeded(tmpPath)}`,
    sourceDirArg,
    westArgs,
    redirect,
  ].filter(Boolean).join(' ');

  const options: vscode.ShellExecutionOptions = {
    cwd        : zephyrProject.appRootPath,
    env        : prependRustBinPath({
      ...normEnvVars,
      ...(activeZephyrSdkInstallation?.buildEnv ?? {}),
      ...westWorkspace.buildEnv,
      ...zephyrProject.getToolchainEnv(),
    }, zephyrProject.selectedRustToolchainInstallation?.binPath),
    executable : getShellExe(),
    shellArgs  : getShellArgs(classifyShell(getShellExe()))
  };

  await execShellTaskWithEnvAndWait(
    'West tmp build cmake-only command',
    command,
    options,
    true
  );

  return tmpPath;
}

export async function westBuildCommand(
  zephyrProject: ZephyrApplication,
  westWorkspace: WestWorkspace,
  extraWestArgs = '',
  configName?: string,
): Promise<number | undefined> {
  const refreshCppProperties = zephyrProject.intellisenseProvider === 'clangd'
    ? async () => {}
    : await createCppPropertiesCompileCommandsRefresh(zephyrProject.appWorkspaceFolder);
  try {
    return await runWestBuildCommand(zephyrProject, westWorkspace, {
      configName,
      extraWestArgs,
      pristine: 'never',
    });
  } finally {
    await refreshCppProperties();
  }
}

export async function westRebuildCommand(
  zephyrProject: ZephyrApplication,
  westWorkspace: WestWorkspace,
  configName?: string,
): Promise<void> {
  const refreshCppProperties = zephyrProject.intellisenseProvider === 'clangd'
    ? async () => {}
    : await createCppPropertiesCompileCommandsRefresh(zephyrProject.appWorkspaceFolder);
  try {
    await runWestBuildCommand(zephyrProject, westWorkspace, {
      configName,
      pristine: 'always',
    });
  } finally {
    await refreshCppProperties();
  }
}

interface WestBuildRunOptions {
  configName?: string;
  extraWestArgs?: string;
  pristine: 'never' | 'always';
}

async function runWestBuildCommand(
  zephyrProject: ZephyrApplication,
  _westWorkspace: WestWorkspace,
  runOptions: WestBuildRunOptions,
): Promise<number | undefined> {
  const buildConfig = resolveBuildConfig(zephyrProject, runOptions.configName);
  if (!buildConfig?.boardIdentifier || !zephyrProject.appRootPath) {
    return;
  }

  const taskName = runOptions.pristine === 'always' ? 'West Rebuild' : 'West Build';
  const task = buildDirectTask(
    zephyrProject.appWorkspaceFolder,
    taskName,
    buildConfig.name,
    { rawWestArgsOverride: runOptions.extraWestArgs },
    zephyrProject,
  );
  if (!task) {
    return;
  }

  return await executeTaskCollectExitCode(task);
}

function resolveBuildConfig(
  zephyrProject: ZephyrApplication,
  configName?: string,
): ZephyrBuildConfig | undefined {
  if (configName) {
    return zephyrProject.buildConfigs.find(cfg => cfg.name === configName);
  }
  return zephyrProject.buildConfigs.find(cfg => cfg.active) ?? zephyrProject.buildConfigs[0];
}

/**
 * A project-scoped west task as buildDirectTask takes it: a task name from the
 * task provider's table, the build configuration it runs for, and its extra
 * options. Unlike WestCommandSpec, the command line itself comes from the
 * task provider, with the board, build folder and toolchain of that
 * configuration.
 */
export interface WestProjectTaskSpec {
  name: string;
  configName: string;
  options: BuildDirectTaskOptions;
}

/**
 * The task the matching `west*Command` runs for `spec`, or undefined where
 * buildDirectTask returns none (and shows its message), such as a task the
 * configuration's sysbuild setting does not support.
 */
export function buildWestProjectTask(application: ZephyrApplication, spec: WestProjectTaskSpec): vscode.Task | undefined {
  return buildDirectTask(application.appWorkspaceFolder, spec.name, spec.configName, spec.options, application);
}

export function westSpdxInitSpec(buildConfig: ZephyrBuildConfig): WestProjectTaskSpec {
  return { name: 'SPDX init', configName: buildConfig.name, options: {} };
}

export async function westSpdxInitCommand(
  zephyrProject: ZephyrApplication,
  _westWorkspace: WestWorkspace,
  buildConfig: ZephyrBuildConfig,
): Promise<void> {
  if (!zephyrProject.appRootPath) {
    return;
  }
  const task = buildWestProjectTask(zephyrProject, westSpdxInitSpec(buildConfig));
  if (!task) {
    return;
  }
  const exitCode = await executeTaskCollectExitCode(task);
  if (typeof exitCode === 'number' && exitCode !== 0) {
    throw new Error(`'west spdx --init' failed with exit code ${exitCode}. See the terminal output.`);
  }
}

export function westSpdxGenerateSpec(buildConfig: ZephyrBuildConfig, spdxVersion: '2.3' | '3.0' = '2.3'): WestProjectTaskSpec {
  const taskName = spdxVersion === '3.0' ? 'SPDX generate 3.0' : 'SPDX generate';
  // sdk.spdx is opt-in for `west spdx`; follow the SBOM Total verification setting
  // so every generation path (manual build or auto-verify) stays consistent.
  const includeSdk = vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
    .get<boolean>('sbomTotal.includeSdk', false);
  const options = includeSdk ? { extraArgs: ['--include-sdk'] } : {};
  return { name: taskName, configName: buildConfig.name, options };
}

export async function westSpdxGenerateCommand(
  zephyrProject: ZephyrApplication,
  _westWorkspace: WestWorkspace,
  buildConfig: ZephyrBuildConfig,
  spdxVersion: '2.3' | '3.0' = '2.3',
): Promise<void> {
  if (!zephyrProject.appRootPath) {
    return;
  }
  const task = buildWestProjectTask(zephyrProject, westSpdxGenerateSpec(buildConfig, spdxVersion));
  if (!task) {
    return;
  }
  const exitCode = await executeTaskCollectExitCode(task);
  if (typeof exitCode === 'number' && exitCode !== 0) {
    throw new Error(`'west spdx' failed with exit code ${exitCode}. See the terminal output.`);
  }
}

function makeWestArgs(
  project: ZephyrApplication,
  raw: string | undefined = undefined,
  westFlagsD: string[] | undefined = [],
): string {
  // Expand ${workspaceFolder}-style variables and normalize Windows paths for
  // the target shell before composing the command string.
  const expanded = expandAndNormalizeWestArgs(raw, {
    shellKind: classifyShell(getShellExe()),
    resolveVariable: makeConfiguredVariableResolver(project.appWorkspaceFolder),
  });
  // Inject the computed OPENOCD override at execution time so build settings stay unchanged,
  // but keep any explicit user-provided OPENOCD value in west args or west flags as higher
  // priority. Detection runs on the raw string; the -D flags it emits are pre-quoted and
  // must not be re-processed by the expander.
  return composeWestBuildArgs(expanded, mergeOpenocdBuildFlag(project, raw, westFlagsD));
}

/**
 * Runs `west build -t menuconfig|guiconfig|hardenconfig`
 * for the active Zephyr configuration.
 */
export async function westConfigCommand(
  zephyrProject: ZephyrApplication,
  _westWorkspace: WestWorkspace,
  target: "menuconfig" | "guiconfig" | "hardenconfig" = "menuconfig"
): Promise<void> {
  const buildConfig =
    zephyrProject.buildConfigs.find(cfg => cfg.active) ?? zephyrProject.buildConfigs[0];
  await westConfigCommandFor(zephyrProject, buildConfig, target);
}

/**
 * Runs `west build -t menuconfig|guiconfig|hardenconfig`
 * for the given Zephyr configuration, and resolves when it ends.
 */
export async function westConfigCommandFor(
  zephyrProject: ZephyrApplication,
  buildConfig: ZephyrBuildConfig | undefined,
  target: "menuconfig" | "guiconfig" | "hardenconfig" = "menuconfig"
): Promise<void> {
  if (!buildConfig?.boardIdentifier || !zephyrProject.appRootPath) {
    return;
  }

  const taskName = target === 'menuconfig'
    ? 'Menuconfig'
    : target === 'guiconfig'
      ? 'Gui config'
      : 'Harden Config';
  const task = buildDirectTask(zephyrProject.appWorkspaceFolder, taskName, buildConfig.name, {}, zephyrProject);
  if (!task) {
    return;
  }
  try {
    await executeTask(task);
  } catch (error) {
    // Held back because an AI agent is building this configuration: the
    // user already chose that in the prompt, so it is not an error.
    if (!(error instanceof TaskLaunchDeclined)) {
      throw error;
    }
  }
}

export interface WestBoardInfo {
  name: string;
  dir: string;
  qualifiers: string[];
  revisionDefault?: string;
  revisions: string[];
}

function parseWestBoardList(stdout: string): WestBoardInfo[] {
  return stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const [name = '', dir = '', qualifiersCsv = '', revisionDefault = '', revisionsRaw = ''] = line
        .split('|')
        .map(part => part.trim().replace(/^"+|"+$/g, ''));

      return {
        name,
        dir,
        qualifiers: qualifiersCsv.length > 0 ? qualifiersCsv.split(',').filter(entry => entry.length > 0) : [],
        revisionDefault: revisionDefault && revisionDefault !== 'None' ? revisionDefault : undefined,
        revisions: revisionsRaw && revisionsRaw !== 'None'
          ? revisionsRaw.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
          : [],
      };
    })
    .filter(board => board.name.length > 0 && board.dir.length > 0);
}

// `west boards --format` exposes a different field set depending on the Zephyr
// hardware model version of the workspace:
//   {name} and {dir}                always available
//   {qualifiers}                    added with hardware model v2 (Zephyr 3.7)
//   {revision_default}/{revisions}  added in Zephyr 4.2
// Referencing a field the running Zephyr does not provide raises a KeyError
// inside west and aborts the whole command, so probe from the richest format
// down to the universal one to keep board discovery working on every version.
const WEST_BOARDS_FORMATS = [
  '{name}|{dir}|{qualifiers}|{revision_default}|{revisions}',
  '{name}|{dir}|{qualifiers}',
  '{name}|{dir}',
];

/** The --format that worked for one workspace, and the Zephyr it worked on. */
interface RememberedFormat {
  stamp: string;
  format: string;
}

// Remember the format that worked per workspace so older Zephyr versions only
// pay the probing cost once instead of on every board lookup.
const westBoardsFormatCache = new Map<string, RememberedFormat>();

/** The west extension, under zephyr/scripts/west_commands, that prints a listing. */
type WestListingExtension = 'boards.py' | 'shields.py' | 'blobs.py';

/**
 * Where a listing's working --format is remembered: the workspace root, plus
 * a stamp of the west extension that formats the listing. An older format
 * still runs on a newer Zephyr, so after a `west update` that adds fields the
 * remembered one would keep hiding them. A Zephyr that adds a field rewrites
 * that extension, which changes the stamp. The VERSION file would not do: a
 * main checkout stays at x.y.99 while fields land.
 */
function formatCacheSlot(
  parent: ZephyrApplication | WestWorkspace,
  extension: WestListingExtension,
): { root: string; stamp: string } | undefined {
  let root: string | undefined;
  let kernel: string | undefined;
  if (parent instanceof WestWorkspace) {
    root = parent.rootUri.fsPath;
    kernel = parent.kernelUri.fsPath;
  } else {
    root = parent.westWorkspaceRootPath;
    try {
      kernel = root ? getWestWorkspace(root).kernelUri.fsPath : undefined;
    } catch {
      kernel = undefined;
    }
  }
  if (!root) {
    return undefined;
  }
  let stamp = '';
  if (kernel) {
    try {
      const stat = fs.statSync(path.join(kernel, 'scripts', 'west_commands', extension));
      stamp = `${stat.size}:${stat.mtimeMs}`;
    } catch {
      // No extension to stamp: the root alone keys the format, as it always did.
    }
  }
  return { root, stamp };
}

/**
 * Bounds for a west command run for a caller that cannot wait forever, such as
 * an agent tool call. Without them the command runs exactly as it always has.
 */
export interface WestRunOptions {
  /** Stops west, and the shell around it, when aborted. */
  signal?: AbortSignal;
  /** Stops west after this many milliseconds. */
  timeoutMs?: number;
  /**
   * Probe every --format again from the richest one, ignoring the format
   * remembered for this workspace, as an explicit refresh asks.
   */
  reprobe?: boolean;
}

/**
 * A west command that failed. It carries stderr so a caller can tell an
 * unknown command from a real failure, and `stopped` when it was killed for a
 * timeout or a cancel rather than failing by itself. String(error) still reads
 * "Error: <stderr>", as the plain string rejections it replaces did.
 */
export class WestCommandError extends Error {
  constructor(message: string, readonly stderr: string, readonly stopped?: 'timeout' | 'aborted') {
    super(message);
  }
}

/** How long a stopped west may ignore SIGTERM before it is killed outright. */
const WEST_KILL_ESCALATION_MS = 2000;

/**
 * Run a west command with the workbench environment and resolve with its
 * stdout. With a timeout or a signal, the shell is started in its own process
 * group so stopping it also stops west, which would otherwise be orphaned.
 */
function runWestCapture(
  cmd: string,
  parent: ZephyrApplication | WestWorkspace,
  opts: WestRunOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new WestCommandError('The west command was cancelled before it started.', '', 'aborted'));
      return;
    }
    const bounded = opts.signal !== undefined || opts.timeoutMs !== undefined;
    let child: ChildProcess | undefined;
    let stopped: 'timeout' | 'aborted' | undefined;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;

    const stop = (reason: 'timeout' | 'aborted') => {
      if (stopped || settled || !child) {
        return;
      }
      stopped = reason;
      killProcessTree(child, 'SIGTERM');
      escalation = setTimeout(() => child && killProcessTree(child, 'SIGKILL'), WEST_KILL_ESCALATION_MS);
    };
    const onAbort = () => stop('aborted');
    const settle = (outcome: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      opts.signal?.removeEventListener('abort', onAbort);
      outcome();
    };

    // Throws synchronously for a missing environment script or venv, which
    // rejects this promise with that error and its setting-key cause.
    child = execWestCommandWithEnv(cmd, parent, (error, stdout, stderr) => settle(() => {
      if (stopped) {
        reject(new WestCommandError(
          stopped === 'timeout'
            ? `"${cmd}" did not finish within ${Math.round((opts.timeoutMs ?? 0) / 1000)} seconds and was stopped.`
            : `"${cmd}" was cancelled.`,
          stderr, stopped));
      } else if (error) {
        reject(new WestCommandError(stderr.trim() || error.message, stderr));
      } else {
        resolve(stdout);
      }
    }), { detached: bounded });
    // A shell that cannot start may never report a close, so an error settles too.
    child.on('error', error => settle(() => reject(new WestCommandError(error.message, ''))));

    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => stop('timeout'), opts.timeoutMs);
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run a west listing with the richest --format the workspace understands,
 * trying the format that worked last time first. A timeout, a cancel, a
 * command this west does not have, a west that cannot start, or an
 * environment error fails the same way for every format, so those end the
 * probing at once instead of repeating it.
 */
async function runWithFormatProbe<T>(
  parent: ZephyrApplication | WestWorkspace,
  candidates: readonly string[],
  formatCache: Map<string, RememberedFormat>,
  extension: WestListingExtension,
  run: (format: string, opts: WestRunOptions) => Promise<T>,
  opts: WestRunOptions,
): Promise<T> {
  const slot = formatCacheSlot(parent, extension);
  const remembered = slot ? formatCache.get(slot.root) : undefined;
  const cachedFormat = !opts.reprobe && remembered && remembered.stamp === slot?.stamp ? remembered.format : undefined;

  // Try the previously successful format first, but still keep the full probe
  // order behind it so a stale cache entry can never wedge discovery.
  const formats = cachedFormat
    ? [cachedFormat, ...candidates.filter(format => format !== cachedFormat)]
    : candidates;
  // One deadline for the whole probe, so a slow west cannot take the timeout
  // once per format.
  const deadline = opts.timeoutMs !== undefined ? Date.now() + opts.timeoutMs : undefined;

  let firstError: unknown;
  let hasError = false;
  for (const format of formats) {
    try {
      const result = await run(format, {
        signal: opts.signal,
        ...(deadline !== undefined ? { timeoutMs: Math.max(1, deadline - Date.now()) } : {}),
      });
      if (slot) {
        formatCache.set(slot.root, { stamp: slot.stamp, format });
      }
      return result;
    } catch (error) {
      if (!(error instanceof WestCommandError) || error.stopped
        || isUnknownWestCommand(error.stderr) || isWestMissing(error.stderr)) {
        throw error;
      }
      if (!hasError) {
        firstError = error;
        hasError = true;
      }
    }
  }
  throw firstError;
}

/**
 * One board root exactly as it goes onto the west command line for the active
 * shell. Exported so a caller that screens roots can check this final string,
 * and not only the setting it came from.
 */
export function boardRootShellArg(boardRoot: string): string {
  return quoteIfNeeded(normalizePathForShell(classifyShell(getShellExe()), normalizePath(boardRoot)));
}

/** ` --board-root <root>` for each root, shaped for the active shell. */
function boardRootArgs(boardRoots?: string[]): string {
  let args = '';
  for (const boardRoot of boardRoots ?? []) {
    if (boardRoot.length > 0) {
      args += ` --board-root ${boardRootShellArg(boardRoot)}`;
    }
  }
  return args;
}

export async function getWestBoards(
  parent: ZephyrApplication | WestWorkspace,
  boardRoots?: string[],
  opts: WestRunOptions = {},
): Promise<WestBoardInfo[]> {
  return runWithFormatProbe(parent, WEST_BOARDS_FORMATS, westBoardsFormatCache, 'boards.py',
    (format, runOpts) => runWestBoardsList(parent, format, boardRoots, runOpts), opts);
}

async function runWestBoardsList(
  parent: ZephyrApplication | WestWorkspace,
  format: string,
  boardRoots: string[] | undefined,
  opts: WestRunOptions,
): Promise<WestBoardInfo[]> {
  const stdout = await runWestCapture(`west boards -f "${format}"${boardRootArgs(boardRoots)}`, parent, opts);
  return parseWestBoardList(stdout);
}

export interface WestShieldInfo {
  name: string;
  dir?: string;
  vendor?: string;
  fullName?: string;
}

// `west shields` exists since Zephyr 3.7 and, like `west boards`, formats its
// output with a Python format string whose fields grew over time: {name} and
// {dir} from the start, {vendor} and {full_name} since mid 2025. An unknown
// field aborts the command, so probe from the richest format down.
const WEST_SHIELDS_FORMATS = [
  '{name}|{dir}|{vendor}|{full_name}',
  '{name}|{dir}',
  '{name}',
];

const westShieldsFormatCache = new Map<string, RememberedFormat>();

/** Shield names as the build system accepts them in SHIELD. */
const SHIELD_NAME = /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/;

/**
 * Parse `west shields -f <format>` output. The last field takes the rest of
 * the line, because a full name may itself contain the separator, and lines
 * that do not start with a valid shield name (warnings, banners) are skipped.
 * west prints "None" for a field the shield does not define, and falls back
 * to the shield name for a missing full name, so that copy is dropped too.
 */
export function parseWestShieldList(stdout: string, format: string): WestShieldInfo[] {
  const fields = format.split('|').map(field => field.replace(/[{}]/g, '').trim());
  const shields: WestShieldInfo[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    let line = rawLine.trim();
    // Some shells echo the quotes around the format back into the output.
    if (line.length >= 2 && line.startsWith('"') && line.endsWith('"')) {
      line = line.slice(1, -1);
    }
    const parts = line.split('|');
    if (line.length === 0 || parts.length < fields.length) {
      continue;
    }
    const values = [...parts.slice(0, fields.length - 1), parts.slice(fields.length - 1).join('|')];
    const field = (key: string): string | undefined => {
      const index = fields.indexOf(key);
      const value = index >= 0 ? values[index].trim() : '';
      return value && value !== 'None' ? value : undefined;
    };
    const name = field('name');
    if (!name || !SHIELD_NAME.test(name)) {
      continue;
    }
    const dir = field('dir');
    const key = `${name}|${dir ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const vendor = field('vendor');
    const fullName = field('full_name');
    shields.push({
      name,
      ...(dir ? { dir } : {}),
      ...(vendor ? { vendor } : {}),
      ...(fullName && fullName !== name ? { fullName } : {}),
    });
  }
  return shields;
}

/**
 * The shields `west shields` reports for a workspace, with their folder, and
 * with vendor and full name where the Zephyr version provides them.
 * `boardRoots` adds shields defined under `<root>/boards/shields`.
 */
export async function getWestShields(
  parent: ZephyrApplication | WestWorkspace,
  boardRoots?: string[],
  opts: WestRunOptions = {},
): Promise<WestShieldInfo[]> {
  return runWithFormatProbe(parent, WEST_SHIELDS_FORMATS, westShieldsFormatCache, 'shields.py', async (format, runOpts) =>
    parseWestShieldList(await runWestCapture(`west shields -f "${format}"${boardRootArgs(boardRoots)}`, parent, runOpts), format),
  opts);
}

/**
 * Executes the "west shields" command and returns an array of shield names.
 * @param parent The ZephyrApplication or WestWorkspace instance.
 * @returns A promise that resolves with the list of supported shield names.
 */
export async function getSupportedShields(
  parent: ZephyrApplication | WestWorkspace,
): Promise<string[]> {
  const shields = await getWestShields(parent);
  return [...new Set(shields.map(shield => shield.name))];
}

export interface WestBlobInfo {
  /** The Zephyr module that declares the blob. */
  module: string;
  /** From west's status letter: A present, M outdated (hash mismatch), D missing. */
  status: 'present' | 'outdated' | 'missing';
  /** Where the blob goes, relative to <module>/zephyr/blobs/. */
  path: string;
  /** 'img' or 'lib'. */
  type?: string;
  /** The blob's license file, relative to its module. */
  license?: string;
  /** Where the blob is fetched from; the first location when several are declared. */
  url?: string;
}

// west's own layout for `west blobs list` without --format (DEFAULT_LIST_FMT in
// blobs.py). Its last field, the absolute path, is only used to take the rest
// of a line.
const WEST_BLOBS_DEFAULT_FORMAT = '{module} {status} {path} {type} {abspath}';

// `west blobs list` formats each blob with a Python format string, like
// `west boards`. The fields below are required by the module.yml schema, but a
// module that still omits one raises a KeyError and aborts the listing, so
// probe down to the fields west computes itself, then to west's own layout.
const WEST_BLOBS_FORMATS = [
  '{module}|{status}|{path}|{type}|{license-path}|{url}',
  '{module}|{status}|{path}|{type}',
  WEST_BLOBS_DEFAULT_FORMAT,
];

const westBlobsFormatCache = new Map<string, RememberedFormat>();

const WEST_BLOB_STATUS: Record<string, WestBlobInfo['status']> = { A: 'present', M: 'outdated', D: 'missing' };

/** A blob declares one URL or, on newer Zephyr, a list of them, which west prints as a Python list. */
function firstBlobUrl(value: string | undefined): string | undefined {
  if (!value?.startsWith('[')) {
    return value;
  }
  return /['"]([^'"]+)['"]/.exec(value)?.[1];
}

/**
 * Parse `west blobs list` output printed with `format`: '|'-separated for the
 * probed formats, whitespace-separated for west's own layout. The last field
 * takes the rest of the line, and lines without a module, a known status
 * letter and a path (warnings, banners) are skipped.
 */
export function parseWestBlobList(stdout: string, format: string): WestBlobInfo[] {
  const separator = format.includes('|') ? '|' : ' ';
  const fields = format.split(separator).map(field => field.replace(/[{}]/g, '').trim());
  const blobs: WestBlobInfo[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    let line = rawLine.trim();
    // Some shells echo the quotes around the format back into the output.
    if (line.length >= 2 && line.startsWith('"') && line.endsWith('"')) {
      line = line.slice(1, -1);
    }
    const parts = separator === '|' ? line.split('|') : line.split(/\s+/);
    if (line.length === 0 || parts.length < fields.length) {
      continue;
    }
    const values = [...parts.slice(0, fields.length - 1), parts.slice(fields.length - 1).join(separator)];
    const field = (key: string): string | undefined => {
      const index = fields.indexOf(key);
      const value = index >= 0 ? values[index].trim() : '';
      return value && value !== 'None' ? value : undefined;
    };
    const moduleName = field('module');
    const status = WEST_BLOB_STATUS[field('status') ?? ''];
    const blobPath = field('path');
    if (!moduleName || !status || !blobPath) {
      continue;
    }
    const type = field('type');
    const license = field('license-path');
    const url = firstBlobUrl(field('url'));
    blobs.push({
      module: moduleName,
      status,
      path: blobPath,
      ...(type ? { type } : {}),
      ...(license ? { license } : {}),
      ...(url ? { url } : {}),
    });
  }
  return blobs;
}

/**
 * The binary blobs `west blobs list` reports for a workspace, with their
 * status, and with the license file and download URL where the Zephyr version
 * lets the listing ask for them. A Zephyr without `west blobs` fails with a
 * WestCommandError, as the other listings do. westBlobsListCommand still
 * prints west's own table for the user.
 */
export async function getWestBlobs(
  workspace: WestWorkspace,
  opts: WestRunOptions = {},
): Promise<WestBlobInfo[]> {
  return runWithFormatProbe(workspace, WEST_BLOBS_FORMATS, westBlobsFormatCache, 'blobs.py', async (format, runOpts) => {
    const cmd = format === WEST_BLOBS_DEFAULT_FORMAT ? 'west blobs list' : `west blobs list -f "${format}"`;
    return parseWestBlobList(await runWestCapture(cmd, workspace, runOpts), format);
  }, opts);
}

function envList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  }
  return typeof value === 'string' && value.length > 0 ? [value] : [];
}

/**
 * Folders `west build -S` searches for `snippets/**\/snippet.yml` with no
 * further setup: Zephyr itself, which the build system always searches, the
 * workspace SNIPPET_ROOT setting, and the application folder when one is given
 * and this Zephyr still adds it by itself. Zephyr 4.4 stopped doing that: an
 * application's own snippets are then found only once it adds its folder to
 * SNIPPET_ROOT, so the folder is left out here. Snippet roots declared by
 * other modules are not included, because finding them needs the module list
 * of a build. A relative setting is left out: it would otherwise be read
 * against the extension host's working directory, not a folder the user meant.
 */
export function getSnippetRoots(westWorkspace: WestWorkspace, application?: ZephyrApplication): string[] {
  const kernel = westWorkspace.kernelUri.fsPath;
  return [
    kernel,
    ...envList(westWorkspace.envVars?.SNIPPET_ROOT).filter(root => path.isAbsolute(root)),
    ...(application && zephyrSearchesAppSnippets(kernel) ? [application.appRootPath] : []),
  ];
}

export async function getSupportedSnippets(
  parent: ZephyrApplication | WestWorkspace,
): Promise<string[]> {
  const ws =
    parent instanceof ZephyrApplication
      ? getWestWorkspace(parent.westWorkspaceRootPath)
      : (parent as WestWorkspace);

  if (!ws?.kernelUri?.fsPath || !fs.existsSync(path.join(ws.kernelUri.fsPath, 'snippets'))) {
    throw new Error('No snippets found. Please make sure you have generated the west workspace correctly.');
  }
  // Names come from each snippet.yml, so nested snippets are listed and
  // grouping folders such as snippets/nordic are not.
  const snippets = await findSnippets(getSnippetRoots(ws, parent instanceof ZephyrApplication ? parent : undefined));
  return [...new Set(snippets.map(snippet => snippet.name))];
}

export function execWestCommandWithEnv(
  cmd: string,
  parent: ZephyrApplication | WestWorkspace,
  callback?: (error: Error | null, stdout: string, stderr: string) => void,
  spawnOptions: { detached?: boolean } = {},
): ChildProcess {
  const venvPath = getConfiguredVenvPath(
    parent instanceof ZephyrApplication ? parent.appWorkspaceFolder : parent.rootUri,
  );
  const projectVenvPath = parent instanceof ZephyrApplication
    ? parent.venvPath ?? venvPath
    : venvPath;

  const envScript = getConfiguredWorkbenchPath(
    ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY,
    parent instanceof ZephyrApplication ? parent.appWorkspaceFolder : parent.rootUri,
  );

  // The cause names the setting to fix, as execWestCommandWithEnvAsync does,
  // so callers such as the MCP tools can report a setup gap rather than a crash.
  // The messages stay as they were: the Create Application panel recognises
  // these two failures by their text.
  if (!envScript) {
    throw new Error('Missing Zephyr env script', {
      cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}`,
    });
  }
  if (projectVenvPath && !fileExists(projectVenvPath)) {
    throw new Error('Invalid venv path', {
      cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY}`,
    });
  }

  // build cwd + env
  const options: any = { env: { ...process.env }, cwd: '' };
  if (parent instanceof ZephyrApplication) {
    const zephyrSdkInstallation = tryGetZephyrSdkInstallation(parent.zephyrSdkPath);
    const ws = getWestWorkspace(parent.westWorkspaceRootPath);
    options.cwd = parent.appRootPath;
    options.env = prependRustBinPath({
      ...options.env,
      ...(zephyrSdkInstallation?.buildEnv ?? {}),
      ...ws.buildEnv,
      ...parent.getToolchainEnv(),
      ...parent.getBuildConfiguration,
    }, parent.selectedRustToolchainInstallation?.binPath);
  } else {
    const ws = parent as WestWorkspace;
    options.cwd = ws.rootUri.fsPath;
    options.env = { ...options.env, ...ws.buildEnv };
  }
  if (projectVenvPath) {options.env.PYTHON_VENV_PATH = projectVenvPath;}

  // shell + flags
  const shellExe = getShellExe();
  const shellKind = classifyShell(shellExe);
  const baseArgs = getShellArgs(shellKind);
  const shellArgs = isCygwin(shellExe)
    ? ['--login', '-i', ...baseArgs]
    : baseArgs;

  // build the one single script
  const envScriptForShell = normalizePathForShell(shellKind, envScript);
  const redirect = getShellNullRedirect(shellKind);
  const sourceCmd = getShellSourceCommand(shellKind, envScriptForShell);
  const script = concatCommands(shellKind, sourceCmd, redirect, cmd);


  const child = spawn(shellExe, [...shellArgs, script], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group lets killProcessTree stop west and not only the
    // shell. Only callers that may stop the command ask for it.
    detached: spawnOptions.detached === true && process.platform !== 'win32',
  });

  let out = '', err = '';
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => err += d);
  child.on('close', code => {
    callback?.(code === 0 ? null : new Error(`exit ${code}`), out, err);
  });

  return child;
}

export function execWestCommandWithEnvAsync(
  cmd: string,
  parent: ZephyrApplication | WestWorkspace
): Promise<void> {

  /* settings ------------------------------------------------------------ */
  const envScript = getConfiguredWorkbenchPath(
    ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY,
    parent instanceof ZephyrApplication ? parent.appWorkspaceFolder : parent.rootUri,
  );

  const venvPath = getConfiguredVenvPath(
    parent instanceof ZephyrApplication ? parent.appWorkspaceFolder : parent.rootUri,
  );
  const projectVenvPath = parent instanceof ZephyrApplication
    ? parent.venvPath ?? venvPath
    : venvPath;

  if (!envScript) {
    throw new Error(
      'Missing Zephyr environment script.\n' +
      'Go to File > Preferences > Settings > Extensions > Zephyr Workbench > Path To Env Script',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` }
    );
  }
  if (projectVenvPath && !fileExists(projectVenvPath)) {
    throw new Error(
      'Invalid Python virtual environment.\n' +
      'Go to File > Preferences > Settings > Extensions > Zephyr Workbench > Venv: Path',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY}` }
    );
  }

  let options: ExecOptions = {
    env: {
      ...process.env,
      ...(projectVenvPath ? { PYTHON_VENV_PATH: projectVenvPath } : {})
    }
  };

  if (parent instanceof ZephyrApplication) {
    const project = parent;
    const activeZephyrSdkInstallation = tryGetZephyrSdkInstallation(project.zephyrSdkPath);
    const westWorkspace = getWestWorkspace(project.westWorkspaceRootPath);
    const buildEnv = project.getBuildConfiguration;

    options.cwd = project.appRootPath;
    options.env = prependRustBinPath({
      ...options.env,
      ...(activeZephyrSdkInstallation?.buildEnv ?? {}),
      ...westWorkspace.buildEnv,
      ...project.getToolchainEnv(),
      ...buildEnv
    }, project.selectedRustToolchainInstallation?.binPath);
  } else {
    const westWorkspace = parent as WestWorkspace;
    options.cwd = westWorkspace.rootUri.fsPath;
    options.env = { ...options.env, ...westWorkspace.buildEnv };
  }

  const shellKind = classifyShell(getShellExe());
  const envScriptForShell = normalizePathForShell(shellKind, envScript);

  const cmdEnv = `${getShellSourceCommand(shellKind, envScriptForShell)}`;
  const command = concatCommands(shellKind, cmdEnv, cmd);

  options.shell = getShellExe();


  return new Promise<void>((resolve, reject) => {
    const child = exec(command, options, err => err ? reject(err) : resolve());

    child.stdout?.on('data', d => console.log(d.toString()));
    child.stderr?.on('data', d => console.error(d.toString()));
  });
}
