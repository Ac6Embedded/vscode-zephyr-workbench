import * as vscode from 'vscode';
import path from 'path';
import {
  ZEPHYR_WORKBENCH_LIST_ARM_GNU_TOOLCHAINS_SETTING_KEY,
  ZEPHYR_WORKBENCH_SETTING_SECTION_KEY,
} from '../../constants';
import { ArmGnuBareMetalTargetTriple } from '../../models/ToolchainInstallations';

export type ArmGnuDownloadHostId = 'mingw-w64-x86_64' | 'x86_64' | 'darwin-arm64';

export interface ArmGnuDownloadRelease {
  version: string;
  displayVersion: string;
}

export interface ArmGnuDownloadAsset {
  version: string;
  displayVersion: string;
  hostId: ArmGnuDownloadHostId;
  hostLabel: string;
  targetTriple: ArmGnuBareMetalTargetTriple;
  targetLabel: string;
  filename: string;
  url: string;
  archiveExt: 'zip' | 'tar.xz';
}

export interface ArmGnuDownloadCatalog {
  releases: ArmGnuDownloadRelease[];
  assets: ArmGnuDownloadAsset[];
}

/** A release in the Arm GitLab package registry: its package version and the names of its files. */
export interface ArmGnuPackage {
  version: string;
  fileNames: string[];
}

export interface RegisteredArmGnuToolchain {
  toolchainPath: string;
  targetTriple: ArmGnuBareMetalTargetTriple;
  version?: string;
  hostId?: ArmGnuDownloadHostId;
}

type ArmGnuHostTarget = {
  id: ArmGnuDownloadHostId;
  label: string;
  archiveExt: 'zip' | 'tar.xz';
};

// Arm moved the releases from developer.arm.com to the package registry of its
// GitLab project tooling/gnu-toolchains-for-arm: one generic package per release,
// holding every archive. The project is addressed by its id, since the encoded
// slash of its path does not survive a vscode.Uri.
const ARM_GNU_GITLAB_PROJECT_API_URL = 'https://gitlab.arm.com/api/v4/projects/10698';
const ARM_GNU_PACKAGE_NAME = 'gnu-toolchain';
const GITLAB_MAX_PER_PAGE = 100;

const ARM_GNU_TARGET_TRIPLES: ArmGnuBareMetalTargetTriple[] = ['arm-none-eabi', 'aarch64-none-elf'];

const ARM_GNU_SUPPORTED_HOSTS: ArmGnuHostTarget[] = [
  {
    id: 'mingw-w64-x86_64',
    label: 'Windows (mingw-w64-x86_64)',
    archiveExt: 'zip',
  },
  {
    id: 'x86_64',
    label: 'x86_64 Linux',
    archiveExt: 'tar.xz',
  },
  {
    id: 'darwin-arm64',
    label: 'macOS (Apple silicon)',
    archiveExt: 'tar.xz',
  },
];

export function getArmGnuHostTarget(): ArmGnuHostTarget | undefined {
  if (process.platform === 'win32' && process.arch === 'x64') {
    return {
      id: 'mingw-w64-x86_64',
      label: 'Windows (mingw-w64-x86_64)',
      archiveExt: 'zip',
    };
  }

  if (process.platform === 'linux' && process.arch === 'x64') {
    return {
      id: 'x86_64',
      label: 'x86_64 Linux',
      archiveExt: 'tar.xz',
    };
  }

  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return {
      id: 'darwin-arm64',
      label: 'macOS (Apple silicon)',
      archiveExt: 'tar.xz',
    };
  }

  return undefined;
}

export function getArmGnuTargetLabel(targetTriple: ArmGnuBareMetalTargetTriple): string {
  switch (targetTriple) {
    case 'aarch64-none-elf':
      return 'AArch64 bare-metal';
    case 'arm-none-eabi':
    default:
      return 'AArch32 bare-metal';
  }
}

/**
 * The download URL of a release archive. The registry matches the version and
 * file name case-sensitively (13.2.Rel1), so prefer the url of a catalog asset.
 */
export function buildArmGnuDownloadUrl(
  version: string,
  hostId: ArmGnuDownloadHostId,
  targetTriple: ArmGnuBareMetalTargetTriple,
): string {
  const cleanVersion = version.trim().replace(/^v/i, '');
  const host = getArmGnuHostTargetFromId(hostId);
  return getArmGnuPackageFileUrl(cleanVersion, `arm-gnu-toolchain-${cleanVersion}-${host.id}-${targetTriple}.${host.archiveExt}`);
}

