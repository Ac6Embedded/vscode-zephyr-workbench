import { ChildProcess, exec, spawn, ExecOptions } from 'child_process';
import * as fs from 'fs';
import path from 'path';
import * as vscode from 'vscode';
import { WestWorkspace } from '../models/WestWorkspace';
import { ZephyrAppProject } from '../models/ZephyrAppProject';
import { ZephyrProject } from '../models/ZephyrProject';
import { ZephyrSDK } from '../models/ZephyrSDK';
import { ZephyrProjectBuildConfiguration } from '../models/ZephyrProjectBuildConfiguration';
import { ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY } from '../constants';
import { concatCommands, execShellCommandWithEnv, execCommandWithEnvCB, getShell, getShellNullRedirect, getShellIgnoreErrorCommand, getShellSourceCommand, execShellCommandWithEnvInteractive, getShellExe, classifyShell, getShellArgs, normalizePathForShell, execShellTaskWithEnvAndWait, isCygwin, normalizeEnvVarsForShell, RawEnvVars } from '../utils/execUtils';
import { fileExists, findIarEntry, getWestWorkspace, getZephyrSDK, normalizePath } from '../utils/utils'; 

function quote(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

export function registerWestCommands(context: vscode.ExtensionContext): void {
  // TODO use this function to register every west command 
  // for better code structure
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
  zephyrProject : ZephyrProject,
  westWorkspace : WestWorkspace,
  buildConfig?  : ZephyrProjectBuildConfiguration
): Promise<string | undefined> {

  if (!buildConfig?.boardIdentifier || !zephyrProject.folderPath) {
    return undefined;
  }

  const activeSdk = getZephyrSDK(zephyrProject.sdkPath);
  if (!activeSdk) {
    throw new Error('The Zephyr SDK is missing, please install host tools first');
  }

  const shellKind = classifyShell(getShellExe());

  const tmpPath = normalizePathForShell(shellKind, path.join(zephyrProject.folderPath, '.tmp'));

  const westArgs = makeWestArgs(buildConfig.westArgs);

  const rawEnvVars = buildConfig.envVars as RawEnvVars;
  const normEnvVars = normalizeEnvVarsForShell(rawEnvVars, shellKind);

  const redirect = getShellNullRedirect(shellKind);

  const command  = [
    'west build',
    '-t boards',
    '--cmake-only',
    `--board 96b_aerocore2`,
    `--build-dir ${quote(tmpPath)}`,
    quote(normalizePathForShell(shellKind,zephyrProject.folderPath)),
    (westArgs ? ` ${westArgs}` : ''),
    redirect,
  ].filter(Boolean).join(' ');

  const options: vscode.ShellExecutionOptions = {
    cwd        : zephyrProject.folderPath,
    env        : {
      ...buildConfig.envVars,
      ...activeSdk.buildEnv,
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

export async function westBuildCommand(zephyrProject: ZephyrProject, westWorkspace: WestWorkspace, extraWestArgs = ''): Promise<void> {
  let buildConfig;
  const shellKind = classifyShell(getShellExe());
  for (let cfg of zephyrProject.configs) {
    if (cfg.active === true) {
      buildConfig = cfg;
      break;
    }
  }
  if (buildConfig === undefined) {
    buildConfig = zephyrProject.configs[0];
  }

  if (buildConfig.boardIdentifier === undefined || zephyrProject.folderPath === undefined) {
    return;
  }

  let activeSdk: ZephyrSDK = getZephyrSDK(zephyrProject.sdkPath);
  if (!activeSdk) {
    throw new Error('The Zephyr SDK is missing, please install host tools first');
  }
  let buildDir = normalizePathForShell(shellKind, path.join(zephyrProject.folderPath, 'build', buildConfig.name));
  const westArgs = makeWestArgs(extraWestArgs);

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

  const folderUri = vscode.Uri.file(zephyrProject.folderPath);
  const folder = vscode.workspace.getWorkspaceFolder(folderUri);
  const cfg = vscode.workspace.getConfiguration(
    ZEPHYR_WORKBENCH_SETTING_SECTION_KEY,
    folder ?? undefined
  );

  const toolchainKind = (cfg.get<string>('toolchain') ?? 'sdk').toLowerCase();
  let iarEnv: Record<string, string> = {};

  if (toolchainKind === 'iar') {
    const selectedIarPath = cfg.get<string>('iar', '');
    const iarEntry = findIarEntry(selectedIarPath);

    if (iarEntry) {
      const armSubdir =
        process.platform === 'win32'
          ? path.join(iarEntry.iarPath, 'arm')
          : path.posix.join(iarEntry.iarPath, 'arm');

      iarEnv = {
        IAR_TOOLCHAIN_PATH: armSubdir,
        ZEPHYR_TOOLCHAIN_VARIANT: 'iar',
        IAR_LMS_BEARER_TOKEN: iarEntry.token ?? ''
      };
    }
  }

  const command =
  `west build -p always` +
  ` --board ${buildConfig.boardIdentifier}` +
  ` --build-dir "${buildDir}"${sysbuildFlag}${snippetsFlag}` +
  ` "${zephyrProject.folderPath}"` +
  (westArgs ? ` ${westArgs}` : '');

    const options: vscode.ShellExecutionOptions = {
      cwd        : westWorkspace.kernelUri.fsPath,
      env        : { ...normEnvVars, ...activeSdk.buildEnv, ...westWorkspace.buildEnv, ...iarEnv },
      executable : getShellExe(),
      shellArgs  : getShellArgs(classifyShell(getShellExe()))
    };

    await execShellTaskWithEnvAndWait(
      `West build for ${zephyrProject.folderName}`,
      command,
      options
    );
}

function makeWestArgs(raw: string | undefined): string {
  if (!raw?.trim()) {return '';}
  return raw.trim().startsWith('--') ? raw.trim() : `-- ${raw.trim()}`;
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
  zephyrProject : ZephyrProject,
  westWorkspace : WestWorkspace,
  target: "menuconfig" | "guiconfig" | "hardenconfig" = "menuconfig"
): Promise<void> {

  const buildConfig =
    zephyrProject.configs.find(cfg => cfg.active) ?? zephyrProject.configs[0];
  if (!buildConfig?.boardIdentifier || !zephyrProject.folderPath) {
    return;                                        
  }

  const activeSdk = getZephyrSDK(zephyrProject.sdkPath);
  if (!activeSdk) {
    throw new Error("The Zephyr SDK is missing, please install host tools first");
  }

  const shellKind = classifyShell(getShellExe());
  const buildDir = normalizePathForShell(shellKind,
    path.join(zephyrProject.folderPath, "build", buildConfig.name)
  );

  let command =
      `west build -t ${target}` +
      ` --board ${buildConfig.boardIdentifier}` +
      ` --build-dir "${buildDir}"`;

  if (target !== "hardenconfig") {
    const folderPath = normalizePathForShell(shellKind, zephyrProject.folderPath);
    command += ` ${folderPath}`;
  }

  const options: vscode.ShellExecutionOptions = {
    env: { ...activeSdk.buildEnv, ...westWorkspace.buildEnv },
    cwd: westWorkspace.kernelUri.fsPath,
    executable: getShellExe(),
    shellArgs : getShellArgs(classifyShell(getShellExe()))
  };

  await execShellTaskWithEnvAndWait(
    `West ${target} for ${zephyrProject.folderName}`,
    command,
    options
  );
}

export async function westFlashCommand(zephyrProject: ZephyrProject, westWorkspace: WestWorkspace): Promise<void> {
  let buildConfig;
  for (let cfg of zephyrProject.configs) {
    if (cfg.active === true) {
      buildConfig = cfg;
      break;
    }
  }
  if (buildConfig === undefined) {
    buildConfig = zephyrProject.configs[0];
  }

  let buildDir = normalizePath(path.join(zephyrProject.folderPath, 'build', buildConfig.boardIdentifier));
  let command = `west flash --build-dir ${buildDir}`;
  let activeSdk: ZephyrSDK = getZephyrSDK(zephyrProject.sdkPath);

  if (!activeSdk) {
    throw new Error('The Zephyr SDK is missing, please install host tools first');
  }

  let options: vscode.ShellExecutionOptions = {
    env: { ...activeSdk.buildEnv, ...westWorkspace.buildEnv },
    cwd: westWorkspace.kernelUri.fsPath
  };

  await execWestCommand(`West flash for ${zephyrProject.folderName}`, command, options);
}

export async function westDebugCommand(zephyrProject: ZephyrProject, westWorkspace: WestWorkspace): Promise<void> {
  let buildConfig;
  for (let cfg of zephyrProject.configs) {
    if (cfg.active === true) {
      buildConfig = cfg;
      break;
    }
  }
  if (buildConfig === undefined) {
    buildConfig = zephyrProject.configs[0];
  }

  let buildDir = normalizePath(path.join(zephyrProject.folderPath, 'build', buildConfig.boardIdentifier));
  let command = `west debug --build-dir ${buildDir}`;

  let options: vscode.ShellExecutionOptions = {
    env: westWorkspace.buildEnv,
    cwd: westWorkspace.kernelUri.fsPath
  };

  await execWestCommand(`West debug for ${zephyrProject.folderName}`, command, options);
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

export async function getBoardsDirectories(parent: ZephyrAppProject | WestWorkspace, boardRoots?: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let cmd = 'west boards -f "{dir}"';
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

      const candidates = stdout
        .split(/\r?\n/)
        .map(s => s.trim().replace(/^"+|"+$/g, ''))
        .filter(s => s.length > 0);

      // Use VS Code FS stat to verify existence and directory type
      // Filter any echoes in environment scripts that are not directories
      const results = await Promise.all(candidates.map(async (p) => {
        try {
          const uri = vscode.Uri.file(p);
          const st = await vscode.workspace.fs.stat(uri);
          return (st.type & vscode.FileType.Directory) === vscode.FileType.Directory ? p : null;
        } catch {
          return null;
        }
      }));

      const boardDirs = results.filter((p): p is string => !!p);
      resolve(boardDirs);
    });
  });
}

/**
 * Executes the "west shields" command and returns an array of shield names.
 * @param parent The ZephyrAppProject or WestWorkspace instance.
 * @returns A promise that resolves with the list of supported shield names.
 */
export async function getSupportedShields(
  parent: ZephyrAppProject | WestWorkspace,
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
  parent: ZephyrAppProject | WestWorkspace,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const ws =
      parent instanceof ZephyrAppProject
        ? getWestWorkspace(parent.westWorkspacePath)
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

export async function getBoardsDirectoriesFromIdentifier(boardIdentifier: string, parent: ZephyrAppProject | WestWorkspace, boardRoots?: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let boardName = boardIdentifier;
    if (boardIdentifier) {
      const regex = /^([^@\/]+)(?:@([^\/]+))?(?:\/([^\/]+)(?:\/([^\/]+)(?:\/([^\/]+))?)?)?$/;
      const match = boardIdentifier.match(regex);

      if (!match) {
        reject(`Error: Identifier format invalid for: ${boardIdentifier}`);
      } else {
        boardName = match[1];
      }
    }

    let cmd = `west boards --board ${boardName} -f "{dir}"`;
    if (boardRoots) {
      for (let boardRoot of boardRoots) {
        if (boardRoot.length > 0) {
          let normalizeBoardRoot = normalizePath(boardRoot);
          cmd += ` --board-root ${normalizeBoardRoot}`;
        }
      }
    }
    execWestCommandWithEnv(cmd, parent, (error: any, stdout: string, stderr: any) => {
      if (error) {
        reject(`Error: ${stderr}`);
      }

      let separator = '\n';
      if (process.platform === 'win32') {
        separator = '\r\n';
      }

      const boardDirs = stdout
        .trim()
        .split(separator);
      resolve(boardDirs);
    });
  });
}

