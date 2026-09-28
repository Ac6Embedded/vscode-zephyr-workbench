// manage_runners: install and configure the flash and debug runner tools, as
// the Install Runners panel and the pyOCD Manager do, with nothing shown but
// the confirmation dialog and the job's terminal. Also removes the pyOCD packs
// for remove_or_delete.
//
// Every action changes ~/.zinstaller, which every window and every Zephyr
// terminal of the machine reads, so each one is checked in full, then asked
// about once with the scope "runners", and only then acts.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getDebugSessionVenvPath } from '../../../utils/debugTools/debugUtils';
import {
  removeRunnerPath, saveDoNotUse, saveRunnerPath, setDebugToolAliasDefault,
} from '../../../utils/debugTools/debugToolEnvUtils';
import {
  DebugToolEnvData, expandDebugToolPack, getConfiguredDebugToolPath, getDebugToolLicense, getDebugToolPacks,
  getDefaultToolIdForAlias, isDebugToolCompatible, isDebugToolDetectOnly, isDebugToolPathEditable,
  listDebugToolSelectors, ManifestDebugTool, resolveDebugToolSelectors,
} from '../../../utils/debugTools/debugToolManifestUtils';
import { getDebugToolExecutableName } from '../../../utils/debugTools/debugToolStatusUtils';
import { DebugToolsManifest } from '../../../utils/debugTools/debugToolVersionUtils';
import { installPyOCDTargetSupport } from '../../../utils/debugTools/pyocdTargetSetup';
import { getEnvYamlPath, readEnvYamlObjectStrict } from '../../../utils/env/envYamlFileUtils';
import { getExtraPaths, normalizePath, setExtraPaths } from '../../../utils/env/envYamlUtils';
import { normalizeForCompare } from '../../core/argSafety';
import { McpToolError, toToolError } from '../../core/errors';
import { logSafe } from '../../core/redact';
import { MANAGE_RUNNERS_ACTIONS, ManageRunnersAction } from '../../core/tools/manageRunners';
import { confirmCategoryOf, ToolContext, ToolHandler } from '../../core/toolSpec';
import { isWorking, JobRunResult, JobSpec, JobState, JobView } from '../../jobs/jobManager';
import { ConfirmOutcome, ConfirmSubject } from '../confirmations';
import { runnerTools } from '../runnerTools';
import { HostDeps } from './deps';
import { progressWait, remainingWaitMs } from './progress';
import { manifestOf, manifestTools, probeRunnerTools, pyocdMissingHint, PyocdVenvOwner, pyocdVenvOwner, runnerEnvData } from './runnerToolsView';
import { bool, checkTypes, invalid, num, refuseUnexpected, str } from './toolchainArgs';
import { cancellationTokenFor } from './toolchainJobs';

type Ctx = ToolContext<HostDeps>;

/**
 * Every runner job of a window holds this lock: the installers share the
 * download folder and env.yml, and the pyOCD pack store is one per user.
 */
export const RUNNER_TOOLS_LOCK = 'runner-tools';

const SCOPE = 'runners';
const SCOPE_LABEL = 'the runners of this machine';
const INSTALL_RUNNERS_COMMAND = '"Zephyr Workbench: Install Runners"';

/** The arguments each action takes besides action and dry_run. */
const ACTION_ARGS: Readonly<Record<ManageRunnersAction, readonly string[]>> = {
  install: ['tools', 'pack', 'accept_license', 'wait_sec'],
  set_path: ['tool', 'path'],
  set_default: ['tool'],
  set_add_to_path: ['tool', 'add_to_path'],
  extra_paths: ['extra_paths'],
  pyocd_update_index: ['wait_sec'],
  pyocd_install_pack: ['pyocd_target', 'app_path', 'config_name', 'wait_sec'],
};

const REVEAL: Record<string, vscode.TaskRevealKind> = {
  always: vscode.TaskRevealKind.Always,
  silent: vscode.TaskRevealKind.Silent,
  never: vscode.TaskRevealKind.Never,
};

/**
 * A path that goes into env.yml, from which the environment scripts write
 * `PATH="<path>:..."` lines that PowerShell, bash and cmd expand: no `$`,
 * backquote, `%` or quote, which those shells would run or expand. Parentheses
 * are kept for "Program Files (x86)".
 */
const ENV_PATH = /^[\p{L}\p{M}\p{N}_.\-/\\: +@=~()]+$/u;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Shared checks and answers

function subjectOf(summary: string, args: Record<string, unknown>, folder?: string): ConfirmSubject {
  const { wait_sec: _waitSec, ...request } = args;
  // The request is part of the subject, so an answer given late to one call
  // is never taken for another.
  const subject: ConfirmSubject & { request: Record<string, unknown> } = {
    summary, ...(folder ? { folder } : {}), scope: SCOPE, scopeLabel: SCOPE_LABEL, request,
  };
  return subject;
}

function confirmationOf(ctx: Ctx, outcome: ConfirmOutcome) {
  return outcome === 'not-required' || outcome === 'not-asked'
    ? undefined
    : { category: ctx.audit.confirmCategory, outcome };
}

/** Whether a real call would ask, for a dry run to say so. */
function confirmationRequired(ctx: Ctx, args: Record<string, unknown>, always = false): boolean {
  const category = confirmCategoryOf(ctx.tool, args);
  return !!category && (always || ctx.deps.permissionOf(ctx.tool) === 'ask');
}

/**
 * A folder an agent gives for env.yml: absolute, existing, and safe in the
 * environment scripts, which put it on PATH as is, where a program file finds nothing.
 */
function assertEnvPath(value: string, label: string): string {
  const trimmed = value.trim();
  if (!path.isAbsolute(trimmed) || !ENV_PATH.test(trimmed)) {
    throw invalid(`${label} must be an absolute path of letters, digits, spaces and _ . - / \\ : + @ = ~ ( ), not "${logSafe(trimmed, 200)}".`);
  }
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(trimmed);
  } catch {
    stat = undefined;
  }
  if (!stat?.isDirectory()) {
    throw invalid(`${label} "${trimmed}" is not an existing folder.`,
      stat ? 'Pass the folder that holds the program, not the program itself.' : 'Pass the folder the tool was installed in, as the user sees it on this machine.');
  }
  return path.resolve(trimmed);
}

