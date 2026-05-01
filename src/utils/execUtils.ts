import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { compareVersions, fileExists } from './utils';
import {
  ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY,
  ZEPHYR_WORKBENCH_SETTING_SECTION_KEY,
  ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY
} from '../constants';
import {
  ChildProcess, ExecException, ExecOptions, SpawnOptions,
  exec, spawn
} from 'child_process';
import { writeWestBuildState, WestBuildState } from './zephyr/westBuildState';

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
    case 'pwsh.exe':
      return cmds.join(' ; ');
    default:
      return cmds.join(' ; ');
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
    case 'pwsh.exe':
      return `$env:${env}`;
    default:
      return `$${env}`;
  }
}

// Returns the kind of shell the user has configured (e.g. 'zsh', 'pwsh.exe').
// Used for shell-specific syntax branching; pair with getShellExe() when you need the actual path.
export function getShell(): string {
  return classifyShell(getShellExe());
}

export function getResolvedShell(): { path: string; args?: string[] } {

  const prof = detectTerminalProfile();
  if (prof?.exe) {
    return { path: prof.exe, args: prof.args };
  }

  // `vscode.env.shell` reports the user's configured login shell — on modern macOS
  // that's /bin/zsh, on Linux whatever the user picked. Trust it before falling back.
  if (vscode.env.shell) {
    return { path: vscode.env.shell };
  }

  return {
    path: process.platform === 'win32'
      ? 'C:\\Windows\\System32\\cmd.exe'
      : process.platform === 'darwin'
        ? '/bin/zsh'
        : '/bin/bash'
  };
}

export function classifyShell(shellPath: string):
  'bash' | 'zsh' | 'fish' | 'dash' | 'cmd.exe' | 'powershell.exe' | 'pwsh.exe' {

  const exe = path.basename(shellPath).toLowerCase();

  if (exe.includes('pwsh')) { return 'pwsh.exe'; }
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

  } else if (shellType === 'powershell.exe' || shellType === 'pwsh.exe') {

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

export type ConfigurationScope = vscode.WorkspaceFolder | vscode.Uri | URL | string;

const WORKSPACE_FOLDER_VARIABLE = '${workspaceFolder}';
const USER_HOME_VARIABLE = '${userHome}';
const PORTABLE_MODE_VARIABLE = '${env:VSCODE_PORTABLE}';
const MAX_CONFIG_VARIABLE_DEPTH = 10;

interface VariableResolutionState {
  depth: number;
  seenConfigKeys: Set<string>;
}

export function buildWorkbenchSettingKey(settingKey: string): string {
  return `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${settingKey}`;
}

export function getConfigurationResource(
  scope?: ConfigurationScope,
): vscode.Uri | undefined {
  if (typeof scope === 'string') {
    return vscode.Uri.file(scope);
  }
  if (scope instanceof URL) {
    return vscode.Uri.parse(scope.toString());
  }
  if (scope instanceof vscode.Uri) {
    return scope;
  }
  return scope?.uri;
}

export function getWorkspaceFolderForScope(
  scope?: ConfigurationScope,
): vscode.WorkspaceFolder | undefined {
  if (typeof scope === 'string') {
    const resource = vscode.Uri.file(scope);
    return vscode.workspace.getWorkspaceFolder(resource)
      ?? vscode.workspace.workspaceFolders?.find(folder => path.normalize(folder.uri.fsPath) === path.normalize(scope));
  }

  if (scope instanceof URL) {
    const resource = vscode.Uri.parse(scope.toString());
    return vscode.workspace.getWorkspaceFolder(resource)
      ?? vscode.workspace.workspaceFolders?.find(folder => path.normalize(folder.uri.fsPath) === path.normalize(resource.fsPath));
  }

  if (scope instanceof vscode.Uri) {
    return vscode.workspace.getWorkspaceFolder(scope)
      ?? vscode.workspace.workspaceFolders?.find(folder => path.normalize(folder.uri.fsPath) === path.normalize(scope.fsPath));
  }

  if (scope) {
    return scope;
  }

  return vscode.workspace.workspaceFolders?.length === 1
    ? vscode.workspace.workspaceFolders[0]
    : undefined;
}

function getNamedWorkspaceFolder(name: string): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.find(folder => folder.name === name);
}

