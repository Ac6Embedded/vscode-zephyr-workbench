// open_in_workbench: show a view, a file or a wizard to the user.
//
// The one tool that opens UI on purpose. Each target opens what the matching
// Zephyr Workbench command opens, for the user to look at or act on, and the
// call returns as soon as it is shown: it never waits for the user. A target
// that cannot open is refused with the reason instead of showing a message,
// and nothing is written on the way, env.yml included. The plot, Puncover and
// West dashboard targets are the exception to "shown and done": they run a
// west build target in a VS Code task the user owns, which holds the build
// folder until it ends.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { westConfigCommandFor } from '../../../commands/WestCommands';
import { WestWorkspace } from '../../../models/WestWorkspace';
import type { ZephyrApplication } from '../../../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../../../models/ZephyrBuildConfig';
import { buildDirectTask } from '../../../providers/ZephyrTaskProvider';
import {
  eclairReportServerCommand, enableEclairExtension, findEclairDatabaseIn, openEclairReportServerTerminal, probeEclair,
} from '../../../utils/eclair/analysis';
import { executeTask, TaskLaunchDeclined } from '../../../utils/execUtils';
import { checkEnvFile, checkHostTools } from '../../../utils/installUtils';
import { getWestWorkspaces } from '../../../utils/utils';
import { refreshGlobalSdkDetection } from '../../../utils/zephyr/globalSdkService';
import { assertInside, isInside } from '../../core/argSafety';
import { McpToolError, toToolError } from '../../core/errors';
import { ToolContext, ToolHandler } from '../../core/toolSpec';
import { OPEN_IN_WORKBENCH_TARGETS } from '../../core/tools/openInWorkbench';
import { isWorking } from '../../jobs/jobManager';
import { findExternalRun } from '../buildConflicts';
import { runnerTools } from '../runnerTools';
import { HostDeps } from './deps';
import { RUNNER_TOOLS_LOCK } from './manageRunners';

type Ctx = ToolContext<HostDeps>;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

const TARGETS = OPEN_IN_WORKBENCH_TARGETS;
type Target = typeof TARGETS[number];

/** The arguments each target takes. */
const TAKES: Record<Target, readonly string[]> = {
  file: ['path', 'line', 'column'],
  dashboard: ['app_path', 'config_name'],
  kconfig_manager: ['app_path', 'config_name'],
  menuconfig: ['app_path', 'config_name'],
  guiconfig: ['app_path', 'config_name'],
  devicetree_manager: ['app_path', 'config_name'],
  west_manager: ['west_workspace', 'app_path'],
  debug_manager: ['app_path', 'config_name'],
  pyocd_manager: ['app_path', 'config_name'],
  install_runners: [],
  eclair_manager: ['app_path'],
  eclair_report: ['app_path', 'config_name'],
  terminal: ['west_workspace', 'app_path', 'config_name'],
  ram_plot: ['app_path', 'config_name'],
  rom_plot: ['app_path', 'config_name'],
  puncover: ['app_path', 'config_name'],
  west_dashboard: ['app_path', 'config_name'],
  add_application: [],
  add_west_workspace: [],
  add_toolchain: [],
};
const ARGUMENTS = ['path', 'line', 'column', 'app_path', 'config_name', 'west_workspace'];

export const DT_MANAGER_EXTENSION = 'Ac6.devicetree-manager-for-zephyr';
const DT_MANAGER_OPEN_COMMAND = 'devicetree-manager-for-zephyr.open';

/** The Zephyr Workbench commands that open the debug and runner pages. */
export const DEBUG_MANAGER_COMMAND = 'zephyr-workbench.debug-manager';
export const PYOCD_MANAGER_COMMAND = 'zephyr-workbench.pyocd-manager';
export const INSTALL_RUNNERS_COMMAND = 'zephyr-workbench.install-runners';

type ServedTarget = 'ram_plot' | 'rom_plot' | 'puncover' | 'west_dashboard';

/**
 * The west build targets served to the user, with the workbench task that
 * runs each: the tasks the memory analysis and West Dashboard commands run.
 */
