import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { compareVersions, fileExists } from './utils';
import {
  ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY,
  ZEPHYR_WORKBENCH_SETTING_SECTION_KEY,
  ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY
} from './constants';
import {
  ChildProcess, ExecException, ExecOptions, SpawnOptions,
  exec, spawn
} from 'child_process';

let _channel: vscode.OutputChannel;
const pyOCDOutput = vscode.window.createOutputChannel('pyOCD');

/* helpers */

export function concatCommands(shell: string, ...cmds: string[]): string {
  switch (shell) {
    case 'bash':
    case 'zsh':
    case 'dash':
    case 'fish':
    case 'cmd.exe':
      return cmds.join(' && ');
    case 'powershell.exe':
      return cmds.join('; ');
    default:
      return cmds.join(' && ');
  }
}

export function getEnvVarFormat(shell: string, env: string): string {
  switch (shell) {
    // POSIX-like shells
    case 'bash':
    case 'zsh':
    case 'dash':
    case 'fish':
      return `$\{${env}\}`;
    case 'cmd.exe':
      return `%${env}%`;
    case 'powershell.exe':
      return `$env:${env}`;
    default:
      return `$${env}`;
  }
}

export function getShell(): string {
  if (process.platform === 'win32') {
    return 'cmd.exe';
  }
  return 'bash';
}

export function getResolvedShell(): { path: string; args?: string[] } {

  const prof = detectTerminalProfile();
  if (prof?.exe) {
    return { path: prof.exe, args: prof.args };
  }

  if (vscode.env.shell) {
    return { path: vscode.env.shell };
  }

  return {
    path: process.platform === 'win32'
      ? 'C:\\Windows\\System32\\cmd.exe'
      : '/bin/bash'
  };
}

export function classifyShell(shellPath: string):
  'bash' | 'zsh' | 'fish' | 'dash' | 'cmd.exe' | 'powershell.exe' {

  const exe = path.basename(shellPath).toLowerCase();

  if (exe.includes('zsh')) { return 'zsh'; }
  if (exe.includes('fish')) { return 'fish'; }
  if (exe.includes('dash')) { return 'dash'; }
  if (exe.includes('bash')) { return 'bash'; }
  if (exe.includes('powershell')) { return 'powershell.exe'; }
  if (exe.includes('cmd')) { return 'cmd.exe'; }
  /* default for unknown POSIX shells */
  return 'bash';
}

export function normalizePathForShell(shellType: string, p: string): string {
  let out = p;

  if (shellType === 'bash' || shellType === 'zsh' ||
    shellType === 'dash' || shellType === 'fish') {

    out = out.replace(/\.(bat|ps1)$/i, '.sh')
      .replace(/%(\w+)%/g, '${$1}');

  } else if (shellType === 'powershell.exe') {

    out = out.replace(/\.(bat|sh)$/i, '.ps1')
      .replace(/%(\w+)%/g, '$env:$1')
      .replace(/\$\{(\w+)\}/g, '$env:$1');
  }

  if (shellType === 'bash' || shellType === 'zsh' ||
    shellType === 'dash' || shellType === 'fish') {
    out = out.replace(/\\/g, '/');
    if (/\s/.test(out)) { out = `"${out}"`; }
  }
  return out;
}

export function normalisePathsInString(kind: string, text: string): string {
  if (!text) { return text; }
  if (kind === 'cmd.exe' || kind === 'powershell.exe') { return text; }

  return text.replace(/\\/g, '/');
}

export type RawEnvVars = { [key: string]: string | string[] };

export function normalizeEnvVarsForShell(
  rawEnv: RawEnvVars,
  shellKind: string
): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  for (const [key, val] of Object.entries(rawEnv)) {
    if (typeof val === 'string') {
      out[key] = normalizePathForShell(shellKind, val);
    } else if (Array.isArray(val)) {
      const normalized = val.map(entry => normalizePathForShell(shellKind, entry));
      // join with platform‐appropriate delimiter
      out[key] = normalized.join(path.delimiter);
    }
  }
  return out;
}


export function getTerminalShell(): string {
  const prof = detectTerminalProfile();
  if (prof) {
    return prof.kind;
  }
  return process.platform === 'win32' ? 'powershell.exe' : 'bash';
}

