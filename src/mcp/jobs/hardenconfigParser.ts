// The options `west build -t hardenconfig` reports as differing from Zephyr's
// hardening recommendations. Zephyr's scripts/kconfig/hardenconfig.py prints
// only the failing options, as a tabulate grid (Name, Current, Recommended,
// Check result) since 2024 and as a fixed-width "name | current | recommended
// || check result" list before that; both are read. vscode-free, so it is
// unit tested on captured output.

import { cleanForLog } from '../core/ansi';
import { parseGridTables } from './gridTable';

export interface HardenconfigRow {
  /** With the CONFIG_ prefix, as hardenconfig prints it. */
  symbol: string;
  /** The value in the build, empty for an empty string. */
  current: string;
  recommended: string;
}

const LEGACY_ROW = /^\s*(CONFIG_[A-Za-z0-9_]+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\|\s*\S+\s*$/;

const withPrefix = (name: string) => (name.startsWith('CONFIG_') ? name : `CONFIG_${name}`);

/** Every row of the hardenconfig report in `output`, once each, in report order. */
export function parseHardenconfig(output: string): HardenconfigRow[] {
  const rows: HardenconfigRow[] = [];
  const seen = new Set<string>();
  const add = (row: HardenconfigRow) => {
    if (!seen.has(row.symbol)) {
      seen.add(row.symbol);
      rows.push(row);
    }
  };

  for (const table of parseGridTables(output)) {
    const headers = table.headers.map(header => header.toLowerCase());
    const name = headers.indexOf('name');
    const current = headers.indexOf('current');
    const recommended = headers.indexOf('recommended');
    if (name < 0 || current < 0 || recommended < 0) {
      continue;
    }
    for (const cells of table.rows) {
      const symbol = cells[name]?.trim();
      if (symbol && /^(CONFIG_)?[A-Za-z0-9_]+$/.test(symbol)) {
        add({ symbol: withPrefix(symbol), current: cells[current] ?? '', recommended: cells[recommended] ?? '' });
      }
    }
  }

  for (const line of cleanForLog(output).split('\n')) {
    const match = LEGACY_ROW.exec(line);
    if (match) {
      add({ symbol: match[1], current: match[2], recommended: match[3] });
    }
  }
  return rows;
}