/**
 * env.yml must exist and parse before it is edited: it is written by the host
 * tools install, and an unreadable one would otherwise be replaced by an
 * almost empty file.
 */
function assertEnvYaml(): void {
  const envYaml = getEnvYamlPath();
  if (!fs.existsSync(envYaml)) {
    throw new McpToolError('ENV_NOT_READY', `The host tools are not installed: ${envYaml} does not exist.`, {
      hint: 'Call check_environment to see what is missing, then ask the user to run "Install Host Tools".',
    });
  }
  try {
    readEnvYamlObjectStrict();
  } catch (error) {
    throw new McpToolError('ENV_NOT_READY', `${envYaml} cannot be parsed, so it is left untouched: ${messageOf(error)}`, {
      hint: 'Ask the user to fix or reinstall the host tools configuration, then retry.',
    });
  }
}

/** What env.yml records for a tool or alias now. */
function storedEntry(id: string): Record<string, unknown> {
  const entry = (readEnvYamlObjectStrict()?.runners ?? {})[id];
  return entry && typeof entry === 'object' && !Array.isArray(entry) ? { ...entry } : {};
}

function toolName(tool: ManifestDebugTool | undefined, id: string): string {
  return tool?.name?.trim() || id;
}

/** A tool or alias id of the manifest; anything else is refused with the valid ids. */
function manifestEntry(manifest: DebugToolsManifest, id: string): { tool?: ManifestDebugTool; alias?: string } {
  const tool = manifestTools(manifest).find(t => t.tool === id);
  if (tool) {
    return { tool };
  }
  if ((manifest.aliases ?? []).some(alias => alias.alias === id)) {
    return { alias: id };
  }
  throw invalid(`"${logSafe(id, 64)}" is not a tool or an alias of the workbench runner manifest.`,
    'Use an id from details.available, as list_runners with all_tools true returns them.',
    { available: [...manifestTools(manifest).map(t => t.tool), ...(manifest.aliases ?? []).map(a => a.alias)].sort() });
}

/** The user can set the path of this tool or alias, as the Install Runners panel lets them. */
function assertPathEditable(manifest: DebugToolsManifest, id: string, what: string): { tool?: ManifestDebugTool; alias?: string } {
  const entry = manifestEntry(manifest, id);
  if (!isDebugToolPathEditable(manifest, id)) {
    if (entry.tool?.alias) {
      throw invalid(`${id} is a variant of "${entry.tool.alias}", which holds the path: ${what} applies to "${entry.tool.alias}".`,
        `Pass tool "${entry.tool.alias}", and pick the variant with manage_runners action "set_default".`);
    }
    throw invalid(`The workbench finds ${toolName(entry.tool, id)} on its own, so its ${what} cannot be set.`);
  }
  return entry;
}

async function waitAndView(ctx: Ctx, job: JobState, attached: boolean, waitSec: number, confirmation?: ReturnType<typeof confirmationOf>): Promise<JobView & Record<string, unknown>> {
  const { jobs } = ctx.deps;
  ctx.audit.jobId = job.id;
  await jobs.wait(job, remainingWaitMs(ctx, waitSec), progressWait(ctx, jobs));
  return { ...jobs.view(job, { attached, parse: false }), ...(confirmation ? { confirmation } : {}) };
}

/** A job running for exactly this request, which a repeated call joins instead of asking again. */
function runningJob(ctx: Ctx, requestKey: string): JobState | undefined {
  return ctx.deps.jobs.findAttachable({ kind: 'install', lockKey: RUNNER_TOOLS_LOCK, requestKey, command: '', run: async () => ({}) });
}

/**
 * Refuse before the user is asked while another runner job of this window
 * works: they share the installers' download folder, env.yml and the pack store.
 */
function assertNoRunnerJob(ctx: Ctx): void {
  const running = ctx.deps.jobs.list().find(job => isWorking(job) && job.spec.lockKey === RUNNER_TOOLS_LOCK);
  if (running) {
    throw new McpToolError('BUSY', `A runner job is already running in this window (job_id "${running.id}"): ${running.spec.command}.`, {
      hint: `Wait for it with job {"action": "status", "job_id": "${running.id}"}, then retry.`,
      details: { job_id: running.id, kind: running.spec.kind, status: running.status },
    });
  }
}

/** Start a runner job in a terminal of its own, and wait the call's budget for it. */
async function startRunnerJob(
  ctx: Ctx, args: Record<string, unknown>, outcome: ConfirmOutcome,
  spec: Omit<JobSpec, 'lockKey' | 'parse'>,
): Promise<Record<string, unknown>> {
  const { job, attached } = ctx.deps.jobs.start({ ...spec, lockKey: RUNNER_TOOLS_LOCK, parse: false });
  return waitAndView(ctx, job, attached, num(args.wait_sec) ?? ctx.deps.defaultWaitSeconds, confirmationOf(ctx, outcome));
}

function stepOptions(ctx: Ctx) {
  return { reveal: REVEAL[ctx.deps.revealTerminal] ?? vscode.TaskRevealKind.Silent, header: `> [agent ${ctx.client.name ?? 'mcp'}] manage_runners` };
}

function failedNext(view: JobView, what: string): string {
  if (view.status === 'cancelled') {
    return `The ${what} was cancelled. Call manage_runners again to retry.`;
  }
  return `The ${what} failed: see result.error and the log (job {"action": "log", "job_id": "${view.job_id}"}).`;
}

// install

interface VendorPage {
  id: string;
  name: string;
  website?: string;
  reason: 'detect_only' | 'not_for_this_os';
  /** The id set_path takes for it (its alias for a variant), when the user may set its path at all. */
  path_tool?: string;
}

