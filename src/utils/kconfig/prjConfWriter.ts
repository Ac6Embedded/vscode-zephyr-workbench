// Writes Kconfig changes into prj.conf (or any .conf fragment) inside a managed marker
// region, so the values survive pristine builds (a plain .config edit does not).
// Everything outside the region is preserved verbatim.
//
// Both the Kconfig Manager export and the MCP set_kconfig tool write here, so the
// region is updated per symbol (an upsert) rather than replaced: replacing it would let
// one writer erase the other's lines, and a second export would drop the first
// export's values, which by then are baseline and no longer part of its drift.

import * as fs from 'fs';
import * as path from 'path';

export const BEGIN = '# >>> Zephyr Workbench Kconfig Manager (managed) >>>';
export const END = '# <<< Zephyr Workbench Kconfig Manager (managed) <<<';

export interface PrjConfWriteResult {
  written: number;
  /** Symbol names assigned outside the managed region (potential conflicts). */
  outsideConflicts: string[];
}

/** One assignment of a managed symbol found outside the region. */
export interface OutsideAssignment {
  /** With the CONFIG_ prefix, like `outsideConflicts`. */
  symbol: string;
  /** 1-based line number in the file. */
  line: number;
  /** A line after the region is merged later, so it wins over the managed value. */
  afterRegion: boolean;
}

export interface PrjConfUpsertPlan {
  /** The full new file text. */
  text: string;
  /** Whether `text` differs from the input. */
  changed: boolean;
  /** The lines inside the managed region after the change. */
  regionLines: string[];
  outsideAssignments: OutsideAssignment[];
  /** 1-based line of each upserted symbol in `text`, keyed with the CONFIG_ prefix. */
  lineOf: Record<string, number>;
}

/** `CONFIG_FOO=y` or `# CONFIG_FOO is not set` -> `CONFIG_FOO`. */
export function symbolOf(line: string): string | undefined {
  let m = /^\s*(CONFIG_[A-Za-z0-9_]+)\s*=/.exec(line);
  if (m) { return m[1]; }
  m = /^\s*#\s*(CONFIG_[A-Za-z0-9_]+)\s+is not set\s*$/.exec(line);
  return m ? m[1] : undefined;
}

/**
 * A control character in a line would split it in two, and a second line smuggled in
 * through a string value becomes an assignment of its own. Refused here as well as at
 * every input, because this is the last point before the file.
 */
function assertSingleLine(line: string): void {
  if (/[\u0000-\u0008\u000A-\u001F\u007F]/.test(line)) {
    throw new Error(`Refusing to write a configuration line with a control character: ${JSON.stringify(line.slice(0, 80))}`);
  }
}

const isMarker = (line: string, marker: string) => line.trimEnd() === marker;
const isBlank = (line: string) => line.trim() === '';

/**
 * Plan an upsert of the managed region, without touching the disk.
 *
 * `upserts` are complete lines (`CONFIG_FOO=y`, `# CONFIG_FOO is not set`): each replaces
 * the region's line for the same symbol in place, or is appended to the region. Symbols
 * in `removeSymbols` (with the CONFIG_ prefix) lose their region line. Lines outside the
 * region are never changed. A region left empty is removed together with its markers.
 */
