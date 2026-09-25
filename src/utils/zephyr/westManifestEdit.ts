// Reading and editing the manifest of a west workspace the way the West
// Manager does: the Zephyr revision, whether the zephyr project imports every
// module or a name-allowlist, and the Rust module (manifest.project-filter in
// .west/config). The West Manager panel and the manage_west_workspace tool
// share it, so both edit the files identically. Works on plain paths and shows
// no UI, so it is unit tested against real files.

import * as fs from 'fs';
import * as path from 'path';
import yaml, { isMap, isSeq, YAMLSeq } from 'yaml';
import type { WestWorkspace } from '../../models/WestWorkspace';
import { ZEPHYR_LANG_RUST_PROJECT_NAME } from './manifestUtils';

type WestManifestProject = Record<string, any> & {
  name?: string;
  revision?: string;
  import?: unknown;
  remote?: string;
  url?: string;
};

type WestManifestData = Record<string, any> & {
  manifest?: {
    remotes?: Record<string, any>[];
    projects?: WestManifestProject[];
  };
};

/** The paths of a west workspace the manifest editing reads and writes. */
export interface ManifestWorkspace {
  name: string;
  rootPath: string;
  version: string;
  /** Absolute path of the workspace manifest (manifest.path/manifest.file of .west/config). */
  manifestPath: string;
  /** Absolute path of .west/config. */
  westConfPath: string;
  /** Absolute path of the Zephyr tree. */
  kernelPath: string;
  /** zephyr.base as .west/config gives it, relative to the root. */
  zephyrBase: string;
}

export interface WestManagerWorkspaceSummary {
  name: string;
  rootPath: string;
  version: string;
}

export interface WestManagerWorkspaceDetails extends WestManagerWorkspaceSummary {
  configPath: string;
  manifestPath: string;
  zephyrBase: string;
  zephyrWestPath: string;
  submanifestPaths: string[];
  zephyrRepoUrl: string;
  zephyrRevision: string;
  supported: boolean;
  unsupportedReason?: string;
  importAll: boolean;
  availableProjects: string[];
  selectedProjects: string[];
  rustEnabled: boolean;
}

export interface WestManagerApplyState {
  rootPath: string;
  zephyrRevision: string;
  importAll: boolean;
  selectedProjects: string[];
  rustEnabled: boolean;
}

const ZEPHYR_LANG_RUST_PROJECT_FILTER = `+${ZEPHYR_LANG_RUST_PROJECT_NAME}`;

/* West Manager only edits the zephyr project's module import. It can manage a
   full workspace (`import: true`, or an import map without a name-allowlist) and
   a minimal workspace (`import.name-allowlist`). Any other shape — no zephyr
   project, or an import that pulls in manifest files (a string/sequence) — is
   left untouched and reported to the user. */
export const UNSUPPORTED_MANIFEST_TOPOLOGY_MESSAGE =
  'This manifest topology is not supported. West Manager can manage a zephyr project that imports modules via "import: true" or an "import.name-allowlist".';

/** The manifest paths of a workspace the model already read. */
export function manifestWorkspaceOf(westWorkspace: WestWorkspace): ManifestWorkspace {
  return {
    name: westWorkspace.name,
    rootPath: westWorkspace.rootUri.fsPath,
    version: westWorkspace.version,
    manifestPath: westWorkspace.manifestUri.fsPath,
    westConfPath: westWorkspace.westConfUri.fsPath,
    kernelPath: westWorkspace.kernelUri.fsPath,
    zephyrBase: westWorkspace.zephyrBase,
  };
}

export interface WestConfigProjectFilter {
  /* Line index where a new project-filter entry can be inserted (end of the
     [manifest] section), -1 when the section is missing. */
  manifestInsertIndex: number;
  /* Line index of the existing manifest.project-filter entry, -1 when absent. */
  filterLineIndex: number;
  tokens: string[];
}

