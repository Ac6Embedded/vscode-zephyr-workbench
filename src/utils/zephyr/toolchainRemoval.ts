// Toolchain removals shared by the Toolchains view and the agent tools. Each
// function does the work in the order the view always did; the caller keeps its
// confirmation, progress notification and messages, and passes the folder
// remover: deleteFolder for the view, a UI-free remover for an agent.

import * as vscode from 'vscode';
import { ZEPHYR_WORKBENCH_LIST_RUST_TOOLCHAINS_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from '../../constants';
import { unregisterArmGnuToolchain } from './armGnuToolchainUtils';
import { refreshGlobalSdkDetection } from './globalSdkService';
import { removeCmakeRegistryEntriesForSdk } from './globalSdkUtils';
import { RegisteredRustToolchain, unregisterRustToolchain } from './rustToolchainUtils';
import { uninstallRustToolchainViaRustup } from './rustupUtils';
import { unregisterZephyrSDK } from './sdkUtils';

/** Deletes a folder. What it resolves to is passed back to the caller untouched. */
export type FolderRemover = (dir: string) => unknown;

/**
 * Unregister a Zephyr SDK, then detect global SDKs again: a removed listSDKs
 * entry may still be globally discoverable, and reappears as global at once.
 */
export async function unregisterZephyrSdk(sdkPath: string): Promise<void> {
  await unregisterZephyrSDK(sdkPath);
  await refreshGlobalSdkDetection();
}

/**
 * Which registration a removal takes out: true, the toolchain's own path, which
 * must be registered (the view, which just listed it); false, none; or a lookup
 * called right before that step, whose answer is taken out, and none when it
 * answers undefined (an agent, whose confirmation may have waited while the
 * registration was removed elsewhere).
 */
export type Unregistering = boolean | (() => string | undefined);

/** Unregister as `how` says; whether a registration was taken out. */
async function unregisterAs(how: Unregistering, toolchainPath: string, unregister: (stored: string) => Promise<void>): Promise<boolean> {
  const stored = typeof how === 'function' ? how() : how ? toolchainPath : undefined;
  if (stored === undefined) {
    return false;
  }
  await unregister(stored);
  return true;
}

/**
 * Delete a Zephyr SDK from disk: unregister it when it is registered, delete
 * the folder, remove its CMake package registry entries (even when the folder
 * was already gone, so no stale entry is left), then detect global SDKs again.
 * A folder deletion error is thrown, unless `onRemoveError` takes it, in which
 * case the cleanup goes on.
 */
export async function deleteZephyrSdkFiles(sdkPath: string, opts: {
  unregister: Unregistering;
  remove: FolderRemover;
  onRemoveError?(error: unknown): void;
}): Promise<{ removal: unknown; registryEntriesRemoved: number; unregistered: boolean }> {
  const unregistered = await unregisterAs(opts.unregister, sdkPath, unregisterZephyrSDK);
  let removal: unknown;
  try {
    removal = await opts.remove(sdkPath);
  } catch (error) {
    if (!opts.onRemoveError) {
      throw error;
    }
    opts.onRemoveError(error);
  }
  const registryEntriesRemoved = await removeCmakeRegistryEntriesForSdk(sdkPath);
  await refreshGlobalSdkDetection();
  return { removal, registryEntriesRemoved, unregistered };
}

/** Unregister an Arm GNU Toolchain (as `unregister` says, itself by default), then delete its folder. */
export async function deleteArmGnuToolchainFiles(toolchainPath: string, opts: {
  remove: FolderRemover;
  unregister?: Unregistering;
}): Promise<{ removal: unknown; unregistered: boolean }> {
  const unregistered = await unregisterAs(opts.unregister ?? true, toolchainPath, unregisterArmGnuToolchain);
  return { removal: await opts.remove(toolchainPath), unregistered };
}

/** The registration of a Rust toolchain, as listRustToolchains stores it. */
export function registeredRustToolchainEntry(toolchainPath: string): RegisteredRustToolchain | undefined {
  const registeredEntries = vscode.workspace
    .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
    .get<RegisteredRustToolchain[]>(ZEPHYR_WORKBENCH_LIST_RUST_TOOLCHAINS_SETTING_KEY, []);
  return registeredEntries.find(entry => entry.toolchainPath === toolchainPath);
}

/**
 * Delete a Rust toolchain: a rustup toolchain is uninstalled with the rustup
 * that owns it, anything else, or a failed uninstall, has its folder deleted;
 * then it is unregistered (as `unregister` says, itself by default). The host
 * LLVM it links to is left alone.
 */
export async function deleteRustToolchainFiles(toolchainPath: string, rustupToolchain: string | undefined, opts: {
  remove: FolderRemover;
  warn(message: string): void;
  unregister?: Unregistering;
}): Promise<{ method: 'rustup' | 'folder'; removal?: unknown; unregistered: boolean }> {
  let uninstalled = false;
  if (rustupToolchain) {
    try {
      uninstalled = await uninstallRustToolchainViaRustup(toolchainPath, rustupToolchain);
    } catch (error: any) {
      opts.warn(`rustup uninstall failed, deleting the folder instead: ${error?.message ?? error}`);
    }
  }
  let removal: unknown;
  if (!uninstalled) {
    removal = await opts.remove(toolchainPath);
  }
  const unregistered = await unregisterAs(opts.unregister ?? true, toolchainPath, unregisterRustToolchain);
  return uninstalled ? { method: 'rustup', unregistered } : { method: 'folder', removal, unregistered };
}
