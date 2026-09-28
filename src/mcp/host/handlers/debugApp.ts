// debug_app: start, drive and read a debug session of a build configuration,
// in the VS Code debugger the user watches. start launches the entry
// configure_debug writes (making it with the Debug Manager defaults when it
// is missing) as the Debug button of the Debug Manager does, after asking the
// user; the other actions work on a running Workbench session, including one
// the user started. Each action accepts only its own arguments, so a
// misplaced one is refused instead of silently ignored.

import * as vscode from 'vscode';
import { CORTEX_DEBUG_EXTENSION_ID } from '../../../debug/backends/cortexDebugExtension';
import { serverOutputTail } from '../../../debug/backends/serverRegistry';
import {
  backendOfEntry, debugEntryFields, DebugEntryInfo, defaultDebugDomain, findApplicationDebugEntry, LaunchJsonFile,
  listApplicationDebugEntries, readLaunchJsonFile,
} from '../../../debug/debugSetup';
import {
  debugSessionsFor, outputTail, TrackedDebugSession, waitForNewWorkbenchSession, waitForStop, workbenchDebugSessions,
} from '../../../debug/sessionTracker';
import { ZephyrApplication } from '../../../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../../../models/ZephyrBuildConfig';
import { getDebugLaunchConfigurationName } from '../../../utils/debugTools/debugUtils';
import { setSelectedWorkspaceApplicationPath } from '../../../utils/zephyr/workspaceApplications';
import { normalizeForCompare } from '../../core/argSafety';
import { McpToolError, toToolError } from '../../core/errors';
import { logSafe } from '../../core/redact';
import { CONFIGURE_DEBUG } from '../../core/tools/configureDebug';
import { DEBUG_APP_ACTIONS, DebugAppAction } from '../../core/tools/debugApp';
import { confirmCategoryOf, ToolHandler } from '../../core/toolSpec';
import { writesOf } from '../../jobs/jobConflicts';
import { isWorking } from '../../jobs/jobManager';
import { Confirmations, ConfirmOutcome, ConfirmSubject, fitsDialogLine } from '../confirmations';
import { configureDebug, staleEntryRemoval } from './configureDebug';
import { baseBoard } from './hardwareFlash';
import {
  agentBreakpointCount, breakpoint, ensureBreakpointCleanup, keepAgentBreakpointsOnEnd, removeAgentBreakpoints,
} from './debugAppBreakpoints';
import {
  appOfSession, assertAlive, boolArg, Ctx, invalid, messageOf, nextFor, resolveSession, sessionIdOf, sessionOut, str, stringArgs,
  waitSecOf,
} from './debugAppSession';
import { control, gdb, inspect } from './debugAppTarget';
import { HostDeps } from './deps';
import { remainingWaitMs } from './progress';

/** The C/C++ extension, whose cppdbg adapter the default backend runs on. */
export const CPPTOOLS_EXTENSION_ID = 'ms-vscode.cpptools';

/**
 * What start reaches outside the session tracker, replaced by the tests:
 * selecting the application of a west workspace before its launch, and the
 * least time start waits for the session to appear, even with a short wait_sec.
 */
export const debugLaunchHost = {
  selectApplication: setSelectedWorkspaceApplicationPath,
  minSessionWaitMs: 10000,
  /** How long stop waits for the session to end. */
  stopWaitMs: 10000,
  /** How long the cortex-debug session of the cortex-west backend may take to show once its launch returned. */
  cortexWestGraceMs: 1500,
};

const CORTEX_WEST_NOT_STARTED = 'the cortex-west backend did not start its Cortex-Debug session: the gdb server did not become ready, '
  + 'its port was busy, the start was cancelled, or Cortex-Debug refused it. The "Zephyr Workbench: Debug Server" output shows what the server printed.';

function confirmationOf(ctx: Ctx, outcome: ConfirmOutcome | undefined) {
  return outcome === undefined || outcome === 'not-required' || outcome === 'not-asked'
    ? undefined
    : { category: ctx.audit.confirmCategory, outcome };
}

function readLaunchJsonOrThrow(app: ZephyrApplication): LaunchJsonFile {
  const file = readLaunchJsonFile(app);
  if (file.unreadable) {
    throw new McpToolError('INTERNAL', `${file.path} is not valid JSON, so its debug configurations cannot be read.`, {
      hint: 'Ask the user to fix or remove that file in VS Code, then retry.',
      details: { launch_json: file.path },
    });
  }
  return file;
}

