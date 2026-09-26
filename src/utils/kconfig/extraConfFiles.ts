// The EXTRA_CONF_FILE list of a build configuration, as the Kconfig Manager export and
// the MCP set_kconfig tool read and extend it. Free of any `vscode` dependency; the
// settings write lives in extraConfFileSettings.ts.

import * as path from 'path';

type EnvVars = Record<string, unknown> | undefined;

/** Whether `file` is already listed in a build configuration's EXTRA_CONF_FILE. */
export function isInExtraConfFiles(envVars: EnvVars, file: string): boolean {
  const list = envVars?.['EXTRA_CONF_FILE'];
  if (!Array.isArray(list)) { return false; }
  return list.some((entry: unknown) => typeof entry === 'string' && path.resolve(entry) === path.resolve(file));
}

/** The EXTRA_CONF_FILE list with `file` appended, unless it is already there. */
export function withExtraConfFile(envVars: EnvVars, file: string): string[] {
  const list = envVars?.['EXTRA_CONF_FILE'];
  const current = Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : [];
  if (!current.includes(file)) { current.push(file); }
  return current;
}
