// Keeps the stable bridge copy and its launcher current.
//
// Runs on every activation, not only when the user clicks Connect, so an agent
// configured by hand from the documentation finds a working bridge too. The
// launcher is rewritten every time because the editor runtime path moves: the
// VS Code Server path carries a commit hash and snap installs carry a revision.

import * as fs from 'fs';
import * as path from 'path';
import { posixLauncherScript } from '../agents/launcher';
import { BRIDGE_NAME, DIR_MODE, EXEC_MODE, FILE_MODE, McpPaths } from '../core/paths';

export interface BridgeVersionFile {
  version: string;
  sha256?: string;
  copiedAt: string;
}

export interface InstallResult {
  ok: boolean;
  copied: boolean;
  problem?: string;
}

/** Compare dotted versions numerically. Unknown parts count as zero. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(/[.+-]/).map(part => Number.parseInt(part, 10) || 0);
  const right = b.split(/[.+-]/).map(part => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function readVersionFile(file: string): BridgeVersionFile | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as BridgeVersionFile;
  } catch {
    return undefined;
  }
}

/**
 * Copy the bridge when it is missing, or when this extension is the same
 * version or newer than whatever installed it. Several editors (VS Code,
 * Insiders, Cursor) can share the directory, and an older one must not
 * downgrade a newer bridge.
 */
export function installBridge(
  paths: McpPaths, extensionOutDir: string, version: string, execPath: string,
): InstallResult {
  const source = path.join(extensionOutDir, BRIDGE_NAME);
  if (!fs.existsSync(source)) {
    return { ok: false, copied: false, problem: `The bridge was not found at ${source}. Reinstall the extension.` };
  }
  try {
    fs.mkdirSync(paths.home, { recursive: true, mode: DIR_MODE });

    const installed = readVersionFile(paths.bridgeVersion);
    const shouldCopy = !fs.existsSync(paths.bridge)
      || !installed
      || compareVersions(version, installed.version) >= 0;

    if (shouldCopy) {
      // Write beside the target, then rename, so a bridge an agent is running
      // right now is never read half written.
      const temporary = `${paths.bridge}.${process.pid}.tmp`;
      fs.copyFileSync(source, temporary);
      fs.renameSync(temporary, paths.bridge);
      fs.writeFileSync(paths.bridgeVersion, JSON.stringify({
        version,
        copiedAt: new Date().toISOString(),
      } satisfies BridgeVersionFile, null, 2), { mode: FILE_MODE });
    }

    if (process.platform !== 'win32') {
      fs.writeFileSync(paths.launcher, posixLauncherScript(paths, execPath, version), { mode: EXEC_MODE });
      fs.chmodSync(paths.launcher, EXEC_MODE);
    }
    return { ok: true, copied: shouldCopy };
  } catch (error) {
    return { ok: false, copied: false, problem: error instanceof Error ? error.message : String(error) };
  }
}
