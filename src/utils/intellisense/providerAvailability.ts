import * as vscode from 'vscode';

/**
 * IntelliSense providers the workbench can configure for an application.
 * 'cpptools' is the default and drives the generated c_cpp_properties.json.
 * 'clangd' drives a generated .clangd file plus a query-driver argument.
 */
export type IntelliSenseProviderId = 'cpptools' | 'clangd';

export const CPPTOOLS_EXTENSION_ID = 'ms-vscode.cpptools';
export const CLANGD_EXTENSION_ID = 'llvm-vs-code-extensions.vscode-clangd';

export function isCppToolsInstalled(): boolean {
  return !!vscode.extensions.getExtension(CPPTOOLS_EXTENSION_ID);
}

export function isClangdInstalled(): boolean {
  return !!vscode.extensions.getExtension(CLANGD_EXTENSION_ID);
}

/**
 * Coerce an arbitrary stored value into a known provider id. Anything that is
 * not exactly 'clangd' resolves to 'cpptools' so a missing or legacy setting
 * keeps today's behavior.
 */
export function normalizeIntelliSenseProvider(raw: unknown): IntelliSenseProviderId {
  return raw === 'clangd' ? 'clangd' : 'cpptools';
}

/**
 * Provider suggested by default when creating an application: cpptools when it
 * is installed (even if clangd is too), clangd when only clangd is installed,
 * otherwise cpptools (its generated files stay inert until cpptools arrives).
 */
export function pickDefaultIntelliSenseProvider(): IntelliSenseProviderId {
  if (isCppToolsInstalled()) {
    return 'cpptools';
  }
  if (isClangdInstalled()) {
    return 'clangd';
  }
  return 'cpptools';
}

/** Short, quiet status line for the creation wizard (no popups, no toasts). */
export function describeIntelliSenseAvailability(): string {
  const cpp = isCppToolsInstalled() ? 'installed' : 'not installed';
  const clangd = isClangdInstalled() ? 'installed' : 'not installed';
  return `C/C++ extension: ${cpp}, clangd: ${clangd}`;
}
