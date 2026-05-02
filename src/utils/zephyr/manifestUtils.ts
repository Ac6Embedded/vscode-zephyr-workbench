import * as vscode from "vscode";
import fs from "fs";
import yaml from 'yaml';
import { fileExists } from "../utils";
import path from "path";

type WestManifestProject = Record<string, any> & {
  name?: string;
};

type WestManifestData = Record<string, any> & {
  manifest?: {
    remotes?: Record<string, any>[];
    projects?: WestManifestProject[];
  };
};

const upstreamManifestCache = new Map<string, WestManifestData>();

export const listHals: any[] = [
  { label: "Analog Devices", name: "hal_adi" },
  { label: "Altera", name: "hal_altera" },
  { label: "Ambiq", name: "hal_ambiq" },
  { label: "Atmel", name: "hal_atmel" },
  { label: "Espressif", name: "hal_espressif" },
  { label: "Ethos-U", name: "hal_ethos_u" },
  { label: "GigaDevice", name: "hal_gigadevice" },
  { label: "Infineon", name: "hal_infineon" },
  { label: "Intel", name: "hal_intel" },
  { label: "Microchip", name: "hal_microchip" },
  { label: "Nordic", name: "hal_nordic" },
  { label: "Nuvoton", name: "hal_nuvoton" },
  { label: "NXP", name: "hal_nxp" },
  { label: "OpenISA", name: "hal_openisa" },
  { label: "QuickLogic", name: "hal_quicklogic" },
  { label: "Renesas", name: "hal_renesas" },
  { label: "Raspberry Pi Pico", name: "hal_rpi_pico" },
  { label: "Silicon Labs", name: "hal_silabs" },
  { label: "STM32", name: "hal_stm32" },
  { label: "Telink", name: "hal_telink" },
  { label: "Texas Instruments", name: "hal_ti" },
  { label: "Würth Elektronik", name: "hal_wurthelektronik" },
  { label: "xtensa", name: "hal_xtensa" }
];

function normalizeRevision(revision: string): string {
  return revision.trim().replace(/^\/+|\/+$/g, '');
}

function normalizeRemotePath(remotePath: string): string {
  return remotePath.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
}

