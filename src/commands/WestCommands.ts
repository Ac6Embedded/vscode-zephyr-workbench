import { ChildProcess, exec, spawn, ExecOptions } from 'child_process';
import * as fs from 'fs';
import path from 'path';
import * as vscode from 'vscode';
import { WestWorkspace } from '../models/WestWorkspace';
import { ZephyrApplication } from '../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../models/ZephyrBuildConfig';
import { ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY } from '../constants';
import { concatCommands, executeTask, execShellCommandWithEnv, getConfiguredVenvPath, getConfiguredWorkbenchPath, getShellNullRedirect, getShellSourceCommand, getShellExe, classifyShell, getShellArgs, normalizePathForShell, execShellTaskWithEnvAndWait, isCygwin, normalizeEnvVarsForShell, RawEnvVars } from '../utils/execUtils';
import { fileExists, getSelectedToolchainVariantEnv, getWestWorkspace, normalizePath, tryGetZephyrSdkInstallation } from '../utils/utils';
import { composeWestBuildArgs } from '../utils/zephyr/westArgUtils';
import { mergeOpenocdBuildFlag } from '../utils/debugTools/debugToolSelectionUtils';
import { buildDirectTask, createCppPropertiesCompileCommandsRefresh } from '../providers/ZephyrTaskProvider';