function toPortableBasePath(
  targetPath: string,
  variable: string,
  basePath: string,
  allowParentRelative = false,
): string | undefined {
  const normalizedTargetPath = path.resolve(targetPath);
  const normalizedBasePath = path.resolve(basePath);
  const relativePath = path.relative(normalizedBasePath, normalizedTargetPath);

  if (relativePath === '') {
    return variable;
  }

  if (!path.isAbsolute(relativePath) && (allowParentRelative || !relativePath.startsWith('..'))) {
    return `${variable}/${relativePath.replace(/\\/g, '/')}`;
  }

  return undefined;
}

export function toPortableWorkspaceFolderPath(
  targetPath: string,
  workspaceFolder: vscode.WorkspaceFolder,
): string {
  return toPortableBasePath(targetPath, WORKSPACE_FOLDER_VARIABLE, workspaceFolder.uri.fsPath, true)
    ?? path.resolve(targetPath);
}

export function toPortableConfiguredPath(
  targetPath: string,
  scope?: ConfigurationScope,
): string {
  if (!targetPath || targetPath.includes('${')) {
    return targetPath;
  }

  const workspaceFolder = getWorkspaceFolderForScope(scope);
  if (workspaceFolder) {
    const portableWorkspacePath = toPortableBasePath(targetPath, WORKSPACE_FOLDER_VARIABLE, workspaceFolder.uri.fsPath, true);
    if (portableWorkspacePath) {
      return portableWorkspacePath;
    }
  }

  const portableModePath = process.env.VSCODE_PORTABLE;
  if (portableModePath) {
    const portablePath = toPortableBasePath(targetPath, PORTABLE_MODE_VARIABLE, portableModePath);
    if (portablePath) {
      return portablePath;
    }
  }

  const userHomePath = toPortableBasePath(targetPath, USER_HOME_VARIABLE, os.homedir());
  if (userHomePath) {
    return userHomePath;
  }

  return path.resolve(targetPath);
}

export function toPortableConfiguredPathValue(
  value: string | string[] | undefined,
  scope?: ConfigurationScope,
): string | string[] | undefined {
  if (typeof value === 'string') {
    return toPortableConfiguredPath(value, scope);
  }
  if (Array.isArray(value)) {
    return value.map(entry => toPortableConfiguredPath(entry, scope));
  }
  return value;
}

function resolveConfigVariable(
  settingName: string,
  scope: ConfigurationScope | undefined,
  state: VariableResolutionState,
): string | undefined {
  if (state.depth >= MAX_CONFIG_VARIABLE_DEPTH) {
    return undefined;
  }

  const resource = getConfigurationResource(scope);
  const configKey = `${resource?.toString() ?? '<global>'}:${settingName}`;
  if (state.seenConfigKeys.has(configKey)) {
    return undefined;
  }

  const rawValue = vscode.workspace.getConfiguration(undefined, resource).get<unknown>(settingName);
  if (typeof rawValue !== 'string') {
    return undefined;
  }

  state.seenConfigKeys.add(configKey);
  try {
    return resolveConfiguredPath(rawValue, scope, {
      depth: state.depth + 1,
      seenConfigKeys: state.seenConfigKeys,
    });
  } finally {
    state.seenConfigKeys.delete(configKey);
  }
}

function resolveSupportedVariable(
  variableName: string,
  scope: ConfigurationScope | undefined,
  state: VariableResolutionState,
): string | undefined {
  if (variableName === 'workspaceFolder') {
    return getWorkspaceFolderForScope(scope)?.uri.fsPath;
  }
  if (variableName.startsWith('workspaceFolder:')) {
    const workspaceName = variableName.slice('workspaceFolder:'.length);
    return workspaceName.length > 0
      ? getNamedWorkspaceFolder(workspaceName)?.uri.fsPath
      : undefined;
  }
  if (variableName === 'workspaceFolderBasename') {
    const workspaceFolder = getWorkspaceFolderForScope(scope);
    return workspaceFolder
      ? path.basename(workspaceFolder.uri.fsPath)
      : undefined;
  }
  if (variableName === 'userHome') {
    return os.homedir();
  }
  if (variableName === 'pathSeparator' || variableName === '/') {
    return path.sep;
  }
  if (variableName.startsWith('env:')) {
    return process.env[variableName.slice('env:'.length)] ?? '';
  }
  if (variableName.startsWith('config:')) {
    return resolveConfigVariable(variableName.slice('config:'.length), scope, state);
  }
  return undefined;
}

