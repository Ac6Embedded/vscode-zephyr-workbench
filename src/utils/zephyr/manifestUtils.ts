import * as vscode from "vscode";
import fs from "fs";
import yaml from 'yaml';
import path from "path";
import { TemplateConfig, resolveBaseModules, validateTemplateConfig } from "./templateData";

type WestManifestProject = Record<string, any> & {
  name?: string;
};

type WestManifestData = Record<string, any> & {
  manifest?: {
    remotes?: Record<string, any>[];
    projects?: WestManifestProject[];
    self?: Record<string, any>;
  };
};

const upstreamManifestCache = new Map<string, WestManifestData>();

/* Optional module defined in zephyr/submanifests/optional.yaml (groups: [optional],
   inactive by default). Enabling Rust requires BOTH importing it (manifest allowlist
   when one is used) and activating it (manifest.project-filter in .west/config). */
export const ZEPHYR_LANG_RUST_PROJECT_NAME = 'zephyr-lang-rust';

let cachedTemplateConfig: TemplateConfig | undefined;

/**
 * Loads and validates the bundled workspace template description
 * (west_manifests/templates.yml): manifest skeleton, version-constrained base
 * modules and the vendor templates of the wizard dropdown. Cached for the
 * extension's lifetime; throws with the file path on a missing/malformed file.
 */
export function loadTemplateConfig(extensionUri: vscode.Uri): TemplateConfig {
  if (!cachedTemplateConfig) {
    const templateDataUri = vscode.Uri.joinPath(extensionUri, 'west_manifests', 'templates.yml');
    try {
      const templateFile = fs.readFileSync(templateDataUri.fsPath, 'utf8');
      cachedTemplateConfig = validateTemplateConfig(yaml.parse(templateFile));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot load the workspace template data (${templateDataUri.fsPath}): ${reason}`);
    }
  }
  return cachedTemplateConfig;
}

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
    throw new Error('Project suggestions are only supported for GitHub Zephyr remotes.');
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

function setProjectAllowlist(
  zephyrProject: WestManifestProject | undefined,
  projects: string[],
): void {
  const importBlock = zephyrProject?.import;
  if (!importBlock || typeof importBlock !== 'object' || Array.isArray(importBlock)) {
    return;
  }

  const allowlist: string[] = [];
  for (const projectName of projects) {
    if (typeof projectName === 'string' && projectName.length > 0 && !allowlist.includes(projectName)) {
      allowlist.push(projectName);
    }
  }
  importBlock['name-allowlist'] = allowlist;
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
 *
 * `enableRust` adds zephyr-lang-rust to the minimal manifest's name-allowlist so the
 * project survives the import filter (the full manifest imports everything, so only
 * the project-filter activation set by west.init is needed there).
 *
 * The minimal manifest's name-allowlist is `projects` when the caller provides it
 * (the wizard always does); otherwise it is rebuilt from templates.yml: the base
 * modules applicable to `remoteBranch` (e.g. cmsis vs cmsis_6) plus `templateModules`.
 *
 * Both manifest flavors declare `self.path` as the folder the west.yml is written
 * into, so the manifest stays valid as a standalone manifest repository.
 */
export function generateWestManifest(extensionUri: vscode.Uri, remotePath: string, remoteBranch: string, workspacePath: string, templateModules: string[], isFull: boolean, manifestSubfolder?: string, pathPrefix?: string, projects?: string[], enableRust = false) {
  const prefix = (pathPrefix ?? 'deps').trim();
  // Empty / undefined falls back to the default 'manifest' folder.
  const subfolder = (manifestSubfolder ?? '').trim() || 'manifest';
  // self.path declares where the manifest repository lives relative to the
  // workspace topdir. The wizard's `west init -l` ignores it, but it keeps the
  // generated manifest correct if it is ever reused via `west init -m <url>`.
  const selfPath = subfolder.replace(/\\/g, '/');

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
        ],
        self: { path: selfPath }
      }
    };
  } else {
    // Minimal manifest structure. The loaded config is cached for the extension's
    // lifetime, so clone the skeleton before the per-call mutations below.
    const templateConfig = loadTemplateConfig(extensionUri);
    manifestYaml = JSON.parse(JSON.stringify({ manifest: templateConfig.manifest })) as WestManifestData;
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
      const allowlist = Array.isArray(projects)
        ? [...projects]
        : [...resolveBaseModules(templateConfig.baseModules, remoteBranch), ...templateModules];
      if (enableRust) {
        allowlist.push(ZEPHYR_LANG_RUST_PROJECT_NAME);
      }
      setProjectAllowlist(manifest.projects![0], allowlist);
    }
    manifest.self = { ...manifest.self, path: selfPath };
  }

  if(!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath);
  }
  const manifestDir = path.join(workspacePath, subfolder);
  if (!fs.existsSync(manifestDir)) {
    fs.mkdirSync(manifestDir, { recursive: true });
  }

  const destFilePath = path.join(manifestDir, 'west.yml');
  const westManifestContent = yaml.stringify(manifestYaml);
  fs.writeFileSync(destFilePath, westManifestContent, 'utf8');

  return destFilePath;
}
