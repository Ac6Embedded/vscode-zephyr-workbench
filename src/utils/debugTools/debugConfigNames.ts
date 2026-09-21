import path from 'path';

/**
 * Pure-string helpers for Debug Manager launch configuration names. Kept
 * dependency-light (path only) so the grammar can be unit-tested without
 * pulling in vscode-heavy modules.
 *
 * Grammar:
 *   name   = base [" [" cfg "]" [" (" domain ")"]]
 *   base   = "Zephyr Workbench Debug"                (freestanding)
 *          | "Zephyr Workbench Debug: " relAppPath   (west workspace app)
 *
 * The domain suffix is only present for sysbuild builds, so a single app+config
 * can own one launch entry per domain. Non-sysbuild names are unchanged.
 */

export const ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME = 'Zephyr Workbench Debug';
export const WORKSPACE_APPLICATION_DEBUG_CONFIG_SEPARATOR = ': ';

/** Trailing ` [cfg]` optionally followed by ` (domain)`. */
const TRAILING_CONFIG_SUFFIX_RE = /\s+\[[^\]]+\](?:\s*\([^)]*\))?\s*$/;
const CONFIG_AND_DOMAIN_RE = /\[([^\]]+)\](?:\s*\(([^)]*)\))?\s*$/;
const DOMAIN_SUFFIX_RE = /\[[^\]]+\]\s*\(([^)]+)\)\s*$/;

/** Structural subset of ZephyrApplication needed to build a debug config name. */
export interface DebugNameProject {
  isWestWorkspaceApplication: boolean;
  appName: string;
  appRootPath: string;
  appWorkspaceFolder: { uri: { fsPath: string } };
}

export function getWorkspaceApplicationDebugName(project: DebugNameProject): string {
  const relativePath = path
    .relative(project.appWorkspaceFolder.uri.fsPath, project.appRootPath)
    .replace(/\\/g, '/');

  return relativePath && relativePath !== '.' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
    ? relativePath
    : project.appName;
}

function buildSuffix(buildConfigName?: string, domain?: string): string {
  if (!buildConfigName) {
    return '';
  }
  // The domain is only meaningful alongside a build config (sysbuild builds).
  const domainSuffix = domain ? ` (${domain})` : '';
  return ` [${buildConfigName}]${domainSuffix}`;
}

export function getDebugLaunchConfigurationName(
  project: DebugNameProject,
  buildConfigName?: string,
  domain?: string,
): string {
  if (!project.isWestWorkspaceApplication) {
    return getFreestandingDebugLaunchConfigurationName(buildConfigName, domain);
  }

  // West workspace apps share one launch.json. Include the app path relative to
  // the west workspace so same-named multibuild configs from different apps
  // remain distinct and can be resolved from VS Code's Run dropdown.
  return `${ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME}${WORKSPACE_APPLICATION_DEBUG_CONFIG_SEPARATOR}${getWorkspaceApplicationDebugName(project)}${buildSuffix(buildConfigName, domain)}`;
}

export function getFreestandingDebugLaunchConfigurationName(buildConfigName?: string, domain?: string): string {
  return `${ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME}${buildSuffix(buildConfigName, domain)}`;
}

export function stripTrailingBuildConfigSuffix(configName: string): string {
  return configName.replace(TRAILING_CONFIG_SUFFIX_RE, '').trim();
}

export function extractDebugBuildConfigName(configName: string): string | undefined {
  const match = configName.match(CONFIG_AND_DOMAIN_RE);
  return match ? match[1] : undefined;
}

export function extractDebugDomainName(configName: string): string | undefined {
  const match = configName.match(DOMAIN_SUFFIX_RE);
  return match ? match[1] : undefined;
}

export function extractWorkspaceApplicationPathFromDebugConfigName(configName: string): string | undefined {
  const prefix = `${ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME}${WORKSPACE_APPLICATION_DEBUG_CONFIG_SEPARATOR}`;
  if (!configName.startsWith(prefix)) {
    return undefined;
  }

  const appPath = stripTrailingBuildConfigSuffix(configName.slice(prefix.length));
  return appPath.length > 0 ? appPath : undefined;
}