export function resolveConfiguredPath(
  targetPath: string | undefined,
  scope?: ConfigurationScope,
  state?: VariableResolutionState,
): string | undefined {
  if (!targetPath || targetPath.trim().length === 0) {
    return undefined;
  }

  const resolutionState = state ?? { depth: 0, seenConfigKeys: new Set<string>() };
  let replaced = false;
  const resolved = targetPath.replace(/\$\{([^}]+)\}/g, (match, variableName: string) => {
    const replacement = resolveSupportedVariable(variableName, scope, resolutionState);
    if (typeof replacement === 'undefined') {
      return match;
    }
    replaced = true;
    return replacement;
  });

  if (!replaced) {
    return targetPath;
  }

  return resolved.includes('${') ? resolved : path.normalize(resolved);
}

export function resolveConfiguredPathValue(
  value: string | string[] | undefined,
  scope?: ConfigurationScope,
): string | string[] | undefined {
  if (typeof value === 'string') {
    return resolveConfiguredPath(value, scope);
  }
  if (Array.isArray(value)) {
    return value.map(entry => resolveConfiguredPath(entry, scope) ?? entry);
  }
  return value;
}

export function getConfiguredPathBySettingName(
  settingName: string,
  scope?: ConfigurationScope,
): string | undefined {
  const resource = getConfigurationResource(scope);
  const rawValue = vscode.workspace
    .getConfiguration(undefined, resource)
    .get<string>(settingName);

  return resolveConfiguredPath(rawValue, scope);
}

export function getConfiguredWorkbenchPath(
  settingKey: string,
  scope?: ConfigurationScope,
): string | undefined {
  return getConfiguredPathBySettingName(buildWorkbenchSettingKey(settingKey), scope);
}

export function isSpdxOnlyVenvPath(venvPath: string | undefined): boolean {
  if (!venvPath) {
    return false;
  }

  return venvPath
    .split(/[\\/]+/)
    .some(segment => segment.toLowerCase() === '.venv-spdx');
}

export function sanitizeConfiguredVenvPath(venvPath: string | undefined): string | undefined {
  if (!venvPath || venvPath.trim().length === 0) {
    return undefined;
  }

  return isSpdxOnlyVenvPath(venvPath) ? undefined : venvPath;
}

export function getConfiguredVenvPath(
  scope?: ConfigurationScope,
): string | undefined {
  return sanitizeConfiguredVenvPath(
    getConfiguredWorkbenchPath(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY, scope),
  );
}

export function normalizeSlashesIfPath(p: string): string {
  const looksLikePath = /[\\/]/.test(p) || /\.\w+$/.test(p);

  if (looksLikePath) {
    return p.replace(/\\/g, '/').replace(/\/+/g, '/');
  }

  return p;
}

export function normalisePathsInString(kind: string, text: string): string {
  if (!text) { return text; }
  if (kind === 'cmd.exe' || kind === 'powershell.exe' || kind === 'pwsh.exe') { return text; }

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
      const normalized = normalizePathForShell(shellKind, val);
      if (normalized) {
        out[key] = normalized;
      }
    } else if (Array.isArray(val)) {
      const normalized = val
        .map(entry => normalizePathForShell(shellKind, entry))
        .filter(entry => entry); // Remove empty strings
      if (normalized.length > 0) {
        out[key] = normalized.join(path.delimiter);
      }
    }
  }
  return out;
}

function detectTerminalProfile():
  | {
    kind: 'bash' | 'cmd.exe' | 'powershell.exe' | 'pwsh.exe';
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
        low.includes('pwsh') ? 'pwsh.exe' :
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
    case 'pwsh.exe':
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
    case 'pwsh.exe':
      return '> $null 2>&1';
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
    case 'pwsh.exe':
      return `. ${script}`;
    default:
      return '';
  }
}

