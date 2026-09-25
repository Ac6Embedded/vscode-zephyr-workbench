// What the toolchain tools know about the installed toolchains: every Zephyr
// SDK (registered, global and the host tools one) with what is really on disk,
// the registered Arm GNU, IAR and Rust toolchains, and the registrations whose
// folder is gone. Read afresh on every call, never cached, and never carrying
// an IAR licence token: only whether one is stored.

import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  ZEPHYR_WORKBENCH_LIST_ARM_GNU_TOOLCHAINS_SETTING_KEY,
  ZEPHYR_WORKBENCH_LIST_IARS_SETTING_KEY,
  ZEPHYR_WORKBENCH_LIST_RUST_TOOLCHAINS_SETTING_KEY,
  ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY,
  ZEPHYR_WORKBENCH_SETTING_SECTION_KEY,
} from '../../../constants';
import {
  ArmGnuToolchainInstallation,
  GlobalZephyrSdkInstallation,
  IarToolchainInstallation,
  RustToolchainInstallation,
  ZephyrSdkInstallation,
} from '../../../models/ToolchainInstallations';
import type { ZephyrApplication } from '../../../models/ZephyrApplication';
import {
  getAllZephyrSdkInstallations,
  getInternalZephyrSdkInstallation,
  getRegisteredArmGnuToolchainInstallations,
  getRegisteredIarToolchainInstallations,
  getRegisteredRustToolchainInstallations,
  normalizeSdkPathKey,
} from '../../../utils/utils';
import { getCachedGlobalSdks } from '../../../utils/zephyr/globalSdkService';
import { detectGlobalSdks, GlobalSdkSource } from '../../../utils/zephyr/globalSdkUtils';
import { hasMingwToolchain, RegisteredRustToolchain } from '../../../utils/zephyr/rustToolchainUtils';
import { rustCToolchainLinkError } from '../../../utils/zephyr/toolchainInstall';
import { isInside, normalizeForCompare } from '../../core/argSafety';

export type ToolchainFamily = 'zephyr_sdk' | 'arm_gnu' | 'iar' | 'rust';

export interface SdkEntry {
  family: 'zephyr_sdk';
  path: string;
  version: string;
  /** In zephyr-workbench.listSDKs. */
  registered: boolean;
  /** Found by the build system's own global discovery. */
  global: boolean;
  /** The SDK of the host tools install, under .zinstaller. */
  internal: boolean;
  installation: ZephyrSdkInstallation;
}

export interface ArmGnuEntry {
  family: 'arm_gnu';
  path: string;
  version: string;
  target: string;
  installation: ArmGnuToolchainInstallation;
}

export interface IarEntry {
  family: 'iar';
  path: string;
  zephyrSdkPath: string;
  hasToken: boolean;
}

export interface RustEntry {
  family: 'rust';
  path: string;
  installation: RustToolchainInstallation;
  registration?: RegisteredRustToolchain;
}

export interface MissingEntry {
  family: ToolchainFamily;
  path: string;
  /** folder_gone: the folder no longer exists; not_a_toolchain: it exists but no longer looks like one. */
  reason: 'folder_gone' | 'not_a_toolchain';
}

export type ListedToolchain = SdkEntry | ArmGnuEntry | IarEntry | RustEntry;

export interface ToolchainInventory {
  sdks: SdkEntry[];
  armGnu: ArmGnuEntry[];
  iar: IarEntry[];
  rust: RustEntry[];
  missing: MissingEntry[];
}

export const samePath = (a: string | undefined, b: string | undefined): boolean =>
  !!a && !!b && normalizeForCompare(a) === normalizeForCompare(b);

/** Same folder, following symlinks as the SDK list does. */
export const sameSdkPath = (a: string | undefined, b: string | undefined): boolean =>
  !!a && !!b && (samePath(a, b) || normalizeSdkPathKey(a) === normalizeSdkPathKey(b));

function setting<T>(key: string): T[] {
  const value = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get<T[]>(key);
  return Array.isArray(value) ? value : [];
}

