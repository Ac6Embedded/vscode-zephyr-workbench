// The flash action of the hardware tool: west flash on the build of an
// application, as a job the user watches in a terminal, like the Flash
// button of the Applications view but without its runner picker: the runner
// comes from the call, the configuration or the board, never from a prompt.
//
// It asks the user first, and refuses while anything else holds the build
// folder, the probe or the serial port a runner flashes through. With
// wait_for, it then waits for the board's first words in the running serial
// capture of the application.

import * as vscode from 'vscode';
import { isSessionOf, TrackedDebugSession, workbenchDebugSessions } from '../../../debug/sessionTracker';
import { ZephyrApplication } from '../../../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../../../models/ZephyrBuildConfig';
import { BuildDirectTaskOptions, buildDirectTask, collectSettingsWarningsSync } from '../../../providers/ZephyrTaskProvider';
import { getStaticFlashRunnerNames } from '../../../utils/debugTools/debugUtils';
import { getConfiguredVenvPath } from '../../../utils/execUtils';
import { getWestWorkspace } from '../../../utils/utils';
import { getDomainBuildDir, readDomainsForBuildDir } from '../../../utils/zephyr/domainsYamlUtils';
import {
  findRunnersYamlForBuildDir, ParsedRunnersYaml, readRunnersYamlFile, readRunnersYamlForProject,
} from '../../../utils/zephyr/runnersYamlUtils';
import { normalizeForCompare } from '../../core/argSafety';
import { McpToolError, toToolError } from '../../core/errors';
import {
  argumentOf, assertDevId, assertFlashRunner, checkRunnerArgs, devIdArgs, devIdOption, flashFailureHint, noRebuildFlag,
  probeOptionsOf, ReservedOption, reservedRunnerOptions, SERIAL_PORT_RUNNERS, ZephyrVersion,
} from '../../core/flashArgs';
import { matcherFor } from '../../core/match';
import { logSafe, redactCommandLine } from '../../core/redact';
import { confirmCategoryOf, ToolContext } from '../../core/toolSpec';
import { conflictOf } from '../../jobs/jobConflicts';
import { isWorking, JobSpec, JobState, JobView } from '../../jobs/jobManager';
import { findExternalRun } from '../buildConflicts';
import { ConfirmSubject, DIALOG_LINE_CHARS, fitsDialogLine } from '../confirmations';
import { SerialCapture, serialCaptures } from '../serial/captures';
import { readSlice, waitForDeviceLine, WaitResult } from '../serial/serialLog';
import { runCapturedTask } from '../taskRunner';
import { REVEAL } from './actions';
import { HostDeps } from './deps';
import { checkStrings, waitForView, waitSecOf } from './hardwareSerial';
import { progressWait, remainingWaitMs } from './progress';

type Ctx = ToolContext<HostDeps>;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** How much of the board's output since the flash the answer carries. */
const SERIAL_EXCERPT_CHARS = 2000;

/** How west flash says its rebuild failed (run_common.py). */
const REBUILD_FAILED = /re-build in .* failed/;

/** What west flash prints once the rebuild is over and the runner starts, per image. */
const RUNNER_BANNER = /west flash: using runner /;

export type RunnerSource = 'argument' | 'config_default' | 'board_default';

/**
 * What the action reaches outside itself, replaced by the tests: building
 * the West Flash task, running it in a terminal, and reading the Zephyr
 * version of the application's west workspace.
 */
export const flashHost = {
  buildTask(app: ZephyrApplication, config: ZephyrBuildConfig, options: BuildDirectTaskOptions, warnings: string[]): vscode.Task | undefined {
    // A missing IAR or Arm GNU toolchain is reported in the answer, not in a notification.
    return collectSettingsWarningsSync(warnings,
      () => buildDirectTask(app.appWorkspaceFolder, 'West Flash', config.name, options, app));
  },
  run: runCapturedTask,
  zephyrVersion(app: ZephyrApplication): ZephyrVersion | undefined {
    try {
      const version = getWestWorkspace(app.westWorkspaceRootPath).versionArray;
      const major = parseInt(version?.VERSION_MAJOR ?? '', 10);
      const minor = parseInt(version?.VERSION_MINOR ?? '', 10);
      return Number.isFinite(major) && Number.isFinite(minor) ? { major, minor } : undefined;
    } catch {
      return undefined;
    }
  },
};