export function getShellSetEnvCommand(shell: string, env: string, value: string): string {
  switch (shell) {
    case 'bash':
    case 'zsh':
    case 'dash':
      return `export ${env}="${value.replace(/(["\\$`])/g, '\\$1')}"`;
    case 'fish':
      return `set -gx ${env} "${value.replace(/(["\\$`])/g, '\\$1')}"`;
    case 'cmd.exe':
      return `set "${env}=${value.replace(/"/g, '""')}"`;
    case 'powershell.exe':
    case 'pwsh.exe':
      return `$env:${env} = '${value.replace(/'/g, "''")}'`;
    default:
      return `${env}=${value}`;
  }
}

export function getShellCdCommand(shell: string, cwd: string): string {
  const normalized = normalizePathForShell(shell, cwd);
  const quoted = /^".*"$/.test(normalized) || !/\s/.test(normalized)
    ? normalized
    : `"${normalized}"`;

  switch (shell) {
    case 'cmd.exe':
      return `cd /d ${quoted}`;
    case 'powershell.exe':
    case 'pwsh.exe':
      return `Set-Location ${quoted}`;
    default:
      return `cd ${quoted}`;
  }
}

export function getShellEchoCommand(shell: string): string {
  switch (shell) {
    case 'bash':
    case 'zsh':
    case 'dash':
    case 'fish':
    case 'cmd.exe':
      return 'echo';
    case 'powershell.exe':
    case 'pwsh.exe':
      return 'Write-Output';
    default:
      return 'echo';
  }
}

export function getShellClearCommand(shell: string): string {
  switch (shell) {
    case 'bash':
    case 'zsh':
    case 'dash':
    case 'fish':
      return 'clear';
    case 'cmd.exe':
    case 'powershell.exe':
    case 'pwsh.exe':
      return 'cls';
    default:
      return '';
  }
}

/**
 * Ensure the workspace has terminal sticky scroll disabled.
 *
 * Why: VS Code's terminal sticky-scroll feature pins the most recent command at the
 * top of the viewport, which obscures Zephyr's grouped env banner on terminal open
 * and overlays full-screen TUIs like menuconfig / guiconfig during the alt-screen
 * transition. There's no per-terminal API to disable it (sticky scroll is a global
 * `terminal.integrated.stickyScroll.enabled` setting), so the next-best fix is to
 * disable it at the workspace level — narrow enough to leave other workspaces alone.
 *
 * Only writes the setting when the user has NOT explicitly set a workspace value
 * themselves (`inspect()` reveals a workspaceValue of `undefined`). If the user later
 * re-enables it in their workspace settings, this function leaves it alone.
 *
 * Safe to call multiple times — returns early on subsequent calls and on no-op cases.
 */
let _stickyScrollChecked = false;
export async function ensureTerminalStickyScrollDisabled(): Promise<void> {
  if (_stickyScrollChecked) {
    return;
  }
  _stickyScrollChecked = true;

  if (!vscode.workspace.workspaceFolders?.length) {
    // No workspace open — falling back to Global would affect every other VS Code
    // window, which is too intrusive. Skip.
    return;
  }

  const cfg = vscode.workspace.getConfiguration('terminal.integrated.stickyScroll');
  const inspect = cfg.inspect<boolean>('enabled');
  // Respect any explicit workspace / workspace-folder value the user has chosen.
  if (inspect?.workspaceValue !== undefined || inspect?.workspaceFolderValue !== undefined) {
    return;
  }

  try {
    await cfg.update('enabled', false, vscode.ConfigurationTarget.Workspace);
  } catch {
    // Settings update can fail in untrusted workspaces or when the workspace file
    // isn't writable. Nothing actionable — sticky scroll just stays at its prior value.
  }
}

/**
 * Build `shellArgs` that runs `setupCommands` silently at terminal startup, then
 * drops into an interactive shell. Pass to `vscode.window.createTerminal({shellArgs})`.
 *
 * Why: `terminal.sendText` types its argument at the prompt and the shell echoes it
 * back, leaving a long `&&` chain visible in scrollback. By baking the setup into the
 * shell's launch args (`-c "<setup>; exec <shell>"` on POSIX, `-NoExit -Command` on
 * PowerShell, `/k` on cmd), no input is ever typed and only the setup's own output
 * (e.g. our env-banner echoes) is shown.
 *
 * Only usable when *creating* a terminal. For an already-running terminal (e.g. when
 * a build config changes and we want to refresh its env), there's no choice but to
 * use `sendText` because the shell is past its launch.
 *
 * `originalShellArgs` is preserved on the inner `exec` so the user's terminal-profile
 * args (e.g. `--login`) still apply to the interactive shell.
 */
