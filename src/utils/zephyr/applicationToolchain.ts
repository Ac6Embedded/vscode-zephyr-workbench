// The toolchain an application builds with, and the west workspace it builds
// against, shared by the Applications view and the AI agent tools.
//
// Nothing here shows UI. The change-toolchain quick step lists the choices
// listApplicationToolchainChoices returns, and the change-toolchain and
// change-west-workspace commands show the compatibility warning and the error
// and warning texts these functions report, so an agent can pick exactly what
// a person is offered and the settings end up the same.

import * as fs from 'fs';
import path from 'path';
import * as vscode from 'vscode';
import {
  ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY,
  ZEPHYR_PROJECT_IAR_SETTING_KEY,
  ZEPHYR_PROJECT_RUST_SETTING_KEY,
  ZEPHYR_PROJECT_SDK_GLOBAL_VALUE,
  ZEPHYR_PROJECT_SDK_SETTING_KEY,
  ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY,
  ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY,
  ZEPHYR_WORKBENCH_SETTING_SECTION_KEY,
} from '../../constants';
import { ToolchainVariantId, ZephyrSdkInstallation } from '../../models/ToolchainInstallations';
import { ZephyrApplication } from '../../models/ZephyrApplication';
import { removeApplicationLaunchConfigurations } from '../debugTools/debugUtils';
import { applyIntelliSenseCompilerPath, isSelectedIntelliSenseApplication, resolveSdkInstallationForSetting } from '../intellisense/intellisenseSync';
import {
  findArmGnuToolchainInstallation,
  findIarToolchainInstallation,
  getAllZephyrSdkInstallations,
  getRegisteredArmGnuToolchainInstallations,
  getRegisteredIarToolchainInstallations,
  getRegisteredRustToolchainInstallations,
  getWestWorkspace,
} from '../utils';
import { updateApplicationSettings } from './applicationSettings';
import { getBoardFromIdentifier } from './boardDiscovery';
import { getCachedGlobalSdks, resolveDefaultGlobalSdk, resolveGlobalSdkForZephyr } from './globalSdkService';
import { checkSdkCompatibility, SdkCompatVerdict } from './sdkCompatUtils';

/** What the change-toolchain quick step hands to the command. */
export interface ToolchainVariantPick {
  selectedVariant: ToolchainVariantId;
  zephyrSdkPath?: string;
  iarToolchainPath?: string;
  armGnuToolchainPath?: string;
  rustToolchainPath?: string;
}

export type ApplicationToolchainFamily = 'global_sdk' | 'zephyr_sdk' | 'iar' | 'arm_gnu' | 'rust';

/** One toolchain the change-toolchain quick step offers, with what an agent needs to name it. */
export interface ApplicationToolchainChoice extends ToolchainVariantPick {
  family: ApplicationToolchainFamily;
  label: string;
  description: string;
  /** The toolchain root, as the Toolchains view lists it. Undefined for the global SDK. */
  path?: string;
  /** The Zephyr SDK a pick uses, found in the SDK list, when it is not the global one. */
  sdk?: ZephyrSdkInstallation;
}

/**
 * Every toolchain an application can switch to, in the order the quick step
 * lists them: the pathless global SDK entry when a global SDK is detected, the
 * registered and detected Zephyr SDKs, then the IAR, Arm GNU and Rust
 * toolchains. A Rust choice is a C toolchain choice derived from its link that
 * also pins the Rust toolchain.
 */
