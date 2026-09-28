// run_command: whose environment a command runs in, and where. The
// environment is the one the Zephyr terminal of that build configuration or
// west workspace gets, built by the same code, so a command an agent runs
// sees what the user sees when typing it there.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from '../../constants';
import { WestWorkspace } from '../../models/WestWorkspace';
import { ZephyrApplication } from '../../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../../models/ZephyrBuildConfig';
import {
  ConfigurationScope, expandEnvVariables, getConfiguredVenvPath, getConfiguredWorkbenchPath, getResolvedShell, TerminalEnvGroup,
} from '../../utils/execUtils';
import { isInside } from '../core/argSafety';
import { McpToolError, toToolError } from '../core/errors';
import { getMcpPaths } from '../core/paths';
import { logSafe } from '../core/redact';
import { envScriptFor, shellOfKind } from './commandScripts';
import { HostServices } from './services';
import { runCapturedTask } from './taskRunner';

/** A shell to build the environment for: its executable, and its profile arguments. */
export interface ShellChoice {
  path: string;
  args?: string[];
}

/**
 * What run_command takes from the workbench. Replaced in tests, which have
 * no terminal profile, no settings and no real application models.
 */
export const commandHost = {
  /** The shell VS Code opens terminals with, after the workbench's own substitutions. */
  terminalShell: (): ShellChoice => getResolvedShell(),
  configGroups: (app: ZephyrApplication, config: ZephyrBuildConfig, shell: ShellChoice): TerminalEnvGroup[] =>
    ZephyrBuildConfig.buildTerminalContext(app, config, shell).groups,
  workspaceGroups: (workspace: WestWorkspace, shell: ShellChoice): TerminalEnvGroup[] =>
    WestWorkspace.buildTerminalContext(workspace, shell).groups,
  envScriptSetting: (scope: ConfigurationScope): string | undefined =>
    getConfiguredWorkbenchPath(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, scope),
  /**
   * Where env scripts go: the MCP home folder, never the user's project. The
   * home setting is read at machine scope, as the MCP controller reads it.
   */
  envDir: (): string => {
    const inspected = vscode.workspace.getConfiguration('zephyr-workbench.mcp').inspect?.<unknown>('homeDir');
    const configured = inspected?.globalValue ?? inspected?.defaultValue;
    return getMcpPaths(typeof configured === 'string' && configured.trim() ? configured : undefined).envDir;
  },
  runTask: runCapturedTask,
};

