// Writes Kconfig Manager changes into prj.conf inside a managed marker region, so the
// values survive pristine builds (a plain .config edit does not). Everything outside the
// region is preserved verbatim; a prior managed region is replaced in place.

import * as fs from 'fs';

const BEGIN = '# >>> Zephyr Workbench Kconfig Manager (managed) >>>';
const END = '# <<< Zephyr Workbench Kconfig Manager (managed) <<<';

export interface PrjConfWriteResult {
  written: number;
  /** Symbol names assigned outside the managed region (potential conflicts). */
  outsideConflicts: string[];
}

function symbolOf(line: string): string | undefined {
  // `CONFIG_FOO=y` or `# CONFIG_FOO is not set`
  let m = /^\s*(CONFIG_[A-Za-z0-9_]+)\s*=/.exec(line);
  if (m) { return m[1]; }
  m = /^\s*#\s*(CONFIG_[A-Za-z0-9_]+)\s+is not set\s*$/.exec(line);
  return m ? m[1] : undefined;
}

/**
 * Replace (or create) the managed region in prj.conf with `configLines`.
 * Returns the number of config lines written and any same-symbol assignments that
 * live outside the region (which the caller may want to surface to the user).
 */
export function writePrjConfManagedRegion(prjConfPath: string, configLines: string[]): PrjConfWriteResult {
  const managedSymbols = new Set(configLines.map(symbolOf).filter((s): s is string => !!s));

  let existing = '';
  if (fs.existsSync(prjConfPath)) {
    existing = fs.readFileSync(prjConfPath, 'utf8');
  }
  const lines = existing.length ? existing.split('\n') : [];

  // Locate any existing managed region.
  const begin = lines.indexOf(BEGIN);
  const end = lines.indexOf(END);

  const before: string[] = [];
  const after: string[] = [];
  if (begin >= 0 && end > begin) {
    before.push(...lines.slice(0, begin));
    after.push(...lines.slice(end + 1));
  } else {
    before.push(...lines);
  }

  // Detect same-symbol assignments outside the region (conflicts the region can't win
  // if they appear later in the file — prj.conf is order-sensitive on duplicates).
  const outsideConflicts: string[] = [];
  for (const line of [...before, ...after]) {
    const sym = symbolOf(line);
    if (sym && managedSymbols.has(sym)) { outsideConflicts.push(sym); }
  }

  const region = [BEGIN, ...configLines, END];

  // Assemble: trim a trailing blank so we don't accumulate blank lines across writes.
  const trimTrailingBlank = (arr: string[]) => {
    const copy = [...arr];
    while (copy.length && copy[copy.length - 1].trim() === '') { copy.pop(); }
    return copy;
  };

  const head = trimTrailingBlank(before);
  const tail = after.length ? ['', ...after] : [];
  const out = [...head, ...(head.length ? [''] : []), ...region, ...tail];

  let text = out.join('\n');
  if (!text.endsWith('\n')) { text += '\n'; }
  fs.writeFileSync(prjConfPath, text, 'utf8');

  return { written: configLines.length, outsideConflicts: Array.from(new Set(outsideConflicts)) };
}