export async function listApplicationToolchainChoices(_project: ZephyrApplication): Promise<ApplicationToolchainChoice[]> {
  const choices: ApplicationToolchainChoice[] = [];
  // Registered SDKs plus auto-detected global ones (each pickable as a
  // pinned path), preceded by the pathless "use whatever is global" entry.
  const sdks = await getAllZephyrSdkInstallations();

  const newestGlobal = resolveDefaultGlobalSdk();
  if (getCachedGlobalSdks().length > 0) {
    choices.push({
      family: 'global_sdk',
      label: 'Global Zephyr SDK',
      description: newestGlobal
        ? `auto-detected at build time (currently Zephyr SDK ${newestGlobal.version.trim()})`
        : 'auto-detected at build time',
      selectedVariant: 'zephyr',
      zephyrSdkPath: ZEPHYR_PROJECT_SDK_GLOBAL_VALUE,
    });
  }

  for (const sdk of sdks) {
    choices.push({
      family: 'zephyr_sdk',
      label: `Zephyr SDK ${sdk.version.trim()}`,
      description: sdk.rootUri.fsPath,
      path: sdk.rootUri.fsPath,
      selectedVariant: 'zephyr',
      zephyrSdkPath: sdk.rootUri.fsPath,
      sdk,
    });
  }

  for (const iar of await getRegisteredIarToolchainInstallations()) {
    choices.push({
      family: 'iar',
      label: iar.name,
      description: iar.iarPath,
      path: iar.iarPath,
      selectedVariant: 'iar',
      iarToolchainPath: iar.iarPath,
    });
  }

  for (const armGnuToolchain of await getRegisteredArmGnuToolchainInstallations()) {
    choices.push({
      family: 'arm_gnu',
      label: armGnuToolchain.name,
      description: armGnuToolchain.toolchainPath,
      path: armGnuToolchain.toolchainPath,
      selectedVariant: 'gnuarmemb',
      armGnuToolchainPath: armGnuToolchain.toolchainPath,
    });
  }

  for (const rustToolchain of await getRegisteredRustToolchainInstallations()) {
    const linkedName = rustToolchain.cToolchainPath
      ? path.basename(rustToolchain.cToolchainPath)
      : 'no C toolchain linked';
    // A Rust pick is a normal C toolchain pick (derived from the link)
    // that additionally pins the app's Rust toolchain path; SDK links go
    // through the same GNU/LLVM sub-step as picking the SDK directly.
    const zephyrSdkPath = rustToolchain.cToolchainType === 'zephyr-sdk' ? rustToolchain.cToolchainPath : undefined;
    choices.push({
      family: 'rust',
      label: rustToolchain.name,
      description: `+ ${linkedName}`,
      path: rustToolchain.toolchainPath,
      selectedVariant: rustToolchain.cToolchainType === 'gnuarmemb' ? 'gnuarmemb' : 'zephyr',
      zephyrSdkPath,
      armGnuToolchainPath: rustToolchain.cToolchainType === 'gnuarmemb' ? rustToolchain.cToolchainPath : undefined,
      rustToolchainPath: rustToolchain.toolchainPath,
      ...(zephyrSdkPath ? { sdk: sdks.find(sdk => sdk.rootUri.fsPath === zephyrSdkPath) } : {}),
    });
  }

  return choices;
}

/** A Rust choice with no linked C toolchain, which the quick step refuses. */
export function lacksCToolchain(pick: ToolchainVariantPick): boolean {
  return !!pick.rustToolchainPath && !pick.zephyrSdkPath && !pick.armGnuToolchainPath;
}

/**
 * The Zephyr SDK a Zephyr SDK choice builds with, which decides whether it
 * offers LLVM. For the global pick that is the SDK the build would actually
 * use: the newest one compatible with the application's Zephyr, as every
 * other global resolution does, not simply the newest detected one.
 */
export function resolveChoiceSdk(project: ZephyrApplication, choice: ApplicationToolchainChoice): ZephyrSdkInstallation | undefined {
  if (choice.zephyrSdkPath !== ZEPHYR_PROJECT_SDK_GLOBAL_VALUE) {
    return choice.sdk;
  }
  let kernelPath: string | undefined;
  try {
    kernelPath = project.westWorkspaceRootPath
      ? getWestWorkspace(project.westWorkspaceRootPath).kernelUri.fsPath
      : undefined;
  } catch {
    kernelPath = undefined;
  }
  return resolveGlobalSdkForZephyr(kernelPath);
}

export function hasApplicationToolchainChanged(project: ZephyrApplication, pick: ToolchainVariantPick): boolean {
  if (project.toolchainVariant !== pick.selectedVariant) {
    return true;
  }

  // The Rust toolchain rides on top of the C variant, so a pick can change
  // it without changing the C side.
  if ((project.selectedRustToolchainInstallation?.toolchainPath ?? '') !== (pick.rustToolchainPath ?? '')) {
    return true;
  }

  if (pick.selectedVariant === 'gnuarmemb') {
    return (project.selectedArmGnuToolchainInstallation?.toolchainPath ?? '') !== (pick.armGnuToolchainPath ?? '');
  }

  if (pick.selectedVariant === 'iar') {
    return (project.selectedIarToolchainInstallation?.iarPath ?? '') !== (pick.iarToolchainPath ?? '');
  }

  return (project.zephyrSdkPath ?? '') !== (pick.zephyrSdkPath ?? '');
}

