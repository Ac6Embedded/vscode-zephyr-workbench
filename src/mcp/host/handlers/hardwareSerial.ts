// The serial actions of the hardware tool: list the ports, capture one as a
// job the user watches in a terminal, read what the board printed, send it a
// line, and stop. The port and the baud rate default to what the application's
// build says: the port whose USB strings name the board (or the only USB
// port), and the current-speed of the devicetree's chosen console.
//
// Only serial_send asks the user: writing to a board can run any shell command
// on it. Listing opens no port, and reading only reads the capture's log.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ZephyrApplication } from '../../../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../../../models/ZephyrBuildConfig';
import { readZephyrDeviceTreeReport } from '../../../utils/zephyr/dtsReportParser';
import { McpToolError } from '../../core/errors';
import { normalizeForCompare } from '../../core/argSafety';
import { matcherFor } from '../../core/match';
import { logSafe } from '../../core/redact';
import {
  assertBaudRate, assertDuration, assertLineEnding, assertMaxChars, assertOffset, assertPortArgument, assertSendText,
  DEFAULT_BAUD, DURATION_DEFAULT_SEC, quoteForDialog, READ_DEFAULT_CHARS,
} from '../../core/serialArgs';
import { consoleSpeedFromDevicetree } from '../../core/serialConsole';
import { choosePort, isUsbPort, ListedPort, matchesBoard, normalizePort, PortChoice, portKeys, usbId, wantsDtr } from '../../core/serialPorts';
import { ToolContext } from '../../core/toolSpec';
import { isPersisted, JobState, JobView, PersistedJob } from '../../jobs/jobManager';
import { ConfirmSubject } from '../confirmations';
import { OpenOutcome, SerialCapture, serialCaptures } from '../serial/captures';
import { HelperCommand, listPorts, pyserialMissing, serialHelper } from '../serial/helper';
import { grepSlice, readSlice, waitForDeviceLine, waitForOutput, WaitResult } from '../serial/serialLog';
import { REVEAL } from './actions';
import { HostDeps } from './deps';
import { remainingWaitMs } from './progress';

type Ctx = ToolContext<HostDeps>;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** How long serial_start waits, once the helper has loaded pyserial, for the port to open or fail. */
export const OPEN_WAIT_MS = 1000;
/** The longest serial_start waits for that answer, however slow Python starts. */
const OPEN_WAIT_CAP_MS = 5000;

function invalid(message: string, hint?: string, details?: Record<string, unknown>): McpToolError {
  return new McpToolError('INVALID_ARGUMENT', message, { ...(hint ? { hint } : {}), ...(details ? { details } : {}) });
}

function checkStrings(args: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    if (args[key] !== undefined && typeof args[key] !== 'string') {
      throw invalid(`${key} must be a string.`);
    }
  }
}

function waitSecOf(args: Record<string, unknown>, fallback: number): number {
  const value = args.wait_sec;
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalid('wait_sec must be a number of seconds, 0 or more.');
  }
  return value;
}

// Where the board and its console speed come from

interface BoardTarget {
  app?: ZephyrApplication;
  config?: ZephyrBuildConfig;
  board?: string;
}

/**
 * The application whose board and devicetree pick the defaults: the one named,
 * else the only one of the window. With several and none named, the defaults
 * come from the ports alone.
 */
async function boardTarget(ctx: Ctx, args: Record<string, unknown>): Promise<BoardTarget> {
  const { services } = ctx.deps;
  if (args.app_path !== undefined || args.config_name !== undefined) {
    const { app, config } = await services.resolveTarget(str(args.app_path), str(args.config_name));
    return { app, config, board: config.boardIdentifier || undefined };
  }
  const apps = await services.listApplications();
  if (apps.length !== 1) {
    return {};
  }
  try {
    const config = services.resolveConfig(apps[0]);
    return { app: apps[0], config, board: config.boardIdentifier || undefined };
  } catch {
    return { app: apps[0] };
  }
}

