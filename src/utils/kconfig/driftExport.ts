// What a confirmed Kconfig Manager export writes, from the drift entries the user kept:
// the lines to upsert into the target's managed region, and the symbols whose managed
// line goes. Free of any `vscode` or `fs` dependency, so the webview bundles it too.

import type { KcDriftEntry } from './kconfigRpcTypes';

export interface DriftExportEdits {
  /** Complete lines (`CONFIG_FOO=y`, `# CONFIG_FOO is not set`) to upsert. */
  lines: string[];
  /** Symbol names without the CONFIG_ prefix whose managed line is removed. */
  remove: string[];
}

export function driftExportEdits(entries: readonly KcDriftEntry[]): DriftExportEdits {
  return {
    lines: entries.filter((e) => e.managedLine !== 'remove' && e.configString).map((e) => e.configString),
    remove: entries.filter((e) => e.managedLine === 'remove').map((e) => e.name),
  };
}

/**
 * The removals of a write request that the export offered, with the CONFIG_ prefix the
 * writer takes. The request comes from the webview, so anything else is ignored.
 */
export function offeredRemovals(requested: readonly string[] | undefined, offered: readonly string[]): string[] {
  return (requested ?? []).filter((name) => offered.includes(name)).map((name) => `CONFIG_${name}`);
}
