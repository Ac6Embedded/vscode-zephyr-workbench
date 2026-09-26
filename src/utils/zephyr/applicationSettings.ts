import * as vscode from 'vscode';
import {
  ZEPHYR_ENV_SETTING_PREFIX_KEY,
  ZEPHYR_WORKBENCH_SETTING_SECTION_KEY,
} from '../../constants';
import { ZephyrApplication } from '../../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../../models/ZephyrBuildConfig';
import {
  addConfig,
  deleteConfig,
  saveConfigEnv,
  saveConfigSetting,
  saveEnv,
  toStoredEnvValue,
} from '../env/zephyrEnvUtils';
import {
  appendStoredBuildConfig,
  applyStoredSettingsPatch,
  markActiveStoredBuildConfig,
  removeStoredBuildConfig,
  StoredBuildConfig,
} from './buildConfigRules';
import {
  findWorkspaceApplicationEntry,
  getWorkspaceApplicationSetting,
  updateWorkspaceApplicationEntry,
} from './workspaceApplications';

const BUILD_CONFIGURATIONS_KEY = 'build.configurations';

function isWorkspaceApplication(project: ZephyrApplication): boolean {
  return project.isWestWorkspaceApplication;
}

function getBuildConfigs(entry: Record<string, any> | undefined): any[] {
  const rawConfigs = entry
    ? getWorkspaceApplicationSetting<any[]>(entry, 'build.configurations', [])
    : [];

  return Array.isArray(rawConfigs)
    ? rawConfigs.map(config => ({ ...config }))
    : [];
}

async function updateWorkspaceApplicationBuildConfig(
  project: ZephyrApplication,
  buildConfigName: string,
  updater: (buildConfig: any | undefined, buildConfigs: any[]) => void,
): Promise<void> {
  await updateWorkspaceApplicationEntry(project.appWorkspaceFolder, project.appRootPath, previousEntry => {
    const nextEntry = { ...(previousEntry ?? {}) };
    const buildConfigs = getBuildConfigs(nextEntry);
    const buildConfig = buildConfigs.find(config => config?.name === buildConfigName);
    updater(buildConfig, buildConfigs);
    nextEntry['build.configurations'] = buildConfigs;
    return nextEntry;
  });
}

export async function saveApplicationEnv(
  project: ZephyrApplication,
  key: string,
  value: string | string[] | undefined,
): Promise<void> {
  if (!isWorkspaceApplication(project)) {
    await saveEnv(project.appWorkspaceFolder, key, value);
    return;
  }

  await updateWorkspaceApplicationEntry(project.appWorkspaceFolder, project.appRootPath, previousEntry => ({
    ...(previousEntry ?? {}),
    [`${ZEPHYR_ENV_SETTING_PREFIX_KEY}.${key}`]: toStoredEnvValue(key, value, project.appWorkspaceFolder),
  }));
}

export async function saveApplicationConfigEnv(
  project: ZephyrApplication,
  buildConfigName: string,
  key: string,
  value: string | string[],
): Promise<void> {
  if (!isWorkspaceApplication(project)) {
    await saveConfigEnv(project.appWorkspaceFolder, buildConfigName, key, value);
    return;
  }

  await updateWorkspaceApplicationBuildConfig(project, buildConfigName, buildConfig => {
    if (!buildConfig) {
      return;
    }
    buildConfig[`${ZEPHYR_ENV_SETTING_PREFIX_KEY}.${key}`] =
      toStoredEnvValue(key, value, project.appWorkspaceFolder);
  });
}

export async function saveApplicationConfigSetting(
  project: ZephyrApplication,
  buildConfigName: string,
  key: string,
  value: string | string[],
): Promise<void> {
  if (!isWorkspaceApplication(project)) {
    await saveConfigSetting(project.appWorkspaceFolder, buildConfigName, key, value);
    return;
  }

  await updateWorkspaceApplicationBuildConfig(project, buildConfigName, buildConfig => {
    if (!buildConfig) {
      return;
    }
    if (value === '') {
      delete buildConfig[key];
    } else {
      buildConfig[key] = value;
    }
  });
}

