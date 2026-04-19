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