function invalid(message: string, hint?: string, details?: Record<string, unknown>): McpToolError {
  return new McpToolError('INVALID_ARGUMENT', message, { ...(hint ? { hint } : {}), ...(details ? { details } : {}) });
}

function boolArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value !== undefined && typeof value !== 'boolean') {
    throw invalid(`${key} must be true or false.`);
  }
  return value;
}

/** The runners.yaml of the build, or of the domain's own build folder. */
function runnersYamlOf(app: ZephyrApplication, config: ZephyrBuildConfig, buildDir: string, domain: string | undefined): ParsedRunnersYaml | undefined {
  if (domain) {
    const domainDir = getDomainBuildDir(readDomainsForBuildDir(buildDir), domain);
    const file = domainDir ? findRunnersYamlForBuildDir(domainDir) : undefined;
    return file ? readRunnersYamlFile(file) : undefined;
  }
  return readRunnersYamlForProject(app, config);
}

/**
 * The runner to flash with: the argument, else the configuration's default
 * runner (as the Flash button uses it), else the flash runner the board names
 * in runners.yaml. One the build does not list is refused before west is.
 */
function chooseRunner(argument: string | undefined, config: ZephyrBuildConfig, yaml: ParsedRunnersYaml | undefined):
  { runner: string; source: RunnerSource } {
  const listed = yaml?.runners ?? [];
  const known = listed.length > 0 ? listed : getStaticFlashRunnerNames();
  const details = {
    runners: known,
    ...(yaml?.defaultFlashRunner ? { default_flash_runner: yaml.defaultFlashRunner } : {}),
    ...(listed.length === 0 ? { note: 'The build has no runners.yaml, so this is every runner Zephyr has, not the ones this board supports.' } : {}),
  };
  const stored = config.defaultRunner?.trim();
  const pick: { runner: string; source: RunnerSource } | undefined = argument ? { runner: argument, source: 'argument' }
    : stored ? { runner: stored, source: 'config_default' }
      : yaml?.defaultFlashRunner ? { runner: yaml.defaultFlashRunner, source: 'board_default' }
        : undefined;
  if (!pick) {
    throw new McpToolError('RUNNER_UNKNOWN',
      `No runner was given, "${config.name}" has no default runner, and its build names no flash runner for the board.`, {
        hint: 'Pass runner, one of details.runners. Call list_runners to see the runners of this build and whether their tools are installed.',
        details,
      });
  }
  if (pick.source !== 'argument' && !/^[a-z][a-z0-9_]*$/.test(pick.runner)) {
    throw new McpToolError('RUNNER_UNKNOWN',
      `The ${pick.source === 'config_default' ? `default runner of "${config.name}"` : 'flash runner of the board'} is "${logSafe(pick.runner, 80)}", which is not a runner name.`, {
        hint: 'Pass runner, one of details.runners, or set the default runner with configure.',
        details,
      });
  }
  if (listed.length > 0 && !listed.includes(pick.runner)) {
    const whose = pick.source === 'config_default' ? `, the default runner of "${config.name}",` : '';
    throw new McpToolError('RUNNER_UNKNOWN',
      `The build of "${config.name}" does not support the runner "${pick.runner}"${whose}: its runners.yaml lists ${listed.join(', ')}.`, {
        hint: 'Pass runner, one of details.runners. Call list_runners to see them with their tools.',
        details,
      });
  }
  return pick;
}

/** How a lock on one probe is named in a refusal: without dev_id, the runner picks the probe. */
function probeName(devId: string | undefined): string {
  return devId ? `the probe ${devId}` : 'the default probe';
}

/** The runner a flash job runs, read from its command. */
function runnerOfJob(command: string): string | undefined {
  return /--runner (\S+)/.exec(command)?.[1];
}

/** The board itself, without its SoC and cluster: nrf5340dk/nrf5340/cpunet is the nrf5340dk. */
export function baseBoard(identifier: string | undefined): string | undefined {
  return identifier?.split('/')[0].split('@')[0].toLowerCase() || undefined;
}

