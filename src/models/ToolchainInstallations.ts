import * as vscode from 'vscode';
import fs from "fs";
import path from "path";
import { fileExists } from '../utils/utils';

// The stored toolchain variant always describes the C toolchain; Rust is an
// orthogonal per-app setting (zephyr-workbench.rust), never a variant value.
export type ToolchainVariantId = 'zephyr' | 'zephyr/llvm' | 'gnuarmemb' | 'iar';
export type RustLinkedCToolchainType = 'zephyr-sdk' | 'gnuarmemb';

/**
 * Locate the directory containing the libclang shared library inside an
 * LLVM installation (bin/ on Windows, lib/ elsewhere). This is the value
 * LIBCLANG_PATH must point to (bindgen finds libclang through it); returns
 * undefined when no libclang exists.
 */
export function findLibclangDir(llvmRoot: string): string | undefined {
  if (!llvmRoot) {
    return undefined;
  }

  const candidates = process.platform === 'win32'
    ? [path.join(llvmRoot, 'bin'), path.join(llvmRoot, 'lib')]
    : [path.join(llvmRoot, 'lib'), path.join(llvmRoot, 'bin')];
  const libclangPattern = process.platform === 'win32'
    ? /^libclang\.dll$/i
    : process.platform === 'darwin'
      ? /^libclang(\.\d+)*\.dylib$/
      : /^libclang(-\d+)?\.so(\.\d+)*$/;

  for (const dir of candidates) {
    try {
      if (fs.readdirSync(dir).some(entry => libclangPattern.test(entry))) {
        return dir;
      }
    } catch {
      // Missing directory: try the next candidate.
    }
  }

  return undefined;
}

// Make the selected Rust toolchain's cargo resolvable: zephyr-lang-rust
// invokes plain `cargo`, so PATH is the only discovery mechanism. Always
// compose with a full fallback because a PATH key in a merged env map
// replaces the inherited PATH wholesale.
export function prependRustBinPath(
  env: Record<string, string>,
  rustBinPath: string | undefined,
): Record<string, string> {
  if (!rustBinPath) {
    return env;
  }

  const prefixes = [rustBinPath];

  // Standalone installs may bundle a MinGW-w64 GCC toolchain (gcc, dlltool,
  // ld, ...) under <toolchain>/mingw64; expose its bin automatically.
  const mingwBinPath = path.join(path.dirname(rustBinPath), 'mingw64', 'bin');
  if (fs.existsSync(mingwBinPath)) {
    prefixes.push(mingwBinPath);
  }

  return {
    ...env,
    PATH: [...prefixes, env.PATH ?? process.env.PATH ?? ''].join(path.delimiter),
  };
}
export type ZephyrSdkVariantId = Extract<ToolchainVariantId, 'zephyr' | 'zephyr/llvm'>;
export type ArmGnuBareMetalTargetTriple = 'arm-none-eabi' | 'aarch64-none-elf';

export function ensureWindowsExecutableExtension(executablePath: string): string {
  if (process.platform !== 'win32' || !executablePath || path.extname(executablePath).length > 0) {
    return executablePath;
  }
  return `${executablePath}.exe`;
}

export function normalizeZephyrSdkVariant(
  variant: string | undefined,
  zephyrSdkInstallation?: ZephyrSdkInstallation,
): ZephyrSdkVariantId {
  if (variant === 'zephyr/llvm' && (!zephyrSdkInstallation || zephyrSdkInstallation.hasLlvmToolchain())) {
    return 'zephyr/llvm';
  }
  return 'zephyr';
}

export class ZephyrSdkInstallation {
  version!: string;
  gnuToolchainIds!: string[];

  constructor(
    public rootUri: vscode.Uri
  ) {
    this.parseVersion();
    this.parseGnuToolchains();
  }

  private parseVersion() {
    const filePath = this.versionFile.fsPath;
    this.version = fs.readFileSync(filePath, 'utf-8');
  }

  private parseGnuToolchains() {
    const filePath = this.gnuToolchainsFile.fsPath;
    const content = fs.readFileSync(filePath, 'utf-8');
    this.gnuToolchainIds = content.split(/\r?\n/).filter(line => line.trim() !== '');
  }

