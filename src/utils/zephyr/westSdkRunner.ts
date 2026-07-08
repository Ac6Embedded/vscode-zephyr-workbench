/**
 * Run the upstream `west sdk install` command from a minimal, extension-materialized
 * west workspace, so the Zephyr SDK can be installed "globally" (auto-discovered by
 * the build system) even when no west workspace or Zephyr checkout exists yet.
 *
 * The workspace is materialized from the vendored payload at res/west-sdk/manifest/
 * (west.yml + scripts/west_commands/sdk.py, vendored from Zephyr) into the
 * extension's global storage. `west sdk install` then runs with cwd set to that
 * workspace and ZEPHYR_BASE cleared: sdk.py's fetch_sdk_info returns empty and the
 * install proceeds without any Zephyr checkout.
 *
 * Execution modes:
 *  1. If the configured env script (zephyr-workbench.pathToEnvScript) resolves to an
 *     existing file, the command runs through spawnCommandWithEnv (env-sourced shell),
 *     which puts west, cmake and (on Windows) 7-Zip on PATH.
 *  2. Otherwise, the managed .zinstaller venv's west executable is spawned directly
 *     with a venv-activated environment (VIRTUAL_ENV + venv bin on PATH).
 *
 * `buildWestSdkInstallArgs` and `classifyWestSdkFailure` are pure (no vscode use at
 * runtime) and exported for unit tests.
 */