/**
 * The Workbench debug sessions whose gdb server may hold the probe of the
 * board: those of this application, whatever their configuration, and those
 * of other applications of the window on the same board. A session of a
 * configuration known to be on another board is left alone.
 */
async function sessionsOnBoard(ctx: Ctx, app: ZephyrApplication, config: ZephyrBuildConfig):
  Promise<Array<{ tracked: TrackedDebugSession; owner?: ZephyrApplication }>> {
  const sessions = workbenchDebugSessions();
  if (sessions.length === 0) {
    return [];
  }
  let apps: ZephyrApplication[] = [];
  try {
    apps = await ctx.deps.services.listApplications();
  } catch {
    // Only the sessions of this application are known then.
  }
  const board = baseBoard(config.boardIdentifier);
  const found: Array<{ tracked: TrackedDebugSession; owner?: ZephyrApplication }> = [];
  for (const tracked of sessions) {
    const own = isSessionOf(tracked, app);
    const owner = own ? app : apps.find(candidate => isSessionOf(tracked, candidate));
    const theirs = baseBoard(owner?.buildConfigs.find(candidate => candidate.name === tracked.configName)?.boardIdentifier);
    if (theirs !== undefined && board !== undefined ? theirs === board : own) {
      found.push({ tracked, ...(owner ? { owner } : {}) });
    }
  }
  return found;
}

interface FlashPlan {
  app: ZephyrApplication;
  config: ZephyrBuildConfig;
  buildDir: string;
  runner: string;
  devId?: string;
}

/**
 * Everything that would make the flash fight something else: a task the user
 * runs on the configuration, a deletion of its build folder, a debug session
 * that may hold the probe, a capture holding the port a serial runner flashes
 * through, another flash on the same probe, or an agent job using the folder.
 * Checked before the user is asked and again right before the job starts.
 */
async function checkConflicts(ctx: Ctx, plan: FlashPlan, spec: JobSpec): Promise<void> {
  const { jobs } = ctx.deps;
  const { app, config, buildDir, runner, devId } = plan;
  const external = findExternalRun(app.appRootPath, config.name);
  if (external) {
    throw new McpToolError('BUSY_EXTERNAL', `"${external.task.name}" is already running for ${config.name}, started from VS Code.`, {
      hint: 'Wait for it to finish in its terminal, then flash again.',
    });
  }
  const deleting = jobs.runningOverlapping(buildDir).find(running => running.spec.kind === 'clean');
  if (deleting) {
    throw new McpToolError('BUSY', `The build folder of ${config.name} is being deleted (job_id "${deleting.id}").`, {
      hint: `Wait for it with job {"action": "status", "job_id": "${deleting.id}"}, then build and flash again.`,
      details: { job_id: deleting.id, kind: deleting.spec.kind },
    });
  }
  const sessions = await sessionsOnBoard(ctx, app, config);
  if (sessions.length > 0) {
    const { tracked, owner } = sessions[0];
    const whose = `${tracked.configName ?? 'a configuration'}${owner && owner !== app ? ` of ${owner.appName}` : ''}`;
    const stop = owner && tracked.configName ? { action: 'stop', app_path: owner.appRootPath, config_name: tracked.configName } : undefined;
    throw new McpToolError('BUSY', `A debug session of ${whose} is running ("${tracked.name}"), and it may hold the probe of the board.`, {
      hint: `${stop ? `Stop it with debug_app ${JSON.stringify(stop)}, or ask` : 'Ask'} the user to stop it in the VS Code debugger, then flash again.`,
      details: {
        sessions: sessions.map(({ tracked: session, owner: of }) => ({
          name: session.name, type: session.type,
          ...(of ? { app_path: of.appRootPath } : {}), ...(session.configName ? { config_name: session.configName } : {}),
        })),
      },
    });
  }
  if (SERIAL_PORT_RUNNERS.has(runner)) {
    const captures = serialCaptures.running();
    if (captures.length > 0) {
      const first = captures[0];
      throw new McpToolError('BUSY',
        `The ${runner} runner flashes through a serial port, and a serial capture holds ${first.info.port} (job_id "${first.jobId}"). A port opens in one program at a time.`, {
          hint: `Stop the capture with hardware {"action": "serial_stop", "job_id": "${first.jobId}"}, flash, then start it again with hardware ${JSON.stringify({ action: 'serial_start', port: first.info.port })}.`,
          details: { captures: captures.map(capture => ({ job_id: capture.jobId, port: capture.info.port })) },
        });
    }
  }
  const working = jobs.list().filter(isWorking);
  const sameProbe = working.find(job => job.spec.lockKey === spec.lockKey && job.spec.requestKey !== spec.requestKey);
  if (sameProbe) {
    const theirs = runnerOfJob(sameProbe.spec.command);
    throw new McpToolError('BUSY', `A flash through ${probeName(devId)} is already running${theirs ? ` with ${theirs}` : ''} (job_id "${sameProbe.id}").`, {
      hint: `Wait for it with job {"action": "status", "job_id": "${sameProbe.id}"}${devId ? '' : ', or pass dev_id to flash another board connected through its own probe'}.`,
      details: { job_id: sameProbe.id, kind: sameProbe.spec.kind, status: sameProbe.status },
    });
  }
  for (const job of working) {
    const shared = job.spec.lockKey === spec.lockKey ? undefined : conflictOf(spec, job.spec);
    if (!shared) {
      continue;
    }
    const what = shared === 'west_workspace' ? 'the west workspace' : shared === 'venv' ? 'the Python environment' : `the build folder of ${config.name}`;
    throw new McpToolError('BUSY', `A ${job.spec.kind} job is using ${what} (job_id "${job.id}").`, {
      hint: `Wait for it with job {"action": "status", "job_id": "${job.id}"}, then flash again.`,
      details: { job_id: job.id, kind: job.spec.kind, status: job.status },
    });
  }
}