export interface ApplyToolchainResult {
  /** False when nothing was written, because the picked Arm GNU toolchain is not registered any more. */
  applied: boolean;
  /** The toolchain differs from the one the application had. */
  changed: boolean;
  /** Set when applied is false, in the words the change-toolchain command shows. */
  error?: string;
  /** The compatibility of the newly assigned Zephyr SDK with the application's Zephyr, when there is one to check. */
  sdkCompat?: { verdict: SdkCompatVerdict; sdkVersion: string };
  /** Debug launch configurations of the application removed because the toolchain changed. */
  launchConfigsRemoved: number;
  /** Set when the stale launch configurations could not be removed, in the words the command shows. */
  launchCleanupWarning?: string;
  /** True when the IntelliSense compiler path was left for the next build to set. */
  compilerPathDeferred?: boolean;
}

export interface ApplyToolchainOptions {
  onSdkCompat?(sdkCompat: { verdict: SdkCompatVerdict; sdkVersion: string }): void;
  /**
   * When the Zephyr SDK compiler path for IntelliSense is looked up. The board
   * lookup behind it configures a throwaway build in <app>/.tmp when the active
   * configuration has no build folder yet, which runs CMake in a terminal:
   * 'if-configured' leaves the path to the next build then. Defaults to 'always'.
   */
  compilerPath?: 'always' | 'if-configured';
}

/**
 * Give the application the toolchain `pick` describes, as the change-toolchain
 * command does: write the settings, point IntelliSense at the new compiler
 * when this application drives it, and drop the application's debug launch
 * configurations when the toolchain changed. `onSdkCompat` fires right after
 * the settings are written, which is where the command shows its warning.
 */