export function readWestConfigProjectFilter(configLines: string[]): WestConfigProjectFilter {
  let inManifestSection = false;
  let manifestInsertIndex = -1;
  let filterLineIndex = -1;
  let tokens: string[] = [];

  for (let i = 0; i < configLines.length; i++) {
    const line = configLines[i];
    const sectionMatch = line.match(/^\s*\[([^\]]*)\]/);
    if (sectionMatch) {
      inManifestSection = sectionMatch[1].trim() === 'manifest';
      if (inManifestSection) {
        manifestInsertIndex = i + 1;
      }
      continue;
    }
    if (!inManifestSection || line.trim().length === 0) {
      continue;
    }

    manifestInsertIndex = i + 1;
    const filterMatch = line.match(/^\s*project-filter\s*[=:]\s*(.*)$/);
    if (filterMatch) {
      filterLineIndex = i;
      tokens = filterMatch[1].split(',')
        .map(token => token.trim())
        .filter(token => token.length > 0);
    }
  }

  return { manifestInsertIndex, filterLineIndex, tokens };
}

/** The manifest.project-filter tokens of a .west/config, empty when it cannot be read. */
export function readProjectFilterTokens(configPath: string): string[] {
  try {
    return readWestConfigProjectFilter(fs.readFileSync(configPath, 'utf8').split(/\r?\n/)).tokens;
  } catch {
    return [];
  }
}

export function isRustEnabledInWestConfig(configPath: string): boolean {
  return readProjectFilterTokens(configPath).includes(ZEPHYR_LANG_RUST_PROJECT_FILTER);
}

export function setRustEnabledInWestConfig(configPath: string, enabled: boolean): void {
  const content = fs.readFileSync(configPath, 'utf8');
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const filter = readWestConfigProjectFilter(lines);
  const rustEnabled = filter.tokens.includes(ZEPHYR_LANG_RUST_PROJECT_FILTER);
  if (enabled === rustEnabled) {
    return;
  }

  const tokens = enabled
    ? [...filter.tokens, ZEPHYR_LANG_RUST_PROJECT_FILTER]
    : filter.tokens.filter(token => token !== ZEPHYR_LANG_RUST_PROJECT_FILTER);

  if (filter.filterLineIndex >= 0) {
    if (tokens.length > 0) {
      lines[filter.filterLineIndex] = `project-filter = ${tokens.join(',')}`;
    } else {
      lines.splice(filter.filterLineIndex, 1);
    }
  } else {
    if (filter.manifestInsertIndex < 0) {
      throw new Error(`Cannot enable Rust: no [manifest] section found in ${configPath}`);
    }
    lines.splice(filter.manifestInsertIndex, 0, `project-filter = ${tokens.join(',')}`);
  }

  fs.writeFileSync(configPath, lines.join(newline), 'utf8');
}

export function uniqueProjectNames(projects: string[]): string[] {
  const names: string[] = [];
  for (const projectName of projects) {
    if (projectName && !names.includes(projectName)) {
      names.push(projectName);
    }
  }
  return names;
}

export function findZephyrProject(projects: WestManifestProject[] | undefined): WestManifestProject | undefined {
  return projects?.find(project =>
    project.name === 'zephyr' ||
    project['repo-path'] === 'zephyr' ||
    project.path === 'zephyr'
  );
}

/* Classify the zephyr project's `import` into the two shapes West Manager can
   manage. `importAll` is the current state, not a request. Anything unsupported
   is reported instead of being rewritten. */
export function classifyManifestImport(importValue: unknown): { supported: boolean; importAll: boolean } {
  if (importValue === true) {
    return { supported: true, importAll: true };
  }
  if (importValue && typeof importValue === 'object' && !Array.isArray(importValue)) {
    const allowlist = (importValue as Record<string, unknown>)['name-allowlist'];
    return Array.isArray(allowlist)
      ? { supported: true, importAll: false }
      : { supported: true, importAll: true };
  }
  return { supported: false, importAll: false };
}

