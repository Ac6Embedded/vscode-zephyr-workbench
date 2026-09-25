import * as vscode from 'vscode';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  ZEPHYR_WORKBENCH_LIST_RUST_TOOLCHAINS_SETTING_KEY,
  ZEPHYR_WORKBENCH_SETTING_SECTION_KEY,
} from '../../constants';
import { getGitTags, GitRemoteQueryOptions } from '../execUtils';
import { download, DownloadHooks, execCommand, extract } from '../installUtils';
import { compareVersions } from '../utils';
import { findLibclangDir, RustLinkedCToolchainType } from '../../models/ToolchainInstallations';

export type RustHostTriple =
  | 'x86_64-pc-windows-gnu'
  | 'x86_64-unknown-linux-gnu'
  | 'aarch64-unknown-linux-gnu'
  | 'x86_64-apple-darwin'
  | 'aarch64-apple-darwin';

export interface RegisteredRustToolchain {
  toolchainPath: string;
  version?: string;
  targets?: string[];
  // rustup toolchain name (e.g. "stable" or "1.87.0"), set for toolchains
  // installed through rustup so they can be uninstalled with it. Standalone
  // installs assembled from dist archives leave it unset.
  rustupToolchain?: string;
  hostTriple?: RustHostTriple;
  cToolchainType?: RustLinkedCToolchainType;
  cToolchainPath?: string;
  llvmPath?: string;
}

const RUST_REPO_URL = 'https://github.com/rust-lang/rust';
// The authoritative Zephyr target triple mapping lives in the module's
// _rust_map_target() CMake function; platforms.txt only lists board names.
const ZEPHYR_RUST_CMAKE_URL = 'https://raw.githubusercontent.com/zephyrproject-rtos/zephyr-lang-rust/main/CMakeLists.txt';

// Older releases lack std support for some of the embedded triples below.
const RUST_MINIMUM_VERSION = '1.60.0';
const RUST_MAX_VERSION_COUNT = 30;

// rustup channel offered on top of the numbered releases.
export const RUST_STABLE_CHANNEL = 'stable';

// The targets the Add Toolchain wizard pre-checks in its Minimal mode
// (importsdk.mts): the Cortex-M4 (thumbv7em) and Cortex-M33 (thumbv8m.main)
// compilers, soft and hard float ABIs.
export const RUST_MINIMAL_PRESET_TARGETS: readonly string[] = [
  'thumbv7em-none-eabi',
  'thumbv7em-none-eabihf',
  'thumbv8m.main-none-eabi',
  'thumbv8m.main-none-eabihf',
];

// Snapshot of _rust_map_target() in zephyr-lang-rust, used when the online
// fetch fails.
const ZEPHYR_RUST_FALLBACK_TARGETS: string[] = [
  'thumbv6m-none-eabi',
  'thumbv7m-none-eabi',
  'thumbv7em-none-eabi',
  'thumbv7em-none-eabihf',
  'thumbv8m.base-none-eabi',
  'thumbv8m.main-none-eabi',
  'thumbv8m.main-none-eabihf',
  'riscv32i-unknown-none-elf',
  'riscv64imac-unknown-none-elf',
  'x86_64-unknown-none',
  'aarch64-unknown-none',
];

// Zephyr usage context per triple, derived from the CPU conditions in the
// module's _rust_map_target() CMake function.
const ZEPHYR_RUST_TARGET_INFO: Record<string, string> = {
  'thumbv6m-none-eabi': 'Cortex-M0/M0+/M1',
  'thumbv7m-none-eabi': 'Cortex-M3',
  'thumbv7em-none-eabi': 'Cortex-M4/M7 (soft-float ABI)',
  'thumbv7em-none-eabihf': 'Cortex-M4/M7 (hard-float ABI)',
  'thumbv8m.base-none-eabi': 'Cortex-M23',
  'thumbv8m.main-none-eabi': 'Cortex-M33/M55 (soft-float ABI)',
  'thumbv8m.main-none-eabihf': 'Cortex-M33/M55 (hard-float ABI)',
  'riscv32i-unknown-none-elf': 'RV32 RISC-V SoCs (e.g. ESP32-C3)',
  'riscv64imac-unknown-none-elf': 'RV64 RISC-V SoCs',
  'x86_64-unknown-none': 'native_sim on x86_64 hosts',
  'aarch64-unknown-none': 'native_sim on AArch64 hosts',
};