import { ChildProcess, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as sevenBin from '7zip-bin';

import { ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY } from '../../constants';
import {
  getConfiguredVenvPath,
  getConfiguredWorkbenchPath,
  getOutputChannel,
  killProcessTree,
  spawnCommandWithEnv,
} from '../execUtils';
import { getManagedVenvWestPath, managedVenvProcessEnv } from '../installUtils';
import { getInternalDirRealPath } from '../utils';

export interface WestSdkInstallOptions {
  /** SDK version, e.g. "0.17.4" (no leading v). */
  version: string;
  /** -b install base; defaults to os.homedir(). SDK lands in <base>/zephyr-sdk-<version>. */
  installBase?: string;
  /** -t toolchain names (e.g. 'arm-zephyr-eabi'); undefined/empty installs all (omit -t). */
  gnuToolchains?: string[];
  /** -T: skip GNU toolchains entirely. */
  noGnuToolchains?: boolean;
  /** -l: also install the LLVM toolchain. */
  llvm?: boolean;
  /** -H: skip host tools. */
  noHostTools?: boolean;
  /** GitHub personal access token; masked as *** in all logging. */
  personalAccessToken?: string;
  /** Alternate GitHub releases API endpoint. */
  apiUrl?: string;
}

export type WestSdkErrorKind =
  | 'rate-limit'
  | 'checksum'
  | 'bad-request'
  | 'setup-failed'
  | 'network'
  | 'permission'
  | 'python-deps'
  | 'extractor'
  | 'west-missing'
  | 'cancelled'
  | 'unknown';

export class WestSdkInstallError extends Error {
  kind: WestSdkErrorKind;
  /** Last lines of process output, for diagnostics. */
  outputTail: string;

  constructor(kind: WestSdkErrorKind, message: string, outputTail: string = '') {
    super(message);
    this.name = 'WestSdkInstallError';
    this.kind = kind;
    this.outputTail = outputTail;
  }
}

export interface SdkSetupOptions {
  /** Run `setup -c` to register the SDK in the CMake user package registry. Default true. */
  registerCmakePackage?: boolean;
  /** GNU toolchains to install (`-t <name>` per entry). */
  gnuToolchains?: string[];
  /** Install the LLVM toolchain (`-l`). */
  llvm?: boolean;
  /** Install host tools (`-h`). */
  hostTools?: boolean;
}

// Bump when the materialization layout changes so existing workspaces re-copy
// even if the vendored payload content is unchanged.
const WEST_SDK_RUNNER_FORMAT_VERSION = '1';
const WEST_SDK_RUNNER_DIR_NAME = 'west-sdk-runner';
const WEST_CONFIG_CONTENT = '[manifest]\npath = manifest\nfile = west.yml\n';
const TAIL_LINE_LIMIT = 80;

const WEST_MISSING_MESSAGE =
  'west was not found. Install the host tools first (Zephyr Workbench: Install Host Tools).';
const CANCELLED_MESSAGE = 'Install cancelled.';

const USER_MESSAGES: Record<WestSdkErrorKind, string> = {
  'rate-limit': 'GitHub API rate limit exceeded. Retry later or provide a personal access token.',
  'checksum': 'Downloaded SDK archive failed sha256 verification. Please retry.',
  'bad-request': 'The requested SDK version or toolchain is not available. Check the version and toolchain names (the output channel lists the available choices).',
  'setup-failed': 'The SDK setup script failed. Check the Zephyr Workbench output channel for details.',
  'network': 'Network error while downloading the Zephyr SDK. Check your connection and retry.',
  'permission': 'Permission denied while installing the SDK. Choose an install base you can write to.',
  'python-deps': 'Python packages required by west sdk are missing (requests, semver, tqdm, patool). Reinstall the host tools.',
  'extractor': 'Could not extract the SDK archive (no suitable extractor was found). Reinstall the host tools and retry.',
  'west-missing': WEST_MISSING_MESSAGE,
  'cancelled': CANCELLED_MESSAGE,
  'unknown': 'west sdk install failed. Check the Zephyr Workbench output channel for details.',
};

function quote(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

// Always double-quote shell-command arguments: bash/zsh (incl. Git Bash on
// Windows) strip backslashes from UNQUOTED words, which would mangle a
// backslashed -b install path; inside double quotes a backslash before a
// normal character is preserved, and cmd.exe/PowerShell accept quoted args.
function shellQuoteArg(arg: string): string {
  return `"${arg.replace(/"/g, '')}"`;
}

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the argument vector passed to west (everything after the executable name),
 * i.e. ['sdk', 'install', '--version', ...]. Pure; exported for unit tests.
 */
export function buildWestSdkInstallArgs(options: WestSdkInstallOptions): string[] {
  const args: string[] = [
    'sdk', 'install',
    '--version', options.version,
    '-b', options.installBase ?? os.homedir(),
  ];

  // argparse declares -t with nargs='+': one -t flag followed by all names.
  if (options.gnuToolchains && options.gnuToolchains.length > 0) {
    args.push('-t', ...options.gnuToolchains);
  }
  if (options.noGnuToolchains) {
    args.push('-T');
  }
  if (options.llvm) {
    args.push('-l');
  }
  if (options.noHostTools) {
    args.push('-H');
  }
  if (options.personalAccessToken) {
    args.push('--personal-access-token', options.personalAccessToken);
  }
  if (options.apiUrl) {
    args.push('--api-url', options.apiUrl);
  }

  return args;
}

/**
 * Map the tail of a failed `west sdk install` run to an error kind. Patterns are
 * grounded in sdk.py's actual output strings (see res/west-sdk/manifest/scripts/
 * west_commands/sdk.py). Pure; exported for unit tests.
 */
export function classifyWestSdkFailure(outputTail: string): WestSdkErrorKind {
  // Checked before 'network': the rate-limit response also contains "Failed to fetch".
  if (/API rate limit exceeded/i.test(outputTail)) {
    return 'rate-limit';
  }
  // sdk.py: raise Exception(f"sha256 mismatched: {sha256}:{digest}")
  if (/sha256[^\n]*mismatch/i.test(outputTail)) {
    return 'checksum';
  }
  // sdk.py: "Unavailable SDK version: ...", "GNU toolchain <tc> is not available.",
  // "No Zephyr SDK <version> bundle found for host <os>-<arch>."
  if (/Unavailable SDK version|is not available|No Zephyr SDK[^\n]*bundle found/i.test(outputTail)) {
    return 'bad-request';
  }
  // sdk.py run_setup: die(f"command \"<...>/setup.sh -t all -h\" failed")
  if (/command "[^"]*setup\.(sh|cmd)/i.test(outputTail)) {
    return 'setup-failed';
  }
  // sdk.py: "Failed to fetch: <status>", "Failed to download <url>: <status>",
  // plus common Python/Node connectivity errors.
  if (/Failed to fetch|Failed to download|ECONNRESET|ENOTFOUND|getaddrinfo|ConnectionError|requests\.exceptions/.test(outputTail)) {
    return 'network';
  }
  if (/ModuleNotFoundError/.test(outputTail)) {
    return 'python-deps';
  }
  // patoolib: "patool error: could not find an executable program to extract format ..."
  if (/patool/i.test(outputTail) && /error|could not find/i.test(outputTail)) {
    return 'extractor';
  }
  if (/PermissionError|Permission denied|EACCES/.test(outputTail)) {
    return 'permission';
  }
  return 'unknown';
}

async function listFilesRecursively(dir: string, base: string = dir): Promise<string[]> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursively(absolute, base));
    } else if (entry.isFile()) {
      files.push(path.relative(base, absolute).split(path.sep).join('/'));
    }
  }
  return files;
}

