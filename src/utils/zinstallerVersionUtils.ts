import fs from "fs";
import path from "path";

import { getInternalDirRealPath } from "./utils";

// Shared helpers for the installed zinstaller_version metadata file.
// This module owns locating the file, extracting the script version from its
// contents, and comparing dotted version strings.

export function getZinstallerVersionFilePath(): string {
  return path.join(getInternalDirRealPath(), "zinstaller_version");
}

export function parseZinstallerVersionText(text: string): string | undefined {
  const match = /^Script Version:\s*([0-9.]+)/m.exec(text);
  return match?.[1];
}

export function readInstalledZinstallerVersion(): string | undefined {
  try {
    const versionFile = getZinstallerVersionFilePath();
    if (!fs.existsSync(versionFile)) {
      return undefined;
    }

    return parseZinstallerVersionText(fs.readFileSync(versionFile, "utf8"));
  } catch {
    return undefined;
  }
}

export function versionAtLeast(current: string, minimum: string): boolean {
  const currentParts = current.split(".").map(Number);
  const minimumParts = minimum.split(".").map(Number);
  const length = Math.max(currentParts.length, minimumParts.length);

  for (let index = 0; index < length; index++) {
    const currentValue = currentParts[index] ?? 0;
    const minimumValue = minimumParts[index] ?? 0;
    if (currentValue > minimumValue) { return true; }
    if (currentValue < minimumValue) { return false; }
  }

  return true;
}