function entriesOf(app: ZephyrApplication): DebugEntryInfo[] {
  const file = readLaunchJsonOrThrow(app);
  return file.launchJson ? listApplicationDebugEntries(app, file.launchJson) : [];
}

interface StartTarget {
  app: ZephyrApplication;
  config: ZephyrBuildConfig;
  domain?: string;
  /** The domain the agent passed, which the entry creation takes as it is. */
  domainArg?: string;
  entryName: string;
  info?: DebugEntryInfo;
  /** The legacy freestanding-style name of the launch.json entry, launched under entryName instead. */
  legacyName?: string;
}

/**
 * A west workspace application's legacy entry, named as a freestanding one,
 * launches under the application's own name, as the Debug Manager renames it:
 * the session then carries the application's path, so every tool finds it.
 */
function withCanonicalName(target: StartTarget): StartTarget {
  if (target.info?.legacy !== 'freestanding-name') {
    return target;
  }
  return { ...target, entryName: getDebugLaunchConfigurationName(target.app, target.config.name, target.domain), legacyName: target.info.name };
}

/** The entry start launches: by its name, or the one of app_path, config_name and domain. */
async function startTarget(ctx: Ctx, args: Record<string, unknown>): Promise<StartTarget> {
  const { services } = ctx.deps;
  const name = str(args.name);
  if (name !== undefined) {
    if (args.config_name !== undefined || args.domain !== undefined) {
      throw invalid('Pass name, or config_name and domain, not both.', 'name already says which build configuration and domain the entry is for.');
    }
    // Without app_path, the name picks among the applications of the window.
    const apps = args.app_path !== undefined ? [await services.resolveApp(str(args.app_path))] : await services.listApplications();
    const matches: { app: ZephyrApplication; info: DebugEntryInfo }[] = [];
    const names: string[] = [];
    for (const app of apps) {
      const entries = entriesOf(app);
      names.push(...entries.map(entry => entry.name));
      const info = entries.find(entry => entry.name === name);
      if (info) {
        matches.push({ app, info });
      }
    }
    if (matches.length === 0) {
      throw invalid(`No Workbench debug configuration is named "${logSafe(name, 200)}".`,
        'Use one of the names in details, as configure_debug with action "list" returns them, or pass app_path and config_name.',
        { names: [...new Set(names)] });
    }
    if (matches.length > 1) {
      throw new McpToolError('AMBIGUOUS_APP', `Several applications have a debug configuration named "${name}".`, {
        hint: 'Pass app_path too, one of details.candidates.',
        details: { candidates: matches.map(match => match.app.appRootPath) },
      });
    }
    const { app, info } = matches[0];
    const config = info.configName ? app.getBuildConfiguration(info.configName) : undefined;
    if (!config) {
      throw new McpToolError('CONFIG_NOT_FOUND', `The debug configuration "${name}" belongs to a build configuration that no longer exists.`, {
        hint: `${staleEntryRemoval(ctx, 'it').replace(/^./, c => c.toUpperCase())}, then call configure_debug with action "apply" for an existing build configuration.`,
      });
    }
    return withCanonicalName({ app, config, ...(info.domain ? { domain: info.domain } : {}), entryName: info.name, info });
  }
  const app = await services.resolveApp(str(args.app_path));
  const config = services.resolveConfig(app, str(args.config_name));
  const domainArg = str(args.domain) !== undefined ? services.resolveDomain(app, config, str(args.domain)) : undefined;
  // As the Debug button: a sysbuild build debugs its default domain.
  const domain = domainArg ?? defaultDebugDomain(app, config);
  const info = findApplicationDebugEntry(app, entriesOf(app), config, domain);
  return withCanonicalName({
    app, config, ...(domain ? { domain } : {}), ...(domainArg ? { domainArg } : {}),
    entryName: info?.name ?? getDebugLaunchConfigurationName(app, config.name, domain), ...(info ? { info } : {}),
  });
}

