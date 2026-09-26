// "Check AI Agent Connection": the questions a user would otherwise have to ask
// in a support thread, answered in one place. Deliberately free of `vscode`, so
// every check is unit tested; the command only renders the result.

import * as fs from 'fs';
import { compareVersions, BridgeVersionFile } from './bridgeInstaller';
import { McpPaths } from '../core/paths';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** What to do about it, when not ok. */
  fix?: string;
}

export interface InstallFacts {
  paths: McpPaths;
  extensionVersion: string;
  platform: NodeJS.Platform;
  nodeMajor: number;
}

function readVersion(file: string): BridgeVersionFile | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as BridgeVersionFile;
  } catch {
    return undefined;
  }
}

/** Runtime to run the POSIX launcher points at, read back from the script itself. */
export function launcherRuntime(launcherText: string): string | undefined {
  const match = /^ZW_NODE='((?:[^']|'\\'')*)'$/m.exec(launcherText);
  return match ? match[1].replace(/'\\''/g, "'") : undefined;
}

export function checkInstall(facts: InstallFacts): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const { paths } = facts;

  checks.push(facts.nodeMajor >= 20
    ? { name: 'Editor runtime', ok: true, detail: `Node ${facts.nodeMajor} in the extension host.` }
    : {
      name: 'Editor runtime', ok: false,
      detail: `The extension host runs Node ${facts.nodeMajor}, and the MCP server needs 20 or later.`,
      fix: 'Update VS Code to 1.90 or later.',
    });

  const installed = readVersion(paths.bridgeVersion);
  if (!fs.existsSync(paths.bridge)) {
    checks.push({
      name: 'Bridge', ok: false, detail: `No bridge at ${paths.bridge}.`,
      fix: 'Reload the VS Code window. The bridge is installed on every start.',
    });
  } else if (installed && compareVersions(installed.version, facts.extensionVersion) < 0) {
    checks.push({
      name: 'Bridge', ok: false,
      detail: `The bridge is from ${installed.version}, older than this extension (${facts.extensionVersion}).`,
      fix: 'Reload the VS Code window to update it.',
    });
  } else {
    checks.push({ name: 'Bridge', ok: true, detail: `${paths.bridge} (${installed?.version ?? 'unknown version'}).` });
  }

  if (facts.platform !== 'win32') {
    if (!fs.existsSync(paths.launcher)) {
      checks.push({
        name: 'Launcher', ok: false, detail: `No launcher at ${paths.launcher}.`,
        fix: 'Reload the VS Code window.',
      });
    } else {
      const executable = (fs.statSync(paths.launcher).mode & 0o111) !== 0;
      const runtime = launcherRuntime(fs.readFileSync(paths.launcher, 'utf8'));
      if (!executable) {
        checks.push({
          name: 'Launcher', ok: false, detail: `${paths.launcher} is not executable.`,
          fix: `Run: chmod +x "${paths.launcher}"`,
        });
      } else if (runtime && !fs.existsSync(runtime)) {
        // Not fatal: the launcher falls back to `node` on PATH.
        checks.push({
          name: 'Launcher', ok: true,
          detail: `The editor runtime it points at is gone (${runtime}), so it will use node from PATH. Reload VS Code to repoint it.`,
        });
      } else {
        checks.push({ name: 'Launcher', ok: true, detail: paths.launcher });
      }
    }
  }
  return checks;
}
