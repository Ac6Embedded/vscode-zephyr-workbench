// Layout of the stable per-user directory shared by the extension host and the
// stdio bridge. Deliberately not inside `~/.zinstaller`: that directory is
// removed by host-tools uninstall and moves under $VSCODE_PORTABLE in portable
// mode, neither of which an agent-spawned bridge could know about.

import * as os from 'os';
import * as path from 'path';

export const MCP_HOME_ENV = 'ZW_MCP_HOME';

/**
 * Root of the stable directory. `override` comes from the
 * `zephyr-workbench.mcp.homeDir` setting; the environment variable is what the
 * bridge reads, because it has no access to VS Code settings.
 */
export function getMcpHome(override?: string): string {
  const fromEnv = process.env[MCP_HOME_ENV];
  const chosen = (override && override.trim()) || (fromEnv && fromEnv.trim());
  return chosen ? path.resolve(chosen) : defaultMcpHome();
}

/** Where everything lives when nothing overrides it. */
export function defaultMcpHome(): string {
  return path.join(os.homedir(), '.zephyr-workbench', 'mcp');
}

export interface McpPaths {
  home: string;
  bridge: string;
  bridgeVersion: string;
  launcher: string;
  installs: string;
  /** Copies of agent config files taken before each change. */
  backupsDir: string;
  windowsDir: string;
  wakeDir: string;
  locksDir: string;
  jobsDir: string;
  logsDir: string;
  audit: string;
  windowRecord(windowId: string): string;
  wakeMarker(windowId: string): string;
  jobDir(windowId: string): string;
  jobLog(windowId: string, jobId: string): string;
  jobRecord(windowId: string, jobId: string): string;
}

/** POSIX launcher name. Windows configs point at the editor binary directly. */
export const LAUNCHER_NAME = 'zw-mcp';
export const BRIDGE_NAME = 'bridge.cjs';

export function getMcpPaths(override?: string): McpPaths {
  const home = getMcpHome(override);
  const windowsDir = path.join(home, 'windows');
  const wakeDir = path.join(home, 'wake');
  const jobsDir = path.join(home, 'jobs');
  return {
    home,
    bridge: path.join(home, BRIDGE_NAME),
    bridgeVersion: path.join(home, 'bridge.version'),
    launcher: path.join(home, LAUNCHER_NAME),
    installs: path.join(home, 'installs.json'),
    backupsDir: path.join(home, 'backups'),
    windowsDir,
    wakeDir,
    locksDir: path.join(home, 'locks'),
    jobsDir,
    logsDir: path.join(home, 'logs'),
    audit: path.join(home, 'audit.jsonl'),
    windowRecord: (windowId: string) => path.join(windowsDir, `${windowId}.json`),
    wakeMarker: (windowId: string) => path.join(wakeDir, windowId),
    jobDir: (windowId: string) => path.join(jobsDir, windowId),
    jobLog: (windowId: string, jobId: string) => path.join(jobsDir, windowId, `${jobId}.log`),
    jobRecord: (windowId: string, jobId: string) => path.join(jobsDir, windowId, `${jobId}.json`),
  };
}

/** POSIX modes. No-ops on Windows, where the user-profile ACL applies instead. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;
export const EXEC_MODE = 0o755;