/**
 * The captures that show this application's board: its own, else the only one
 * running, unless that one was started for another application on another board.
 */
function capturesOf(app: ZephyrApplication, config: ZephyrBuildConfig): { capture?: SerialCapture; running: SerialCapture[] } {
  const running = serialCaptures.running();
  const root = normalizeForCompare(app.appRootPath);
  const own = running.filter(capture => capture.info.appPath && normalizeForCompare(capture.info.appPath) === root);
  const mine = own.find(capture => capture.info.configName === config.name) ?? own[0];
  const lone = running.length === 1 ? running[0] : undefined;
  const board = baseBoard(config.boardIdentifier);
  const otherBoard = !!lone?.info.appPath && board !== undefined && baseBoard(lone.info.board) !== undefined
    && baseBoard(lone.info.board) !== board;
  return { capture: mine ?? (otherBoard ? undefined : lone), running };
}

function readHint(jobId: string, offset: number): string {
  return `hardware {"action": "serial_read", "job_id": "${jobId}", "offset": ${offset}}`;
}

/** The next step once the flash job has ended. */
function flashNext(view: JobView, plan: FlashPlan, options: { erase: boolean; before: ReadonlyMap<string, number> }): string {
  const { app, config, runner, devId } = plan;
  if (view.status === 'succeeded') {
    const { capture } = capturesOf(app, config);
    const board = config.boardIdentifier || config.name;
    return capture?.jobId
      ? `Flashed ${board} with ${runner}. Read what it printed since with ${readHint(capture.jobId, options.before.get(capture.jobId) ?? 0)}, adding wait_for to wait for a line.`
      : `Flashed ${board} with ${runner}. To see it boot, start a capture with hardware ${JSON.stringify({ action: 'serial_start', app_path: app.appRootPath })}, then reset the board or flash it again.`;
  }
  if (view.status === 'cancelled') {
    return 'The flash was cancelled. The board may hold a partly written image, so flash it again before relying on it.';
  }
  // West reports every runner failure as a FATAL ERROR too, which the parser
  // counts as an error: only its re-build line, or an error of the compiler,
  // CMake, ninja or the linker, says the build failed.
  const buildFailed = `West rebuilt ${config.name} before flashing, and the build failed. Fix the errors in diagnostics, then flash again; get_diagnostics lists them all.`;
  if (REBUILD_FAILED.test(view.log.tail)) {
    return buildFailed;
  }
  const hint = flashFailureHint(view.log.tail, { runner, erase: options.erase, devId });
  if (hint) {
    return hint;
  }
  if ((view.diagnostics?.items ?? []).some(item => item.severity === 'error' && item.tool !== 'west')) {
    return buildFailed;
  }
  return `The flash failed${view.exit_code !== undefined ? ` with exit code ${view.exit_code}` : ''}. Read the whole log with job {"action": "log", "job_id": "${view.job_id}"}; `
    + `check that the board is connected, and that the tool of the ${runner} runner is installed with list_runners and include ["tools"].`;
}

