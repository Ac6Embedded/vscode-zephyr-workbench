// West workspaces: manage_west_workspace, configure target "west_workspace",
// and remove_or_delete what "west_workspace", "west_workspace_files",
// "workspace_venv" and "west_blobs".
//
// Every action goes through the functions the Add West Workspace wizard, the
// West Manager and the west workspace commands use (westWorkspaceSetup,
// westManifestEdit, the west command specs), so a workspace an agent creates
// or changes ends up exactly as one made by hand. West runs captured in a
// terminal the user can watch; nothing shows UI except the confirmation.
//
// Every handler follows one order: validate, resolve, run each check that can
// refuse the call, return early for a dry run, ask the user when they chose to
// be asked, then act under the right lock against freshly read values.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  buildWestTask, prepareWestInitManifest, westBlobsCleanSpec, westBlobsFetchSpec, WestCommandSpec, westEnableRustModuleSpec,
  westInitSpec, westPackagesInstallSpec, westUpdateSpec,
} from '../../../commands/WestCommands';
import {
  ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY,
} from '../../../constants';
import { WestWorkspace } from '../../../models/WestWorkspace';
import { ZephyrApplication } from '../../../models/ZephyrApplication';
import {
  classifyShell, getConfiguredWorkbenchPath, getShellExe, normalizePathForShell, resolveConfiguredPath,
} from '../../../utils/execUtils';
import { saveEnv } from '../../../utils/env/zephyrEnvUtils';
import { createWorkspaceVenv, getManagedVenvWestPath, VenvRunner, VenvSetupError, zephyrVersionSupportsWestPackages } from '../../../utils/installUtils';
import { createWorkspaceFolderReference, getExactWorkspaceFolder, getWestWorkspace, removeDirectory } from '../../../utils/utils';
import { validateVenvDirectory } from '../../../utils/venvValidation';
import { loadTemplateConfig, renderWestManifest, ZEPHYR_LANG_RUST_PROJECT_NAME } from '../../../utils/zephyr/manifestUtils';
import { resolveBaseModules } from '../../../utils/zephyr/templateData';
import {
  applyWorkspaceState, diffLines, getWorkspaceDetails, isRustEnabledInWestConfig, manifestWorkspaceOf, readZephyrRevision,
  renderWorkspaceState, WestManagerApplyState,
} from '../../../utils/zephyr/westManifestEdit';
import {
  deleteWestWorkspace, describeWorkspaceVenv, initWestWorkspace, managedWorkspaceVenvDir, removeWorkspaceVenv,
  resolveWorkspaceDestination, setWorkspaceVenvPath, storeWorkspaceVenvPath, WEST_WORKSPACE_FOLDER_SETTINGS, writeFolderSettingsFile,
} from '../../../utils/zephyr/westWorkspaceSetup';
import { assertEnvListElement, assertInside, isInside, isPlainPath, normalizeForCompare } from '../../core/argSafety';
import { editList, ListEdit, toEnvList } from '../../core/buildConfigEdit';
import { McpToolError, toToolError } from '../../core/errors';
import {
  assertFolderName, assertGitRevision, assertGitUrl, assertManifestFileName, assertNoWhitespacePath, assertWestProjectName,
} from '../../core/gitArgs';
import { logSafe, redactCommandLine } from '../../core/redact';
import { confirmCategoryOf, ToolContext, ToolHandler } from '../../core/toolSpec';
import { checkWestWorkspaceDeletion, folderSize } from '../../core/westWorkspaceFence';
import { conflictOf, JobClaim } from '../../jobs/jobConflicts';
import { isTerminal, isWorking, JobSink, JobSpec, JobState, JobView } from '../../jobs/jobManager';
import { CAPTURED_TASK_MARKER } from '../capturedTask';
import { ConfirmOutcome, ConfirmSubject } from '../confirmations';
import { runCapturedTask } from '../taskRunner';
import { HostDeps } from './deps';
import { progressWait, remainingWaitMs } from './progress';

type Ctx = ToolContext<HostDeps>;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);

const REVEAL: Record<string, vscode.TaskRevealKind> = {
  always: vscode.TaskRevealKind.Always,
  silent: vscode.TaskRevealKind.Silent,
  never: vscode.TaskRevealKind.Never,
};

const UPSTREAM_ZEPHYR_URL = 'https://github.com/zephyrproject-rtos/zephyr';
const DEFAULT_FOLDER_NAME = 'zephyrproject';
/** The template flow's manifest folder and import prefix, as the wizard defaults them. */
const TEMPLATE_MANIFEST_DIR = 'manifest';
const TEMPLATE_PATH_PREFIX = 'deps';
/** Kept back from a call's budget for anything synchronous it waits on, so the answer is sent in time. */
const CALL_MARGIN_MS = 3_000;
/** At most this long for the west boards check of an import or the blob listing of a fetch. */
const LISTING_TIMEOUT_MS = 30_000;
/** At most this long to measure a workspace for a dry run. */
const SIZE_TIMEOUT_MS = 5_000;
const VERSION_TIMEOUT_MS = 10_000;
const WEST_ROOT_KEYS = WestWorkspace.envVarKeys as readonly string[];

function invalid(message: string, hint?: string, details?: Record<string, unknown>): McpToolError {
  return new McpToolError('INVALID_ARGUMENT', message, { hint, details });
}

const samePath = (a: string, b: string) => normalizeForCompare(a) === normalizeForCompare(b);

/** Refuse a value of the wrong type instead of silently ignoring it. */
function checkTypes(args: Record<string, unknown>, strings: readonly string[], booleans: readonly string[], arrays: readonly string[] = []): void {
  for (const key of strings) {
    if (args[key] !== undefined && typeof args[key] !== 'string') {
      throw invalid(`${key} must be a string.`);
    }
  }
  for (const key of booleans) {
    if (args[key] !== undefined && typeof args[key] !== 'boolean') {
      throw invalid(`${key} must be true or false.`);
    }
  }
  for (const key of arrays) {
    const value = args[key];
    if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) {
      throw invalid(`${key} must be a list of strings.`);
    }
  }
}

/** Refuse arguments the action does not take, so a misplaced one is never silently ignored. */
function checkAccepted(args: Record<string, unknown>, accepted: readonly string[], what: string): void {
  const unexpected = Object.keys(args).filter(key => args[key] !== undefined && !accepted.includes(key));
  if (unexpected.length > 0) {
    throw invalid(`${what} does not take ${unexpected.join(', ')}.`, undefined, { accepted: [...accepted] });
  }
}

/**
 * The confirmation subject, with the request itself added to what identifies
 * the call, so an answer given after a timeout is only reused by a call that
 * would make exactly the same change.
 */
function subjectOf(base: ConfirmSubject, args: Record<string, unknown>): ConfirmSubject {
  const { wait_sec: _waitSec, ...request } = args;
  const subject: ConfirmSubject & { request: Record<string, unknown> } = { ...base, request };
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
  return !!category && (always || ctx.deps.confirmActions.includes(category));
}

// Environment and busy checks

/**
 * The same check the west task builders make, done up front so a missing
 * environment script is reported as a setup gap with its fix, before anyone
 * is asked anything.
 */