function vendorPage(manifest: DebugToolsManifest, tool: ManifestDebugTool, reason: VendorPage['reason']): VendorPage {
  const pathTool = tool.alias ?? tool.tool;
  return {
    id: tool.tool,
    name: toolName(tool, tool.tool),
    ...(tool.website ? { website: tool.website } : {}),
    reason,
    ...(isDebugToolPathEditable(manifest, pathTool) ? { path_tool: pathTool } : {}),
  };
}

const OS_KEYS: Record<string, string> = { windows: 'win32', linux: 'linux', darwin: 'darwin' };

/** The tools an install call names, and what it cannot install for the user. */
function selectInstall(args: Record<string, unknown>, manifest: DebugToolsManifest, envData: DebugToolEnvData | undefined, platform: NodeJS.Platform) {
  const names = args.tools as string[] | undefined;
  const pack = str(args.pack);
  if (names && pack !== undefined) {
    throw invalid('install takes tools or pack, not both.');
  }
  if (pack !== undefined) {
    const expanded = expandDebugToolPack(manifest, pack, platform);
    if (!expanded) {
      throw invalid(`The runner manifest has no pack "${logSafe(pack, 40)}".`, 'Pass one of details.packs.',
        { packs: getDebugToolPacks(manifest).map(p => p.pack) });
    }
    return {
      install: expanded.install,
      vendorPages: expanded.vendorPages.map(tool => vendorPage(manifest, tool, isDebugToolDetectOnly(tool) ? 'detect_only' : 'not_for_this_os')),
      skipped: expanded.skipped,
    };
  }
  if (!names || names.length === 0) {
    throw invalid('install needs tools or pack.', 'Call list_runners with all_tools true to see the tool ids and packs.');
  }
  const { ids, unknown } = resolveDebugToolSelectors(manifest, names);
  if (unknown.length > 0) {
    throw invalid(`tools has names that are not a tool, an alias or a runner of the workbench runner manifest: ${unknown.map(name => logSafe(name, 64)).join(', ')}.`,
      'Use names from details.available, as list_runners with all_tools true returns them.',
      { available: listDebugToolSelectors(manifest) });
  }
  const install: ManifestDebugTool[] = [];
  const vendorPages: VendorPage[] = [];
  const wrongOs: ManifestDebugTool[] = [];
  const seen = new Set<string>();
  for (const selected of ids) {
    // An alias installs the variant it resolves to, as its panel row does.
    const id = (manifest.aliases ?? []).some(alias => alias.alias === selected)
      ? getDefaultToolIdForAlias(manifest, envData, selected) ?? selected
      : selected;
    const tool = manifestTools(manifest).find(t => t.tool === id);
    if (!tool || seen.has(id)) {
      continue;
    }
    seen.add(id);
    if (isDebugToolDetectOnly(tool)) {
      vendorPages.push(vendorPage(manifest, tool, 'detect_only'));
    } else if (!isDebugToolCompatible(tool, platform)) {
      wrongOs.push(tool);
    } else {
      install.push(tool);
    }
  }
  if (wrongOs.length > 0) {
    throw invalid(`The workbench cannot install ${wrongOs.map(tool => toolName(tool, tool.tool)).join(', ')} on this OS (${platform}).`,
      'Leave them out of tools; list_runners with all_tools true says which tools install here.',
      {
        installs_on: Object.fromEntries(wrongOs.map(tool => [tool.tool,
          Object.entries((tool.os ?? {}) as Record<string, unknown>).filter(([, value]) => !!value).map(([key]) => OS_KEYS[key] ?? key)])),
      });
  }
  return { install, vendorPages, skipped: [] as string[] };
}

function vendorNext(vendorPages: readonly VendorPage[]): string {
  const editable = vendorPages.find(page => page.path_tool);
  return `Ask the user to install ${vendorPages.map(page => page.name).join(', ')} from ${vendorPages.length > 1 ? 'their vendor pages' : 'its vendor page'} (vendor_pages). `
    + 'Once installed, call list_runners with all_tools true to check it is found'
    + (editable ? `; if it is not, record its folder with manage_runners {"action": "set_path", "tool": "${editable.path_tool}", "path": "..."}.` : '.');
}