/** Registered paths whose folder is gone, or no longer holds that kind of toolchain. */
function missingOf(family: ToolchainFamily, paths: unknown[], valid: (p: string) => boolean): MissingEntry[] {
  const missing: MissingEntry[] = [];
  for (const entry of paths) {
    if (typeof entry !== 'string' || entry.length === 0) {
      continue;
    }
    if (!fs.existsSync(entry)) {
      missing.push({ family, path: entry, reason: 'folder_gone' });
    } else if (!valid(entry)) {
      missing.push({ family, path: entry, reason: 'not_a_toolchain' });
    }
  }
  return missing;
}

async function internalSdkPath(): Promise<string | undefined> {
  try {
    return (await getInternalZephyrSdkInstallation())?.rootUri.fsPath;
  } catch {
    // No host tools install, or one whose folder cannot be read.
    return undefined;
  }
}

/** Every toolchain the workbench knows, read now. Each family is independent: one failing hides no other. */
export async function readToolchainInventory(): Promise<ToolchainInventory> {
  const settle = async <T>(read: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await read();
    } catch {
      return [];
    }
  };
  const [sdks, armGnu, iar, rust, internal] = await Promise.all([
    settle(getAllZephyrSdkInstallations),
    settle(getRegisteredArmGnuToolchainInstallations),
    settle(getRegisteredIarToolchainInstallations),
    settle(getRegisteredRustToolchainInstallations),
    internalSdkPath(),
  ]);

  const registeredSdks = setting<string>(ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY);
  const registeredKeys = new Set(registeredSdks.filter(p => typeof p === 'string').map(normalizeSdkPathKey));
  const globalKeys = new Set(getCachedGlobalSdks().map(sdk => normalizeSdkPathKey(sdk.rootUri.fsPath)));
  const rawIars = setting<{ iarPath?: string; zephyrSdkPath?: string; token?: string }>(ZEPHYR_WORKBENCH_LIST_IARS_SETTING_KEY);
  const rawArmGnu = setting<{ toolchainPath?: string }>(ZEPHYR_WORKBENCH_LIST_ARM_GNU_TOOLCHAINS_SETTING_KEY);
  const rawRust = setting<RegisteredRustToolchain>(ZEPHYR_WORKBENCH_LIST_RUST_TOOLCHAINS_SETTING_KEY);

  return {
    sdks: sdks.map(sdk => {
      const key = normalizeSdkPathKey(sdk.rootUri.fsPath);
      return {
        family: 'zephyr_sdk',
        path: sdk.rootUri.fsPath,
        version: sdk.version.trim(),
        registered: registeredKeys.has(key),
        global: sdk instanceof GlobalZephyrSdkInstallation || globalKeys.has(key),
        internal: !!internal && sameSdkPath(internal, sdk.rootUri.fsPath),
        installation: sdk,
      };
    }),
    armGnu: armGnu.map(toolchain => ({
      family: 'arm_gnu',
      path: toolchain.toolchainPath,
      version: toolchain.version ?? '',
      target: toolchain.targetTriple,
      installation: toolchain,
    })),
    iar: iar.map(toolchain => ({
      family: 'iar',
      path: toolchain.iarPath,
      zephyrSdkPath: toolchain.zephyrSdkPath,
      // Only whether one is stored: the token itself never leaves this line.
      hasToken: typeof toolchain.token === 'string' && toolchain.token.length > 0,
    })),
    rust: rust.map(toolchain => ({
      family: 'rust',
      path: toolchain.toolchainPath,
      installation: toolchain,
      registration: rawRust.find(entry => entry?.toolchainPath === toolchain.toolchainPath),
    })),
    missing: [
      ...missingOf('zephyr_sdk', registeredSdks, ZephyrSdkInstallation.isSdkPath),
      ...missingOf('arm_gnu', rawArmGnu.map(entry => entry?.toolchainPath), ArmGnuToolchainInstallation.isArmGnuPath),
      ...missingOf('iar', rawIars.map(entry => entry?.iarPath), IarToolchainInstallation.isIarPath),
      ...missingOf('rust', rawRust.map(entry => entry?.toolchainPath), RustToolchainInstallation.isRustPath),
    ],
  };
}

/**
 * The listSDKs entry for an SDK as stored, which unregistering must match
 * exactly, whatever spelling of the path the agent or the model uses.
 */
