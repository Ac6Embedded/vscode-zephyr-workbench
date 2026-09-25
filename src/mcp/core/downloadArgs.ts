// Checks for every value an agent gives that ends up in a download URL, a
// folder name or a tar command line. Each is an allow-list. The values are
// also checked against what the release sites list, but the pattern stays, so
// a surprising entry scraped from a release page can never reach a shell:
// the downloaded file is named after the last URL segment, and tar extracts it
// through a shell (`tar -xf "<file>" -C "<folder>"`).

import { McpToolError } from './errors';

/** The file name of every archive a toolchain install downloads. */
export const ARCHIVE_BASENAME = /^[A-Za-z0-9._+-]+\.(tar\.xz|tar\.gz|tar\.bz2|7z|zip)$/;

/** A folder created inside an agent-given parent: one plain path segment. */
const FOLDER_NAME = /^[A-Za-z0-9._+-]{1,64}$/;

/** Zephyr SDK, Rust and LLVM release numbers. */
const RELEASE_NUMBER = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** GNU toolchain package names of the Zephyr SDK, such as arm-zephyr-eabi or xtensa-espressif_esp32s3_zephyr-elf. */
const SDK_TOOLCHAIN_PACKAGE = /^[a-z0-9][a-z0-9_.-]{0,80}[-_]zephyr-(elf|eabi)$/;

/** Friendly GNU toolchain ids the wizard shows, such as arm or xtensa-espressif_esp32s3. */
const SDK_TOOLCHAIN_FRIENDLY = /^[a-z0-9][a-z0-9_.-]{0,80}$/;

/** Rust target triples such as thumbv8m.main-none-eabihf or riscv32i-unknown-none-elf. */
const RUST_TARGET = /^[a-z0-9_]+(?:\.[a-z0-9_]+)?(?:-[a-z0-9_]+){1,3}$/;

/** Arm GNU Toolchain releases as the catalog normalizes them, such as 14.2.rel1. */
const ARM_GNU_VERSION = /^\d{1,3}\.\d{1,3}\.[a-z0-9]{1,16}(?:-[a-z0-9]{1,16})?$/;

function invalid(message: string, hint?: string): McpToolError {
  return new McpToolError('INVALID_ARGUMENT', message, hint ? { hint } : {});
}

/** A value shown in an error, cut short and stripped of anything odd. */
function shown(value: string): string {
  return value.slice(0, 80).replace(/[^\x20-\x7e]/g, '?');
}

/** An SDK, Rust or LLVM version with any leading v removed: 0.17.4, 1.87.0 or 20.1.8. */
export function assertReleaseNumber(value: string, label: string): string {
  const version = value.trim().replace(/^v/, '');
  if (!RELEASE_NUMBER.test(version)) {
    throw invalid(`${label} must be a release number such as 1.2.3, not "${shown(value)}".`);
  }
  return version;
}

/**
 * A Zephyr SDK GNU toolchain id, as its package name: arm and arm-zephyr-eabi
 * both give arm-zephyr-eabi. `toPackage` is the workbench's own mapping.
 */
export function assertSdkToolchainId(value: string, toPackage: (id: string) => string): string {
  const id = value.trim();
  if (SDK_TOOLCHAIN_PACKAGE.test(id)) {
    return id;
  }
  if (SDK_TOOLCHAIN_FRIENDLY.test(id)) {
    const packaged = toPackage(id);
    if (SDK_TOOLCHAIN_PACKAGE.test(packaged)) {
      return packaged;
    }
  }
  throw invalid(`"${shown(value)}" is not a Zephyr SDK GNU toolchain id such as arm-zephyr-eabi.`,
    'Call list_toolchains with available "zephyr_sdk" and version to see the ids of that SDK.');
}

export function assertRustTarget(value: string): string {
  const target = value.trim();
  if (!RUST_TARGET.test(target) || target.length > 64) {
    throw invalid(`"${shown(value)}" is not a Rust target triple such as thumbv7em-none-eabihf.`,
      'Call list_toolchains with available "rust" to see the targets Zephyr supports.');
  }
  return target;
}