async function install(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  checkTypes(args, { strings: ['pack'], booleans: ['accept_license', 'dry_run'], stringArrays: ['tools'] });
  const manifest = manifestOf(ctx);
  const platform = runnerTools.platform();
  const envData = runnerEnvData();
  const { install: tools, vendorPages, skipped } = selectInstall(args, manifest, envData, platform);
  const dryRun = bool(args.dry_run) === true;

  if (tools.length === 0) {
    return {
      action: 'install',
      ...(dryRun ? { dry_run: true } : {}),
      installed: [],
      vendor_pages: vendorPages,
      ...(skipped.length > 0 ? { skipped } : {}),
      next: vendorPages.length > 0 ? vendorNext(vendorPages) : 'Nothing in this pack installs on this OS.',
    };
  }

  const licensed = tools.filter(tool => getDebugToolLicense(tool));
  if (licensed.length > 0 && bool(args.accept_license) !== true) {
    const license = getDebugToolLicense(licensed[0])!;
    throw invalid(`The ${toolName(licensed[0], licensed[0].tool)} installer accepts the ${license.name} on the user's behalf, so accept_license must be true.`,
      `Ask the user whether they accept the ${license.name}${license.url ? ` (${license.url})` : ''}, then call manage_runners again with accept_license true.`,
      { license });
  }

  // Linux and macOS elevate root tools with a graphical sudo prompt. The
  // installer's fallback, sudo in a terminal, waits for a password no job
  // can type, so without the graphical prompt the user installs them.
  const elevates = platform === 'linux' || platform === 'darwin';
  const rootTools = tools.filter(tool => tool.root === true);
  if (elevates && rootTools.length > 0) {
    const sudo = runnerTools.guiSudo(platform);
    if (!sudo.available) {
      throw new McpToolError('INTERACTIVE_UNSUPPORTED',
        `${rootTools.map(tool => toolName(tool, tool.tool)).join(', ')} need${rootTools.length === 1 ? 's' : ''} administrator rights, and this ${sudo.reason === 'remote' ? 'remote or WSL session' : 'session without a display'} cannot show the graphical sudo prompt.`, {
          hint: `Ask the user to install ${rootTools.length === 1 ? 'it' : 'them'} from the Install Runners panel (command ${INSTALL_RUNNERS_COMMAND}), where sudo asks for the password in a terminal, or leave ${rootTools.length === 1 ? 'it' : 'them'} out of tools.`,
          details: { needs_admin: rootTools.map(tool => tool.tool) },
        });
    }
  }

  const ids = tools.map(tool => tool.tool);
  const scriptsDir = vscode.Uri.joinPath(ctx.deps.extensionContext.extensionUri, 'scripts', 'runners').fsPath;
  const plan = runnerTools.planInstall(scriptsDir, ids, new Set(rootTools.map(tool => tool.tool)), { platform, quoting: 'argv' });
  if (!plan) {
    throw invalid(`The runner installers do not support this OS (${platform}).`);
  }
  // Built now, so a missing environment script is reported before anyone is asked.
  let task: vscode.Task | undefined;
  if (plan.nonRoot) {
    try {
      task = runnerTools.installTask(plan.nonRoot);
    } catch (error) {
      throw toToolError(error);
    }
  }
  const command = [plan.root ? `sudo ${plan.root.command}` : undefined, plan.nonRoot?.command].filter(Boolean).join(' ; ');
  const needsAdmin = rootTools.length > 0;
  const report = {
    tools: tools.map(tool => ({
      id: tool.tool,
      name: toolName(tool, tool.tool),
      ...(tool.version !== undefined ? { version: String(tool.version).trim() } : {}),
      needs_admin: tool.root === true,
      ...(getDebugToolLicense(tool) ? { license: getDebugToolLicense(tool) } : {}),
    })),
    ...(vendorPages.length > 0 ? { vendor_pages: vendorPages } : {}),
    ...(skipped.length > 0 ? { skipped } : {}),
    needs_admin: needsAdmin,
    ...(needsAdmin ? { admin_prompt: platform === 'win32' ? 'uac' : 'graphical_sudo' } : {}),
    command,
  };
  if (dryRun) {
    return {
      action: 'install', dry_run: true, ...report,
      confirmation_required: confirmationRequired(ctx, args, licensed.length > 0),
      next: 'Call manage_runners again without dry_run to install them.',
    };
  }

  const requestKey = `runners:install:${[...ids].sort().join(',')}`;
  const running = runningJob(ctx, requestKey);
  if (running) {
    return waitAndView(ctx, running, true, num(args.wait_sec) ?? ctx.deps.defaultWaitSeconds);
  }
  assertNoRunnerJob(ctx);
  const names = tools.map(tool => toolName(tool, tool.tool)).join(', ');
  const licenseText = licensed.length > 0
    ? ` and accept the ${getDebugToolLicense(licensed[0])!.name} on your behalf (the J-Link installer accepts them)`
    : '';
  const adminText = needsAdmin ? `; ${platform === 'win32' ? 'Windows' : 'a sudo prompt'} then asks for administrator rights` : '';
  // A license accepted for the user is asked about every time, whatever the
  // permissions say, and never covered by Allow for This Session.
  const outcome = await ctx.deps.confirmations.require(ctx, args,
    subjectOf(`install the runner tools ${names}${licenseText}${adminText}`, args), licensed.length > 0 ? { always: true } : {});

  // pyOCD installs with pip into the global venv: a build using it waits.
  const venvPath = ids.includes('pyocd') ? runnerTools.globalVenv() : undefined;
  return startRunnerJob(ctx, args, outcome, {
    kind: 'install',
    requestKey,
    command,
    ...(venvPath ? { venvPath, writes: ['venv'] } : {}),
    run: (sink, signal) => runInstall(ctx, { plan, task, ids, platform, vendorPages }, sink, signal),
    next: view => {
      if (view.status !== 'succeeded') {
        return failedNext(view, 'install');
      }
      const state = view.result?.warnings
        ? 'The installer ended well, but some tools could not be confirmed (result.warnings)'
        : 'The runner tools are installed';
      return `${state}; result.tools has their state. ${vendorPages.length > 0 ? vendorNext(vendorPages) : 'Flash or debug again.'}`;
    },
  });
}