export interface CommandTarget {
  kind: 'config' | 'workspace';
  /** How a terminal or a script names it: `blinky (primary)`, or the west workspace's name. */
  label: string;
  /** What Allow for This Session covers: the application root or the west workspace root. */
  scope: string;
  scopeLabel: 'this application' | 'this west workspace';
  appPath?: string;
  configName?: string;
  board?: string;
  westWorkspace?: string;
  venvPath?: string;
  /** The build folder of the configuration, which a command that builds claims. */
  buildDir?: string;
  /** Where a command runs unless cwd says otherwise, as the Zephyr terminal opens. */
  cwdDefault: string;
  /** The folder a task runs for, when the target is one. */
  taskScope?: vscode.WorkspaceFolder;
  /** Where the environment script setting is read. */
  settingsScope: ConfigurationScope;
  /** The variables of the Zephyr terminal, in groups, with paths in the form `shell` takes. */
  groups(shell: ShellChoice): TerminalEnvGroup[];
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/**
 * The application build configuration or the west workspace the call names:
 * app_path with config_name (the active configuration by default), or
 * west_workspace. With neither, the only application of the window.
 */
export async function resolveCommandTarget(services: HostServices, args: Record<string, unknown>): Promise<CommandTarget> {
  const appPath = str(args.app_path);
  const westWorkspace = str(args.west_workspace);
  if (appPath && westWorkspace) {
    throw new McpToolError('INVALID_ARGUMENT', 'Pass app_path or west_workspace, not both: each picks an environment of its own.', {
      hint: 'Pass app_path for the environment of an application build configuration, or west_workspace alone for that of a west workspace.',
    });
  }
  if (westWorkspace) {
    if (args.config_name !== undefined) {
      throw new McpToolError('INVALID_ARGUMENT', 'config_name picks a build configuration of an application, so it goes with app_path, not west_workspace.');
    }
    const { workspace } = await services.resolveWestWorkspace(westWorkspace);
    const root = workspace.rootUri.fsPath;
    return {
      kind: 'workspace',
      label: workspace.name,
      scope: root,
      scopeLabel: 'this west workspace',
      westWorkspace: root,
      ...(workspace.venvPath ? { venvPath: workspace.venvPath } : {}),
      cwdDefault: root,
      taskScope: vscode.workspace.getWorkspaceFolder(workspace.rootUri),
      settingsScope: workspace.rootUri,
      groups: shell => commandHost.workspaceGroups(workspace, shell),
    };
  }
  const { app, config, buildDir } = await services.resolveTarget(appPath, str(args.config_name));
  // The venv a build of this application activates, with the precedence build_app claims it by.
  const venvPath = app.venvPath ?? getConfiguredVenvPath(app.appWorkspaceFolder);
  return {
    kind: 'config',
    label: `${app.appName} (${config.name})`,
    scope: app.appRootPath,
    scopeLabel: 'this application',
    appPath: app.appRootPath,
    configName: config.name,
    ...(config.boardIdentifier ? { board: config.boardIdentifier } : {}),
    ...(app.westWorkspaceRootPath ? { westWorkspace: app.westWorkspaceRootPath } : {}),
    ...(venvPath ? { venvPath } : {}),
    buildDir,
    cwdDefault: fs.existsSync(buildDir) ? buildDir : app.appRootPath,
    taskScope: app.appWorkspaceFolder,
    settingsScope: app.appWorkspaceFolder,
    groups: shell => commandHost.configGroups(app, config, shell),
  };
}

/** The variables of the target for a shell. Reading a west workspace can fail, which is an error of the call. */
export function groupsFor(target: CommandTarget, shell: ShellChoice): TerminalEnvGroup[] {
  try {
    return target.groups(shell);
  } catch (error) {
    throw toToolError(error);
  }
}

/** Every variable of the groups in one record, later groups winning, as the terminal gets them. */
export function flatEnv(groups: TerminalEnvGroup[]): Record<string, string> {
  return Object.assign({}, ...groups.map(group => group.env)) as Record<string, string>;
}

function envNotReady(message: string): McpToolError {
  // toToolError maps the setting named in `cause` to ENV_NOT_READY and its hint.
  return toToolError(new Error(message, {
    cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}`,
  }));
}

/** The environment script `kind` sources, which must exist: the host tools install writes it. */
export function requireEnvScript(target: CommandTarget, kind: string): string {
  const configured = commandHost.envScriptSetting(target.settingsScope);
  if (!configured) {
    throw envNotReady('The Zephyr environment script is not set (zephyr-workbench.pathToEnvScript).');
  }
  // A portable install stores it under %VSCODE_PORTABLE%, which a shell
  // started elsewhere does not have.
  const script = envScriptFor(kind, expandEnvVariables(configured));
  if (!fs.existsSync(script)) {
    throw envNotReady(`The Zephyr environment script for ${shellOfKind(kind)} does not exist: ${script}.`);
  }
  return script;
}

/** A working folder the agent gave: absolute, an existing folder, and inside the folders of the window. */
export async function checkCwd(services: HostServices, cwd: string): Promise<string> {
  if (!path.isAbsolute(cwd)) {
    throw new McpToolError('INVALID_ARGUMENT', `cwd must be an absolute path, not "${logSafe(cwd, 300)}".`, {
      hint: 'Pass an absolute folder, such as the app_path list_apps returns, or omit cwd for the build folder.',
    });
  }
  const resolved = path.resolve(cwd);
  const roots = await services.knownRoots();
  if (!roots.some(root => isInside(resolved, root))) {
    throw new McpToolError('PATH_OUTSIDE_WORKSPACE', `cwd "${logSafe(cwd, 300)}" is outside every folder this window knows about.`, {
      hint: 'Pass a folder inside an application or west workspace that get_status lists, or omit cwd.',
      details: { allowed: roots },
    });
  }
  let isFolder = false;
  try {
    isFolder = fs.statSync(resolved).isDirectory();
  } catch {
    isFolder = false;
  }
  if (!isFolder) {
    throw new McpToolError('INVALID_ARGUMENT', `cwd "${logSafe(cwd, 300)}" is not an existing folder.`, {
      hint: 'Create the folder first, or omit cwd to run in the build folder or the application root.',
    });
  }
  return resolved;
}