function assertWestEnvironment(scope?: string): void {
  const envScript = getConfiguredWorkbenchPath(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, scope ? vscode.Uri.file(scope) : undefined);
  if (!envScript || !fs.existsSync(envScript)) {
    throw toToolError(new Error(
      envScript ? `The Zephyr environment script "${envScript}" does not exist.` : 'The Zephyr environment script is not set.',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` },
    ));
  }
}

/** A failure to build a west task, mapped onto the error contract. */
function taskError(error: unknown): McpToolError {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  if (cause === `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY}`) {
    return new McpToolError('ENV_NOT_READY', 'The configured Python virtual environment does not exist.', {
      hint: 'Point the workspace at an existing venv with configure target "west_workspace" venv, or create one with manage_west_workspace action create_venv.',
    });
  }
  return toToolError(error);
}

/**
 * The task a west spec runs, with PYTHON_VENV_PATH set to `venvPath` when one
 * is given: the env script activates that variable, and the task builders
 * would otherwise take the venv from the settings of the folder they run in,
 * missing a `<root>/.venv` the workspace uses without a setting.
 */
function westTask(spec: WestCommandSpec, venvPath?: string): vscode.Task {
  let task: vscode.Task;
  try {
    task = buildWestTask(spec);
  } catch (error) {
    throw taskError(error);
  }
  if (venvPath) {
    const execution = task.execution as vscode.ShellExecution;
    const shell = classifyShell(execution.options?.executable ?? getShellExe());
    execution.options = {
      ...execution.options,
      env: { ...execution.options?.env, PYTHON_VENV_PATH: normalizePathForShell(shell, venvPath) },
    };
  }
  return task;
}

/** Applications of the window that build with the west workspace at `root`. */
async function linkedApps(ctx: Ctx, root: string): Promise<ZephyrApplication[]> {
  return (await ctx.deps.services.listApplications())
    .filter(app => !!app.westWorkspaceRootPath && samePath(app.westWorkspaceRootPath, root));
}

/** A west task the user started from VS Code on `root`, if one runs. */
function externalWestTask(root: string): vscode.TaskExecution | undefined {
  return (vscode.tasks.taskExecutions ?? []).find(({ task }) => {
    if (task.definition?.type !== 'zephyr-workbench-shell' || task.definition[CAPTURED_TASK_MARKER]) {
      return false;
    }
    const options = (task.execution as vscode.ShellExecution | undefined)?.options;
    const dir = options?.env?.ZEPHYR_PROJECT_DIRECTORY ?? (typeof options?.cwd === 'string' ? options.cwd : undefined);
    // The progress flavour of west update is a pseudoterminal that names no folder.
    return dir ? samePath(dir, root) : task.name === 'West Update for current workspace';
  });
}

/** Refuse with BUSY while a working job would conflict with `claim`. */
function assertNoConflictingJob(ctx: Ctx, claim: JobClaim): void {
  for (const holder of ctx.deps.jobs.list()) {
    if (!isWorking(holder) || !conflictOf(claim, holder.spec)) {
      continue;
    }
    throw new McpToolError('BUSY', `A ${holder.spec.kind} job is using this west workspace or its Python environment (job_id "${holder.id}").`, {
      hint: `Wait for it with job {"action": "status", "job_id": "${holder.id}"}, or stop it with job {"action": "cancel", "job_id": "${holder.id}"}, then retry.`,
      details: { job_id: holder.id, kind: holder.spec.kind },
    });
  }
}

/**
 * Refuse while anything works with the west workspace: an agent job that
 * conflicts with `claim`, a build the user started of an application linked
 * to it (freestanding ones live outside the root, so path locks miss them),
 * or a west task the user started on it.
 */
async function assertWorkspaceIdle(ctx: Ctx, root: string, claim: JobClaim): Promise<void> {
  assertNoConflictingJob(ctx, claim);
  for (const app of await linkedApps(ctx, root)) {
    for (const config of app.buildConfigs) {
      const external = ctx.deps.services.externalRun(app.appRootPath, config.name);
      if (external) {
        throw new McpToolError('BUSY_EXTERNAL', `"${external.task.name}" is running for ${config.name} of ${app.appName}, which builds with this west workspace.`, {
          hint: 'Wait for it to finish in its terminal, then retry.',
        });
      }
    }
  }
  const west = externalWestTask(root);
  if (west) {
    throw new McpToolError('BUSY_EXTERNAL', `"${west.task.name}" is running, started from VS Code.`, {
      hint: 'Wait for it to finish in its terminal, then retry.',
    });
  }
}

function westClaim(root: string, kind: JobClaim['kind'] = 'west'): JobClaim {
  return { kind, lockKey: root, westWorkspace: root, writes: ['west_workspace'] };
}

function venvLockKey(venvPath: string): string {
  return `venv:${normalizeForCompare(venvPath)}`;
}

function venvClaim(root: string, venvPath: string, kind: JobClaim['kind'] = 'install'): JobClaim {
  return { kind, lockKey: venvLockKey(venvPath), westWorkspace: root, venvPath, writes: ['venv'] };
}

// Running jobs

/** A west step that did not succeed. */
class StepFailed extends Error {
  constructor(readonly step: string, readonly exitCode: number | undefined) {
    super(exitCode === undefined ? `${step} was cancelled.` : `${step} failed with exit code ${exitCode}.`);
  }
}

/** Run one west task captured in a terminal the user can watch; throws StepFailed unless it exits 0. */
async function runWestStep(ctx: Ctx, task: vscode.Task, sink: JobSink, signal: AbortSignal, label: string): Promise<void> {
  const { exitCode } = await runCapturedTask(task, sink, signal, {
    reveal: REVEAL[ctx.deps.revealTerminal] ?? vscode.TaskRevealKind.Silent,
    header: `> [agent ${ctx.client.name ?? 'mcp'}] ${label}`,
  });
  if (exitCode !== 0) {
    throw new StepFailed(label, exitCode);
  }
}

/** Wait for a job within the call's budget and hand back its view, with the confirmation it went through. */
async function waitAndView(ctx: Ctx, job: JobState, attached: boolean, waitSec: number, confirmation?: ReturnType<typeof confirmationOf>): Promise<JobView & Record<string, unknown>> {
  const { jobs } = ctx.deps;
  ctx.audit.jobId = job.id;
  await jobs.wait(job, remainingWaitMs(ctx, waitSec), progressWait(ctx, jobs));
  return { ...jobs.view(job, { attached, parse: false }), ...(confirmation ? { confirmation } : {}) };
}

/** A listing bounded by `timeoutMs`; undefined when it did not finish in time. */
async function within<T>(pending: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run west boards on a workspace and keep its listing for search_zephyr_catalog:
 * it proves the tree is usable. Never fails the caller; says what went wrong.
 */
async function checkBoards(ctx: Ctx, workspace: WestWorkspace, timeoutMs: number): Promise<{ boards?: number; warning?: string }> {
  try {
    const listing = await within(ctx.deps.services.catalog.list('board', workspace, undefined, true), timeoutMs);
    return listing
      ? { boards: listing.entries.length }
      : { warning: `west boards did not finish within ${Math.round(timeoutMs / 1000)} seconds; search_zephyr_catalog kind board picks up its result.` };
  } catch (error) {
    return { warning: `west boards failed, so the workspace may be incomplete: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function describeWorkspace(root: string): { path: string; zephyr_version?: string; zephyr_base?: string } {
  try {
    const workspace = getWestWorkspace(root);
    return { path: root, zephyr_version: workspace.version, zephyr_base: workspace.kernelUri.fsPath };
  } catch {
    return { path: root };
  }
}

function runVersion(executable: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(executable, args, { timeout: VERSION_TIMEOUT_MS }, (error, stdout, stderr) => {
      const text = `${stdout ?? ''}${stderr ?? ''}`.trim().split(/\r?\n/)[0];
      resolve(error || !text ? undefined : text);
    });
  });
}

/** The west workspace a call names, resolved against the ones the window knows. */
async function resolveWorkspace(ctx: Ctx, args: Record<string, unknown>): Promise<{ workspace: WestWorkspace; root: string }> {
  const { workspace } = await ctx.deps.services.resolveWestWorkspace(str(args.west_workspace));
  return { workspace, root: workspace.rootUri.fsPath };
}

// manage_west_workspace

const MANAGE_ACTIONS = ['create', 'import', 'update', 'set_manifest', 'create_venv', 'install_python_deps', 'fetch_blobs'] as const;
type ManageAction = typeof MANAGE_ACTIONS[number];

const ACTION_ARGS: Readonly<Record<ManageAction, readonly string[]>> = {
  create: ['source', 'destination', 'folder_name', 'url', 'revision', 'manifest_file', 'manifest_path', 'template_mode', 'templates', 'projects', 'enable_rust'],
  import: ['path'],
  update: ['west_workspace'],
  set_manifest: ['west_workspace', 'revision', 'import_all', 'allowlist', 'enable_rust', 'update'],
  create_venv: ['west_workspace'],
  install_python_deps: ['west_workspace'],
  fetch_blobs: ['west_workspace', 'modules', 'accept_blob_licenses'],
};

/** Refuse a new workspace that could not be created where it is asked for. */
function checkNewWorkspaceTarget(ctx: Ctx, destination: string, folderName: string, source: string): string {
  assertNoWhitespacePath(destination, 'destination');
  if (!isPlainPath(destination)) {
    throw invalid(`destination "${logSafe(destination, 300)}" holds characters a shell would read.`, 'Pick a folder whose path has only letters, digits and . _ - / characters.');
  }
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(destination);
  } catch {
    stat = undefined;
  }
  if (!stat?.isDirectory()) {
    throw invalid(`destination "${logSafe(destination, 300)}" is not an existing folder.`, 'Pass an existing folder; the workspace is created in folder_name inside it.');
  }
  assertFolderName(folderName, 'folder_name');
  // Before the wizard's check, which lists the folder and so throws on a file.
  const candidate = path.join(destination, folderName);
  if (fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) {
    throw invalid(`"${candidate}" is a file.`, 'Pick another folder_name.');
  }
  const { workspacePath, problem } = resolveWorkspaceDestination(destination, source, folderName);
  if (problem) {
    throw invalid(problem, 'Pick another folder_name or destination.');
  }
  if (getExactWorkspaceFolder(workspacePath)) {
    throw invalid(`"${workspacePath}" is already a folder of this window.`);
  }
  const enclosing = ctx.deps.services.listWestWorkspaces().find(workspace => isInside(workspacePath, workspace.rootUri.fsPath));
  if (enclosing) {
    throw invalid(`"${workspacePath}" is inside the west workspace "${enclosing.rootUri.fsPath}", and west workspaces cannot be nested.`,
      'Pick a destination outside every west workspace.');
  }
  return workspacePath;
}

interface CreatePlan {
  source: 'template' | 'remote' | 'manifest';
  target: string;
  enableRust: boolean;
  url?: string;
  revision?: string;
  manifestFile?: string;
  manifestPath?: string;
  templateMode?: 'minimal' | 'full';
  templates?: string[];
  /** The allowlist of a minimal template workspace, when extra projects make the wizard's own rule not enough. */
  allowlist?: string[];
  /** What west init will be given as the manifest, for the plan. */
  initCommand: string;
  manifestText?: string;
  warnings: string[];
}

function refuseFor(source: string, args: Record<string, unknown>, keys: readonly string[]): void {
  const misplaced = keys.filter(key => args[key] !== undefined);
  if (misplaced.length > 0) {
    throw invalid(`source "${source}" does not take ${misplaced.join(', ')}.`);
  }
}

async function planCreate(args: Record<string, unknown>, ctx: Ctx): Promise<CreatePlan> {
  const source = str(args.source);
  if (source !== 'template' && source !== 'remote' && source !== 'manifest') {
    throw invalid('create needs source: "template", "remote" or "manifest".');
  }
  const destination = str(args.destination);
  if (!destination) {
    throw invalid('create needs destination, the absolute folder that receives the workspace folder.');
  }
  const target = checkNewWorkspaceTarget(ctx, destination, str(args.folder_name) ?? DEFAULT_FOLDER_NAME, source);
  const enableRust = bool(args.enable_rust) === true;
  const warnings: string[] = [];

  if (source === 'remote') {
    refuseFor(source, args, ['manifest_path', 'template_mode', 'templates', 'projects']);
    const url = str(args.url);
    const revision = str(args.revision);
    if (!url || !revision) {
      throw invalid('source "remote" needs url and revision.', 'Call search_zephyr_catalog with kind "revision" and the url to list its revisions.');
    }
    assertGitUrl(url);
    assertGitRevision(revision);
    const manifestFile = str(args.manifest_file);
    if (manifestFile !== undefined) {
      assertManifestFileName(manifestFile);
    }
    return {
      source, target, enableRust, url, revision, manifestFile, warnings,
      initCommand: westInitSpec(url, revision, target, manifestFile ?? '').command,
    };
  }

  if (source === 'manifest') {
    refuseFor(source, args, ['url', 'revision', 'manifest_file', 'template_mode', 'templates', 'projects']);
    const manifestPath = str(args.manifest_path);
    if (!manifestPath) {
      throw invalid('source "manifest" needs manifest_path, the absolute path of a west.yml.');
    }
    assertNoWhitespacePath(manifestPath, 'manifest_path');
    if (!isPlainPath(manifestPath) || !/\.ya?ml$/i.test(manifestPath)) {
      throw invalid(`manifest_path "${logSafe(manifestPath, 300)}" must be a plain path to a .yml or .yaml file.`);
    }
    if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
      throw invalid(`manifest_path "${logSafe(manifestPath, 300)}" is not an existing file.`);
    }
    return {
      source, target, enableRust, manifestPath, warnings,
      // The manifest is copied into <target>/manifest first, as the wizard does.
      initCommand: westInitSpec('', '', target, manifestPath).command,
    };
  }

  refuseFor(source, args, ['manifest_path', 'manifest_file']);
  const url = str(args.url) ?? UPSTREAM_ZEPHYR_URL;
  assertGitUrl(url);
  const revision = str(args.revision);
  if (!revision) {
    throw invalid('source "template" needs revision, the Zephyr revision to fetch.', 'Call search_zephyr_catalog with kind "revision" to list them.');
  }
  assertGitRevision(revision);
  const templateMode = str(args.template_mode) === 'full' ? 'full' : 'minimal';
  if (args.template_mode !== undefined && args.template_mode !== 'full' && args.template_mode !== 'minimal') {
    throw invalid('template_mode must be "minimal" or "full".');
  }
  const templateNames = (args.templates as string[] | undefined) ?? [];
  const extraProjects = (args.projects as string[] | undefined) ?? [];
  if (templateMode === 'full' && (templateNames.length > 0 || extraProjects.length > 0)) {
    throw invalid('template_mode "full" fetches every module, so it takes no templates or projects.');
  }
  if (templateMode === 'minimal' && templateNames.length === 0 && extraProjects.length === 0) {
    throw invalid('template_mode "minimal" needs templates or projects.', 'Call search_zephyr_catalog with kind "template" to list the templates.');
  }

  let config;
  try {
    config = loadTemplateConfig(ctx.deps.extensionContext.extensionUri);
  } catch (error) {
    throw new McpToolError('INTERNAL', error instanceof Error ? error.message : String(error));
  }
  const templateModules: string[] = [];
  const templates: string[] = [];
  for (const name of templateNames) {
    const template = config.templates.find(candidate => candidate.label.toLowerCase() === name.trim().toLowerCase());
    if (!template) {
      throw invalid(`There is no workspace template "${logSafe(name, 64)}".`, 'Call search_zephyr_catalog with kind "template" to list them.',
        { available: config.templates.map(candidate => candidate.label) });
    }
    templates.push(template.label);
    templateModules.push(...template.modules);
  }
  for (const project of extraProjects) {
    assertWestProjectName(project, 'projects');
  }
  let allowlist: string[] | undefined;
  if (extraProjects.length > 0) {
    // Checked against the projects the Zephyr west.yml lists at that revision,
    // when GitHub can say; west ignores an allowlisted name it does not know.
    try {
      const known = await ctx.deps.services.catalog.upstreamProjects(url, revision, Math.max(1000, Math.min(15_000, remainingWaitMs(ctx, ctx.deps.defaultWaitSeconds) - CALL_MARGIN_MS)));
      const unknown = extraProjects.filter(project => !known.includes(project));
      if (unknown.length > 0) {
        throw invalid(`Zephyr ${revision} lists no project ${unknown.map(name => `"${name}"`).join(', ')}.`,
          'Call search_zephyr_catalog with kind "project", url and revision to list them.', { unknown });
      }
    } catch (error) {
      if (error instanceof McpToolError && error.code === 'INVALID_ARGUMENT') {
        throw error;
      }
      warnings.push(`The projects could not be checked against the Zephyr west.yml (${error instanceof Error ? error.message : String(error)}); west skips a name it does not know.`);
    }
    // The wizard's own rule, with the extra projects after: base modules for
    // the revision, then the template modules.
    allowlist = [...new Set([...resolveBaseModules(config.baseModules, revision), ...templateModules, ...extraProjects])];
  }
  let manifestText: string;
  try {
    manifestText = renderWestManifest(ctx.deps.extensionContext.extensionUri, url, revision, templateModules, templateMode === 'full',
      TEMPLATE_MANIFEST_DIR, TEMPLATE_PATH_PREFIX, allowlist, enableRust).text;
  } catch (error) {
    throw new McpToolError('INTERNAL', error instanceof Error ? error.message : String(error));
  }
  return {
    source, target, enableRust, url, revision, templateMode, templates, allowlist, manifestText, warnings,
    initCommand: `west init -l --mf west.yml ${path.join(target, TEMPLATE_MANIFEST_DIR)}`,
  };
}

