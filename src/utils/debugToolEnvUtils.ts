import { getDetectPlatform, getToolCommandDir } from './debugToolPathUtils';
import { readEnvYamlObject, writeEnvYamlObject } from './envYamlFileUtils';
import { getInternalDirRealPath } from './utils';

// Debug-runner-specific env.yml updates.
// This module builds on the shared env.yml file helpers and owns the logic for
// runner alias defaults, resolved tool paths, stored versions, and cleanup of
// runner entries under env.runners.

function ensureRunners(jsEnv: any): Record<string, any> {
  if (!jsEnv.runners || typeof jsEnv.runners !== 'object' || Array.isArray(jsEnv.runners)) {
    jsEnv.runners = {};
  }
  return jsEnv.runners;
}

function ensureRunnerEntry(jsEnv: any, toolId: string): Record<string, any> {
  const runners = ensureRunners(jsEnv);
  if (!runners[toolId] || typeof runners[toolId] !== 'object' || Array.isArray(runners[toolId])) {
    runners[toolId] = {};
  }
  return runners[toolId];
}

function cleanupRunnerEntry(jsEnv: any, toolId: string): void {
  const runners = jsEnv?.runners;
  if (!runners || typeof runners !== 'object' || Array.isArray(runners)) {
    return;
  }

  const entry = runners[toolId];
  if (entry && typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).length === 0) {
    delete runners[toolId];
  }

  if (Object.keys(runners).length === 0) {
    delete jsEnv.runners;
  }
}

export function setDebugToolAliasDefault(options: {
  manifest: any;
  alias: string;
  toolId: string;
  executableName?: string;
  fallbackPath?: string;
}): void {
  const { manifest, alias, toolId, executableName, fallbackPath } = options;
  if (!alias || typeof alias !== 'string') {
    throw new Error('Missing runner alias');
  }

  const selectedTool = manifest?.debug_tools?.find((tool: any) => tool?.tool === toolId);
  if (!selectedTool) {
    throw new Error(`Unknown runner tool: ${toolId}`);
  }

  const jsEnv = readEnvYamlObject();
  const runners = ensureRunners(jsEnv);
  const aliasVariants = Array.isArray(manifest?.debug_tools)
    ? manifest.debug_tools
      .filter((tool: any) => tool?.alias === alias)
      .map((tool: any) => tool.tool)
    : [];

  for (const variantId of aliasVariants) {
    delete runners[variantId];
  }

  const aliasEntry = ensureRunnerEntry(jsEnv, alias);
  const selectedPath = executableName
    ? getToolCommandDir(selectedTool, getInternalDirRealPath(), executableName, getDetectPlatform())
    : undefined;
  const hasExplicitDetect = Array.isArray(selectedTool?.['explicit-detect']?.[getDetectPlatform()]);

  if (selectedPath) {
    aliasEntry.path = selectedPath.replace(/\\/g, '/');
  } else if (hasExplicitDetect) {
    delete aliasEntry.path;
  } else if (fallbackPath) {
    aliasEntry.path = fallbackPath.replace(/\\/g, '/');
  } else {
    delete aliasEntry.path;
  }

  if (selectedTool?.version) {
    aliasEntry.version = String(selectedTool.version);
  } else {
    delete aliasEntry.version;
  }

  const defaultFromManifest = manifest?.aliases?.find((entry: any) => entry?.alias === alias)?.default;
  if (toolId !== defaultFromManifest) {
    aliasEntry.default = toolId;
  } else {
    delete aliasEntry.default;
  }

  cleanupRunnerEntry(jsEnv, alias);
  writeEnvYamlObject(jsEnv);
}
