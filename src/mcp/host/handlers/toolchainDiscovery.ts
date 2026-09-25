// What can be installed, asked from the official release sites the Add
// Toolchain wizard asks. Every lookup is bounded well below the time an agent
// waits for a call, and kept a few minutes, so checking an install and listing
// what it may install do not ask the network twice.

import { getArmGnuImportData } from '../../../utils/zephyr/armGnuToolchainUtils';
import { fetchLlvmVersions, getRustImportData, LlvmVersionOptions } from '../../../utils/zephyr/rustToolchainUtils';
import { getRustupStatus, RustupStatus } from '../../../utils/zephyr/rustupUtils';
import { getMinimalToolchainsForVersion, getSdkVersion, mapToolchainIdToPackage } from '../../../utils/zephyr/sdkUtils';
import { compareVersions } from '../../../utils/versionUtils';
import { McpToolError } from '../../core/errors';
import { TtlCache } from '../../core/ttlCache';

/**
 * One lookup's limit. A call starts the lookups it needs side by side (see
 * prefetch), so its checks stay well inside the time an agent waits.
 */
export const LOOKUP_TIMEOUT_MS = 15_000;

const RELEASE = /^\d+\.\d+\.\d+$/;

const cache = new TtlCache<unknown>({ ttlMs: 10 * 60_000, maxEntries: 32 });

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run `load` with an abort signal and a deadline. The deadline wins even over
 * a load that does not listen to its signal, so a call never waits past it.
 */
async function bounded<T>(what: string, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new McpToolError('TIMEOUT', `Asking for ${what} took longer than ${LOOKUP_TIMEOUT_MS / 1000} seconds.`, {
        hint: 'Check the network connection of this machine, then call list_toolchains again.',
      }));
    }, LOOKUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([load(controller.signal), deadline]);
  } catch (error) {
    if (error instanceof McpToolError) {
      throw error;
    }
    throw new McpToolError('INTERNAL', `Could not get ${what}: ${messageOf(error)}`, {
      hint: 'Check the network connection of this machine, then call list_toolchains again.',
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function cached<T>(key: string, what: string, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const { value } = await cache.get(key, () => bounded(what, load));
  return value as T;
}

const git = { nonInteractive: true, timeoutMs: LOOKUP_TIMEOUT_MS - 2000 };

/**
 * The lookups, on one object so a test can stand in for the network. Versions
 * come without a leading v and newest first.
 */
export const toolchainDiscovery = {
  /** Zephyr SDK releases of sdk-ng, without pre-releases. */
  async sdkVersions(): Promise<string[]> {
    return cached('sdk-versions', 'the Zephyr SDK releases', async () => {
      const versions = (await getSdkVersion(git)).map(tag => tag.replace(/^v/, '')).filter(tag => RELEASE.test(tag));
      return [...new Set(versions)].sort((a, b) => compareVersions(b, a));
    });
  },

  /** The GNU toolchain packages of one SDK release for this host, such as arm-zephyr-eabi. */
  async sdkToolchains(version: string): Promise<string[]> {
    return cached(`sdk-toolchains:${version}`, `the toolchains of Zephyr SDK ${version}`, async signal =>
      (await getMinimalToolchainsForVersion(version, signal)).map(mapToolchainIdToPackage));
  },

  /** The Arm GNU Toolchain releases and archives for this host. */
  async armGnuCatalog() {
    return cached('arm-gnu', 'the Arm GNU Toolchain releases', signal => getArmGnuImportData(signal));
  },

  /** Rust versions (stable first) and the Zephyr Rust targets with their descriptions. */
  async rust() {
    return cached('rust', 'the Rust releases', signal => getRustImportData({ versions: git, signal }));
  },

  /** Host LLVM releases usable for bindgen. */
  async llvmVersions(): Promise<LlvmVersionOptions> {
    return cached('llvm', 'the LLVM releases', () => fetchLlvmVersions(git));
  },

  /** The rustup the workbench would use and the host prerequisites. Local state, so never kept. */
  async rustupStatus(): Promise<RustupStatus> {
    return bounded('the rustup status', signal => getRustupStatus(signal));
  },
};

/**
 * Start the lookups a call is about to need, so they run side by side: each
 * later call for the same lookup joins the one already running. A failure
 * shows up there, not here.
 */
export function prefetch(...lookups: Array<() => Promise<unknown>>): void {
  for (const lookup of lookups) {
    lookup().catch(() => undefined);
  }
}