const RUST_PLATFORM_SUPPORT_MD_URL = 'https://raw.githubusercontent.com/rust-lang/rust/master/src/doc/rustc/src/platform-support.md';

const RUST_DIST_BASE_URL = 'https://static.rust-lang.org/dist';
const LLVM_RELEASES_BASE_URL = 'https://github.com/llvm/llvm-project/releases/download';
const LLVM_REPO_URL = 'https://github.com/llvm/llvm-project';
// bindgen (used by zephyr-lang-rust to generate the zephyr-sys bindings)
// locates libclang via LIBCLANG_PATH; the host LLVM exists only for that.
const LLVM_MINIMUM_MAJOR = 20;
// Curated default keeps every major.minor series but only its newest few
// patches, so the dropdown isn't flooded by older point releases.
const LLVM_SUGGESTED_PATCHES_PER_MINOR = 2;

export function getRustHostTriple(): RustHostTriple | undefined {
  if (process.platform === 'win32' && process.arch === 'x64') {
    // windows-gnu (not msvc) so the rust-mingw component makes host linking
    // work without a Visual Studio installation.
    return 'x86_64-pc-windows-gnu';
  }

  if (process.platform === 'linux' && process.arch === 'x64') {
    return 'x86_64-unknown-linux-gnu';
  }

  if (process.platform === 'linux' && process.arch === 'arm64') {
    return 'aarch64-unknown-linux-gnu';
  }

  if (process.platform === 'darwin' && process.arch === 'x64') {
    return 'x86_64-apple-darwin';
  }

  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return 'aarch64-apple-darwin';
  }

  return undefined;
}

export function buildRustDistUrls(
  version: string,
  hostTriple: RustHostTriple,
  targets: string[],
): string[] {
  const urls = [
    `${RUST_DIST_BASE_URL}/rustc-${version}-${hostTriple}.tar.xz`,
    `${RUST_DIST_BASE_URL}/cargo-${version}-${hostTriple}.tar.xz`,
    // Host std is required: cargo build scripts and proc-macros compile for host.
    `${RUST_DIST_BASE_URL}/rust-std-${version}-${hostTriple}.tar.xz`,
  ];

  if (hostTriple === 'x86_64-pc-windows-gnu') {
    urls.push(`${RUST_DIST_BASE_URL}/rust-mingw-${version}-${hostTriple}.tar.xz`);
  }

  for (const target of targets) {
    urls.push(`${RUST_DIST_BASE_URL}/rust-std-${version}-${target}.tar.xz`);
  }

  return urls;
}

export function getRustDistTopLevelDirName(url: string): string {
  return path.basename(new URL(url).pathname).replace(/\.tar\.(xz|gz)$/, '');
}

/**
 * Merge the payload of every component of an extracted Rust dist archive
 * into the install root. Each archive contains a `components` file plus one
 * directory per component holding `manifest.in` and the file tree to overlay.
 */
