import * as vscode from 'vscode';
import os from 'os';
import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { download, execCommand } from '../installUtils';
import { compareVersions, getInternalToolsDirRealPath } from '../utils';

const RUSTUP_DIST_BASE_URL = 'https://static.rust-lang.org/rustup/dist';
const RUSTUP_RELEASE_MANIFEST_URL = 'https://static.rust-lang.org/rustup/release-stable.toml';

export const MSVC_BUILD_TOOLS_MANUAL_URL = 'https://visualstudio.microsoft.com/visual-cpp-build-tools/';
// Official Visual Studio 2022 Build Tools bootstrapper (evergreen link).
const VS_BUILD_TOOLS_BOOTSTRAPPER_URL = 'https://aka.ms/vs/17/release/vs_BuildTools.exe';

export interface RustupStatus {
  installed: boolean;
  managed: boolean;
  rustupPath?: string;
  version?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  // Where the workbench installs rustup (.zinstaller/tools/rustup, fixed) and
  // where the active rustup actually stores its toolchains.
  managedRootDir: string;
  toolchainsDir?: string;
  prereqOk: boolean;
  prereqMessage: string;
  // True when the missing prerequisites can be installed by the extension
  // in one click (Windows: VS Build Tools bootstrapper).
  prereqInstallable: boolean;
}

// rustup is installed self-contained and exclusively under
// .zinstaller/tools/rustup/ (no PATH change, no ~/.cargo).
export function getManagedRustupRootDir(): string {
  return path.join(getInternalToolsDirRealPath(), 'rustup');
}

export function getManagedRustupHome(): string {
  return path.join(getManagedRustupRootDir(), 'rustup-home');
}

function getManagedCargoHome(): string {
  return path.join(getManagedRustupRootDir(), 'cargo-home');
}

export function getManagedRustupBinPath(): string {
  const exe = process.platform === 'win32' ? 'rustup.exe' : 'rustup';
  return path.join(getManagedCargoHome(), 'bin', exe);
}

// Environment for every managed rustup invocation: redirect both homes into
// the managed root so installs and metadata stay self-contained.
export function getManagedRustupEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RUSTUP_HOME: getManagedRustupHome(),
    CARGO_HOME: getManagedCargoHome(),
  };
}

function getRustupInitHostTriple(): string | undefined {
  if (process.platform === 'win32' && process.arch === 'x64') {
    return 'x86_64-pc-windows-msvc';
  }
  if (process.platform === 'win32' && process.arch === 'arm64') {
    return 'aarch64-pc-windows-msvc';
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return 'x86_64-unknown-linux-gnu';
  }
  if (process.platform === 'linux' && process.arch === 'arm64') {
    return 'aarch64-unknown-linux-gnu';
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return 'aarch64-apple-darwin';
  }
  if (process.platform === 'darwin' && process.arch === 'x64') {
    return 'x86_64-apple-darwin';
  }
  return undefined;
}

export function getRustupInitUrl(): string | undefined {
  const triple = getRustupInitHostTriple();
  if (!triple) {
    return undefined;
  }
  const exe = process.platform === 'win32' ? 'rustup-init.exe' : 'rustup-init';
  return `${RUSTUP_DIST_BASE_URL}/${triple}/${exe}`;
}

export interface FoundRustup {
  rustupPath: string;
  managed: boolean;
}

/**
 * Locate rustup: the managed install under .zinstaller/tools/rustup/ takes
 * precedence, then any rustup already on the user's PATH.
 */
export async function findRustup(): Promise<FoundRustup | undefined> {
  const managedBin = getManagedRustupBinPath();
  if (fs.existsSync(managedBin)) {
    return { rustupPath: managedBin, managed: true };
  }

  const lookupCmd = process.platform === 'win32' ? 'where rustup' : 'command -v rustup';
  try {
    const output = await execCommand(lookupCmd);
    const firstHit = output.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0);
    if (firstHit) {
      return { rustupPath: firstHit, managed: false };
    }
  } catch {
    // Not on PATH.
  }

  return undefined;
}