export async function fetchArmGnuDownloadCatalog(signal?: AbortSignal): Promise<ArmGnuDownloadCatalog> {
  const packages = (await fetchGitLabList<{ id: number; name: string; version: string }>(
    `${ARM_GNU_GITLAB_PROJECT_API_URL}/packages?package_type=generic&package_name=${ARM_GNU_PACKAGE_NAME}`,
    signal,
  )).filter(pkg => pkg.name === ARM_GNU_PACKAGE_NAME);

  const catalog = buildArmGnuDownloadCatalog(await Promise.all(packages.map(async pkg => ({
    version: pkg.version,
    fileNames: (await fetchGitLabList<{ file_name: string }>(
      `${ARM_GNU_GITLAB_PROJECT_API_URL}/packages/${pkg.id}/package_files`,
      signal,
    )).map(file => file.file_name),
  }))));

  if (!catalog.releases.length || !catalog.assets.length) {
    throw new Error('No Arm GNU Toolchain release found in the Arm package registry.');
  }

  return catalog;
}

/**
 * The releases and assets offered for this host, as the Add Toolchain wizard
 * lists them. Throws on a host Arm publishes no toolchain for.
 */
export async function getArmGnuImportData(signal?: AbortSignal): Promise<ArmGnuDownloadCatalog> {
  const host = getArmGnuHostTarget();
  if (!host) {
    throw new Error("Arm GNU Toolchain import is not supported on this platform.");
  }

  const catalog = filterArmGnuCatalogForHost(
    await fetchArmGnuDownloadCatalog(signal),
    host.id,
  );

  return {
    releases: catalog.releases,
    assets: catalog.assets,
  };
}

/** The release of an Arm GNU Toolchain folder named as Arm ships it, or '' when the name does not say. */
export function inferArmGnuToolchainVersion(toolchainPath: string): string {
  const match = /^arm-gnu-toolchain-([^-]+)-/i.exec(path.basename(toolchainPath));
  return match?.[1] ?? '';
}

/** The toolchain root a picked folder stands for: its bin/ folder means the folder above it. */
export function normalizeArmGnuToolchainRoot(selectedPath: string): string {
  return path.basename(selectedPath).toLowerCase() === 'bin' ? path.dirname(selectedPath) : selectedPath;
}

export function filterArmGnuCatalogForHost(
  catalog: ArmGnuDownloadCatalog,
  hostId: ArmGnuDownloadHostId,
): ArmGnuDownloadCatalog {
  const hostAssets = catalog.assets.filter(asset => asset.hostId === hostId);
  const hostReleaseVersions = new Set(hostAssets.map(asset => asset.version));

  return {
    releases: catalog.releases.filter(release => hostReleaseVersions.has(release.version)),
    assets: hostAssets,
  };
}

/**
 * The catalog of the release packages, newest release first. Only the
 * bare-metal archives of the supported hosts are listed, and a release
 * without any is left out.
 */
export function buildArmGnuDownloadCatalog(packages: ArmGnuPackage[]): ArmGnuDownloadCatalog {
  const releases: ArmGnuDownloadRelease[] = [];
  const assets: ArmGnuDownloadAsset[] = [];
  const seenVersions = new Set<string>();

  for (const pkg of [...packages].sort(compareArmGnuPackagesNewestFirst)) {
    const release: ArmGnuDownloadRelease = {
      version: normalizeArmGnuVersion(pkg.version),
      displayVersion: pkg.version,
    };
    const releaseAssets = parseArmGnuReleaseAssets(pkg, release);
    if (!releaseAssets.length || seenVersions.has(release.version)) {
      continue;
    }

    releases.push(release);
    assets.push(...releaseAssets);
    seenVersions.add(release.version);
  }

  return {
    releases,
    assets,
  };
}

export async function registerArmGnuToolchain(toolchain: RegisteredArmGnuToolchain) {
  const cfg = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY);
  const list: RegisteredArmGnuToolchain[] =
    cfg.get<RegisteredArmGnuToolchain[]>(ZEPHYR_WORKBENCH_LIST_ARM_GNU_TOOLCHAINS_SETTING_KEY) ?? [];

  if (list.find(entry => entry.toolchainPath === toolchain.toolchainPath)) {
    throw new Error(`This Arm GNU toolchain [${toolchain.toolchainPath}] is already registered.`);
  }

  list.push(toolchain);

  await cfg.update(
    ZEPHYR_WORKBENCH_LIST_ARM_GNU_TOOLCHAINS_SETTING_KEY,
    list,
    vscode.ConfigurationTarget.Global,
  );
}

