import * as vscode from 'vscode';
import { GlobalZephyrSdkInstallation } from '../../models/ToolchainInstallations';
import { detectGlobalSdks, getGlobalSourcesForPath, GlobalSdkSource } from './globalSdkUtils';
import { checkSdkCompatibility } from './sdkCompatUtils';

// Cached detection results. Synchronous accessors are required because several
// consumers (ZephyrApplication.parseSettings, tree item constructors) are
// synchronous; callers that can await should refresh first.
let cachedGlobalSdks: GlobalZephyrSdkInstallation[] = [];
let refreshInFlight: Promise<GlobalZephyrSdkInstallation[]> | undefined;

/**
 * Re-run global SDK detection (CMake package registry, recommended install
 * locations, ZEPHYR_SDK_INSTALL_DIR) and refresh the cache. Never rejects:
 * detection failures leave an empty cache. Results are sorted newest first.
 */
export async function refreshGlobalSdkDetection(): Promise<GlobalZephyrSdkInstallation[]> {
  if (refreshInFlight) {
    return refreshInFlight;
  }
  refreshInFlight = (async () => {
    const installations: GlobalZephyrSdkInstallation[] = [];
    try {
      const detected = await detectGlobalSdks();
      for (const sdk of detected) {
        try {
          installations.push(new GlobalZephyrSdkInstallation(vscode.Uri.file(sdk.path)));
        } catch {
          // Very old SDKs without a toolchains manifest fail to parse; skip them.
        }
      }
    } catch {
      // Detection must never break activation or refresh flows.
    }
    cachedGlobalSdks = installations;
    return installations;
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = undefined;
  }
}

export function getCachedGlobalSdks(): GlobalZephyrSdkInstallation[] {
  return cachedGlobalSdks;
}

/**
 * Best-effort prediction of the SDK a build would use when the app is set to
 * 'global': the newest detected SDK. Advisory only (CMake makes the real pick,
 * honoring per-workspace minimum versions); never used to set
 * ZEPHYR_SDK_INSTALL_DIR.
 */
export function resolveDefaultGlobalSdk(): GlobalZephyrSdkInstallation | undefined {
  return cachedGlobalSdks[0];
}

/**
 * Workspace-aware variant of resolveDefaultGlobalSdk: the build system picks
 * the newest COMPATIBLE SDK, so prefer detected SDKs compatible with the given
 * Zephyr tree (then partially compatible ones), falling back to the newest.
 * Advisory only, like resolveDefaultGlobalSdk.
 */
export function resolveGlobalSdkForZephyr(zephyrBasePath: string | undefined): GlobalZephyrSdkInstallation | undefined {
  if (!zephyrBasePath || cachedGlobalSdks.length === 0) {
    return cachedGlobalSdks[0];
  }
  const verdicts = cachedGlobalSdks.map(sdk => {
    try {
      return checkSdkCompatibility(sdk.version.trim(), zephyrBasePath).status;
    } catch {
      return 'unknown';
    }
  });
  const compatible = cachedGlobalSdks.find((_, i) => verdicts[i] === 'compatible');
  if (compatible) {
    return compatible;
  }
  const partial = cachedGlobalSdks.find((_, i) => verdicts[i] === 'partial');
  return partial ?? cachedGlobalSdks[0];
}

/**
 * Global discovery channels a given SDK path is visible through, or undefined
 * when it is not globally discoverable. Used to badge registered SDKs.
 */
export async function getGlobalSdkSources(sdkPath: string): Promise<GlobalSdkSource[] | undefined> {
  try {
    return await getGlobalSourcesForPath(sdkPath);
  } catch {
    return undefined;
  }
}