export function storedSdkPath(sdkPath: string): string | undefined {
  return setting<unknown>(ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY)
    .find((entry): entry is string => typeof entry === 'string' && sameSdkPath(entry, sdkPath));
}

/** The stored Arm GNU, IAR or Rust registration at a folder, as stored. */
export function storedRegistrationPath(family: 'arm_gnu' | 'iar' | 'rust', folder: string): string | undefined {
  const key = family === 'arm_gnu' ? ZEPHYR_WORKBENCH_LIST_ARM_GNU_TOOLCHAINS_SETTING_KEY
    : family === 'iar' ? ZEPHYR_WORKBENCH_LIST_IARS_SETTING_KEY
      : ZEPHYR_WORKBENCH_LIST_RUST_TOOLCHAINS_SETTING_KEY;
  const pathOf = (entry: any): unknown => family === 'iar' ? entry?.iarPath : entry?.toolchainPath;
  return setting<unknown>(key).map(pathOf)
    .find((entry): entry is string => typeof entry === 'string' && samePath(entry, folder));
}

/**
 * Every stored registration, of any family, at or inside `folder`, whether its
 * folder is there or not.
 */
export function storedRegistrationsWithin(folder: string): Array<{ family: ToolchainFamily; path: string }> {
  const stored: Array<{ family: ToolchainFamily; path: unknown }> = [
    ...setting<unknown>(ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY).map(entry => ({ family: 'zephyr_sdk' as const, path: entry })),
    ...setting<{ toolchainPath?: unknown }>(ZEPHYR_WORKBENCH_LIST_ARM_GNU_TOOLCHAINS_SETTING_KEY).map(entry => ({ family: 'arm_gnu' as const, path: entry?.toolchainPath })),
    ...setting<{ iarPath?: unknown }>(ZEPHYR_WORKBENCH_LIST_IARS_SETTING_KEY).map(entry => ({ family: 'iar' as const, path: entry?.iarPath })),
    ...setting<{ toolchainPath?: unknown }>(ZEPHYR_WORKBENCH_LIST_RUST_TOOLCHAINS_SETTING_KEY).map(entry => ({ family: 'rust' as const, path: entry?.toolchainPath })),
  ];
  return stored.filter((entry): entry is { family: ToolchainFamily; path: string } =>
    typeof entry.path === 'string' && entry.path.length > 0 && isInside(entry.path, folder));
}

/** Whether a stored IAR registration carries a licence token, for a registration whose folder is gone too. */
export function iarRegistrationHasToken(iarPath: string): boolean {
  const entry = setting<{ iarPath?: string; token?: string }>(ZEPHYR_WORKBENCH_LIST_IARS_SETTING_KEY)
    .find(candidate => candidate?.iarPath === iarPath);
  return typeof entry?.token === 'string' && entry.token.length > 0;
}

/** The listed toolchains at `path`, a registration whose folder is gone included. */
export function findListed(inventory: ToolchainInventory, path: string): Array<ListedToolchain | MissingEntry> {
  return [
    ...inventory.sdks.filter(entry => sameSdkPath(entry.path, path)),
    ...inventory.armGnu.filter(entry => samePath(entry.path, path)),
    ...inventory.iar.filter(entry => samePath(entry.path, path)),
    ...inventory.rust.filter(entry => samePath(entry.path, path)),
    ...inventory.missing.filter(entry => samePath(entry.path, path)),
  ];
}

export function isMissing(entry: ListedToolchain | MissingEntry): entry is MissingEntry {
  return 'reason' in entry;
}

/** The applications of this window that build with a toolchain. */
export function applicationsUsing(entry: ListedToolchain | MissingEntry, apps: readonly ZephyrApplication[]): string[] {
  const using = apps.filter(app => {
    switch (entry.family) {
      case 'zephyr_sdk':
        // An IAR application builds with the SDK its IAR toolchain is paired with.
        if (!app.isGlobalSdk) {
          return sameSdkPath(app.zephyrSdkPath, entry.path);
        }
        // 'global' uses whichever global SDK the build system picks; the
        // workbench predicts it by version.
        return !isMissing(entry) && (entry as SdkEntry).global && app.zephyrSdkVersion === (entry as SdkEntry).version;
      case 'arm_gnu':
        return app.toolchainVariant === 'gnuarmemb' && samePath(app.selectedArmGnuToolchainInstallation?.toolchainPath, entry.path);
      case 'iar':
        return app.toolchainVariant === 'iar' && samePath(app.selectedIarToolchainInstallation?.iarPath, entry.path);
      case 'rust':
        return samePath(app.selectedRustToolchainInstallation?.toolchainPath, entry.path);
    }
  });
  return using.map(app => app.appRootPath);
}

