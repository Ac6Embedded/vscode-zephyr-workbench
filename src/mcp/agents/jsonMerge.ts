// Edits an agent's JSON config without destroying it.
//
// These files are JSONC in practice: VS Code's mcp.json, Cursor's and Gemini's
// settings all tolerate comments, and users write them. A parse-and-rewrite
// would silently drop those comments, so every edit goes through jsonc-parser,
// which returns minimal text edits instead.

import {
  applyEdits, createScanner, findNodeAtLocation, modify, parse, ParseError, parseTree, printParseErrorCode, SyntaxKind,
} from 'jsonc-parser';

const FORMAT = { insertSpaces: true, tabSize: 2, eol: '\n' };

export class ConfigParseError extends Error {
  constructor(readonly file: string, detail: string) {
    super(`${file} is not valid JSON: ${detail}`);
    this.name = 'ConfigParseError';
  }
}

/** Parse permissively, but refuse to touch a file we cannot understand. */
export function parseJsonc<T = unknown>(text: string, file: string): T {
  if (text.trim().length === 0) {
    return {} as T;
  }
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0];
    throw new ConfigParseError(file, `${printParseErrorCode(first.error)} at offset ${first.offset}`);
  }
  return (value ?? {}) as T;
}

/** Set `path` to `value`, preserving comments and formatting. */
export function setJsonPath(text: string, path: (string | number)[], value: unknown): string {
  const edits = modify(text, path, value, { formattingOptions: FORMAT });
  return applyEdits(text, edits);
}

/** Offset of the next comma after `from`, skipping whitespace and comments, or -1. */
function commaAfter(text: string, from: number): number {
  const scanner = createScanner(text, true);
  scanner.setPosition(from);
  const token = scanner.scan();
  return token === SyntaxKind.CommaToken ? scanner.getTokenOffset() : -1;
}

/**
 * Remove `path`. Returns the text unchanged when it was not there.
 *
 * Only the property itself and one separating comma are deleted, plus the
 * lines it occupied when nothing else shares them. jsonc-parser's own removal
 * reformats the neighbouring entries and can take comments with it, and these
 * are files people keep notes and commented-out servers in.
 */
export function removeJsonPath(text: string, path: (string | number)[]): string {
  const root = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
  const valueNode = root ? findNodeAtLocation(root, path) : undefined;
  const property = valueNode?.parent;
  if (!valueNode || !property || property.type !== 'property' || !property.parent) {
    return text;
  }
  const siblings = property.parent.children ?? [];
  const index = siblings.indexOf(property);
  let start = property.offset;
  let end = property.offset + property.length;
  const deletions: [number, number][] = [];

  const trailing = commaAfter(text, end);
  if (trailing >= 0) {
    // "key": value,  ... the comma goes with the property. When a comment sits
    // between them, only the comma itself is removed and the comment stays.
    if (text.slice(end, trailing).trim() === '') {
      end = trailing + 1;
    } else {
      deletions.push([trailing, trailing + 1]);
    }
  } else if (index > 0) {
    // The last property: remove the comma that ended the previous one.
    const previous = siblings[index - 1];
    const leading = commaAfter(text, previous.offset + previous.length);
    if (leading >= 0) {
      deletions.push([leading, leading + 1]);
    }
  }

  // Take whole lines when the property had them to itself.
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const newline = text.indexOf('\n', end);
  const lineEnd = newline === -1 ? text.length : newline + 1;
  if (text.slice(lineStart, start).trim() === '' && text.slice(end, lineEnd).trim() === '') {
    start = lineStart;
    end = lineEnd;
  }
  deletions.push([start, end]);

  let result = text;
  for (const [from, to] of deletions.sort((a, b) => b[0] - a[0])) {
    result = result.slice(0, from) + result.slice(to);
  }

  // Confirm the narrow edit did exactly what was meant; otherwise fall back
  // to the library's removal, which is always correct if less tidy.
  const expected = parse(text, [], { allowTrailingComma: true }) as Record<string, unknown>;
  removeAt(expected, path);
  const errors: ParseError[] = [];
  const actual = parse(result, errors, { allowTrailingComma: true });
  if (errors.length > 0 || JSON.stringify(actual) !== JSON.stringify(expected)) {
    return applyEdits(text, modify(text, path, undefined, { formattingOptions: FORMAT }));
  }
  return result;
}

function removeAt(value: unknown, path: (string | number)[]): void {
  let current = value as Record<string | number, unknown> | undefined;
  for (const key of path.slice(0, -1)) {
    current = current?.[key] as Record<string | number, unknown> | undefined;
  }
  if (current && typeof current === 'object') {
    delete current[path[path.length - 1]];
  }
}

/** Read a nested value without throwing on a missing branch. */
export function readJsonPath(value: unknown, path: (string | number)[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}
