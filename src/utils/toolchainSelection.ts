import * as vscode from 'vscode';
import { ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY } from '../constants';
import { ToolchainVariantId } from '../models/ToolchainInstallations';

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
