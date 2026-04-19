import * as vscode from 'vscode';
import {
  ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY,
  ZEPHYR_PROJECT_IAR_SETTING_KEY,
  ZEPHYR_PROJECT_SDK_SETTING_KEY,
  ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY,
} from '../constants';
import { ToolchainVariantId } from '../models/ToolchainInstallations';
import { ConfigurationScope, getConfiguredWorkbenchPath, toPortableConfiguredPath } from './execUtils';

export interface ToolchainSelection {
  variant: ToolchainVariantId;
  zephyrSdkPath?: string;
  iarToolchainPath?: string;
  armGnuToolchainPath?: string;
}

export function normalizeStoredToolchainVariant(
  cfg: vscode.WorkspaceConfiguration,
  rawVariant: string | undefined,
): ToolchainVariantId {
  if (rawVariant === 'zephyr_sdk') {
    cfg.update(ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY, 'zephyr', vscode.ConfigurationTarget.WorkspaceFolder);
    return 'zephyr';
  }

  if (
    rawVariant === 'zephyr'
    || rawVariant === 'zephyr/llvm'
    || rawVariant === 'gnuarmemb'
    || rawVariant === 'iar'
  ) {
    return rawVariant;
  }

  return 'zephyr';
}

export function readToolchainSelection(
  cfg: vscode.WorkspaceConfiguration,
  scope?: ConfigurationScope,
): ToolchainSelection {
  const variant = normalizeStoredToolchainVariant(
    cfg,
    cfg.get<string>(ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY),
  );

  return {
    variant,
    zephyrSdkPath: getConfiguredWorkbenchPath(ZEPHYR_PROJECT_SDK_SETTING_KEY, scope) ?? '',
    iarToolchainPath: getConfiguredWorkbenchPath(ZEPHYR_PROJECT_IAR_SETTING_KEY, scope) ?? '',
    armGnuToolchainPath: getConfiguredWorkbenchPath(ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY, scope) ?? '',
  };
}

export async function writeToolchainSelection(
  cfg: vscode.WorkspaceConfiguration,
  selection: ToolchainSelection,
  scope?: ConfigurationScope,
): Promise<void> {
  await cfg.update(ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY, selection.variant, vscode.ConfigurationTarget.WorkspaceFolder);

  if (selection.variant === 'iar') {
    await cfg.update(ZEPHYR_PROJECT_IAR_SETTING_KEY, selection.iarToolchainPath ? toPortableConfiguredPath(selection.iarToolchainPath, scope) : selection.iarToolchainPath, vscode.ConfigurationTarget.WorkspaceFolder);
    await cfg.update(ZEPHYR_PROJECT_SDK_SETTING_KEY, selection.zephyrSdkPath ? toPortableConfiguredPath(selection.zephyrSdkPath, scope) : selection.zephyrSdkPath, vscode.ConfigurationTarget.WorkspaceFolder);
    await cfg.update(ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    return;
  }

  if (selection.variant === 'gnuarmemb') {
    await cfg.update(ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY, selection.armGnuToolchainPath ? toPortableConfiguredPath(selection.armGnuToolchainPath, scope) : selection.armGnuToolchainPath, vscode.ConfigurationTarget.WorkspaceFolder);
    await cfg.update(ZEPHYR_PROJECT_SDK_SETTING_KEY, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await cfg.update(ZEPHYR_PROJECT_IAR_SETTING_KEY, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    return;
  }

  await cfg.update(ZEPHYR_PROJECT_SDK_SETTING_KEY, selection.zephyrSdkPath ? toPortableConfiguredPath(selection.zephyrSdkPath, scope) : selection.zephyrSdkPath, vscode.ConfigurationTarget.WorkspaceFolder);
  await cfg.update(ZEPHYR_PROJECT_IAR_SETTING_KEY, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  await cfg.update(ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
}