async function runInstall(
  ctx: Ctx,
  work: {
    plan: NonNullable<ReturnType<typeof runnerTools.planInstall>>;
    task?: vscode.Task;
    ids: string[];
    platform: NodeJS.Platform;
    vendorPages: VendorPage[];
  },
  sink: { onData(text: string): void },
  signal: AbortSignal,
): Promise<JobRunResult> {
  const { plan, task, ids, platform } = work;
  const errors: string[] = [];
  let exitCode: number | undefined = 0;
  if (platform === 'win32' && !(await runnerTools.allowPowershellScripts())) {
    const message = 'PowerShell script execution is disabled for the current user, so the runner installer cannot run. Set the policy to RemoteSigned (Set-ExecutionPolicy -Scope CurrentUser RemoteSigned) and retry.';
    sink.onData(`${message}\n`);
    return { exitCode: 1, extra: { error: message } };
  }
  if (plan.root && !signal.aborted) {
    const root = plan.root;
    const title = 'Installing root-required runners';
    try {
      // sudo-prompt runs the command itself, so the terminal shows its output once it ends.
      await runnerTools.runStep(title, sink, signal, async log => {
        const code = await runnerTools.elevate(root.command, title, log);
        if (code !== 0) {
          throw new Error(`${title} (${root.toolIds.join(', ')}) failed or the sudo prompt was dismissed (exit code ${code}).`);
        }
      }, stepOptions(ctx));
    } catch (error) {
      exitCode = 1;
      errors.push(messageOf(error));
    }
  }
  if (plan.nonRoot && task && !signal.aborted) {
    const run = await runnerTools.runTask(task, sink, signal, stepOptions(ctx));
    if (run.exitCode !== 0) {
      exitCode = run.exitCode === undefined ? undefined : (exitCode === 0 ? run.exitCode : exitCode);
      errors.push(run.exitCode === undefined
        ? (run.started ? 'The installer was stopped.' : 'The installer did not start.')
        : `The installer exited with code ${run.exitCode}.`);
    }
  }
  if (signal.aborted) {
    exitCode = undefined;
  }
  // As the Install Runners panel does after an install, whatever its outcome.
  try {
    await runnerTools.afterInstall(ctx.deps.extensionContext, ids);
  } catch (error) {
    sink.onData(`\nThe runner settings were not refreshed: ${messageOf(error)}\n`);
  }
  let tools: Array<Record<string, unknown>> = [];
  try {
    const { rows } = await probeRunnerTools({ ...ctx, startedAt: Date.now() }, ids);
    tools = rows.map(row => ({
      id: row.id,
      installed: row.installed,
      ...(row.version ? { version: row.version } : {}),
      ...(row.configuredPath ?? row.detectedPath ? { path: row.configuredPath ?? row.detectedPath } : {}),
      ...(row.note ? { note: row.note } : {}),
    }));
  } catch (error) {
    sink.onData(`\nThe installed tools could not be checked: ${messageOf(error)}\n`);
  }
  const missing = tools.filter(tool => tool.installed === false).map(tool => tool.id);
  const unconfirmed = tools.filter(tool => tool.installed === null).map(tool => tool.id);
  if (exitCode === 0 && missing.length > 0) {
    // The installers go on after a tool script fails and still exit 0, and
    // the check runs in a fresh Zephyr environment: a tool it does not find
    // was not installed.
    exitCode = 1;
    errors.push(`The installer ended, but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} still not found; see the log for the step that failed.`);
  } else if (exitCode === 0 && unconfirmed.length > 0) {
    errors.push(`The installer ended well, but ${unconfirmed.join(', ')} could not be confirmed yet; check with list_runners all_tools true from a new call.`);
  }
  return {
    exitCode,
    extra: {
      tools,
      ...(work.vendorPages.length > 0 ? { vendor_pages: work.vendorPages } : {}),
      ...(errors.length > 0 ? { [exitCode === 0 ? 'warnings' : 'error']: errors.join(' ') } : {}),
    },
  };
}

// Settings in env.yml

async function setPath(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  checkTypes(args, { strings: ['tool', 'path'], booleans: ['dry_run'] });
  const id = str(args.tool)?.trim();
  if (!id) {
    throw invalid('set_path needs tool.', 'Call list_runners with all_tools true to see the tool ids.');
  }
  if (typeof args.path !== 'string') {
    throw invalid('set_path needs path: an absolute folder, or an empty string to clear the recorded path.');
  }
  const manifest = manifestOf(ctx);
  const { tool } = assertPathEditable(manifest, id, 'path');
  const clear = args.path.trim() === '';
  const target = clear ? undefined : assertEnvPath(args.path, 'path');
  assertEnvYaml();
  const name = toolName(tool, id);
  // Clearing drops the whole entry, as the Install Runners panel does: the
  // variant an alias uses and add_to_path false go with the path.
  const before = storedEntry(id);
  const aliasDefault = clear && typeof before.default === 'string' ? getDefaultToolIdForAlias(manifest, undefined, id) : undefined;
  const cleared = clear
    ? { removed: Object.keys(before), ...(aliasDefault ? { default_now: aliasDefault } : {}) }
    : {};
  if (bool(args.dry_run) === true) {
    return {
      action: 'set_path', dry_run: true, tool: id, ...(target ? { path: normalizePath(target) } : { cleared: true, ...cleared }),
      stored: before, confirmation_required: confirmationRequired(ctx, args),
      next: 'Call manage_runners again without dry_run to store it.',
    };
  }
  const lost = [
    ...(aliasDefault && before.default !== aliasDefault ? [`its chosen variant ${String(before.default)}, so ${id} goes back to ${aliasDefault}`] : []),
    ...(clear && before.do_not_use === true ? ['its add_to_path false setting, so Zephyr terminals put it on PATH again'] : []),
  ];
  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf(target
    ? `record ${target} as the path of ${name} in ${getEnvYamlPath()}, which puts it on PATH in every Zephyr terminal`
    : `forget the recorded path of ${name} in ${getEnvYamlPath()}${lost.map(text => `, and ${text}`).join('')}`, args, target));
  const saved = target ? saveRunnerPath(id, target) : removeRunnerPath(id);
  if (!saved) {
    throw new McpToolError('INTERNAL', `${getEnvYamlPath()} could not be written.`);
  }
  return {
    action: 'set_path', tool: id, ...cleared, stored: storedEntry(id), env_file: getEnvYamlPath(),
    ...(confirmationOf(ctx, outcome) ? { confirmation: confirmationOf(ctx, outcome) } : {}),
    next: 'New Zephyr terminals and builds use it. Call list_runners with all_tools true to check the tool is found.',
  };
}

