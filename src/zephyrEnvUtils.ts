import vscode from "vscode"; 
import { ZEPHYR_ENV_SETTING_PREFIX_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from "./constants";

export function addEnvValue(envVars: { [key: string]: string[] }, key: string, value: string): void {
  if (!envVars[key]) {
    envVars[key] = [value];
  } else {
    if (!envVars[key].includes(value)) {
      envVars[key].push(value);
    }
  }
}

export function replaceEnvValue(envVars: { [key: string]: string[] }, key: string, oldValue: string, newValue: string): boolean {
  if (envVars[key]) {
    const index = envVars[key].indexOf(oldValue);
    if (index !== -1) {
      envVars[key][index] = newValue;
      return true; 
    }
  }
  return false;
}

export function removeEnvValue(envVars: { [key: string]: string[] }, key: string, value: string): boolean {
  if (envVars[key]) {
    const index = envVars[key].indexOf(value);
    if (index !== -1) {
      envVars[key].splice(index, 1);
      return true;
    }
  }
  return false;
}

export async function saveEnv(workspaceFolder: vscode.WorkspaceFolder, key: string, values: string[]) {
  await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).update(`${ZEPHYR_ENV_SETTING_PREFIX_KEY}.${key}`, values, vscode.ConfigurationTarget.WorkspaceFolder);
}

export function loadEnv(workspaceFolder: vscode.WorkspaceFolder, key: string): string[] | undefined  {
  return vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).get(`${ZEPHYR_ENV_SETTING_PREFIX_KEY}.${key}`);
}

export function getEnvJoinValue(envVars: { [key: string]: string[] }, key: string): string {
  if (envVars[key]) {
    return envVars[key].join(';');
  }
  return '';
}