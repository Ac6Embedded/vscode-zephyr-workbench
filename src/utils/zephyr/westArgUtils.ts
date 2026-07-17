import { isPosixShellKind } from '../shellQuoting';

export function normalizeWestFlagDValue(value: string): string {
  return value.trim().replace(/^(--\s*)?-D/, '').trim();
}

function isWrappedInQuotes(value: string): boolean {
  return /^".*"$/.test(value) || /^'.*'$/.test(value);
}

function quoteWestFlagDArgument(value: string): string {
  const separatorIndex = value.indexOf('=');
  if (separatorIndex === -1) {
    return `-D${value}`;
  }

  const key = value.slice(0, separatorIndex);
  const rawAssignedValue = value.slice(separatorIndex + 1);
  const normalizedAssignedValue = rawAssignedValue.trim();
  const formattedAssignedValue =
    normalizedAssignedValue.length > 0 && !isWrappedInQuotes(normalizedAssignedValue)
      ? `'${normalizedAssignedValue.replace(/'/g, "''")}'`
      : normalizedAssignedValue;

  return `-D${key}=${formattedAssignedValue}`;
}

export function formatWestFlagDValues(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map(normalizeWestFlagDValue)
    .filter((value) => value.length > 0)
    .map(quoteWestFlagDArgument);
}

export interface SplitWestBuildArgs {
  westArgs: string;
  cmakeArgs: string;
}

function tokenizeWestArgs(raw: string | undefined): string[] {
  const input = raw?.trim() ?? '';
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

export interface ExpandWestArgsOptions {
  /** classifyShell() result for the shell that will run the composed command string. */
  shellKind: string;
  /**
   * Resolves ONE VS Code variable name (the text between `${` and `}`) — use
   * makeConfiguredVariableResolver() from execUtils, bound to the app's
   * workspace folder. MUST return undefined for unknown variables: VS Code or
   * the shell substitutes those later (${input:west.runner}, ${BUILD_DIR}).
   * Optional so pure callers/tests can omit it.
   */
  resolveVariable?: (name: string) => string | undefined;
  /** Injectable for tests. Defaults to process.platform === 'win32'. */
  isWindows?: boolean;
}

// Variables whose value is a single filesystem path (or path segment): only
// these get automatic quoting when their expansion contains whitespace.
// ${env:...}/${config:...} values are inlined verbatim — they may legitimately
// expand to MULTIPLE arguments (e.g. "-DFOO=1 -DBAR=2") that the shell must
// word-split, exactly as VS Code's own substitution behaved.
const PATH_VALUED_VARIABLE = /^(workspaceFolder(:.*)?|workspaceFolderBasename|userHome)$/;

// An `-opt=value` / `--opt=value` prefix. Quoting only the value part keeps
// downstream prefix checks working (splitWestBuildArgs routes on
// `startsWith('-D')`, which a leading quote would break).
const OPTION_VALUE_WORD = /^(--?[A-Za-z0-9][A-Za-z0-9_.:-]*=)(.*)$/;

/**
 * Prepare a user-provided west-args string for interpolation into a shell
 * command line. Span-preserving: the user's own quoting, escapes and spacing
 * are kept byte-identical — a string without supported ${...} variables and
 * without unquoted backslashes passes through unchanged. What it does:
 *
 *  - Expands supported VS Code ${...} variables inline (so the task system
 *    has nothing left to substitute into unquoted backslash paths). Unknown
 *    variables stay literal. Expanded path values get forward slashes for
 *    POSIX shells on Windows, and the containing word is double-quoted when
 *    the expansion contains whitespace and the occurrence is not already
 *    inside quotes (value-only for `-opt=` words).
 *  - Converts backslashes to forward slashes in UNQUOTED spans on Windows
 *    POSIX shells (bash would eat them as escapes there anyway), but never a
 *    backslash before a quote/`$`/backtick/whitespace — those are deliberate
 *    shell escapes — and never inside quoted spans, where backslashes
 *    survived the shell before and native west/cmake accept them.
 *
 * Call this on the RAW user string before splitWestBuildArgs/composeWestBuildArgs;
 * never on formatWestFlagDValues output (its single-quoted -D values must not
 * be re-processed).
 */
export function expandAndNormalizeWestArgs(
  raw: string | undefined,
  options: ExpandWestArgsOptions,
): string {
  if (!raw || raw.trim().length === 0) {
    return '';
  }

  const onWindows = options.isWindows ?? process.platform === 'win32';
  const convertSlashes = onWindows && isPosixShellKind(options.shellKind);

  let out = '';
  let quote: '"' | "'" | undefined;
  let wordStart = 0;           // index in `out` where the current word began
  let quoteWordAtEnd = false;  // a spaced path expansion landed in this word

  const closeWord = () => {
    if (!quoteWordAtEnd) {
      return;
    }
    quoteWordAtEnd = false;
    const word = out.slice(wordStart);
    if (/["']/.test(word)) {
      // Mixed quoted/unquoted word — adding quotes could nest incorrectly;
      // leave the user's own construction alone.
      return;
    }
    // A trailing backslash right before the closing quote would escape it
    // (`"...\"` never terminates, in bash and in Windows argv parsing alike);
    // double the trailing run so it stays a literal backslash.
    const wrap = (value: string) => `"${value.replace(/(\\+)$/, '$1$1')}"`;
    const optionValue = word.match(OPTION_VALUE_WORD);
    const quoted = optionValue ? `${optionValue[1]}${wrap(optionValue[2])}` : wrap(word);
    out = out.slice(0, wordStart) + quoted;
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    // Variable expansion happens in every context (VS Code's substitution was
    // textual too, quotes or not); quoting is only added in unquoted context.
    if (ch === '$' && raw[i + 1] === '{') {
      const end = raw.indexOf('}', i + 2);
      if (end !== -1) {
        const name = raw.slice(i + 2, end);
        const resolved = options.resolveVariable?.(name);
        if (resolved !== undefined) {
          const value = convertSlashes ? resolved.replace(/\\/g, '/') : resolved;
          if (!quote && PATH_VALUED_VARIABLE.test(name) && /\s/.test(value)) {
            quoteWordAtEnd = true;
          }
          out += value;
          i = end;
          continue;
        }
      }
      out += ch;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = undefined;
      }
      out += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }

    if (/\s/.test(ch)) {
      closeWord();
      out += ch;
      wordStart = out.length;
      continue;
    }

    if (ch === '\\' && convertSlashes) {
      const next = raw[i + 1];
      // Convert only backslashes that plausibly separate path segments
      // (next char is a path-name character or another `\` for UNC roots).
      // A backslash before anything else — `\"`, `\$`, `\;`, `\&`, `\(`,
      // `\ `, a final `\` — is a deliberate shell escape: bash strips it to
      // yield the literal character, whereas converting it to `/` would
      // ACTIVATE the metacharacter (e.g. `debug.conf\;net.conf` must not
      // become `debug.conf/;net.conf`, which splits the command).
      if (next !== undefined && /[A-Za-z0-9_.\-\\~]/.test(next)) {
        out += '/';
      } else {
        out += ch;
      }
      continue;
    }

    out += ch;
  }
  closeWord();

  return out.trim();
}

export function getWestBuildSourceDirArgValue(raw: string | undefined): string | undefined {
  const tokens = tokenizeWestArgs(raw);

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];

    if (token === '--') {
      return undefined;
    }

    if (token === '-s' || token === '--source-dir') {
      return tokens[index + 1] ?? '';
    }

    if (token.startsWith('-s=')) {
      return token.slice(3);
    }

    if (token.startsWith('-s') && token.length > 2) {
      return token.slice(2);
    }

    if (token.startsWith('--source-dir=')) {
      return token.slice('--source-dir='.length);
    }
  }

  return undefined;
}