async function setDefault(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  checkTypes(args, { strings: ['tool'], booleans: ['dry_run'] });
  const id = str(args.tool)?.trim();
  if (!id) {
    throw invalid('set_default needs tool: the variant an alias such as openocd should use.');
  }
  const manifest = manifestOf(ctx);
  const { tool } = manifestEntry(manifest, id);
  const alias = tool?.alias;
  if (!tool || !alias) {
    const variants = manifestTools(manifest).filter(t => t.alias).map(t => t.tool);
    throw invalid(`"${id}" is not a variant of an alias, so it cannot be a default.`,
      'Pass one of details.variants, such as openocd-zephyr for openocd.', { variants });
  }
  assertEnvYaml();
  const envData = runnerEnvData();
  const current = getDefaultToolIdForAlias(manifest, envData, alias);
  if (bool(args.dry_run) === true) {
    return {
      action: 'set_default', dry_run: true, alias, tool: id, current_default: current,
      confirmation_required: current !== id && confirmationRequired(ctx, args),
      next: 'Call manage_runners again without dry_run to set it.',
    };
  }
  if (current === id) {
    return { action: 'set_default', alias, tool: id, unchanged: true, stored: storedEntry(alias), next: `${id} is already the default for ${alias}.` };
  }
  const outcome = await ctx.deps.confirmations.require(ctx, args,
    subjectOf(`make ${toolName(tool, id)} the ${alias} every build, flash and debug of this machine uses`, args));
  try {
    setDebugToolAliasDefault({
      manifest,
      alias,
      toolId: id,
      executableName: getDebugToolExecutableName(alias),
      fallbackPath: getConfiguredDebugToolPath(envData, id) || getConfiguredDebugToolPath(envData, alias),
    });
  } catch (error) {
    throw new McpToolError('INTERNAL', `The default for ${alias} was not stored: ${messageOf(error)}`);
  }
  return {
    action: 'set_default', alias, tool: id, previous_default: current, stored: storedEntry(alias),
    ...(confirmationOf(ctx, outcome) ? { confirmation: confirmationOf(ctx, outcome) } : {}),
    next: `New Zephyr terminals use it. With Zephyr SDK 1.x the build passes it with -DOPENOCD, so rebuild with build_app pristine "always".`,
  };
}

async function setAddToPath(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  checkTypes(args, { strings: ['tool'], booleans: ['add_to_path', 'dry_run'] });
  const id = str(args.tool)?.trim();
  if (!id) {
    throw invalid('set_add_to_path needs tool.');
  }
  const addToPath = bool(args.add_to_path);
  if (addToPath === undefined) {
    throw invalid('set_add_to_path needs add_to_path: true to put the tool on PATH, false to leave it out.');
  }
  const manifest = manifestOf(ctx);
  const { tool } = assertPathEditable(manifest, id, 'PATH setting');
  assertEnvYaml();
  if (bool(args.dry_run) === true) {
    return {
      action: 'set_add_to_path', dry_run: true, tool: id, add_to_path: addToPath, stored: storedEntry(id),
      confirmation_required: confirmationRequired(ctx, args),
      next: 'Call manage_runners again without dry_run to store it.',
    };
  }
  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf(addToPath
    ? `put ${toolName(tool, id)} on PATH in every Zephyr terminal`
    : `leave ${toolName(tool, id)} off PATH in every Zephyr terminal`, args));
  if (!saveDoNotUse(id, !addToPath)) {
    throw new McpToolError('INTERNAL', `${getEnvYamlPath()} could not be written.`);
  }
  return {
    action: 'set_add_to_path', tool: id, add_to_path: addToPath, stored: storedEntry(id),
    ...(confirmationOf(ctx, outcome) ? { confirmation: confirmationOf(ctx, outcome) } : {}),
    next: 'New Zephyr terminals and builds use it.',
  };
}

async function extraPaths(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  checkTypes(args, { booleans: ['dry_run'] });
  const edit = args.extra_paths;
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
    throw invalid('extra_paths needs extra_paths with set, add or remove.');
  }
  const { set, add, remove, ...other } = edit as Record<string, unknown>;
  if (Object.keys(other).length > 0) {
    throw invalid(`extra_paths takes set, add and remove, not ${Object.keys(other).join(', ')}.`);
  }
  checkTypes({ set, add, remove }, { stringArrays: ['set', 'add', 'remove'] });
  const setList = set as string[] | undefined;
  const addList = add as string[] | undefined;
  const removeList = remove as string[] | undefined;
  if (setList && (addList || removeList)) {
    throw invalid('extra_paths set replaces the whole list, so it cannot be combined with add or remove.');
  }
  if (!setList && !addList?.length && !removeList?.length) {
    throw invalid('extra_paths needs set, add or remove.');
  }
  assertEnvYaml();
  const current = getExtraPaths('EXTRA_RUNNERS');
  const same = (a: string, b: string) => normalizeForCompare(a) === normalizeForCompare(b);
  let next: string[];
  if (setList) {
    next = setList.map(p => normalizePath(assertEnvPath(p, 'extra_paths.set')));
  } else {
    const unknown = (removeList ?? []).filter(p => !current.some(entry => same(entry, p)));
    if (unknown.length > 0) {
      throw invalid(`extra_paths.remove names folders that are not in the list: ${unknown.map(p => logSafe(p, 200)).join(', ')}.`,
        'Pass entries of details.extra_paths exactly.', { extra_paths: current });
    }
    next = current.filter(entry => !(removeList ?? []).some(p => same(entry, p)));
    for (const p of addList ?? []) {
      next.push(normalizePath(assertEnvPath(p, 'extra_paths.add')));
    }
  }
  next = next.filter((entry, index) => next.findIndex(other => same(other, entry)) === index);
  if (bool(args.dry_run) === true) {
    return {
      action: 'extra_paths', dry_run: true, extra_paths: current, would_be: next,
      confirmation_required: confirmationRequired(ctx, args),
      next: 'Call manage_runners again without dry_run to store it.',
    };
  }
  const outcome = await ctx.deps.confirmations.require(ctx, args,
    subjectOf(`set the extra runner folders every Zephyr terminal puts on PATH to ${next.length > 0 ? next.join(', ') : 'none'}`, args));
  try {
    setExtraPaths('EXTRA_RUNNERS', next);
  } catch (error) {
    throw new McpToolError('INTERNAL', `${getEnvYamlPath()} could not be written: ${messageOf(error)}`);
  }
  return {
    action: 'extra_paths', extra_paths: getExtraPaths('EXTRA_RUNNERS'), previous: current,
    ...(confirmationOf(ctx, outcome) ? { confirmation: confirmationOf(ctx, outcome) } : {}),
    next: 'New Zephyr terminals and builds use them.',
  };
}

// pyOCD packs