export async function getRustupVersion(rustup: FoundRustup): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      rustup.rustupPath,
      ['--version'],
      { env: rustup.managed ? getManagedRustupEnv() : process.env },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        resolve(/^rustup (\d+\.\d+\.\d+)/.exec(stdout.trim())?.[1]);
      },
    );
  });
}

/** Latest rustup version published in the official release manifest. */
export async function fetchLatestRustupVersion(): Promise<string | undefined> {
  try {
    const response = await fetch(RUSTUP_RELEASE_MANIFEST_URL, {
      headers: { 'User-Agent': 'zephyr-workbench' },
    });
    if (!response.ok) {
      return undefined;
    }
    const toml = await response.text();
    // The manifest quotes the value with single quotes (version = '1.29.0');
    // accept both styles to be safe.
    return /^version\s*=\s*['"](\d+\.\d+\.\d+)['"]/m.exec(toml)?.[1];
  } catch {
    return undefined;
  }
}

export interface RustPrerequisitesStatus {
  ok: boolean;
  message: string;
}

/**
 * Rust toolchains need a host linker: on Windows the default MSVC host
 * toolchain requires the Visual Studio C++ Build Tools, on Linux a C
 * compiler/linker, on macOS the Xcode Command Line Tools.
 */
export async function checkRustPrerequisites(): Promise<RustPrerequisitesStatus> {
  if (process.platform === 'win32') {
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const vswherePath = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');

    if (fs.existsSync(vswherePath)) {
      const installationPath = await new Promise<string>((resolve) => {
        execFile(
          vswherePath,
          ['-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-latest', '-property', 'installationPath'],
          (error, stdout) => resolve(error ? '' : stdout.trim()),
        );
      });

      if (installationPath) {
        return {
          ok: true,
          message: 'Prerequisites OK: Visual Studio C++ Build Tools found.',
        };
      }
    }

    return {
      ok: false,
      message: 'Missing prerequisites: the default Rust host toolchain (MSVC) needs the Visual Studio C++ Build Tools '
        + 'with the "Desktop development with C++" workload. Use the install button below, or get them manually from '
        + `${MSVC_BUILD_TOOLS_MANUAL_URL} (without them, the self-contained GNU host toolchain is used instead).`,
    };
  }

  if (process.platform === 'darwin') {
    try {
      await execCommand('xcode-select -p');
      return { ok: true, message: 'Prerequisites OK: Xcode Command Line Tools found.' };
    } catch {
      return { ok: false, message: 'Missing prerequisites: install the Xcode Command Line Tools (run "xcode-select --install").' };
    }
  }

  try {
    await execCommand('cc --version');
    return { ok: true, message: 'Prerequisites OK: C compiler/linker found.' };
  } catch {
    return { ok: false, message: 'Missing prerequisites: install a C compiler/linker (e.g. "sudo apt install build-essential").' };
  }
}

export async function getRustupStatus(): Promise<RustupStatus> {
  const [found, latestVersion, prereq] = await Promise.all([
    findRustup(),
    fetchLatestRustupVersion(),
    checkRustPrerequisites(),
  ]);

  const managedRootDir = getManagedRustupRootDir();
  const prereqInstallable = process.platform === 'win32' && !prereq.ok;

  if (!found) {
    return {
      installed: false,
      managed: false,
      latestVersion,
      managedRootDir,
      prereqOk: prereq.ok,
      prereqMessage: prereq.message,
      prereqInstallable,
    };
  }

  const version = await getRustupVersion(found);
  const updateAvailable = !!version && !!latestVersion && compareVersions(latestVersion, version) > 0;

  // Toolchains of the managed rustup live under the managed RUSTUP_HOME; a
  // rustup found on PATH uses its own home (env override or ~/.rustup).
  const toolchainsDir = found.managed
    ? path.join(getManagedRustupHome(), 'toolchains')
    : path.join(process.env.RUSTUP_HOME ?? path.join(os.homedir(), '.rustup'), 'toolchains');

  return {
    installed: true,
    managed: found.managed,
    rustupPath: found.rustupPath,
    version,
    latestVersion,
    updateAvailable,
    managedRootDir,
    toolchainsDir,
    prereqOk: prereq.ok,
    prereqMessage: prereq.message,
    prereqInstallable,
  };
}

/**
 * One-click install of the Visual Studio C++ Build Tools: downloads the
 * official bootstrapper and runs the unattended install of the "Desktop
 * development with C++" workload (--passive shows a progress window; the
 * installer elevates itself via UAC). Exit code 3010 means success with a
 * reboot recommended.
 */
export async function installMsvcBuildTools(
  context: vscode.ExtensionContext,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('The Visual Studio C++ Build Tools installer is only available on Windows.');
  }

  progress.report({ message: `Download ${VS_BUILD_TOOLS_BOOTSTRAPPER_URL}` });
  const downloadedFileUri = await download(
    VS_BUILD_TOOLS_BOOTSTRAPPER_URL,
    getManagedRustupRootDir(),
    context,
    progress,
    token,
  );

  progress.report({ message: 'Running the Visual Studio Build Tools installer (accept the elevation prompt)...' });
  await new Promise<void>((resolve, reject) => {
    execFile(
      downloadedFileUri.fsPath,
      [
        '--passive', '--wait', '--norestart', '--nocache',
        '--add', 'Microsoft.VisualStudio.Workload.VCTools',
        '--includeRecommended',
      ],
      (error) => {
        const exitCode = (error as any)?.code;
        if (!error || exitCode === 3010) {
          resolve();
          return;
        }
        reject(new Error(
          `Visual Studio Build Tools installer failed (exit ${exitCode ?? 'unknown'}). `
          + `Install it manually from ${MSVC_BUILD_TOOLS_MANUAL_URL} and select the "Desktop development with C++" workload.`,
        ));
      },
    );
  });

  const verification = await checkRustPrerequisites();
  if (!verification.ok) {
    throw new Error(
      'The installer finished but the C++ Build Tools were not detected. '
      + `Install them manually from ${MSVC_BUILD_TOOLS_MANUAL_URL} and select the "Desktop development with C++" workload.`,
    );
  }
}