/** After a flash with wait_for: wait for the line in the capture of the application. */
async function waitOnCapture(ctx: Ctx, plan: FlashPlan, pattern: string, matches: (line: string) => boolean, waitSec: number,
  before: ReadonlyMap<string, number>): Promise<{ serial: Record<string, unknown>; next?: string }> {
  const { app, config } = plan;
  const { capture, running } = capturesOf(app, config);
  if (!capture?.jobId) {
    return {
      serial: {
        pattern,
        waited: false,
        reason: running.length === 0 ? 'No serial capture is running, so the output of the board was not read.'
          : running.length === 1 ? `A serial capture is running, but it is of another application on another board (${running[0].info.board}).`
            : `${running.length} serial captures are running and none is of this application.`,
        ...(running.length > 0 ? { captures: running.map(entry => ({ job_id: entry.jobId, port: entry.info.port })) } : {}),
      },
      next: running.length === 0
        ? `Flashed. To wait for a line of the board, start a capture before flashing with hardware ${JSON.stringify({ action: 'serial_start', app_path: app.appRootPath })}, then flash again with wait_for, or reset the board and wait with serial_read.`
        : `Flashed. Wait for the line in the right capture with hardware {"action": "serial_read", "job_id": "...", "wait_for": ${JSON.stringify(pattern)}}, one of the job ids in serial.captures.`,
    };
  }
  const jobId = capture.jobId;
  const file = (ctx.deps.jobs.get(jobId) as JobState).log.filePath;
  const from = before.get(jobId) ?? 0;
  const waited: WaitResult = await waitForDeviceLine({
    file, from, matches, capture,
    deadline: Date.now() + remainingWaitMs(ctx, waitSec), signal: ctx.signal,
    tick: () => ctx.progress({ progress: Math.round((Date.now() - ctx.startedAt) / 1000), message: `Waiting for "${pattern}" on ${capture.info.port}` }),
  });
  const excerpt = readSlice(file, from, SERIAL_EXCERPT_CHARS);
  return {
    serial: {
      job_id: jobId,
      port: capture.info.port,
      ...waitForView(pattern, waited),
      text: excerpt.text,
      offset: from,
      next_offset: excerpt.next_offset,
      more: excerpt.more,
    },
    next: waited.hit
      ? `Flashed, and the board printed the line you waited for. Read what follows with ${readHint(jobId, excerpt.next_offset)}.`
      : `Flashed, but no line matched within wait_sec. Read what the board printed with ${readHint(jobId, from)}, or wait longer with serial_read and wait_for.`,
  };
}

/** Stored options that make west flash another runner, build or nothing at all, whatever the call says. */
const STORED_REFUSED = new Set(['--runner', '--build-dir', '--cmake-cache', '--board-dir', '--context']);

/**
 * Check the runner arguments stored in the configuration against the call.
 * They come after the call's own options, so argparse would keep theirs: a
 * stored --dev-id would flash another probe than dev_id names, outside its
 * lock. Returns the probe and the erase they select on their own.
 */