/** The console's current-speed in the build's zephyr.dts, through the parser query_devicetree uses. */
function devicetreeConsole(ctx: Ctx, target: BoardTarget): { baud?: number; node?: string } {
  if (!target.app || !target.config) {
    return {};
  }
  const paths = ctx.deps.services.artifactPaths(target.app, target.config);
  const dtsPath = paths.dtsPath;
  if (!dtsPath || !fs.existsSync(dtsPath)) {
    return {};
  }
  try {
    const report = readZephyrDeviceTreeReport({ dtsPath, westWorkspaceRoot: paths.westWorkspaceRoot, appRootPath: paths.appRootPath });
    const text = report.rawTruncated ? fs.readFileSync(dtsPath, 'utf8') : report.rawText;
    const found = consoleSpeedFromDevicetree(report.nodes, text.split(/\r?\n/));
    return found ? { node: found.node, ...(found.baud ? { baud: found.baud } : {}) } : {};
  } catch {
    // An unreadable devicetree only loses a default.
    return {};
  }
}

function helperFor(ctx: Ctx, app?: ZephyrApplication): HelperCommand {
  return serialHelper.resolve(ctx.deps.extensionContext?.extensionUri?.fsPath ?? '', app);
}

/** The arguments that name the same application and configuration again. */
function targetArgs(target: BoardTarget) {
  return {
    ...(target.app ? { app_path: target.app.appRootPath } : {}),
    ...(target.config ? { config_name: target.config.name } : {}),
  };
}

function targetFields(target: BoardTarget) {
  return {
    ...(target.app ? { app_path: target.app.appRootPath } : {}),
    ...(target.config ? { config_name: target.config.name } : {}),
    ...(target.board ? { board: target.board } : {}),
  };
}

const text = (value: string | null | undefined) => (value && value !== 'n/a' ? value : undefined);

function describePort(port: ListedPort, board: string | undefined) {
  const holder = serialCaptures.byPort(normalizePort(port.port));
  return {
    port: port.port,
    ...(text(port.description) ? { description: port.description } : {}),
    ...(text(port.hwid) ? { hwid: port.hwid } : {}),
    ...(usbId(port.vid) ? { vid: usbId(port.vid) } : {}),
    ...(usbId(port.pid) ? { pid: usbId(port.pid) } : {}),
    ...(text(port.serial_number) ? { serial_number: port.serial_number } : {}),
    ...(text(port.manufacturer) ? { manufacturer: port.manufacturer } : {}),
    ...(text(port.product) ? { product: port.product } : {}),
    ...(text(port.location) ? { location: port.location } : {}),
    ...(text(port.interface) ? { interface: port.interface } : {}),
    usb: isUsbPort(port),
    ...(board ? { matches_board: matchesBoard(port, board) } : {}),
    ...(holder?.jobId ? { captured_by_job: holder.jobId } : {}),
  };
}

function portChoiceError(choice: Extract<PortChoice, { ok: false }>, requested: string | undefined, board: string | undefined): McpToolError {
  const listed = choice.candidates.map(port => ({ port: port.port, ...(text(port.description) ? { description: port.description } : {}) }));
  if (choice.reason === 'unknown_port') {
    return invalid(`"${logSafe(requested, 200)}" is not one of the serial ports of this machine.`,
      'Call hardware with action "list_ports" and pass one of the port values it returns, exactly as written.', { ports: listed });
  }
  if (choice.reason === 'no_usb_port') {
    return invalid('No USB serial port is connected. Ports without a USB id, such as Bluetooth ones, are only opened when named.',
      'Ask the user to connect the board through the USB port of its debug probe, then retry; pass port to open a port without a USB id.', { ports: listed });
  }
  return invalid(`${listed.length} USB serial ports could be the console${board ? ` of ${board}` : ''}, so port is required.`,
    'Pass port, one of details.candidates. Call hardware with action "list_ports" to see their descriptions.', { candidates: listed });
}

/** A symbolic link the agent named, resolved to the device it points at. */
function canonicalPort(requested: string): string | undefined {
  if (process.platform === 'win32' || !path.isAbsolute(requested)) {
    return undefined;
  }
  try {
    return fs.realpathSync(requested);
  } catch {
    return undefined;
  }
}

// list_ports