/** pyOCD must be installed in the venv it runs from; it is what updates and installs packs. */
async function assertPyocd(ctx: Ctx, venvPath: string | undefined, owner?: PyocdVenvOwner): Promise<string> {
  const version = await runnerTools.pyocd.version(venvPath);
  if (!version) {
    throw new McpToolError('RUNNER_TOOL_MISSING', `pyOCD is not installed in ${venvPath ? `the Python environment ${venvPath}` : 'the Python environment of the host tools'}.`, {
      hint: `${pyocdMissingHint(ctx, venvPath, owner)} Then retry.`,
    });
  }
  return version;
}

/** Log pyocd's lines, and a download tick at most every tenth. */
function pyocdLogger(log: (text: string) => void) {
  let lastTenth = -1;
  return {
    onLine: (line: string) => log(`${line}\n`),
    onProgress: (current: number, total: number | undefined) => {
      if (total && total > 0) {
        const tenth = Math.floor((current / total) * 10);
        if (tenth !== lastTenth) {
          lastTenth = tenth;
          log(`Downloading descriptors (${current}/${total})\n`);
        }
      }
    },
  };
}

async function pyocdUpdateIndex(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  checkTypes(args, { booleans: ['dry_run'] });
  const version = await assertPyocd(ctx, undefined);
  const present = await runnerTools.pyocd.hasIndex(undefined);
  if (bool(args.dry_run) === true) {
    return {
      action: 'pyocd_update_index', dry_run: true, pyocd_version: version, pack_index: present ?? null,
      command: 'pyocd pack update', confirmation_required: confirmationRequired(ctx, args),
      next: 'Call manage_runners again without dry_run to download the index.',
    };
  }
  const requestKey = 'runners:pyocd:update-index';
  const running = runningJob(ctx, requestKey);
  if (running) {
    return waitAndView(ctx, running, true, num(args.wait_sec) ?? ctx.deps.defaultWaitSeconds);
  }
  assertNoRunnerJob(ctx);
  const outcome = await ctx.deps.confirmations.require(ctx, args,
    subjectOf('download the CMSIS pack index of pyOCD (pyocd pack update), shared by every Python environment of this user', args));
  return startRunnerJob(ctx, args, outcome, {
    kind: 'install',
    requestKey,
    command: 'pyocd pack update',
    run: async (sink, signal) => {
      try {
        await runnerTools.runStep('pyOCD: updating the CMSIS pack index', sink, signal, async (log, stepSignal) => {
          await runnerTools.pyocd.updateIndex({ show: false, token: cancellationTokenFor(stepSignal), ...pyocdLogger(log) });
        }, stepOptions(ctx));
        return { exitCode: 0, extra: { pack_index: (await runnerTools.pyocd.hasIndex(undefined)) ?? null } };
      } catch (error) {
        return { exitCode: signal.aborted ? undefined : 1, extra: { error: messageOf(error) } };
      }
    },
    next: view => (view.status === 'succeeded'
      ? 'The pack index is up to date. Install the pack of a target with manage_runners action "pyocd_install_pack".'
      : failedNext(view, 'index update')),
  });
}

const PYOCD_TARGET = /^[A-Za-z0-9._+-]{1,64}$/;

async function pyocdInstallPack(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  checkTypes(args, { strings: ['pyocd_target', 'app_path', 'config_name'], booleans: ['dry_run'] });
  const given = str(args.pyocd_target)?.trim();
  if (given !== undefined && !PYOCD_TARGET.test(given)) {
    throw invalid(`pyocd_target must be a pyOCD target name of letters, digits and . _ + -, such as stm32f429zitx, not "${logSafe(given, 64)}".`);
  }
  let target = given;
  let venvPath: string | undefined;
  let appPath: string | undefined;
  let owner: PyocdVenvOwner | undefined;
  let configName: string | undefined;
  if (!given || args.app_path !== undefined || args.config_name !== undefined) {
    const { app, config } = await ctx.deps.services.resolveTarget(str(args.app_path), str(args.config_name));
    appPath = app.appRootPath;
    configName = config.name;
    // The venv the debug session of this application runs pyocd from.
    venvPath = getDebugSessionVenvPath(app);
    owner = pyocdVenvOwner(app, venvPath);
    if (!target) {
      let boardTarget: string | undefined;
      try {
        boardTarget = config.getPyOCDTarget(app);
      } catch {
        boardTarget = undefined;
      }
      if (!boardTarget) {
        if (!ctx.deps.services.isBuilt(app, config)) {
          throw new McpToolError('NOT_BUILT', `The pyOCD target of "${config.name}" comes from its runners.yaml, and it is not built.`, {
            hint: 'Call build_app first, or pass pyocd_target.',
          });
        }
        throw invalid(`The runners.yaml of "${config.name}" names no pyOCD target: pyocd is not a runner of board ${config.boardIdentifier}.`,
          'Pass pyocd_target, or call list_runners to see the runners of the board.');
      }
      target = boardTarget;
    }
  }
  const pyocdTarget = target!;
  const version = await assertPyocd(ctx, venvPath, owner);
  const where = { ...(appPath ? { app_path: appPath, config_name: configName } : {}), ...(venvPath ? { venv_path: venvPath } : {}) };
  if (await runnerTools.pyocd.targetOps.checkTarget(pyocdTarget, venvPath)) {
    return {
      action: 'pyocd_install_pack', ...(bool(args.dry_run) === true ? { dry_run: true } : {}), target: pyocdTarget, ...where,
      already_available: true, next: 'pyOCD already supports this target: nothing to install.',
    };
  }
  const index = await runnerTools.pyocd.hasIndex(venvPath);
  if (bool(args.dry_run) === true) {
    // Only an index already on disk is read: a dry run downloads nothing.
    let packs: string[] | undefined;
    const notes: string[] = [];
    if (index === true) {
      try {
        packs = await runnerTools.pyocd.dryRunInstall(pyocdTarget, { show: false, ...(venvPath ? { venvPath } : {}) });
        if (packs.length === 0) {
          notes.push('The local pack index names no pack for this target: the install refreshes the index once and looks again.');
        }
      } catch (error) {
        notes.push(`The packs could not be resolved: ${messageOf(error)}`);
      }
    } else {
      notes.push('The pack index was never downloaded: the install downloads it first, then resolves the pack.');
    }
    return {
      action: 'pyocd_install_pack', dry_run: true, target: pyocdTarget, ...where, pyocd_version: version,
      pack_index: index ?? null, ...(packs ? { packs } : {}), ...(notes.length > 0 ? { notes } : {}),
      confirmation_required: confirmationRequired(ctx, args),
      next: 'Call manage_runners again without dry_run to install the pack.',
    };
  }
  const requestKey = `runners:pyocd:install:${pyocdTarget.toLowerCase()}:${venvPath ?? ''}`;
  const running = runningJob(ctx, requestKey);
  if (running) {
    return waitAndView(ctx, running, true, num(args.wait_sec) ?? ctx.deps.defaultWaitSeconds);
  }
  assertNoRunnerJob(ctx);
  const outcome = await ctx.deps.confirmations.require(ctx, args, {
    ...subjectOf(`download and install the CMSIS pack of pyOCD for target ${pyocdTarget} (pyocd pack install ${pyocdTarget})`, args),
    ...(appPath ? { appPath, configName } : {}),
  } as ConfirmSubject);
  return startRunnerJob(ctx, args, outcome, {
    kind: 'install',
    requestKey,
    command: `pyocd pack install ${pyocdTarget}`,
    ...(appPath ? { appPath, configName } : {}),
    run: async (sink, signal) => {
      try {
        const result = await runnerTools.runStep(`pyOCD: installing the pack for ${pyocdTarget}`, sink, signal, async (log, stepSignal) => {
          const setup = await installPyOCDTargetSupport(pyocdTarget,
            { ...(venvPath ? { venvPath } : {}), token: cancellationTokenFor(stepSignal), ...pyocdLogger(log) },
            runnerTools.pyocd.targetOps);
          if (!setup.available) {
            throw new Error(setup.packs.length === 0
              ? `No CMSIS pack provides the pyOCD target ${pyocdTarget}. Check the target name.`
              : `${setup.packs.join(', ')} installed, but pyOCD still does not list the target ${pyocdTarget}.`);
          }
          return setup;
        }, stepOptions(ctx));
        return {
          exitCode: 0,
          extra: { target: pyocdTarget, available: true, packs: result.packs, index_updated: result.indexUpdated, ...where },
        };
      } catch (error) {
        return { exitCode: signal.aborted ? undefined : 1, extra: { target: pyocdTarget, available: false, error: messageOf(error), ...where } };
      }
    },
    next: view => (view.status === 'succeeded'
      ? 'pyOCD now supports the target. Flash or debug with the pyocd runner.'
      : failedNext(view, 'pack install')),
  });
}

