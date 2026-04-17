import * as vscode from 'vscode';
import fs from "fs";
import path from "path";
import { fileExists } from '../utils/utils';

export type ZephyrToolchainVariant = 'zephyr' | 'zephyr/llvm';

export function normalizeZephyrToolchainVariant(
  variant: string | undefined,
  sdk?: ZephyrSDK,
): ZephyrToolchainVariant {
  if (variant === 'zephyr/llvm' && (!sdk || sdk.hasLlvmToolchain())) {
    return 'zephyr/llvm';
  }
  return 'zephyr';
}

export class ZephyrSDK {
  version!: string;
  toolchains!: string[];

  constructor(
    public rootUri: vscode.Uri
  ) {
    this.parseVersion();
    this.parseToolchains();
  }

  private parseVersion() {
    let filePath = this.versionFile.fsPath;
    this.version = fs.readFileSync(filePath, 'utf-8');
  }

  private parseToolchains() {
    let filePath = this.toolchainsFile.fsPath;
    let content = fs.readFileSync(filePath, 'utf-8');
    this.toolchains = content.split(/\r?\n/).filter(line => line.trim() !== '');
  }

  private get versionFile() {
    return vscode.Uri.joinPath(this.rootUri, 'sdk_version');
  }

  private get toolchainsFile() {
    const legacyFile = vscode.Uri.joinPath(this.rootUri, 'sdk_toolchains');
    if (fileExists(legacyFile.fsPath)) {
      return legacyFile;
    }
    return vscode.Uri.joinPath(this.rootUri, 'sdk_gnu_toolchains');
  }

  private get toolchainsRootPath(): string {
    const gnuPath = path.join(this.rootUri.fsPath, 'gnu');
    if (fileExists(this.toolchainsFile.fsPath) && path.basename(this.toolchainsFile.fsPath) === 'sdk_gnu_toolchains' && fileExists(gnuPath)) {
      return gnuPath;
    }
    return this.rootUri.fsPath;
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

  public getSupportedVariants(): ZephyrToolchainVariant[] {
    return this.hasLlvmToolchain()
      ? ['zephyr', 'zephyr/llvm']
      : ['zephyr'];
  }

  public static getToolchainPrefix(toolchainId: string, socToolchainName: string | undefined = undefined) {
    if (!toolchainId) { return toolchainId; }

    // Already a full identifier
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
    if (normalizeZephyrToolchainVariant(variant, this) === 'zephyr/llvm') {
      return this.getLlvmCompilerPath();
    }

    let compilerPrefix = '';
    if(arch === 'xtensa' && socToolchain) {
      compilerPrefix = ZephyrSDK.getToolchainPrefix(arch, socToolchain);
    } else {
      compilerPrefix = ZephyrSDK.getToolchainPrefix(arch);
    }
    return path.join(this.toolchainsRootPath, compilerPrefix, 'bin', `${compilerPrefix}-gcc`);
  }

  public getDebuggerPath(arch: string, socToolchain: string | undefined = undefined): string {
    let compilerPrefix = '';
    if(arch === 'xtensa' && socToolchain) {
      compilerPrefix = ZephyrSDK.getToolchainPrefix(arch, socToolchain);
    } else {
      compilerPrefix = ZephyrSDK.getToolchainPrefix(arch);
    }
    
    let ext = '';
    if(process.platform === 'win32') {
      ext = '.exe';
    }
    const sdkBasePath = this.toolchainsRootPath === this.rootUri.fsPath
      ? '${config:zephyr-workbench.sdk}'
      : path.join('${config:zephyr-workbench.sdk}', 'gnu');
    return path.join(sdkBasePath, compilerPrefix, 'bin', `${compilerPrefix}-gdb${ext}`);
  }

  static isSDKFolder(folder: vscode.WorkspaceFolder) {
    const sdkVersionFile = vscode.Uri.joinPath(folder.uri, 'sdk_version');
    return fileExists(sdkVersionFile.fsPath);
  }

  static isSDKPath(folderPath: string) {
    const sdkVersionPath = path.join(folderPath, 'sdk_version');
    return fileExists(sdkVersionPath);
  }
}

export class IARToolchain {
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