/** Other toolchains that stop working without this one: Rust toolchains linked to it, IAR toolchains paired with it. */
export function toolchainsDependingOn(entry: ListedToolchain | MissingEntry, inventory: ToolchainInventory): Array<{ family: ToolchainFamily; path: string }> {
  if (entry.family !== 'zephyr_sdk' && entry.family !== 'arm_gnu') {
    return [];
  }
  const same = entry.family === 'zephyr_sdk' ? sameSdkPath : samePath;
  const rust = inventory.rust
    .filter(candidate => same(candidate.installation.cToolchainPath, entry.path))
    .map(candidate => ({ family: 'rust' as const, path: candidate.path }));
  const iar = entry.family === 'zephyr_sdk'
    ? inventory.iar.filter(candidate => sameSdkPath(candidate.zephyrSdkPath, entry.path)).map(candidate => ({ family: 'iar' as const, path: candidate.path }))
    : [];
  return [...rust, ...iar];
}

// What list_toolchains shows. Every field is picked by hand, never spread.

/**
 * The discovery channels of every globally found SDK, by path key, from one
 * detection run rather than one per SDK.
 */
export async function globalSdkSourcesByPath(): Promise<Map<string, GlobalSdkSource[]>> {
  try {
    const detected = await detectGlobalSdks();
    return new Map(detected.map(sdk => [normalizeSdkPathKey(sdk.path), sdk.sources]));
  } catch {
    return new Map();
  }
}

export function sdkView(entry: SdkEntry, globalSources: ReadonlyMap<string, GlobalSdkSource[]>) {
  const sources = entry.global ? globalSources.get(normalizeSdkPathKey(entry.path)) : undefined;
  return {
    path: entry.path,
    version: entry.version,
    registered: entry.registered,
    global: entry.global,
    internal: entry.internal,
    ...(sources && sources.length > 0 ? { sources } : {}),
    // What is really on disk: the manifest lists every toolchain of the release.
    gnu_toolchains: entry.installation.getInstalledGnuToolchains().map(toolchain => toolchain.name),
    llvm_installed: entry.installation.hasLlvmToolchain(),
  };
}

export function armGnuView(entry: ArmGnuEntry) {
  return {
    path: entry.path,
    ...(entry.version ? { version: entry.version } : {}),
    target: entry.target,
  };
}

export function iarView(entry: IarEntry) {
  return {
    path: entry.path,
    zephyr_sdk_path: entry.zephyrSdkPath,
    has_token: entry.hasToken,
  };
}

export function rustView(entry: RustEntry) {
  const toolchain = entry.installation;
  const cFamily = toolchain.cToolchainType === 'zephyr-sdk' ? 'zephyr_sdk' : toolchain.cToolchainType === 'gnuarmemb' ? 'arm_gnu' : undefined;
  return {
    path: entry.path,
    ...(toolchain.version ? { version: toolchain.version } : {}),
    targets: toolchain.targets,
    ...(entry.registration?.rustupToolchain ? { rustup_toolchain: entry.registration.rustupToolchain } : {}),
    ...(cFamily && toolchain.cToolchainPath
      ? {
        c_toolchain: {
          family: cFamily,
          path: toolchain.cToolchainPath,
          valid: !rustCToolchainLinkError(toolchain.cToolchainType, toolchain.cToolchainPath),
        },
      }
      : {}),
    ...(toolchain.llvmPath ? { llvm_path: toolchain.llvmPath } : {}),
    ...(toolchain.libclangDirPath ? { libclang_dir: toolchain.libclangDirPath } : {}),
    ...(process.platform === 'win32' ? { mingw: hasMingwToolchain(entry.path) } : {}),
  };
}