function createSteps(plan: CreatePlan): string[] {
  return [
    ...(plan.source === 'template' ? [`write ${path.join(plan.target, TEMPLATE_MANIFEST_DIR, 'west.yml')}`] : []),
    ...(plan.source === 'manifest' ? [`copy ${plan.manifestPath} to ${path.join(plan.target, 'manifest')}`] : []),
    plan.initCommand,
    ...(plan.enableRust ? [westEnableRustModuleSpec(plan.target).command] : []),
    'west update',
    'west boards (checks the workspace and lists its boards)',
    `write ${path.join(plan.target, '.vscode', 'settings.json')} (cmake.enableAutomaticKitScan false)`,
    `add ${plan.target} to the VS Code window`,
  ];
}

function createSummary(plan: CreatePlan): string {
  const from = plan.source === 'template'
    ? `the ${plan.templateMode} template${plan.templates?.length ? ` (${plan.templates.join(', ')})` : ''} of Zephyr ${plan.revision}${plan.url !== UPSTREAM_ZEPHYR_URL ? ` from ${plan.url}` : ''}`
    : plan.source === 'remote'
      ? `the manifest repository ${plan.url} at ${plan.revision}`
      : `the manifest ${plan.manifestPath}`;
  // Only the template flow on upstream Zephyr renders a manifest this extension
  // vouches for. A remote repository, or a local file anyone (an agent too) may
  // have written, names whatever remotes and projects it likes.
  // The dialog ends the summary with its own period.
  const trust = plan.source !== 'template' || plan.url !== UPSTREAM_ZEPHYR_URL
    ? '. The manifest decides which repositories are downloaded; they can bring west extension commands and module CMake code that run on this machine'
    : '';
  return `create a west workspace in ${plan.target} from ${from}${plan.enableRust ? ' with the Rust module' : ''}: west init and west update download Zephyr and its modules, which can take 10 to 45 minutes${trust}`;
}

async function createWorkspace(args: Record<string, unknown>, ctx: Ctx) {
  const { jobs, defaultWaitSeconds, services } = ctx.deps;
  const plan = await planCreate(args, ctx);
  assertWestEnvironment();
  assertNoConflictingJob(ctx, westClaim(plan.target));

  if (bool(args.dry_run) === true) {
    return {
      action: 'create', dry_run: true, west_workspace: plan.target, source: plan.source,
      steps: createSteps(plan),
      ...(plan.manifestText !== undefined ? { manifest: { path: path.join(plan.target, TEMPLATE_MANIFEST_DIR, 'west.yml'), text: plan.manifestText } } : {}),
      ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
      confirmation_required: confirmationRequired(ctx, args),
      next: 'Call manage_west_workspace again without dry_run to create it. Creating the venv and fetching blobs are separate actions afterwards.',
    };
  }

  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: createSummary(plan), folder: plan.target, scope: plan.target, scopeLabel: 'this new west workspace',
  }, args));
  const confirmation = confirmationOf(ctx, outcome);
  // The folder may have been used while the dialog was open.
  checkNewWorkspaceTarget(ctx, str(args.destination) as string, str(args.folder_name) ?? DEFAULT_FOLDER_NAME, plan.source);

  let jobId: string | undefined;
  const target = plan.target;
  const spec: JobSpec = {
    kind: 'west',
    lockKey: target,
    requestKey: `west:create:${normalizeForCompare(target)}`,
    westWorkspace: target,
    writes: ['west_workspace'],
    parse: false,
    command: redactCommandLine(plan.initCommand),
    run: async (sink, signal) => {
      const warnings = [...plan.warnings];
      let registration: { restart_pending: boolean; applied: boolean; waiting_for_jobs?: string[] } | undefined;
      let folderSettings: string | undefined;
      let failedStep: string | undefined;
      try {
        await initWestWorkspace({ enableRust: plan.enableRust, createVenv: false, fetchBlobs: false }, {
          init: async () => {
            let manifestPath = '';
            if (plan.source === 'template') {
              // Written by the job, not the plan: a dry run writes nothing.
              fs.mkdirSync(target, { recursive: true });
              const manifestDir = path.join(target, TEMPLATE_MANIFEST_DIR);
              fs.mkdirSync(manifestDir, { recursive: true });
              manifestPath = path.join(manifestDir, 'west.yml');
              fs.writeFileSync(manifestPath, plan.manifestText as string, 'utf8');
              sink.onData(`Wrote ${manifestPath}\n`);
            } else if (plan.source === 'manifest') {
              manifestPath = plan.manifestPath as string;
              prepareWestInitManifest('', target, manifestPath);
            }
            const initSpec = plan.source === 'remote'
              ? westInitSpec(plan.url as string, plan.revision as string, target, plan.manifestFile ?? '')
              : westInitSpec('', '', target, manifestPath);
            failedStep = 'west init';
            await runWestStep(ctx, westTask(initSpec), sink, signal, 'West init');
          },
          enableRust: async () => {
            failedStep = 'enabling the Rust module';
            await runWestStep(ctx, westTask(westEnableRustModuleSpec(target)), sink, signal, 'West enable Rust module');
          },
          update: async () => {
            failedStep = 'west update';
            await runWestStep(ctx, westTask(westUpdateSpec(target)), sink, signal, 'West update');
          },
          boards: async () => {
            failedStep = 'west boards';
            const check = await checkBoards(ctx, getWestWorkspace(target), 120_000);
            if (check.warning) {
              warnings.push(check.warning);
              sink.onData(`${check.warning}\n`);
            } else {
              sink.onData(`west boards lists ${check.boards} boards.\n`);
            }
          },
          createVenv: async () => undefined,
          fetchBlobs: async () => undefined,
          register: async () => {
            failedStep = 'adding the workspace to the window';
            // Written straight to the file: adding the folder may restart the
            // extensions, and nothing of this process survives that.
            folderSettings = await services.withFolderSettingsLock(target, () => writeFolderSettingsFile(target, WEST_WORKSPACE_FOLDER_SETTINGS));
            if (folderSettings === 'unparsable') {
              warnings.push(`${path.join(target, '.vscode', 'settings.json')} could not be parsed, so cmake.enableAutomaticKitScan was not set to false.`);
            }
            registration = await ctx.deps.folders.apply({ add: [target] }, { reason: `west workspace ${target} created by an agent`, jobId });
            sink.onData(registration.restart_pending
              ? `${target} is added to the window once this job ends; the extensions of the window restart then.\n`
              : `Added ${target} to the window.\n`);
            await ctx.deps.refreshViews(['westWorkspaces']);
          },
        }, {
          report: (_increment, message) => sink.onData(`\n${message}\n`),
          isCancelled: () => signal.aborted,
        });
      } catch (error) {
        const exitCode = error instanceof StepFailed ? error.exitCode : 1;
        sink.onData(`\n${error instanceof Error ? error.message : String(error)}\n`);
        return { exitCode: signal.aborted ? undefined : exitCode ?? 1, extra: { west_workspace: target, failed_step: failedStep, ...(warnings.length > 0 ? { warnings } : {}) } };
      }
      const described = describeWorkspace(target);
      return {
        exitCode: 0,
        extra: {
          west_workspace: described,
          manifest_path: (() => {
            try {
              return getWestWorkspace(target).manifestUri.fsPath;
            } catch {
              return undefined;
            }
          })(),
          restart_pending: registration?.restart_pending ?? false,
          ...(registration?.waiting_for_jobs ? { waiting_for_jobs: registration.waiting_for_jobs } : {}),
          folder_settings: folderSettings,
          ...(warnings.length > 0 ? { warnings } : {}),
        },
      };
    },
    next: view => {
      if (view.status !== 'succeeded') {
        const step = view.result?.failed_step;
        return `Creating the workspace ${view.status === 'cancelled' ? 'was cancelled' : `failed${step ? ` during ${step}` : ''}`}. Read the log with job {"action": "log", "job_id": "${view.job_id}"}, delete the folder ${target} it left, then call manage_west_workspace create again.`;
      }
      const restart = view.result?.restart_pending
        ? 'VS Code restarts the extensions of the window to add it: wait a few seconds and call get_status. Then '
        : 'Next, ';
      return `${restart}call manage_west_workspace with action "create_venv" to give it its own Python environment, with action "fetch_blobs" if its boards need binary blobs, then create an application with manage_app action "create".`;
    },
  };
  const { job, attached } = jobs.start(spec);
  jobId = job.id;
  return waitAndView(ctx, job, attached, num(args.wait_sec) ?? defaultWaitSeconds, confirmation);
}