export const SERVED_TASKS: Record<ServedTarget, { task: string; westTarget: string }> = {
  ram_plot: { task: 'West RAM Plot', westTarget: 'ram_plot' },
  rom_plot: { task: 'West ROM Plot', westTarget: 'rom_plot' },
  puncover: { task: 'West Puncover', westTarget: 'puncover' },
  west_dashboard: { task: 'West Dashboard', westTarget: 'dashboard' },
};

/** How long a view may take to open before the call returns anyway. */
const OPEN_WAIT_MS = 3000;
/** How long a terminal command is watched for a failure to start. */
const START_WATCH_MS = 300;

const sleep = (ms: number) => new Promise<'waiting'>(resolve => setTimeout(() => resolve('waiting'), ms));

/**
 * The panels, loaded when first opened: they pull in the workbench views,
 * which the unit tests of this handler do not have.
 */
const panels = {
  dashboard: () => require('../../../panels/ZephyrDashboardViewProvider') as typeof import('../../../panels/ZephyrDashboardViewProvider'),
  kconfig: () => require('../../../panels/KconfigManagerPanel') as typeof import('../../../panels/KconfigManagerPanel'),
  westManager: () => require('../../../panels/WestManagerPanel') as typeof import('../../../panels/WestManagerPanel'),
  eclair: () => require('../../../panels/EclairManagerPanel') as typeof import('../../../panels/EclairManagerPanel'),
  createApp: () => require('../../../panels/CreateZephyrAppPanel') as typeof import('../../../panels/CreateZephyrAppPanel'),
  createWorkspace: () => require('../../../panels/CreateWestWorkspacePanel') as typeof import('../../../panels/CreateWestWorkspacePanel'),
  importSdk: () => require('../../../panels/ImportZephyrSDKPanel') as typeof import('../../../panels/ImportZephyrSDKPanel'),
};

/**
 * What each target opens, through the functions the Zephyr Workbench commands
 * use. Unit tests, which have no VS Code window, replace them.
 */