export function buildStartupSetupShellArgs(
  shellExe: string,
  shellKind: string,
  originalShellArgs: string[] | undefined,
  setupCommands: string[],
): string[] {
  if (shellKind === 'cmd.exe') {
    // /k = run command then stay open in interactive mode. @echo off suppresses cmd's
    // default per-line echoing of the setup commands.
    const setupChain = setupCommands.join(' && ');
    return ['/k', setupChain ? `@echo off && ${setupChain}` : '@echo off'];
  }

  if (shellKind === 'powershell.exe' || shellKind === 'pwsh.exe') {
    // -NoExit keeps the shell open after running the -Command argument.
    return ['-NoExit', '-Command', setupCommands.join('; ')];
  }

  // POSIX (bash/zsh/dash/fish, plus their Cygwin/MSYS2/Git Bash variants):
  // `-c` runs the setup non-interactively, then `exec <shell>` replaces the wrapper
  // with an interactive shell that inherits env, cwd, and any profile args the user
  // had configured.
  const setupChain = setupCommands.join(' && ');
  const userArgs = (originalShellArgs ?? [])
    .map(arg => `'${arg.replace(/'/g, "'\\''")}'`)
    .join(' ');
  const execTail = `exec ${shellExe}${userArgs ? ' ' + userArgs : ''}`;
  // `;` (not `&&`) before exec so the interactive shell still launches even if a
  // setup command returns non-zero — otherwise a fluky echo or source would close
  // the terminal.
  return ['-c', setupChain ? `${setupChain}; ${execTail}` : execTail];
}

/**
 * A labelled bucket of env vars to inject into a Zephyr terminal.
 * Used to print the env in categorized sections (e.g. "Zephyr build system",
 * "Toolchain", "Helpers") instead of one undifferentiated dump.
 */
export interface TerminalEnvGroup {
  label: string;
  env: Record<string, string>;
}

/**
 * Build the shell commands a Zephyr terminal needs at startup to inject and
 * display its env vars, grouped by category.
 *
 * Returned commands split into two phases so the caller can interleave them
 * with cd/source-env-script:
 *   - `setCommands`  — `export FOO=bar` (or shell equivalent), one per var. Run
 *                      these BEFORE sourcing the env script so the script can
 *                      observe and possibly augment them.
 *   - `echoCommands` — header + per-group label + `echo KEY="value"` lines.
 *                      Run these AFTER sourcing the env script so the user sees
 *                      the final, post-source values.
 *
 * Empty groups are skipped.
 */
export function buildTerminalEnvCommands(
  shellType: string,
  groups: TerminalEnvGroup[],
): { setCommands: string[]; echoCommands: string[] } {
  const echoCommand = getShellEchoCommand(shellType);
  const isPosix = shellType === 'bash' || shellType === 'zsh'
    || shellType === 'dash' || shellType === 'fish';
  const renderValue = (v: string) => isPosix ? winToPosixPath(v) : v;

  const setCommands: string[] = [];
  const echoCommands: string[] = [`${echoCommand} "======= Zephyr Workbench Environment ======="`];

  for (const group of groups) {
    const entries = Object.entries(group.env);
    if (entries.length === 0) {
      continue;
    }

    for (const [key, value] of entries) {
      setCommands.push(getShellSetEnvCommand(shellType, key, String(value)));
    }

    echoCommands.push(`${echoCommand} "----- ${group.label} -----"`);
    for (const [key, value] of entries) {
      echoCommands.push(`${echoCommand} ${key}="${renderValue(String(value))}"`);
    }
  }

  echoCommands.push(`${echoCommand} "============================================"`);
  return { setCommands, echoCommands };
}

export function getOutputChannel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel('Ac6 Zephyr Workbench');
  }
  return _channel;
}