export async function installRustDistComponents(extractedDir: string, installRoot: string): Promise<void> {
  const componentsFile = path.join(extractedDir, 'components');
  if (!fs.existsSync(componentsFile)) {
    throw new Error(`Invalid Rust dist archive layout: missing components file in ${extractedDir}`);
  }

  const components = fs.readFileSync(componentsFile, 'utf-8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '');

  for (const component of components) {
    const componentDir = path.join(extractedDir, component);
    if (!fs.existsSync(componentDir)) {
      throw new Error(`Invalid Rust dist archive layout: missing component ${component} in ${extractedDir}`);
    }

    for (const entry of fs.readdirSync(componentDir)) {
      if (entry === 'manifest.in') {
        continue;
      }
      mergeMove(path.join(componentDir, entry), path.join(installRoot, entry));
    }
  }
}

function mergeMove(src: string, dest: string): void {
  if (fs.existsSync(dest) && fs.statSync(dest).isDirectory() && fs.statSync(src).isDirectory()) {
    for (const entry of fs.readdirSync(src)) {
      mergeMove(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }

  try {
    fs.renameSync(src, dest);
  } catch {
    // Cross-device or locked file: fall back to copy + remove.
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

export interface LlvmVersionOptions {
  // Curated subset: every major.minor series for major >= LLVM_MINIMUM_MAJOR,
  // capped at LLVM_SUGGESTED_PATCHES_PER_MINOR latest patches each.
  suggested: string[];
  // Every release with major >= LLVM_MINIMUM_MAJOR, newest first.
  all: string[];
}

export async function fetchLlvmVersions(opts?: GitRemoteQueryOptions): Promise<LlvmVersionOptions> {
  const tags = await getGitTags(LLVM_REPO_URL, opts);

  const all = tags
    .map(tag => /^llvmorg-(\d+\.\d+\.\d+)$/.exec(tag)?.[1])
    .filter((version): version is string => !!version)
    .filter(version => Number(version.split('.')[0]) >= LLVM_MINIMUM_MAJOR)
    .sort((a, b) => compareVersions(b, a));

  return { suggested: selectSuggestedLlvmVersions(all), all };
}

// `all` must be sorted newest-first: walking it in order, the first patches we
// meet for each major.minor series are its latest, so capping the count per
// series yields the newest LLVM_SUGGESTED_PATCHES_PER_MINOR patches of every Y.
function selectSuggestedLlvmVersions(all: string[]): string[] {
  const patchesPerMinor = new Map<string, number>();
  const suggested: string[] = [];

  for (const version of all) {
    const [major, minor] = version.split('.');
    const minorKey = `${major}.${minor}`;
    const seen = patchesPerMinor.get(minorKey) ?? 0;
    if (seen >= LLVM_SUGGESTED_PATCHES_PER_MINOR) {
      continue;
    }
    patchesPerMinor.set(minorKey, seen + 1);
    suggested.push(version);
  }

  return suggested;
}

// Release asset per host (verified against llvmorg-20.x/21.x):
// Windows x64 ships as clang+llvm-<v>-x86_64-pc-windows-msvc.tar.xz, the
// other hosts as LLVM-<v>-<OS>-<ARCH>.tar.xz. macOS x64 has no 20+ asset.
function getLlvmAssetName(version: string): string | undefined {
  if (process.platform === 'win32' && process.arch === 'x64') {
    return `clang+llvm-${version}-x86_64-pc-windows-msvc.tar.xz`;
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return `LLVM-${version}-Linux-X64.tar.xz`;
  }
  if (process.platform === 'linux' && process.arch === 'arm64') {
    return `LLVM-${version}-Linux-ARM64.tar.xz`;
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return `LLVM-${version}-macOS-ARM64.tar.xz`;
  }
  return undefined;
}

export function buildLlvmDownloadUrl(version: string): string | undefined {
  const assetName = getLlvmAssetName(version);
  if (!assetName) {
    return undefined;
  }
  return `${LLVM_RELEASES_BASE_URL}/llvmorg-${version}/${assetName}`;
}

export function getLlvmTopLevelDirName(version: string): string | undefined {
  return getLlvmAssetName(version)?.replace(/\.tar\.xz$/, '');
}

export function isLlvmPath(llvmRoot: string): boolean {
  return !!findLibclangDir(llvmRoot);
}

/** The LLVM root a picked folder stands for: its bin/ or lib/ folder means the folder above it. */
export function llvmRootFromSelection(selectedPath: string): string {
  const base = path.basename(selectedPath).toLowerCase();
  return base === 'bin' || base === 'lib' ? path.dirname(selectedPath) : selectedPath;
}

const WINLIBS_LATEST_RELEASE_API_URL = 'https://api.github.com/repos/brechtsanders/winlibs_mingw/releases/latest';
export const WINLIBS_MANUAL_URL = 'https://winlibs.com/';

function getMingwBinDirPath(toolchainPath: string): string {
  return path.join(toolchainPath, 'mingw64', 'bin');
}

export function hasMingwToolchain(toolchainPath: string): boolean {
  return fs.existsSync(path.join(getMingwBinDirPath(toolchainPath), 'gcc.exe'));
}

interface WinLibsAsset {
  name: string;
  url: string;
  sha256Url?: string;
}

// Latest WinLibs MinGW-w64 build for x86_64 with POSIX threads and the UCRT
// runtime, as a plain zip (no LLVM bundle). This matches exactly one asset
// per release.
async function fetchLatestWinLibsAsset(): Promise<WinLibsAsset> {
  const response = await fetch(WINLIBS_LATEST_RELEASE_API_URL, {
    headers: {
      'User-Agent': 'zephyr-workbench',
      'Accept': 'application/vnd.github+json',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to query WinLibs releases (${response.status}).`);
  }

  const release: any = await response.json();
  const assets: any[] = Array.isArray(release?.assets) ? release.assets : [];
  const asset = assets.find(entry => typeof entry?.name === 'string'
    && entry.name.startsWith('winlibs-x86_64-')
    && entry.name.includes('posix')
    && entry.name.includes('ucrt')
    && !entry.name.includes('llvm')
    && entry.name.endsWith('.zip'));

  if (!asset) {
    throw new Error('No WinLibs UCRT x86_64 zip asset found in the latest release.');
  }

  const shaAsset = assets.find(entry => entry?.name === `${asset.name}.sha256`);
  return {
    name: asset.name,
    url: asset.browser_download_url,
    sha256Url: shaAsset?.browser_download_url,
  };
}

function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Install the WinLibs MinGW-w64 GCC toolchain into <rust toolchain>/mingw64
 * so standalone Rust installs carry their own host C tools (gcc, dlltool,
 * ld, ar, ...). The bin directory is picked up automatically by
 * prependRustBinPath whenever it exists.
 */
export async function installMingwToolchain(
  context: vscode.ExtensionContext,
  rustToolchainPath: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
  hooks?: DownloadHooks,
): Promise<string> {
  progress.report({ message: 'Querying the latest WinLibs MinGW-w64 release...' });
  const asset = await fetchLatestWinLibsAsset();

  progress.report({ message: `Download ${asset.name}` });
  const downloadedFileUri = await download(asset.url, rustToolchainPath, context, progress, token, hooks);

  // Best-effort checksum: skip silently when the hash cannot be obtained,
  // but fail hard on a real mismatch.
  if (asset.sha256Url) {
    progress.report({ message: 'Verifying SHA-256 checksum...' });
    let expected: string | undefined;
    try {
      const response = await fetch(asset.sha256Url, { headers: { 'User-Agent': 'zephyr-workbench' } });
      const text = response.ok ? await response.text() : '';
      // WinLibs .sha256 files wrap the hash in descriptive text.
      expected = /[0-9a-fA-F]{64}/.exec(text)?.[0]?.toLowerCase();
    } catch {
      expected = undefined;
    }
    if (expected) {
      const actual = await sha256OfFile(downloadedFileUri.fsPath);
      if (expected !== actual.toLowerCase()) {
        throw new Error(`WinLibs checksum mismatch (expected ${expected}, got ${actual}).`);
      }
    }
  }

  const stagingPath = path.join(rustToolchainPath, '.zw-mingw-staging');
  fs.mkdirSync(stagingPath, { recursive: true });
  try {
    progress.report({ message: `Extracting ${asset.name}` });
    await extract(downloadedFileUri.fsPath, stagingPath, progress, token);

    // WinLibs x86_64 archives wrap everything in a single top-level folder
    // (usually 'mingw64').
    const topDir = fs.readdirSync(stagingPath, { withFileTypes: true }).find(entry => entry.isDirectory());
    if (!topDir) {
      throw new Error('WinLibs archive extraction produced no top-level folder.');
    }

    const mingwDestPath = path.join(rustToolchainPath, 'mingw64');
    if (fs.existsSync(mingwDestPath)) {
      fs.rmSync(mingwDestPath, { recursive: true, force: true });
    }
    try {
      fs.renameSync(path.join(stagingPath, topDir.name), mingwDestPath);
    } catch {
      fs.cpSync(path.join(stagingPath, topDir.name), mingwDestPath, { recursive: true });
      fs.rmSync(path.join(stagingPath, topDir.name), { recursive: true, force: true });
    }

    if (!hasMingwToolchain(rustToolchainPath)) {
      throw new Error('MinGW-w64 installation is incomplete (gcc.exe not found).');
    }

    return mingwDestPath;
  } finally {
    fs.rmSync(stagingPath, { recursive: true, force: true });
  }
}

export async function updateRustToolchainLlvm(toolchainPath: string, llvmPath: string | undefined) {
  const cfg = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY);
  const list: RegisteredRustToolchain[] | undefined =
    cfg.get<RegisteredRustToolchain[]>(ZEPHYR_WORKBENCH_LIST_RUST_TOOLCHAINS_SETTING_KEY);

  if (!list) {
    throw new Error('Cannot update Rust toolchain: setting value corrupted, please edit settings.json');
  }

  const entry = list.find(item => item.toolchainPath === toolchainPath);
  if (!entry) {
    throw new Error(`This Rust toolchain [${toolchainPath}] is not found.`);
  }

  entry.llvmPath = llvmPath;

  await cfg.update(
    ZEPHYR_WORKBENCH_LIST_RUST_TOOLCHAINS_SETTING_KEY,
    list,
    vscode.ConfigurationTarget.Global,
  );
}

export async function fetchRustVersions(opts?: GitRemoteQueryOptions): Promise<string[]> {
  const tags = await getGitTags(RUST_REPO_URL, opts);

  return tags
    .filter(tag => /^\d+\.\d+\.\d+$/.test(tag))
    .filter(tag => compareVersions(tag, RUST_MINIMUM_VERSION) >= 0)
    // Rust tags carry no 'v' prefix, so getGitTags falls back to a locale
    // sort where 1.9.0 ranks above 1.10.0; re-sort semantically.
    .sort((a, b) => compareVersions(b, a))
    .slice(0, RUST_MAX_VERSION_COUNT);
}

export async function fetchZephyrRustTargets(signal?: AbortSignal): Promise<string[]> {
  try {
    const response = await fetch(ZEPHYR_RUST_CMAKE_URL, {
      headers: { 'User-Agent': 'zephyr-workbench' },
      signal,
    });
    if (!response.ok) {
      return ZEPHYR_RUST_FALLBACK_TARGETS;
    }

    const cmake = await response.text();
    const targets = new Set<string>();
    const regex = /set\(RUST_TARGET\s+"([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(cmake)) !== null) {
      targets.add(match[1]);
    }

    return targets.size > 0 ? [...targets] : ZEPHYR_RUST_FALLBACK_TARGETS;
  } catch {
    return ZEPHYR_RUST_FALLBACK_TARGETS;
  }
}

/**
 * Fetch the per-target notes column of the rustc book's platform support
 * tables (rows look like "[`thumbv7em-none-eabi`](...) | * | Bare Armv7E-M").
 * Never throws; returns an empty map on failure.
 */
export async function fetchRustTargetDescriptions(signal?: AbortSignal): Promise<Record<string, string>> {
  try {
    const response = await fetch(RUST_PLATFORM_SUPPORT_MD_URL, {
      headers: { 'User-Agent': 'zephyr-workbench' },
      signal,
    });
    if (!response.ok) {
      return {};
    }

    const markdown = await response.text();
    const descriptions: Record<string, string> = {};
    for (const line of markdown.split(/\r?\n/)) {
      const tripleMatch = /^\[?`([^`]+)`\]?/.exec(line.trim());
      if (!tripleMatch || !line.includes('|')) {
        continue;
      }
      const cells = line.split('|').map(cell => cell.trim()).filter(cell => cell !== '');
      const notes = cells[cells.length - 1];
      // The last cell may be the std/host marker when no notes exist.
      if (notes && notes !== '*' && notes !== '?' && notes !== '✓') {
        descriptions[tripleMatch[1]] = notes;
      }
    }

    return descriptions;
  } catch {
    return {};
  }
}

export async function fetchZephyrRustTargetDetails(signal?: AbortSignal): Promise<Array<{ target: string; description: string }>> {
  const [targets, rustcNotes] = await Promise.all([
    fetchZephyrRustTargets(signal),
    fetchRustTargetDescriptions(signal),
  ]);

  return targets.map(target => ({
    target,
    description: [ZEPHYR_RUST_TARGET_INFO[target], rustcNotes[target]]
      .filter(Boolean)
      .join(' - '),
  }));
}

/**
 * The Rust versions and Zephyr targets the Add Toolchain wizard offers. Only a
 * version lookup failure rejects: the targets fall back to a built-in list.
 */
export async function getRustImportData(opts: { versions?: GitRemoteQueryOptions; signal?: AbortSignal } = {}) {
  // fetchZephyrRustTargetDetails never throws (falls back to a static list);
  // only a version fetch failure rejects.
  const [versions, targetDetails] = await Promise.all([
    fetchRustVersions(opts.versions),
    fetchZephyrRustTargetDetails(opts.signal),
  ]);

  return {
    versions: [RUST_STABLE_CHANNEL, ...versions],
    targets: targetDetails.map(detail => detail.target),
    targetDescriptions: Object.fromEntries(
      targetDetails.map(detail => [detail.target, detail.description]),
    ),
  };
}

export async function detectRustVersion(toolchainPath: string): Promise<string> {
  const exe = process.platform === 'win32' ? 'rustc.exe' : 'rustc';
  const rustcPath = path.join(toolchainPath, 'bin', exe);

  try {
    const output = await execCommand(`"${rustcPath}" --version`);
    const match = /^rustc (\d+\.\d+\.\d+)/.exec(output.trim());
    return match?.[1] ?? '';
  } catch {
    return '';
  }
}

export async function registerRustToolchain(toolchain: RegisteredRustToolchain) {
  const cfg = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY);
  const list: RegisteredRustToolchain[] =
    cfg.get<RegisteredRustToolchain[]>(ZEPHYR_WORKBENCH_LIST_RUST_TOOLCHAINS_SETTING_KEY) ?? [];

  if (list.find(entry => entry.toolchainPath === toolchain.toolchainPath)) {
    throw new Error(`This Rust toolchain [${toolchain.toolchainPath}] is already registered.`);
  }

  list.push(toolchain);

  await cfg.update(
    ZEPHYR_WORKBENCH_LIST_RUST_TOOLCHAINS_SETTING_KEY,
    list,
    vscode.ConfigurationTarget.Global,
  );
}

/**
 * Register a Rust toolchain, or replace the registration of one already
 * registered in place: reinstalling a rustup toolchain updates its targets
 * and links rather than failing as a duplicate.
 */
export async function registerOrUpdateRustToolchain(toolchain: RegisteredRustToolchain) {
  const cfg = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY);
  const list: RegisteredRustToolchain[] =
    cfg.get<RegisteredRustToolchain[]>(ZEPHYR_WORKBENCH_LIST_RUST_TOOLCHAINS_SETTING_KEY) ?? [];

  const index = list.findIndex(entry => entry.toolchainPath === toolchain.toolchainPath);
  if (index === -1) {
    list.push(toolchain);
  } else {
    list[index] = toolchain;
  }

  await cfg.update(
    ZEPHYR_WORKBENCH_LIST_RUST_TOOLCHAINS_SETTING_KEY,
    list,
    vscode.ConfigurationTarget.Global,
  );
}

export async function updateRustToolchainLink(
  toolchainPath: string,
  cToolchainType: RustLinkedCToolchainType,
  cToolchainPath: string,
) {
  const cfg = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY);
  const list: RegisteredRustToolchain[] | undefined =
    cfg.get<RegisteredRustToolchain[]>(ZEPHYR_WORKBENCH_LIST_RUST_TOOLCHAINS_SETTING_KEY);

  if (!list) {
    throw new Error('Cannot update Rust toolchain: setting value corrupted, please edit settings.json');
  }

  const entry = list.find(item => item.toolchainPath === toolchainPath);
  if (!entry) {
    throw new Error(`This Rust toolchain [${toolchainPath}] is not found.`);
  }

  entry.cToolchainType = cToolchainType;
  entry.cToolchainPath = cToolchainPath;

  await cfg.update(
    ZEPHYR_WORKBENCH_LIST_RUST_TOOLCHAINS_SETTING_KEY,
    list,
    vscode.ConfigurationTarget.Global,
  );
}

export async function unregisterRustToolchain(toolchainPath: string) {
  const cfg = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY);
  const list: RegisteredRustToolchain[] | undefined =
    cfg.get<RegisteredRustToolchain[]>(ZEPHYR_WORKBENCH_LIST_RUST_TOOLCHAINS_SETTING_KEY);

  if (!list) {
    throw new Error('Cannot unregister Rust toolchain: setting value corrupted, please edit settings.json');
  }

  const index = list.findIndex(entry => entry.toolchainPath === toolchainPath);
  if (index === -1) {
    throw new Error(`This Rust toolchain [${toolchainPath}] is not found.`);
  }

  list.splice(index, 1);

  await cfg.update(
    ZEPHYR_WORKBENCH_LIST_RUST_TOOLCHAINS_SETTING_KEY,
    list,
    vscode.ConfigurationTarget.Global,
  );
}
