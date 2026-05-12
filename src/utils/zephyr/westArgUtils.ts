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