export function assertArmGnuVersion(value: string): string {
  const version = value.trim().replace(/^v/i, '').toLowerCase();
  if (!ARM_GNU_VERSION.test(version)) {
    throw invalid(`"${shown(value)}" is not an Arm GNU Toolchain release such as 14.2.rel1.`,
      'Call list_toolchains with available "arm_gnu" to see the releases for this machine.');
  }
  return version;
}

/** The name of a folder created in parent_path: one segment, no spaces, not . or .. */
export function assertFolderName(value: string, label = 'folder_name'): string {
  const name = value.trim();
  if (!FOLDER_NAME.test(name) || name === '.' || name === '..' || /^\.+$/.test(name)) {
    throw invalid(`${label} must be a single folder name of letters, digits, dot, dash, underscore or plus (at most 64), not "${shown(value)}".`);
  }
  return name;
}

/** Where official releases are downloaded from. */
export interface DownloadSource {
  hosts: readonly string[];
  /** Every path starts with one of these. */
  pathPrefixes: readonly string[];
}

export const OFFICIAL_SOURCES = {
  zephyrSdk: { hosts: ['github.com'], pathPrefixes: ['/zephyrproject-rtos/sdk-ng/releases/download/'] },
  // The Arm downloads page links to developer.arm.com, and to its blob store for some releases.
  armGnu: {
    hosts: ['developer.arm.com', 'armkeil.blob.core.windows.net'],
    pathPrefixes: ['/-/media/Files/downloads/gnu/', '/developer/Files/downloads/gnu/'],
  },
  rustDist: { hosts: ['static.rust-lang.org'], pathPrefixes: ['/dist/'] },
  rustupInit: { hosts: ['static.rust-lang.org'], pathPrefixes: ['/rustup/dist/'] },
  llvm: { hosts: ['github.com'], pathPrefixes: ['/llvm/llvm-project/releases/download/'] },
  winlibs: { hosts: ['github.com'], pathPrefixes: ['/brechtsanders/winlibs_mingw/releases/download/'] },
} satisfies Record<string, DownloadSource>;

/**
 * Why a URL may not be downloaded, or undefined when it may: https only, from
 * one of the official sources, and for an archive, a file name tar can take.
 */
export function downloadUrlProblem(url: string, sources: readonly DownloadSource[], opts: { archive: boolean }): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `"${shown(url)}" is not a URL.`;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
    return `Only plain https downloads are allowed, not "${shown(url)}".`;
  }
  const host = parsed.hostname.toLowerCase();
  const source = sources.some(candidate => candidate.hosts.includes(host)
    && candidate.pathPrefixes.some(prefix => parsed.pathname.startsWith(prefix)));
  if (!source) {
    return `${host}${shown(parsed.pathname)} is not an official release download.`;
  }
  if (parsed.pathname.split('/').includes('..')) {
    return `"${shown(url)}" has a parent folder segment.`;
  }
  const basename = parsed.pathname.split('/').pop() ?? '';
  if (opts.archive && !ARCHIVE_BASENAME.test(basename)) {
    return `The archive name "${shown(basename)}" is not a plain .tar.xz, .tar.gz, .tar.bz2, .7z or .zip file name.`;
  }
  if (!opts.archive && !/^[A-Za-z0-9._+-]+$/.test(basename)) {
    return `The file name "${shown(basename)}" is not a plain file name.`;
  }
  return undefined;
}

/** Throw INVALID_ARGUMENT when a URL may not be downloaded (see downloadUrlProblem). */
export function assertDownloadUrl(url: string, sources: readonly DownloadSource[], opts: { archive: boolean }): string {
  const problem = downloadUrlProblem(url, sources, opts);
  if (problem) {
    throw invalid(problem, 'Toolchains are only downloaded from their official release sites. Ask the user to use the Add Toolchain wizard for any other source.');
  }
  return url;
}