// sha256 over the vendored payload (sorted relative paths + contents) plus the
// format version, so the materialized workspace refreshes when either changes.
async function computePayloadStamp(sourceDir: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  hash.update(`format:${WEST_SDK_RUNNER_FORMAT_VERSION}\n`);
  const files = (await listFilesRecursively(sourceDir)).sort();
  for (const relative of files) {
    hash.update(`file:${relative}\n`);
    hash.update(await fs.promises.readFile(path.join(sourceDir, ...relative.split('/'))));
  }
  return hash.digest('hex');
}

/**
 * Materialize (idempotently) the minimal west workspace used to run `west sdk`,
 * under the extension's global storage. Returns the workspace root, i.e. the
 * directory holding .west/config and manifest/.
 */
export async function ensureWestSdkWorkspace(context: vscode.ExtensionContext): Promise<string> {
  const extensionRoot = context.extensionUri ? context.extensionUri.fsPath : context.extensionPath;
  const sourceManifestDir = path.join(extensionRoot, 'res', 'west-sdk', 'manifest');
  const workspaceRoot = path.join(context.globalStorageUri.fsPath, WEST_SDK_RUNNER_DIR_NAME);
  const targetManifestDir = path.join(workspaceRoot, 'manifest');
  const westConfigPath = path.join(workspaceRoot, '.west', 'config');
  const stampPath = path.join(workspaceRoot, '.stamp');

  const stamp = await computePayloadStamp(sourceManifestDir);

  let upToDate = false;
  try {
    const existingStamp = await fs.promises.readFile(stampPath, 'utf8');
    upToDate = existingStamp.trim() === stamp
      && await pathExists(targetManifestDir)
      && await pathExists(westConfigPath);
  } catch {
    upToDate = false;
  }

  if (!upToDate) {
    await fs.promises.rm(targetManifestDir, { recursive: true, force: true });
    await fs.promises.rm(stampPath, { force: true });
    await fs.promises.mkdir(path.join(workspaceRoot, '.west'), { recursive: true });
    await fs.promises.cp(sourceManifestDir, targetManifestDir, { recursive: true });
    await fs.promises.writeFile(westConfigPath, WEST_CONFIG_CONTENT);
    await fs.promises.writeFile(stampPath, stamp);
  }

  return workspaceRoot;
}

function maskPersonalAccessToken(args: string[]): string[] {
  const masked = [...args];
  const flagIndex = masked.indexOf('--personal-access-token');
  if (flagIndex >= 0 && flagIndex + 1 < masked.length) {
    masked[flagIndex + 1] = '***';
  }
  return masked;
}

// Belt and braces: scrub the PAT value from any process output before it reaches
// the output channel or the error tail (west may echo arguments in verbose mode).
function createSecretMasker(secret?: string): (text: string) => string {
  if (!secret) {
    return text => text;
  }
  return text => text.split(secret).join('***');
}