function quote(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

export async function westInitCommand(srcUrl: string, srcRev: string, workspacePath: string, manifestPath: string = ''): Promise<void> {
  let command = '';
  // If init remote repository
  if (srcUrl && srcUrl !== '') {
    workspacePath = normalizePath(workspacePath);
    workspacePath = normalizePathForShell(classifyShell(getShellExe()), workspacePath);
    command = `west init -m ${srcUrl} --mr ${srcRev} ${workspacePath}`;
    if (manifestPath !== '') {
      manifestPath = normalizePath(manifestPath);
      manifestPath = normalizePathForShell(classifyShell(getShellExe()), manifestPath);
      command += ` --mf ${manifestPath}`;
    }
  } else {
    if (manifestPath !== '' && fileExists(manifestPath)) {
      let manifestFile = path.basename(manifestPath);
      let manifestDir: string;

      // If the manifest already lives inside the workspace (e.g. the template flow
      // wrote it under <workspace>/manifest/ or <workspace>/<custom>/), use that
      // location directly. Only fall back to the legacy <workspace>/manifest/ copy
      // when the user picked an external file we need to bring into the workspace.
      const absManifest = path.resolve(manifestPath);
      const absWorkspace = path.resolve(workspacePath);
      const insideWorkspace =
        absManifest === path.join(absWorkspace, manifestFile) ||
        absManifest.startsWith(absWorkspace + path.sep);

      if (insideWorkspace) {
        manifestDir = path.dirname(absManifest);
      } else {
        manifestDir = path.join(workspacePath, 'manifest');
        const destFilePath = path.join(manifestDir, manifestFile);

        if (destFilePath !== manifestPath) {
          if (!fileExists(workspacePath)) {
            fs.mkdirSync(workspacePath);
          }
          if (!fileExists(manifestDir)) {
            fs.mkdirSync(manifestDir, { recursive: true });
          }

          if (!fileExists(destFilePath)) {
            fs.cpSync(manifestPath, destFilePath);
          }
        }
      }

      manifestFile = normalizePath(manifestFile);
      manifestFile = normalizePathForShell(classifyShell(getShellExe()), manifestFile);
      manifestDir = normalizePath(manifestDir);
      manifestDir = normalizePathForShell(classifyShell(getShellExe()), manifestDir);
      command = `west init -l --mf ${manifestFile} ${manifestDir}`;
    }
  }

  let options: vscode.ShellExecutionOptions = {
    env: { ZEPHYR_PROJECT_DIRECTORY: workspacePath },
    cwd: "${userHome}"
  };
  await execShellCommandWithEnv(`West Init for current workspace`, command, options);
}

export async function westUpdateCommand(workspacePath: string): Promise<void> {
  let command = "west update";

  let options: vscode.ShellExecutionOptions = {
    env: { ZEPHYR_PROJECT_DIRECTORY: workspacePath },
    cwd: `${workspacePath}`
  };

  await execShellCommandWithEnv(`West Update for current workspace`, command, options);
}

export async function westPackagesInstallCommand(workspacePath: string): Promise<void> {

  const command = "west packages pip --install";

  const options: vscode.ShellExecutionOptions = {
    env: { ZEPHYR_PROJECT_DIRECTORY: workspacePath },
    cwd: workspacePath
  };

  await execShellCommandWithEnv(
    "West - install Python dependencies for current workspace",
    command,
    options
  );
}

export async function westBoardsCommand(workspacePath: string): Promise<void> {
  const shellKind = classifyShell(getShellExe());
  const redirect = getShellNullRedirect(shellKind);

  const command = `west boards ${redirect}`;

  const options: vscode.ShellExecutionOptions = {
    env: { ZEPHYR_PROJECT_DIRECTORY: workspacePath },
    cwd: workspacePath,
    executable: getShellExe(),
  };

  await execShellCommandWithEnv('West Boards for current workspace', command, options);
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

  const rawEnvVars = buildConfig.envVars as RawEnvVars;
  normalizeEnvVarsForShell(rawEnvVars, shellKind);

  const redirect = getShellNullRedirect(shellKind);

  const command  = [
    'west build',
    '-t boards',
    '--cmake-only',
    `--board ${buildConfig.boardIdentifier}`,
    `--build-dir ${quote(tmpPath)}`,
    quote(normalizePathForShell(shellKind,zephyrProject.appRootPath)),
    (westArgs ? ` ${westArgs}` : ''),
    redirect,
  ].filter(Boolean).join(' ');

  const options: vscode.ShellExecutionOptions = {
    cwd        : zephyrProject.appRootPath,
    env        : {
      ...buildConfig.envVars,
      ...(activeZephyrSdkInstallation?.buildEnv ?? {}),
      ...westWorkspace.buildEnv
    },
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
): Promise<void> {
  const refreshCppProperties = await createCppPropertiesCompileCommandsRefresh(zephyrProject.appWorkspaceFolder);
  try {
    await runWestBuildCommand(zephyrProject, westWorkspace, {
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
  const refreshCppProperties = await createCppPropertiesCompileCommandsRefresh(zephyrProject.appWorkspaceFolder);
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
): Promise<void> {
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
  );
  if (!task) {
    return;
  }

  await executeTask(task);
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

export async function westSpdxInitCommand(
  zephyrProject: ZephyrApplication,
  _westWorkspace: WestWorkspace,
  buildConfig: ZephyrBuildConfig,
): Promise<void> {
  if (!zephyrProject.appRootPath) {
    return;
  }
  const task = buildDirectTask(zephyrProject.appWorkspaceFolder, 'SPDX init', buildConfig.name);
  if (!task) {
    return;
  }
  await executeTask(task);
}

export async function westSpdxGenerateCommand(
  zephyrProject: ZephyrApplication,
  _westWorkspace: WestWorkspace,
  buildConfig: ZephyrBuildConfig,
): Promise<void> {
  if (!zephyrProject.appRootPath) {
    return;
  }
  const task = buildDirectTask(zephyrProject.appWorkspaceFolder, 'SPDX generate', buildConfig.name);
  if (!task) {
    return;
  }
  await executeTask(task);
}

function makeWestArgs(
  project: ZephyrApplication,
  raw: string | undefined = undefined,
  westFlagsD: string[] | undefined = [],
): string {
  // Inject the computed OPENOCD override at execution time so build settings stay unchanged,
  // but keep any explicit user-provided OPENOCD value in west args or west flags as higher priority.
  return composeWestBuildArgs(raw, mergeOpenocdBuildFlag(project, raw, westFlagsD));
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
  if (!buildConfig?.boardIdentifier || !zephyrProject.appRootPath) {
    return;
  }

  const taskName = target === 'menuconfig'
    ? 'Menuconfig'
    : target === 'guiconfig'
      ? 'Gui config'
      : 'Harden Config';
  const task = buildDirectTask(zephyrProject.appWorkspaceFolder, taskName, buildConfig.name);
  if (!task) {
    return;
  }
  await executeTask(task);
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

export async function getWestBoards(parent: ZephyrApplication | WestWorkspace, boardRoots?: string[]): Promise<WestBoardInfo[]> {
  return new Promise((resolve, reject) => {
    let cmd = 'west boards -f "{name}|{dir}|{qualifiers}|{revision_default}|{revisions}"';
    if (boardRoots) {
      for (let boardRoot of boardRoots) {
        if (boardRoot.length > 0) {
          let normalizeBoardRoot = normalizePath(boardRoot);
          normalizeBoardRoot = normalizePathForShell(classifyShell(getShellExe()), normalizeBoardRoot);
          cmd += ` --board-root ${normalizeBoardRoot}`;
        }
      }
    }
    execWestCommandWithEnv(cmd, parent, async (error: any, stdout: string, stderr: any) => {
      if (error) {
        reject(`Error: ${stderr}`);
        return;
      }

      const boards = parseWestBoardList(stdout);
      resolve(boards);
    });
  });
}

/**
 * Executes the "west shields" command and returns an array of shield names.
 * @param parent The ZephyrApplication or WestWorkspace instance.
 * @returns A promise that resolves with the list of supported shield names.
 */
export async function getSupportedShields(
  parent: ZephyrApplication | WestWorkspace,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execWestCommandWithEnv('west shields', parent, (error, stdout, stderr) => {
      if (error) {
        return reject(`Error: ${stderr}`);
      }

      const lines = stdout.split(/\r?\n/).map(l => l.trim());

      const firstShieldIdx = lines.findIndex(
        l => /^[A-Za-z0-9_]+$/.test(l) && l.includes('_'),
      );

      const shieldNames =
        firstShieldIdx === -1
          ? []
          : lines
              .slice(firstShieldIdx)
              .filter(l => /^[A-Za-z0-9_]+$/.test(l));

      resolve(shieldNames);
    });
  });
}

export async function getSupportedSnippets(
  parent: ZephyrApplication | WestWorkspace,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const ws =
      parent instanceof ZephyrApplication
        ? getWestWorkspace(parent.westWorkspaceRootPath)
        : (parent as WestWorkspace);

    if (ws?.kernelUri?.fsPath) {
      const snippetsDir = path.join(ws.kernelUri.fsPath, 'snippets');
      if (fs.existsSync(snippetsDir)) {
        const names = fs.readdirSync(snippetsDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        return resolve(names);
      }
    }
    reject('No snippets found. Please make sure you have generated the west workspace correctly.');
  });
}

export function execWestCommandWithEnv(
  cmd: string,
  parent: ZephyrApplication | WestWorkspace,
  callback?: (error: Error | null, stdout: string, stderr: string) => void
): ChildProcess {
  const venvPath = getConfiguredVenvPath(
    parent instanceof ZephyrApplication ? parent.appWorkspaceFolder : parent.rootUri,
  );

  const envScript = getConfiguredWorkbenchPath(
    ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY,
    parent instanceof ZephyrApplication ? parent.appWorkspaceFolder : parent.rootUri,
  );

  if (!envScript) {throw new Error('Missing Zephyr env script');}
  if (venvPath && !fileExists(venvPath)) {throw new Error('Invalid venv path');}

  // build cwd + env
  const options: any = { env: { ...process.env }, cwd: '' };
  if (parent instanceof ZephyrApplication) {
    const zephyrSdkInstallation = tryGetZephyrSdkInstallation(parent.zephyrSdkPath);
    const ws = getWestWorkspace(parent.westWorkspaceRootPath);
    options.cwd = parent.appRootPath;
    options.env = {
      ...options.env,
      ...(zephyrSdkInstallation?.buildEnv ?? {}),
      ...ws.buildEnv,
      ...getSelectedToolchainVariantEnv(vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, parent.appWorkspaceFolder), parent.appWorkspaceFolder),
      ...parent.getBuildConfiguration,
    };
  } else {
    const ws = parent as WestWorkspace;
    options.cwd = ws.rootUri.fsPath;
    options.env = { ...options.env, ...ws.buildEnv };
  }
  if (venvPath) {options.env.PYTHON_VENV_PATH = venvPath;}

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
    stdio: ['ignore', 'pipe', 'pipe']
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

  if (!envScript) {
    throw new Error(
      'Missing Zephyr environment script.\n' +
      'Go to File > Preferences > Settings > Extensions > Zephyr Workbench > Path To Env Script',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` }
    );
  }
  if (venvPath && !fileExists(venvPath)) {
    throw new Error(
      'Invalid Python virtual environment.\n' +
      'Go to File > Preferences > Settings > Extensions > Zephyr Workbench > Venv: Path',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY}` }
    );
  }

  let options: ExecOptions = {
    env: {
      ...process.env,
      ...(venvPath ? { PYTHON_VENV_PATH: venvPath } : {})
    }
  };

  if (parent instanceof ZephyrApplication) {
    const project = parent;
    const activeZephyrSdkInstallation = tryGetZephyrSdkInstallation(project.zephyrSdkPath);
    const westWorkspace = getWestWorkspace(project.westWorkspaceRootPath);
    const buildEnv = project.getBuildConfiguration;

    options.cwd = project.appRootPath;
    options.env = {
      ...options.env,
      ...(activeZephyrSdkInstallation?.buildEnv ?? {}),
      ...westWorkspace.buildEnv,
      ...getSelectedToolchainVariantEnv(vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, project.appWorkspaceFolder), project.appWorkspaceFolder),
      ...buildEnv
    };
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