function checkStoredArgs(stored: string, runner: string, config: ZephyrBuildConfig,
  call: { devId?: string; domain?: string; rebuild: boolean }): { devId?: string; erase: boolean } {
  const probeOptions = [...probeOptionsOf(runner), 'adapter serial'];
  const clash = (option: ReservedOption): string | undefined => {
    const arg = argumentOf(option.taken);
    if ((probeOptions.includes(option.taken) && call.devId)
      || (option.taken === '--domain' && call.domain)
      || (arg === 'rebuild' && !call.rebuild)) {
      return arg;
    }
    return undefined;
  };
  let devId: string | undefined;
  let erase = false;
  for (const option of reservedRunnerOptions(stored, runner)) {
    const what = `The runner arguments stored in "${config.name}" hold ${logSafe(option.word, 60)} (${option.taken})`;
    const change = `change the runner arguments of "${config.name}" with configure (runner_args)`;
    if (STORED_REFUSED.has(option.taken)) {
      throw invalid(`${what}, so west would not flash what this call names.`,
        `Ask the user whether to ${change}, or pass another runner, which does not get them.`);
    }
    const arg = clash(option);
    if (arg) {
      throw invalid(`${what}, and the call gives ${arg} too: west would take the stored one.`,
        `Leave ${arg} out of the call, or ${change}.`);
    }
    if (option.taken === '--erase') {
      erase = true;
    } else if (probeOptions.includes(option.taken)) {
      devId ??= option.taken === 'adapter serial' ? /adapter\s+serial\s+(\S+)/.exec(option.word)?.[1] : option.value;
    }
  }
  return { ...(devId ? { devId } : {}), erase };
}

