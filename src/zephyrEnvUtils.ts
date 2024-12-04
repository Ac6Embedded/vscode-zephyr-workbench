import vscode from "vscode"; 
import { ZEPHYR_ENV_SETTING_PREFIX_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from "./constants";
import { ZephyrProjectBuildConfiguration } from "./ZephyrProjectBuildConfiguration";

export function addEnvValue(envVars: { [key: string]: any }, key: string, value: string): void {
  if (envVars[key]) {
    if(Array.isArray(envVars[key])) {
      if (!envVars[key].includes(value)) {
        envVars[key].push(value);
      }
    } else {
      envVars[key] = value;
    }
  }
}

export function replaceEnvValue(envVars: { [key: string]: any }, key: string, oldValue: string, newValue: string): boolean {
  if (envVars[key]) {
    if(Array.isArray(envVars[key])) {
      const index = envVars[key].indexOf(oldValue);
      if (index !== -1) {
        envVars[key][index] = newValue;
        return true; 
      }
    } else {
      envVars[key] = newValue;
      return true; 
    }
  }
  return false;
}

export function removeEnvValue(envVars: { [key: string]: any }, key: string, value: string): boolean {
  if (envVars[key]) {
    const index = envVars[key].indexOf(value);
    if (index !== -1) {
      envVars[key].splice(index, 1);
      return true;
    } else {
      envVars[key] = '';
      return true;
    }
  }
  return false;
}

export async function saveEnv(workspaceFolder: vscode.WorkspaceFolder, key: string, value: string | string[] | undefined ) {
  await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).update(`${ZEPHYR_ENV_SETTING_PREFIX_KEY}.${key}`, value, vscode.ConfigurationTarget.WorkspaceFolder);
}

export function loadEnv(workspaceFolder: vscode.WorkspaceFolder, key: string): string | string[] | undefined  {
  return vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).get(`${ZEPHYR_ENV_SETTING_PREFIX_KEY}.${key}`);
}

export async function addConfig(workspaceFolder: vscode.WorkspaceFolder, configToAdd: ZephyrProjectBuildConfiguration) {
  const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder);
  const buildConfigs = config.get<any[]>('build.configurations') ? config.get<any[]>('build.configurations') : [];

  if(buildConfigs) {
    let newBuildConfig = {
      name: configToAdd.name,
      board: configToAdd.boardIdentifier,
      active: "true"
    };
  
    buildConfigs.push(newBuildConfig);
  }
  await config.update('build.configurations', buildConfigs, vscode.ConfigurationTarget.WorkspaceFolder);
}

export async function deleteConfig(workspaceFolder: vscode.WorkspaceFolder, configToDelete: ZephyrProjectBuildConfiguration) {
  const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder);
  const buildConfigs = config.get<any[]>('build.configurations');
  if(buildConfigs) {
    let buildConfigIndex = buildConfigs.findIndex(buildConfig => buildConfig.name === configToDelete.name);
    if (buildConfigIndex !== -1) {
      buildConfigs.splice(buildConfigIndex, 1);
    }
  }
  await config.update('build.configurations', buildConfigs, vscode.ConfigurationTarget.WorkspaceFolder);
}

export async function saveConfigSetting(workspaceFolder: vscode.WorkspaceFolder, buildConfigName: string, key: string, value: string | string[]) {
  const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder);
  const buildConfigs = config.get<any[]>('build.configurations');
  if(buildConfigs) {
    let buildConfig = buildConfigs.find(buildConfig => buildConfig.name === buildConfigName);
    if(buildConfig) {
      // Remove attribute if value is empty
      if(value === "") {
        delete buildConfig[key];
      } else {
        buildConfig[key] = value;
      }
      await config.update('build.configurations', buildConfigs, vscode.ConfigurationTarget.WorkspaceFolder);
    }
  }
}

export async function saveConfigEnv(workspaceFolder: vscode.WorkspaceFolder, buildConfigName: string, key: string, value: string | string[]) {
  const config = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder);
  const buildConfigs = config.get<any[]>('build.configurations');
  if(buildConfigs) {
    let buildConfig = buildConfigs.find(buildConfig => buildConfig.name === buildConfigName);
    if(buildConfig) {
      buildConfig[`${ZEPHYR_ENV_SETTING_PREFIX_KEY}.${key}`] = value;
      await config.update('build.configurations', buildConfigs, vscode.ConfigurationTarget.WorkspaceFolder);
    }
  }
}

export function loadConfigEnv(workspaceFolder: vscode.WorkspaceFolder, buildConfigName: string, key: string): string | string[] | undefined {
  const config = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder);
  const buildConfigs: vscode.WorkspaceConfiguration[] | undefined = config.get<any[]>('build.configurations');
  if(buildConfigs) {
    let buildConfig = buildConfigs.find(buildConfig => buildConfig.name === buildConfigName);
    if(buildConfig) {
      return buildConfig[`${ZEPHYR_ENV_SETTING_PREFIX_KEY}.${key}`];
    }
  }
  return undefined;
}

export function getEnvValue(envVars: { [key: string]: any }, key: string): string {
  if (envVars[key]) {
    if(Array.isArray(envVars[key])) {
      return envVars[key].join(';');
    } else {
      return envVars[key];
    }
  }
  return '';
}

export function getBuildEnv(envVars: { [key: string]: any }): { [key: string]: string } {
  let buildEnv: { [key: string]: string } = {};
  for (const key in envVars) {
    if (envVars.hasOwnProperty(key)) {
      const value = getEnvValue(envVars, key);
      if(value !== '') {
        buildEnv[key] = value;
      }
    }
  }
  return buildEnv;
}