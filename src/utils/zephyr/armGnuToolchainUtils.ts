import * as vscode from 'vscode';
import {
  ZEPHYR_WORKBENCH_LIST_ARM_GNU_TOOLCHAINS_SETTING_KEY,
  ZEPHYR_WORKBENCH_SETTING_SECTION_KEY,
} from '../../constants';
import { ArmGnuBareMetalTargetTriple } from '../../models/ToolchainInstallations';

export type ArmGnuDownloadHostId = 'mingw-w64-x86_64' | 'x86_64' | 'darwin-arm64';

export interface ArmGnuDownloadRelease {
  version: string;
  displayVersion: string;
  releasedAt?: string;
}

export interface ArmGnuDownloadAsset {
  version: string;
  displayVersion: string;
  releasedAt?: string;
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

const ARM_GNU_DOWNLOADS_PAGE_URL = 'https://developer.arm.com/downloads/-/arm-gnu-toolchain-downloads';
const ARM_GNU_BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
} as const;

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

export function buildArmGnuDownloadUrl(
  version: string,
  hostId: ArmGnuDownloadHostId,
  targetTriple: ArmGnuBareMetalTargetTriple,
): string {
  const cleanVersion = normalizeArmGnuVersion(version);
  const host = getArmGnuHostTargetFromId(hostId);
  return `https://developer.arm.com/-/media/Files/downloads/gnu/${cleanVersion}/binrel/arm-gnu-toolchain-${cleanVersion}-${host.id}-${targetTriple}.${host.archiveExt}`;
}

export async function fetchArmGnuDownloadCatalog(): Promise<ArmGnuDownloadCatalog> {
  const response = await fetch(ARM_GNU_DOWNLOADS_PAGE_URL, {
    headers: ARM_GNU_BROWSER_HEADERS,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Arm GNU downloads (${response.status})`);
  }

  const html = await response.text();
  const parsed = parseArmGnuDownloadCatalog(html);
  if (!parsed.releases.length || !parsed.assets.length) {
    throw new Error('Failed to parse Arm GNU downloads.');
  }

  return parsed;
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

export function parseArmGnuDownloadCatalog(html: string): ArmGnuDownloadCatalog {
  const releases: ArmGnuDownloadRelease[] = [];
  const assets: ArmGnuDownloadAsset[] = [];
  const seenVersions = new Set<string>();
  const seenUrls = new Set<string>();
  const accordionSections = splitAccordionSections(html);

  for (const section of accordionSections) {
    const release = parseArmGnuRelease(section);
    if (!release) {
      continue;
    }

    if (!seenVersions.has(release.version)) {
      releases.push(release);
      seenVersions.add(release.version);
    }

    for (const asset of parseArmGnuReleaseAssets(section, release)) {
      if (seenUrls.has(asset.url)) {
        continue;
      }

      assets.push(asset);
      seenUrls.add(asset.url);
    }
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

function decodeHtml(value: string): string {
  return value
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', '\'');
}

function splitAccordionSections(html: string): string[] {
  return html
    .split(/<li[^>]*class="accordion-navigation[^"]*"[^>]*>/gi)
    .slice(1);
}

function parseArmGnuRelease(section: string): ArmGnuDownloadRelease | undefined {
  const releaseMatch = /Downloads:\s*([^<]+?)\s*<span[^>]*class="download__date"[^>]*>([^<]+)<\/span>/i.exec(section);
  if (!releaseMatch) {
    return undefined;
  }

  const displayVersion = decodeHtml(releaseMatch[1].trim());
  return {
    version: normalizeArmGnuVersion(displayVersion),
    displayVersion,
    releasedAt: decodeHtml(releaseMatch[2].trim()),
  };
}

function parseArmGnuReleaseAssets(
  section: string,
  release: ArmGnuDownloadRelease,
): ArmGnuDownloadAsset[] {
  const assets: ArmGnuDownloadAsset[] = [];
  const hostSections = collectSections(
    section,
    /<h4>\s*(?:<nobr>)?([^<]+?)(?:<\/nobr>)?\s*<\/h4>/gi,
  );

  for (const hostSection of hostSections) {
    const host = findArmGnuSupportedHost(hostSection.heading);
    if (!host) {
      continue;
    }

    const targetSections = collectSections(
      hostSection.content,
      /<p>\s*(?:<nobr>)?([\s\S]*?\((arm-none-eabi|aarch64-none-elf)\))\s*(?:<\/nobr>)?(?:\s|&nbsp;|<br\s*\/?>)*<\/p>/gi,
    );

    for (const targetSection of targetSections) {
      const targetTriple = targetSection.match[2] as ArmGnuBareMetalTargetTriple;
      const targetLabel = getArmGnuTargetLabel(targetTriple);
      const anchorRegex = /<a[^>]+href="([^"]+)"[^>]*>\s*(?:<nobr>)?\s*([^<]+?)\s*(?:<\/nobr>)?\s*<\/a>/gi;
      let anchorMatch: RegExpExecArray | null;

      while ((anchorMatch = anchorRegex.exec(targetSection.content)) !== null) {
        const url = decodeHtml(anchorMatch[1].trim());
        const filename = decodeHtml(anchorMatch[2].trim());

        if (!isArmGnuArchiveAsset(filename, url, host, targetTriple)) {
          continue;
        }

        assets.push({
          version: release.version,
          displayVersion: release.displayVersion,
          releasedAt: release.releasedAt,
          hostId: host.id,
          hostLabel: host.label,
          targetTriple,
          targetLabel,
          filename,
          url,
          archiveExt: host.archiveExt,
        });
      }
    }
  }

  return assets;
}

function collectSections(content: string, regex: RegExp): Array<{
  heading: string;
  content: string;
  match: RegExpExecArray;
}> {
  const entries: Array<{
    heading: string;
    index: number;
    match: RegExpExecArray;
  }> = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    entries.push({
      heading: decodeHtml(match[1].trim()),
      index: match.index,
      match,
    });
  }

  return entries.map((entry, index) => ({
    heading: entry.heading,
    content: content.slice(entry.index, index + 1 < entries.length ? entries[index + 1].index : content.length),
    match: entry.match,
  }));
}

function findArmGnuSupportedHost(heading: string): ArmGnuHostTarget | undefined {
  const normalizedHeading = normalizeArmGnuHeading(heading);
  return ARM_GNU_SUPPORTED_HOSTS.find(host =>
    normalizedHeading === normalizeArmGnuHeading(`${host.label} hosted cross toolchains`)
  );
}

function isArmGnuArchiveAsset(
  filename: string,
  url: string,
  host: ArmGnuHostTarget,
  targetTriple: ArmGnuBareMetalTargetTriple,
): boolean {
  return filename.startsWith('arm-gnu-toolchain-')
    && filename.includes(`-${host.id}-${targetTriple}.`)
    && filename.endsWith(`.${host.archiveExt}`)
    && url.includes('/binrel/');
}

function normalizeArmGnuHeading(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}