function logShellCommand(cmdName: string, cmd: string, cwd?: string): void {
  const output = getOutputChannel();
  output.appendLine(`[command] ${cmdName}`);
  if (cwd) {
    output.appendLine(`[cwd] ${cwd}`);
  }
  output.appendLine(cmd);
  output.appendLine('');
}

export function expandEnvVariables(input: string): string {
  const envVariableRegex = /\$(\w+)|\$\{(\w+)\}|@(\w+)@|%(\w+)%/g;
  return input.replace(envVariableRegex, (_, v1, v2, v3, v4) => {
    const name = v1 || v2 || v3 || v4;
    return process.env[name] || '';
  });
}

/**
 * Runs a `vscode.Task` and resolves when it ends. The companion of `buildDirectTask`:
 * the typical project-scoped flow is `executeTask(buildDirectTask(folder, name, cfg))`.
 *
 * Persists west-build-state markers (`__westBuildStatePath` / `__westBuildState`) that
 * `ZephyrTaskProvider.resolve` may stash on the task definition, so callers don't need
 * to call `writeWestBuildState` themselves.
 */
export async function executeTask(task: vscode.Task): Promise<vscode.TaskExecution> {
  await vscode.tasks.executeTask(task);
  return new Promise(resolve => {
    const disp = vscode.tasks.onDidEndTask(e => {
      if (e.execution.task.name === task.name) {
        disp.dispose();
        const buildStatePath = e.execution.task.definition.__westBuildStatePath;
        const buildState = e.execution.task.definition.__westBuildState;
        if (typeof buildStatePath === 'string' && typeof buildState === 'string') {
          try {
            writeWestBuildState(buildStatePath, JSON.parse(buildState) as WestBuildState);
          } catch {
            // Ignore malformed build-state metadata and just return the execution.
          }
        }
        resolve(e.execution);
      }
    });
  });
}

export function isCygwin(shellPath: string): boolean {
  return /\\cygwin[^\\]*\\bin\\bash.exe$/i.test(shellPath);
}

/**
 * Run a shell command as a one-shot VS Code task and await completion. Does NOT source
 * the Zephyr env script — caller is responsible for any env setup.
 *
 * Use for: install / setup flows that run BEFORE the Zephyr env exists (zinstaller,
 * venv creation, SDK setup, SPDX install). For anything that needs `west`, prefer
 * `execShellCommandWithEnv` (pre-project) or `buildDirectTask` + `executeTask`
 * (project-scoped — preferred).
 */
export async function execShellCommand(
  cmdName: string,
  cmd: string,
  options: vscode.ShellExecutionOptions
) {
  if (!cmd) {
    throw new Error('Missing command to execute');
  }

  logShellCommand(cmdName, cmd, options.cwd);
  const shExec = new vscode.ShellExecution(cmd, options);
  const task = new vscode.Task(
    { label: cmdName, type: 'zephyr-workbench-shell' },
    vscode.TaskScope.Workspace,
    cmdName,
    'Zephyr Workbench',
    shExec
  );
  task.presentationOptions.echo = true;
  await executeTask(task);
}

/**
 * Run a shell command in a VS Code task, sourcing the Zephyr env script first so `west`,
 * the toolchain, and the venv are on PATH. Awaits completion.
 *
 * Use for: workspace-level west operations that don't have a project / build config —
 * `west init`, `west update`, `west boards`, `west packages pip --install`, ECLAIR
 * analysis, install-tool checks. For project-scoped operations (build, flash, menuconfig,
 * SPDX init/generate) use `buildDirectTask` + `executeTask` instead — that path adds
 * board, build-dir, and toolchain env automatically.
 */
