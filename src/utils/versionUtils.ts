/* Pure version helpers, kept free of vscode (and any other) imports so they can
   be shared with the webview bundles and plain unit tests. */

/**
 * Compares two version strings in semantic versioning format.
 * @param v1 - The first version string.
 * @param v2 - The second version string.
 * @returns A number: 1 if v1 > v2, -1 if v1 < v2, 0 if equal.
 */
export function compareVersions(v1: string, v2: string): number {
  const parseVersion = (version: string) => {
    const normalized = version.trim().replace(/^v/, '').split('+', 1)[0];
    const [core, prerelease] = normalized.split('-', 2);
    const coreParts = core.split('.').map(part => Number(part));

    if (coreParts.some(part => Number.isNaN(part))) {
      return undefined;
    }

    const prereleaseParts = prerelease
      ? prerelease
        .split('.')
        .flatMap(part => part.match(/[A-Za-z]+|\d+/g) ?? [part])
      : [];

    return { coreParts, prereleaseParts };
  };

  const parsedV1 = parseVersion(v1);
  const parsedV2 = parseVersion(v2);

  if (!parsedV1 || !parsedV2) {
    return v1.localeCompare(v2);
  }

  for (let i = 0; i < Math.max(parsedV1.coreParts.length, parsedV2.coreParts.length); i++) {
    const v1Part = parsedV1.coreParts[i] || 0;
    const v2Part = parsedV2.coreParts[i] || 0;

    if (v1Part > v2Part) {
      return 1;
    }
    if (v1Part < v2Part) {
      return -1;
    }
  }

  const v1HasPrerelease = parsedV1.prereleaseParts.length > 0;
  const v2HasPrerelease = parsedV2.prereleaseParts.length > 0;

  if (v1HasPrerelease !== v2HasPrerelease) {
    return v1HasPrerelease ? -1 : 1;
  }

  for (let i = 0; i < Math.max(parsedV1.prereleaseParts.length, parsedV2.prereleaseParts.length); i++) {
    const v1Part = parsedV1.prereleaseParts[i];
    const v2Part = parsedV2.prereleaseParts[i];

    if (v1Part === undefined) {
      return -1;
    }
    if (v2Part === undefined) {
      return 1;
    }

    const v1IsNumber = /^\d+$/.test(v1Part);
    const v2IsNumber = /^\d+$/.test(v2Part);

    if (v1IsNumber && v2IsNumber) {
      const v1Number = Number(v1Part);
      const v2Number = Number(v2Part);

      if (v1Number > v2Number) {
        return 1;
      }
      if (v1Number < v2Number) {
        return -1;
      }
      continue;
    }

    if (v1IsNumber !== v2IsNumber) {
      return v1IsNumber ? -1 : 1;
    }

    const comparison = v1Part.localeCompare(v2Part);
    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}
