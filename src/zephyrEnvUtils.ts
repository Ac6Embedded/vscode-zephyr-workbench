import vscode from "vscode"; 
import { ZEPHYR_ENV_SETTING_PREFIX_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from "./constants";

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

export async function saveEnv(workspaceFolder: vscode.WorkspaceFolder, key: string, value: string | string[]) {
  await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).update(`${ZEPHYR_ENV_SETTING_PREFIX_KEY}.${key}`, value, vscode.ConfigurationTarget.WorkspaceFolder);
}

export function loadEnv(workspaceFolder: vscode.WorkspaceFolder, key: string): string | string[] | undefined  {
  return vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).get(`${ZEPHYR_ENV_SETTING_PREFIX_KEY}.${key}`);
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