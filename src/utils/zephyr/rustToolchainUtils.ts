import * as vscode from 'vscode';
import fs from 'fs';
import path from 'path';
import {
  ZEPHYR_WORKBENCH_LIST_RUST_TOOLCHAINS_SETTING_KEY,
  ZEPHYR_WORKBENCH_SETTING_SECTION_KEY,
} from '../../constants';
import { getGitTags } from '../execUtils';
import { execCommand } from '../installUtils';
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

// Snapshot of _rust_map_target() in zephyr-lang-rust, used when the online
// fetch fails.
export const ZEPHYR_RUST_FALLBACK_TARGETS: string[] = [
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
export const ZEPHYR_RUST_TARGET_INFO: Record<string, string> = {
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
const LLVM_MAX_VERSION_COUNT = 20;

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

export async function fetchLlvmVersions(): Promise<string[]> {
  const tags = await getGitTags(LLVM_REPO_URL);

  return tags
    .map(tag => /^llvmorg-(\d+\.\d+\.\d+)$/.exec(tag)?.[1])
    .filter((version): version is string => !!version)
    .filter(version => Number(version.split('.')[0]) >= LLVM_MINIMUM_MAJOR)
    .sort((a, b) => compareVersions(b, a))
    .slice(0, LLVM_MAX_VERSION_COUNT);
}

// Release asset per host (verified against llvmorg-20.x/21.x):
// Windows x64 ships as clang+llvm-<v>-x86_64-pc-windows-msvc.tar.xz, the
// other hosts as LLVM-<v>-<OS>-<ARCH>.tar.xz. macOS x64 has no 20+ asset.
export function getLlvmAssetName(version: string): string | undefined {
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

export async function fetchRustVersions(): Promise<string[]> {
  const tags = await getGitTags(RUST_REPO_URL);

  return tags
    .filter(tag => /^\d+\.\d+\.\d+$/.test(tag))
    .filter(tag => compareVersions(tag, RUST_MINIMUM_VERSION) >= 0)
    // Rust tags carry no 'v' prefix, so getGitTags falls back to a locale
    // sort where 1.9.0 ranks above 1.10.0; re-sort semantically.
    .sort((a, b) => compareVersions(b, a))
    .slice(0, RUST_MAX_VERSION_COUNT);
}

export async function fetchZephyrRustTargets(): Promise<string[]> {
  try {
    const response = await fetch(ZEPHYR_RUST_CMAKE_URL, {
      headers: { 'User-Agent': 'zephyr-workbench' },
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
export async function fetchRustTargetDescriptions(): Promise<Record<string, string>> {
  try {
    const response = await fetch(RUST_PLATFORM_SUPPORT_MD_URL, {
      headers: { 'User-Agent': 'zephyr-workbench' },
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

export async function fetchZephyrRustTargetDetails(): Promise<Array<{ target: string; description: string }>> {
  const [targets, rustcNotes] = await Promise.all([
    fetchZephyrRustTargets(),
    fetchRustTargetDescriptions(),
  ]);

  return targets.map(target => ({
    target,
    description: [ZEPHYR_RUST_TARGET_INFO[target], rustcNotes[target]]
      .filter(Boolean)
      .join(' - '),
  }));
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