/** A configure_debug apply call made on start's behalf, never asking: start's own dialog covers it. */
async function applyDefaults(ctx: Ctx, target: StartTarget, dryRun: boolean): Promise<{ entry: any; warnings: string[] }> {
  const noAsk = { require: async () => 'not-required' as const } as unknown as Confirmations;
  const deps: HostDeps = dryRun ? ctx.deps : { ...ctx.deps, confirmations: noAsk };
  const applyArgs = {
    action: 'apply', app_path: target.app.appRootPath, config_name: target.config.name,
    ...(target.domainArg ? { domain: target.domainArg } : {}),
    ...(dryRun ? { dry_run: true } : {}),
  };
  try {
    const result = await configureDebug(applyArgs, { ...ctx, deps, tool: CONFIGURE_DEBUG, audit: {} }) as { entry: any; warnings?: string[] };
    return { entry: result.entry, warnings: result.warnings ?? [] };
  } catch (error) {
    const cause = toToolError(error);
    throw new McpToolError(cause.code, `"${target.config.name}" has no debug configuration, and the Debug Manager defaults cannot make one: ${cause.message}`, {
      hint: `Call configure_debug with action "apply" and config_name "${target.config.name}", with the arguments this error asks for${cause.hint ? ` (${cause.hint})` : ''}, then start again.`,
      ...(cause.details ? { details: cause.details } : {}),
    });
  }
}

/** The adapter extension the entry's backend runs on must be there, or VS Code says so in a notification. */
function assertAdapterInstalled(backend: string): void {
  const id = backend === 'cppdbg' ? CPPTOOLS_EXTENSION_ID : CORTEX_DEBUG_EXTENSION_ID;
  if (vscode.extensions.getExtension(id)) {
    return;
  }
  const label = backend === 'cppdbg' ? 'C/C++ extension' : 'Cortex-Debug extension';
  throw new McpToolError('DEPENDENCY_MISSING', `The ${backend} backend of this debug configuration needs the ${label} (${id}), which is not installed or is disabled.`, {
    hint: `Ask the user to install the ${label} (${id}) in VS Code${backend === 'cppdbg' ? '' : ', or call configure_debug with action "apply" and backend "cppdbg"'}, then start again.`,
  });
}

/**
 * Everything that would fight the session for the probe or the build folder.
 * A flash of another application counts when it is on the same board, as
 * flash counts a debug session: the board of a flash not found is unknown,
 * and refuses too.
 */
async function assertNotBusy(ctx: Ctx, app: ZephyrApplication, config: ZephyrBuildConfig, buildDir: string): Promise<void> {
  const { jobs, services } = ctx.deps;
  const root = normalizeForCompare(app.appRootPath);
  const flashes = jobs.list().filter(job => isWorking(job) && job.spec.kind === 'flash');
  let apps: ZephyrApplication[] = [];
  if (flashes.length > 0) {
    try {
      apps = await services.listApplications();
    } catch {
      // Every flash of another application is then on an unknown board.
    }
  }
  const board = baseBoard(config.boardIdentifier);
  const boardOf = (appPath: string | undefined, configName: string | undefined) => {
    const owner = appPath !== undefined ? apps.find(candidate => normalizeForCompare(candidate.appRootPath) === normalizeForCompare(appPath)) : undefined;
    return baseBoard(owner?.buildConfigs.find(candidate => candidate.name === configName)?.boardIdentifier);
  };
  const own = (appPath: string | undefined) => appPath !== undefined && normalizeForCompare(appPath) === root;
  const flashing = flashes.find(job => own(job.spec.appPath))
    ?? flashes.find(job => {
      const theirs = boardOf(job.spec.appPath, job.spec.configName);
      return theirs === undefined || board === undefined || theirs === board;
    });
  if (flashing) {
    const known = board !== undefined && boardOf(flashing.spec.appPath, flashing.spec.configName) !== undefined;
    const whose = own(flashing.spec.appPath) ? 'this application'
      : `${flashing.spec.configName ?? 'a configuration'} of another application ${known ? 'on the same board' : 'on a board that may be this one'}`;
    throw new McpToolError('BUSY', `A flash of ${whose} is running (job_id "${flashing.id}"), and it holds the probe.`, {
      hint: `Wait for it with job {"action": "status", "job_id": "${flashing.id}"}, then start again.`,
      details: { job_id: flashing.id, kind: flashing.spec.kind, ...(flashing.spec.appPath ? { app_path: flashing.spec.appPath } : {}) },
    });
  }
  // The launch builds first when the program is out of date, in the same
  // folder, so any job that writes it is in the way: a build, a deletion, a
  // flash that rebuilds or a command that builds.
  const building = jobs.runningOverlapping(buildDir).find(job => writesOf(job.spec).has('build_dir'));
  if (building) {
    throw new McpToolError('BUSY', `A ${building.spec.kind} job works in the build folder of ${config.name} (job_id "${building.id}").`, {
      hint: `Wait for it with job {"action": "status", "job_id": "${building.id}"}, then start again.`,
      details: { job_id: building.id, kind: building.spec.kind },
    });
  }
  const external = services.externalRun(app.appRootPath, config.name);
  if (external) {
    throw new McpToolError('BUSY_EXTERNAL', `"${external.task.name}" is running for ${config.name}, started from VS Code.`, {
      hint: 'Wait for it to finish in its terminal, then start again.',
    });
  }
}