export async function execShellCommandWithEnv(
  cmdName: string,
  cmd: string,
  options: vscode.ShellExecutionOptions
) {
  const rawEnvScript = getConfiguredWorkbenchPath(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, options.cwd);
  const rawVenvPath = getConfiguredVenvPath(options.cwd);

  const envScript = normalizePathForShell(classifyShell(getShellExe()), rawEnvScript ?? '');
  const venvPath = rawVenvPath ? normalizePathForShell(classifyShell(getShellExe()), rawVenvPath) : undefined;

  if (!envScript) {
    throw new Error(
      'Missing Zephyr environment script.',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` }
    );
  }
  if (!cmd) {
    throw new Error('Missing command to execute', { cause: 'missing.command' });
  }
  if (rawVenvPath && !fileExists(rawVenvPath)) {
    throw new Error(
      'Invalid Python virtual environment.',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY}` }
    );
  }

  const shellKind = classifyShell(getShellExe());
  const exe = getShellExe();
  options.executable = exe;
  options.shellArgs = getShellArgs(shellKind);

  if (isCygwin(exe)) {
    options.shellArgs = ['--login', '-i', ...options.shellArgs];
  }

  const needsChere = isCygwin(exe);

  options.env = {
    ...(needsChere ? { CHERE_INVOKING: '1' } : {}),
    ...getProfileEnv(),
    ...options.env,
    ...(venvPath ? { PYTHON_VENV_PATH: venvPath } : {})
  };

  const redirect = getShellNullRedirect(shellKind);
  const cmdEnv = `${getShellSourceCommand(shellKind, envScript)} ${redirect}`;
  await execShellCommand(cmdName, concatCommands(shellKind, cmdEnv, cmd), options);
}

/**
 * Run a shell command via `child_process.exec`, sourcing the Zephyr env script. Returns
 * a `ChildProcess` and does NOT show a terminal — use this when you need to capture
 * stdout/stderr (e.g. parsing `west boards` output, board-discovery probes).
 *
 * For interactive output the user should see, use `execShellCommandWithEnv` (pre-project)
 * or `buildDirectTask` + `executeTask` (project-scoped). Sibling helpers:
 *   - `execCommandWithEnvCB` — same idea but takes a `ExecOptions` and returns directly.
 *   - `spawnCommandWithEnv` — `child_process.spawn`-based, for streaming output.
 */
export async function execCommandWithEnv(
  cmd: string,
  cwd?: string,
  cb?: (e: ExecException | null, so: string, se: string) => void
): Promise<ChildProcess> {
  const rawEnvScript = getConfiguredWorkbenchPath(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, cwd);
  const rawVenvPath = getConfiguredVenvPath(cwd);

  const envScript = normalizePathForShell(classifyShell(getShellExe()), rawEnvScript ?? '');
  const venvPath = rawVenvPath ? normalizePathForShell(classifyShell(getShellExe()), rawVenvPath) : undefined;

  if (!envScript) {
    throw new Error(
      'Missing Zephyr environment script.',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` }
    );
  }
  if (rawVenvPath && !fileExists(rawVenvPath)) {
    throw new Error(
      'Invalid Python virtual environment.',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY}` }
    );
  }

  const options: ExecOptions = {
    cwd,
    env: {
      ...process.env,
      ...getProfileEnv(),
      ...(venvPath ? { PYTHON_VENV_PATH: venvPath } : {})
    },
    shell: getShellExe()
  };

  const shellKind = classifyShell(getShellExe());
  const redirect = getShellNullRedirect(shellKind);
  const cmdEnv = `${getShellSourceCommand(shellKind, envScript)} ${redirect}`;
  return exec(concatCommands(shellKind, cmdEnv, cmd), options, cb);
}

/**
 * Synchronous-shaped variant of `execCommandWithEnv`: returns the `ChildProcess`
 * directly (no Promise wrapper) and accepts custom `ExecOptions`. Same env-sourcing
 * behavior. Pick this when you want full control of `ExecOptions` (env, encoding, etc.).
 */