async function importWorkspace(args: Record<string, unknown>, ctx: Ctx) {
  const { services } = ctx.deps;
  const root = str(args.path);
  if (!root) {
    throw invalid('import needs path, the absolute root of an existing west workspace (the folder that holds .west).');
  }
  if (!path.isAbsolute(root) || !isPlainPath(root)) {
    throw invalid(`path "${logSafe(root, 300)}" must be an absolute plain path.`);
  }
  if (getExactWorkspaceFolder(root)) {
    return {
      action: 'import', west_workspace: describeWorkspace(root), already_registered: true, restart_pending: false,
      next: 'It is already in the window. Call get_status to see it.',
    };
  }
  if (!WestWorkspace.isWestWorkspacePath(root)) {
    throw invalid(`"${logSafe(root, 300)}" is not a west workspace: it has no .west folder.`,
      'Pass the root of the workspace, or create one with manage_west_workspace action "create".');
  }
  let workspace: WestWorkspace;
  try {
    workspace = getWestWorkspace(root);
  } catch (error) {
    throw invalid(`The west workspace "${root}" cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      'Check .west/config, which must name the manifest.');
  }
  // No environment script is needed to register a workspace: the boards check
  // then only warns, as it does for any other reason west cannot list them.

  if (bool(args.dry_run) === true) {
    return {
      action: 'import', dry_run: true, west_workspace: describeWorkspace(root),
      steps: [`write ${path.join(root, '.vscode', 'settings.json')} (cmake.enableAutomaticKitScan false)`, 'west boards (checks the workspace and lists its boards)', `add ${root} to the VS Code window`],
      confirmation_required: confirmationRequired(ctx, args),
      next: 'Call manage_west_workspace again without dry_run to import it.',
    };
  }

  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: `add the west workspace ${root} (Zephyr ${workspace.version}) to the window`, folder: root, scope: root, scopeLabel: 'this west workspace',
  }, args));
  const warnings: string[] = [];
  const folderSettings = await services.withFolderSettingsLock(root, () => writeFolderSettingsFile(root, WEST_WORKSPACE_FOLDER_SETTINGS));
  if (folderSettings === 'unparsable') {
    warnings.push(`${path.join(root, '.vscode', 'settings.json')} could not be parsed, so cmake.enableAutomaticKitScan was not set to false.`);
  }
  // Before the folder is added: adding it may restart the extensions a moment after this answer.
  const budget = Math.max(1000, Math.min(LISTING_TIMEOUT_MS, remainingWaitMs(ctx, ctx.deps.defaultWaitSeconds) - CALL_MARGIN_MS));
  const boards = await checkBoards(ctx, workspace, budget);
  if (boards.warning) {
    warnings.push(boards.warning);
  }
  const registration = await ctx.deps.folders.apply({ add: [root] }, { reason: `west workspace ${root} imported by an agent` });
  await ctx.deps.refreshViews(['westWorkspaces']);
  const confirmation = confirmationOf(ctx, outcome);
  return {
    action: 'import',
    west_workspace: describeWorkspace(root),
    ...(boards.boards !== undefined ? { boards: boards.boards } : {}),
    applied: registration.applied,
    restart_pending: registration.restart_pending,
    ...(registration.waiting_for_jobs ? { waiting_for_jobs: registration.waiting_for_jobs } : {}),
    folder_settings: folderSettings,
    ...(confirmation ? { confirmation } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    next: registration.restart_pending
      ? 'VS Code restarts the extensions of the window to add it: wait a few seconds and call get_status.'
      : registration.applied
        ? 'Call get_status to see it, then manage_app action "create" to add an application.'
        : 'VS Code did not confirm the folder was added. Call get_status to check.',
  };
}

/** Start west update on a workspace as a job, as the tree's Update does, then refresh what depends on it. */
function startUpdateJob(ctx: Ctx, workspace: WestWorkspace, task: vscode.Task): { job: JobState; attached: boolean } {
  const root = workspace.rootUri.fsPath;
  const before = workspace.version;
  return ctx.deps.jobs.start({
    kind: 'west',
    lockKey: root,
    requestKey: `west:update:${normalizeForCompare(root)}`,
    westWorkspace: root,
    writes: ['west_workspace'],
    parse: false,
    command: 'west update',
    run: async (sink, signal) => {
      let exitCode: number | undefined;
      try {
        await runWestStep(ctx, task, sink, signal, 'West update');
        exitCode = 0;
      } catch (error) {
        exitCode = error instanceof StepFailed ? error.exitCode : 1;
        sink.onData(`\n${error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        // Even a failed update may have moved some projects.
        ctx.deps.services.catalog.invalidate(root);
      }
      const after = describeWorkspace(root).zephyr_version;
      const warnings: string[] = [];
      if (exitCode === 0) {
        const boards = await checkBoards(ctx, getWestWorkspace(root), 120_000);
        if (boards.warning) {
          warnings.push(boards.warning);
        }
      }
      await ctx.deps.refreshViews(['westWorkspaces']);
      return {
        exitCode,
        extra: {
          west_workspace: root,
          zephyr_version_before: before,
          zephyr_version_after: after,
          ...(warnings.length > 0 ? { warnings } : {}),
        },
      };
    },
    next: view => {
      if (view.status !== 'succeeded') {
        return `west update ${view.status === 'cancelled' ? 'was cancelled' : 'failed'}. Read the log with job {"action": "log", "job_id": "${view.job_id}"}; a local change in a project checkout is the usual reason.`;
      }
      return view.result?.zephyr_version_before !== view.result?.zephyr_version_after
        ? `Zephyr moved from ${view.result?.zephyr_version_before} to ${view.result?.zephyr_version_after}. Rebuild with build_app and pristine "always".`
        : 'The workspace is up to date. Rebuild with build_app; use pristine "always" if modules changed.';
    },
  });
}

async function updateWorkspace(args: Record<string, unknown>, ctx: Ctx) {
  const { workspace, root } = await resolveWorkspace(ctx, args);
  assertWestEnvironment(root);
  await assertWorkspaceIdle(ctx, root, westClaim(root));
  const apps = await linkedApps(ctx, root);
  const task = westTask(westUpdateSpec(root));

  if (bool(args.dry_run) === true) {
    return {
      action: 'update', dry_run: true, west_workspace: root, zephyr_version: workspace.version, command: 'west update',
      linked_apps: apps.map(app => app.appRootPath),
      confirmation_required: confirmationRequired(ctx, args),
      next: 'Call manage_west_workspace again without dry_run to update it.',
    };
  }
  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: `run west update in ${root}, which fetches every project of its manifest and moves their checkouts to the revisions it names`,
    folder: root, scope: root, scopeLabel: 'this west workspace',
  }, args));
  // A build may have started while the dialog was open.
  await assertWorkspaceIdle(ctx, root, westClaim(root));
  const { job, attached } = startUpdateJob(ctx, workspace, task);
  return waitAndView(ctx, job, attached, num(args.wait_sec) ?? ctx.deps.defaultWaitSeconds, confirmationOf(ctx, outcome));
}

/** The manifest state a set_manifest call asks for, checked against the projects the workspace offers. */
function planManifestState(args: Record<string, unknown>, workspace: WestWorkspace, warnings: string[]): {
  state: WestManagerApplyState; changed: string[]; before: string; after: string; rustBefore: boolean;
} {
  const details = getWorkspaceDetails(manifestWorkspaceOf(workspace));
  if (!details.supported) {
    throw invalid(details.unsupportedReason ?? 'This manifest topology is not supported.', 'Edit the manifest by hand instead.');
  }
  const importAll = bool(args.import_all) ?? (args.allowlist !== undefined ? false : details.importAll);
  let selected = details.importAll ? [...details.availableProjects] : [...details.selectedProjects];
  const allowlist = args.allowlist as ListEdit | undefined;
  if (allowlist !== undefined) {
    const known = new Set(details.availableProjects);
    const check = (name: string) => {
      assertWestProjectName(name, 'allowlist');
      if (!known.has(name)) {
        throw invalid(`The workspace offers no project "${logSafe(name, 64)}".`, 'Call search_zephyr_catalog with kind "project" to list them.',
          { available: details.availableProjects });
      }
      return name;
    };
    selected = editList(selected, allowlist, 'allowlist', check, name => name, (a, b) => a === b, warnings);
  }
  const revision = str(args.revision)?.trim() ?? '';
  const state: WestManagerApplyState = {
    rootPath: workspace.rootUri.fsPath,
    zephyrRevision: revision,
    importAll,
    selectedProjects: selected,
    rustEnabled: bool(args.enable_rust) ?? details.rustEnabled,
  };
  const manifest = manifestWorkspaceOf(workspace);
  const before = fs.readFileSync(manifest.manifestPath, 'utf8');
  let after: string;
  try {
    after = renderWorkspaceState(manifest, state);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error), 'Edit the manifest by hand instead.');
  }
  const changed: string[] = [];
  if (revision && revision !== details.zephyrRevision) {
    changed.push('revision');
  }
  if (importAll !== details.importAll) {
    changed.push('import_all');
  }
  if (!importAll) {
    // What the allowlist ends up holding: the Rust module is always kept in it while Rust is on.
    const wanted = [...new Set([...selected, ...(state.rustEnabled ? [ZEPHYR_LANG_RUST_PROJECT_NAME] : [])])];
    const current = details.selectedProjects;
    if (details.importAll || wanted.length !== current.length || wanted.some(name => !current.includes(name))) {
      changed.push('allowlist');
    }
  }
  if (state.rustEnabled !== details.rustEnabled) {
    changed.push('enable_rust');
  }
  return { state, changed, before, after, rustBefore: details.rustEnabled };
}