export const workbenchViews = {
  file: async (file: string, line?: number, column?: number): Promise<void> => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const at = line ? new vscode.Position(line - 1, (column ?? 1) - 1) : undefined;
    await vscode.window.showTextDocument(document, { preview: false, ...(at ? { selection: new vscode.Range(at, at) } : {}) });
  },
  /** False when the window has no dashboard view. */
  dashboard: async (app: ZephyrApplication, configName: string): Promise<boolean> => {
    const provider = panels.dashboard().ZephyrDashboardViewProvider.current;
    if (!provider) {
      return false;
    }
    await provider.reveal({ project: app }, { configName, pin: true });
    return true;
  },
  kconfigManager: (extensionUri: vscode.Uri, app: ZephyrApplication, config: ZephyrBuildConfig): Promise<void> =>
    panels.kconfig().KconfigManagerPanel.render(extensionUri, app, config),
  /** Resolves when the user closes the tool, which the handler never waits for. */
  westConfig: (app: ZephyrApplication, config: ZephyrBuildConfig, target: 'menuconfig' | 'guiconfig'): Promise<void> =>
    westConfigCommandFor(app, config, target),
  devicetreeManagerInstalled: (): boolean => !!vscode.extensions.getExtension(DT_MANAGER_EXTENSION),
  devicetreeManager: (appRootPath: string, configName: string): Thenable<unknown> =>
    vscode.commands.executeCommand(DT_MANAGER_OPEN_COMMAND, { appRootPath, configName }),
  westManager: (extensionUri: vscode.Uri, workspace: WestWorkspace): void =>
    panels.westManager().WestManagerPanel.render(extensionUri, workspace),
  /** The { project, buildConfig } payload the commands take from the application explorer. */
  debugManager: (app: ZephyrApplication, config: ZephyrBuildConfig): Thenable<unknown> =>
    vscode.commands.executeCommand(DEBUG_MANAGER_COMMAND, { project: app, buildConfig: config }),
  pyocdManager: (target?: { app: ZephyrApplication; config: ZephyrBuildConfig }): Thenable<unknown> => (target
    ? vscode.commands.executeCommand(PYOCD_MANAGER_COMMAND, { project: target.app, buildConfig: target.config })
    : vscode.commands.executeCommand(PYOCD_MANAGER_COMMAND)),
  installRunners: (): Thenable<unknown> => vscode.commands.executeCommand(INSTALL_RUNNERS_COMMAND),
  /**
   * Whether build.ninja in the build folder defines the west build target;
   * undefined without a build.ninja, as with another CMake generator.
   */
  buildHasTarget: (buildDir: string, westTarget: string): boolean | undefined => {
    let ninja: string;
    try {
      ninja = fs.readFileSync(path.join(buildDir, 'build.ninja'), 'utf8');
    } catch {
      return undefined;
    }
    return new RegExp(`^build ${westTarget}: phony`, 'm').test(ninja);
  },
  /** Whether pyOCD has its CMSIS pack index, shared by every venv of the user; undefined when pyocd cannot tell. */
  pyocdPackIndex: (): Promise<boolean | undefined> => runnerTools.pyocd.hasIndex(undefined),
  /**
   * Runs the task of a served target, and resolves when it ends: for Puncover
   * when the user stops its server, for a RAM or ROM plot once the browser has
   * loaded the page. The task is started
   * here rather than through the command: the commands also write tasks.json
   * for Puncover and the West Dashboard, and show notifications.
   */
  serveBuildTarget: async (app: ZephyrApplication, config: ZephyrBuildConfig, target: ServedTarget): Promise<void> => {
    const { task: taskName } = SERVED_TASKS[target];
    const task = buildDirectTask(app.appWorkspaceFolder, taskName, config.name, {}, app);
    if (!task) {
      throw new Error(`Zephyr Workbench has no "${taskName}" task for ${config.name}.`);
    }
    try {
      await executeTask(task);
    } catch (error) {
      // Held back by the launch prompt: the user chose, it is not an error.
      if (!(error instanceof TaskLaunchDeclined)) {
        throw error;
      }
      return;
    }
    if (target === 'west_dashboard') {
      // As the West Dashboard command does once the page is generated; a
      // missing page is left to the task's terminal rather than a notification.
      const page = path.join(config.getBuildDir(app), 'dashboard', 'index.html');
      if (fs.existsSync(page)) {
        await vscode.env.openExternal(vscode.Uri.file(page));
      }
    }
  },
  eclairManager: (extensionUri: vscode.Uri, app: ZephyrApplication): void =>
    panels.eclair().EclairManagerPanel.render(extensionUri, app.appWorkspaceFolder, app.appRootPath),
  /** Starts the report server in a terminal, and turns on the ECLAIR extension when it is installed. */
  eclairReport: async (command: string): Promise<{ terminal: string; extension: string }> => {
    const terminal = openEclairReportServerTerminal(command).name;
    const extension = await Promise.race([
      enableEclairExtension(() => undefined).catch(() => 'failed'),
      sleep(OPEN_WAIT_MS).then(() => 'activating'),
    ]);
    return { terminal, extension };
  },
  appTerminal: (app: ZephyrApplication, config: ZephyrBuildConfig): string => {
    const terminal = ZephyrBuildConfig.getTerminal(app, config);
    terminal.show();
    return terminal.name;
  },
  westWorkspaceTerminal: (workspace: WestWorkspace): string => {
    const terminal = WestWorkspace.getTerminal(workspace);
    terminal.show();
    return terminal.name;
  },
  westWorkspaceCount: (): number => getWestWorkspaces().length,
  hostToolsReady: async (): Promise<boolean> => (await checkHostTools()) && (await checkEnvFile()),
  addApplication: async (extensionUri: vscode.Uri): Promise<void> => {
    // As the command does, so the wizard lists the current global Zephyr SDK.
    await refreshGlobalSdkDetection();
    panels.createApp().CreateZephyrAppPanel.render(extensionUri);
  },
  addWestWorkspace: (extensionUri: vscode.Uri): void => panels.createWorkspace().CreateWestWorkspacePanel.render(extensionUri),
  addToolchain: (extensionUri: vscode.Uri): void => panels.importSdk().ImportZephyrSDKPanel.render(extensionUri),
};

