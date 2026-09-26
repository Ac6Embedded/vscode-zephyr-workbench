// Edits the Codex entry in ~/.codex/config.toml.
//
// That file is shared by the Codex CLI, its IDE extension and the desktop
// app, and it usually holds the user's own settings, so the edit is
// structural and verified rather than textual:
//
// - The entry is owned by its name. Every definition of
//   `mcp_servers.<name>` is replaced, wherever it sits and however it got
//   there: our marked block, a table written by hand from the docs, a
//   subtable left outside the block, or a block whose end marker was lost.
// - Comments and formatting everywhere else are kept, because only the lines
//   of that table are touched.
// - Both versions of the file are parsed and compared. If anything other than
//   our entry would change, nothing is written.

import { SERVER_NAME } from '../core/catalog';

interface SmolToml {
  parse(text: string): Record<string, unknown>;
}

// smol-toml declares ESM-only types but ships a CommonJS build, which is what
// this require resolves to, so parsing stays synchronous.
const toml = require('smol-toml') as SmolToml;

export const BEGIN = '# >>> zephyr-workbench mcp >>>';
export const END = '# <<< zephyr-workbench mcp <<<';

/**
 * The markers around the block of one server. The workbench's own server keeps
 * the markers it always had, so the files written before still match; another
 * server, such as the Zephyr Project's, is named in its markers, so removing
 * one block never takes the markers of the other.
 */
export function markersFor(name: string): { begin: string; end: string } {
  return name === SERVER_NAME
    ? { begin: BEGIN, end: END }
    : { begin: `# >>> zephyr-workbench mcp: ${name} >>>`, end: `# <<< zephyr-workbench mcp: ${name} <<<` };
}

export class TomlValidationError extends Error {
  constructor(readonly file: string, detail: string) {
    super(`${file} is not valid TOML: ${detail}`);
    this.name = 'TomlValidationError';
  }
}

/** The file defines the entry in a form that cannot be edited safely. */
export class ForeignEntryError extends Error {
  constructor(readonly file: string, name: string) {
    super(`${file} defines mcp_servers.${name} in a form Zephyr Workbench cannot edit safely. `
      + 'Remove that entry by hand, then try again.');
    this.name = 'ForeignEntryError';
  }
}

export function parseToml(text: string, file: string): Record<string, unknown> {
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return toml.parse(text);
  } catch (error) {
    throw new TomlValidationError(file, error instanceof Error ? error.message.split('\n')[0] : String(error));
  }
}

function serverOf(parsed: Record<string, unknown>, name: string): unknown {
  const servers = parsed.mcp_servers;
  return servers && typeof servers === 'object' ? (servers as Record<string, unknown>)[name] : undefined;
}

/** Deterministic JSON with sorted keys, for comparing parsed documents. */
function canonical(value: unknown): string {
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as object).sort()
      .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The document without our entry, with an emptied `mcp_servers` treated as absent. */
function withoutServer(parsed: Record<string, unknown>, name: string): string {
  const copy: Record<string, unknown> = { ...parsed };
  if (copy.mcp_servers && typeof copy.mcp_servers === 'object') {
    const servers = { ...(copy.mcp_servers as Record<string, unknown>) };
    delete servers[name];
    if (Object.keys(servers).length === 0) {
      delete copy.mcp_servers;
    } else {
      copy.mcp_servers = servers;
    }
  }
  return canonical(copy);
}

// ---------------------------------------------------------------------------
// A line scanner that knows just enough TOML to find table boundaries: string
// and comment syntax, multi-line strings, and brackets of multi-line values.

interface ScanState {
  /** Open multi-line string delimiter carried to the next line. */
  multiline?: '"""' | "'''";
  /** Open brackets and braces of a value that continues on the next line. */
  depth: number;
}