export async function addApplicationConfig(
  project: ZephyrApplication,
  configToAdd: ZephyrBuildConfig,
): Promise<void> {
  if (!isWorkspaceApplication(project)) {
    await addConfig(project.appWorkspaceFolder, configToAdd);
    return;
  }

  await updateWorkspaceApplicationEntry(project.appWorkspaceFolder, project.appRootPath, previousEntry => {
    const nextEntry = { ...(previousEntry ?? {}) };
    const buildConfigs = getBuildConfigs(nextEntry);
    const newBuildConfig: any = {
      name: configToAdd.name,
      board: configToAdd.boardIdentifier,
    };
    if (configToAdd.active) {
      newBuildConfig.active = 'true';
    }
    buildConfigs.push(newBuildConfig);
    nextEntry['build.configurations'] = buildConfigs;
    return nextEntry;
  });
}

export async function deleteApplicationConfig(
  project: ZephyrApplication,
  configToDelete: ZephyrBuildConfig,
): Promise<void> {
  if (!isWorkspaceApplication(project)) {
    await deleteConfig(project.appWorkspaceFolder, configToDelete);
    return;
  }

  await updateWorkspaceApplicationEntry(project.appWorkspaceFolder, project.appRootPath, previousEntry => {
    const nextEntry = { ...(previousEntry ?? {}) };
    nextEntry['build.configurations'] = getBuildConfigs(nextEntry)
      .filter(config => config?.name !== configToDelete.name);
    return nextEntry;
  });
}

export async function updateApplicationSettings(
  project: ZephyrApplication,
  values: Record<string, any | undefined>,
): Promise<void> {
  if (!isWorkspaceApplication(project)) {
    const cfg = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, project.appWorkspaceFolder);
    for (const [key, value] of Object.entries(values)) {
      await cfg.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
    }
    return;
  }

  await updateWorkspaceApplicationEntry(project.appWorkspaceFolder, project.appRootPath, previousEntry => {
    const nextEntry = { ...(previousEntry ?? {}) };
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === 'undefined') {
        delete nextEntry[key];
      } else {
        nextEntry[key] = value;
      }
    }
    return nextEntry;
  });
}

// Whole-list edits of an application's build configurations.
//
// The helpers above write one key per call, and every call rewrites the whole
// array, so a change of several fields meant several writes, each firing a
// configuration change, and a failure halfway left a mix. The helpers below
// read the stored array once, change it in memory and write it once, and they
// report a missing configuration instead of silently doing nothing.

/** Changes to one stored build configuration. */
export interface BuildConfigPatch {
  /** Stored keys such as board, sysbuild or west-args. undefined, '' or [] removes the key. */
  settings?: Record<string, string | string[] | undefined>;
  /**
   * Build variable lists keyed without the env. prefix. Path entries are
   * stored portable. undefined removes the key; [] is stored as [], as the
   * Applications view does when its last value is removed.
   */
  env?: Record<string, string[] | undefined>;
}

function cloneStoredConfigs(raw: unknown): StoredBuildConfig[] {
  return Array.isArray(raw)
    ? raw.filter(config => config && typeof config === 'object').map(config => JSON.parse(JSON.stringify(config)))
    : [];
}

/** The application's build configurations as stored, as a copy safe to change. */
export function readStoredBuildConfigs(project: ZephyrApplication): StoredBuildConfig[] {
  if (!isWorkspaceApplication(project)) {
    return cloneStoredConfigs(vscode.workspace
      .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, project.appWorkspaceFolder)
      .get<any[]>(BUILD_CONFIGURATIONS_KEY));
  }
  const entry = findWorkspaceApplicationEntry(project.appWorkspaceFolder, project.appRootPath);
  return entry ? cloneStoredConfigs(getWorkspaceApplicationSetting<any[]>(entry, BUILD_CONFIGURATIONS_KEY, [])) : [];
}

/**
 * One read-modify-write of the build configurations, for both storage kinds.
 * `mutate` returns false to skip the write. Returns whether it wrote.
 */