/* Node-based counterpart of findZephyrProject for the surgical write path. */
function findZephyrProjectIndex(projectsNode: YAMLSeq): number {
  for (let i = 0; i < projectsNode.items.length; i++) {
    const item = projectsNode.items[i];
    if (!isMap(item)) {
      continue;
    }
    if (item.get('name') === 'zephyr' || item.get('repo-path') === 'zephyr' || item.get('path') === 'zephyr') {
      return i;
    }
  }
  return -1;
}

/* Patch a name-allowlist sequence in place: drop entries no longer selected and
   append newly selected ones, so comments and order on retained entries survive
   (replacing the whole node would discard them). */
function setAllowlistSeq(allowlistNode: YAMLSeq, selectedProjects: string[]): void {
  for (let i = allowlistNode.items.length - 1; i >= 0; i--) {
    if (!selectedProjects.includes(String(allowlistNode.get(i)))) {
      allowlistNode.delete(i);
    }
  }
  const existing = new Set<string>();
  for (let i = 0; i < allowlistNode.items.length; i++) {
    existing.add(String(allowlistNode.get(i)));
  }
  for (const projectName of selectedProjects) {
    if (!existing.has(projectName)) {
      allowlistNode.add(projectName);
    }
  }
}

function joinRemoteRepoUrl(urlBase: string, repoPath: string): string {
  const normalizedBase = urlBase.trim().replace(/\/+$/, '');
  const normalizedRepoPath = repoPath.trim().replace(/^\/+/, '');
  if (!normalizedRepoPath) {
    return normalizedBase;
  }
  return `${normalizedBase}/${normalizedRepoPath}`;
}

export function getZephyrRepoUrl(manifest: WestManifestData, zephyrProject: WestManifestProject | undefined): string {
  if (!zephyrProject) {
    return '';
  }

  if (typeof zephyrProject.url === 'string' && zephyrProject.url.trim().length > 0) {
    return zephyrProject.url.trim();
  }

  const remoteName = typeof zephyrProject.remote === 'string' ? zephyrProject.remote : '';
  const remote = manifest.manifest?.remotes?.find(candidate => candidate.name === remoteName);
  const urlBase = typeof remote?.['url-base'] === 'string'
    ? remote['url-base']
    : typeof remote?.url === 'string'
      ? remote.url
      : '';
  if (!urlBase) {
    return '';
  }

  const repoPath = typeof zephyrProject['repo-path'] === 'string'
    ? zephyrProject['repo-path']
    : typeof zephyrProject.name === 'string'
      ? zephyrProject.name
      : 'zephyr';
  return joinRemoteRepoUrl(urlBase, repoPath);
}

export function getProjectSourcePaths(zephyrBasePath: string): string[] {
  const sourcePaths: string[] = [];
  const zephyrWestPath = path.join(zephyrBasePath, 'west.yml');
  if (fs.existsSync(zephyrWestPath)) {
    sourcePaths.push(zephyrWestPath);
  }

  const submanifestDir = path.join(zephyrBasePath, 'submanifests');
  if (fs.existsSync(submanifestDir) && fs.statSync(submanifestDir).isDirectory()) {
    const submanifestPaths = fs.readdirSync(submanifestDir)
      .filter(fileName => fileName.endsWith('.yaml') || fileName.endsWith('.yml'))
      .sort((left, right) => left.localeCompare(right))
      .map(fileName => path.join(submanifestDir, fileName));
    sourcePaths.push(...submanifestPaths);
  }

  return sourcePaths;
}

function getManifestProjectNames(manifestPath: string): string[] {
  const manifest = yaml.parse(fs.readFileSync(manifestPath, 'utf8')) as WestManifestData;
  return (manifest.manifest?.projects ?? [])
    .map(project => typeof project?.name === 'string' ? project.name : '')
    .filter(name => name.length > 0);
}