function invalid(message: string, hint?: string): McpToolError {
  return new McpToolError('INVALID_ARGUMENT', message, { hint });
}

/** Refuse arguments the target does not take, before anything is resolved. */
function checkArguments(args: Record<string, unknown>): Target {
  const target = str(args.target) as Target | undefined;
  if (!target || !TARGETS.includes(target)) {
    throw invalid(`target must be one of ${TARGETS.join(', ')}.`);
  }
  for (const key of ARGUMENTS) {
    if (args[key] !== undefined && !TAKES[target].includes(key)) {
      throw invalid(`${key} does not apply to target "${target}".`, `Call open_in_workbench again without ${key}.`);
    }
  }
  for (const key of ['path', 'app_path', 'config_name', 'west_workspace']) {
    if (args[key] !== undefined && typeof args[key] !== 'string') {
      throw invalid(`${key} must be a string.`);
    }
  }
  if (target === 'terminal' && args.west_workspace !== undefined && (args.app_path !== undefined || args.config_name !== undefined)) {
    throw invalid('Pass west_workspace for a west workspace terminal, or app_path and config_name for an application terminal, not both.');
  }
  if (target === 'file') {
    const file = str(args.path);
    if (!file) {
      throw invalid('target "file" needs path, the absolute path of the file to open.');
    }
    if (!path.isAbsolute(file)) {
      throw invalid(`path must be absolute; "${file}" is not.`);
    }
    if (args.column !== undefined && args.line === undefined) {
      throw invalid('column needs line.');
    }
  }
  return target;
}

function extensionUri(ctx: Ctx): vscode.Uri {
  return ctx.deps.extensionContext.extensionUri;
}

/** A missing environment script is the usual reason a Zephyr terminal or task cannot open. */
function environmentError(error: unknown): McpToolError {
  const message = error instanceof Error ? error.message : String(error);
  if (/environment script/i.test(message)) {
    return new McpToolError('ENV_NOT_READY', message.split('\n')[0], {
      hint: 'Call check_environment to see what is missing, then ask the user to fix it.',
    });
  }
  return toToolError(error);
}

// -- targets ------------------------------------------------------------------------

async function openFile(ctx: Ctx, args: Record<string, unknown>) {
  const file = str(args.path) as string;
  const roots = await ctx.deps.services.knownRoots();
  assertInside(file, roots, 'path');
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    throw invalid(`"${file}" does not exist.`);
  }
  // A link inside the window must not open a file outside it.
  const realRoots = roots.map(root => {
    try {
      return fs.realpathSync(root);
    } catch {
      return root;
    }
  });
  assertInside(real, realRoots, 'path');
  if (!fs.statSync(real).isFile()) {
    throw invalid(`"${file}" is not a file.`);
  }
  const line = num(args.line);
  const column = num(args.column);
  await workbenchViews.file(file, line, column);
  return { opened: 'file', path: file, ...(line ? { line } : {}), ...(column ? { column } : {}) };
}

/**
 * Refuse while an agent job or a VS Code task works in the build folder. The
 * Kconfig tools configure a build folder that is not configured yet and rewrite
 * .config, so they wait for whatever uses the folder.
 */