async function mutateStoredBuildConfigs(
  project: ZephyrApplication,
  mutate: (configs: StoredBuildConfig[]) => boolean,
): Promise<boolean> {
  if (!isWorkspaceApplication(project)) {
    const cfg = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, project.appWorkspaceFolder);
    const configs = cloneStoredConfigs(cfg.get<any[]>(BUILD_CONFIGURATIONS_KEY));
    if (!mutate(configs)) {
      return false;
    }
    await cfg.update(BUILD_CONFIGURATIONS_KEY, configs, vscode.ConfigurationTarget.WorkspaceFolder);
    return true;
  }

  // updateWorkspaceApplicationEntry appends a new application when the path
  // matches none, so an application that vanished must stop here.
  const entry = findWorkspaceApplicationEntry(project.appWorkspaceFolder, project.appRootPath);
  if (!entry) {
    return false;
  }
  const configs = cloneStoredConfigs(getWorkspaceApplicationSetting<any[]>(entry, BUILD_CONFIGURATIONS_KEY, []));
  if (!mutate(configs)) {
    return false;
  }
  // No await between the read above and the one inside, so both see the same entry.
  await updateWorkspaceApplicationEntry(project.appWorkspaceFolder, project.appRootPath, previousEntry => {
    const nextEntry = { ...(previousEntry ?? {}) };
    nextEntry[BUILD_CONFIGURATIONS_KEY] = configs;
    // The prefixed spelling is read only when the plain one is absent, so a
    // copy left behind would be stale and shadowed forever.
    delete nextEntry[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${BUILD_CONFIGURATIONS_KEY}`];
    return nextEntry;
  });
  return true;
}

function applyBuildConfigPatch(project: ZephyrApplication, stored: StoredBuildConfig, patch: BuildConfigPatch): void {
  applyStoredSettingsPatch(stored, patch.settings ?? {});
  for (const [key, value] of Object.entries(patch.env ?? {})) {
    const storedKey = `${ZEPHYR_ENV_SETTING_PREFIX_KEY}.${key}`;
    if (value === undefined) {
      delete stored[storedKey];
    } else {
      stored[storedKey] = toStoredEnvValue(key, value, project.appWorkspaceFolder);
    }
  }
}

/** Apply `patch` to the configuration `configName` in one write. False when it does not exist. */
export async function updateApplicationConfig(
  project: ZephyrApplication,
  configName: string,
  patch: BuildConfigPatch,
): Promise<boolean> {
  let found = false;
  await mutateStoredBuildConfigs(project, configs => {
    const stored = configs.find(config => config?.name === configName);
    if (!stored) {
      return false;
    }
    found = true;
    applyBuildConfigPatch(project, stored, patch);
    return true;
  });
  return found;
}

/**
 * Append a configuration built from `base` (a stored configuration to copy, or
 * {}) plus `patch`, in one write. When `active` is set, it becomes the only
 * active configuration. Returns its index, or -1 when the name is taken.
 */
export async function createApplicationConfig(
  project: ZephyrApplication,
  name: string,
  base: StoredBuildConfig,
  patch: BuildConfigPatch,
  options: { active: boolean },
): Promise<number> {
  let index = -1;
  await mutateStoredBuildConfigs(project, configs => {
    const created: StoredBuildConfig = { ...JSON.parse(JSON.stringify(base)), name };
    applyBuildConfigPatch(project, created, patch);
    index = appendStoredBuildConfig(configs, created, options.active);
    return index !== -1;
  });
  return index;
}

/**
 * Make `configName` the only active configuration in one write. Returns its
 * index, which tasks.json references use, or -1 when it does not exist.
 */
export async function setActiveApplicationConfig(project: ZephyrApplication, configName: string): Promise<number> {
  let index = -1;
  await mutateStoredBuildConfigs(project, configs => {
    index = markActiveStoredBuildConfig(configs, configName);
    return index !== -1;
  });
  return index;
}

/**
 * Remove `configName` in one write. When it was the active one, the first
 * remaining configuration becomes active in the same write, so the
 * application always keeps one; the caller refreshes IntelliSense and tasks
 * for it.
 */
export async function removeApplicationConfig(
  project: ZephyrApplication,
  configName: string,
): Promise<{ removed: boolean; elected?: { name: string; index: number } }> {
  let result: { removed: boolean; elected?: { name: string; index: number } } = { removed: false };
  await mutateStoredBuildConfigs(project, configs => {
    result = removeStoredBuildConfig(configs, configName);
    return result.removed;
  });
  return result;
}
