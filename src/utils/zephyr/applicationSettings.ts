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
  getWorkspaceApplicationSetting,
  updateWorkspaceApplicationEntry,
} from './workspaceApplications';

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