function assertBuildFolderFree(ctx: Ctx, app: ZephyrApplication, config: ZephyrBuildConfig, buildDir: string): void {
  const running = ctx.deps.jobs.runningOverlapping(buildDir)[0];
  if (running) {
    throw new McpToolError('BUSY', `A ${running.spec.kind} job is working in "${running.spec.buildDir}" (job_id "${running.id}").`, {
      hint: `Wait for it with job {"action": "status", "job_id": "${running.id}"}, then call open_in_workbench again.`,
      details: { job_id: running.id, kind: running.spec.kind },
    });
  }
  // A task started meanwhile would meet the launch prompt that asks the user
  // to wait for the agent, so the agent is told instead.
  const root = app.westWorkspaceRootPath;
  const westWork = root ? ctx.deps.jobs.list().find(job => {
    const used = job.spec.westWorkspace;
    return isWorking(job) && !!used && (job.spec.writes ?? []).includes('west_workspace')
      && (isInside(root, used) || isInside(used, root));
  }) : undefined;
  if (westWork) {
    throw new McpToolError('BUSY', `A ${westWork.spec.kind} job is changing the west workspace "${westWork.spec.westWorkspace}" (job_id "${westWork.id}").`, {
      hint: `Wait for it with job {"action": "status", "job_id": "${westWork.id}"}, then call open_in_workbench again.`,
      details: { job_id: westWork.id, kind: westWork.spec.kind },
    });
  }
  const external = findExternalRun(app.appRootPath, config.name);
  if (external) {
    throw new McpToolError('BUSY_EXTERNAL', `"${external.task.name}" is running for ${config.name}, started from VS Code.`, {
      hint: 'Wait for it to finish in its terminal, or for a server such as Puncover ask the user to stop it there, then retry.',
    });
  }
}

/** The Debug Manager, with the application and configuration selected. */
async function openDebugManager(ctx: Ctx, args: Record<string, unknown>) {
  const { app, config } = await ctx.deps.services.resolveTarget(str(args.app_path), str(args.config_name));
  // The panel reads the board and runners from the build, and without one it
  // runs a CMake configure into <app>/.tmp as soon as it loads.
  if (!ctx.deps.services.isBuilt(app, config)) {
    throw new McpToolError('NOT_BUILT', `${config.name} has not been built, and the Debug Manager reads its board and runners from the build.`, {
      hint: `Call build_app with config_name "${config.name}" first, then open the Debug Manager.`,
    });
  }
  await showPanel('The Debug Manager', workbenchViews.debugManager(app, config));
  return {
    opened: 'debug_manager', app_path: app.appRootPath, config_name: config.name,
    note: 'The user sets up the debug configuration there, and Apply writes it to launch.json.',
  };
}

/** The pyOCD Manager, showing the target of a build when one is named. */
async function openPyocdManager(ctx: Ctx, args: Record<string, unknown>) {
  if (args.app_path === undefined && args.config_name === undefined) {
    await showPanel('The pyOCD Manager', workbenchViews.pyocdManager());
    return { opened: 'pyocd_manager' };
  }
  const { app, config } = await ctx.deps.services.resolveTarget(str(args.app_path), str(args.config_name));
  // With a build the panel looks up the pack of the board target with pyocd,
  // which writes the pack cache a runner job may be writing, and downloads
  // the whole pack index when it is missing: manage_runners asks first.
  const running = ctx.deps.jobs.list().find(job => isWorking(job) && job.spec.lockKey === RUNNER_TOOLS_LOCK);
  if (running) {
    throw new McpToolError('BUSY', `A runner job is running in this window (job_id "${running.id}"): ${running.spec.command}.`, {
      hint: `Wait for it with job {"action": "status", "job_id": "${running.id}"}, then call open_in_workbench again.`,
      details: { job_id: running.id, kind: running.spec.kind },
    });
  }
  if (await workbenchViews.pyocdPackIndex() === false) {
    throw new McpToolError('DEPENDENCY_MISSING', `pyOCD has no CMSIS pack index yet, and the pyOCD Manager of ${config.name} would download it to find the pack of the board target.`, {
      hint: 'Call manage_runners with action "pyocd_update_index" first, which asks the user, then retry; or open the pyOCD Manager without app_path and config_name.',
    });
  }
  await showPanel('The pyOCD Manager', workbenchViews.pyocdManager({ app, config }));
  return { opened: 'pyocd_manager', app_path: app.appRootPath, config_name: config.name };
}