export async function applyApplicationToolchain(
  project: ZephyrApplication,
  pick: ToolchainVariantPick,
  hooks: ApplyToolchainOptions = {},
): Promise<ApplyToolchainResult> {
  const changed = hasApplicationToolchainChanged(project, pick);
  let sdkCompat: ApplyToolchainResult['sdkCompat'];
  let compilerPathDeferred = false;

  if (pick.selectedVariant === 'zephyr' || pick.selectedVariant === 'zephyr/llvm') {
    await updateApplicationSettings(project, {
      [ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY]: pick.selectedVariant,
      [ZEPHYR_PROJECT_SDK_SETTING_KEY]: pick.zephyrSdkPath,
      [ZEPHYR_PROJECT_IAR_SETTING_KEY]: undefined,
      [ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY]: undefined,
      [ZEPHYR_PROJECT_RUST_SETTING_KEY]: pick.rustToolchainPath,
    });

    // Non-blocking: the newly assigned SDK may not match the app's Zephyr version
    if (pick.zephyrSdkPath) {
      try {
        const westWorkspace = getWestWorkspace(project.westWorkspaceRootPath);
        const effectiveSdk = resolveSdkInstallationForSetting(pick.zephyrSdkPath, westWorkspace.kernelUri.fsPath);
        if (effectiveSdk) {
          const sdkVersion = effectiveSdk.version;
          sdkCompat = { verdict: checkSdkCompatibility(sdkVersion, westWorkspace.kernelUri.fsPath), sdkVersion };
          hooks.onSdkCompat?.(sdkCompat);
        }
      } catch {
        // Unknown compatibility must never break the toolchain change.
      }
    }

    if (pick.zephyrSdkPath) {
      const activeConfig = project.buildConfigs.find(config => config.active) ?? project.buildConfigs[0];
      compilerPathDeferred = !!activeConfig?.boardIdentifier && hooks.compilerPath === 'if-configured'
        && !fs.existsSync(activeConfig.getBuildDir(project));
      if (activeConfig?.boardIdentifier && !compilerPathDeferred) {
        try {
          const westWorkspace = getWestWorkspace(project.westWorkspaceRootPath);
          const zephyrSdkInstallation = resolveSdkInstallationForSetting(pick.zephyrSdkPath, westWorkspace.kernelUri.fsPath);
          if (zephyrSdkInstallation) {
            const board = await getBoardFromIdentifier(
              activeConfig.boardIdentifier,
              westWorkspace,
              project,
              activeConfig
            );
            const socToolchainName = activeConfig.getKConfigValue(project, 'SOC_TOOLCHAIN_NAME');
            if (isSelectedIntelliSenseApplication(project)) {
              await applyIntelliSenseCompilerPath(
                project,
                zephyrSdkInstallation.getCompilerPath(board.arch, socToolchainName, pick.selectedVariant),
              );
            }
          }
        } catch {
          // Keep the variant change even if the compiler path cannot be refreshed yet.
        }
      }
    }
  } else if (pick.selectedVariant === 'gnuarmemb') {
    const armGnuToolchainInstallation = pick.armGnuToolchainPath ? findArmGnuToolchainInstallation(pick.armGnuToolchainPath) : undefined;
    if (!armGnuToolchainInstallation) {
      return { applied: false, changed, error: 'The selected Arm GNU toolchain could not be found.', launchConfigsRemoved: 0 };
    }

    await updateApplicationSettings(project, {
      [ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY]: armGnuToolchainInstallation.toolchainPath,
      [ZEPHYR_PROJECT_SDK_SETTING_KEY]: undefined,
      [ZEPHYR_PROJECT_IAR_SETTING_KEY]: undefined,
      [ZEPHYR_PROJECT_RUST_SETTING_KEY]: pick.rustToolchainPath,
      [ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY]: 'gnuarmemb',
    });

    try {
      if (isSelectedIntelliSenseApplication(project)) {
        await applyIntelliSenseCompilerPath(project, armGnuToolchainInstallation.compilerPath);
      }
    } catch {
      // Keep the toolchain change even if the compiler path cannot be refreshed yet.
    }
  } else {
    const iarToolchainInstallation = pick.iarToolchainPath ? findIarToolchainInstallation(pick.iarToolchainPath) : undefined;
    await updateApplicationSettings(project, {
      [ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY]: 'iar',
      [ZEPHYR_PROJECT_IAR_SETTING_KEY]: pick.iarToolchainPath,
      [ZEPHYR_PROJECT_SDK_SETTING_KEY]: iarToolchainInstallation?.zephyrSdkPath,
      [ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY]: undefined,
      [ZEPHYR_PROJECT_RUST_SETTING_KEY]: undefined,
    });
    if (pick.iarToolchainPath) {
      try {
        if (iarToolchainInstallation) {
          if (isSelectedIntelliSenseApplication(project)) {
            await applyIntelliSenseCompilerPath(project, iarToolchainInstallation.compilerPath);
          }
        }
      } catch {
        // Keep the toolchain change even if the compiler path cannot be refreshed yet.
      }
    }
  }

  let launchConfigsRemoved = 0;
  let launchCleanupWarning: string | undefined;
  if (changed) {
    try {
      launchConfigsRemoved = await removeApplicationLaunchConfigurations(project);
    } catch (error) {
      console.error('Failed to remove stale debug launch configurations after toolchain change', error);
      launchCleanupWarning = 'Toolchain changed, but stale debug launch configurations could not be removed.';
    }
  }

  return {
    applied: true,
    changed,
    ...(sdkCompat ? { sdkCompat } : {}),
    launchConfigsRemoved,
    ...(launchCleanupWarning ? { launchCleanupWarning } : {}),
    ...(compilerPathDeferred ? { compilerPathDeferred } : {}),
  };
}

/**
 * Link a freestanding application to another west workspace, as the
 * change-west-workspace command does, and return the compatibility of its
 * Zephyr SDK with the Zephyr of that workspace (undefined when unknown).
 */
export async function setApplicationWestWorkspace(
  project: ZephyrApplication,
  westWorkspacePath: string,
): Promise<{ verdict: SdkCompatVerdict; sdkVersion: string | undefined } | undefined> {
  await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, project.appWorkspaceFolder).update(
    ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY,
    westWorkspacePath,
    vscode.ConfigurationTarget.WorkspaceFolder,
  );
  try {
    const westWorkspace = getWestWorkspace(westWorkspacePath);
    return {
      verdict: checkSdkCompatibility(project.zephyrSdkVersion, westWorkspace.kernelUri.fsPath),
      sdkVersion: project.zephyrSdkVersion,
    };
  } catch {
    // Unknown compatibility must never break the workspace change.
    return undefined;
  }
}
