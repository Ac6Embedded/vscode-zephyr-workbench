import { ChildProcess, exec, spawn, ExecOptions } from 'child_process';
import * as fs from 'fs';
import path from 'path';
import * as vscode from 'vscode';
import { WestWorkspace } from '../models/WestWorkspace';
import { ZephyrApplication } from '../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../models/ZephyrBuildConfig';
import { ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY } from '../constants';
import { concatCommands, execShellCommandWithEnv, getConfiguredVenvPath, getConfiguredWorkbenchPath, getShellNullRedirect, getShellSourceCommand, getShellExe, classifyShell, getShellArgs, normalizePathForShell, execShellTaskWithEnvAndWait, isCygwin, normalizeEnvVarsForShell, RawEnvVars } from '../utils/execUtils';
import { fileExists, getSelectedToolchainVariantEnv, getWestWorkspace, normalizePath, tryGetZephyrSdkInstallation } from '../utils/utils';
import { composeWestBuildArgs } from '../utils/zephyr/westArgUtils';
import { mergeOpenocdBuildFlag } from '../utils/debugTools/debugToolSelectionUtils';

function quote(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

function formatShellPathArg(shellKind: string, p: string): string {
  const normalized = normalizePathForShell(shellKind, p);
  if (shellKind === 'cmd.exe' || shellKind === 'powershell.exe' || shellKind === 'pwsh.exe') {
    return quote(normalized);
  }
  return normalized;
}

function getWestWorkspaceShellOptions(
  zephyrProject: ZephyrApplication,
  westWorkspace: WestWorkspace,
  cwd: string = westWorkspace.rootUri.fsPath,
): vscode.ShellExecutionOptions {
  const activeZephyrSdkInstallation = tryGetZephyrSdkInstallation(zephyrProject.zephyrSdkPath);
  return {
    env: {
      ...(activeZephyrSdkInstallation?.buildEnv ?? {}),
      ...westWorkspace.buildEnv,
      ...getSelectedToolchainVariantEnv(
        vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, zephyrProject.appWorkspaceFolder),
        zephyrProject.appWorkspaceFolder,
      ),
    },
    cwd,
    executable: getShellExe(),
    shellArgs: getShellArgs(classifyShell(getShellExe())),
  };
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
      let manifestDir = path.join(workspacePath, 'manifest');
      let manifestFile = path.basename(manifestPath);
      const destFilePath = path.join(manifestDir, manifestFile);

      // If the manifest is not already in the destination folder 
      if (destFilePath !== manifestPath) {
        // If init from manifest, prepare directory
        if (!fileExists(workspacePath)) {
          fs.mkdirSync(workspacePath);
        }
        fs.mkdirSync(manifestDir);

        if (!fileExists(destFilePath)) {
          fs.cpSync(manifestPath, destFilePath);
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
  await execWestCommand(`West Init for current workspace`, command, options);
}

export async function westUpdateCommand(workspacePath: string): Promise<void> {
  let command = "west update";

  let options: vscode.ShellExecutionOptions = {
    env: { ZEPHYR_PROJECT_DIRECTORY: workspacePath },
    cwd: `${workspacePath}`
  };

  await execWestCommand(`West Update for current workspace`, command, options);
}

export async function westPackagesInstallCommand(workspacePath: string): Promise<void> {

  const command = "west packages pip --install";

  const options: vscode.ShellExecutionOptions = {
    env: { ZEPHYR_PROJECT_DIRECTORY: workspacePath },
    cwd: workspacePath
  };

  await execWestCommand(
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

  await execWestCommand('West Update for current workspace', command, options);
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

export async function westBuildCommand(zephyrProject: ZephyrApplication, westWorkspace: WestWorkspace, extraWestArgs = ''): Promise<void> {
  let buildConfig;
  const shellKind = classifyShell(getShellExe());
  for (let cfg of zephyrProject.buildConfigs) {
    if (cfg.active === true) {
      buildConfig = cfg;
      break;
    }
  }
  if (buildConfig === undefined) {
    buildConfig = zephyrProject.buildConfigs[0];
  }

  if (buildConfig.boardIdentifier === undefined || zephyrProject.appRootPath === undefined) {
    return;
  }

  const activeZephyrSdkInstallation = tryGetZephyrSdkInstallation(zephyrProject.zephyrSdkPath);
  let buildDir = normalizePathForShell(shellKind, path.join(zephyrProject.appRootPath, 'build', buildConfig.name));
  const rawWestArgs = extraWestArgs.length > 0 ? extraWestArgs : buildConfig.westArgs;
  const westArgs = makeWestArgs(zephyrProject, rawWestArgs, buildConfig.westFlagsD);

  const rawEnvVars = buildConfig.envVars as RawEnvVars;
  const normEnvVars = normalizeEnvVarsForShell(rawEnvVars, shellKind);

  const sysbuildEnabled =
    typeof buildConfig.sysbuild === "string"
      ? buildConfig.sysbuild.toLowerCase() === "true"
      : Boolean(buildConfig.sysbuild);

  const sysbuildFlag = sysbuildEnabled ? " --sysbuild" : "";

  const snippets = buildConfig.envVars?.['SNIPPETS'];
  const snippetsFlag = Array.isArray(snippets) && snippets.length > 0
    ? snippets.map(s => ` -S ${s}`).join('')
    : '';

  const folderUri = vscode.Uri.file(zephyrProject.appRootPath);
  const folder = vscode.workspace.getWorkspaceFolder(folderUri);
  const cfg = vscode.workspace.getConfiguration(
    ZEPHYR_WORKBENCH_SETTING_SECTION_KEY,
    folder ?? undefined
  );

  const toolchainEnv = getSelectedToolchainVariantEnv(cfg, folder ?? zephyrProject.appWorkspaceFolder);

  // Add the venv Python to PATH so MCUBoot can find dependencies
  const venvPath = getConfiguredVenvPath(folder ?? zephyrProject.appWorkspaceFolder) ?? '';

  const command =
  `west build` +
  ` --board ${buildConfig.boardIdentifier}` +
  ` --build-dir "${buildDir}"${sysbuildFlag}${snippetsFlag}` +
  ` "${zephyrProject.appRootPath}"` +
  (westArgs ? ` ${westArgs}` : '');

    const baseEnv = { ...normEnvVars, ...(activeZephyrSdkInstallation?.buildEnv ?? {}), ...westWorkspace.buildEnv, ...toolchainEnv };

    // If sysbuild, prepend venv Python to PATH so MCUBoot can find pykwalify and other deps
    const env = venvPath && sysbuildEnabled
      ? {
          ...baseEnv,
          PATH: process.platform === 'win32'
            ? `${path.join(venvPath, 'Scripts')};${baseEnv.PATH ?? ''}`
            : `${path.join(venvPath, 'bin')}:${baseEnv.PATH ?? ''}`
        }
      : baseEnv;

    const options: vscode.ShellExecutionOptions = {
      cwd        : westWorkspace.kernelUri.fsPath,
      env        : env,
      executable : getShellExe(),
      shellArgs  : getShellArgs(classifyShell(getShellExe()))
    };

    await execShellTaskWithEnvAndWait(
      `West build for ${zephyrProject.appName}`,
      command,
      options
    );
}

async function runWestSpdxCommand(
  label: string,
  zephyrProject: ZephyrApplication,
  westWorkspace: WestWorkspace,
  buildConfig: ZephyrBuildConfig,
  init = false,
): Promise<void> {
  if (!zephyrProject.appRootPath) {
    return;
  }

  const shellKind = classifyShell(getShellExe());
  const buildDir = formatShellPathArg(shellKind, buildConfig.getBuildDir(zephyrProject));
  const command = `west spdx${init ? ' --init' : ''} --build-dir ${buildDir}`;

  await execShellTaskWithEnvAndWait(
    label,
    command,
    getWestWorkspaceShellOptions(zephyrProject, westWorkspace),
  );
}

export async function westSpdxInitCommand(
  zephyrProject: ZephyrApplication,
  westWorkspace: WestWorkspace,
  buildConfig: ZephyrBuildConfig,
): Promise<void> {
  await runWestSpdxCommand(
    `SPDX init for ${zephyrProject.appName}`,
    zephyrProject,
    westWorkspace,
    buildConfig,
    true,
  );
}

export async function westSpdxGenerateCommand(
  zephyrProject: ZephyrApplication,
  westWorkspace: WestWorkspace,
  buildConfig: ZephyrBuildConfig,
): Promise<void> {
  await runWestSpdxCommand(
    `SPDX generate for ${zephyrProject.appName}`,
    zephyrProject,
    westWorkspace,
    buildConfig,
    false,
  );
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
 *
 * @param zephyrProject  The project the user has opened.
 * @param westWorkspace  The West workspace detected from west.yml.
 * @param target         "menuconfig" (TUI), "guiconfig" (GUI) or
 *                       "hardenconfig".
 */
export async function westConfigCommand(
  zephyrProject : ZephyrApplication,
  westWorkspace : WestWorkspace,
  target: "menuconfig" | "guiconfig" | "hardenconfig" = "menuconfig"
): Promise<void> {

  const buildConfig =
    zephyrProject.buildConfigs.find(cfg => cfg.active) ?? zephyrProject.buildConfigs[0];
  if (!buildConfig?.boardIdentifier || !zephyrProject.appRootPath) {
    return;                                        
  }

  const activeZephyrSdkInstallation = tryGetZephyrSdkInstallation(zephyrProject.zephyrSdkPath);

  const shellKind = classifyShell(getShellExe());
  const buildDir = normalizePathForShell(shellKind,
    path.join(zephyrProject.appRootPath, "build", buildConfig.name)
  );

  let command =
      `west build -t ${target}` +
      ` --board ${buildConfig.boardIdentifier}` +
      ` --build-dir "${buildDir}"`;

  if (target !== "hardenconfig") {
    const folderPath = normalizePathForShell(shellKind, zephyrProject.appRootPath);
    command += ` ${folderPath}`;
  }

  const westArgs = makeWestArgs(zephyrProject);
  if (westArgs) {
    command += ` ${westArgs}`;
  }

  const options: vscode.ShellExecutionOptions = {
    env: { ...(activeZephyrSdkInstallation?.buildEnv ?? {}), ...westWorkspace.buildEnv, ...getSelectedToolchainVariantEnv(vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, zephyrProject.appWorkspaceFolder), zephyrProject.appWorkspaceFolder) },
    cwd: westWorkspace.kernelUri.fsPath,
    executable: getShellExe(),
    shellArgs : getShellArgs(classifyShell(getShellExe()))
  };

  await execShellTaskWithEnvAndWait(
    `West ${target} for ${zephyrProject.appName}`,
    command,
    options
  );
}

export async function westFlashCommand(zephyrProject: ZephyrApplication, westWorkspace: WestWorkspace): Promise<void> {
  let buildConfig;
  for (let cfg of zephyrProject.buildConfigs) {
    if (cfg.active === true) {
      buildConfig = cfg;
      break;
    }
  }
  if (buildConfig === undefined) {
    buildConfig = zephyrProject.buildConfigs[0];
  }

  let buildDir = normalizePath(path.join(zephyrProject.appRootPath, 'build', buildConfig.boardIdentifier));

  let command = `west flash --build-dir ${buildDir}`;
  const activeZephyrSdkInstallation = tryGetZephyrSdkInstallation(zephyrProject.zephyrSdkPath);

  let options: vscode.ShellExecutionOptions = {
    env: { ...(activeZephyrSdkInstallation?.buildEnv ?? {}), ...westWorkspace.buildEnv, ...getSelectedToolchainVariantEnv(vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, zephyrProject.appWorkspaceFolder), zephyrProject.appWorkspaceFolder) },
    cwd: westWorkspace.kernelUri.fsPath
  };

  await execWestCommand(`West flash for ${zephyrProject.appName}`, command, options);
}

export async function westDebugCommand(zephyrProject: ZephyrApplication, westWorkspace: WestWorkspace): Promise<void> {
  let buildConfig;
  for (let cfg of zephyrProject.buildConfigs) {
    if (cfg.active === true) {
      buildConfig = cfg;
      break;
    }
  }
  if (buildConfig === undefined) {
    buildConfig = zephyrProject.buildConfigs[0];
  }

  let buildDir = normalizePath(path.join(zephyrProject.appRootPath, 'build', buildConfig.boardIdentifier));
  let command = `west debug --build-dir ${buildDir}`;

  let options: vscode.ShellExecutionOptions = {
    env: westWorkspace.buildEnv,
    cwd: westWorkspace.kernelUri.fsPath
  };

  await execWestCommand(`West debug for ${zephyrProject.appName}`, command, options);
}

/**
 * Execute a West command, the west command is prepend with a command to source the environment script
 * @param cmdName The command name
 * @param cmd     The west command
 * @param options The shell execution option (if no cwd, ${workspaceFolder} is default)
 * @returns 
 */
export async function execWestCommand(cmdName: string, cmd: string, options: vscode.ShellExecutionOptions) {
  await execShellCommandWithEnv(cmdName, cmd, options);
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