function scanLine(line: string, state: ScanState): ScanState {
  let { multiline, depth } = state;
  let i = 0;
  while (i < line.length) {
    if (multiline) {
      const close = line.indexOf(multiline, i);
      if (close === -1) {
        return { multiline, depth };
      }
      if (multiline === '"""') {
        // An escaped quote does not close a basic string.
        let backslashes = 0;
        for (let j = close - 1; j >= 0 && line[j] === '\\'; j--) {
          backslashes++;
        }
        if (backslashes % 2 === 1) {
          i = close + 1;
          continue;
        }
      }
      i = close + 3;
      // A closing delimiter may be followed by up to two more quotes of content.
      while (line[i] === multiline[0]) {
        i++;
      }
      multiline = undefined;
      continue;
    }
    const ch = line[i];
    if (ch === '#') {
      break;
    }
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      multiline = line.slice(i, i + 3) as '"""' | "'''";
      i += 3;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        i += line[i] === '\\' ? 2 : 1;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      const close = line.indexOf("'", i + 1);
      i = close === -1 ? line.length : close + 1;
      continue;
    }
    if (ch === '[' || ch === '{') {
      depth++;
    } else if ((ch === ']' || ch === '}') && depth > 0) {
      depth--;
    }
    i++;
  }
  return { multiline, depth };
}

/** Split a dotted key such as `a."b.c".'d'` into its parts. */
function splitKey(text: string): string[] | undefined {
  const parts: string[] = [];
  let i = 0;
  const skipSpace = () => { while (text[i] === ' ' || text[i] === '\t') { i++; } };
  skipSpace();
  while (i < text.length) {
    let part: string;
    if (text[i] === '"') {
      let j = i + 1;
      let value = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          value += text[j + 1] ?? '';
          j += 2;
        } else {
          value += text[j++];
        }
      }
      if (text[j] !== '"') {
        return undefined;
      }
      part = value;
      i = j + 1;
    } else if (text[i] === "'") {
      const close = text.indexOf("'", i + 1);
      if (close === -1) {
        return undefined;
      }
      part = text.slice(i + 1, close);
      i = close + 1;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
      if (!match) {
        return undefined;
      }
      part = match[0];
      i += part.length;
    }
    parts.push(part);
    skipSpace();
    if (i >= text.length) {
      break;
    }
    if (text[i] !== '.') {
      return undefined;
    }
    i++;
    skipSpace();
  }
  return parts.length > 0 ? parts : undefined;
}

/** `[a.b]` or `[[a.b]]`, with an optional trailing comment. */
function headerPath(line: string): string[] | undefined {
  const match = /^\s*\[\[?(.*?)\]\]?\s*(?:#.*)?$/.exec(line);
  if (!match || !line.trimStart().startsWith('[')) {
    return undefined;
  }
  return splitKey(match[1]);
}

/** The key of a `key = value` line. */
function keyOf(line: string): string[] | undefined {
  let i = 0;
  let quote: string | undefined;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i++;
      } else if (ch === quote) {
        quote = undefined;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '=') {
      return splitKey(line.slice(0, i).trimEnd());
    } else if (ch === '#') {
      return undefined;
    }
  }
  return undefined;
}

const startsWithPath = (full: string[], prefix: string[]) =>
  full.length >= prefix.length && prefix.every((part, index) => full[index] === part);

const isQuiet = (line: string) => line.trim() === '' || line.trimStart().startsWith('#');

/**
 * Remove every line that defines `mcp_servers.<name>`: its tables and
 * subtables, dotted keys and inline tables that reach it, and the markers of
 * its block, orphaned or not. Comments right above the next table stay with
 * that table, and so do the markers of another server's block.
 */