export function hasWestBuildSourceDirArg(raw: string | undefined): boolean {
  return getWestBuildSourceDirArgValue(raw) !== undefined;
}

function splitExplicitCMakeArgs(raw: string): SplitWestBuildArgs | undefined {
  const directCMakeMatch = raw.match(/^--(?:\s+(.*))?$/);
  if (directCMakeMatch) {
    return {
      westArgs: '',
      cmakeArgs: directCMakeMatch[1]?.trim() ?? ''
    };
  }

  const explicitSeparatorMatch = raw.match(/^(.*?)(?:\s+)--(?:\s+(.*))?$/);
  if (!explicitSeparatorMatch) {
    return undefined;
  }

  return {
    westArgs: explicitSeparatorMatch[1]?.trim() ?? '',
    cmakeArgs: explicitSeparatorMatch[2]?.trim() ?? ''
  };
}

export function splitWestBuildArgs(raw: string | undefined, westFlagsD: string[] | undefined = []): SplitWestBuildArgs {
  const trimmedRaw = raw?.trim() ?? '';
  const formattedFlags = formatWestFlagDValues(westFlagsD).join(' ');

  if (!trimmedRaw) {
    return {
      westArgs: '',
      cmakeArgs: formattedFlags,
    };
  }

  const explicitCMakeArgs = splitExplicitCMakeArgs(trimmedRaw);
  if (explicitCMakeArgs) {
    return {
      westArgs: explicitCMakeArgs.westArgs,
      cmakeArgs: [explicitCMakeArgs.cmakeArgs, formattedFlags].filter(Boolean).join(' '),
    };
  }

  if (trimmedRaw.startsWith('-D')) {
    return {
      westArgs: '',
      cmakeArgs: [trimmedRaw, formattedFlags].filter(Boolean).join(' '),
    };
  }

  return {
    westArgs: trimmedRaw,
    cmakeArgs: formattedFlags,
  };
}

export function composeWestBuildArgs(raw: string | undefined, westFlagsD: string[] | undefined = []): string {
  const split = splitWestBuildArgs(raw, westFlagsD);
  if (split.westArgs.length > 0 && split.cmakeArgs.length > 0) {
    return `${split.westArgs} -- ${split.cmakeArgs}`;
  }
  if (split.westArgs.length > 0) {
    return split.westArgs;
  }
  return split.cmakeArgs.length > 0 ? `-- ${split.cmakeArgs}` : '';
}