type NotificationProgress = vscode.Progress<{ message?: string; increment?: number }>;

// Progress parsing grounded in sdk.py's inf() strings: "Fetching Zephyr SDK list...",
// "Fetching sha256...", "Downloading <url>...", tqdm lines ("<name>:  42%|..."),
// "Downloaded: <file>", "Extract: <file>", "Move: <src> to <dest>.", plus the setup
// scripts' "Installing ..." lines. Tolerant: unrecognized lines are ignored.
function createWestSdkProgressReporter(progress?: NotificationProgress): (chunk: string) => void {
  let lastMessage = '';
  const report = (message: string) => {
    if (progress && message && message !== lastMessage) {
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
      if (/^Fetching Zephyr SDK list/.test(line)) {
        report('Fetching Zephyr SDK list...');
        continue;
      }
      if (/^Fetching sha256/.test(line)) {
        report('Fetching checksums...');
        continue;
      }
      const downloadMatch = line.match(/^Downloading\s+(\S+?)\.{3}$/);
      if (downloadMatch) {
        report(`Downloading ${path.basename(downloadMatch[1])}...`);
        continue;
      }
      // tqdm bar_format: "{desc}: {percentage:3.0f}%|{bar}|   {n_fmt} {rate_fmt} ..."
      const percentMatch = line.match(/^(.+?):\s+(\d{1,3})%\|/);
      if (percentMatch) {
        report(`${percentMatch[1].trim()}: ${percentMatch[2]}%`);
        continue;
      }
      if (/^Downloaded:/.test(line)) {
        report('Download complete. Verifying checksum...');
        continue;
      }
      if (/^Extract:/.test(line)) {
        report('Extracting SDK archive...');
        continue;
      }
      if (/^Move:/.test(line)) {
        report('Installing SDK files...');
        continue;
      }
      if (/already installed at/.test(line)) {
        report('SDK already installed. Running setup...');
        continue;
      }
      // setup.sh / setup.cmd toolchain and host-tools steps.
      if (/^Installing\b/.test(line)) {
        report(line);
      }
    }
  };
}

function appendToTail(tail: string[], text: string): void {
  for (const line of stripAnsi(text).split(/\r|\n/)) {
    const trimmed = line.trimEnd();
    if (trimmed.length > 0) {
      tail.push(trimmed);
    }
  }
  if (tail.length > TAIL_LINE_LIMIT) {
    tail.splice(0, tail.length - TAIL_LINE_LIMIT);
  }
}

// Stream a child's stdout+stderr to the shared output channel and resolve with its
// exit code. Rejects on spawn 'error' (e.g. executable not found).
function streamChildToOutput(
  child: ChildProcess,
  onChunk?: (text: string) => void,
  sanitize?: (text: string) => string,
): Promise<number> {
  const output = getOutputChannel();
  return new Promise<number>((resolve, reject) => {
    const handleData = (data: Buffer) => {
      let text = data.toString();
      if (sanitize) {
        text = sanitize(text);
      }
      output.append(text);
      onChunk?.(text);
    };
    child.stdout?.on('data', handleData);
    child.stderr?.on('data', handleData);
    child.on('error', reject);
    child.on('close', code => {
      output.appendLine('');
      resolve(code ?? -1);
    });
  });
}