async function setManifest(args: Record<string, unknown>, ctx: Ctx) {
  const { workspace, root } = await resolveWorkspace(ctx, args);
  const allowlist = args.allowlist;
  if (allowlist !== undefined && (!allowlist || typeof allowlist !== 'object' || Array.isArray(allowlist))) {
    throw invalid('allowlist must be an object with set, add or remove.');
  }
  if (bool(args.import_all) === true && allowlist !== undefined) {
    throw invalid('import_all true imports every project, so it cannot be combined with allowlist.');
  }
  if (args.revision !== undefined) {
    assertGitRevision(str(args.revision) as string);
  }
  if (['revision', 'import_all', 'allowlist', 'enable_rust'].every(key => args[key] === undefined)) {
    throw invalid('set_manifest needs revision, import_all, allowlist or enable_rust.');
  }
  const update = bool(args.update) === true;
  const warnings: string[] = [];
  let plan = planManifestState(args, workspace, warnings);
  // The manifest may not change under a west job, and update also needs the workspace idle.
  assertNoConflictingJob(ctx, westClaim(root));
  let updateTask: vscode.Task | undefined;
  if (update) {
    assertWestEnvironment(root);
    await assertWorkspaceIdle(ctx, root, westClaim(root));
    updateTask = westTask(westUpdateSpec(root));
  }
  const diff = diffLines(plan.before, plan.after);
  if (plan.changed.length === 0 && !update) {
    return {
      action: 'set_manifest', west_workspace: root, changed: [], needs_update: false, ...(warnings.length > 0 ? { warnings } : {}),
      next: 'Nothing changed: the manifest already says this.',
    };
  }
  if (bool(args.dry_run) === true) {
    return {
      action: 'set_manifest', dry_run: true, west_workspace: root, changed: plan.changed,
      manifest_path: workspace.manifestUri.fsPath, diff,
      ...(plan.state.rustEnabled !== plan.rustBefore ? { west_config: `manifest.project-filter ${plan.state.rustEnabled ? 'gains' : 'loses'} +zephyr-lang-rust` } : {}),
      would_update: update,
      ...(warnings.length > 0 ? { warnings } : {}),
      confirmation_required: confirmationRequired(ctx, args),
      next: 'Call manage_west_workspace again without dry_run to apply it.',
    };
  }
  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: `edit the manifest of the west workspace ${root} (${plan.changed.join(', ') || 'no change'})${update ? ', then run west update, which moves the project checkouts to match' : ''}`,
    folder: root, scope: root, scopeLabel: 'this west workspace',
  }, args));
  const confirmation = confirmationOf(ctx, outcome);

  // Freshly read: a west job, a build or another edit may have come in while
  // the dialog was open. Every check that can refuse runs before the write,
  // and nothing is awaited from the last one until the update has started.
  if (update) {
    await assertWorkspaceIdle(ctx, root, westClaim(root));
  }
  assertNoConflictingJob(ctx, westClaim(root));
  const fresh = getWestWorkspace(root);
  plan = planManifestState(args, fresh, []);
  const freshDiff = diffLines(plan.before, plan.after);
  if (plan.changed.length > 0) {
    // Synchronous from reading to writing, so no other edit interleaves.
    applyWorkspaceState(manifestWorkspaceOf(fresh), plan.state);
    ctx.deps.services.catalog.invalidate(root);
  }
  let started: { job: JobState; attached: boolean } | undefined;
  let notStarted: McpToolError | undefined;
  if (update) {
    try {
      started = startUpdateJob(ctx, getWestWorkspace(root), updateTask as vscode.Task);
    } catch (error) {
      if (plan.changed.length === 0) {
        // Nothing was written and nothing ran: fail as action "update" does.
        throw error;
      }
      // The manifest is written by now, so the answer says so instead of failing.
      notStarted = toToolError(error);
    }
  }
  if (plan.changed.length > 0) {
    await ctx.deps.refreshViews(['westWorkspaces']);
  }
  const base = {
    action: 'set_manifest', west_workspace: root, changed: plan.changed, manifest_path: fresh.manifestUri.fsPath, diff: freshDiff,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(confirmation ? { confirmation } : {}),
  };
  if (!update) {
    return {
      ...base, needs_update: plan.changed.length > 0,
      next: 'Call manage_west_workspace with action "update" to fetch and check out what the manifest now names.',
    };
  }
  if (!started) {
    const error = notStarted as McpToolError;
    return {
      ...base, needs_update: true,
      update_error: { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) },
      next: `The manifest is written, but west update could not start (${error.message.replace(/\.$/, '')}). Call manage_west_workspace with action "update" once it can run.`,
    };
  }
  const { job, attached } = started;
  const view = await waitAndView(ctx, job, attached, num(args.wait_sec) ?? ctx.deps.defaultWaitSeconds);
  return { ...base, needs_update: job.status !== 'succeeded', job: view, next: view.next };
}

async function createVenv(args: Record<string, unknown>, ctx: Ctx) {
  const { workspace, root } = await resolveWorkspace(ctx, args);
  const venvDir = managedWorkspaceVenvDir(root);
  const claim = venvClaim(root, venvDir);
  assertWestEnvironment(root);
  await assertWorkspaceIdle(ctx, root, claim);
  const westPackages = zephyrVersionSupportsWestPackages(workspace.versionArray);
  const installs = `the base Python packages and Zephyr's Python requirements (${westPackages ? 'west packages pip' : 'requirements.txt'}), which include pyOCD`;

  if (bool(args.dry_run) === true) {
    return {
      action: 'create_venv', dry_run: true, west_workspace: root, venv_path: venvDir, replaces_existing: fs.existsSync(venvDir),
      installs, confirmation_required: confirmationRequired(ctx, args),
      next: 'Call manage_west_workspace again without dry_run to create it.',
    };
  }
  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: `create the Python virtual environment ${venvDir} for the west workspace ${root} and install ${installs} from PyPI`,
    folder: venvDir, scope: root, scopeLabel: 'this west workspace',
  }, args));
  await assertWorkspaceIdle(ctx, root, claim);

  const { job, attached } = ctx.deps.jobs.start({
    ...claim,
    requestKey: `install:venv:${normalizeForCompare(venvDir)}`,
    parse: false,
    command: `create the Python virtual environment ${venvDir}`,
    run: async (sink, signal) => {
      const runner: VenvRunner = {
        nonInteractive: true,
        signal,
        onOutput: chunk => sink.onData(chunk),
        runTask: async task => (await runCapturedTask(task, sink, signal, {
          reveal: REVEAL[ctx.deps.revealTerminal] ?? vscode.TaskRevealKind.Silent,
          header: `> [agent ${ctx.client.name ?? 'mcp'}] Create workspace venv`,
        })).exitCode,
      };
      let stored: string | undefined;
      try {
        stored = await createWorkspaceVenv(ctx.deps.extensionContext, createWorkspaceFolderReference(root), runner);
      } catch (error) {
        sink.onData(`\n${error instanceof Error ? error.message : String(error)}\n`);
        return {
          exitCode: signal.aborted ? undefined : 1,
          extra: { venv_path: venvDir, ...(error instanceof VenvSetupError ? { error_code: error.code } : {}) },
        };
      }
      if (!stored) {
        return { exitCode: 1, extra: { venv_path: venvDir } };
      }
      const setting = await ctx.deps.services.withFolderSettingsLock(root, () => storeWorkspaceVenvPath(root, stored as string));
      const python = await runVersion(path.join(venvDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3'), ['--version']);
      const west = await runVersion(getManagedVenvWestPath(venvDir), ['--version']);
      await ctx.deps.refreshViews(['westWorkspaces', 'apps']);
      return {
        exitCode: 0,
        extra: {
          venv_path: venvDir,
          // Without the folder in the window, the venv is found as <root>/.venv instead.
          setting: setting ? `venv.path = ${stored}` : 'not stored: the venv is found as <root>/.venv',
          ...(python ? { python_version: python } : {}),
          ...(west ? { west_version: west } : {}),
          installed: installs,
        },
      };
    },
    next: view => {
      if (view.status === 'succeeded') {
        return 'The venv is ready; every application of the workspace that does not set its own venv builds with it. Call build_app to build.';
      }
      const code = view.result?.error_code;
      return code === 'ENV_NOT_READY'
        ? 'The host tools are not installed. Call check_environment and ask the user to run the command it names.'
        : code === 'EXECUTION_POLICY'
          ? 'PowerShell may not run the venv installer. Ask the user to allow scripts for their account (Set-ExecutionPolicy -Scope CurrentUser RemoteSigned), then retry.'
          : `Creating the venv failed. Read the log with job {"action": "log", "job_id": "${view.job_id}"}.`;
    },
  });
  return waitAndView(ctx, job, attached, num(args.wait_sec) ?? ctx.deps.defaultWaitSeconds, confirmationOf(ctx, outcome));
}

async function installPythonDeps(args: Record<string, unknown>, ctx: Ctx) {
  const { workspace, root } = await resolveWorkspace(ctx, args);
  if (!zephyrVersionSupportsWestPackages(workspace.versionArray)) {
    throw invalid(`west packages needs Zephyr 3.6 or newer, and "${root}" is on ${workspace.version}.`,
      'Recreate the venv with manage_west_workspace action "create_venv", which installs requirements.txt on this Zephyr.');
  }
  const venv = describeWorkspaceVenv(workspace);
  if (!venv.path || !fs.existsSync(venv.path)) {
    throw new McpToolError('ENV_NOT_READY', `The west workspace "${root}" has no Python environment to install into.`, {
      hint: 'Create one with manage_west_workspace action "create_venv".',
    });
  }
  const claim = venvClaim(root, venv.path);
  assertWestEnvironment(root);
  await assertWorkspaceIdle(ctx, root, claim);
  const spec = westPackagesInstallSpec(root);
  const task = westTask(spec, venv.path);

  if (bool(args.dry_run) === true) {
    return {
      action: 'install_python_deps', dry_run: true, west_workspace: root, command: spec.command, venv_path: venv.path, venv_source: venv.source,
      confirmation_required: confirmationRequired(ctx, args),
      next: 'Call manage_west_workspace again without dry_run to install them.',
    };
  }
  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: `install the Python packages the modules of ${root} need into ${venv.path} with west packages pip --install, downloading them from PyPI`,
    folder: venv.path, scope: root, scopeLabel: 'this west workspace',
  }, args));
  await assertWorkspaceIdle(ctx, root, claim);
  const { job, attached } = ctx.deps.jobs.start({
    ...claim,
    requestKey: `install:packages:${normalizeForCompare(venv.path)}`,
    parse: false,
    command: spec.command,
    run: async (sink, signal) => {
      try {
        await runWestStep(ctx, task, sink, signal, 'West packages pip --install');
        return { exitCode: 0, extra: { venv_path: venv.path, venv_source: venv.source } };
      } catch (error) {
        sink.onData(`\n${error instanceof Error ? error.message : String(error)}\n`);
        return { exitCode: error instanceof StepFailed ? error.exitCode : 1, extra: { venv_path: venv.path, venv_source: venv.source } };
      }
    },
    next: view => (view.status === 'succeeded'
      ? 'The Python packages are installed. Call build_app to build.'
      : `Installing the packages failed. Read the log with job {"action": "log", "job_id": "${view.job_id}"}.`),
  });
  return waitAndView(ctx, job, attached, num(args.wait_sec) ?? ctx.deps.defaultWaitSeconds, confirmationOf(ctx, outcome));
}

/** The blobs of a workspace, bounded by what is left of the call. */
async function listBlobs(ctx: Ctx, workspace: WestWorkspace) {
  const budget = Math.max(1000, Math.min(LISTING_TIMEOUT_MS, remainingWaitMs(ctx, ctx.deps.defaultWaitSeconds) - CALL_MARGIN_MS));
  const listing = await within(ctx.deps.services.catalog.list('blob', workspace, undefined, false), budget);
  if (!listing) {
    throw new McpToolError('TIMEOUT', 'west blobs list did not finish in time. It keeps running, so a retry picks up its result.', {
      hint: 'Call the same action again in a few seconds.',
    });
  }
  return listing.entries as Array<{ name: string; module: string; status: string }>;
}