/** What the gdb server runs, as the dialog shows it. */
function serverCommandOf(entry: any): string | undefined {
  if (typeof entry?.debugServerArgs === 'string' && entry.debugServerArgs.trim().length > 0) {
    const program = typeof entry.debugServerPath === 'string' && entry.debugServerPath.length > 0 ? entry.debugServerPath : 'west';
    return `${program} ${entry.debugServerArgs}`;
  }
  if (entry?.type === 'cortex-debug' && typeof entry.servertype === 'string') {
    const serverArgs = Array.isArray(entry.serverArgs) ? entry.serverArgs.map(String) : typeof entry.serverArgs === 'string' ? [entry.serverArgs] : [];
    return [`${entry.servertype} server`, typeof entry.serverpath === 'string' ? entry.serverpath : '', ...serverArgs].filter(part => part.length > 0).join(' ');
  }
  return undefined;
}

/**
 * A session started from a legacy entry of a west workspace carries no
 * application path, and debugs the selected application of the workspace:
 * for another application it is no session of this one, but it may hold
 * the probe, so start refuses rather than report it as already running.
 */
async function assertSessionOfApp(ctx: Ctx, app: ZephyrApplication, running: TrackedDebugSession): Promise<void> {
  if (!app.isWestWorkspaceApplication || running.appRelPath !== undefined) {
    return;
  }
  const owner = await appOfSession(ctx, running);
  if (owner && normalizeForCompare(owner.appRootPath) === normalizeForCompare(app.appRootPath)) {
    return;
  }
  const sessionId = sessionIdOf(ctx, running);
  throw new McpToolError('BUSY', `A session started from the legacy entry "${running.name}" debugs ${owner ? owner.appName : 'the selected application of the west workspace'}, not this application; stop it first.`, {
    hint: `Stop it with debug_app ${JSON.stringify({ action: 'stop', session_id: sessionId })}, then start again.`,
    details: { session_id: sessionId, name: running.name, ...(owner ? { app_path: owner.appRootPath } : {}) },
  });
}

async function alreadyRunning(ctx: Ctx, target: StartTarget, running: TrackedDebugSession, confirmation?: ReturnType<typeof confirmationOf>) {
  return {
    action: 'start',
    ...(await sessionOut(ctx, running, { app: target.app })),
    already_running: true,
    created_entry: false,
    ...(confirmation ? { confirmation } : {}),
    next: `This session was already running, so nothing was started. ${nextFor(ctx, running)}`,
  };
}

// start

