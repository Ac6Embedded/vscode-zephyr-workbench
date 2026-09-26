// Pattern matching for text an agent supplies.
//
// Agent-supplied regular expressions used to be compiled and run on the
// extension host thread. A pattern such as `(\w+)+!` backtracks exponentially,
// so a single call could freeze every extension in the window, and a
// prompt-injected agent could send exactly that. This matcher accepts a much
// smaller language, case-insensitive text where `*` matches any run of
// characters, and runs in O(text x pattern) time with no recursion, so no
// input can make it slow.

import { McpToolError } from './errors';

export const MAX_PATTERN_LENGTH = 200;

export class PatternError extends Error {}

/**
 * Wildcard match anywhere in `text`: the pattern is implicitly wrapped in `*`.
 * Case-insensitive. The classic linear two-pointer algorithm, which only ever
 * backtracks to the most recent star.
 */
function wildcardContains(text: string, pattern: string): boolean {
  const t = text.toLowerCase();
  const p = `*${pattern.toLowerCase()}*`;
  let ti = 0;
  let pi = 0;
  let starPi = -1;
  let starTi = 0;
  while (ti < t.length) {
    if (pi < p.length && p[pi] !== '*' && p[pi] === t[ti]) {
      ti++;
      pi++;
    } else if (pi < p.length && p[pi] === '*') {
      starPi = pi++;
      starTi = ti;
    } else if (starPi !== -1) {
      pi = starPi + 1;
      ti = ++starTi;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === '*') {
    pi++;
  }
  return pi === p.length;
}

/**
 * Compile an agent-supplied pattern into a safe predicate. Throws PatternError
 * for a pattern that is empty or too long, so the caller can report it.
 */
export function compileMatcher(pattern: string): (text: string) => boolean {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    throw new PatternError('pattern is empty.');
  }
  if (trimmed.length > MAX_PATTERN_LENGTH) {
    throw new PatternError(`pattern is longer than ${MAX_PATTERN_LENGTH} characters.`);
  }
  // Collapse runs of stars: they mean the same thing and only add work.
  const normalized = trimmed.replace(/\*+/g, '*');
  return text => wildcardContains(text, normalized);
}

/**
 * compileMatcher for a tool argument, shared by every tool that takes a
 * pattern: undefined when none was given, and a pattern the matcher refuses
 * becomes INVALID_ARGUMENT so the agent can correct it.
 */
export function matcherFor(pattern: string | undefined): ((text: string) => boolean) | undefined {
  if (!pattern) {
    return undefined;
  }
  try {
    return compileMatcher(pattern);
  } catch (error) {
    throw new McpToolError('INVALID_ARGUMENT', error instanceof PatternError ? error.message : String(error));
  }
}

export const PATTERN_HELP = 'Case-insensitive text to look for; * matches any run of characters. Not a regular expression.';