export function execCommandWithEnvCB(
  cmd: string,
  cwd?: string,
  options: ExecOptions = {},
  cb?: (e: ExecException | null, so: string, se: string) => void
): ChildProcess {
  const envScript = getConfiguredWorkbenchPath(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, cwd ?? options.cwd);
  const venvPath2 = getConfiguredVenvPath(cwd ?? options.cwd);

  if (!envScript) {
    throw new Error(
      'Missing Zephyr environment script.',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` }
    );
  }
  if (venvPath2 && !fileExists(venvPath2)) {
    throw new Error(
      'Invalid Python virtual environment.',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY}` }
    );
  }

  options.env = {
    ...getProfileEnv(),
    ...options.env,
    ...(venvPath2 ? { PYTHON_VENV_PATH: venvPath2 } : {})
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

/**
 * Run a shell command via `child_process.spawn`, sourcing the Zephyr env script. Returns
 * a `ChildProcess` for streaming output (`stdout`/`stderr` via `'data'` events) without
 * a terminal — use for long-running probes where you need to read output incrementally.
 * For one-shot output capture, prefer `execCommandWithEnv`.
 */
export function spawnCommandWithEnv(cmd: string, options: SpawnOptions = {}): ChildProcess {
  const envScript = getConfiguredWorkbenchPath(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, options.cwd);
  const venvPath3 = getConfiguredVenvPath(options.cwd);

  if (!envScript) {
    throw new Error(
      'Missing Zephyr environment script.',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` }
    );
  }
  if (venvPath3 && !fileExists(venvPath3)) {
    throw new Error(
      'Invalid Python virtual environment.',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY}` }
    );
  }

  options.env = {
    ...getProfileEnv(),
    ...options.env,
    ...(venvPath3 ? { PYTHON_VENV_PATH: venvPath3 } : {})
  };
  options.shell = getShellExe();

  const shellKind = classifyShell(getShellExe());
  const redirect = getShellNullRedirect(shellKind);
  const cmdEnv = `${getShellSourceCommand(shellKind, envScript)} ${redirect}`;
  return spawn(concatCommands(shellKind, cmdEnv, cmd), options);
}

/**
 * Run a fully-pre-built shell command as an env-sourced VS Code task and await
 * completion, with an option to hide the terminal panel. Cygwin-aware (adds
 * `--login -i` and `CHERE_INVOKING=1`).
 *
 * Use only for internal, hidden, project-adjacent tasks that don't fit the standard
 * `tasksMap` shape — currently just the board-discovery probe (`west build -t boards`
 * into a `.tmp` directory). For all normal Zephyr operations (build, flash, config,
 * SPDX) use `buildDirectTask` + `executeTask`.
 */
export async function execShellTaskWithEnvAndWait(
  cmdName: string,
  cmd: string,
  options: vscode.ShellExecutionOptions = {},
  hideTerminal = false,
): Promise<void> {

  const envScriptRaw = getConfiguredWorkbenchPath(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, options.cwd);

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

  logShellCommand(cmdName, fullCmd, options.cwd);

  const shExec = new vscode.ShellExecution(fullCmd, {
    ...options,
    executable: exe,
    shellArgs: shellArgs,
    env: { ...getProfileEnv(), ...(needsChere ? { CHERE_INVOKING: '1' } : {}), ...options.env }
  });

  const task = new vscode.Task(
    { label: cmdName, type: 'zephyr-workbench-shell' },
    vscode.TaskScope.Workspace,
    cmdName,
    'Zephyr Workbench',
    shExec
  );
  task.presentationOptions.echo = true;

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
        .filter(l => l.trim() !== '' && !l.includes('^{}') && l.includes('\t'))
        .map(l => {
          const parts = l.split('\t');
          return parts[1] ? parts[1].replace('refs/tags/', '') : '';
        })
        .filter(tag => tag !== '')
        .sort((a, b) => {
          const aIsVersionTag = /^v\d/.test(a);
          const bIsVersionTag = /^v\d/.test(b);

          if (aIsVersionTag !== bIsVersionTag) {
            return aIsVersionTag ? -1 : 1;
          }

          if (aIsVersionTag && bIsVersionTag) {
            return compareVersions(b, a);
          }

          return a.localeCompare(b);
        });
      resolve(tags);
    });
  });
}

export async function getGitBranches(gitUrl: string): Promise<string[]> {
  const gitCmd = `git ls-remote --heads ${gitUrl}`;
  return new Promise((resolve, reject) => {
    execCommandWithEnv(gitCmd, undefined, (err, out, errStr) => {
      if (err) {
        reject(`Error: ${errStr}`);
        return;
      }
      const branches = out
        .trim()
        .split('\n')
        .filter(l => l.trim() !== '' && l.includes('\t'))
        .map(l => {
          const parts = l.split('\t');
          return parts[1] ? parts[1].replace('refs/heads/', '') : '';
        })
        .filter(branch => branch !== '')
        .sort();
      resolve(branches);
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