function resolveEnvScriptPath(): string | undefined {
  const envScript = getConfiguredWorkbenchPath(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
  return envScript && fs.existsSync(envScript) ? envScript : undefined;
}

function resolveManagedVenvDir(): string {
  return getConfiguredVenvPath() ?? path.join(getInternalDirRealPath(), '.venv');
}

// Execution mode 1 (env script sourced) when the configured env script exists;
// otherwise mode 2 (managed venv west spawned directly, no shell). Throws
// 'west-missing' when neither is available.
function spawnWestSdkInstallChild(args: string[], workspaceRoot: string): ChildProcess {
  // ZEPHYR_BASE is cleared on purpose: sdk.py then finds no SDK_VERSION/EDT context
  // and its fetch_sdk_info cmake probe degrades to an empty list (install proceeds).
  const extraEnv = { ZEPHYR_BASE: '', PYTHONUNBUFFERED: '1' };

  // detached on POSIX puts the command in its own process group so cancellation
  // can kill the whole tree (wrapper shell, west, setup.sh, cmake) at once.
  const detached = process.platform !== 'win32';

  const envScript = resolveEnvScriptPath();
  if (envScript) {
    const command = ['west', ...args.map(shellQuoteArg)].join(' ');
    // spawnCommandWithEnv merges options.env over process.env, so the overrides win.
    return spawnCommandWithEnv(command, { cwd: workspaceRoot, env: { ...extraEnv }, detached });
  }

  const venvDir = resolveManagedVenvDir();
  const westPath = getManagedVenvWestPath(venvDir);
  if (!fs.existsSync(westPath)) {
    throw new WestSdkInstallError('west-missing', WEST_MISSING_MESSAGE);
  }

  const env = managedVenvProcessEnv(venvDir, extraEnv);
  if (process.platform === 'win32') {
    // Best effort: patoolib needs a 7z-capable extractor on PATH; the extension
    // already ships 7zip-bin.
    env.PATH = `${path.dirname(sevenBin.path7za)}${path.delimiter}${env.PATH ?? ''}`;
  }
  return spawn(westPath, args, { cwd: workspaceRoot, env, stdio: ['ignore', 'pipe', 'pipe'], detached });
}

/**
 * Run `west sdk install` from the materialized workspace. Resolves on exit 0 with
 * the expected SDK path (<installBase>/zephyr-sdk-<version>); throws
 * WestSdkInstallError otherwise.
 */
export async function runWestSdkInstall(
  context: vscode.ExtensionContext,
  options: WestSdkInstallOptions,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?: vscode.CancellationToken,
): Promise<{ sdkPath: string }> {
  const output = getOutputChannel();
  const workspaceRoot = await ensureWestSdkWorkspace(context);

  if (token?.isCancellationRequested) {
    throw new WestSdkInstallError('cancelled', CANCELLED_MESSAGE);
  }

  const args = buildWestSdkInstallArgs(options);
  output.appendLine('[command] West SDK Install');
  output.appendLine(`[cwd] ${workspaceRoot}`);
  output.appendLine(['west', ...maskPersonalAccessToken(args).map(quote)].join(' '));
  output.appendLine('');

  const child = spawnWestSdkInstallChild(args, workspaceRoot);

  const tail: string[] = [];
  const sanitize = createSecretMasker(options.personalAccessToken);
  const reportChunk = createWestSdkProgressReporter(progress);

  let cancelled = false;
  let settled = false;
  let escalation: NodeJS.Timeout | undefined;
  const cancellation = token?.onCancellationRequested(() => {
    cancelled = true;
    output.appendLine('Install cancelled. A partial temporary directory may remain under the install base.');
    killProcessTree(child, 'SIGTERM');
    // Escalate if part of the tree survives the polite signal.
    escalation = setTimeout(() => {
      if (!settled) {
        killProcessTree(child, 'SIGKILL');
      }
    }, 5000);
  });

  let exitCode: number;
  try {
    exitCode = await streamChildToOutput(child, text => {
      appendToTail(tail, text);
      reportChunk(text);
    }, sanitize);
  } catch (error) {
    const spawnError = error as NodeJS.ErrnoException;
    if (spawnError?.code === 'ENOENT') {
      throw new WestSdkInstallError('west-missing', WEST_MISSING_MESSAGE, tail.join('\n'));
    }
    const reason = spawnError?.message ?? String(error);
    output.appendLine(`west sdk install failed to start: ${reason}`);
    throw new WestSdkInstallError('unknown', `west sdk install could not start: ${reason}`, tail.join('\n'));
  } finally {
    settled = true;
    if (escalation) {
      clearTimeout(escalation);
    }
    cancellation?.dispose();
  }

  if (cancelled) {
    throw new WestSdkInstallError('cancelled', CANCELLED_MESSAGE, tail.join('\n'));
  }

  if (exitCode !== 0) {
    const tailText = tail.join('\n');
    const kind = classifyWestSdkFailure(tailText);
    throw new WestSdkInstallError(kind, USER_MESSAGES[kind], tailText);
  }

  const installBase = options.installBase ?? os.homedir();
  const sdkPath = path.join(installBase, `zephyr-sdk-${options.version}`);
  if (!(await pathExists(path.join(sdkPath, 'sdk_version')))) {
    output.appendLine(`Note: ${path.join(sdkPath, 'sdk_version')} was not found after install; returning the expected SDK path anyway.`);
  }
  return { sdkPath };
}

async function runSetupInvocation(setupScript: string, flags: string[], sdkPath: string): Promise<number> {
  const output = getOutputChannel();
  output.appendLine(`[command] SDK setup: ${quote(setupScript)} ${flags.join(' ')}`);

  const envScript = resolveEnvScriptPath();
  let child: ChildProcess;
  if (process.platform === 'win32') {
    // setup.cmd is a batch file: run it through cmd.exe directly regardless of
    // the configured shell (a bash-classified profile cannot execute .cmd), and
    // put the managed cmake and the bundled 7za on PATH (setup.cmd needs both).
    const env = { ...process.env };
    const pathPrefixes = [path.dirname(sevenBin.path7za)];
    const cmakeBin = path.join(getInternalDirRealPath(), 'tools', 'cmake', 'bin');
    if (fs.existsSync(cmakeBin)) {
      pathPrefixes.unshift(cmakeBin);
    }
    env.PATH = [...pathPrefixes, env.PATH ?? ''].join(path.delimiter);
    child = spawn('cmd.exe', ['/c', setupScript, ...flags], {
      cwd: sdkPath,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else if (envScript) {
    // Route through the env script so cmake is on PATH.
    const command = `${shellQuoteArg(setupScript)} ${flags.join(' ')}`.trimEnd();
    child = spawnCommandWithEnv(command, { cwd: sdkPath });
  } else {
    child = spawn(setupScript, flags, {
      cwd: sdkPath,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  try {
    return await streamChildToOutput(child);
  } catch (error) {
    const reason = (error as Error)?.message ?? String(error);
    throw new WestSdkInstallError('setup-failed', `The SDK setup script could not be started: ${reason}`);
  }
}

/**
 * Run an existing SDK's setup script (<sdk>/setup.sh on POSIX, <sdk>/setup.cmd on
 * Windows) directly. Mirrors sdk.py's run_setup: a first invocation with -c (CMake
 * package registration, unless disabled), then a second one with the requested
 * -t/-l/-h flags. Throws WestSdkInstallError('setup-failed') on nonzero exit.
 */
export async function runSdkSetup(sdkPath: string, opts: SdkSetupOptions = {}): Promise<void> {
  const isWindows = process.platform === 'win32';
  const setupScript = path.join(sdkPath, isWindows ? 'setup.cmd' : 'setup.sh');
  const optsep = isWindows ? '/' : '-';

  const invocations: string[][] = [];
  if (opts.registerCmakePackage !== false) {
    invocations.push([`${optsep}c`]);
  }

  const componentFlags: string[] = [];
  for (const toolchain of opts.gnuToolchains ?? []) {
    componentFlags.push(`${optsep}t`, toolchain);
  }
  if (opts.llvm) {
    componentFlags.push(`${optsep}l`);
  }
  if (opts.hostTools) {
    componentFlags.push(`${optsep}h`);
  }
  if (componentFlags.length > 0) {
    invocations.push(componentFlags);
  }

  for (const flags of invocations) {
    const exitCode = await runSetupInvocation(setupScript, flags, sdkPath);
    if (exitCode !== 0) {
      throw new WestSdkInstallError(
        'setup-failed',
        `The SDK setup script failed (exit code ${exitCode}). Check the Zephyr Workbench output channel for details.`,
      );
    }
  }
}