export async function unregisterArmGnuToolchain(toolchainPath: string) {
  const cfg = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY);
  const list: RegisteredArmGnuToolchain[] | undefined =
    cfg.get<RegisteredArmGnuToolchain[]>(ZEPHYR_WORKBENCH_LIST_ARM_GNU_TOOLCHAINS_SETTING_KEY);

  if (!list) {
    throw new Error('Cannot unregister Arm GNU toolchain: setting value corrupted, please edit settings.json');
  }

  const index = list.findIndex(entry => entry.toolchainPath === toolchainPath);
  if (index === -1) {
    throw new Error(`This Arm GNU toolchain [${toolchainPath}] is not found.`);
  }

  list.splice(index, 1);

  await cfg.update(
    ZEPHYR_WORKBENCH_LIST_ARM_GNU_TOOLCHAINS_SETTING_KEY,
    list,
    vscode.ConfigurationTarget.Global,
  );
}

function getArmGnuHostTargetFromId(hostId: ArmGnuDownloadHostId): ArmGnuHostTarget {
  const host = ARM_GNU_SUPPORTED_HOSTS.find(entry => entry.id === hostId);
  if (!host) {
    throw new Error(`Unsupported Arm GNU host ID: ${hostId}`);
  }

  return host;
}

function normalizeArmGnuVersion(version: string): string {
  return version.trim().replace(/^v/i, '').toLowerCase();
}

/** Every item of a paginated GitLab API list. */
async function fetchGitLabList<T>(url: string, signal?: AbortSignal): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page > 0;) {
    const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}per_page=${GITLAB_MAX_PER_PAGE}&page=${page}`, { signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch the Arm GNU Toolchain releases (${response.status})`);
    }

    items.push(...await response.json() as T[]);
    // Empty on the last page.
    const nextPage = Number(response.headers.get('x-next-page'));
    page = nextPage > page ? nextPage : 0;
  }

  return items;
}

function getArmGnuPackageFileUrl(packageVersion: string, filename: string): string {
  return `${ARM_GNU_GITLAB_PROJECT_API_URL}/packages/generic/${ARM_GNU_PACKAGE_NAME}/${encodeURIComponent(packageVersion)}/${encodeURIComponent(filename)}`;
}

/** Newest first: by GCC major.minor, then rel1 before mpacbti-rel1 before mpacbti-bet1. */
function compareArmGnuPackagesNewestFirst(a: ArmGnuPackage, b: ArmGnuPackage): number {
  const [aMajor, aMinor, aRest] = splitArmGnuVersion(a.version);
  const [bMajor, bMinor, bRest] = splitArmGnuVersion(b.version);
  return bMajor - aMajor || bMinor - aMinor || bRest.localeCompare(aRest);
}

function splitArmGnuVersion(version: string): [number, number, string] {
  const cleanVersion = normalizeArmGnuVersion(version);
  const match = /^(\d+)\.(\d+)(.*)$/.exec(cleanVersion);
  return match ? [Number(match[1]), Number(match[2]), match[3]] : [0, 0, cleanVersion];
}

function parseArmGnuReleaseAssets(
  pkg: ArmGnuPackage,
  release: ArmGnuDownloadRelease,
): ArmGnuDownloadAsset[] {
  const assets: ArmGnuDownloadAsset[] = [];
  // Arm names an archive arm-gnu-toolchain-<version>-<host>-<target>.<ext>.
  const prefix = `arm-gnu-toolchain-${pkg.version}-`;

  // A package may hold several uploads of the same file.
  for (const filename of new Set(pkg.fileNames)) {
    if (!filename.startsWith(prefix)) {
      continue;
    }

    const variant = filename.slice(prefix.length);
    for (const host of ARM_GNU_SUPPORTED_HOSTS) {
      const targetTriple = ARM_GNU_TARGET_TRIPLES.find(target => variant === `${host.id}-${target}.${host.archiveExt}`);
      if (!targetTriple) {
        continue;
      }

      assets.push({
        version: release.version,
        displayVersion: release.displayVersion,
        hostId: host.id,
        hostLabel: host.label,
        targetTriple,
        targetLabel: getArmGnuTargetLabel(targetTriple),
        filename,
        url: getArmGnuPackageFileUrl(pkg.version, filename),
        archiveExt: host.archiveExt,
      });
    }
  }

  return assets;
}
