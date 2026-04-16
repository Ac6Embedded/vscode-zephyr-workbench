export function normalizeWestFlagDValue(value: string): string {
  return value.trim().replace(/^(--\s*)?-D/, '').trim();
}

export function formatWestFlagDValues(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map(normalizeWestFlagDValue)
    .filter((value) => value.length > 0)
    .map((value) => `-D${value}`);
}

function splitExplicitCMakeArgs(raw: string): { westArgs: string; cmakeArgs: string } | undefined {
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

export function composeWestBuildArgs(raw: string | undefined, westFlagsD: string[] | undefined = []): string {
  const trimmedRaw = raw?.trim() ?? '';
  const formattedFlags = formatWestFlagDValues(westFlagsD).join(' ');

  if (!trimmedRaw) {
    return formattedFlags ? `-- ${formattedFlags}` : '';
  }

  const explicitCMakeArgs = splitExplicitCMakeArgs(trimmedRaw);
  if (explicitCMakeArgs) {
    const cmakeArgs = [explicitCMakeArgs.cmakeArgs, formattedFlags].filter(Boolean).join(' ');
    if (explicitCMakeArgs.westArgs.length > 0 && cmakeArgs.length > 0) {
      return `${explicitCMakeArgs.westArgs} -- ${cmakeArgs}`;
    }
    if (explicitCMakeArgs.westArgs.length > 0) {
      return explicitCMakeArgs.westArgs;
    }
    return cmakeArgs ? `-- ${cmakeArgs}` : '';
  }

  if (trimmedRaw.startsWith('-D')) {
    const cmakeArgs = [trimmedRaw, formattedFlags].filter(Boolean).join(' ');
    return `-- ${cmakeArgs}`;
  }

  if (!formattedFlags) {
    return trimmedRaw;
  }

  return `${trimmedRaw} -- ${formattedFlags}`;
}