async function fetchBlobs(args: Record<string, unknown>, ctx: Ctx) {
  const { workspace, root } = await resolveWorkspace(ctx, args);
  if (!workspace.supportsBlobs) {
    throw invalid(`west blobs needs Zephyr 3.2 or newer, and "${root}" is on ${workspace.version}.`);
  }
  assertWestEnvironment(root);
  const modules = [...new Set((args.modules as string[] | undefined) ?? [])];
  for (const module of modules) {
    assertWestProjectName(module, 'modules');
  }
  const autoAccept = workspace.supportsBlobsAutoAccept;
  if (autoAccept && bool(args.accept_blob_licenses) !== true) {
    throw invalid(`Zephyr ${workspace.version} fetches blobs with --auto-accept, which accepts their click-through licenses for the user.`,
      'Ask the user whether they accept the licenses of these blobs, then call again with accept_blob_licenses true.');
  }
  await assertWorkspaceIdle(ctx, root, westClaim(root));
  let pending: Array<{ name: string; module: string; status: string }> | undefined;
  if (modules.length > 0 || bool(args.dry_run) === true) {
    const blobs = await listBlobs(ctx, workspace);
    const known = new Set(blobs.map(blob => blob.module));
    const unknown = modules.filter(module => !known.has(module));
    if (unknown.length > 0) {
      throw invalid(`No module ${unknown.map(name => `"${name}"`).join(', ')} declares a blob in this workspace.`,
        'Call search_zephyr_catalog with kind "blob" to list them.', { modules: [...known].sort() });
    }
    pending = blobs.filter(blob => blob.status !== 'present' && (modules.length === 0 || modules.includes(blob.module)));
  }
  const spec = westBlobsFetchSpec(root, autoAccept, modules);
  const task = westTask(spec);

  if (bool(args.dry_run) === true) {
    return {
      action: 'fetch_blobs', dry_run: true, west_workspace: root, command: spec.command, accepts_licenses: autoAccept,
      to_fetch: (pending ?? []).map(blob => ({ module: blob.module, path: blob.name, status: blob.status })),
      confirmation_required: confirmationRequired(ctx, args, autoAccept),
      next: 'Call manage_west_workspace again without dry_run to fetch them.',
    };
  }
  const what = modules.length > 0 ? `the binary blobs of ${modules.join(', ')}` : 'every binary blob';
  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: autoAccept
      ? `fetch ${what} of the west workspace ${root} and accept their click-through licenses on your behalf (west blobs fetch --auto-accept)`
      : `fetch ${what} of the west workspace ${root} (west blobs fetch)`,
    folder: root, scope: root, scopeLabel: 'this west workspace',
  }, args), autoAccept ? { always: true } : {});
  await assertWorkspaceIdle(ctx, root, westClaim(root));
  const { job, attached } = ctx.deps.jobs.start({
    ...westClaim(root),
    requestKey: `west:blobs:${normalizeForCompare(root)}:${modules.join(',')}`,
    parse: false,
    command: spec.command,
    run: async (sink, signal) => {
      let exitCode: number | undefined;
      try {
        await runWestStep(ctx, task, sink, signal, 'West blobs fetch');
        exitCode = 0;
      } catch (error) {
        exitCode = error instanceof StepFailed ? error.exitCode : 1;
        sink.onData(`\n${error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        ctx.deps.services.catalog.invalidate(root);
      }
      return { exitCode, extra: { west_workspace: root, accepted_licenses: autoAccept, ...(modules.length > 0 ? { modules } : {}) } };
    },
    next: view => (view.status === 'succeeded'
      ? 'The blobs are fetched. Call build_app to build.'
      : `Fetching the blobs failed. Read the log with job {"action": "log", "job_id": "${view.job_id}"}.`),
  });
  return waitAndView(ctx, job, attached, num(args.wait_sec) ?? ctx.deps.defaultWaitSeconds, confirmationOf(ctx, outcome));
}

export const manageWestWorkspace: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const action = str(args.action) ?? '';
  if (!(MANAGE_ACTIONS as readonly string[]).includes(action)) {
    throw invalid(`action must be one of ${MANAGE_ACTIONS.join(', ')}.`);
  }
  const act = action as ManageAction;
  checkAccepted(args, ['action', 'dry_run', 'wait_sec', ...ACTION_ARGS[act]], `action "${act}"`);
  checkTypes(args,
    ['west_workspace', 'source', 'destination', 'folder_name', 'url', 'revision', 'manifest_file', 'manifest_path', 'template_mode', 'path'],
    ['enable_rust', 'import_all', 'update', 'accept_blob_licenses', 'dry_run'],
    ['templates', 'projects', 'modules']);
  switch (act) {
    case 'create':
      return createWorkspace(args, ctx);
    case 'import':
      return importWorkspace(args, ctx);
    case 'update':
      return updateWorkspace(args, ctx);
    case 'set_manifest':
      return setManifest(args, ctx);
    case 'create_venv':
      return createVenv(args, ctx);
    case 'install_python_deps':
      return installPythonDeps(args, ctx);
    default:
      return fetchBlobs(args, ctx);
  }
};

// configure target "west_workspace"

const UPDATE_ARGS = ['target', 'action', 'west_workspace', 'roots', 'venv', 'dry_run'];

/** An agent root path made absolute: workbench variables expanded, relative paths taken from the workspace. */
function absoluteRoot(folder: vscode.WorkspaceFolder, root: string, value: string): string {
  const trimmed = value.trim();
  const expanded = trimmed.includes('${') ? resolveConfiguredPath(trimmed, folder) ?? trimmed : trimmed;
  if (expanded.includes('${')) {
    throw invalid(`"${logSafe(value, 200)}" uses a variable that cannot be expanded here.`, 'Pass an absolute path, or one relative to the west workspace.');
  }
  return path.resolve(root, expanded);
}

interface SettingsPlan {
  roots: Record<string, string[]>;
  venv?: { path?: string };
  changed: string[];
  warnings: string[];
}

async function planWorkspaceSettings(ctx: Ctx, args: Record<string, unknown>, workspace: WestWorkspace, folder: vscode.WorkspaceFolder): Promise<SettingsPlan> {
  const root = workspace.rootUri.fsPath;
  const plan: SettingsPlan = { roots: {}, changed: [], warnings: [] };
  const roots = args.roots;
  if (roots !== undefined) {
    if (!roots || typeof roots !== 'object' || Array.isArray(roots)) {
      throw invalid('roots must be an object keyed by BOARD_ROOT, DTS_ROOT, SOC_ROOT, ARCH_ROOT or SNIPPET_ROOT.');
    }
    const known = await ctx.deps.services.knownRoots();
    for (const [key, edit] of Object.entries(roots as Record<string, unknown>)) {
      if (edit === undefined) {
        continue;
      }
      if (!WEST_ROOT_KEYS.includes(key)) {
        throw invalid(`roots.${key} is not a west workspace root list.`, undefined, { allowed: [...WEST_ROOT_KEYS] });
      }
      if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
        throw invalid(`roots.${key} must be an object with set, add or remove.`);
      }
      const label = `roots.${key}`;
      const current = toEnvList(workspace.envVars[key]);
      const next = editList(current, edit as ListEdit, label,
        value => {
          assertEnvListElement(value, label);
          const absolute = absoluteRoot(folder, root, value);
          assertInside(absolute, known, label);
          if (!fs.existsSync(absolute)) {
            plan.warnings.push(`${label}: "${absolute}" does not exist yet. It is stored anyway; builds fail until it exists.`);
          }
          return absolute;
        },
        value => absoluteRoot(folder, root, value),
        samePath, plan.warnings);
      if (next.length !== current.length || next.some((entry, index) => entry !== current[index])) {
        plan.roots[key] = next;
        plan.changed.push(label);
      }
    }
  }
  const venv = args.venv;
  if (venv !== undefined) {
    if (!venv || typeof venv !== 'object' || Array.isArray(venv)) {
      throw invalid('venv must be an object with mode, and path for mode "path".');
    }
    const { mode, path: venvPath, ...rest } = venv as Record<string, unknown>;
    if (Object.keys(rest).length > 0) {
      throw invalid(`venv does not take ${Object.keys(rest).join(', ')}.`);
    }
    const stored = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, folder)
      .inspect?.<string>(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY)?.workspaceFolderValue;
    const currentPath = typeof stored === 'string' && stored.trim() ? resolveConfiguredPath(stored, folder) ?? stored : undefined;
    if (mode === 'inherit') {
      if (venvPath !== undefined) {
        throw invalid('venv.path only goes with mode "path".');
      }
      if (currentPath !== undefined) {
        plan.venv = {};
        plan.changed.push('venv');
      }
    } else if (mode === 'path') {
      if (typeof venvPath !== 'string' || !venvPath.trim()) {
        throw invalid('venv mode "path" needs path, the absolute root of a Python virtual environment.');
      }
      if (!path.isAbsolute(venvPath)) {
        throw invalid(`venv.path "${logSafe(venvPath, 300)}" is not an absolute path.`);
      }
      const reason = validateVenvDirectory(venvPath);
      if (reason) {
        throw invalid(`venv.path "${logSafe(venvPath, 300)}" cannot be used: ${reason}`);
      }
      if (currentPath === undefined || !samePath(currentPath, venvPath)) {
        plan.venv = { path: path.resolve(venvPath) };
        plan.changed.push('venv');
      }
    } else {
      throw invalid('venv.mode must be "inherit" or "path".');
    }
  }
  return plan;
}

/** configure with target "west_workspace" and action "update". */
export async function updateWestWorkspace(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  checkAccepted(args, UPDATE_ARGS, 'target "west_workspace"');
  checkTypes(args, ['west_workspace'], ['dry_run']);
  if (args.roots === undefined && args.venv === undefined) {
    throw invalid('target "west_workspace" needs roots or venv to change.');
  }
  const { services } = ctx.deps;
  const { workspace, root } = await resolveWorkspace(ctx, args);
  const folder = getExactWorkspaceFolder(root);
  if (!folder) {
    throw invalid(`"${root}" is not a folder of this window, so it has no folder settings to change.`,
      'Add it with manage_west_workspace action "import" first, which only the full toolset offers.');
  }
  const plan = await planWorkspaceSettings(ctx, args, workspace, folder);
  const base = { target: 'west_workspace', action: 'update', west_workspace: root, settings_file: path.join(root, '.vscode', 'settings.json') };
  if (plan.changed.length === 0) {
    return { ...base, changed: [], warnings: plan.warnings, next: 'Nothing changed: the workspace already has these settings.' };
  }
  if (bool(args.dry_run) === true) {
    return {
      ...base, dry_run: true, changed: plan.changed,
      ...(Object.keys(plan.roots).length > 0 ? { roots: plan.roots } : {}),
      ...(plan.venv ? { venv: plan.venv.path ? { mode: 'path', path: plan.venv.path } : { mode: 'inherit' } } : {}),
      warnings: plan.warnings,
      confirmation_required: confirmationRequired(ctx, args),
      next: 'Call configure again without dry_run to write it.',
    };
  }
  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: `change ${plan.changed.join(', ')} of the west workspace ${root}`,
    folder: root, scope: root, scopeLabel: 'this west workspace',
  }, args));

  return services.withFolderSettingsLock(root, async () => {
    // Planned again against the values stored now, so two calls never drop each other's change.
    const fresh = getWestWorkspace(root);
    const freshPlan = await planWorkspaceSettings(ctx, args, fresh, folder);
    try {
      for (const [key, values] of Object.entries(freshPlan.roots)) {
        await saveEnv(folder, key, values);
      }
      if (freshPlan.venv) {
        await setWorkspaceVenvPath(folder, freshPlan.venv.path ?? '');
      }
    } catch (error) {
      throw new McpToolError('INTERNAL', `VS Code could not write ${base.settings_file}: ${error instanceof Error ? error.message : String(error)}`, {
        hint: `Ask the user to save or close ${base.settings_file} if it has unsaved changes, and to fix it if it is not valid JSON, then retry.`,
      });
    }
    const rootsChanged = Object.keys(freshPlan.roots).length > 0;
    if (rootsChanged) {
      services.catalog.invalidate(root);
    }
    await ctx.deps.refreshViews(['westWorkspaces']);
    const after = getWestWorkspace(root);
    const venv = describeWorkspaceVenv(after);
    const confirmation = confirmationOf(ctx, outcome);
    return {
      ...base,
      changed: freshPlan.changed,
      roots: Object.fromEntries(WEST_ROOT_KEYS.map(key => [key, toEnvList(after.envVars[key])])),
      venv: { ...(venv.path ? { path: venv.path } : {}), source: venv.source },
      ...(confirmation ? { confirmation } : {}),
      warnings: freshPlan.warnings,
      next: rootsChanged
        ? 'Call search_zephyr_catalog with refresh true to see boards from the new roots, and build_app with pristine "always": a CMake cache keeps the roots it was configured with.'
        : 'Call build_app to build with this venv.',
    };
  });
}

// remove_or_delete

/** The paths the window registers as toolchains, which a workspace deletion must never take with it. */
async function toolchainRoots(ctx: Ctx): Promise<string[]> {
  const sdks = await ctx.deps.services.listSdks().catch(() => []);
  const { armGnu, iar, rust } = await ctx.deps.services.listOtherToolchains();
  return [
    ...sdks.map(sdk => sdk.rootUri.fsPath),
    ...armGnu.map(toolchain => toolchain.toolchainPath),
    ...iar.map(toolchain => toolchain.iarPath),
    ...rust.map(toolchain => toolchain.toolchainPath),
  ].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/** Refuse while a Kconfig server, whose working folder would be deleted, runs inside `folder`. */
function assertNoKconfigServerIn(ctx: Ctx, folder: string): void {
  const editor = ctx.deps.services.kconfigEditors().find(candidate => isInside(candidate.buildDir, folder));
  if (editor) {
    throw new McpToolError('BUSY_EXTERNAL', `The Kconfig Manager is open on ${editor.configName}, whose build folder is inside "${folder}".`, {
      hint: `Ask the user to close the Kconfig Manager tab of ${editor.configName}, then retry.`,
    });
  }
  if (ctx.deps.kconfig.inUseWithin(folder).length > 0) {
    throw new McpToolError('BUSY', `A query_kconfig or set_kconfig call is reading a build inside "${folder}".`, { hint: 'Retry once it has answered.' });
  }
}

/** Any working job that touches the workspace at all: its tree, a build inside it, or its venv. */
function assertNoJobIn(ctx: Ctx, root: string): void {
  const holder = ctx.deps.jobs.list().find(job => isWorking(job) && (
    (!!job.spec.westWorkspace && samePath(job.spec.westWorkspace, root))
    || (!!job.spec.buildDir && (isInside(job.spec.buildDir, root) || isInside(root, job.spec.buildDir)))
    || (!!job.spec.venvPath && isInside(job.spec.venvPath, root))
    || job.spec.lockKey === root));
  if (holder) {
    throw new McpToolError('BUSY', `A ${holder.spec.kind} job is working with this west workspace (job_id "${holder.id}").`, {
      hint: `Wait for it with job {"action": "status", "job_id": "${holder.id}"}, or stop it with job {"action": "cancel", "job_id": "${holder.id}"}, then retry.`,
      details: { job_id: holder.id, kind: holder.spec.kind },
    });
  }
}

async function removeFromWindow(args: Record<string, unknown>, ctx: Ctx) {
  const { root } = await resolveWorkspace(ctx, args);
  if (!getExactWorkspaceFolder(root)) {
    throw invalid(`"${root}" is not a folder of this window.`, 'Only a west workspace that is a folder of the window can be removed from it.');
  }
  const apps = await linkedApps(ctx, root);
  if (apps.length > 0 && bool(args.force) !== true) {
    throw invalid(`${apps.length} application(s) of this window build with "${root}".`,
      'They cannot build once it is gone. Pass force true to remove it anyway.', { linked_apps: apps.map(app => app.appRootPath) });
  }
  assertNoJobIn(ctx, root);
  await assertWorkspaceIdle(ctx, root, westClaim(root));
  if (bool(args.dry_run) === true) {
    return {
      what: 'west_workspace', dry_run: true, west_workspace: root, keeps_files: true, linked_apps: apps.map(app => app.appRootPath),
      confirmation_required: confirmationRequired(ctx, args),
      next: 'Call remove_or_delete again without dry_run to remove it from the window.',
    };
  }
  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: `remove the west workspace ${root} from the window, keeping its files`, folder: root, scope: root, scopeLabel: 'this west workspace',
  }, args));
  assertNoJobIn(ctx, root);
  const change = await ctx.deps.folders.apply({ remove: [root] }, { reason: `west workspace ${root} removed by an agent` });
  ctx.deps.services.catalog.invalidate(root);
  await ctx.deps.refreshViews(['westWorkspaces', 'apps']);
  const confirmation = confirmationOf(ctx, outcome);
  return {
    what: 'west_workspace', west_workspace: root, removed: change.applied, restart_pending: change.restart_pending,
    ...(change.waiting_for_jobs ? { waiting_for_jobs: change.waiting_for_jobs } : {}),
    kept_files: true, linked_apps: apps.map(app => app.appRootPath),
    ...(confirmation ? { confirmation } : {}),
    next: change.restart_pending
      ? 'VS Code restarts the extensions of the window to remove it: wait a few seconds and call get_status.'
      : 'Done. Bring it back with manage_west_workspace action "import".',
  };
}

/**
 * What deleting the workspace at `root` must spare, read from the window as it
 * is now, and the linked applications the deletion takes with it or leaves
 * without a workspace.
 */
async function deletionFence(ctx: Ctx, root: string) {
  const { services } = ctx.deps;
  const apps = await services.listApplications();
  const linked = apps.filter(app => !!app.westWorkspaceRootPath && samePath(app.westWorkspaceRootPath, root));
  const inside = linked.filter(app => isInside(app.appRootPath, root));
  const outside = linked.filter(app => !isInside(app.appRootPath, root));
  const others = [
    ...services.listWestWorkspaces().map(workspace => workspace.rootUri.fsPath),
    ...apps.map(app => app.westWorkspaceRootPath).filter((entry): entry is string => !!entry),
  ].filter(candidate => !samePath(candidate, root));
  const windowFolders = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
  const foreign = [
    ...windowFolders,
    ...apps.filter(app => !app.isWestWorkspaceApplication || !samePath(app.westWorkspaceRootPath, root)).map(app => app.appRootPath),
  ].filter(candidate => !samePath(candidate, root));
  const fenceInput = { root, home: os.homedir(), otherWorkspaces: others, toolchains: await toolchainRoots(ctx), foreignFolders: foreign };
  return { fenceInput, inside, outside };
}

function assertNoAppLinkedFromOutside(args: Record<string, unknown>, root: string, outside: readonly ZephyrApplication[]): void {
  if (outside.length > 0 && bool(args.force) !== true) {
    throw invalid(`${outside.length} application(s) outside "${root}" build with it.`,
      'They cannot build once it is gone. Pass force true to delete it anyway.', { linked_apps: outside.map(app => app.appRootPath) });
  }
}

async function deleteFiles(args: Record<string, unknown>, ctx: Ctx) {
  const { services, jobs, defaultWaitSeconds } = ctx.deps;
  const { root } = await resolveWorkspace(ctx, args);
  const claim: JobClaim = { ...westClaim(root, 'clean'), buildDir: root };
  const { fenceInput, inside, outside } = await deletionFence(ctx, root);
  const { exists } = checkWestWorkspaceDeletion(fenceInput);
  if (!exists) {
    return { what: 'west_workspace_files', west_workspace: root, deleted: false, already_gone: true, next: 'There is nothing to delete.' };
  }
  assertNoAppLinkedFromOutside(args, root, outside);
  assertNoJobIn(ctx, root);
  await assertWorkspaceIdle(ctx, root, claim);
  assertNoKconfigServerIn(ctx, root);

  if (bool(args.dry_run) === true) {
    const size = await folderSize(root, { deadline: Date.now() + SIZE_TIMEOUT_MS });
    return {
      what: 'west_workspace_files', dry_run: true, west_workspace: root,
      size_bytes: size.bytes, files: size.files, ...(size.complete ? {} : { size_is_partial: true }),
      apps_inside: inside.map(app => app.appRootPath), apps_linked_elsewhere: outside.map(app => app.appRootPath),
      confirmation_required: confirmationRequired(ctx, args),
      next: 'Call remove_or_delete again without dry_run to delete it.',
    };
  }
  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: `delete the west workspace ${root} from disk, with its Zephyr tree and modules${inside.length > 0 ? ` and ${inside.length} application(s) inside it` : ''}`,
    folder: root, scope: root, scopeLabel: 'this west workspace',
  }, args));
  const confirmation = confirmationOf(ctx, outcome);
  // Something may have started, been registered inside it or linked to it, or
  // the folder changed while the dialog was open: every check runs again on
  // what the window holds now, the synchronous ones last, right before the job.
  await assertWorkspaceIdle(ctx, root, claim);
  const now = await deletionFence(ctx, root);
  checkWestWorkspaceDeletion(now.fenceInput);
  assertNoAppLinkedFromOutside(args, root, now.outside);
  assertNoJobIn(ctx, root);
  assertNoKconfigServerIn(ctx, root);

  let removal: 'removed' | 'absent' | 'busy' | undefined;
  let jobId: string | undefined;
  let change: { restart_pending: boolean } | undefined;
  const { job } = jobs.start({
    ...westClaim(root, 'clean'),
    // So build_app refuses to build in a folder inside it while it goes.
    buildDir: root,
    requestKey: `clean:west_workspace:${normalizeForCompare(root)}`,
    command: `delete ${root}`,
    parse: false,
    run: async sink => {
      sink.onData(`Deleting ${root}\n`);
      const reopenKconfig = await ctx.deps.kconfig.closeWithin(root);
      try {
        // Taken out of the window first; a change that restarts the
        // extensions waits for this job to end.
        removal = await deleteWestWorkspace(root, {
          unregister: async () => {
            change = await ctx.deps.folders.apply({ remove: [root] }, { reason: `west workspace ${root} deleted by an agent`, jobId });
          },
          remove: dir => removeDirectory(dir),
        }, createWorkspaceFolderReference(root));
      } catch (error) {
        sink.onData(`${root} could not be deleted: ${error instanceof Error ? error.message : String(error)}\n`);
        return { exitCode: 1 };
      } finally {
        reopenKconfig();
        services.catalog.invalidate(root);
        await ctx.deps.refreshViews(['westWorkspaces', 'apps']);
      }
      if (removal === 'busy') {
        sink.onData(`Some files in ${root} are in use, so it was not fully deleted.\n`);
        return { exitCode: 1 };
      }
      sink.onData(`Deleted ${root}\n`);
      return { exitCode: 0, extra: { west_workspace: root, restart_pending: change?.restart_pending ?? false } };
    },
  });
  jobId = job.id;
  ctx.audit.jobId = job.id;
  await jobs.wait(job, remainingWaitMs(ctx, num(args.wait_sec) ?? defaultWaitSeconds), progressWait(ctx, jobs));
  if (!isTerminal(job.status)) {
    return {
      what: 'west_workspace_files', west_workspace: root, status: 'running', job: jobs.view(job, { parse: false }),
      ...(confirmation ? { confirmation } : {}),
      next: `The deletion is still running. Call job {"action": "status", "job_id": "${job.id}"} until it ends.`,
    };
  }
  if (removal === 'busy') {
    throw new McpToolError('BUSY_EXTERNAL', `Some files in "${root}" are in use, so it was only partly deleted.`, {
      hint: 'Ask the user to close any terminal, editor or tool using that folder, then call remove_or_delete again.',
      details: { folder: root, still_exists: fs.existsSync(root), job_id: job.id },
    });
  }
  if (job.status !== 'succeeded') {
    throw new McpToolError('INTERNAL', `Deleting "${root}" ${job.status === 'cancelled' ? 'was cancelled' : 'failed'}: ${jobs.lastLine(job, 300)}`, {
      details: { job_id: job.id, log: job.log.filePath },
    });
  }
  return {
    what: 'west_workspace_files', west_workspace: root, deleted: removal !== 'absent',
    restart_pending: change?.restart_pending ?? false, apps_removed: now.inside.map(app => app.appRootPath),
    ...(confirmation ? { confirmation } : {}),
    job_id: job.id,
    next: change?.restart_pending
      ? 'Deleted. VS Code restarts the extensions of the window to drop its folder: wait a few seconds and call get_status.'
      : 'Deleted. Call get_status to see the remaining west workspaces.',
  };
}

async function removeVenv(args: Record<string, unknown>, ctx: Ctx) {
  const { services, jobs, defaultWaitSeconds } = ctx.deps;
  const { workspace, root } = await resolveWorkspace(ctx, args);
  const folder = getExactWorkspaceFolder(root);
  const managed = managedWorkspaceVenvDir(root);
  const hasManaged = fs.existsSync(managed);
  const stored = folder
    ? vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, folder).inspect?.<string>(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY)?.workspaceFolderValue
    : undefined;
  const hasSetting = typeof stored === 'string' && stored.trim().length > 0;
  const configured = hasSetting ? workspace.venvPath : undefined;
  if (!hasManaged && !hasSetting) {
    return { what: 'workspace_venv', west_workspace: root, removed: false, nothing_to_remove: true, next: 'This workspace has no venv of its own.' };
  }
  // The job itself only conflicts on the managed venv, so the configured one
  // is checked last, with nothing awaited before the job starts.
  const assertVenvIdle = async () => {
    await assertWorkspaceIdle(ctx, root, venvClaim(root, managed, 'clean'));
    for (const venv of [managed, configured].filter((entry): entry is string => !!entry)) {
      assertNoConflictingJob(ctx, venvClaim(root, venv, 'clean'));
    }
  };
  await assertVenvIdle();
  const external = configured && !isInside(configured, root) ? configured : undefined;

  if (bool(args.dry_run) === true) {
    return {
      what: 'workspace_venv', dry_run: true, west_workspace: root,
      clears_setting: hasSetting, ...(hasManaged ? { would_delete: managed } : {}), ...(external ? { keeps_external_venv: external } : {}),
      confirmation_required: confirmationRequired(ctx, args),
      next: 'Call remove_or_delete again without dry_run to remove it.',
    };
  }
  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: `remove the venv of the west workspace ${root}${hasManaged ? ` and delete ${managed}` : ''}`,
    folder: hasManaged ? managed : root, scope: root, scopeLabel: 'this west workspace',
  }, args));
  const confirmation = confirmationOf(ctx, outcome);
  // A build may have started while the dialog was open.
  await assertVenvIdle();

  let removal: 'removed' | 'absent' | 'busy' | undefined;
  const { job } = jobs.start({
    ...venvClaim(root, managed, 'clean'),
    requestKey: `clean:venv:${normalizeForCompare(managed)}`,
    command: `delete ${managed}`,
    parse: false,
    run: async sink => {
      try {
        const remove = async (dir: string) => {
          sink.onData(`Deleting ${dir}\n`);
          removal = await removeDirectory(dir);
        };
        if (folder) {
          await services.withFolderSettingsLock(root, () => removeWorkspaceVenv(folder, remove));
        } else if (hasManaged) {
          await remove(managed);
        }
      } catch (error) {
        sink.onData(`The venv could not be removed: ${error instanceof Error ? error.message : String(error)}\n`);
        return { exitCode: 1 };
      }
      await ctx.deps.refreshViews(['westWorkspaces', 'apps']);
      return { exitCode: removal === 'busy' ? 1 : 0 };
    },
  });
  ctx.audit.jobId = job.id;
  await jobs.wait(job, remainingWaitMs(ctx, num(args.wait_sec) ?? defaultWaitSeconds), progressWait(ctx, jobs));
  if (!isTerminal(job.status)) {
    return {
      what: 'workspace_venv', west_workspace: root, status: 'running', job: jobs.view(job, { parse: false }),
      ...(confirmation ? { confirmation } : {}),
      next: `The removal is still running. Call job {"action": "status", "job_id": "${job.id}"} until it ends.`,
    };
  }
  if (removal === 'busy') {
    throw new McpToolError('BUSY_EXTERNAL', `Some files in "${managed}" are in use, so it was only partly deleted.`, {
      hint: 'Ask the user to close any terminal or Python process using that venv, then call remove_or_delete again.',
    });
  }
  if (job.status !== 'succeeded') {
    throw new McpToolError('INTERNAL', `Removing the venv of "${root}" failed: ${jobs.lastLine(job, 300)}`, { details: { job_id: job.id } });
  }
  return {
    what: 'workspace_venv', west_workspace: root, removed: true, cleared_setting: hasSetting && !!folder,
    ...(removal === 'removed' ? { deleted: managed } : {}), ...(external ? { kept_external_venv: external } : {}),
    ...(confirmation ? { confirmation } : {}),
    job_id: job.id,
    next: 'The workspace now builds with the global venv. Create a new one with manage_west_workspace action "create_venv".',
  };
}

async function cleanBlobs(args: Record<string, unknown>, ctx: Ctx) {
  const { workspace, root } = await resolveWorkspace(ctx, args);
  if (!workspace.supportsBlobs) {
    throw invalid(`west blobs needs Zephyr 3.2 or newer, and "${root}" is on ${workspace.version}.`);
  }
  assertWestEnvironment(root);
  const claim = westClaim(root, 'clean');
  await assertWorkspaceIdle(ctx, root, claim);
  const spec = westBlobsCleanSpec(root);
  const task = westTask(spec);
  if (bool(args.dry_run) === true) {
    const blobs = await listBlobs(ctx, workspace);
    return {
      what: 'west_blobs', dry_run: true, west_workspace: root, command: spec.command,
      would_delete: blobs.filter(blob => blob.status !== 'missing').map(blob => ({ module: blob.module, path: blob.name })),
      confirmation_required: confirmationRequired(ctx, args),
      next: 'Call remove_or_delete again without dry_run to delete them.',
    };
  }
  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: `delete the fetched binary blobs of the west workspace ${root} (west blobs clean); fetch_blobs brings them back`,
    folder: root, scope: root, scopeLabel: 'this west workspace',
  }, args));
  await assertWorkspaceIdle(ctx, root, claim);
  const { job, attached } = ctx.deps.jobs.start({
    ...claim,
    requestKey: `clean:blobs:${normalizeForCompare(root)}`,
    parse: false,
    command: spec.command,
    run: async (sink, signal) => {
      try {
        await runWestStep(ctx, task, sink, signal, 'West blobs clean');
        return { exitCode: 0, extra: { west_workspace: root } };
      } catch (error) {
        sink.onData(`\n${error instanceof Error ? error.message : String(error)}\n`);
        return { exitCode: error instanceof StepFailed ? error.exitCode : 1 };
      } finally {
        ctx.deps.services.catalog.invalidate(root);
      }
    },
    next: view => (view.status === 'succeeded'
      ? 'The blobs are deleted. Fetch them again with manage_west_workspace action "fetch_blobs" before building a board that needs them.'
      : `west blobs clean failed. Read the log with job {"action": "log", "job_id": "${view.job_id}"}.`),
  });
  return waitAndView(ctx, job, attached, num(args.wait_sec) ?? ctx.deps.defaultWaitSeconds, confirmationOf(ctx, outcome));
}

/** remove_or_delete with what "west_workspace", "west_workspace_files", "workspace_venv" or "west_blobs". */
export async function removeWestWorkspaceItem(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  checkTypes(args, ['what', 'west_workspace'], ['force', 'dry_run']);
  switch (str(args.what)) {
    case 'west_workspace':
      return removeFromWindow(args, ctx);
    case 'west_workspace_files':
      return deleteFiles(args, ctx);
    case 'workspace_venv':
      return removeVenv(args, ctx);
    case 'west_blobs':
      return cleanBlobs(args, ctx);
    default:
      throw invalid(`what "${logSafe(String(args.what), 40)}" is not a west workspace removal.`);
  }
}

// get_status

/** A field of a workspace that may not be readable: a malformed workspace must never break get_status. */
function readable<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * The west_workspaces entries of get_status: every workspace folder of the
 * window, then the workspaces applications link to that are not folders.
 */
export function westWorkspaceStatus(
  workspaces: readonly WestWorkspace[], apps: readonly ZephyrApplication[],
): Array<Record<string, unknown>> {
  const listed = [...workspaces];
  for (const app of apps) {
    const root = app.westWorkspaceRootPath;
    if (root && !listed.some(workspace => samePath(workspace.rootUri.fsPath, root))) {
      const linked = readable(() => getWestWorkspace(root));
      if (linked) {
        listed.push(linked);
      }
    }
  }
  return listed.map(workspace => {
    const root = workspace.rootUri.fsPath;
    const venv = readable(() => describeWorkspaceVenv(workspace));
    const manifestPath = readable(() => workspace.manifestUri.fsPath);
    const revision = manifestPath ? readZephyrRevision(manifestPath) : undefined;
    const envRoots = readable(() => Object.fromEntries(WEST_ROOT_KEYS
      .map(key => [key, toEnvList(workspace.envVars?.[key])] as const)
      .filter(([, values]) => values.length > 0)));
    const fields: Record<string, unknown> = {
      path: root,
      zephyr_version: workspace.version,
      zephyr_base: readable(() => workspace.kernelUri.fsPath),
      is_folder: !!readable(() => getExactWorkspaceFolder(root)),
      venv: venv ? { ...(venv.path ? { path: venv.path } : {}), source: venv.source } : undefined,
      manifest_path: manifestPath,
      zephyr_revision: revision,
      rust_enabled: readable(() => isRustEnabledInWestConfig(workspace.westConfUri.fsPath)),
      blobs_supported: readable(() => workspace.supportsBlobs),
      spdx3_supported: readable(() => workspace.supportsSpdx3),
      env_roots: envRoots && Object.keys(envRoots).length > 0 ? envRoots : undefined,
      application_count: apps.filter(app => !!app.westWorkspaceRootPath && samePath(app.westWorkspaceRootPath, root)).length,
    };
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  });
}