async function start(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  const { services, confirmations, defaultWaitSeconds } = ctx.deps;
  stringArgs(args, ['app_path', 'config_name', 'domain', 'name']);
  const waitForFirstStop = boolArg(args, 'wait_for_stop') ?? true;
  const waitSec = waitSecOf(args, defaultWaitSeconds);
  const target = await startTarget(ctx, args);
  const { app, config, entryName, legacyName } = target;
  const buildDir = config.getBuildDir(app);
  ctx.audit.target = { app_path: app.appRootPath, config_name: config.name };

  // A session the user started from the legacy entry itself is this one too.
  const runningNow = () => debugSessionsFor(app, config.name)
    .find(tracked => (tracked.name === entryName || tracked.name === legacyName) && tracked.state !== 'terminated');
  const running = runningNow();
  if (running) {
    await assertSessionOfApp(ctx, app, running);
    return alreadyRunning(ctx, target, running);
  }
  if (!services.isConfigured(buildDir)) {
    throw new McpToolError('NOT_BUILT', `"${config.name}" has never been built, so there is nothing to debug in "${buildDir}".`, {
      hint: `Call build_app with config_name "${config.name}" first, then start again.`,
    });
  }

  // A missing entry is made with the Debug Manager defaults, planned now so
  // the dialog shows what will run, and written only once the user agreed.
  const planned = target.info ? undefined : await applyDefaults(ctx, target, true);
  const entry = target.info?.entry ?? planned?.entry;
  const backend = backendOfEntry(entry) ?? 'cppdbg';
  assertAdapterInstalled(backend);
  await assertNotBusy(ctx, app, config, buildDir);

  const fields = debugEntryFields(entry);
  const runner = typeof fields.runner === 'string' ? fields.runner : undefined;
  const attach = fields.mode === 'attach';
  const gdbPath = typeof fields.gdb_path === 'string' && fields.gdb_path.length > 0 ? fields.gdb_path : undefined;
  const server = serverCommandOf(entry);
  const board = config.boardIdentifier || config.name;
  ctx.audit.target = { app_path: app.appRootPath, config_name: config.name, ...(runner ? { runner } : {}) };
  // The gdb and the server command are shown in the dialog, so the user
  // approves exactly what runs, and are part of the subject, so an answer
  // given late covers only this launch.
  const subject: ConfirmSubject & { mode: string } = {
    summary: `start debugging "${entryName}" on the board ${board} with ${runner ?? backend} (${attach ? 'attaches without flashing' : 'flashes the board first'})`
      + `${planned ? ', after writing its debug configuration with the Debug Manager defaults' : ''}`,
    appPath: app.appRootPath,
    configName: config.name,
    ...(config.boardIdentifier ? { board: config.boardIdentifier } : {}),
    ...(runner ? { runner } : {}),
    scope: `debug:${normalizeForCompare(app.appRootPath)}`,
    sessionText: 'starting debug sessions of this application',
    lines: [
      ...(legacyName ? [`launch.json entry: "${legacyName}", launched as "${entryName}"`] : []),
      ...(gdbPath ? [`gdb: ${gdbPath}`] : []),
      ...(server ? [`gdb server: ${server}`] : []),
    ],
    mode: attach ? 'attach' : 'program',
  };
  // The dialog cuts a longer line, and the user must never approve a part they could not read.
  const asked = !!confirmCategoryOf(ctx.tool, args) && ctx.deps.permissionOf(ctx.tool) === 'ask';
  const cut = asked ? subject.lines?.find(line => !fitsDialogLine(line)) : undefined;
  if (cut) {
    throw invalid(`The confirmation dialog cannot show the whole "${cut.slice(0, cut.indexOf(':'))}" line of "${entryName}", so it cannot be approved.`,
      `Shorten the runner arguments with configure_debug action "apply" and runner_args for "${config.name}", or ask the user to start it from the Debug Manager.`);
  }
  const outcome = await confirmations.require(ctx, args, subject);
  const confirmation = confirmationOf(ctx, outcome);

  // Read again: the dialog may have stayed open for a while.
  const late = runningNow();
  if (late) {
    await assertSessionOfApp(ctx, app, late);
    return alreadyRunning(ctx, target, late, confirmation);
  }
  await assertNotBusy(ctx, app, config, buildDir);

  let launchEntry = entry;
  const warnings: string[] = [];
  if (planned) {
    const written = await applyDefaults(ctx, target, false);
    warnings.push(...written.warnings);
    launchEntry = entriesOf(app).find(info => info.name === entryName)?.entry ?? written.entry;
  }
  ensureBreakpointCleanup();

  // Watched before launching: the session can start before startDebugging
  // returns, and cortex-west starts a second, cortex-debug session.
  const expectedType = backend === 'cppdbg' ? 'cppdbg' : 'cortex-debug';
  const sessionDeadline = Date.now() + Math.max(remainingWaitMs(ctx, waitSec), debugLaunchHost.minSessionWaitMs);
  const watcher = waitForNewWorkbenchSession(tracked => tracked.name === entryName && tracked.type === expectedType, {
    deadline: sessionDeadline, signal: ctx.signal,
  });
  let launched: Thenable<boolean>;
  const launchedAt = Date.now();
  try {
    if (app.isWestWorkspaceApplication) {
      // As the Debug button: the provider resolves the selected application of the workspace.
      await debugLaunchHost.selectApplication(app.appWorkspaceFolder, app.appRootPath);
      launched = vscode.debug.startDebugging(app.appWorkspaceFolder, legacyName ? { ...launchEntry, name: entryName } : launchEntry);
    } else {
      launched = vscode.debug.startDebugging(app.appWorkspaceFolder, entryName);
    }
  } catch (error) {
    watcher.cancel();
    throw new McpToolError('INTERNAL', `VS Code could not start "${entryName}": ${messageOf(error)}`);
  }
  // The cortex-west provider builds, starts the gdb server and starts its
  // cortex-debug session within the launch, and reports false for its own
  // session: once the launch returns, that session has appeared or never
  // will, so it gets only a short grace period, not the whole wait.
  type Launch = { tracked?: TrackedDebugSession; reason?: string };
  const appeared: Promise<Launch> = watcher.session.then(found => ({ tracked: found }));
  let graceTimer: NodeJS.Timeout | undefined;
  const settled: Promise<Launch> = Promise.resolve(launched).then(
    (ok): Launch | Promise<Launch> => {
      if (ok) {
        return appeared;
      }
      if (backend !== 'cortex-west') {
        return { reason: 'VS Code did not start the session.' };
      }
      return Promise.race([appeared, new Promise<Launch>(resolve => {
        graceTimer = setTimeout(() => resolve({ reason: CORTEX_WEST_NOT_STARTED }), debugLaunchHost.cortexWestGraceMs);
      })]);
    },
    error => ({ reason: messageOf(error) }),
  );
  const first: Launch = await Promise.race<Launch>([appeared, settled]);
  if (graceTimer) {
    clearTimeout(graceTimer);
  }
  watcher.cancel();
  const tracked = first.tracked;
  if (!tracked) {
    // Only a server of this launch: the provider may already have disposed it.
    const serverTail = backend === 'cortex-west' ? serverOutputTail({ appRootPath: app.appRootPath, since: launchedAt }) : undefined;
    const details = {
      name: entryName,
      ...(serverTail ? { server_output_tail: serverTail.split('\n').slice(-20).join('\n') } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    if (first.reason) {
      throw new McpToolError('INTERNAL', `The debug session "${entryName}" did not start: ${first.reason}`, {
        hint: 'VS Code shows why in a notification or in the Debug Console. Ask the user what it says, check the configuration with configure_debug action "get", then start again.',
        details,
      });
    }
    throw new McpToolError('TIMEOUT', `The debug session "${entryName}" did not start within ${Math.round((sessionDeadline - ctx.startedAt) / 1000)} seconds.`, {
      hint: 'The launch may still be building the program or starting the gdb server. Call debug_app with action "status" in a few seconds; if no session shows, ask the user what VS Code reports.',
      details,
    });
  }

  let waited: string | undefined;
  if (waitForFirstStop) {
    waited = await waitForStop(tracked, { afterStop: 0, deadline: Date.now() + remainingWaitMs(ctx, waitSec), signal: ctx.signal });
  }
  const view = await sessionOut(ctx, tracked, { app, ...(tracked.state === 'terminated' ? { outputLines: 30 } : {}) });
  return {
    action: 'start',
    ...view,
    app_path: app.appRootPath,
    config_name: config.name,
    ...(target.domain ? { domain: target.domain } : {}),
    created_entry: planned !== undefined,
    ...(waited ? { waited } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(confirmation ? { confirmation } : {}),
    next: tracked.state === 'terminated'
      ? 'The session ended right after it started: read output_tail for why, and check the board connection and the runner tool with list_runners.'
      : nextFor(ctx, tracked),
  };
}

// stop

async function stop(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  const keep = boolArg(args, 'keep_breakpoints') ?? false;
  const tracked = await resolveSession(ctx, args);
  assertAlive(ctx, tracked);
  const sessionId = sessionIdOf(ctx, tracked);
  // This call's choice holds for the end of the last session, whatever an earlier stop said.
  keepAgentBreakpointsOnEnd(keep);
  if (!keep) {
    ensureBreakpointCleanup();
  }
  // Counted now: when this is the last session, its end may remove them first.
  const agentSet = agentBreakpointCount();
  try {
    await vscode.debug.stopDebugging(tracked.session);
  } catch (error) {
    throw new McpToolError('INTERNAL', `VS Code could not stop "${tracked.name}": ${messageOf(error)}`, {
      hint: 'Ask the user to stop it from the debug toolbar in VS Code.',
    });
  }
  const outcome = await waitForStop(tracked, {
    afterStop: Number.POSITIVE_INFINITY, deadline: Date.now() + debugLaunchHost.stopWaitMs, signal: ctx.signal,
  });
  // The breakpoints apply to every session: while another one runs they stay,
  // and go when the last one ends.
  const others = workbenchDebugSessions().filter(other => other !== tracked && other.state !== 'terminated');
  if (!keep && others.length === 0) {
    removeAgentBreakpoints();
  }
  const removed = keep ? 0 : agentSet - agentBreakpointCount();
  const ended = outcome === 'terminated';
  return {
    action: 'stop',
    session_id: sessionId,
    name: tracked.name,
    state: ended ? 'terminated' : 'stopping',
    ...(tracked.exitCode !== undefined ? { exit_code: tracked.exitCode } : {}),
    breakpoints_removed: removed,
    ...(keep ? { breakpoints_kept: true } : {}),
    ...(!keep && others.length > 0 && agentBreakpointCount() > 0
      ? { breakpoints_note: `The agent's breakpoints stay while another Workbench session runs (${others.length}), and go when the last one ends or with breakpoint clear.` }
      : {}),
    ...(tracked.output.length > 0 ? { output_tail: outputTail(tracked, 15) } : {}),
    next: ended
      ? 'The session has ended and the probe is free: flash with hardware action "flash", or debug again with debug_app action "start".'
      : `The session is still ending. Call debug_app with action "status" in a few seconds; ${JSON.stringify(sessionId)} is gone once it has ended.`,
  };
}

// status

async function status(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  stringArgs(args, ['session_id', 'app_path', 'config_name']);
  let list: TrackedDebugSession[];
  if (args.session_id !== undefined) {
    list = [await resolveSession(ctx, args)];
  } else if (args.app_path !== undefined || args.config_name !== undefined) {
    const app = await ctx.deps.services.resolveApp(str(args.app_path));
    const config = args.config_name !== undefined ? ctx.deps.services.resolveConfig(app, str(args.config_name)) : undefined;
    list = debugSessionsFor(app, config?.name);
  } else {
    list = workbenchDebugSessions();
  }
  const sessions = [];
  for (const tracked of list) {
    sessions.push(await sessionOut(ctx, tracked, { outputLines: 20, app: await appOfSession(ctx, tracked) }));
  }
  return {
    action: 'status',
    sessions,
    next: sessions.length === 0
      ? 'No Workbench debug session runs. Call debug_app with action "start" to start one; configure_debug action "list" names the debug configurations.'
      : sessions.length === 1
        ? nextFor(ctx, list[0])
        : 'Pass session_id, one of these, to the other debug_app actions.',
  };
}

const ROUTES: Readonly<Record<DebugAppAction, {
  args: readonly string[];
  run(args: Record<string, unknown>, ctx: Ctx): Promise<unknown>;
}>> = {
  start: { args: ['app_path', 'config_name', 'domain', 'name', 'wait_for_stop', 'wait_sec'], run: start },
  // app_path and config_name pick the session when session_id is omitted, and the window.
  stop: { args: ['session_id', 'app_path', 'config_name', 'keep_breakpoints'], run: stop },
  status: { args: ['session_id', 'app_path', 'config_name'], run: status },
  breakpoint: { args: ['session_id', 'app_path', 'config_name', 'add', 'remove', 'clear'], run: breakpoint },
  control: { args: ['session_id', 'app_path', 'config_name', 'command', 'thread_id', 'wait_for_stop', 'wait_sec'], run: control },
  inspect: {
    args: ['session_id', 'app_path', 'config_name', 'include', 'expressions', 'memory', 'frame', 'thread_id', 'depth'],
    run: inspect,
  },
  gdb: { args: ['session_id', 'app_path', 'config_name', 'text'], run: gdb },
};

export const debugApp: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const action = typeof args.action === 'string' ? args.action : '';
  const route = Object.prototype.hasOwnProperty.call(ROUTES, action) ? ROUTES[action as DebugAppAction] : undefined;
  if (!route) {
    throw new McpToolError('INVALID_ARGUMENT', `action must be one of ${DEBUG_APP_ACTIONS.join(', ')}, not "${logSafe(action, 40)}".`);
  }
  const accepted = new Set(['action', ...route.args]);
  const unexpected = Object.keys(args).filter(key => args[key] !== undefined && !accepted.has(key));
  if (unexpected.length > 0) {
    throw new McpToolError('INVALID_ARGUMENT', `action "${action}" does not take ${unexpected.join(', ')}.`, {
      details: { accepted: [...accepted] },
    });
  }
  return route.run(args, ctx);
};