export async function flash(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  const { services, jobs, confirmations, defaultWaitSeconds } = ctx.deps;
  checkStrings(args, ['app_path', 'config_name', 'runner', 'runner_args', 'domain', 'dev_id', 'wait_for']);
  const erase = boolArg(args, 'erase') ?? false;
  const rebuild = boolArg(args, 'rebuild') ?? true;
  const dryRun = boolArg(args, 'dry_run') ?? false;
  const runnerArg = args.runner !== undefined ? assertFlashRunner(args.runner) : undefined;
  const devId = args.dev_id !== undefined ? assertDevId(args.dev_id) : undefined;
  const pattern = str(args.wait_for);
  const matches = matcherFor(pattern);
  const waitSec = waitSecOf(args, defaultWaitSeconds);

  const { app, config, buildDir } = await services.resolveTarget(str(args.app_path), str(args.config_name));
  const domain = services.resolveDomain(app, config, str(args.domain));
  if (domain !== undefined && !/^[A-Za-z0-9_.-]+$/.test(domain)) {
    throw invalid(`domain "${logSafe(domain, 80)}" cannot be passed to west flash.`);
  }
  if (!services.isConfigured(buildDir)) {
    throw new McpToolError('NOT_BUILT', `"${config.name}" has never been built, so there is nothing to flash in "${buildDir}".`, {
      hint: `Call build_app with config_name "${config.name}" first, then flash.`,
    });
  }
  if (!rebuild && !services.isBuilt(app, config)) {
    throw new McpToolError('NOT_BUILT', `rebuild is false, and "${buildDir}" holds no finished build of "${config.name}" to flash.`, {
      hint: `Call build_app with config_name "${config.name}" first, or flash with rebuild true.`,
    });
  }
  const domains = services.listDomains(app, config);
  const sysbuild = domains !== undefined || String(config.sysbuild).toLowerCase() === 'true';
  if (erase && sysbuild && !domain) {
    // West would pass --erase for every image it flashes, so the application
    // image could wipe MCUboot, flashed just before it.
    throw invalid(`erase on the sysbuild build of "${config.name}" needs domain: without it, each image flashed would erase the chip again.`,
      'Pass domain, one of details.domains, to erase and flash that image, then flash the others without erase.',
      domains ? { domains: domains.domains.map(entry => entry.name), default: domains.default } : undefined);
  }

  const { runner, source } = chooseRunner(runnerArg, config, runnersYamlOf(app, config, buildDir, domain));
  const extraRunnerArgs = args.runner_args !== undefined ? checkRunnerArgs(args.runner_args, runner).trim() || undefined : undefined;
  // As the Flash button does: the stored arguments go with the stored runner.
  const storedArgs = runner === config.defaultRunner?.trim() && config.customArgs?.trim() ? config.customArgs.trim() : undefined;
  const stored = storedArgs ? checkStoredArgs(storedArgs, runner, config, { devId, domain, rebuild }) : { erase: false };
  // The probe the flash goes to, for its lock and its hints, whoever named it.
  const probeId = devId ?? stored.devId;
  const flashRunnerArgs = [storedArgs, extraRunnerArgs].filter((part): part is string => !!part).join(' ') || undefined;
  const rebuildFlag = rebuild ? undefined : noRebuildFlag(flashHost.zephyrVersion(app));
  const devOption = devId ? devIdOption(runner) : undefined;
  const extraArgs = [
    ...(domain ? [`--domain ${domain}`] : []),
    ...(erase ? ['--erase'] : []),
    ...(devId ? devIdArgs(runner, devId) : []),
    ...(rebuildFlag ? [rebuildFlag] : []),
  ];
  const flags = {
    erase: erase || stored.erase,
    rebuild,
    ...(rebuildFlag ? { rebuild_flag: rebuildFlag } : {}),
    ...(devId ? { dev_id: devId, dev_id_option: devOption } : {}),
    ...(!devId && stored.devId ? { dev_id: stored.devId, dev_id_source: 'stored_runner_args' } : {}),
    ...(storedArgs ? { stored_runner_args: storedArgs } : {}),
    ...(extraRunnerArgs ? { runner_args: extraRunnerArgs } : {}),
  };

  const warnings: string[] = [];
  let task: vscode.Task | undefined;
  try {
    task = flashHost.buildTask(app, config, { flashRunner: runner, ...(flashRunnerArgs ? { flashRunnerArgs } : {}), extraArgs }, warnings);
  } catch (error) {
    // `ZephyrTaskProvider.resolve` throws for a missing environment script and
    // for an unlinked west workspace application, which map to real codes.
    throw toToolError(error);
  }
  if (!task) {
    throw invalid(`Cannot flash "${config.name}": the West Flash task could not be built for it.`,
      'Check that the configuration has a board set, with list_apps.');
  }
  const flashTask = task;
  const command = redactCommandLine((flashTask.execution as vscode.ShellExecution)?.commandLine ?? 'west flash');

  // Offsets of the running captures when the flash starts, so wait_for reads
  // only what came after. Moved on when west starts the runner, since the old
  // image keeps printing while west rebuilds.
  const before = new Map<string, number>();
  const markCaptures = () => {
    for (const capture of serialCaptures.running()) {
      try {
        before.set(capture.jobId as string, (jobs.get(capture.jobId as string) as JobState).log.size);
      } catch {
        // A capture whose job is gone is read from its start.
      }
    }
  };
  const venvPath = (() => {
    try {
      return app.venvPath ?? getConfiguredVenvPath(app.appWorkspaceFolder);
    } catch {
      return undefined;
    }
  })();
  const plan: FlashPlan = { app, config, buildDir, runner, ...(probeId ? { devId: probeId } : {}) };
  const spec: JobSpec = {
    kind: 'flash',
    // One flash per probe, whichever runner drives it: two on the same probe
    // would interleave their commands, and without dev_id the runners pick
    // the same first probe.
    lockKey: `flash:probe:${probeId ?? 'default'}`,
    requestKey: `flash:${buildDir}:${command}`,
    appPath: app.appRootPath,
    configName: config.name,
    buildDir,
    ...(app.westWorkspaceRootPath ? { westWorkspace: app.westWorkspaceRootPath } : {}),
    ...(venvPath ? { venvPath } : {}),
    // West rebuilds the folder before it flashes, unless told not to.
    ...(rebuild ? { writes: ['build_dir'] as const } : {}),
    parse: rebuild,
    command,
    run: async (sink, signal) => {
      // West prints its runner banner once per image after the rebuild; the
      // board resets only after that, so the lines before it are the old image's.
      let tail = '';
      const watched = {
        onData: (chunk: string) => {
          const seen = (tail + chunk).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
          if (RUNNER_BANNER.test(seen)) {
            markCaptures();
          }
          tail = seen.slice(-200).replace(/[\s\S]*west flash: using runner \S*/, '');
          sink.onData(chunk);
        },
      };
      const { exitCode } = await flashHost.run(flashTask, watched, signal, {
        reveal: REVEAL[ctx.deps.revealTerminal] ?? vscode.TaskRevealKind.Silent,
        header: `> [agent ${ctx.client.name ?? 'mcp'}] West Flash [${config.name}] with ${runner}`,
      });
      return { exitCode, extra: { runner, runner_source: source, ...(domain ? { domain } : {}), ...(probeId ? { dev_id: probeId } : {}) } };
    },
    next: view => flashNext(view, plan, { erase: flags.erase, before }),
  };

  // The identical flash already running: this call joins it, and was approved with it.
  const attachable = jobs.findAttachable(spec);
  ctx.audit.target = { app_path: app.appRootPath, config_name: config.name, runner };
  const asked = !attachable && !!confirmCategoryOf(ctx.tool, args) && ctx.deps.permissionOf(ctx.tool) === 'ask';
  // The dialog cuts a longer line, and the user must never approve a part they could not read.
  const commandLine = `Command: ${command}`;
  if (asked && !fitsDialogLine(commandLine)) {
    throw invalid(`The west flash command is too long to show whole in the confirmation dialog the user approves it in (${commandLine.length} characters, more than ${DIALOG_LINE_CHARS}).`,
      // The stored arguments are part of the same command, so moving options there does not help.
      storedArgs
        ? 'Shorten runner_args, or the runner arguments stored in the configuration (configure runner_args): both are part of the command.'
        : 'Shorten runner_args.',
      storedArgs ? { stored_runner_args_chars: storedArgs.length } : undefined);
  }
  if (!attachable) {
    await checkConflicts(ctx, plan, spec);
  }
  if (dryRun) {
    return {
      action: 'flash',
      dry_run: true,
      app_path: app.appRootPath,
      config_name: config.name,
      board: config.boardIdentifier,
      build_dir: buildDir,
      command,
      runner,
      runner_source: source,
      ...(domain ? { domain } : {}),
      flags,
      ...(attachable ? { running_job_id: attachable.id } : {}),
      confirmation_required: asked,
      ...(warnings.length > 0 ? { warnings } : {}),
      next: 'Nothing was flashed. Call hardware again with the same arguments and without dry_run to flash.',
    };
  }

  let outcome: string | undefined;
  if (!attachable) {
    // The command is part of the subject, so an answer given late to one
    // flash is never taken for another; Allow for This Session covers
    // flashing this application only, not a serial send or a debug session.
    const board = config.boardIdentifier || config.name;
    const subject: ConfirmSubject = {
      summary: `flash the board ${board} with ${runner} (west flash)${erase ? ', erasing its flash first' : ''}${domain ? `, domain ${domain} only` : ''}`,
      appPath: app.appRootPath,
      configName: config.name,
      ...(config.boardIdentifier ? { board: config.boardIdentifier } : {}),
      runner,
      scope: `flash:${normalizeForCompare(app.appRootPath)}`,
      sessionText: 'flashing this application',
      lines: [commandLine],
    };
    outcome = await confirmations.require(ctx, args, subject);
    // Read again: the dialog may have stayed open for a while.
    await checkConflicts(ctx, plan, spec);
  }

  // Kept when west never prints its runner banner, and for a call that joins a running flash.
  markCaptures();
  const { job, attached } = jobs.start(spec);
  ctx.audit.jobId = job.id;
  await jobs.wait(job, remainingWaitMs(ctx, waitSec), progressWait(ctx, jobs));
  const view = jobs.view(job, { attached });

  let serial: Record<string, unknown> | undefined;
  let next = view.next;
  if (matches && pattern) {
    if (view.status === 'succeeded') {
      const waited = await waitOnCapture(ctx, plan, pattern, matches, waitSec, before);
      serial = waited.serial;
      next = waited.next ?? next;
    } else {
      serial = {
        pattern,
        waited: false,
        reason: view.status === 'running' ? 'The flash was still running when wait_sec ran out.' : 'The flash did not succeed, so the board was not read.',
      };
      if (view.status === 'running') {
        next = `${view.next} Once it has succeeded, wait for the line with hardware action "serial_read" and wait_for.`;
      }
    }
  }
  return {
    ...view,
    action: 'flash',
    runner,
    runner_source: source,
    ...(domain ? { domain } : {}),
    flags,
    ...(outcome === undefined || outcome === 'not-required' || outcome === 'not-asked'
      ? {} : { confirmation: { category: ctx.audit.confirmCategory, outcome } }),
    ...(serial ? { serial } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    next,
  };
}