function detectTerminalProfile():
  | {
    kind: 'bash' | 'cmd.exe' | 'powershell.exe';
    exe: string;
    args?: string[];
    env?: Record<string, string>;
  }
  | undefined {
  if (process.platform !== 'win32') {
    return undefined;
  }

  const termCfg = vscode.workspace.getConfiguration('terminal.integrated');
  const profName = termCfg.get<string>('defaultProfile.windows');
  const profiles = termCfg.get<any>('profiles.windows');

  if (!profName || !profiles?.[profName]) {
    return undefined;
  }

  const entry = profiles[profName];
  const exe = String(entry.path ?? '');
  const low = exe.toLowerCase();

  const kind =
    low.includes('bash') ? 'bash' :
      low.includes('powershell') ? 'powershell.exe' :
        'cmd.exe';

  return {
    kind,
    exe,
    args: entry.args as string[] | undefined,
    env: entry.env as Record<string, string> | undefined
  };
}

export function winToPosixPath(p: string): string {
  if (process.platform !== 'win32') {
    return p;
  }
  const withSlashes = p.replace(/\\/g, '/');
  return withSlashes.replace(/^([A-Za-z]):/, (_m, d) => `/cygdrive/${d.toLowerCase()}`);
}

export function getShellExe(): string {
  return getResolvedShell().path;
}

export function getShellProfileArgs(): string[] | undefined {
  return getResolvedShell().args;
}

function getProfileEnv(): Record<string, string> | undefined {
  return detectTerminalProfile()?.env;
}

export function getShellArgs(shell: string): string[] {
  switch (shell) {
    case 'bash':
    case 'zsh':
    case 'dash':
    case 'fish':
      return ['-c'];
    case 'cmd.exe':
      return ['/d', '/c'];
    case 'powershell.exe':
      return ['-Command'];
    default:
      return [];
  }
}

export function getShellNullRedirect(shell: string): string {
  switch (shell) {
    case 'bash':
    case 'zsh':
    case 'dash':
    case 'fish':
      return '> /dev/null 2>&1';
    case 'cmd.exe':
      return '> NUL 2>&1';
    case 'powershell.exe':
      return '> $null 2>&1';
    default:
      return '';
  }
}

export function getShellIgnoreErrorCommand(shell: string): string {
  switch (shell) {
    case 'bash':
    case 'sh':
    case 'zsh':
      return '> /dev/null 2>&1 || true';
    case 'cmd.exe':
      return '> NUL 2>&1 || exit 0';
    case 'powershell.exe':
      return '> $null 2>&1; exit 0';
    default:
      return '';
  }
}

export function getShellSourceCommand(shell: string, script: string): string {
  switch (shell) {
    case 'bash':
    case 'zsh':
    case 'dash':
    case 'fish':
      return `. ${script}`;
    case 'cmd.exe':
      return `call ${script}`;
    case 'powershell.exe':
      return `. ${script}`;
    default:
      return '';
  }
}

export function getShellEchoCommand(shell: string): string {
  switch (shell) {
    case 'bash':
    case 'cmd.exe':
      return 'echo';
    case 'powershell.exe':
      return 'Write-Output';
    default:
      return 'echo';
  }
}

export function getShellClearCommand(shell: string): string {
  switch (shell) {
    case 'bash':
    case 'zsh':
      return 'clear';
    case 'cmd.exe':
    case 'powershell.exe':
      return 'cls';
    default:
      return '';
  }
}

export function getOutputChannel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel('Ac6 Zephyr Workbench');
  }
  return _channel;
}

export function expandEnvVariables(input: string): string {
  const envVariableRegex = /\$(\w+)|\$\{(\w+)\}|@(\w+)@|%(\w+)%/g;
  return input.replace(envVariableRegex, (_, v1, v2, v3, v4) => {
    const name = v1 || v2 || v3 || v4;
    return process.env[name] || '';
  });
}

export async function executeTask(task: vscode.Task): Promise<vscode.TaskExecution> {
  const exec = await vscode.tasks.executeTask(task);
  return new Promise(resolve => {
    const disp = vscode.tasks.onDidEndTask(e => {
      if (e.execution.task.name === task.name) {
        disp.dispose();
        resolve(e.execution);
      }
    });
  });
}

