// Every free-text value an agent supplies that can reach a shell command line
// passes through here. The repo's own `tokenizeArgs` only understands double
// quotes, which is not enough to prove a fragment is safe, so this module owns
// the check. It runs both when a value is used and when it is persisted,
// because stored west args reach a shell on the next build.

import * as path from 'path';
import { McpToolError } from './errors';

/**
 * Variable references the workbench expands itself before the string reaches a
 * shell (`expandAndNormalizeWestArgs`). This is an explicit allow-list of NAMES,
 * not a shape: an earlier version allowed any `${...}` and therefore accepted
 * `${IFS}`, which a POSIX shell expands to whitespace and which is a standard
 * way to smuggle word splitting past a filter.
 *
 * `${env:...}` and `${config:...}` are deliberately NOT accepted from an agent.
 * Their values are not under our control, and expansion happens after this
 * check, so allowing them would move the trust boundary somewhere we cannot
 * see. Callers that expand a value must re-run `assertSafeShellFragment` on the
 * expanded result before handing it to a shell.
 */
const VARIABLE_REFERENCE = /\$\{(?:workspaceFolder|workspaceFolderBasename|userHome|pathSeparator)\}/g;

/** Shell metacharacters that must never survive into a command line. */
const FORBIDDEN_CHARS = /[;&|`$(){}<>\n\r\t\u0000-\u001F\u007F]/;

const BOARD_PATTERN = /^[A-Za-z0-9_.\\/@+-]+$/;
const CONFIG_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const RUNNER_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const SYMBOL_PATTERN = /^[A-Za-z0-9_]{1,128}$/;
// Snippets reach the command line unquoted as `-S name`, so the shape is strict.
const SHIELD_OR_SNIPPET_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
// A CMake cache variable, optionally typed as in -DNAME:STRING=value. The name
// is passed unquoted when the -D flag is formatted.
const CMAKE_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}(?::[A-Z]{1,16})?$/;

/** True when every quote in the string is closed. */
export function hasBalancedQuotes(value: string): boolean {
  let single = false;
  let double = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && double) {
      i++;
      continue;
    }
    if (ch === "'" && !double) {
      single = !single;
    } else if (ch === '"' && !single) {
      double = !double;
    }
  }
  return !single && !double;
}

/**
 * Throw unless `value` is safe to splice into a shell command line.
 * `label` names the offending field in the error so the agent can fix it.
 */
export function assertSafeShellFragment(value: string, label: string): string {
  if (value.length > 4096) {
    throw new McpToolError('INVALID_ARGUMENT', `${label} is too long (${value.length} characters, maximum 4096).`);
  }
  // Mask the variable references we expand ourselves, then judge the remainder.
  const masked = value.replace(VARIABLE_REFERENCE, '');
  const offender = masked.match(FORBIDDEN_CHARS);
  if (offender) {
    const shown = offender[0].trim().length === 0
      ? `whitespace control character (code ${offender[0].charCodeAt(0)})`
      : `"${offender[0]}"`;
    throw new McpToolError('INVALID_ARGUMENT',
      `${label} contains ${shown}, which is not allowed because the value is passed to a shell.`, {
        hint: 'Remove shell metacharacters. Only plain arguments and ${workspaceFolder}-style variables are accepted.',
      });
  }
  if (!hasBalancedQuotes(value)) {
    throw new McpToolError('INVALID_ARGUMENT', `${label} has an unbalanced quote.`);
  }
  return value;
}

function assertPattern(value: string, pattern: RegExp, label: string, shape: string): string {
  if (!pattern.test(value)) {
    throw new McpToolError('INVALID_ARGUMENT', `${label} "${value}" is not valid. Expected ${shape}.`);
  }
  return value;
}

export const assertBoardIdentifier = (v: string) =>
  assertPattern(v, BOARD_PATTERN, 'board', 'letters, digits and . _ - / @ +');
export const assertConfigName = (v: string) =>
  assertPattern(v, CONFIG_NAME_PATTERN, 'config_name', '1 to 64 characters of letters, digits and . _ -');
export const assertRunnerName = (v: string) =>
  assertPattern(v, RUNNER_PATTERN, 'runner', '1 to 64 characters of letters, digits and . _ -');
export const assertKconfigSymbol = (v: string) =>
  assertPattern(v, SYMBOL_PATTERN, 'symbol', 'a Kconfig symbol name such as CONFIG_GPIO or GPIO');
export const assertShieldOrSnippetName = (v: string, label: string) =>
  assertPattern(v, SHIELD_OR_SNIPPET_PATTERN, label, 'a name of letters, digits and . _ - such as x_nucleo_iks01a3');
export const assertCmakeVariableName = (v: string, label: string) =>
  assertPattern(v, CMAKE_VARIABLE_PATTERN, label, 'a CMake variable name such as CONFIG_DEBUG or MY_OPTION:STRING');

/**
 * One element of a build variable list such as EXTRA_CONF_FILE. The elements
 * are joined with ";" into one environment variable and echoed inside double
 * quotes when a terminal starts, so on top of the shell rules they may hold no
 * quote at all.
 */
export function assertEnvListElement(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new McpToolError('INVALID_ARGUMENT', `${label} has an empty entry.`);
  }
  if (value.length > 1024) {
    throw new McpToolError('INVALID_ARGUMENT', `${label} has an entry longer than 1024 characters.`);
  }
  assertSafeShellFragment(value, label);
  if (/["']/.test(value)) {
    throw new McpToolError('INVALID_ARGUMENT', `${label} entry "${value}" contains a quote, which is not allowed in a list entry.`, {
      hint: 'Pass each file or folder as its own list entry, without quotes.',
    });
  }
  return value;
}

/**
 * Letters, marks and digits of any script, and the punctuation paths use that
 * none of the shells the workbench runs gives a meaning to. Everything else is
 * out: % $ ^ ! and quotes expand or escape, * ? [ glob, and PowerShell reads an
 * unquoted comma as an array.
 */
const PLAIN_PATH = /^[\p{L}\p{M}\p{N}_.\-/\\: +@=~]+$/u;

/**
 * True when a configured path, such as a board root, can go onto a command
 * line as one plain argument whichever shell runs it. It is an allow-list
 * because a deny-list missed `%NAME%`, which the workbench itself rewrites
 * into `${NAME}` for a POSIX shell after any check on the setting.
 */
export function isPlainPath(value: string): boolean {
  return PLAIN_PATH.test(value);
}

/**
 * isPlainPath for a path already shaped for the shell. It may be wrapped in
 * one pair of double quotes, which it then needs for its spaces, and inside
 * them must not end in a backslash, which Windows reads as escaping the quote.
 */
export function isPlainShellArgument(arg: string): boolean {
  const quoted = arg.length >= 2 && arg.startsWith('"') && arg.endsWith('"');
  const inner = quoted ? arg.slice(1, -1) : arg;
  return isPlainPath(inner) && (quoted ? !inner.endsWith('\\') : !inner.includes(' '));
}

/** Normalize a path for comparison: absolute, no trailing separator, case-folded where the OS is. */
export function normalizeForCompare(target: string, platform: NodeJS.Platform = process.platform): string {
  let normalized = path.normalize(target).replace(/[\\/]+$/, '');
  if (platform === 'win32' || platform === 'darwin') {
    normalized = normalized.toLowerCase();
  }
  return platform === 'win32' ? normalized.replace(/\//g, '\\') : normalized;
}

/** True when `child` is `parent` or lives underneath it. */
export function isInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const c = normalizeForCompare(child, platform);
  const p = normalizeForCompare(parent, platform);
  if (c === p) {
    return true;
  }
  const sep = platform === 'win32' ? '\\' : '/';
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Throw unless `child` is inside at least one of `parents`. */
export function assertInside(child: string, parents: string[], label: string): string {
  if (parents.some(parent => isInside(child, parent))) {
    return child;
  }
  throw new McpToolError('PATH_OUTSIDE_WORKSPACE',
    `${label} "${child}" is outside every folder this window knows about.`, {
      hint: 'Use a path returned by list_apps or get_status.',
      details: { allowed: parents },
    });
}
