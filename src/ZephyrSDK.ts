import * as vscode from 'vscode';
import fs from "fs";
import path from "path";
import { fileExists } from './utils';

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
    return vscode.Uri.joinPath(this.rootUri, 'sdk_toolchains');
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

  public static getToolchainPrefix(arch: string, socToolchainName: string | undefined = undefined) {
    let prefix = '';
    switch(arch) {
      case 'arm': 
        prefix = 'arm-zephyr-eabi';
        break;
      case 'arm64': 
        prefix = 'aarch64-zephyr-eabi';
        break;
      case 'riscv':
        prefix = 'riscv64-zephyr-elf';
        break;
      case 'microblaze':
        prefix = 'microblazeel-zephyr-elf';
        break;
      case 'x86':
        prefix = 'x86_64-zephyr-elf';
        break;
      case 'xtensa':
        prefix = `xtensa-${socToolchainName}_zephyr-elf`;
        break;
      default:
        prefix = `${arch}-zephyr-elf`;
        break;
    }
    return prefix;
  }

  public getCompilerPath(arch: string, socToolchain: string | undefined = undefined): string {
    let compilerPrefix = '';
    if(arch === 'xtensa' && socToolchain) {
      compilerPrefix = ZephyrSDK.getToolchainPrefix(arch, socToolchain);
    } else {
      compilerPrefix = ZephyrSDK.getToolchainPrefix(arch);
    }
    return path.join(this.rootUri.fsPath, compilerPrefix, 'bin', `${compilerPrefix}-gcc`);
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
    return path.join('${config:zephyr-workbench.sdk}', compilerPrefix, 'bin', `${compilerPrefix}-gdb${ext}`);
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