// remove_or_delete what "pyocd_packs"

export async function removePyocdPacks(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  checkTypes(args, { booleans: ['dry_run'] });
  await assertPyocd(ctx, undefined);
  const index = await runnerTools.pyocd.hasIndex(undefined);
  let packs: Array<{ pack: string; version?: string }> = [];
  try {
    packs = (await runnerTools.pyocd.installedPacks(undefined)).map(pack => ({ pack: pack.pack, ...(pack.version ? { version: pack.version } : {}) }));
  } catch (error) {
    throw new McpToolError('INTERNAL', `The installed pyOCD packs could not be read: ${messageOf(error)}`);
  }
  const report = { what: 'pyocd_packs', pack_index: index ?? null, packs };
  if (bool(args.dry_run) === true) {
    return {
      ...report, dry_run: true, confirmation_required: confirmationRequired(ctx, args),
      next: 'Call remove_or_delete again without dry_run to delete them. Pack-provided targets then need their pack again before pyOCD can flash or debug them.',
    };
  }
  if (packs.length === 0 && index === false) {
    return { ...report, removed: false, next: 'There is no pack index and no installed pack: nothing to delete.' };
  }
  assertNoRunnerJob(ctx);
  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf(
    `delete the pyOCD pack index and every installed CMSIS pack (${packs.length} pack${packs.length === 1 ? '' : 's'}), shared by every Python environment of this user (pyocd pack clean)`, args));
  return startRunnerJob(ctx, args, outcome, {
    kind: 'clean',
    requestKey: 'runners:pyocd:clean',
    command: 'pyocd pack clean',
    run: async (sink, signal) => {
      try {
        await runnerTools.runStep('pyOCD: deleting the pack index and the installed packs', sink, signal, async (log, stepSignal) => {
          await runnerTools.pyocd.clean({ show: false, token: cancellationTokenFor(stepSignal), ...pyocdLogger(log) });
        }, stepOptions(ctx));
        return { exitCode: 0, extra: { removed_packs: packs.map(pack => pack.pack) } };
      } catch (error) {
        return { exitCode: signal.aborted ? undefined : 1, extra: { error: messageOf(error) } };
      }
    },
    next: view => (view.status === 'succeeded'
      ? 'The packs are deleted. Install the pack a target needs again with manage_runners action "pyocd_install_pack".'
      : failedNext(view, 'deletion')),
  });
}

// The tool

const ROUTES: Readonly<Record<ManageRunnersAction, (args: Record<string, unknown>, ctx: Ctx) => Promise<unknown>>> = {
  install,
  set_path: setPath,
  set_default: setDefault,
  set_add_to_path: setAddToPath,
  extra_paths: extraPaths,
  pyocd_update_index: pyocdUpdateIndex,
  pyocd_install_pack: pyocdInstallPack,
};

export const manageRunners: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const action = str(args.action) ?? '';
  if (!(MANAGE_RUNNERS_ACTIONS as readonly string[]).includes(action)) {
    throw invalid(`action must be one of ${MANAGE_RUNNERS_ACTIONS.join(', ')}, not "${logSafe(action, 40)}".`);
  }
  const act = action as ManageRunnersAction;
  refuseUnexpected(args, ['action', 'dry_run', ...ACTION_ARGS[act]], `action "${act}"`);
  return ROUTES[act](args, ctx);
};