/**
 * Decide the rustup toolchain name for a version/channel. On Windows x64
 * without the MSVC Build Tools, the self-contained GNU host toolchain is
 * used instead (rustup installs rust-mingw alongside it, so build scripts
 * and proc-macros link without Visual Studio).
 */
export function resolveRustupToolchainName(versionOrChannel: string, msvcPrereqOk: boolean): string {
  if (process.platform === 'win32' && process.arch === 'x64' && !msvcPrereqOk) {
    return `${versionOrChannel}-x86_64-pc-windows-gnu`;
  }
  return versionOrChannel;
}

/** Run a rustup command, streaming its output to the progress reporter. */
export function execRustup(
  rustup: FoundRustup,
  args: string[],
  progress?: vscode.Progress<{ message?: string }>,
  token?: vscode.CancellationToken,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(rustup.rustupPath, args, {
      env: rustup.managed ? getManagedRustupEnv() : process.env,
    });

    let recentOutput = '';
    const onData = (data: Buffer) => {
      const text = data.toString();
      recentOutput = (recentOutput + text).slice(-2000);
      const line = text.split(/\r?\n/).map(part => part.trim()).filter(Boolean).pop();
      if (line && progress) {
        progress.report({ message: line.slice(0, 120) });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const cancellation = token?.onCancellationRequested(() => {
      child.kill();
    });

    child.on('error', (error) => {
      cancellation?.dispose();
      reject(error);
    });
    child.on('close', (code) => {
      cancellation?.dispose();
      if (token?.isCancellationRequested) {
        reject(Object.assign(new Error('Cancelled'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const tail = recentOutput.trim().split(/\r?\n/).slice(-5).join('\n');
      reject(new Error(`rustup ${args.join(' ')} failed (exit ${code}):\n${tail}`));
    });
  });
}

export function execRustupCapture(rustup: FoundRustup, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      rustup.rustupPath,
      args,
      { env: rustup.managed ? getManagedRustupEnv() : process.env },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`rustup ${args.join(' ')} failed: ${stderr || error.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Install a Rust toolchain plus the requested embedded targets through
 * rustup (the managed one by default), then resolve the toolchain's
 * installation directory. Re-running for an existing toolchain is a cheap
 * no-op for rustup, so this also "imports" already-installed toolchains.
 */
export async function installRustToolchainViaRustup(
  rustup: FoundRustup,
  toolchainName: string,
  targets: string[],
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
): Promise<string> {
  progress.report({ message: `rustup toolchain install ${toolchainName}` });
  await execRustup(
    rustup,
    ['toolchain', 'install', toolchainName, '--profile', 'minimal', '--no-self-update'],
    progress,
    token,
  );

  if (targets.length > 0) {
    progress.report({ message: `rustup target add (${targets.length} targets)` });
    await execRustup(rustup, ['target', 'add', '--toolchain', toolchainName, ...targets], progress, token);
  }

  const rustcPath = (await execRustupCapture(rustup, ['which', 'rustc', '--toolchain', toolchainName])).trim();
  if (!rustcPath) {
    throw new Error('Unable to locate the installed toolchain (rustup which rustc returned nothing).');
  }

  // <toolchain root>/bin/rustc
  return path.dirname(path.dirname(rustcPath));
}

/**
 * Uninstall a rustup-managed toolchain. Uses the same rustup that owns the
 * toolchain directory (managed homes or the user's own rustup).
 */
export async function uninstallRustToolchainViaRustup(toolchainPath: string, rustupToolchain: string): Promise<boolean> {
  const managedHome = getManagedRustupHome();
  const insideManaged = toolchainPath.toLowerCase().startsWith(managedHome.toLowerCase());
  const found = await findRustup();

  const rustup: FoundRustup | undefined = insideManaged
    ? (fs.existsSync(getManagedRustupBinPath())
        ? { rustupPath: getManagedRustupBinPath(), managed: true }
        : undefined)
    : found;

  if (!rustup) {
    return false;
  }

  await execRustupCapture(rustup, ['toolchain', 'uninstall', rustupToolchain]);
  return true;
}

/**
 * Download rustup-init from static.rust-lang.org (no package manager
 * involved) and run it self-contained against the managed homes. No
 * toolchain is installed yet ("--default-toolchain none") and the user's
 * PATH/profile is never modified.
 */
export async function installManagedRustup(
  context: vscode.ExtensionContext,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
): Promise<void> {
  const url = getRustupInitUrl();
  if (!url) {
    throw new Error('rustup installation is not supported on this platform.');
  }

  fs.mkdirSync(getManagedRustupRootDir(), { recursive: true });

  progress.report({ message: `Download ${url}` });
  const downloadedFileUri = await download(url, getManagedRustupRootDir(), context, progress, token);
  const rustupInitPath = downloadedFileUri.fsPath;

  if (process.platform !== 'win32') {
    fs.chmodSync(rustupInitPath, 0o755);
  }

  progress.report({ message: 'Running rustup-init...' });
  await new Promise<void>((resolve, reject) => {
    execFile(
      rustupInitPath,
      ['-y', '--no-modify-path', '--default-toolchain', 'none'],
      { env: getManagedRustupEnv() },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`rustup-init failed: ${stderr || error.message}`));
          return;
        }
        resolve();
      },
    );
  });

  if (!fs.existsSync(getManagedRustupBinPath())) {
    throw new Error('rustup-init finished but the managed rustup binary was not found.');
  }
}