export async function execShellCommandInteractive(
  cmdName: string,
  cmd: string,
  options: vscode.ShellExecutionOptions = {}
): Promise<vscode.Terminal> {

  if (!cmd) {
    throw new Error('Missing command to execute');
  }

  const shellPath = options.executable ?? getShellExe();      // helpers from your utils
  const shellArgs = options.shellArgs;
  const terminalEnv = { ...process.env, ...options.env };

  const termOpts: vscode.TerminalOptions = {
    name: cmdName,
    cwd: options.cwd,
    env: terminalEnv,
    shellPath,
    shellArgs,
    iconPath: new vscode.ThemeIcon('terminal')
  };

  const term = vscode.window.createTerminal(termOpts);
  term.show(true);

  term.sendText(cmd, true);

  return term;
}

export function isCygwin(shellPath: string): boolean {
  return /\\cygwin[^\\]*\\bin\\bash.exe$/i.test(shellPath);
}

export async function execShellCommand(
  cmdName: string,
  cmd: string,
  options: vscode.ShellExecutionOptions
) {
  if (!cmd) {
    throw new Error('Missing command to execute');
  }

  const shExec = new vscode.ShellExecution(cmd, options);
  const task = new vscode.Task(
    { label: cmdName, type: 'shell' },
    vscode.TaskScope.Workspace,
    cmdName,
    'Zephyr Workbench',
    shExec
  );
  task.presentationOptions.echo = false;
  await executeTask(task);
}

export async function execShellCommandWithEnv(
  cmdName: string,
  cmd: string,
  options: vscode.ShellExecutionOptions
) {
  const rawEnvScript = vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
    .get<string>(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
  const rawActivatePath = vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
    .get<string>(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY);

  const envScript = normalizePathForShell(classifyShell(getShellExe()), rawEnvScript ?? '');
  const activatePath = rawActivatePath ? normalizePathForShell(classifyShell(getShellExe()), rawActivatePath) : undefined;

  if (!envScript) {
    throw new Error(
      'Missing Zephyr environment script.',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` }
    );
  }
  if (!cmd) {
    throw new Error('Missing command to execute', { cause: 'missing.command' });
  }
  if (activatePath && !fileExists(activatePath)) {
    throw new Error(
      'Invalid Python virtual environment.',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY}` }
    );
  }

  const shellKind = classifyShell(getShellExe());
  const exe = getShellExe();
  options.executable = exe;
  options.shellArgs = getShellArgs(shellKind);

  options.env = {
    ...getProfileEnv(),
    ...options.env,
    ...(activatePath ? { PYTHON_VENV_ACTIVATE_PATH: activatePath } : {})
  };

  const redirect = getShellNullRedirect(shellKind);
  const cmdEnv = `${getShellSourceCommand(shellKind, envScript)} ${redirect}`;
  await execShellCommand(cmdName, concatCommands(shellKind, cmdEnv, cmd), options);
}

export async function execShellCommandWithEnvInteractive(
  cmdName: string,
  cmd: string,
  options: vscode.ShellExecutionOptions = {}
) {

  const cfg = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY);
  const envScriptRaw = cfg.get<string>(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
  const venvRaw = cfg.get<string>(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY);

  if (!envScriptRaw) {
    throw new Error(
      'Missing Zephyr environment script.',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` }
    );
  }
  if (venvRaw && !fileExists(venvRaw)) {
    throw new Error(
      'Invalid Python virtual environment.',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY}` }
    );
  }

  const shellPath = options.executable ?? getShellExe();
  const shellKind = classifyShell(shellPath);
  let shellArgs = options.shellArgs;

  if (!shellArgs && isCygwin(shellPath)) {
    shellArgs = ['--login', '-i'];
  }

  const needsChere = isCygwin(shellPath);

  const isPosixish =
    shellKind === 'bash' || shellKind === 'zsh' ||
    shellKind === 'dash' || shellKind === 'fish';

  const norm = (p?: string) =>
    p ? normalizePathForShell(shellKind, p) : p;

  const envScript = normalizePathForShell(shellKind, envScriptRaw!);
  const venvPath = venvRaw ? normalizePathForShell(shellKind, venvRaw!) : undefined;

  if (isPosixish) {
    cmd = normalisePathsInString(shellKind, cmd);
    if (options.cwd) {
      options.cwd = normalisePathsInString(shellKind, options.cwd);
    }
    if (options.env) {
      for (const k of Object.keys(options.env)) {
        const v = options.env[k];
        if (typeof v === 'string') {
          options.env[k] = normalisePathsInString(shellKind, v);
        }
      }
    }
  }

  const redirect = getShellNullRedirect(shellKind);
  const cmdEnv = `${getShellSourceCommand(shellKind, envScript)} ${redirect}`;
  const fullCmd = concatCommands(shellKind, cmdEnv, cmd);

  options.env = {
    ...(needsChere ? { CHERE_INVOKING: '1' } : {}),
    ...getProfileEnv(),
    ...options.env,
    ...(venvPath ? { PYTHON_VENV_ACTIVATE_PATH: venvPath } : {})
  };

  return execShellCommandInteractive(cmdName, fullCmd, {
    ...options,
    executable: shellPath,
    shellArgs
  });
}