export function stripServer(text: string, name: string): string {
  const owned = ['mcp_servers', name];
  const { begin, end } = markersFor(name);
  const lines = text.split('\n');
  const out: string[] = [];
  let section: string[] = [];
  let droppingSection = false;
  /** Quiet lines seen while dropping, handed back if the next table is kept. */
  let pendingQuiet: string[] = [];
  let droppingValue = false;
  let state: ScanState = { depth: 0 };

  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const continuation = state.multiline !== undefined || state.depth > 0;

    if (!continuation) {
      droppingValue = false;
      const trimmed = line.trim();
      if (trimmed === begin) {
        continue;
      }
      if (trimmed === end) {
        // Our block ends here. Quiet lines inside it were ours; what follows
        // is the user's again, though keys would still belong to our table.
        if (droppingSection) {
          pendingQuiet = [];
          droppingSection = false;
        }
        continue;
      }
      const header = headerPath(line);
      if (header) {
        section = header;
        const owns = startsWithPath(header, owned);
        if (!owns && droppingSection) {
          out.push(...pendingQuiet);
        }
        pendingQuiet = [];
        droppingSection = owns;
        if (!owns) {
          out.push(raw);
        }
        state = scanLine(line, { depth: 0 });
        continue;
      }
      if (!droppingSection) {
        const key = keyOf(line);
        if (key && startsWithPath([...section, ...key], owned)) {
          droppingValue = true;
        }
      }
    }

    state = scanLine(line, state);
    if (droppingSection) {
      if (!continuation && isQuiet(line)) {
        pendingQuiet.push(raw);
      } else {
        pendingQuiet = [];
      }
      continue;
    }
    if (droppingValue) {
      continue;
    }
    out.push(raw);
  }
  if (droppingSection) {
    // Comments after a table at the end of the file are the user's notes.
    out.push(...pendingQuiet);
  }
  return out.join('\n');
}

function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Trim trailing blank lines to exactly one line end. */
function tidyEnd(text: string, eol: string): string {
  const trimmed = text.replace(/(?:\r?\n[ \t]*)+$/, '');
  return trimmed.length === 0 ? '' : `${trimmed}${eol}`;
}

export type CodexEntryState = 'configured' | 'outdated' | 'not-configured' | 'foreign';

/** Compare what the file holds for `name` with what it should hold. */
export function inspectServer(text: string, name: string, body: string, file: string): { state: CodexEntryState; note?: string } {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(text, file);
  } catch (error) {
    return { state: 'foreign', note: error instanceof Error ? error.message : String(error) };
  }
  const current = serverOf(parsed, name);
  if (current === undefined) {
    return { state: 'not-configured' };
  }
  const expected = serverOf(parseToml(body, file), name);
  return { state: canonical(current) === canonical(expected) ? 'configured' : 'outdated' };
}

/**
 * Put `body` (a `[mcp_servers.<name>]` table and its subtables) in place of
 * whatever defines that server now. Returns the text unchanged when the file
 * already holds exactly that entry.
 */
export function upsertServer(text: string, name: string, body: string, file: string): string {
  const before = parseToml(text, file);
  const wanted = serverOf(parseToml(body, file), name);
  if (wanted === undefined) {
    throw new Error(`The generated entry does not define mcp_servers.${name}.`);
  }
  if (canonical(serverOf(before, name)) === canonical(wanted)) {
    return text;
  }
  const eol = eolOf(text);
  const stripped = stripServer(text, name);
  if (serverOf(parseToml(stripped, file), name) !== undefined) {
    throw new ForeignEntryError(file, name);
  }
  const base = tidyEnd(stripped, eol);
  const { begin, end } = markersFor(name);
  const block = [begin, ...body.trim().split(/\r?\n/), end, ''].join(eol);
  const result = `${base}${base ? eol : ''}${block}`;

  const after = parseToml(result, file);
  if (canonical(serverOf(after, name)) !== canonical(wanted) || withoutServer(after, name) !== withoutServer(before, name)) {
    throw new Error(`Refusing to change ${file}: the edit would have altered settings other than mcp_servers.${name}.`);
  }
  return result;
}

/** Remove every definition of the server, and nothing else. */
export function removeServer(text: string, name: string, file: string): string {
  const before = parseToml(text, file);
  if (serverOf(before, name) === undefined) {
    return text;
  }
  const stripped = stripServer(text, name);
  const after = parseToml(stripped, file);
  if (serverOf(after, name) !== undefined) {
    throw new ForeignEntryError(file, name);
  }
  if (withoutServer(after, name) !== withoutServer(before, name)) {
    throw new Error(`Refusing to change ${file}: the edit would have altered settings other than mcp_servers.${name}.`);
  }
  return tidyEnd(stripped, eolOf(text));
}