/** A command's panel opens at once; a slow one is left opening rather than waited for. */
async function showPanel(what: string, opening: Thenable<unknown>): Promise<void> {
  try {
    await Promise.race([Promise.resolve(opening), sleep(OPEN_WAIT_MS)]);
  } catch (error) {
    throw new McpToolError('INTERNAL', `${what} did not open: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * ram_plot, rom_plot, puncover or west_dashboard: west build -t <target> in a
 * task of the user, refused up front wherever the task or the command would
 * show a message instead.
 */
async function openServedTarget(ctx: Ctx, args: Record<string, unknown>, target: ServedTarget) {
  const { services } = ctx.deps;
  const { app, config, buildDir } = await services.resolveTarget(str(args.app_path), str(args.config_name));
  const { task, westTarget } = SERVED_TASKS[target];
  if (!config.boardIdentifier) {
    throw invalid(`${config.name} has no board.`, 'Set one with configure, then retry.');
  }
  const plot = target === 'ram_plot' || target === 'rom_plot';
  const reportHint = `Call get_memory_report with config_name "${config.name}" for ${plot ? 'the same' : 'the memory'} breakdown; domain picks the image.`;
  // The task provider warns and runs nothing for the plots on a sysbuild
  // build, and the top-level sysbuild folder defines none of these targets.
  if (String(config.sysbuild).toLowerCase() === 'true') {
    throw new McpToolError('SYSBUILD_UNSUPPORTED', `west build -t ${westTarget} does not run on ${config.name}, which uses sysbuild: its top-level build folder has no ${westTarget} target.`, {
      hint: reportHint,
    });
  }
  if (!services.isBuilt(app, config)) {
    throw new McpToolError('NOT_BUILT', `${target} needs a completed build of ${config.name}, and "${buildDir}" has none.`, {
      hint: `Call build_app with config_name "${config.name}" first, then retry.`,
    });
  }
  // Ninja fails on an unknown target long after the call has returned.
  if (workbenchViews.buildHasTarget(buildDir, westTarget) === false) {
    if (target === 'puncover') {
      throw new McpToolError('DEPENDENCY_MISSING', `The build of ${config.name} has no puncover target: CMake did not find puncover when it configured the build.`, {
        hint: `Ask the user to install puncover in the Zephyr Python environment (pip install puncover), then call build_app with config_name "${config.name}" and pristine "always" so CMake finds it, then retry.`,
      });
    }
    throw invalid(`The build of ${config.name} has no ${westTarget} target: this Zephyr version predates it (the RAM and ROM plots need Zephyr 4.3 or later, the West dashboard 4.4 or later).`,
      plot ? reportHint : `Call get_build_info or get_memory_report with config_name "${config.name}" instead.`);
  }
  assertBuildFolderFree(ctx, app, config, buildDir);
  const run = workbenchViews.serveBuildTarget(app, config, target);
  // The task runs until it ends or the user stops it; only a failure to start is reported.
  run.catch(() => undefined);
  try {
    await Promise.race([run, sleep(START_WATCH_MS)]);
  } catch (error) {
    throw environmentError(error);
  }
  const busy = `While it runs, build_app answers BUSY_EXTERNAL for ${config.name}`;
  return {
    opened: target,
    app_path: app.appRootPath,
    config_name: config.name,
    task,
    // The plots serve one page load and end; only Puncover keeps its server.
    note: target === 'west_dashboard'
      ? `"${task}" runs west build -t ${westTarget} in a VS Code terminal, then opens the dashboard in the user's browser. ${busy}.`
      : plot
        ? `"${task}" runs west build -t ${westTarget} in a VS Code terminal, which builds the report, opens it in the user's browser and then ends. ${busy}.`
        : `"${task}" runs west build -t ${westTarget} in a VS Code terminal and keeps a server running there for the user's browser. ${busy}, until the user stops the task in its terminal.`,
  };
}

/** menuconfig or guiconfig in a terminal of the user, for the configuration asked for. */
async function openConfigTool(ctx: Ctx, args: Record<string, unknown>, target: 'menuconfig' | 'guiconfig') {
  const { app, config, buildDir } = await ctx.deps.services.resolveTarget(str(args.app_path), str(args.config_name));
  if (!config.boardIdentifier) {
    throw invalid(`${config.name} has no board.`, 'Set one with configure, then retry.');
  }
  assertBuildFolderFree(ctx, app, config, buildDir);
  const run = workbenchViews.westConfig(app, config, target);
  // The tool runs until the user closes it; only a failure to start is reported.
  run.catch(() => undefined);
  try {
    await Promise.race([run, sleep(START_WATCH_MS)]);
  } catch (error) {
    throw environmentError(error);
  }
  return {
    opened: target,
    app_path: app.appRootPath,
    config_name: config.name,
    note: `${target} runs in a VS Code terminal for the user. What they save there is a temporary change the next build may discard: after they save, call set_kconfig with persist_temporary true to keep it in prj.conf.`,
  };
}

async function openEclairManager(ctx: Ctx, args: Record<string, unknown>) {
  const app = await ctx.deps.services.resolveApp(str(args.app_path));
  const probe = probeEclair();
  if (!probe.dir) {
    throw new McpToolError('DEPENDENCY_MISSING', 'ECLAIR is not installed on this machine, so the ECLAIR Manager has nothing to run.', {
      hint: 'ECLAIR is a licensed BUGSENG tool. Ask the user to install it and open the ECLAIR Manager from Zephyr Workbench themselves.',
    });
  }
  if (!probe.envYmlHasPath) {
    // Opening the panel would record the ECLAIR folder in env.yml, which is host tool setup.
    throw new McpToolError('ENV_NOT_READY', `ECLAIR is installed in ${probe.dir}, but Zephyr Workbench has not recorded its folder yet, and opening the ECLAIR Manager would record it.`, {
      hint: 'Ask the user to open the ECLAIR Manager from Zephyr Workbench once; after that this target opens it.',
      details: { eclair_dir: probe.dir },
    });
  }
  workbenchViews.eclairManager(extensionUri(ctx), app);
  return { opened: 'eclair_manager', app_path: app.appRootPath, eclair_dir: probe.dir };
}

async function openEclairReport(ctx: Ctx, args: Record<string, unknown>) {
  const { app, config, buildDir } = await ctx.deps.services.resolveTarget(str(args.app_path), str(args.config_name));
  const probe = probeEclair();
  if (!probe.dir || !probe.eclairReport) {
    throw new McpToolError('DEPENDENCY_MISSING', probe.dir
      ? `The ECLAIR folder ${probe.dir} has no eclair_report, which serves the reports.`
      : 'ECLAIR is not installed on this machine: env.yml records no ECLAIR folder and eclair is not on PATH.', {
      hint: 'ECLAIR is a licensed BUGSENG tool. Ask the user to install it; read the findings with get_diagnostics source "sca" meanwhile.',
    });
  }
  const database = findEclairDatabaseIn(buildDir);
  if (!database) {
    throw new McpToolError('NOT_BUILT', `${config.name} has no ECLAIR database (sca/eclair/PROJECT.ecd) yet.`, {
      hint: 'Call analyze with analysis "eclair" first, then retry.',
    });
  }
  const { terminal, extension } = await workbenchViews.eclairReport(eclairReportServerCommand(probe.dir, database));
  return {
    opened: 'eclair_report',
    app_path: app.appRootPath,
    config_name: config.name,
    database,
    terminal,
    eclair_extension: extension,
    note: 'The report server opens the reports in the user\'s browser.',
  };
}

async function openTerminal(ctx: Ctx, args: Record<string, unknown>) {
  const { services } = ctx.deps;
  const root = str(args.west_workspace);
  try {
    if (root) {
      const { workspace } = await services.resolveWestWorkspace(root);
      return { opened: 'terminal', west_workspace: workspace.rootUri.fsPath, terminal: workbenchViews.westWorkspaceTerminal(workspace) };
    }
    const { app, config } = await services.resolveTarget(str(args.app_path), str(args.config_name));
    return { opened: 'terminal', app_path: app.appRootPath, config_name: config.name, terminal: workbenchViews.appTerminal(app, config) };
  } catch (error) {
    throw error instanceof McpToolError ? error : environmentError(error);
  }
}

async function assertHostTools(what: string): Promise<void> {
  if (!await workbenchViews.hostToolsReady()) {
    throw new McpToolError('ENV_NOT_READY', `The Zephyr host tools are not installed, and the ${what} wizard needs them.`, {
      hint: 'Call check_environment to see what is missing, then ask the user to install the host tools.',
    });
  }
}

// -- the tool -----------------------------------------------------------------------

export const openInWorkbench: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const { services } = ctx.deps;
  const target = checkArguments(args);

  switch (target) {
    case 'file':
      return openFile(ctx, args);

    case 'dashboard': {
      const { app, config } = await services.resolveTarget(str(args.app_path), str(args.config_name));
      if (!await workbenchViews.dashboard(app, config.name)) {
        throw new McpToolError('INTERNAL', 'The Workbench dashboard is not available in this VS Code window.');
      }
      return {
        opened: 'dashboard', app_path: app.appRootPath, config_name: config.name,
        note: 'The dashboard shows this configuration until the user switches editors.',
      };
    }

    case 'kconfig_manager': {
      const { app, config, buildDir } = await services.resolveTarget(str(args.app_path), str(args.config_name));
      // The panel configures a build folder that is not configured yet, outside any job.
      assertBuildFolderFree(ctx, app, config, buildDir);
      await workbenchViews.kconfigManager(extensionUri(ctx), app, config);
      return {
        opened: 'kconfig_manager', app_path: app.appRootPath, config_name: config.name,
        note: 'Changes the user makes there stay temporary until they export them; call set_kconfig with persist_temporary true to save them for the user.',
      };
    }

    case 'menuconfig':
    case 'guiconfig':
      return openConfigTool(ctx, args, target);

    case 'devicetree_manager': {
      if (!workbenchViews.devicetreeManagerInstalled()) {
        throw new McpToolError('DEPENDENCY_MISSING', 'The Devicetree Manager for Zephyr extension is not installed.', {
          hint: `Ask the user to install the "Devicetree Manager for Zephyr" extension (${DT_MANAGER_EXTENSION}) from the VS Code Marketplace, then retry.`,
        });
      }
      const { app, config } = await services.resolveTarget(str(args.app_path), str(args.config_name));
      try {
        await Promise.race([workbenchViews.devicetreeManager(app.appRootPath, config.name), sleep(OPEN_WAIT_MS)]);
      } catch (error) {
        throw new McpToolError('INTERNAL', `The Devicetree Manager did not open: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { opened: 'devicetree_manager', app_path: app.appRootPath, config_name: config.name };
    }

    case 'west_manager': {
      const { workspace } = await services.resolveWestWorkspace(str(args.west_workspace), str(args.app_path));
      workbenchViews.westManager(extensionUri(ctx), workspace);
      return { opened: 'west_manager', west_workspace: workspace.rootUri.fsPath };
    }

    case 'debug_manager':
      return openDebugManager(ctx, args);

    case 'pyocd_manager':
      return openPyocdManager(ctx, args);

    case 'install_runners':
      await showPanel('The Install Runners page', workbenchViews.installRunners());
      return { opened: 'install_runners' };

    case 'eclair_manager':
      return openEclairManager(ctx, args);

    case 'eclair_report':
      return openEclairReport(ctx, args);

    case 'terminal':
      return openTerminal(ctx, args);

    case 'ram_plot':
    case 'rom_plot':
    case 'puncover':
    case 'west_dashboard':
      return openServedTarget(ctx, args, target);

    case 'add_application':
      if (workbenchViews.westWorkspaceCount() === 0) {
        throw invalid('No west workspace is registered, and the Add Application wizard needs one.',
          'Call open_in_workbench with target "add_west_workspace" so the user creates one first.');
      }
      await workbenchViews.addApplication(extensionUri(ctx));
      return { opened: 'add_application' };

    case 'add_west_workspace':
      await assertHostTools('Add West Workspace');
      workbenchViews.addWestWorkspace(extensionUri(ctx));
      return { opened: 'add_west_workspace' };

    case 'add_toolchain':
      await assertHostTools('Add Toolchain');
      workbenchViews.addToolchain(extensionUri(ctx));
      return { opened: 'add_toolchain' };
  }
};