export async function execCommandWithEnv(
  cmd: string,
  cwd?: string,
  cb?: (e: ExecException | null, so: string, se: string) => void
): Promise<ChildProcess> {
  const rawEnvScript = vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
    .get<string>(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
  const rawActivatePath = vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
    .get<string>(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY);

  const envScript = normalizePathForShell(classifyShell(getShellExe()), rawEnvScript ?? '');
  const activatePath = rawActivatePath ? normalizePathForShell(classifyShell(getShellExe()), rawActivatePath) : undefined;

  if (!envScript) {
    throw new Error(
      'Missing Zephyr environment script.',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` }
    );
  }
  if (activatePath && !fileExists(activatePath)) {
    throw new Error(
      'Invalid Python virtual environment.',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY}` }
    );
  }

  const options: ExecOptions = {
    cwd,
    env: {
      ...process.env,
      ...getProfileEnv(),
      ...(activatePath ? { PYTHON_VENV_ACTIVATE_PATH: activatePath } : {})
    },
    shell: getShellExe()
  };

  const shellKind = classifyShell(getShellExe());
  const redirect = getShellNullRedirect(shellKind);
  const cmdEnv = `${getShellSourceCommand(shellKind, envScript)} ${redirect}`;
  return exec(concatCommands(shellKind, cmdEnv, cmd), options, cb);
}

export function execCommandWithEnvCB(
  cmd: string,
  cwd?: string,
  options: ExecOptions = {},
  cb?: (e: ExecException | null, so: string, se: string) => void
): ChildProcess {
  const envScript = vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
    .get<string>(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
  const activatePath = vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
    .get<string>(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY);

  if (!envScript) {
    throw new Error(
      'Missing Zephyr environment script.',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` }
    );
  }
  if (activatePath && !fileExists(activatePath)) {
    throw new Error(
      'Invalid Python virtual environment.',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY}` }
    );
  }

  options.env = {
    ...getProfileEnv(),
    ...options.env,
    ...(activatePath ? { PYTHON_VENV_ACTIVATE_PATH: activatePath } : {})
  };
  if (cwd) {
    options.cwd = cwd;
  }
  options.shell = getShellExe();

  const shellKind = classifyShell(getShellExe());
  const redirect = getShellNullRedirect(shellKind);
  const cmdEnv = `${getShellSourceCommand(shellKind, envScript)} ${redirect}`;
  return exec(concatCommands(shellKind, cmdEnv, cmd), options, cb);
}

export function spawnCommandWithEnv(cmd: string, options: SpawnOptions = {}): ChildProcess {
  const envScript = vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
    .get<string>(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
  const activatePath = vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
    .get<string>(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY);

  if (!envScript) {
    throw new Error(
      'Missing Zephyr environment script.',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` }
    );
  }
  if (activatePath && !fileExists(activatePath)) {
    throw new Error(
      'Invalid Python virtual environment.',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY}` }
    );
  }

  options.env = {
    ...getProfileEnv(),
    ...options.env,
    ...(activatePath ? { PYTHON_VENV_ACTIVATE_PATH: activatePath } : {})
  };
  options.shell = getShellExe();

  const shellKind = classifyShell(getShellExe());
  const redirect = getShellNullRedirect(shellKind);
  const cmdEnv = `${getShellSourceCommand(shellKind, envScript)} ${redirect}`;
  return spawn(concatCommands(shellKind, cmdEnv, cmd), options);
}