export async function listSerialPorts(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  checkStrings(args, ['app_path', 'config_name']);
  const target = await boardTarget(ctx, args);
  const ports = await listPorts(helperFor(ctx, target.app), ctx.signal);
  const choice = choosePort(ports, { board: target.board });
  return {
    ...targetFields(target),
    ports: ports.map(port => describePort(port, target.board)),
    ...(choice.ok ? { default_port: choice.port.port, default_port_source: choice.source } : {}),
    next: choice.ok
      ? `Capture it with hardware ${JSON.stringify({ action: 'serial_start', ...targetArgs(target), port: choice.port.port })} before resetting or flashing the board.`
      : `Pass the port to capture to hardware {"action": "serial_start", "port": "..."${target.app ? `, "app_path": ${JSON.stringify(target.app.appRootPath)}` : ''}}; none can be picked on its own.`,
  };
}

// serial_start

/** Wait for the port to open or fail, at most OPEN_WAIT_MS after the helper is ready. */
async function earlyOutcome(capture: SerialCapture): Promise<OpenOutcome | undefined> {
  let timer: NodeJS.Timeout | undefined;
  let cap: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      capture.opened,
      capture.ready.then(() => new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), OPEN_WAIT_MS); })),
      new Promise<undefined>(resolve => { cap = setTimeout(() => resolve(undefined), OPEN_WAIT_CAP_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
    clearTimeout(cap);
  }
}

async function openError(outcome: Extract<OpenOutcome, { ok: false }>, port: string): Promise<McpToolError> {
  switch (outcome.code) {
    case 'pyserial_missing':
      return pyserialMissing(outcome.message);
    case 'busy': {
      const holders = await serialHelper.findHolder(port, outcome.pid).catch(() => []);
      const named = holders.map(holder => `${holder.name ? `"${holder.name}" ` : ''}(pid ${holder.pid})`).join(', ');
      const inThisWindow = holders.some(holder => holder.thisWindow);
      if (holders.some(holder => holder.workbenchCapture)) {
        return new McpToolError('BUSY_EXTERNAL', `${port} is already captured by Zephyr Workbench in another VS Code window. A serial port opens in one program at a time.`, {
          hint: 'Call get_status with all_windows true to find that capture among running_jobs, then read it with hardware action "serial_read" or stop it with "serial_stop", passing its job_id.',
          details: { port, holders },
        });
      }
      return new McpToolError('BUSY_EXTERNAL', `${port} is in use by another program${named ? `: ${named}` : ''}. A serial port opens in one program at a time.`, {
        hint: inThisWindow
          ? 'It is open in this VS Code window, in the Serial Monitor or another extension. Ask the user to close it there, then retry.'
          : 'Ask the user to close the program that holds it (a serial monitor, screen, minicom or another terminal), then retry.',
        details: { port, ...(holders.length > 0 ? { holders } : {}) },
      });
    }
    case 'not_found':
      return invalid(`${port} went away before it could be opened: ${outcome.message}`,
        'Call hardware with action "list_ports" to see the ports connected now.');
    case 'permission':
      return new McpToolError('ENV_NOT_READY', `This account may not open ${port}: ${outcome.message}`, {
        hint: 'On Linux, ask the user to add their account to the group that owns the port (usually dialout) and log in again, then retry.',
      });
    default:
      return new McpToolError('INTERNAL', `The serial capture of ${port} failed: ${outcome.message}`);
  }
}

function waitForView(pattern: string, result: WaitResult) {
  return {
    pattern,
    matched: !!result.hit,
    ...(result.hit ? { line: result.hit.line, offset: result.hit.offset } : {}),
    ...(!result.hit && result.ended ? { capture_ended: true } : {}),
  };
}

function readHint(jobId: string, offset: number): string {
  return `hardware {"action": "serial_read", "job_id": "${jobId}", "offset": ${offset}}`;
}

function captureNext(view: JobView, port: string, offset: number, waited?: WaitResult): string {
  if (view.status !== 'running') {
    return `The capture has ended. Read its output with ${readHint(view.job_id, 0)}.`;
  }
  const rest = 'Add wait_for to wait for a line, send the board a line with action "serial_send", and stop the capture with '
    + `hardware {"action": "serial_stop", "job_id": "${view.job_id}"} when done. It stays running until then or until duration_sec, `
    + 'so read it with serial_read rather than polling job status.';
  if (waited?.hit) {
    return `The board printed the line you waited for. Read what follows with ${readHint(view.job_id, offset)}. ${rest}`;
  }
  if (waited) {
    return `Nothing matched yet. Read what the board printed meanwhile with ${readHint(view.job_id, offset)}, or reset or flash it now and `
      + `wait again with serial_read and wait_for. ${rest}`;
  }
  return `Capturing ${port}: reset or flash the board now to see it boot. Read the output with ${readHint(view.job_id, offset)}. ${rest}`;
}

export async function serialStart(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  const { jobs, defaultWaitSeconds } = ctx.deps;
  checkStrings(args, ['app_path', 'config_name', 'port', 'wait_for']);
  const requested = args.port !== undefined ? assertPortArgument(args.port) : undefined;
  const baudArg = args.baud_rate !== undefined ? assertBaudRate(args.baud_rate) : undefined;
  const durationSec = args.duration_sec !== undefined ? assertDuration(args.duration_sec) : DURATION_DEFAULT_SEC;
  const pattern = str(args.wait_for);
  const matches = matcherFor(pattern);
  const waitSec = waitSecOf(args, defaultWaitSeconds);

  const target = await boardTarget(ctx, args);
  const helper = helperFor(ctx, target.app);
  const ports = await listPorts(helper, ctx.signal);
  const choice = choosePort(ports, { requested, board: target.board, ...(requested ? { canonical: canonicalPort(requested) } : {}) });
  if (!choice.ok) {
    throw portChoiceError(choice, requested, target.board);
  }
  const port = choice.port.port;
  const key = normalizePort(port);

  // No await from here to jobs.start: two calls racing for the port see each other.
  const running = serialCaptures.byPort(key);
  // Without a baud_rate, a repeated start joins the capture running on the port.
  const fromDevicetree = baudArg === undefined && !running ? devicetreeConsole(ctx, target) : {};
  const baud = baudArg ?? running?.info.baud ?? fromDevicetree.baud ?? DEFAULT_BAUD;
  const baudSource = baudArg !== undefined ? 'argument' : fromDevicetree.baud !== undefined ? 'devicetree' : 'default';
  if (running && running.info.baud !== baud) {
    throw new McpToolError('BUSY', `${port} is already captured at ${running.info.baud} baud (job_id "${running.jobId}").`, {
      hint: `Read that capture with ${readHint(running.jobId ?? '', 0)}, or stop it with hardware {"action": "serial_stop", "job_id": "${running.jobId}"} and start again at ${baud} baud.`,
      details: { job_id: running.jobId, port, baud_rate: running.info.baud },
    });
  }
  const capture = new SerialCapture({
    port, key, baud, portSource: choice.source, baudSource, durationSec,
    ...(baudSource === 'devicetree' && fromDevicetree.node ? { consoleNode: fromDevicetree.node } : {}),
    ...(wantsDtr(choice.port) ? { raiseDtr: true } : {}),
    ...(target.app ? { appPath: target.app.appRootPath } : {}),
    ...(target.config ? { configName: target.config.name } : {}),
    ...(target.board ? { board: target.board } : {}),
  });
  const { job, attached } = jobs.start({
    kind: 'serial',
    // Deliberately no appPath: a capture reads a port, and must not make the
    // application look busy to the tools that change it.
    lockKey: `serial:${key}`,
    requestKey: `serial:${key}:${baud}`,
    parse: false,
    command: `serial capture of ${port} at ${baud} baud`,
    run: async (sink, signal) => {
      try {
        return await capture.execute(helper, sink, signal, {
          reveal: REVEAL[ctx.deps.revealTerminal] ?? vscode.TaskRevealKind.Silent,
          header: `> [agent ${ctx.client.name ?? 'mcp'}] serial capture of ${port} at ${baud} baud`,
          ...(target.app ? { scope: target.app.appWorkspaceFolder } : {}),
        });
      } finally {
        serialCaptures.delete(capture);
      }
    },
    runningNext: view => captureNext(view, port, 0),
    next: view => `The capture has ended. Read its output with ${readHint(view.job_id, 0)}.`,
  });
  ctx.audit.jobId = job.id;
  const active = attached ? (serialCaptures.byJob(job.id) ?? capture) : capture;
  if (!attached) {
    capture.attachJob(job.id, () => job.log.size);
    serialCaptures.add(capture);
    const outcome = await earlyOutcome(capture);
    if (outcome && !outcome.ok) {
      throw await openError(outcome, port);
    }
  }

  let waited: WaitResult | undefined;
  // The capture's whole output: a repeated start may join one whose line came already.
  const waitFrom = 0;
  if (matches && pattern) {
    waited = await waitForDeviceLine({
      file: job.log.filePath, from: waitFrom, matches, capture: active,
      deadline: Date.now() + remainingWaitMs(ctx, waitSec), signal: ctx.signal,
      tick: () => ctx.progress({ progress: Math.round((Date.now() - ctx.startedAt) / 1000), message: `Waiting for "${pattern}" on ${port}` }),
    });
  }
  // After a match, what follows the line; after a miss, everything the wait
  // looked at, which is what explains the miss.
  const nextOffset = waited ? (waited.hit ? waited.resumeAt : waitFrom) : job.log.size;
  const view = jobs.view(job, { attached });
  return {
    ...view,
    ...targetFields(target),
    port,
    port_source: active.info.portSource,
    ...(choice.ok && choice.note ? { port_note: choice.note } : {}),
    baud_rate: active.info.baud,
    baud_source: active.info.baudSource,
    ...(active.info.consoleNode ? { console_node: active.info.consoleNode } : {}),
    duration_sec: active.info.durationSec,
    ...(active.info.raiseDtr ? { dtr_raised: true } : {}),
    next_offset: nextOffset,
    ...(waited && pattern ? { wait_for: waitForView(pattern, waited) } : {}),
    next: captureNext(view, port, nextOffset, waited),
  };
}

// Finding the capture a read, send or stop is about

interface CaptureRef {
  job: JobState | PersistedJob;
  /** Present while the capture runs. */
  capture?: SerialCapture;
  port?: string;
}

function isSerialJob(job: JobState | PersistedJob): boolean {
  return (isPersisted(job) ? job.view.kind : job.spec.kind) === 'serial';
}

function statusOf(job: JobState | PersistedJob) {
  return isPersisted(job) ? job.view.status : job.status;
}

function portOf(job: JobState | PersistedJob, capture?: SerialCapture): string | undefined {
  if (capture) {
    return capture.info.port;
  }
  const result = isPersisted(job) ? job.view.result : job.result;
  return typeof result?.port === 'string' ? result.port : undefined;
}

/**
 * The capture named by job_id or port, or the only one running. A port finds
 * the capture running on it, else the latest one this window still holds,
 * by any name serial_start accepts for it: a symbolic link, or on macOS the
 * /dev/tty.* twin of the /dev/cu.* port it opened.
 */
async function findCapture(ctx: Ctx, args: Record<string, unknown>, action: string): Promise<CaptureRef> {
  const { jobs } = ctx.deps;
  const jobId = str(args.job_id);
  if (jobId !== undefined) {
    const job = jobs.get(jobId);
    if (!isSerialJob(job)) {
      throw invalid(`Job "${jobId}" is not a serial capture.`, 'Pass the job_id that hardware action "serial_start" returned.');
    }
    const capture = serialCaptures.byJob(jobId);
    return { job, capture, port: portOf(job, capture) };
  }
  if (args.port !== undefined) {
    const requested = assertPortArgument(args.port);
    const keys = portKeys(requested, { canonical: canonicalPort(requested) });
    const capture = keys.map(key => serialCaptures.byPort(key)).find(found => found?.jobId);
    const job = capture?.jobId ? jobs.get(capture.jobId)
      : jobs.list().find(candidate => candidate.spec.kind === 'serial' && keys.some(key => candidate.spec.lockKey === `serial:${key}`))
        // One known only from its record, after the extension host restarted.
        ?? jobs.listPersisted(view => view.kind === 'serial' && typeof view.result?.port === 'string'
          && keys.includes(normalizePort(view.result.port)), 1)[0];
    if (!job) {
      throw invalid(`No capture of ${logSafe(requested, 200)} is known in this VS Code window.`,
        `Start one with hardware {"action": "serial_start", "port": "${logSafe(requested, 200)}"}.`);
    }
    return { job, capture, port: portOf(job, capture) ?? requested };
  }
  let runningNow = serialCaptures.list().filter(capture => !capture.ended && capture.jobId);
  if (args.app_path !== undefined || args.config_name !== undefined) {
    // The capture serial_start made for that application.
    const { app, config } = await ctx.deps.services.resolveTarget(str(args.app_path), str(args.config_name));
    const root = normalizeForCompare(app.appRootPath);
    const own = runningNow.filter(capture => capture.info.appPath && normalizeForCompare(capture.info.appPath) === root
      && (args.config_name === undefined || capture.info.configName === config.name));
    if (own.length === 0) {
      throw invalid(`No capture of ${app.appName} is running in this VS Code window.`,
        `Pass the job_id that serial_start returned, or start one with hardware {"action": "serial_start", "app_path": ${JSON.stringify(app.appRootPath)}}.`);
    }
    runningNow = own;
  }
  if (runningNow.length === 1) {
    const capture = runningNow[0];
    return { job: jobs.get(capture.jobId as string), capture, port: capture.info.port };
  }
  throw invalid(runningNow.length === 0
    ? `${action} needs a capture, and none is running in this VS Code window.`
    : `${runningNow.length} captures are running, so ${action} needs job_id or port.`,
  runningNow.length === 0
    ? 'Pass the job_id that serial_start returned, or start a capture with hardware {"action": "serial_start"}.'
    : 'Pass one of the job ids in details.',
  runningNow.length > 0 ? { captures: runningNow.map(capture => ({ job_id: capture.jobId, port: capture.info.port })) } : undefined);
}

/** A capture that is running now, or a refusal that says how to start one. */
async function runningCapture(ctx: Ctx, args: Record<string, unknown>, action: string): Promise<{ capture: SerialCapture; job: JobState }> {
  const ref = await findCapture(ctx, args, action);
  if (!ref.capture || ref.capture.ended || isPersisted(ref.job)) {
    const port = ref.port ?? str(args.port);
    throw invalid(`The capture${port ? ` of ${port}` : ''} (job_id "${ref.job.id}") has ended, so ${action} has nothing to act on.`,
      `Start a new one with hardware {"action": "serial_start"${port ? `, "port": ${JSON.stringify(port)}` : ''}}.`);
  }
  return { capture: ref.capture, job: ref.job };
}

// serial_read

export async function serialRead(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  checkStrings(args, ['job_id', 'port', 'app_path', 'config_name', 'grep', 'wait_for']);
  const offset = args.offset !== undefined ? assertOffset(args.offset) : 0;
  const maxChars = args.max_chars !== undefined ? assertMaxChars(args.max_chars) : READ_DEFAULT_CHARS;
  const pattern = str(args.wait_for);
  const matches = matcherFor(pattern);
  const grep = str(args.grep);
  const grepMatches = matcherFor(grep);
  // Waits only when asked to: with wait_for for a line, with wait_sec alone for any output.
  const waitSec = waitSecOf(args, matches ? ctx.deps.defaultWaitSeconds : 0);

  const { job, capture, port } = await findCapture(ctx, args, 'serial_read');
  const file = job.log.filePath;
  const deadline = Date.now() + remainingWaitMs(ctx, waitSec);
  let waited: WaitResult | undefined;
  if (matches && pattern) {
    waited = await waitForDeviceLine({
      file, from: offset, matches, capture, deadline, signal: ctx.signal,
      tick: () => ctx.progress({ progress: Math.round((Date.now() - ctx.startedAt) / 1000), message: `Waiting for "${pattern}"${port ? ` on ${port}` : ''}` }),
    });
  } else if (waitSec > 0) {
    await waitForOutput(file, offset, capture, deadline, ctx.signal);
  }
  const slice = grepMatches ? grepSlice(file, offset, grepMatches, maxChars) : readSlice(file, offset, maxChars);
  const status = statusOf(job);
  const again = `${readHint(job.id, slice.next_offset)}${grep ? ` with the same grep` : ''}`;
  return {
    job_id: job.id,
    status,
    ...(port ? { port } : {}),
    ...(isPersisted(job) ? { persisted: true } : {}),
    ...slice,
    ...(grep ? { grep } : {}),
    ...(waited && pattern ? { wait_for: waitForView(pattern, waited) } : {}),
    next: slice.more
      ? `More output is already captured: call ${again}.`
      : status === 'running'
        ? `That is everything so far. Call ${again} later, with wait_for or wait_sec to wait for more.`
        : 'The capture has ended and this is the end of its output.',
  };
}

// serial_send

export async function serialSend(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  checkStrings(args, ['job_id', 'port', 'app_path', 'config_name', 'wait_for']);
  const lineEnding = assertLineEnding(args.line_ending);
  const sent = assertSendText(args.text, lineEnding);
  const pattern = str(args.wait_for);
  const matches = matcherFor(pattern);
  const waitSec = waitSecOf(args, ctx.deps.defaultWaitSeconds);

  const { capture, job } = await runningCapture(ctx, args, 'serial_send');
  ctx.audit.jobId = job.id;
  const { port, key } = capture.info;
  if (capture.state === 'disconnected') {
    throw new McpToolError('BUSY', `The board on ${port} is disconnected right now; the capture reopens it when it comes back.`, {
      hint: 'Retry in a few seconds, once the board is back.',
      details: { job_id: job.id, port },
    });
  }

  // The text is part of the subject, so an answer given late to one send is
  // never taken for a different text; Allow for This Session covers the port.
  const subject: ConfirmSubject & { text: string } = {
    summary: `send ${quoteForDialog(sent)} to the board on ${port}`,
    ...(capture.info.appPath ? { appPath: capture.info.appPath } : {}),
    ...(capture.info.configName ? { configName: capture.info.configName } : {}),
    ...(capture.info.board ? { board: capture.info.board } : {}),
    scope: `serial:${key}`,
    scopeLabel: 'this serial port',
    text: sent,
  };
  const outcome = await ctx.deps.confirmations.require(ctx, args, subject);
  // Read again: the dialog may have stayed open for a while.
  const stateNow = capture.state as SerialCapture['state'];
  if (capture.ended || stateNow === 'disconnected') {
    throw new McpToolError('BUSY', `The capture of ${port} ${capture.ended ? 'ended' : 'lost the board'} while waiting for the confirmation, so nothing was sent.`, {
      hint: capture.ended ? 'Start a new capture with hardware {"action": "serial_start"}, then send again.' : 'Retry in a few seconds, once the board is back.',
    });
  }

  const { offset, ack } = capture.send(sent, lineEnding);
  const written = await ack;
  if (written.event !== 'sent') {
    throw new McpToolError('BUSY', `The text was not sent to ${port}: ${written.message ?? 'the write failed'}.`, {
      hint: 'Read the capture with hardware action "serial_read" to see what happened, then retry.',
      details: { job_id: job.id, port },
    });
  }
  let waited: WaitResult | undefined;
  if (matches && pattern) {
    waited = await waitForDeviceLine({
      file: job.log.filePath, from: offset, matches, capture,
      deadline: Date.now() + remainingWaitMs(ctx, waitSec), signal: ctx.signal,
      tick: () => ctx.progress({ progress: Math.round((Date.now() - ctx.startedAt) / 1000), message: `Waiting for "${pattern}" on ${port}` }),
    });
  }
  const reply = readSlice(job.log.filePath, offset, READ_DEFAULT_CHARS);
  return {
    job_id: job.id,
    port,
    sent: { text: sent, line_ending: lineEnding, bytes: written.bytes },
    ...(outcome === 'not-required' || outcome === 'not-asked' ? {} : { confirmation: { category: ctx.audit.confirmCategory, outcome } }),
    // The device's answer so far, from the send on.
    text: reply.text,
    offset,
    next_offset: reply.next_offset,
    more: reply.more,
    ...(waited && pattern ? { wait_for: waitForView(pattern, waited) } : {}),
    next: `Read more of the answer with ${readHint(job.id, reply.next_offset)}, adding wait_for to wait for a line.`,
  };
}

// serial_stop

export async function serialStop(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  checkStrings(args, ['job_id', 'port', 'app_path', 'config_name']);
  const { jobs } = ctx.deps;
  const { job, capture, port } = await findCapture(ctx, args, 'serial_stop');
  ctx.audit.jobId = job.id;
  const wasRunning = !!capture && !capture.ended;
  if (capture && wasRunning) {
    await capture.stop('agent');
  }
  if (isPersisted(job)) {
    return { ...job.view, ...(port ? { port } : {}), stopped: false };
  }
  // The job ends right after its helper; wait for its final record.
  await jobs.wait(job, 5000, { signal: ctx.signal });
  const view = jobs.view(job);
  return {
    ...view,
    ...(port ? { port } : {}),
    stopped: wasRunning,
    next: `Read the whole capture with ${readHint(job.id, 0)}.`,
  };
}