export function getUpstreamWestManifestUrl(remotePath: string, revision: string): string {
  const normalizedRevision = normalizeRevision(revision);
  const normalizedRemotePath = normalizeRemotePath(remotePath);
  const sshMatch = normalizedRemotePath.match(/^git@github\.com:(?<owner>[^/]+)(?:\/(?<repo>[^/]+))?$/);
  if (sshMatch?.groups?.owner) {
    const owner = sshMatch.groups.owner;
    const repo = sshMatch.groups.repo ?? 'zephyr';
    return `https://raw.githubusercontent.com/${owner}/${repo}/${normalizedRevision}/west.yml`;
  }

  const url = new URL(normalizedRemotePath);
  if (url.hostname !== 'github.com') {
    throw new Error('Additional projects are only supported for GitHub Zephyr remotes.');
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const owner = segments[0];
  const repo = segments[1] ?? 'zephyr';
  if (!owner) {
    throw new Error('Cannot determine the Zephyr repository from the remote path.');
  }

  return `https://raw.githubusercontent.com/${owner}/${repo}/${normalizedRevision}/west.yml`;
}

function getUpstreamManifestCacheKey(remotePath: string, revision: string): string {
  return getUpstreamWestManifestUrl(remotePath, revision);
}

export async function getUpstreamWestManifest(remotePath: string, revision: string): Promise<WestManifestData> {
  const cacheKey = getUpstreamManifestCacheKey(remotePath, revision);
  const cached = upstreamManifestCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const response = await fetch(cacheKey);
  if (!response.ok) {
    throw new Error(`Could not load upstream west.yml for revision "${revision}". Check that the revision exists and the repository is accessible.`);
  }

  const text = await response.text();
  const parsed = yaml.parse(text) as WestManifestData;
  if (!parsed?.manifest || !Array.isArray(parsed.manifest.projects)) {
    throw new Error(`The upstream west.yml for revision "${revision}" does not contain manifest projects.`);
  }

  upstreamManifestCache.set(cacheKey, parsed);
  return parsed;
}

export async function getUpstreamProjectNames(remotePath: string, revision: string): Promise<string[]> {
  const upstreamManifest = await getUpstreamWestManifest(remotePath, revision);
  return (upstreamManifest.manifest?.projects ?? [])
    .map(project => typeof project?.name === 'string' ? project.name : '')
    .filter(name => name.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function appendAdditionalProjectsToAllowlist(
  zephyrProject: WestManifestProject | undefined,
  additionalProjects: string[],
): void {
  const importBlock = zephyrProject?.import;
  if (!importBlock || typeof importBlock !== 'object' || Array.isArray(importBlock) || additionalProjects.length === 0) {
    return;
  }

  if (!Array.isArray(importBlock['name-allowlist'])) {
    importBlock['name-allowlist'] = [];
  }

  const allowlist = importBlock['name-allowlist'];
  for (const projectName of additionalProjects) {
    if (typeof projectName === 'string' && projectName.length > 0 && !allowlist.includes(projectName)) {
      allowlist.push(projectName);
    }
  }
}

/**
 * Write a generated west.yml under `workspacePath`. By default it goes into a
 * `manifest/` subfolder (the legacy convention), but callers can override:
 *   - undefined / empty / 'manifest' → <workspacePath>/manifest/west.yml (default)
 *   - any other non-empty string → <workspacePath>/<subfolder>/west.yml
 * (An empty value falls back to the default — west.yml at the workspace root is
 *  not supported, the UI also enforces this on submit.)
 *
 * `pathPrefix` controls the `import.path-prefix` written into the manifest:
 *   - undefined / 'deps' → projects imported under <workspace>/deps/ (default)
 *   - any other non-empty string → imported under <workspace>/<value>/
 *   - empty string → no `path-prefix` (modules imported at workspace root)
 */
export function generateWestManifest(context: vscode.ExtensionContext, remotePath: string, remoteBranch: string, workspacePath: string, templateHal: string, isFull: boolean, manifestSubfolder?: string, pathPrefix?: string, additionalProjects: string[] = []) {
  const prefix = (pathPrefix ?? 'deps').trim();

  let manifestYaml: WestManifestData;
  if (isFull) {
    // Full manifest structure. `import: true` (vs an object with path-prefix) means
    // "import everything, no subfolder".
    manifestYaml = {
      manifest: {
        remotes: [
          { name: "zephyrproject", "url-base": remotePath.replace(/\/zephyr\/?$/, '') }
        ],
        projects: [
          {
            name: "zephyr",
            "repo-path": "zephyr",
            remote: "zephyrproject",
            revision: remoteBranch,
            import: prefix.length > 0 ? { "path-prefix": prefix } : true
          }
        ]
      }
    };
  } else {
    // Minimal manifest structure
    let templateManifestUri = vscode.Uri.joinPath(context.extensionUri, 'west_manifests', 'minimal_west.yml');
    const templateFile = fs.readFileSync(templateManifestUri.fsPath, 'utf8');
    manifestYaml = yaml.parse(templateFile) as WestManifestData;
    const manifest = manifestYaml.manifest!;
    // Do not duplicate zephyr in url-base
    manifest.remotes![0]['url-base'] = remotePath.replace(/\/zephyr\/?$/, '');
    manifest.projects![0]['revision'] = remoteBranch;
    const importBlock = manifest.projects![0]['import'];
    if (importBlock && typeof importBlock === 'object') {
      if (prefix.length > 0) {
        importBlock['path-prefix'] = prefix;
      } else {
        delete importBlock['path-prefix'];
      }
      appendAdditionalProjectsToAllowlist(manifest.projects![0], [templateHal, ...additionalProjects]);
    }
  }

  if(!fileExists(workspacePath)) {
    fs.mkdirSync(workspacePath);
  }
  // Empty / undefined falls back to the default 'manifest' folder.
  const subfolder = (manifestSubfolder ?? '').trim() || 'manifest';
  const manifestDir = path.join(workspacePath, subfolder);
  if (!fileExists(manifestDir)) {
    fs.mkdirSync(manifestDir, { recursive: true });
  }

  const destFilePath = path.join(manifestDir, 'west.yml');
  const westManifestContent = yaml.stringify(manifestYaml);
  fs.writeFileSync(destFilePath, westManifestContent, 'utf8');

  return destFilePath;
}