export function planPrjConfUpsert(existing: string, upserts: string[], removeSymbols: string[] = []): PrjConfUpsertPlan {
  upserts.forEach(assertSingleLine);
  // CRLF files keep CRLF: a marker compared with its '\r' still attached is never
  // found, which used to append a second region on every write.
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing.length ? existing.split(/\r?\n/) : [];
  // The '' after the final newline is not a line of the file.
  if (lines.length && lines[lines.length - 1] === '') { lines.pop(); }

  const begin = lines.findIndex((l) => isMarker(l, BEGIN));
  const end = begin >= 0 ? lines.findIndex((l, i) => i > begin && isMarker(l, END)) : -1;
  const hasRegion = begin >= 0 && end > begin;
  const before = hasRegion ? lines.slice(0, begin) : [...lines];
  const region = hasRegion ? lines.slice(begin + 1, end) : [];
  const after = hasRegion ? lines.slice(end + 1) : [];

  const bySymbol = new Map<string, string>();
  const verbatim: string[] = [];
  for (const line of upserts) {
    const sym = symbolOf(line);
    if (sym) { bySymbol.set(sym, line); } else { verbatim.push(line); }
  }
  const removed = new Set(removeSymbols);

  const nextRegion: string[] = [];
  const placed = new Set<string>();
  for (const line of region) {
    const sym = symbolOf(line);
    if (sym && removed.has(sym)) { continue; }
    if (sym && bySymbol.has(sym)) {
      // Replace in place; any later duplicate of the same symbol goes.
      if (!placed.has(sym)) {
        nextRegion.push(bySymbol.get(sym) as string);
        placed.add(sym);
      }
      continue;
    }
    nextRegion.push(line);
  }
  for (const [sym, line] of bySymbol) {
    if (!placed.has(sym)) { nextRegion.push(line); }
  }
  for (const line of verbatim) {
    if (!nextRegion.includes(line)) { nextRegion.push(line); }
  }
  while (nextRegion.length && isBlank(nextRegion[nextRegion.length - 1])) { nextRegion.pop(); }

  // Trailing blank lines at the end of the file are dropped, so repeated writes do not
  // grow the file by one blank line each time.
  const trimEnd = (arr: string[]) => {
    const copy = [...arr];
    while (copy.length && isBlank(copy[copy.length - 1])) { copy.pop(); }
    return copy;
  };
  const trimStart = (arr: string[]) => {
    const first = arr.findIndex((l) => !isBlank(l));
    return first < 0 ? [] : arr.slice(first);
  };

  let out: string[];
  const hasContent = nextRegion.some((l) => !isBlank(l));
  const regionUnchanged = hasRegion
    ? nextRegion.length === region.length && nextRegion.every((l, i) => l === region[i])
    : !hasContent;
  if (regionUnchanged) {
    // Nothing to do: the file is left byte for byte as it is.
    out = lines;
  } else if (hasRegion && hasContent) {
    out = [...before, BEGIN, ...nextRegion, END, ...after];
  } else if (hasRegion) {
    // Nothing managed is left: the markers go too, with one blank line kept
    // between whatever surrounded them.
    const head = trimEnd(before);
    const tail = trimStart(after);
    out = [...head, ...(head.length && tail.length ? [''] : []), ...tail];
  } else if (hasContent) {
    const head = trimEnd(before);
    out = [...head, ...(head.length ? [''] : []), BEGIN, ...nextRegion, END];
  } else {
    out = lines;
  }
  let text = existing;
  if (!regionUnchanged) {
    out = trimEnd(out);
    text = out.length ? out.join(eol) + eol : '';
  }

  // Same-symbol assignments outside the region: prj.conf is order-sensitive, so one
  // after the region wins over the managed value.
  const managed = new Set([...bySymbol.keys(), ...removed]);
  const outsideAssignments: OutsideAssignment[] = [];
  const lineOf: Record<string, number> = {};
  let regionSeen = false;
  let inRegion = false;
  out.forEach((line, index) => {
    if (isMarker(line, BEGIN)) { inRegion = true; regionSeen = true; return; }
    if (isMarker(line, END)) { inRegion = false; return; }
    const sym = symbolOf(line);
    if (!sym || !managed.has(sym)) { return; }
    if (inRegion) {
      lineOf[sym] = index + 1;
    } else {
      outsideAssignments.push({ symbol: sym, line: index + 1, afterRegion: regionSeen });
    }
  });

  return {
    text,
    changed: text !== existing,
    regionLines: hasContent ? nextRegion : [],
    outsideAssignments,
    lineOf,
  };
}

/** The lines currently inside the managed region of a file (empty when there is none). */
export function readPrjConfManagedRegion(prjConfPath: string): string[] {
  let existing: string;
  try {
    existing = fs.readFileSync(prjConfPath, 'utf8');
  } catch {
    return [];
  }
  return planPrjConfUpsert(existing, []).regionLines;
}

/**
 * The file a write of `filePath` lands in: the end of its symbolic links, even when that
 * file does not exist yet, as a plain write would follow them.
 */
function writeTargetOf(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    // Missing, or a link whose target does not exist yet.
  }
  let current = filePath;
  for (let hops = 0; hops < 40; hops++) {
    try {
      if (!fs.lstatSync(current).isSymbolicLink()) { return current; }
      current = path.resolve(path.dirname(current), fs.readlinkSync(current));
    } catch {
      return current;
    }
  }
  return current;
}

/**
 * Write a file through a temporary sibling and a rename, so a reader (a build starting
 * at the same moment) sees the old content or the new one, never half of it.
 *
 * A rename replaces the directory entry rather than the file, so it would turn a linked
 * prj.conf (one file shared by several applications) into a private copy, reset its
 * permissions and overwrite a read-only file. So the rename is done on the file the link
 * points to, with that file's permissions; a read-only file still refuses the write, and
 * a file with several hard links is written in place, as a plain write would.
 */
export function writeFileAtomic(filePath: string, text: string): void {
  const dest = writeTargetOf(filePath);
  let existing: fs.Stats | undefined;
  try {
    existing = fs.statSync(dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
  }
  if (existing) {
    // A rename only needs the folder to be writable.
    fs.accessSync(dest, fs.constants.W_OK);
    if (existing.nlink > 1) {
      fs.writeFileSync(dest, text, 'utf8');
      return;
    }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    if (existing) {
      // Not through writeFileSync's mode, which the umask would narrow.
      fs.chmodSync(tmp, existing.mode & 0o7777);
    }
    fs.renameSync(tmp, dest);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw error;
  }
}

/**
 * Upsert `upsertLines` into the managed region of `prjConfPath` (creating the file when
 * missing), drop the region lines of `removeSymbols`, and write the result atomically.
 * Returns how many lines were given, and the same-symbol assignments left outside.
 */
export function upsertPrjConfManagedRegion(
  prjConfPath: string,
  upsertLines: string[],
  removeSymbols: string[] = [],
): PrjConfWriteResult & { lines: string[]; outsideAssignments: OutsideAssignment[] } {
  const existing = fs.existsSync(prjConfPath) ? fs.readFileSync(prjConfPath, 'utf8') : '';
  const plan = planPrjConfUpsert(existing, upsertLines, removeSymbols);
  if (plan.changed) {
    writeFileAtomic(prjConfPath, plan.text);
  }
  return {
    written: upsertLines.length,
    outsideConflicts: Array.from(new Set(plan.outsideAssignments.map((a) => a.symbol))),
    lines: plan.regionLines,
    outsideAssignments: plan.outsideAssignments,
  };
}