export function getAvailableProjects(projectSourcePaths: string[]): string[] {
  const projectNames: string[] = [];
  for (const sourcePath of projectSourcePaths) {
    projectNames.push(...getManifestProjectNames(sourcePath));
  }
  return uniqueProjectNames(projectNames);
}

export function getSelectedProjects(zephyrProject: WestManifestProject | undefined, availableProjects: string[]): { importAll: boolean; selectedProjects: string[] } {
  const importBlock = zephyrProject?.import;
  if (importBlock === true || importBlock === undefined) {
    return { importAll: true, selectedProjects: availableProjects };
  }

  if (!importBlock || typeof importBlock !== 'object' || Array.isArray(importBlock)) {
    return { importAll: false, selectedProjects: [] };
  }

  const allowlist = (importBlock as Record<string, unknown>)['name-allowlist'];
  if (!Array.isArray(allowlist)) {
    return { importAll: true, selectedProjects: availableProjects };
  }

  return {
    importAll: false,
    selectedProjects: uniqueProjectNames(allowlist
      .filter((projectName): projectName is string => typeof projectName === 'string' && projectName.length > 0)),
  };
}

export function getWorkspaceDetails(westWorkspace: ManifestWorkspace): WestManagerWorkspaceDetails {
  const manifestPath = westWorkspace.manifestPath;
  const zephyrWestPath = path.join(westWorkspace.kernelPath, 'west.yml');
  const projectSourcePaths = getProjectSourcePaths(westWorkspace.kernelPath);
  const submanifestPaths = projectSourcePaths.filter(sourcePath => sourcePath !== zephyrWestPath);
  const manifest = yaml.parse(fs.readFileSync(manifestPath, 'utf8')) as WestManifestData;
  const zephyrProject = findZephyrProject(manifest.manifest?.projects);
  const zephyrRepoUrl = getZephyrRepoUrl(manifest, zephyrProject);
  const availableProjects = getAvailableProjects(projectSourcePaths);
  const selection = getSelectedProjects(zephyrProject, availableProjects);
  const topology = zephyrProject
    ? classifyManifestImport(zephyrProject.import)
    : { supported: false, importAll: false };

  return {
    name: westWorkspace.name,
    rootPath: westWorkspace.rootPath,
    version: westWorkspace.version,
    configPath: westWorkspace.westConfPath,
    manifestPath,
    zephyrBase: westWorkspace.zephyrBase,
    zephyrWestPath,
    submanifestPaths,
    zephyrRepoUrl,
    zephyrRevision: zephyrProject?.revision ?? '',
    supported: topology.supported,
    unsupportedReason: topology.supported ? undefined : UNSUPPORTED_MANIFEST_TOPOLOGY_MESSAGE,
    importAll: topology.importAll,
    availableProjects,
    selectedProjects: selection.selectedProjects,
    rustEnabled: isRustEnabledInWestConfig(westWorkspace.westConfPath),
  };
}

/**
 * The revision the manifest gives the zephyr project, reading only the
 * manifest itself; undefined when it names none or cannot be read.
 */