  private get versionFile() {
    return vscode.Uri.joinPath(this.rootUri, 'sdk_version');
  }

  private get gnuToolchainsFile() {
    const legacyFile = vscode.Uri.joinPath(this.rootUri, 'sdk_toolchains');
    if (fileExists(legacyFile.fsPath)) {
      return legacyFile;
    }
    return vscode.Uri.joinPath(this.rootUri, 'sdk_gnu_toolchains');
  }

  private get gnuToolchainsRootPath(): string {
    const gnuPath = path.join(this.rootUri.fsPath, 'gnu');
    if (fileExists(this.gnuToolchainsFile.fsPath) && path.basename(this.gnuToolchainsFile.fsPath) === 'sdk_gnu_toolchains' && fileExists(gnuPath)) {
      return gnuPath;
    }
    return this.rootUri.fsPath;
  }

  /**
   * Directory where per-toolchain packages live for this SDK: a `gnu/` subdir
   * for SDKs that nest toolchains there, otherwise the SDK root. Public so
   * callers adding a toolchain to an existing SDK extract into the right place.
   */
  public getGnuToolchainsRootPath(): string {
    return this.gnuToolchainsRootPath;
  }

  /**
   * The GNU toolchains actually present on disk for this SDK. The manifest file
   * (`sdk_gnu_toolchains`/`sdk_toolchains`) lists every toolchain the SDK knows
   * about, but a minimal install only extracts a subset — so the ground truth is
   * the set of `*-zephyr-elf`/`*-zephyr-eabi` directories under the toolchains
   * root (a `gnu/` subdir on newer SDKs, the SDK root on older ones). Returns each
   * toolchain's directory name and absolute path, sorted by name.
   */
  public getInstalledGnuToolchains(): { name: string; toolchainPath: string }[] {
    const root = this.gnuToolchainsRootPath;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter(entry => entry.isDirectory() && /-zephyr-(elf|eabi)$/.test(entry.name))
      .map(entry => ({ name: entry.name, toolchainPath: path.join(root, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get name(): string {
    return path.basename(this.rootUri.fsPath);
  }

  get buildEnv(): { [key: string]: string; } {
    return {
      ZEPHYR_SDK_INSTALL_DIR: this.rootUri.fsPath,
    };
  }

  get buildEnvWithVar(): { [key: string]: string; } {
    return {
      ZEPHYR_SDK_INSTALL_DIR: "${config:zephyr-workbench.sdk}"
    };
  }

  public hasLlvmToolchain(): boolean {
    return fileExists(this.getLlvmCompilerPath());
  }

  public getSupportedVariants(): ZephyrSdkVariantId[] {
    return this.hasLlvmToolchain()
      ? ['zephyr', 'zephyr/llvm']
      : ['zephyr'];
  }

  public static getCompilerPrefix(toolchainId: string, socToolchainName: string | undefined = undefined) {
    if (!toolchainId) { return toolchainId; }

    if (toolchainId.includes('zephyr-elf') || toolchainId.includes('zephyr-eabi')) {
      return toolchainId;
    }

    switch (toolchainId) {
      case 'arm':
        return 'arm-zephyr-eabi';
      case 'arm64':
      case 'aarch64':
        return 'aarch64-zephyr-elf';
      case 'riscv':
      case 'riscv64':
        return 'riscv64-zephyr-elf';
      case 'microblaze':
      case 'microblazeel':
        return 'microblazeel-zephyr-elf';
      case 'x86':
      case 'x86_64':
        return 'x86_64-zephyr-elf';
      case 'xtensa':
        if (socToolchainName) {
          return `xtensa-${socToolchainName}_zephyr-elf`;
        }
        return toolchainId;
      default:
        return `${toolchainId}-zephyr-elf`;
    }
  }

  public getLlvmCompilerPath(): string {
    const exe = process.platform === 'win32' ? 'clang.exe' : 'clang';
    return path.join(this.rootUri.fsPath, 'llvm', 'bin', exe);
  }

  public getCompilerPath(
    arch: string,
    socToolchain: string | undefined = undefined,
    variant: string = 'zephyr',
  ): string {
    if (normalizeZephyrSdkVariant(variant, this) === 'zephyr/llvm') {
      return this.getLlvmCompilerPath();
    }

    const compilerPrefix = arch === 'xtensa' && socToolchain
      ? ZephyrSdkInstallation.getCompilerPrefix(arch, socToolchain)
      : ZephyrSdkInstallation.getCompilerPrefix(arch);
    // No usable prefix (e.g. an unknown/empty arch) means no resolvable compiler;
    // bail out instead of letting path.join throw on an undefined segment.
    if (!compilerPrefix) {
      return '';
    }
    return ensureWindowsExecutableExtension(
      path.join(this.gnuToolchainsRootPath, compilerPrefix, 'bin', `${compilerPrefix}-gcc`)
    );
  }

  public getDebuggerPath(arch: string, socToolchain: string | undefined = undefined): string {
    const compilerPrefix = arch === 'xtensa' && socToolchain
      ? ZephyrSdkInstallation.getCompilerPrefix(arch, socToolchain)
      : ZephyrSdkInstallation.getCompilerPrefix(arch);

    let ext = '';
    if (process.platform === 'win32') {
      ext = '.exe';
    }
    const sdkBasePath = this.gnuToolchainsRootPath === this.rootUri.fsPath
      ? '${config:zephyr-workbench.sdk}'
      : path.join('${config:zephyr-workbench.sdk}', 'gnu');
    return path.join(sdkBasePath, compilerPrefix, 'bin', `${compilerPrefix}-gdb${ext}`);
  }

  static isSdkFolder(folder: vscode.WorkspaceFolder) {
    const sdkVersionFile = vscode.Uri.joinPath(folder.uri, 'sdk_version');
    return fileExists(sdkVersionFile.fsPath);
  }

  static isSdkPath(folderPath: string) {
    const sdkVersionPath = path.join(folderPath, 'sdk_version');
    return fileExists(sdkVersionPath);
  }
}

export class IarToolchainInstallation {
  constructor(
    public readonly zephyrSdkPath: string,
    public readonly iarPath: string,
    public readonly token: string,
  ) {}

  get name(): string {
    return `IAR-${path.basename(this.iarPath)}`;
  }

  get buildEnv(): Record<string, string> {
    return {
      IAR_TOOLCHAIN_DIR: this.iarPath,
      ZEPHYR_SDK_INSTALL_DIR: this.zephyrSdkPath,
    };
  }

  static isIarPath(p: string): boolean {
    if (!p) {return false;}

    const exe = process.platform === "win32" ? "iccarm.exe" : "iccarm";
    const candidates = [
      path.join(p, "bin", exe),
      path.join(p, "arm", "bin", exe),
      path.join(p, "common", "bin", exe),
    ];

    return candidates.some(fs.existsSync);
  }

  get compilerPath(): string {
    const exe = process.platform === "win32" ? "iccarm.exe" : "iccarm";
    const lookup = [
      path.join(this.iarPath, "bin", exe),
      path.join(this.iarPath, "arm", "bin", exe),
      path.join(this.iarPath, "common", "bin", exe),
    ];
    return lookup.find(fs.existsSync) || lookup[0];
  }
}

export function normalizeArmGnuTargetTriple(
  targetTriple: string | undefined,
  toolchainPath?: string,
): ArmGnuBareMetalTargetTriple {
  const detectedTargets = toolchainPath
    ? ArmGnuToolchainInstallation.detectTargetTriples(toolchainPath)
    : ArmGnuToolchainInstallation.supportedTargetTriples;

  if (targetTriple === 'aarch64-none-elf' && detectedTargets.includes(targetTriple)) {
    return 'aarch64-none-elf';
  }

  if (detectedTargets.includes('arm-none-eabi')) {
    return 'arm-none-eabi';
  }

  return detectedTargets[0] ?? 'arm-none-eabi';
}

export class ArmGnuToolchainInstallation {
  static readonly supportedTargetTriples: ArmGnuBareMetalTargetTriple[] = [
    'arm-none-eabi',
    'aarch64-none-elf',
  ];

  constructor(
    public readonly toolchainPath: string,
    public readonly targetTriple: ArmGnuBareMetalTargetTriple,
    public readonly version: string = '',
  ) {}

  get name(): string {
    const displayVersion = this.version
      ? this.version.replace(/\.rel(\d+)$/i, '.Rel$1')
      : '';
    const versionLabel = displayVersion ? ` ${displayVersion}` : '';
    return `Arm GNU${versionLabel} (${this.targetTriple})`;
  }

  get buildEnv(): Record<string, string> {
    return {
      GNUARMEMB_TOOLCHAIN_PATH: this.toolchainPath,
    };
  }

  get compilerPath(): string {
    const exe = process.platform === 'win32' ? '.exe' : '';
    return path.join(this.toolchainPath, 'bin', `${this.targetTriple}-gcc${exe}`);
  }

  get debuggerPath(): string {
    const exe = process.platform === 'win32' ? '.exe' : '';
    return path.join(this.toolchainPath, 'bin', `${this.targetTriple}-gdb${exe}`);
  }

  static detectTargetTriples(toolchainPath: string): ArmGnuBareMetalTargetTriple[] {
    const exe = process.platform === 'win32' ? '.exe' : '';
    return ArmGnuToolchainInstallation.supportedTargetTriples.filter(targetTriple =>
      fs.existsSync(path.join(toolchainPath, 'bin', `${targetTriple}-gcc${exe}`))
    );
  }

  static isArmGnuPath(toolchainPath: string): boolean {
    if (!toolchainPath) {
      return false;
    }

    return ArmGnuToolchainInstallation.detectTargetTriples(toolchainPath).length > 0;
  }
}

export class RustToolchainInstallation {
  constructor(
    public readonly toolchainPath: string,
    public readonly version: string = '',
    public readonly targets: string[] = [],
    public readonly cToolchainType?: RustLinkedCToolchainType,
    public readonly cToolchainPath?: string,
    public readonly llvmPath?: string,
  ) {}

  get name(): string {
    return this.version ? `Rust ${this.version}` : 'Rust';
  }

  get binPath(): string {
    return path.join(this.toolchainPath, 'bin');
  }

  get rustcPath(): string {
    return ensureWindowsExecutableExtension(path.join(this.binPath, 'rustc'));
  }

  get cargoPath(): string {
    return ensureWindowsExecutableExtension(path.join(this.binPath, 'cargo'));
  }

  get libclangDirPath(): string | undefined {
    return this.llvmPath ? findLibclangDir(this.llvmPath) : undefined;
  }

  get buildEnv(): Record<string, string> {
    // RUSTC is the standard cargo variable selecting the compiler (and,
    // through its sysroot, the std/embedded targets). cargo itself is found
    // via PATH only (zephyr-lang-rust invokes plain `cargo`); the PATH
    // prepend is composed at the execution sites via prependRustBinPath.
    // LIBCLANG_PATH lets bindgen find libclang in the linked host LLVM;
    // that LLVM is never put on PATH.
    const libclangDir = this.libclangDirPath;
    return {
      RUSTC: this.rustcPath,
      ...(libclangDir ? { LIBCLANG_PATH: libclangDir } : {}),
    };
  }

  static isRustPath(toolchainPath: string): boolean {
    if (!toolchainPath) {
      return false;
    }

    const rustc = ensureWindowsExecutableExtension(path.join(toolchainPath, 'bin', 'rustc'));
    const cargo = ensureWindowsExecutableExtension(path.join(toolchainPath, 'bin', 'cargo'));
    return fs.existsSync(rustc) && fs.existsSync(cargo);
  }

  static detectInstalledTargets(toolchainPath: string): string[] {
    const rustlibPath = path.join(toolchainPath, 'lib', 'rustlib');
    if (!fs.existsSync(rustlibPath)) {
      return [];
    }

    // Bare-metal triples end with '-none' or contain '-none-' (thumbv*-none-eabi,
    // riscv*-unknown-none-elf, x86_64-unknown-none); host triples never do.
    return fs.readdirSync(rustlibPath).filter(entry =>
      /-none(-|$)/.test(entry)
      && fs.existsSync(path.join(rustlibPath, entry, 'lib'))
    );
  }
}

export type ToolchainInstallation =
  | ZephyrSdkInstallation
  | IarToolchainInstallation
  | ArmGnuToolchainInstallation
  | RustToolchainInstallation;
