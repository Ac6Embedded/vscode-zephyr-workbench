import { compareVersions } from '../versionUtils';

/* Data model for west_manifests/templates.yml, the "Add West Workspace"
   template description file. This module is pure (no vscode/fs/yaml imports):
   the host loads and yaml-parses the file, the webview receives the validated
   config as JSON, and both share the resolution logic below. */

/** West manifest skeleton, round-tripped from YAML (west owns the schema). */
export type WestManifestSkeleton = Record<string, any>;

export interface BaseModuleSpec {
  name: string;
  /** Included only for Zephyr revisions >= this "major.minor" (inclusive). */
  sinceZephyr?: string;
  /** Included only for Zephyr revisions <= this "major.minor" (inclusive). */
  untilZephyr?: string;
}

export interface WorkspaceTemplate {
  label: string;
  modules: string[];
  /** Preselected entry when the wizard opens. */
  isDefault?: boolean;
}

export interface TemplateConfig {
  manifest: WestManifestSkeleton;
  baseModules: BaseModuleSpec[];
  templates: WorkspaceTemplate[];
}

function readVersionBound(entry: Record<string, any>, key: string, where: string): string | undefined {
  const value = entry[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !/^\d+\.\d+$/.test(value)) {
    throw new Error(`${where}: "${key}" must be a "major.minor" string (e.g. "4.1"), got ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * Validates the parsed content of templates.yml and maps its kebab-case keys
 * onto the typed config. Throws a descriptive Error on any malformed entry so
 * a bad data file fails loudly instead of silently generating broken manifests.
 */
export function validateTemplateConfig(data: unknown): TemplateConfig {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Template data must be a YAML mapping with "manifest", "base-modules" and "templates" keys.');
  }
  const root = data as Record<string, any>;

  const manifest = root['manifest'];
  const zephyrProject = manifest?.projects?.[0];
  if (!manifest || !Array.isArray(manifest.remotes) || manifest.remotes.length === 0 || !zephyrProject) {
    throw new Error('"manifest" must be a west manifest skeleton with non-empty "remotes" and "projects" lists.');
  }
  const importBlock = zephyrProject['import'];
  if (!importBlock || typeof importBlock !== 'object' || Array.isArray(importBlock)) {
    throw new Error('"manifest.projects[0].import" must be a mapping (it receives path-prefix and name-allowlist at generation time).');
  }

  const rawBaseModules = root['base-modules'];
  if (!Array.isArray(rawBaseModules) || rawBaseModules.length === 0) {
    throw new Error('"base-modules" must be a non-empty list.');
  }
  const seenModuleNames = new Set<string>();
  const baseModules: BaseModuleSpec[] = rawBaseModules.map((entry, index) => {
    const where = `base-modules[${index}]`;
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || entry.name.length === 0) {
      throw new Error(`${where}: each entry must have a non-empty string "name".`);
    }
    if (seenModuleNames.has(entry.name)) {
      throw new Error(`${where}: duplicate module "${entry.name}".`);
    }
    seenModuleNames.add(entry.name);
    return {
      name: entry.name,
      sinceZephyr: readVersionBound(entry, 'since-zephyr', where),
      untilZephyr: readVersionBound(entry, 'until-zephyr', where),
    };
  });

  const rawTemplates = root['templates'];
  if (!Array.isArray(rawTemplates) || rawTemplates.length === 0) {
    throw new Error('"templates" must be a non-empty list.');
  }
  const seenLabels = new Set<string>();
  const templates: WorkspaceTemplate[] = rawTemplates.map((entry, index) => {
    const where = `templates[${index}]`;
    if (!entry || typeof entry !== 'object' || typeof entry.label !== 'string' || entry.label.length === 0) {
      throw new Error(`${where}: each entry must have a non-empty string "label".`);
    }
    if (seenLabels.has(entry.label)) {
      throw new Error(`${where}: duplicate label "${entry.label}".`);
    }
    seenLabels.add(entry.label);
    const modules = entry.modules;
    if (!Array.isArray(modules) || modules.length === 0
      || modules.some((name: unknown) => typeof name !== 'string' || name.length === 0)) {
      throw new Error(`${where} ("${entry.label}"): "modules" must be a non-empty list of west project names.`);
    }
    return {
      label: entry.label,
      modules: [...modules],
      ...(entry['default'] === true ? { isDefault: true } : {}),
    };
  });

  return { manifest, baseModules, templates };
}

/**
 * Reduces a Zephyr revision (git tag, branch, SHA...) to a "major.minor"
 * version string, or undefined when it does not look like a version — branches
 * (main, collab-*) and other unparseable refs are treated as the latest Zephyr.
 */
export function normalizeZephyrRevision(revision: string): string | undefined {
  const match = revision.trim().match(/^[vV]?(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}` : undefined;
}

/**
 * Returns the base module names applicable to the given Zephyr revision, in
 * declaration order. An unparseable revision counts as latest: entries with an
 * until-zephyr bound are excluded, everything else applies.
 */
export function resolveBaseModules(baseModules: BaseModuleSpec[], revision: string): string[] {
  const version = normalizeZephyrRevision(revision);
  return baseModules
    .filter(module => {
      if (version === undefined) {
        return module.untilZephyr === undefined;
      }
      return (module.sinceZephyr === undefined || compareVersions(version, module.sinceZephyr) >= 0)
        && (module.untilZephyr === undefined || compareVersions(version, module.untilZephyr) <= 0);
    })
    .map(module => module.name);
}