export function readZephyrRevision(manifestPath: string): string | undefined {
  try {
    const manifest = yaml.parse(fs.readFileSync(manifestPath, 'utf8')) as WestManifestData;
    const revision = findZephyrProject(manifest?.manifest?.projects)?.revision;
    return typeof revision === 'string' && revision.length > 0 ? revision : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The manifest text `state` produces, without writing it. Throws with the
 * West Manager's reason for a manifest topology it does not manage.
 */
export function renderWorkspaceState(westWorkspace: ManifestWorkspace, state: WestManagerApplyState): string {
  /* Edit through the YAML Document API so comments and untouched content survive;
     a parse -> stringify round-trip would rewrite the whole file. */
  const doc = yaml.parseDocument(fs.readFileSync(westWorkspace.manifestPath, 'utf8'));

  const projectsNode = doc.getIn(['manifest', 'projects']);
  const zephyrIndex = isSeq(projectsNode) ? findZephyrProjectIndex(projectsNode) : -1;
  if (zephyrIndex < 0) {
    throw new Error(UNSUPPORTED_MANIFEST_TOPOLOGY_MESSAGE);
  }

  const importPath = ['manifest', 'projects', zephyrIndex, 'import'];
  const importNode = doc.getIn(importPath);
  const importMap = isMap(importNode) ? importNode : null;
  if (importNode !== true && !importMap) {
    throw new Error(UNSUPPORTED_MANIFEST_TOPOLOGY_MESSAGE);
  }

  const revision = state.zephyrRevision.trim();
  if (revision.length > 0) {
    doc.setIn(['manifest', 'projects', zephyrIndex, 'revision'], revision);
  }

  if (state.importAll) {
    // Full workspace: import everything. Drop any allowlist; collapse an otherwise
    // empty import map (e.g. it only held name-allowlist) back to `import: true`.
    if (importMap) {
      importMap.delete('name-allowlist');
      if (importMap.items.length === 0) {
        doc.setIn(importPath, true);
      }
    }
  } else {
    // Minimal workspace: manage the name-allowlist.
    const selectedProjects = uniqueProjectNames(state.selectedProjects);
    /* The Rust module must survive the import name-allowlist on top of the
       project-filter activation, otherwise west never resolves the project. */
    if (state.rustEnabled === true && !selectedProjects.includes(ZEPHYR_LANG_RUST_PROJECT_NAME)) {
      selectedProjects.push(ZEPHYR_LANG_RUST_PROJECT_NAME);
    }

    if (importMap) {
      const allowlistNode = importMap.get('name-allowlist', true);
      if (isSeq(allowlistNode)) {
        setAllowlistSeq(allowlistNode, selectedProjects);
      } else {
        importMap.set('name-allowlist', doc.createNode(selectedProjects));
      }
    } else {
      // Coming from a full workspace (`import: true`) into an allowlist.
      doc.setIn(importPath, { 'name-allowlist': selectedProjects });
    }
  }

  return doc.toString();
}

/** Write `state` to the manifest and .west/config, and return the details read back. */
export function applyWorkspaceState(westWorkspace: ManifestWorkspace, state: WestManagerApplyState): WestManagerWorkspaceDetails {
  const manifestText = renderWorkspaceState(westWorkspace, state);
  fs.writeFileSync(westWorkspace.manifestPath, manifestText, 'utf8');
  setRustEnabledInWestConfig(westWorkspace.westConfPath, state.rustEnabled === true);
  return getWorkspaceDetails(westWorkspace);
}

/**
 * A line diff of two texts, for a dry run: changed lines prefixed with "-" and
 * "+", with `context` unchanged lines around each change and "..." between
 * hunks. Empty when the texts are equal.
 */
export function diffLines(before: string, after: string, context = 2): string {
  if (before === after) {
    return '';
  }
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  // Longest common subsequence table; manifests are a few hundred lines at most.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines: Array<{ tag: ' ' | '-' | '+'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ tag: ' ', text: a[i++] });
      j++;
    } else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      lines.push({ tag: '+', text: b[j++] });
    } else {
      lines.push({ tag: '-', text: a[i++] });
    }
  }
  const keep = lines.map((line, index) => line.tag !== ' '
    || lines.slice(Math.max(0, index - context), index + context + 1).some(near => near.tag !== ' '));
  const out: string[] = [];
  let skipped = false;
  lines.forEach((line, index) => {
    if (!keep[index]) {
      skipped = true;
      return;
    }
    if (skipped && out.length > 0) {
      out.push('...');
    }
    skipped = false;
    out.push(`${line.tag} ${line.text}`);
  });
  return out.join('\n');
}