export async function execShellTaskWithEnvAndWait(
  cmdName: string,
  cmd: string,
  options: vscode.ShellExecutionOptions = {},
  hideTerminal = false,
): Promise<void> {

  const envScriptRaw = vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
    .get<string>(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);

  if (!envScriptRaw) {
    throw new Error(
      'Missing Zephyr environment script.\n' +
      'Set “Zephyr Workbench > Path To Env Script” in Settings.'
    );
  }

  const exe = options.executable ?? getShellExe();
  const shellKind = classifyShell(exe);

  let shellArgs = options.shellArgs ?? getShellArgs(shellKind);

  if (isCygwin(exe)) {
    shellArgs = ['--login', '-i', ...shellArgs];
  }

  const needsChere = isCygwin(exe);


  const envScript = normalizePathForShell(shellKind, envScriptRaw);
  const redirect = getShellNullRedirect(shellKind);
  const cmdEnv = `${getShellSourceCommand(shellKind, envScript)} ${redirect}`;
  const fullCmd = concatCommands(shellKind, cmdEnv, cmd);

  const shExec = new vscode.ShellExecution(fullCmd, {
    ...options,
    executable: exe,
    shellArgs: shellArgs,
    env: { ...getProfileEnv(), ...(needsChere ? { CHERE_INVOKING: '1' } : {}), ...options.env }
  });

  const task = new vscode.Task(
    { label: cmdName, type: 'shell' },
    vscode.TaskScope.Workspace,
    cmdName,
    'Zephyr Workbench',
    shExec
  );
  task.presentationOptions.echo = false;

  if (hideTerminal) {
    task.presentationOptions.reveal = vscode.TaskRevealKind.Never;
    task.presentationOptions.showReuseMessage = false;
    task.presentationOptions.clear = false;
  }

  const exec = await vscode.tasks.executeTask(task);

  return new Promise<void>(resolve => {
    const disp = vscode.tasks.onDidEndTask(e => {
      if (e.execution === exec) {
        disp.dispose();
        resolve();
      }
    });
  });
}

export function getTerminalDefaultProfile(): string | undefined {
  const termCfg = vscode.workspace.getConfiguration('terminal.integrated');

  const key =
    process.platform === 'win32' ? 'defaultProfile.windows' :
      process.platform === 'darwin' ? 'defaultProfile.osx' :
        'defaultProfile.linux';
  return termCfg.get<string>(key);
}

/* git helpers */

export async function getGitTags(gitUrl: string): Promise<string[]> {
  const gitCmd = `git ls-remote --tags ${gitUrl}`;
  return new Promise((resolve, reject) => {
    execCommandWithEnv(gitCmd, undefined, (err, out, errStr) => {
      if (err) {
        reject(`Error: ${errStr}`);
        return;
      }
      const tags = out
        .trim()
        .split('\n')
        .filter(l => !l.includes('^{}'))
        .map(l => l.split('\t')[1].replace('refs/tags/', ''))
        .sort((a, b) => compareVersions(b, a));
      resolve(tags);
    });
  });
}

/* pyOCD helpers */

async function execPyOCD(cmd: string, cwd?: string): Promise<string> {
  pyOCDOutput.show(true);
  pyOCDOutput.clear();
  let full = '';

  const proc = await execCommandWithEnv(cmd, cwd);
  proc.stdout?.on('data', c => {
    const t = c.toString();
    full += t;
    pyOCDOutput.appendLine(t);
  });
  proc.stderr?.on('data', c => {
    const t = c.toString();
    full += t;
    pyOCDOutput.append(t);
  });

  return new Promise((res, rej) => {
    proc.on('error', e => {
      pyOCDOutput.appendLine(`\n ${e.message}`);
      rej(e);
    });
    proc.on('close', code => {
      if (code === 0) {
        res(full);
      } else {
        const e = new Error(`Process exited with code ${code}`);
        pyOCDOutput.appendLine(`\n ${e.message}`);
        rej(e);
      }
    });
  });
}

export async function getPyOCDTargets(): Promise<string[]> {
  const out = await execPyOCD('pyocd list --targets');
  return out.split('\n').slice(2).filter(l => l.trim()).map(l => l.trim().split(/\s+/)[0]);
}

export async function checkPyOCDTarget(name: string): Promise<boolean> {
  return (await getPyOCDTargets()).includes(name.trim());
}

export async function updatePyOCDPack(): Promise<string> {
  return execPyOCD('pyocd pack update');
}

export async function installPyOCDTarget(name: string): Promise<string> {
  return execPyOCD(`pyocd pack install ${name}`);
}