export function execWestCommandWithEnv(
  cmd: string,
  parent: ZephyrAppProject | WestWorkspace,
  callback?: (error: Error | null, stdout: string, stderr: string) => void
): ChildProcess {
  const rawEnv = vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
    .get<string>(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY)!;
  const venvPath = vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
    .get<string>(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY);

  if (!rawEnv) {throw new Error('Missing Zephyr env script');}
  if (venvPath && !fileExists(venvPath)) {throw new Error('Invalid venv path');}

  // build cwd + env
  const options: any = { env: { ...process.env }, cwd: '' };
  if (parent instanceof ZephyrAppProject) {
    const sdk = getZephyrSDK(parent.sdkPath);
    const ws = getWestWorkspace(parent.westWorkspacePath);
    options.cwd = parent.folderPath;
    options.env = { ...options.env, ...sdk.buildEnv, ...ws.buildEnv, ...parent.getBuildConfiguration };
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
  const envScript = normalizePathForShell(shellKind, rawEnv);
  const redirect = getShellNullRedirect(shellKind);
  const sourceCmd = getShellSourceCommand(shellKind, envScript);
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
  parent: ZephyrAppProject | WestWorkspace
): Promise<void> {

  /* settings ------------------------------------------------------------ */
  const envScript = vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
    .get<string>(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);

  const venvPath = vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
    .get<string>(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY);

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

  if (parent instanceof ZephyrAppProject) {
    const project = parent;
    const activeSdk = getZephyrSDK(project.sdkPath);
    const westWorkspace = getWestWorkspace(project.westWorkspacePath);
    const buildEnv = project.getBuildConfiguration;

    options.cwd = project.folderPath;
    options.env = {
      ...options.env,
      ...activeSdk.buildEnv,
      ...westWorkspace.buildEnv,
      ...buildEnv
    };
  } else {
    const westWorkspace = parent as WestWorkspace;
    options.cwd = westWorkspace.rootUri.fsPath;
    options.env = { ...options.env, ...westWorkspace.buildEnv };
  }

  const shellKind = classifyShell(getShellExe());
  const redirect = getShellNullRedirect(shellKind);
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
