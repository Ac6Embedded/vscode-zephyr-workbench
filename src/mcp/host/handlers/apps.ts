// Applications: manage_app (create, import, create_venv), configure target
// "app" action "update", and remove_or_delete what "application" and
// "application_files".
//
// Each goes through the functions the Add Application wizard and the
// Applications view use, so the settings, IntelliSense files and launch
// configurations end up exactly as a change made by hand would leave them.
// None shows any UI except the confirmation dialog: the settings writers run
// in their quiet mode and their warnings come back in the result.
//
// Every handler follows one order: validate, resolve, run each check that can
// refuse the call, return early for a dry run, ask the user when they chose
// to be asked, then act under the settings lock against freshly read values.
// Adding or removing a VS Code folder goes through the folder scheduler, which
// defers a change that restarts the extension host until the answer is out.

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseJsonc } from 'jsonc-parser';
import * as vscode from 'vscode';
import {
  ZEPHYR_PROJECT_SDK_GLOBAL_VALUE, ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY,
  ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY,
} from '../../../constants';
import {
  GlobalZephyrSdkInstallation, RustToolchainInstallation, ToolchainInstallation, ToolchainVariantId, ZephyrSdkInstallation,
} from '../../../models/ToolchainInstallations';
import { WestWorkspace } from '../../../models/WestWorkspace';
import { ZephyrApplication } from '../../../models/ZephyrApplication';
import { ZephyrBoard } from '../../../models/ZephyrBoard';
import { ZephyrBuildConfig } from '../../../models/ZephyrBuildConfig';
import { buildDefaultApplicationSettings, collectSettingsWarnings } from '../../../providers/ZephyrTaskProvider';
import { getConfiguredWorkbenchPath, resolveConfiguredPath } from '../../../utils/execUtils';
import { createLocalVenv, getManagedVenvWestPath, VenvRunner, VenvSetupError } from '../../../utils/installUtils';
import { setApplicationIntelliSenseProvider } from '../../../utils/intellisense/intellisenseSync';
import {
  IntelliSenseProviderId, isClangdInstalled, isCppToolsInstalled, normalizeIntelliSenseProvider, pickDefaultIntelliSenseProvider,
} from '../../../utils/intellisense/providerAvailability';
import {
  createWorkspaceFolderReference, describeZephyrApplicationDetectionFailure, findArmGnuToolchainInstallation,
  findIarToolchainInstallation, findRustToolchainInstallation, getAllZephyrSdkInstallations, getExactWorkspaceFolder,
  getRegisteredArmGnuToolchainInstallations, getRegisteredIarToolchainInstallations, getRegisteredRustToolchainInstallations,
  isGlobalSdkSettingValue, removeDirectory, tryGetZephyrSdkInstallation,
} from '../../../utils/utils';
import { validateVenvDirectory } from '../../../utils/venvValidation';
import {
  ApplicationCreationError, ApplicationKind, createApplication, sdkCompatibilityFor, toRequestedVariantFor,
  workspaceApplicationParentPath,
} from '../../../utils/zephyr/applicationCreation';
import {
  ApplicationImportError, importApplication, ImportOutcome, importLocalApplication, IncompleteImportError,
} from '../../../utils/zephyr/applicationImport';
import { updateApplicationSettings } from '../../../utils/zephyr/applicationSettings';
import {
  ApplicationToolchainChoice, applyApplicationToolchain, hasApplicationToolchainChanged, lacksCToolchain,
  listApplicationToolchainChoices, resolveChoiceSdk, setApplicationWestWorkspace, ToolchainVariantPick,
} from '../../../utils/zephyr/applicationToolchain';
import { resolveGlobalSdkForZephyr } from '../../../utils/zephyr/globalSdkService';
import { checkSdkCompatibility, formatSdkCompatMessage, SdkCompatVerdict } from '../../../utils/zephyr/sdkCompatUtils';
import {
  findContainingWorkspaceApplicationEntry, findWorkspaceApplicationEntry, removeApplication as unregisterApplication,
  toWorkspaceApplicationStoragePath,
} from '../../../utils/zephyr/workspaceApplications';
import { assertAppFolderPath, assertApplicationsSubfolder, assertAppName } from '../../core/appArgs';
import { checkAppFolderDeletion, measureFolder } from '../../core/appFolderFence';
import { assertBoardIdentifier, isInside, normalizeForCompare } from '../../core/argSafety';
import { BoardEntry, SampleEntry } from '../../core/catalogSearch';
import { McpToolError } from '../../core/errors';
import { logSafe } from '../../core/redact';
import { confirmCategoryOf, ToolContext, ToolHandler } from '../../core/toolSpec';
import { conflictOf, JobClaim } from '../../jobs/jobConflicts';
import { isTerminal, isWorking, JobSpec, JobView } from '../../jobs/jobManager';
import { ConfirmOutcome, ConfirmSubject } from '../confirmations';
import { folderChangeRestartsHost, FolderChange, FolderChangeOutcome } from '../folderChanges';
import { AppConfigDto, AppDto, appDtoOf, freestandingVenvPathOf } from '../services';
import { runCapturedTask } from '../taskRunner';
import { HostDeps } from './deps';
import { progressWait, remainingWaitMs } from './progress';

type Ctx = ToolContext<HostDeps>;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const same = (a: string, b: string) => normalizeForCompare(a) === normalizeForCompare(b);

const REVEAL: Record<string, vscode.TaskRevealKind> = {
  always: vscode.TaskRevealKind.Always,
  silent: vscode.TaskRevealKind.Silent,
  never: vscode.TaskRevealKind.Never,
};

/** How long a create or import waits for the cached board list before going on without it. */
const BOARD_LOOKUP_MS = 3000;

const PYOCD_NOTE = 'Zephyr\'s Python requirements, which the venv installs as the Add Application wizard does, include pyOCD (a flash and debug tool) and come from PyPI.';

function invalid(message: string, hint?: string, details?: Record<string, unknown>): McpToolError {
  return new McpToolError('INVALID_ARGUMENT', message, { hint, details });
}

/** Refuse an argument the action does not take instead of silently ignoring it. */
function checkArgs(args: Record<string, unknown>, accepted: readonly string[], what: string): void {
  const unexpected = Object.keys(args).filter(key => args[key] !== undefined && !accepted.includes(key));
  if (unexpected.length > 0) {
    throw invalid(`${what} does not take ${unexpected.join(', ')}.`, undefined, { accepted: [...accepted] });
  }
}

/** Refuse a value of the wrong type. */
function checkTypes(args: Record<string, unknown>, types: Readonly<Record<string, 'string' | 'boolean' | 'number' | 'object'>>): void {
  for (const [key, type] of Object.entries(types)) {
    const value = args[key];
    if (value === undefined) {
      continue;
    }
    const ok = type === 'object' ? !!value && typeof value === 'object' && !Array.isArray(value) : typeof value === type;
    if (!ok) {
      throw invalid(`${key} must be ${type === 'boolean' ? 'true or false' : `a ${type}`}.`);
    }
  }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw invalid(`${label} must be one of ${allowed.join(', ')}.`);
  }
  return value as T;
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

function confirmationRequired(ctx: Ctx, args: Record<string, unknown>): boolean {
  const category = confirmCategoryOf(ctx.tool, args);
  return !!category && ctx.deps.permissionOf(ctx.tool) === 'ask';
}

/**
 * How a hint points at a tool the user may have blocked: by name when this
 * window serves it, else at the Zephyr Workbench command doing the same.
 */
function viaTool(ctx: Ctx, tool: string, call: string, command: string): string {
  return ctx.deps.servedTools().has(tool)
    ? `call ${call}`
    : `ask the user to run the Zephyr Workbench command "${command}" (${tool} does it too, if the user allows it in the AI Manager)`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settingsFileIn(folder: string): string {
  return path.join(folder, '.vscode', 'settings.json');
}

/** A settings write, with a failure turned into an error that names the file to fix. */
async function writeSettings<T>(folder: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof McpToolError) {
      throw error;
    }
    const file = settingsFileIn(folder);
    throw new McpToolError('INTERNAL', `VS Code could not write ${file}: ${messageOf(error)}`, {
      hint: `Ask the user to save or close ${file} if it has unsaved changes, and to fix it if it is not valid JSON, then retry.`,
    });
  }
}

function currentFolders(): { workspaceFile: boolean; folders: string[] } {
  return {
    workspaceFile: vscode.workspace.workspaceFile !== undefined,
    folders: (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
  };
}

function restartsHost(change: FolderChange): boolean {
  return folderChangeRestartsHost(change, currentFolders());
}

/** What a folder change means for the agent, as the result reports it. */
function folderOutcome(outcome: FolderChangeOutcome) {
  return {
    restart_pending: outcome.restart_pending,
    ...(outcome.waiting_for_jobs ? { waiting_for_jobs: outcome.waiting_for_jobs } : {}),
  };
}

// Busy checks

/** True when a job works on the application: builds it, deletes in it, or uses a venv inside it. */
function jobTouchesApp(spec: JobSpec, appRoot: string): boolean {
  if (spec.appPath && same(spec.appPath, appRoot)) {
    return true;
  }
  return [spec.buildDir, spec.venvPath].some(folder => !!folder && path.isAbsolute(folder) && isInside(folder, appRoot));
}

/**
 * Refuse while an agent job, a task the user started from VS Code, or a
 * Kconfig session works on the application. Its settings or files are about
 * to change under it.
 */
function assertAppIdle(ctx: Ctx, app: ZephyrApplication, options: { kconfig?: boolean } = {}): void {
  const root = app.appRootPath;
  const running = ctx.deps.jobs.list().find(job => isWorking(job) && jobTouchesApp(job.spec, root));
  if (running) {
    throw new McpToolError('BUSY', `A ${running.spec.kind} job is working on "${root}" (job_id "${running.id}").`, {
      hint: `Wait for it with job {"action": "status", "job_id": "${running.id}"}, or stop it with job {"action": "cancel", "job_id": "${running.id}"}, then retry.`,
      details: { job_id: running.id, kind: running.spec.kind },
    });
  }
  for (const config of app.buildConfigs) {
    const external = ctx.deps.services.externalRun(root, config.name);
    if (external) {
      throw new McpToolError('BUSY_EXTERNAL', `"${external.task.name}" is running for ${config.name}, started from VS Code.`, {
        hint: 'Wait for it to finish in its terminal, then retry.',
      });
    }
  }
  if (options.kconfig === false) {
    return;
  }
  const editor = ctx.deps.services.kconfigEditors().find(candidate => isInside(candidate.buildDir, root));
  if (editor) {
    throw new McpToolError('BUSY_EXTERNAL', `The Kconfig Manager is open on ${editor.configName} of this application.`, {
      hint: editor.dirty
        ? `Ask the user to save or discard the changes in the Kconfig Manager tab of ${editor.configName} and close it, then retry.`
        : `Ask the user to close the Kconfig Manager tab of ${editor.configName}, then retry.`,
      details: { editor: 'kconfig_manager', config_name: editor.configName, unsaved: editor.dirty },
    });
  }
  const querying = ctx.deps.kconfig.inUseWithin(root)[0];
  if (querying) {
    throw new McpToolError('BUSY', `A query_kconfig or set_kconfig call is reading the Kconfig tree of "${querying}".`, {
      hint: 'Retry once it has answered.',
    });
  }
}

// Toolchains, boards and templates for create and import

type ToolchainFamily = 'zephyr_sdk' | 'global_sdk' | 'arm_gnu' | 'iar' | 'rust';
const TOOLCHAIN_FAMILIES: readonly ToolchainFamily[] = ['zephyr_sdk', 'global_sdk', 'arm_gnu', 'iar', 'rust'];

interface ToolchainArg {
  family: ToolchainFamily;
  path?: string;
  variant?: 'gnu' | 'llvm';
}

function toolchainArgOf(value: unknown): ToolchainArg | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('toolchain must be an object with family, and path for every family but global_sdk.');
  }
  const raw = value as Record<string, unknown>;
  const extra = Object.keys(raw).filter(key => !['family', 'path', 'variant'].includes(key));
  if (extra.length > 0) {
    throw invalid(`toolchain does not take ${extra.join(', ')}.`);
  }
  const family = oneOf(raw.family, TOOLCHAIN_FAMILIES, 'toolchain.family');
  if (!family) {
    throw invalid(`toolchain.family is required: one of ${TOOLCHAIN_FAMILIES.join(', ')}.`);
  }
  if (raw.path !== undefined && typeof raw.path !== 'string') {
    throw invalid('toolchain.path must be a string.');
  }
  if (family === 'global_sdk' && raw.path !== undefined) {
    throw invalid('toolchain.path does not apply to the global_sdk family, which the build finds by itself.');
  }
  if (family !== 'global_sdk' && !raw.path) {
    throw invalid(`toolchain.path is required for the ${family} family.`, 'Call list_toolchains and pass one of the paths it returns.');
  }
  const variant = oneOf(raw.variant, ['gnu', 'llvm'] as const, 'toolchain.variant');
  return { family, ...(raw.path ? { path: raw.path as string } : {}), ...(variant ? { variant } : {}) };
}

interface ResolvedToolchain {
  installation: ToolchainInstallation;
  family: ToolchainFamily;
  /** The variant stored in the settings: zephyr, zephyr/llvm, gnuarmemb or iar. */
  variant: string;
  /** True when the call named no toolchain and the recommended SDK was picked. */
  defaulted: boolean;
}

function notListed(family: ToolchainFamily, wanted: string, available: string[]): McpToolError {
  return invalid(`toolchain.path "${logSafe(wanted, 300)}" is not a ${family} toolchain the workbench has registered.`,
    'Call list_toolchains and pass one of the paths it returns for that family.', { available });
}

function llvmRefused(what: string): McpToolError {
  return invalid(`toolchain.variant "llvm" is not available: ${what}.`,
    'Omit variant (or pass "gnu"), or pick a Zephyr SDK that has its LLVM toolchain installed; list_toolchains shows which do.');
}

/** A Zephyr SDK as the settings store it by path: a detected global SDK would otherwise be stored as "global". */
function pinnedSdk(sdk: ZephyrSdkInstallation): ZephyrSdkInstallation {
  return sdk instanceof GlobalZephyrSdkInstallation ? new ZephyrSdkInstallation(sdk.rootUri) : sdk;
}

function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.trim().split(/[.-]/).map(part => parseInt(part, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) {
      return (pa[i] ?? 0) - (pb[i] ?? 0);
    }
  }
  return 0;
}

/** The SDK version a Zephyr tree recommends, from its SDK_VERSION file (Zephyr 3.6 and later). */
function readRecommendedSdk(kernelPath: string): string | undefined {
  try {
    return fs.readFileSync(path.join(kernelPath, 'SDK_VERSION'), 'utf8').split(/\r?\n/)[0].trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Zephyr SDK an application of this Zephyr gets when the call names no
 * toolchain: the installed one of the version Zephyr recommends, else the
 * newest compatible one, else the newest partially compatible one.
 */
async function recommendedToolchain(ctx: Ctx, workspace: WestWorkspace): Promise<ResolvedToolchain> {
  const kernelPath = workspace.kernelUri.fsPath;
  const sdks = await getAllZephyrSdkInstallations();
  const ranked = sdks
    .map(sdk => ({ sdk, verdict: checkSdkCompatibility(sdk.version.trim(), kernelPath) }))
    .sort((a, b) => compareVersions(b.sdk.version, a.sdk.version));
  const recommended = ranked[0]?.verdict.recommendedSdk ?? readRecommendedSdk(kernelPath);
  const pick = ranked.find(entry => entry.verdict.status === 'compatible' && recommended && entry.sdk.version.trim() === recommended.trim())
    ?? ranked.find(entry => entry.verdict.status === 'compatible')
    ?? ranked.find(entry => entry.verdict.status === 'partial')
    ?? ranked.find(entry => entry.verdict.status === 'unknown');
  if (!pick) {
    throw invalid(`No installed Zephyr SDK suits Zephyr ${workspace.version}${recommended ? ` (it recommends SDK ${recommended})` : ''}, so pass toolchain.`,
      `Call list_toolchains to see what is installed, or ${viaTool(ctx, 'manage_toolchain', 'manage_toolchain with action install', 'Add Toolchain')}.`,
      { installed: sdks.map(sdk => ({ path: sdk.rootUri.fsPath, version: sdk.version.trim() })) });
  }
  return { installation: pinnedSdk(pick.sdk), family: 'zephyr_sdk', variant: 'zephyr', defaulted: true };
}

/** The installation a toolchain argument names, among the registered ones only. */
async function resolveToolchainArg(ctx: Ctx, arg: ToolchainArg | undefined, workspace: WestWorkspace): Promise<ResolvedToolchain> {
  if (!arg) {
    return recommendedToolchain(ctx, workspace);
  }
  const kernelPath = workspace.kernelUri.fsPath;
  const llvm = arg.variant === 'llvm';
  const wanted = arg.path ?? '';
  switch (arg.family) {
    case 'global_sdk': {
      const sdk = resolveGlobalSdkForZephyr(kernelPath);
      if (!sdk) {
        throw invalid('No global Zephyr SDK is detected on this machine.',
          `Call list_toolchains with rescan true after installing one, or pass a zephyr_sdk toolchain; ${viaTool(ctx, 'manage_toolchain', 'manage_toolchain with action install', 'Add Toolchain')} to install one.`);
      }
      if (llvm && !sdk.hasLlvmToolchain()) {
        throw llvmRefused(`the global Zephyr SDK ${sdk.version.trim()} has no LLVM toolchain`);
      }
      return { installation: sdk, family: 'global_sdk', variant: llvm ? 'zephyr/llvm' : 'zephyr', defaulted: false };
    }
    case 'zephyr_sdk': {
      const sdks = await getAllZephyrSdkInstallations();
      const match = sdks.find(sdk => same(sdk.rootUri.fsPath, wanted));
      if (!match) {
        throw notListed('zephyr_sdk', wanted, sdks.map(sdk => sdk.rootUri.fsPath));
      }
      if (llvm && !match.hasLlvmToolchain()) {
        throw llvmRefused(`the Zephyr SDK at ${match.rootUri.fsPath} has no LLVM toolchain`);
      }
      return { installation: pinnedSdk(match), family: 'zephyr_sdk', variant: llvm ? 'zephyr/llvm' : 'zephyr', defaulted: false };
    }
    case 'arm_gnu': {
      const registered = await getRegisteredArmGnuToolchainInstallations();
      const match = registered.find(toolchain => same(toolchain.toolchainPath, wanted));
      const installation = match && findArmGnuToolchainInstallation(match.toolchainPath);
      if (!installation) {
        throw notListed('arm_gnu', wanted, registered.map(toolchain => toolchain.toolchainPath));
      }
      if (llvm) {
        throw llvmRefused('variant only applies to a Zephyr SDK');
      }
      return { installation, family: 'arm_gnu', variant: 'gnuarmemb', defaulted: false };
    }
    case 'iar': {
      const registered = await getRegisteredIarToolchainInstallations();
      const match = registered.find(toolchain => same(toolchain.iarPath, wanted));
      const installation = match && findIarToolchainInstallation(match.iarPath);
      if (!installation) {
        throw notListed('iar', wanted, registered.map(toolchain => toolchain.iarPath));
      }
      if (llvm) {
        throw llvmRefused('variant only applies to a Zephyr SDK');
      }
      return { installation, family: 'iar', variant: 'iar', defaulted: false };
    }
    default: {
      const registered = await getRegisteredRustToolchainInstallations();
      const match = registered.find(toolchain => same(toolchain.toolchainPath, wanted));
      const installation = match && findRustToolchainInstallation(match.toolchainPath);
      if (!installation) {
        throw notListed('rust', wanted, registered.map(toolchain => toolchain.toolchainPath));
      }
      if (!installation.cToolchainType || !installation.cToolchainPath) {
        throw invalid(`The Rust toolchain at ${installation.toolchainPath} has no linked C toolchain, which it needs to build.`,
          `Link one first: ${viaTool(ctx, 'manage_toolchain', 'manage_toolchain with action link', 'Change Linked C Toolchain')}.`);
      }
      if (llvm) {
        const sdk = installation.cToolchainType === 'zephyr-sdk' ? tryGetZephyrSdkInstallation(installation.cToolchainPath) : undefined;
        if (!sdk?.hasLlvmToolchain()) {
          throw llvmRefused(`the C toolchain linked to the Rust toolchain at ${installation.toolchainPath} has no LLVM toolchain`);
        }
      }
      return {
        installation, family: 'rust', variant: toRequestedVariantFor(installation, llvm ? 'zephyr/llvm' : 'zephyr'), defaulted: false,
      };
    }
  }
}

function toolchainSummary(resolved: ResolvedToolchain) {
  const installation = resolved.installation;
  const pathOf = installation instanceof ZephyrSdkInstallation
    ? (resolved.family === 'global_sdk' ? undefined : installation.rootUri.fsPath)
    : installation instanceof RustToolchainInstallation
      ? installation.toolchainPath
      : 'iarPath' in installation ? installation.iarPath : installation.toolchainPath;
  return {
    family: resolved.family,
    ...(pathOf ? { path: pathOf } : {}),
    ...(resolved.variant === 'zephyr/llvm' ? { variant: 'llvm' } : resolved.variant === 'zephyr' ? { variant: 'gnu' } : {}),
    ...(installation instanceof ZephyrSdkInstallation ? { sdk_version: installation.version.trim() } : {}),
    ...(resolved.defaulted ? { defaulted: true } : {}),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  // A load that outlives the wait keeps going and primes the cache; its failure is not ours.
  promise.catch(() => undefined);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(undefined); });
  });
}

/**
 * The board, from the cached board list of the west workspace when it answers
 * quickly. Its architecture only serves the IntelliSense compiler path, so a
 * board the list does not have is still accepted, as the wizard accepts a
 * hand-typed one, with a warning.
 */
async function resolveBoard(ctx: Ctx, workspace: WestWorkspace, identifier: string, warnings: string[]): Promise<ZephyrBoard> {
  assertBoardIdentifier(identifier);
  const listing = await withTimeout(ctx.deps.services.catalog.list('board', workspace, undefined, false), BOARD_LOOKUP_MS);
  if (!listing) {
    warnings.push(`The board list of this west workspace was not ready, so "${identifier}" was not checked; IntelliSense gets its compiler path after the first build.`);
    return ZephyrBoard.fromIdentifier(identifier);
  }
  const entries = listing.entries as BoardEntry[];
  let candidate = identifier;
  for (;;) {
    const entry = entries.find(board => board.identifiers.includes(candidate) || board.name === candidate);
    if (entry) {
      return new ZephyrBoard(vscode.Uri.file(entry.dir), identifier);
    }
    const slash = candidate.lastIndexOf('/');
    if (slash <= 0) {
      break;
    }
    candidate = candidate.slice(0, slash);
  }
  warnings.push(`"${identifier}" is not in the board list of this west workspace: the build fails unless a board root of the application provides it. search_zephyr_catalog with kind board lists the valid identifiers.`);
  return ZephyrBoard.fromIdentifier(identifier);
}

async function assertTemplate(ctx: Ctx, workspace: WestWorkspace, template: string): Promise<SampleEntry> {
  const listing = await ctx.deps.services.catalog.list('sample', workspace, undefined, false);
  const entry = (listing.entries as SampleEntry[]).find(candidate => same(candidate.path, template));
  if (!entry) {
    throw invalid(`template "${logSafe(template, 300)}" is not a sample or test of the west workspace "${workspace.rootUri.fsPath}".`,
      `Call search_zephyr_catalog with kind sample or test and west_workspace "${workspace.rootUri.fsPath}", and pass one of the paths it returns.`);
  }
  if (!fs.existsSync(path.join(entry.path, 'CMakeLists.txt'))) {
    throw invalid(`The template "${entry.path}" has no CMakeLists.txt any more.`,
      'Call search_zephyr_catalog with refresh true and pick another template.');
  }
  return entry;
}

function compatWarningOf(workspace: WestWorkspace, installation: ToolchainInstallation): { verdict?: SdkCompatVerdict; sdkVersion?: string; message?: string } {
  const compat = sdkCompatibilityFor(workspace, installation);
  if (!compat) {
    return {};
  }
  return { ...compat, message: formatSdkCompatMessage(compat.verdict, compat.sdkVersion) };
}

function compatDtoOf(compat: { verdict?: SdkCompatVerdict; message?: string }) {
  return compat.verdict
    ? {
      status: compat.verdict.status,
      ...(compat.verdict.zephyrVersion ? { zephyr_version: compat.verdict.zephyrVersion } : {}),
      ...(compat.verdict.recommendedSdk ? { recommended_sdk: compat.verdict.recommendedSdk } : {}),
      ...(compat.message ? { message: compat.message } : {}),
    }
    : { status: 'unknown' };
}

/**
 * The settings a create or import writes: the entry added to the west
 * workspace settings for a workspace application, or the keys written into
 * the application's own settings file.
 */
function settingsPreview(
  kind: ApplicationKind, appRoot: string, settingsFolder: vscode.WorkspaceFolder, workspace: WestWorkspace,
  board: ZephyrBoard, toolchain: ResolvedToolchain, provider: IntelliSenseProviderId,
) {
  const { values, deleteKeys } = buildDefaultApplicationSettings(settingsFolder, workspace, board, toolchain.installation, {
    toolchainVariant: toolchain.variant, intellisenseProvider: provider, pathMode: 'relative',
  }, kind === 'freestanding');
  if (kind === 'workspace') {
    return {
      file: settingsFileIn(settingsFolder.uri.fsPath),
      setting: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.westWorkspace.applications`,
      entry: { path: toWorkspaceApplicationStoragePath(appRoot, settingsFolder), ...values },
    };
  }
  return {
    file: settingsFileIn(appRoot),
    values: {
      ...Object.fromEntries(Object.entries(values).map(([key, value]) => [`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${key}`, value])),
      'cmake.configureOnOpen': false,
      'cmake.enableAutomaticKitScan': false,
    },
    removed: deleteKeys.map(key => `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${key}`),
  };
}

/** The files a create or import writes besides the copied template. */
function settingsFiles(settingsFolder: string, provider: IntelliSenseProviderId): string[] {
  return [
    settingsFileIn(settingsFolder),
    path.join(settingsFolder, '.vscode', 'c_cpp_properties.json'),
    ...(provider === 'clangd' ? [path.join(settingsFolder, '.clangd')] : []),
  ];
}

/**
 * The application of a folder VS Code has not opened yet, read from its own
 * settings file, as list_apps will report it once the folder is open.
 */
function detachedAppDto(ctx: Ctx, appRoot: string): AppDto {
  const folder = createWorkspaceFolderReference(appRoot);
  let settings: Record<string, unknown> = {};
  try {
    const parsed = parseJsonc(fs.readFileSync(settingsFileIn(appRoot), 'utf8'));
    settings = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    settings = {};
  }
  const get = (key: string) => settings[`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${key}`];
  const pathOf = (key: string) => {
    const value = get(key);
    return typeof value === 'string' && value.trim().length > 0 ? resolveConfiguredPath(value, folder) ?? value : undefined;
  };
  const westWorkspaceRoot = pathOf('westWorkspace');
  const rawVariant = get('toolchain');
  const toolchainVariant: ToolchainVariantId = typeof rawVariant === 'string'
    && ['zephyr', 'zephyr/llvm', 'gnuarmemb', 'iar'].includes(rawVariant) ? rawVariant as ToolchainVariantId : 'zephyr';
  const sdkSetting = get('sdk');
  const isGlobalSdk = typeof sdkSetting === 'string' && isGlobalSdkSettingValue(sdkSetting);
  const iar = toolchainVariant === 'iar' ? findIarToolchainInstallation(pathOf('iar') ?? '') : undefined;
  let zephyrSdkPath = toolchainVariant === 'gnuarmemb' ? undefined : isGlobalSdk ? ZEPHYR_PROJECT_SDK_GLOBAL_VALUE : pathOf('sdk');
  if (iar) {
    zephyrSdkPath = iar.zephyrSdkPath;
  }
  let kernelPath: string | undefined;
  try {
    kernelPath = westWorkspaceRoot ? new WestWorkspace(path.basename(westWorkspaceRoot), vscode.Uri.file(westWorkspaceRoot)).kernelUri.fsPath : undefined;
  } catch {
    kernelPath = undefined;
  }
  const zephyrSdkVersion = (isGlobalSdk ? resolveGlobalSdkForZephyr(kernelPath) : tryGetZephyrSdkInstallation(zephyrSdkPath))?.version.trim();
  const rustPath = pathOf('rust');
  const rust = rustPath ? findRustToolchainInstallation(rustPath) : undefined;
  const appLike = { appRootPath: appRoot, appWorkspaceFolder: folder } as ZephyrApplication;
  const ownVenvPath = pathOf(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY);
  const rawConfigs = get('build.configurations');
  const configs: AppConfigDto[] = (Array.isArray(rawConfigs) ? rawConfigs : [])
    .filter(raw => raw && typeof raw === 'object' && typeof raw.name === 'string')
    .map(raw => {
      const config = new ZephyrBuildConfig(raw.name);
      config.parseSettings(raw, folder);
      return ctx.deps.services.toConfigDto(appLike, config);
    });
  return appDtoOf({
    appRootPath: appRoot,
    appName: path.basename(appRoot),
    kind: 'freestanding',
    westWorkspaceRoot,
    toolchainVariant,
    isGlobalSdk,
    zephyrSdkPath: isGlobalSdk ? undefined : zephyrSdkPath,
    zephyrSdkVersion,
    armGnuPath: toolchainVariant === 'gnuarmemb' ? findArmGnuToolchainInstallation(pathOf('gnuarmemb') ?? '')?.toolchainPath : undefined,
    iarPath: iar?.iarPath,
    rust,
    rustMissing: !!rustPath && !rust,
    intellisenseProvider: normalizeIntelliSenseProvider(get('intellisense.provider')),
    ownVenvPath,
    venvPath: freestandingVenvPathOf(ownVenvPath, folder, westWorkspaceRoot),
    scope: folder,
  }, configs);
}

/** The application as list_apps reports it, once the settings are written. */
async function appDtoAfterWrite(ctx: Ctx, appRoot: string, inWindow: boolean): Promise<AppDto> {
  if (inWindow) {
    try {
      return ctx.deps.services.toAppDto(await ctx.deps.services.resolveApp(appRoot));
    } catch {
      // Not visible yet: read the settings file instead.
    }
  }
  return detachedAppDto(ctx, appRoot);
}

function creationFailure(error: unknown, appRoot: string): McpToolError {
  if (error instanceof McpToolError) {
    return error;
  }
  if (error instanceof ApplicationCreationError) {
    return error.code === 'destination-exists'
      ? invalid(error.message, 'Pick another name, or import the existing folder with manage_app action import.')
      : new McpToolError('INTERNAL', error.message, {
        hint: `Check "${appRoot}" and its .vscode folder, then retry; remove what was left behind by hand if needed.`,
      });
  }
  if (error instanceof ApplicationImportError) {
    return invalid(error.message);
  }
  return new McpToolError('INTERNAL', `The settings of "${appRoot}" could not be written: ${messageOf(error)}`, {
    hint: 'Ask the user to save or close any unsaved settings.json in VS Code and to fix it if it is not valid JSON, then retry.',
    details: { app_path: appRoot },
  });
}

function afterRegistrationNext(appRoot: string, restartPending: boolean): string {
  return restartPending
    ? `VS Code restarts the extensions of the window in a few seconds to add the folder: call get_status until it answers again, then build_app with app_path "${appRoot}". manage_app with action create_venv gives it its own Python environment.`
    : `Call build_app with app_path "${appRoot}" to build it. manage_app with action create_venv gives it its own Python environment.`;
}

// manage_app create

const CREATE_ARGS = [
  'action', 'kind', 'west_workspace', 'template', 'name', 'applications_subfolder', 'parent_dir', 'board', 'toolchain',
  'intellisense_provider', 'debug_preset', 'dry_run',
];

async function createApp(args: Record<string, unknown>, ctx: Ctx) {
  const { services } = ctx.deps;
  checkArgs(args, CREATE_ARGS, 'action "create"');
  checkTypes(args, {
    west_workspace: 'string', template: 'string', name: 'string', applications_subfolder: 'string', parent_dir: 'string',
    board: 'string', debug_preset: 'boolean', dry_run: 'boolean',
  });
  const kind = oneOf(args.kind, ['workspace', 'freestanding'] as const, 'kind') ?? 'workspace';
  const template = str(args.template);
  if (!template) {
    throw invalid('action "create" needs template.', 'Call search_zephyr_catalog with kind sample or test and pass the path of one of them as template.');
  }
  if (!path.isAbsolute(template)) {
    throw invalid(`template "${logSafe(template, 300)}" is not an absolute path.`);
  }
  const boardId = str(args.board);
  if (!boardId) {
    throw invalid('action "create" needs board.', 'Call search_zephyr_catalog with kind board to find its identifier.');
  }
  assertBoardIdentifier(boardId);
  if (kind === 'workspace' && args.parent_dir !== undefined) {
    throw invalid('parent_dir only applies to kind "freestanding"; a workspace application goes under applications_subfolder.');
  }
  if (kind === 'freestanding' && args.applications_subfolder !== undefined) {
    throw invalid('applications_subfolder only applies to kind "workspace"; a freestanding application goes in parent_dir.');
  }
  const name = assertAppName(str(args.name) ?? path.basename(template));
  const provider = oneOf(args.intellisense_provider, ['cpptools', 'clangd'] as const, 'intellisense_provider') ?? pickDefaultIntelliSenseProvider();
  const debugPreset = bool(args.debug_preset) ?? true;
  const toolchainArg = toolchainArgOf(args.toolchain);

  const { workspace } = await services.resolveWestWorkspace(str(args.west_workspace));
  const root = workspace.rootUri.fsPath;
  const kernelPath = workspace.kernelUri.fsPath;
  const workspaceFolder = kind === 'workspace' ? getExactWorkspaceFolder(root) : undefined;
  if (kind === 'workspace' && !workspaceFolder) {
    throw invalid(`The west workspace "${root}" is not open as a VS Code folder, which a workspace application needs.`,
      `Create a freestanding application linked to it instead (kind "freestanding"), or ${viaTool(ctx, 'manage_west_workspace', `manage_west_workspace with action import and path "${root}"`, 'Add West Workspace')} first.`);
  }

  let parent: string;
  if (kind === 'workspace') {
    const subfolder = assertApplicationsSubfolder(str(args.applications_subfolder) ?? 'applications');
    parent = workspaceApplicationParentPath(root, subfolder);
  } else {
    const parentDir = str(args.parent_dir);
    if (!parentDir) {
      throw invalid('kind "freestanding" needs parent_dir, the existing folder that receives the application folder.');
    }
    assertAppFolderPath(parentDir, 'parent_dir');
    if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) {
      throw invalid(`parent_dir "${parentDir}" is not an existing folder.`);
    }
    parent = path.resolve(parentDir);
  }
  const appRoot = path.join(parent, name);
  assertAppFolderPath(appRoot, 'The application path');
  if (fs.existsSync(appRoot)) {
    throw invalid(`"${appRoot}" already exists.`, 'Pick another name, or import the existing folder with manage_app action import.');
  }
  const protectedTree = [kernelPath, workspace.rustModuleUri.fsPath].find(tree => isInside(appRoot, tree));
  if (protectedTree) {
    throw invalid(`"${appRoot}" would be inside "${protectedTree}", which west manages.`, 'Pick another applications_subfolder or parent_dir.');
  }
  if (workspaceFolder && findWorkspaceApplicationEntry(workspaceFolder, appRoot)) {
    throw invalid(`The west workspace already declares an application at "${appRoot}".`,
      'Pick another name, or remove that entry first with remove_or_delete what "application", if the user allows it in the AI Manager.');
  }
  const entry = await assertTemplate(ctx, workspace, template);
  if (isInside(appRoot, entry.path)) {
    throw invalid('The application cannot be created inside its own template.');
  }

  const warnings: string[] = [];
  const board = await resolveBoard(ctx, workspace, boardId, warnings);
  const toolchain = await resolveToolchainArg(ctx, toolchainArg, workspace);
  const compat = compatWarningOf(workspace, toolchain.installation);
  if (compat.message) {
    warnings.push(compat.message);
  }
  const settingsFolder = workspaceFolder ?? createWorkspaceFolderReference(appRoot);
  const restartExpected = kind === 'freestanding' && restartsHost({ add: [appRoot] });
  const files = [
    appRoot,
    ...(debugPreset ? [path.join(appRoot, 'prj.conf')] : []),
    ...settingsFiles(settingsFolder.uri.fsPath, provider),
  ];
  const plan = {
    action: 'create',
    kind,
    app_path: appRoot,
    west_workspace: root,
    template: { path: entry.path, name: entry.name, kind: entry.kind },
    board: boardId,
    toolchain: toolchainSummary(toolchain),
    sdk_compat: compatDtoOf(compat),
    intellisense_provider: provider,
    debug_preset: debugPreset,
  };

  if (bool(args.dry_run) === true) {
    return {
      ...plan,
      dry_run: true,
      files,
      settings: settingsPreview(kind, appRoot, settingsFolder, workspace, board, toolchain, provider),
      ...(kind === 'freestanding' ? { adds_folder: true, restart_expected: restartExpected } : {}),
      warnings,
      confirmation_required: confirmationRequired(ctx, args),
      next: 'Call manage_app again without dry_run to create it.',
    };
  }

  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: `create the application "${name}" from ${logSafe(entry.name, 64)} in ${logSafe(parent, 200)}`
      + (restartExpected ? ' and add it to the window, which restarts the extensions of VS Code' : ''),
    appPath: appRoot, board: boardId, folder: appRoot,
    scope: kind === 'workspace' ? root : appRoot,
    scopeLabel: kind === 'workspace' ? 'this west workspace' : 'this folder',
  }, args));

  await services.withFolderSettingsLock(settingsFolder.uri.fsPath, async () => {
    if (fs.existsSync(appRoot)) {
      throw invalid(`"${appRoot}" appeared while this call ran.`, 'Pick another name.');
    }
    try {
      await collectSettingsWarnings(warnings, () => createApplication({
        westWorkspace: workspace,
        templatePath: entry.path,
        board,
        toolchain: toolchain.installation,
        kind,
        parentDir: parent,
        name,
        toolchainVariant: toolchain.variant,
        settingsPathMode: 'relative',
        intellisenseProvider: provider,
        debugPreset,
      }));
    } catch (error) {
      throw creationFailure(error, appRoot);
    }
  });
  ZephyrApplication.invalidateApplicationWorkspaceFolder(appRoot);

  let folders: FolderChangeOutcome = { applied: true, restart_pending: false };
  if (kind === 'freestanding') {
    folders = await ctx.deps.folders.apply({ add: [appRoot] }, { reason: `manage_app created ${name}` });
    if (!folders.applied && !folders.restart_pending) {
      warnings.push(`The settings were written, but VS Code did not add "${appRoot}" to the window. manage_app action import with path "${appRoot}" adds it.`);
    }
  }
  await ctx.deps.refreshViews(kind === 'workspace' ? ['apps', 'westWorkspaces'] : ['apps']);
  const app = await appDtoAfterWrite(ctx, appRoot, folders.applied);
  return {
    action: 'create',
    kind,
    app,
    template: plan.template,
    files_written: files.filter(file => fs.existsSync(file)),
    warnings,
    ...folderOutcome(folders),
    ...(confirmationOf(ctx, outcome) ? { confirmation: confirmationOf(ctx, outcome) } : {}),
    next: afterRegistrationNext(appRoot, folders.restart_pending),
  };
}

// manage_app import

const IMPORT_ARGS = ['action', 'path', 'west_workspace', 'board', 'toolchain', 'intellisense_provider', 'dry_run'];

async function importApp(args: Record<string, unknown>, ctx: Ctx) {
  const { services } = ctx.deps;
  checkArgs(args, IMPORT_ARGS, 'action "import"');
  checkTypes(args, { path: 'string', west_workspace: 'string', board: 'string', dry_run: 'boolean' });
  const given = str(args.path);
  if (!given) {
    throw invalid('action "import" needs path, the folder holding the application.');
  }
  assertAppFolderPath(given, 'path');
  const appRoot = path.resolve(given);
  const detection = describeZephyrApplicationDetectionFailure(appRoot);
  if (detection) {
    throw invalid(detection);
  }
  const boardId = str(args.board);
  if (boardId) {
    assertBoardIdentifier(boardId);
  }
  const toolchainArg = toolchainArgOf(args.toolchain);
  const requestedProvider = oneOf(args.intellisense_provider, ['cpptools', 'clangd'] as const, 'intellisense_provider');
  const requestedWorkspace = str(args.west_workspace);
  const bare = !boardId && !toolchainArg && !requestedWorkspace && !requestedProvider;
  const dryRun = bool(args.dry_run) === true;

  const apps = await services.listApplications();
  const registered = apps.find(app => same(app.appRootPath, appRoot));
  const containing = services.listWestWorkspaces().find(candidate => isInside(appRoot, candidate.rootUri.fsPath));

  // Only a path: bring the application back from the settings it already has.
  if (bare && ZephyrApplication.isApplicationPath(appRoot)) {
    return reopenApp(args, ctx, appRoot, registered, dryRun);
  }
  if (containing) {
    return importWorkspaceApp(args, ctx, appRoot, containing, { boardId, toolchainArg, requestedProvider, requestedWorkspace, dryRun });
  }
  if (ZephyrApplication.isApplicationPath(appRoot)) {
    throw invalid(`"${appRoot}" already has its workbench settings.`,
      'Call manage_app action import with only path to add it back to the window, then change its toolchain or west workspace with configure target "app" action "update".');
  }

  // A freestanding application getting its first settings.
  const missing: string[] = [];
  let workspace: WestWorkspace | undefined;
  try {
    workspace = (await services.resolveWestWorkspace(requestedWorkspace)).workspace;
  } catch (error) {
    if (requestedWorkspace) {
      throw error;
    }
    missing.push('west_workspace');
  }
  // Inside a west workspace, the import declares the application in that
  // workspace's settings, which needs the workspace open as a folder; one
  // open would have been found above.
  if (workspace && isInside(appRoot, workspace.rootUri.fsPath)) {
    const root = workspace.rootUri.fsPath;
    throw invalid(`"${appRoot}" is inside the west workspace "${root}", which is not open in VS Code: an application inside a west workspace is declared in that workspace's settings, so it can only be imported once the workspace is open.`,
      `Open the workspace first: ${viaTool(ctx, 'manage_west_workspace', `manage_west_workspace with action import and path "${root}"`, 'Add West Workspace')}, then import the application again.`);
  }
  if (!boardId) {
    missing.push('board');
  }
  if (!workspace || !boardId) {
    throw invalid(`Importing "${appRoot}" as a freestanding application needs ${missing.join(' and ')}.`,
      'Pass board, and west_workspace unless the window has a single one (get_status lists them); toolchain defaults to the Zephyr SDK the workspace recommends.',
      { missing });
  }
  return registerFreestandingApp(args, ctx, appRoot, workspace, { boardId, toolchainArg, provider: requestedProvider ?? pickDefaultIntelliSenseProvider(), dryRun });
}

async function reopenApp(args: Record<string, unknown>, ctx: Ctx, appRoot: string, registered: ZephyrApplication | undefined, dryRun: boolean) {
  if (registered) {
    return {
      action: 'import', kind: registered.isWestWorkspaceApplication ? 'workspace' : 'freestanding', outcome: 'reopened',
      changed: false, app: ctx.deps.services.toAppDto(registered), files_written: [], warnings: [], restart_pending: false,
      next: `"${appRoot}" is already an application of this window. Call build_app with app_path "${appRoot}".`,
    };
  }
  const restartExpected = restartsHost({ add: [appRoot] });
  if (dryRun) {
    return {
      action: 'import', kind: 'freestanding', outcome: 'reopened', dry_run: true, app_path: appRoot, files: [],
      adds_folder: true, restart_expected: restartExpected, confirmation_required: confirmationRequired(ctx, args),
      next: 'Call manage_app again without dry_run to add it back to the window.',
    };
  }
  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: `add the application folder ${logSafe(appRoot, 200)} back to the window`
      + (restartExpected ? ', which restarts the extensions of VS Code' : ''),
    appPath: appRoot, folder: appRoot, scope: appRoot, scopeLabel: 'this folder',
  }, args));
  let folders: FolderChangeOutcome = { applied: false, restart_pending: false };
  try {
    await importLocalApplication(appRoot, {
      addFolder: async folderPath => {
        folders = await ctx.deps.folders.apply({ add: [folderPath] }, { reason: `manage_app imported ${path.basename(folderPath)}` });
      },
    });
  } catch (error) {
    throw creationFailure(error, appRoot);
  }
  ZephyrApplication.invalidateApplicationWorkspaceFolder(appRoot);
  const warnings: string[] = [];
  if (!folders.applied && !folders.restart_pending) {
    warnings.push(`VS Code did not add "${appRoot}" to the window. Retry, or ask the user to add the folder.`);
  }
  await ctx.deps.refreshViews(['apps']);
  return {
    action: 'import',
    kind: 'freestanding',
    outcome: 'reopened',
    app: await appDtoAfterWrite(ctx, appRoot, folders.applied),
    files_written: [],
    warnings,
    ...folderOutcome(folders),
    ...(confirmationOf(ctx, outcome) ? { confirmation: confirmationOf(ctx, outcome) } : {}),
    next: afterRegistrationNext(appRoot, folders.restart_pending),
  };
}

interface ImportRequest {
  boardId?: string;
  toolchainArg?: ToolchainArg;
  requestedProvider?: IntelliSenseProviderId;
  requestedWorkspace?: string;
  dryRun: boolean;
}

async function importWorkspaceApp(args: Record<string, unknown>, ctx: Ctx, appRoot: string, workspace: WestWorkspace, request: ImportRequest) {
  const { services } = ctx.deps;
  const root = workspace.rootUri.fsPath;
  if (request.requestedWorkspace) {
    const chosen = (await services.resolveWestWorkspace(request.requestedWorkspace)).workspace.rootUri.fsPath;
    if (!same(chosen, root)) {
      throw invalid(`"${appRoot}" is inside the west workspace "${root}", so it can only be imported into that one.`,
        `Omit west_workspace, or pass "${root}".`);
    }
  }
  const folder = getExactWorkspaceFolder(root);
  if (!folder) {
    throw invalid(`The west workspace "${root}" is not open as a VS Code folder.`);
  }
  const declared = findContainingWorkspaceApplicationEntry(folder, appRoot);
  const linking = !!request.boardId || !!request.toolchainArg || !!request.requestedProvider;
  if (!linking) {
    if (!declared) {
      throw invalid(`Importing "${appRoot}" into its west workspace the first time needs board.`,
        'Pass board; toolchain defaults to the Zephyr SDK the workspace recommends.', { missing: ['board'] });
    }
    return selectWorkspaceApp(args, ctx, appRoot, workspace, folder, request.dryRun);
  }
  if (declared) {
    throw invalid(`The west workspace already declares the application containing "${appRoot}".`,
      'Omit board, toolchain and intellisense_provider to select it, and change it with configure (target "build_config" for the board, target "app" action "update" for the toolchain).');
  }
  if (!request.boardId) {
    throw invalid(`Importing "${appRoot}" into its west workspace the first time needs board.`, undefined, { missing: ['board'] });
  }
  const warnings: string[] = [];
  const board = await resolveBoard(ctx, workspace, request.boardId, warnings);
  const toolchain = await resolveToolchainArg(ctx, request.toolchainArg, workspace);
  const provider = request.requestedProvider ?? pickDefaultIntelliSenseProvider();
  const compat = compatWarningOf(workspace, toolchain.installation);
  if (compat.message) {
    warnings.push(compat.message);
  }
  const files = settingsFiles(root, provider);
  const plan = {
    action: 'import', kind: 'workspace', outcome: 'linked', app_path: appRoot, west_workspace: root, board: request.boardId,
    toolchain: toolchainSummary(toolchain), sdk_compat: compatDtoOf(compat), intellisense_provider: provider,
  };
  if (request.dryRun) {
    return {
      ...plan, dry_run: true, files, settings: settingsPreview('workspace', appRoot, folder, workspace, board, toolchain, provider),
      warnings, confirmation_required: confirmationRequired(ctx, args), next: 'Call manage_app again without dry_run to import it.',
    };
  }
  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: `declare ${logSafe(appRoot, 200)} as an application of the west workspace ${logSafe(path.basename(root), 64)}`,
    appPath: appRoot, board: request.boardId, scope: root, scopeLabel: 'this west workspace',
  }, args));
  await services.withFolderSettingsLock(root, async () => {
    if (findContainingWorkspaceApplicationEntry(folder, appRoot)) {
      throw invalid(`The west workspace declared an application containing "${appRoot}" while this call ran.`);
    }
    try {
      await collectSettingsWarnings(warnings, () => importApplication({
        appRoot, westWorkspace: workspace, board, toolchain: toolchain.installation, toolchainVariant: toolchain.variant,
        settingsPathMode: 'relative', intellisenseProvider: provider,
      }));
    } catch (error) {
      throw creationFailure(error, appRoot);
    }
  });
  await ctx.deps.refreshViews(['apps', 'westWorkspaces']);
  return {
    action: 'import', kind: 'workspace', outcome: 'linked' as ImportOutcome,
    app: await appDtoAfterWrite(ctx, appRoot, true),
    files_written: files.filter(file => fs.existsSync(file)),
    warnings,
    restart_pending: false,
    ...(confirmationOf(ctx, outcome) ? { confirmation: confirmationOf(ctx, outcome) } : {}),
    next: afterRegistrationNext(appRoot, false),
  };
}

async function selectWorkspaceApp(
  args: Record<string, unknown>, ctx: Ctx, appRoot: string, workspace: WestWorkspace, folder: vscode.WorkspaceFolder, dryRun: boolean,
) {
  const root = workspace.rootUri.fsPath;
  if (dryRun) {
    return {
      action: 'import', kind: 'workspace', outcome: 'selected', dry_run: true, app_path: appRoot, west_workspace: root,
      files: [settingsFileIn(root)], confirmation_required: confirmationRequired(ctx, args),
      next: 'Call manage_app again without dry_run to select it.',
    };
  }
  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: `select ${logSafe(path.basename(appRoot), 64)} as the application of the west workspace ${logSafe(path.basename(root), 64)}`,
    appPath: appRoot, scope: root, scopeLabel: 'this west workspace',
  }, args));
  let selected = appRoot;
  const warnings: string[] = [];
  await ctx.deps.services.withFolderSettingsLock(root, async () => {
    try {
      selected = (await collectSettingsWarnings(warnings, () => importApplication({ appRoot, westWorkspace: workspace }))).appRoot;
    } catch (error) {
      throw creationFailure(error, appRoot);
    }
  });
  await ctx.deps.refreshViews(['apps', 'westWorkspaces']);
  return {
    action: 'import', kind: 'workspace', outcome: 'selected' as ImportOutcome,
    app: await appDtoAfterWrite(ctx, selected, true),
    files_written: [settingsFileIn(folder.uri.fsPath)],
    warnings,
    restart_pending: false,
    ...(confirmationOf(ctx, outcome) ? { confirmation: confirmationOf(ctx, outcome) } : {}),
    next: `The workbench views now follow "${selected}". Call build_app with app_path "${selected}" to build it.`,
  };
}

async function registerFreestandingApp(
  args: Record<string, unknown>, ctx: Ctx, appRoot: string, workspace: WestWorkspace,
  request: { boardId: string; toolchainArg?: ToolchainArg; provider: IntelliSenseProviderId; dryRun: boolean },
) {
  const warnings: string[] = [];
  const board = await resolveBoard(ctx, workspace, request.boardId, warnings);
  const toolchain = await resolveToolchainArg(ctx, request.toolchainArg, workspace);
  const compat = compatWarningOf(workspace, toolchain.installation);
  if (compat.message) {
    warnings.push(compat.message);
  }
  const restartExpected = restartsHost({ add: [appRoot] });
  const files = settingsFiles(appRoot, request.provider);
  const plan = {
    action: 'import', kind: 'freestanding', outcome: 'registered', app_path: appRoot, west_workspace: workspace.rootUri.fsPath,
    board: request.boardId, toolchain: toolchainSummary(toolchain), sdk_compat: compatDtoOf(compat), intellisense_provider: request.provider,
  };
  if (request.dryRun) {
    return {
      ...plan, dry_run: true, files,
      settings: settingsPreview('freestanding', appRoot, createWorkspaceFolderReference(appRoot), workspace, board, toolchain, request.provider),
      adds_folder: true, restart_expected: restartExpected, warnings, confirmation_required: confirmationRequired(ctx, args),
      next: 'Call manage_app again without dry_run to import it.',
    };
  }
  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: `set up ${logSafe(appRoot, 200)} as an application linked to the west workspace ${logSafe(path.basename(workspace.rootUri.fsPath), 64)} and add it to the window`
      + (restartExpected ? ', which restarts the extensions of VS Code' : ''),
    appPath: appRoot, board: request.boardId, folder: appRoot, scope: appRoot, scopeLabel: 'this folder',
  }, args));
  await ctx.deps.services.withFolderSettingsLock(appRoot, async () => {
    try {
      await collectSettingsWarnings(warnings, () => importApplication({
        appRoot, westWorkspace: workspace, board, toolchain: toolchain.installation, toolchainVariant: toolchain.variant,
        settingsPathMode: 'relative', intellisenseProvider: request.provider,
      }));
    } catch (error) {
      if (error instanceof IncompleteImportError) {
        throw invalid(error.message, undefined, { missing: [...error.missing] });
      }
      throw creationFailure(error, appRoot);
    }
  });
  ZephyrApplication.invalidateApplicationWorkspaceFolder(appRoot);
  const folders = await ctx.deps.folders.apply({ add: [appRoot] }, { reason: `manage_app imported ${path.basename(appRoot)}` });
  if (!folders.applied && !folders.restart_pending) {
    warnings.push(`The settings were written, but VS Code did not add "${appRoot}" to the window. Calling manage_app action import with only path adds it.`);
  }
  await ctx.deps.refreshViews(['apps']);
  return {
    action: 'import', kind: 'freestanding', outcome: 'registered' as ImportOutcome,
    app: await appDtoAfterWrite(ctx, appRoot, folders.applied),
    files_written: files.filter(file => fs.existsSync(file)),
    warnings,
    ...folderOutcome(folders),
    ...(confirmationOf(ctx, outcome) ? { confirmation: confirmationOf(ctx, outcome) } : {}),
    next: afterRegistrationNext(appRoot, folders.restart_pending),
  };
}

// manage_app create_venv

const VENV_ARGS = ['action', 'app_path', 'dry_run', 'wait_sec'];

function venvActivationScript(venvDir: string): string {
  return process.platform === 'win32' ? path.join(venvDir, 'Scripts', 'activate.bat') : path.join(venvDir, 'bin', 'activate');
}

/**
 * Refuse with BUSY while a working job conflicts with the venv job `claim`
 * describes, so it is refused before the user is asked. The same request
 * still running is no conflict: starting it again attaches to it.
 */
function assertVenvJobFree(ctx: Ctx, claim: JobClaim & { requestKey: string; venvPath: string }): void {
  for (const holder of ctx.deps.jobs.list()) {
    const identical = !isTerminal(holder.status) && holder.spec.lockKey === claim.lockKey && holder.spec.requestKey === claim.requestKey;
    const shared = isWorking(holder) && !identical ? conflictOf(claim, holder.spec) : undefined;
    if (!shared) {
      continue;
    }
    const what = shared === 'west_workspace'
      ? `the west workspace "${claim.westWorkspace}", whose Python requirements the venv installs`
      : `the Python environment "${claim.venvPath}"`;
    throw new McpToolError('BUSY', `A ${holder.spec.kind} job is using ${what} (job_id "${holder.id}").`, {
      hint: `Wait for it with job {"action": "status", "job_id": "${holder.id}"}, or stop it with job {"action": "cancel", "job_id": "${holder.id}"}, then retry.`,
      details: { job_id: holder.id, kind: holder.spec.kind },
    });
  }
}

async function createAppVenv(args: Record<string, unknown>, ctx: Ctx) {
  const { services, jobs, defaultWaitSeconds } = ctx.deps;
  checkArgs(args, VENV_ARGS, 'action "create_venv"');
  checkTypes(args, { app_path: 'string', dry_run: 'boolean', wait_sec: 'number' });
  const app = await services.resolveApp(str(args.app_path));
  const waitSec = num(args.wait_sec) ?? defaultWaitSeconds;
  const venvDir = path.join(app.appRootPath, '.venv');
  const reused = fs.existsSync(venvActivationScript(venvDir));
  const envScript = getConfiguredWorkbenchPath(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, app.appWorkspaceFolder);
  if (!envScript || !fs.existsSync(envScript)) {
    throw new McpToolError('ENV_NOT_READY', 'The Zephyr environment script is not set up, and the venv installer needs it.', {
      hint: 'Call check_environment to see what the host tools install is missing.',
    });
  }
  const claim = {
    kind: 'install' as const,
    lockKey: `venv:${normalizeForCompare(venvDir)}`,
    requestKey: `create_venv:${normalizeForCompare(venvDir)}`,
    appPath: app.appRootPath,
    // The installer reads the requirements of the linked workspace's Zephyr tree.
    ...(app.westWorkspaceRootPath ? { westWorkspace: app.westWorkspaceRootPath } : {}),
    venvPath: venvDir,
    writes: ['venv' as const],
  };
  assertVenvJobFree(ctx, claim);
  const plan = {
    action: 'create_venv',
    app_path: app.appRootPath,
    venv_path: venvDir,
    reuses_existing: reused,
    note: reused
      ? `A venv already exists at ${venvDir}: the installer reuses it, installs or upgrades Zephyr's Python requirements in it, and sets the application to use it. ${PYOCD_NOTE}`
      : PYOCD_NOTE,
  };
  if (bool(args.dry_run) === true) {
    return {
      ...plan, dry_run: true, confirmation_required: confirmationRequired(ctx, args),
      next: 'Call manage_app again without dry_run to create it.',
    };
  }
  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: `create a Python virtual environment in ${logSafe(venvDir, 200)} for ${logSafe(app.appName, 64)}, installing Zephyr's Python requirements (they include pyOCD) from PyPI`,
    appPath: app.appRootPath, folder: venvDir, scope: app.appRootPath,
  }, args));
  const confirmation = confirmationOf(ctx, outcome);
  // A job may have started while the dialog was open.
  assertVenvJobFree(ctx, claim);

  const { job, attached } = jobs.start({
    ...claim,
    command: `create the Python venv ${venvDir}`,
    run: async (sink, signal) => {
      const runner: VenvRunner = {
        nonInteractive: true,
        onOutput: chunk => sink.onData(chunk),
        runTask: async task => {
          const run = await runCapturedTask(task, sink, signal, {
            reveal: REVEAL[ctx.deps.revealTerminal] ?? vscode.TaskRevealKind.Silent,
            header: `> [agent ${ctx.client.name ?? 'mcp'}] Create venv [${app.appName}]`,
          });
          if (signal.aborted) {
            throw new Error('Cancelled.');
          }
          if (!run.started) {
            throw new Error('VS Code did not start the venv installer.');
          }
          return run.exitCode;
        },
      };
      let stored: string | undefined;
      try {
        stored = await createLocalVenv(
          ctx.deps.extensionContext,
          app.appWorkspaceFolder,
          app.westWorkspaceRootPath || undefined,
          app.isWestWorkspaceApplication ? app.appRootPath : undefined,
          runner,
        );
      } catch (error) {
        const code = error instanceof VenvSetupError ? error.code : 'FAILED';
        sink.onData(`\n${messageOf(error)}\n`);
        return { exitCode: 1, extra: { error_code: code, message: messageOf(error), venv_path: venvDir } };
      }
      if (!stored) {
        return { exitCode: 1, extra: { error_code: 'FAILED', message: 'The venv installer did not report a venv.', venv_path: venvDir } };
      }
      try {
        await services.withSettingsLock(app, async () => {
          const fresh = await services.resolveApp(app.appRootPath);
          await updateApplicationSettings(fresh, { [ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY]: stored });
        });
      } catch (error) {
        sink.onData(`\nThe venv was created, but the application settings could not be updated: ${messageOf(error)}\n`);
        return { exitCode: 1, extra: { error_code: 'SETTINGS', message: messageOf(error), venv_path: venvDir } };
      }
      sink.onData(`\nThe application now uses the venv ${venvDir}.\n`);
      await ctx.deps.refreshViews(['apps']);
      return {
        exitCode: 0,
        extra: {
          venv_path: venvDir,
          setting: stored,
          west_found: fs.existsSync(getManagedVenvWestPath(venvDir)),
          reused_existing: reused,
          note: PYOCD_NOTE,
        },
      };
    },
    next: (view: JobView) => {
      if (view.status === 'succeeded') {
        return `The application uses ${venvDir} from now on. Call build_app with app_path "${app.appRootPath}" and pristine "always" if it was configured before, since CMake keeps the Python it found.`;
      }
      const code = view.result?.error_code;
      if (code === 'ENV_NOT_READY') {
        return 'The host tools are not set up. Call check_environment to see what is missing.';
      }
      if (code === 'EXECUTION_POLICY') {
        return 'Ask the user to allow PowerShell scripts for their account (Set-ExecutionPolicy -Scope CurrentUser RemoteSigned), then call manage_app action create_venv again.';
      }
      return `Read what failed with job {"action": "log", "job_id": "${view.job_id}"}.`;
    },
  });
  ctx.audit.jobId = job.id;
  await jobs.wait(job, remainingWaitMs(ctx, waitSec), progressWait(ctx, jobs));
  return {
    ...jobs.view(job, { attached }),
    ...(confirmation ? { confirmation } : {}),
  };
}

export const manageApp: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  switch (args.action) {
    case 'create':
      return createApp(args, ctx);
    case 'import':
      return importApp(args, ctx);
    case 'create_venv':
      return createAppVenv(args, ctx);
    default:
      throw invalid(`action must be create, import or create_venv, not "${logSafe(String(args.action), 40)}".`);
  }
};

// configure target "app" action "update"

const UPDATE_ARGS = ['target', 'action', 'app_path', 'west_workspace', 'toolchain', 'intellisense_provider', 'venv', 'dry_run'];
const UPDATE_FIELDS = ['west_workspace', 'toolchain', 'intellisense_provider', 'venv'];

interface AppUpdatePlan {
  changed: string[];
  westWorkspaceRoot?: string;
  pick?: ToolchainVariantPick;
  choice?: ApplicationToolchainChoice;
  /** The venv.path to store; null clears it. */
  venv?: string | null;
  provider?: IntelliSenseProviderId;
  /** What the change does to the compatibility of the SDK with Zephyr. */
  sdkCompat?: { verdict: SdkCompatVerdict; sdkVersion?: string };
  warnings: string[];
}

function venvArgOf(value: unknown): { mode: 'inherit' | 'path'; path?: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('venv must be an object: {"mode": "inherit"} or {"mode": "path", "path": "..."}.');
  }
  const raw = value as Record<string, unknown>;
  const extra = Object.keys(raw).filter(key => !['mode', 'path'].includes(key));
  if (extra.length > 0) {
    throw invalid(`venv does not take ${extra.join(', ')}.`);
  }
  const mode = oneOf(raw.mode, ['inherit', 'path'] as const, 'venv.mode');
  if (!mode) {
    throw invalid('venv.mode is required: inherit or path.');
  }
  if (mode === 'inherit' && raw.path !== undefined) {
    throw invalid('venv.path does not apply with mode "inherit", which clears the application setting.');
  }
  if (mode === 'path' && (typeof raw.path !== 'string' || raw.path.length === 0)) {
    throw invalid('venv.path is required with mode "path": the absolute root of an existing Python virtual environment.');
  }
  return { mode, ...(mode === 'path' ? { path: raw.path as string } : {}) };
}

function kernelOf(root: string | undefined): string | undefined {
  if (!root) {
    return undefined;
  }
  try {
    return new WestWorkspace(path.basename(root), vscode.Uri.file(root)).kernelUri.fsPath;
  } catch {
    return undefined;
  }
}

/** What an update would change, checked against the application as it is now. */
async function planAppUpdate(ctx: Ctx, app: ZephyrApplication, args: Record<string, unknown>): Promise<AppUpdatePlan> {
  const plan: AppUpdatePlan = { changed: [], warnings: [] };
  let kernelPath = kernelOf(app.westWorkspaceRootPath);

  const requestedWorkspace = str(args.west_workspace);
  if (requestedWorkspace !== undefined) {
    if (app.isWestWorkspaceApplication) {
      throw invalid(`"${app.appRootPath}" is an application of the west workspace it lives in, so its west workspace cannot change.`,
        'Only a freestanding application is linked to a west workspace of its choice.');
    }
    const root = (await ctx.deps.services.resolveWestWorkspace(requestedWorkspace)).workspace.rootUri.fsPath;
    if (!app.westWorkspaceRootPath || !same(root, app.westWorkspaceRootPath)) {
      plan.changed.push('west_workspace');
      plan.westWorkspaceRoot = root;
      kernelPath = kernelOf(root);
      if (app.zephyrSdkVersion && kernelPath) {
        plan.sdkCompat = { verdict: checkSdkCompatibility(app.zephyrSdkVersion, kernelPath), sdkVersion: app.zephyrSdkVersion };
      }
    }
  }

  const toolchainArg = toolchainArgOf(args.toolchain);
  if (toolchainArg) {
    const choices = await listApplicationToolchainChoices(app);
    const choice = choices.find(candidate => candidate.family === toolchainArg.family
      && (toolchainArg.family === 'global_sdk' || (!!candidate.path && same(candidate.path, toolchainArg.path ?? ''))));
    if (!choice) {
      throw invalid(`toolchain ${toolchainArg.family}${toolchainArg.path ? ` "${logSafe(toolchainArg.path, 300)}"` : ''} is not one the workbench offers for this application.`,
        'Call list_toolchains, then pass one of the choices listed in details.',
        { available: choices.map(candidate => ({ family: candidate.family, ...(candidate.path ? { path: candidate.path } : {}) })) });
    }
    if (lacksCToolchain(choice)) {
      throw invalid(`The Rust toolchain at ${choice.path} has no linked C toolchain, which it needs to build.`,
        `Link one first: ${viaTool(ctx, 'manage_toolchain', 'manage_toolchain with action link', 'Change Linked C Toolchain')}.`);
    }
    let selectedVariant = choice.selectedVariant;
    if (toolchainArg.variant === 'llvm') {
      if (choice.selectedVariant !== 'zephyr' || !choice.zephyrSdkPath) {
        throw llvmRefused('variant only applies to a Zephyr SDK');
      }
      if (!resolveChoiceSdk(app, choice)?.hasLlvmToolchain()) {
        throw llvmRefused('that Zephyr SDK has no LLVM toolchain');
      }
      selectedVariant = 'zephyr/llvm';
    }
    const pick: ToolchainVariantPick = {
      selectedVariant,
      zephyrSdkPath: choice.zephyrSdkPath,
      iarToolchainPath: choice.iarToolchainPath,
      armGnuToolchainPath: choice.armGnuToolchainPath,
      rustToolchainPath: choice.rustToolchainPath,
    };
    if (hasApplicationToolchainChanged(app, pick)) {
      plan.changed.push('toolchain');
      plan.pick = pick;
      plan.choice = choice;
      const sdk = pick.zephyrSdkPath === ZEPHYR_PROJECT_SDK_GLOBAL_VALUE ? resolveGlobalSdkForZephyr(kernelPath) : choice.sdk;
      if (sdk && kernelPath) {
        plan.sdkCompat = { verdict: checkSdkCompatibility(sdk.version.trim(), kernelPath), sdkVersion: sdk.version.trim() };
      }
    }
  }

  const venvArg = venvArgOf(args.venv);
  if (venvArg) {
    const current = ctx.deps.services.toAppDto(app).venv;
    if (venvArg.mode === 'inherit') {
      if (current.source === 'app') {
        plan.changed.push('venv');
        plan.venv = null;
      }
    } else {
      const venvPath = venvArg.path!;
      if (!path.isAbsolute(venvPath)) {
        throw invalid(`venv.path "${logSafe(venvPath, 300)}" is not an absolute path.`);
      }
      const reason = validateVenvDirectory(venvPath);
      if (reason) {
        throw invalid(`venv.path "${logSafe(venvPath, 300)}" is not a usable virtual environment: ${reason}`,
          'Pass the root folder of an existing venv, or call manage_app action create_venv to create one for this application.');
      }
      const normalized = path.resolve(venvPath);
      if (!(current.source === 'app' && current.path && same(current.path, normalized))) {
        plan.changed.push('venv');
        plan.venv = normalized;
      }
    }
  }

  const provider = oneOf(args.intellisense_provider, ['cpptools', 'clangd'] as const, 'intellisense_provider');
  if (provider && provider !== app.intellisenseProvider) {
    plan.changed.push('intellisense_provider');
    plan.provider = provider;
    const installed = provider === 'clangd' ? isClangdInstalled() : isCppToolsInstalled();
    if (!installed) {
      plan.warnings.push(`The ${provider === 'clangd' ? 'clangd' : 'C/C++'} extension is not installed, so its files stay inert until the user installs it.`);
    }
  }
  if (plan.sdkCompat) {
    const message = formatSdkCompatMessage(plan.sdkCompat.verdict, plan.sdkCompat.sdkVersion);
    if (message) {
      plan.warnings.push(message);
    }
  }
  return plan;
}

/** A toolchain choice as the agent names it. */
function toolchainOfPick(choice: ApplicationToolchainChoice, pick: ToolchainVariantPick) {
  return {
    family: choice.family,
    ...(choice.path ? { path: choice.path } : {}),
    ...(pick.selectedVariant === 'zephyr/llvm' ? { variant: 'llvm' } : pick.selectedVariant === 'zephyr' ? { variant: 'gnu' } : {}),
  };
}

/** Whether each configuration must be rebuilt from scratch: CMake caches the toolchain, Zephyr and Python it found. */
function pristineNeeds(ctx: Ctx, app: ZephyrApplication, changed: readonly string[]): Record<string, boolean> {
  const cached = changed.some(field => field === 'west_workspace' || field === 'toolchain' || field === 'venv');
  return Object.fromEntries(app.buildConfigs.map(config =>
    [config.name, cached && ctx.deps.services.isConfigured(config.getBuildDir(app))]));
}

/** configure with target "app" and action "update". */
export async function updateApp(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  const { services } = ctx.deps;
  checkArgs(args, UPDATE_ARGS, 'target "app" action "update"');
  checkTypes(args, { app_path: 'string', west_workspace: 'string', intellisense_provider: 'string', dry_run: 'boolean' });
  if (!UPDATE_FIELDS.some(field => args[field] !== undefined)) {
    throw invalid('update needs at least one of west_workspace, toolchain, intellisense_provider and venv.',
      'Read the current values with list_apps, then pass the ones to change.');
  }
  const app = await services.resolveApp(str(args.app_path));
  const plan = await planAppUpdate(ctx, app, args);
  const base = { target: 'app', action: 'update', app_path: app.appRootPath };
  if (plan.changed.length === 0) {
    return {
      ...base, app: services.toAppDto(app), changed: [], needs_pristine: pristineNeeds(ctx, app, []), warnings: plan.warnings,
      next: 'Nothing changed: the application already has these values.',
    };
  }
  if (bool(args.dry_run) === true) {
    return {
      ...base,
      dry_run: true,
      changed: plan.changed,
      ...(plan.westWorkspaceRoot ? { west_workspace: plan.westWorkspaceRoot } : {}),
      ...(plan.choice ? { toolchain: toolchainOfPick(plan.choice, plan.pick!) } : {}),
      ...(plan.venv !== undefined ? { venv: plan.venv === null ? { mode: 'inherit' } : { mode: 'path', path: plan.venv } } : {}),
      ...(plan.provider ? { intellisense_provider: plan.provider } : {}),
      ...(plan.sdkCompat ? {
        sdk_compat: compatDtoOf({ ...plan.sdkCompat, message: formatSdkCompatMessage(plan.sdkCompat.verdict, plan.sdkCompat.sdkVersion) }),
      } : {}),
      needs_pristine: pristineNeeds(ctx, app, plan.changed),
      ...(plan.changed.includes('toolchain') ? { removes_launch_configs: true } : {}),
      warnings: plan.warnings,
      confirmation_required: confirmationRequired(ctx, args),
      next: 'Call configure again without dry_run to apply it.',
    };
  }
  assertAppIdle(ctx, app, { kconfig: false });

  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: `change the ${plan.changed.map(field => field.replace(/_/g, ' ')).join(', ')} of the application ${logSafe(app.appName, 64)}`,
    appPath: app.appRootPath, scope: app.appRootPath,
  }, args));

  return services.withSettingsLock(app, async () => {
    let current = await services.resolveApp(app.appRootPath);
    // Something may have changed while the dialog was open.
    assertAppIdle(ctx, current, { kconfig: false });
    const fresh = await planAppUpdate(ctx, current, args);
    const warnings = [...fresh.warnings];
    let launchConfigsRemoved = 0;
    const reload = () => services.resolveApp(app.appRootPath);
    const settingsFolder = current.appWorkspaceFolder.uri.fsPath;
    await collectSettingsWarnings(warnings, async () => {
      if (fresh.westWorkspaceRoot) {
        await writeSettings(settingsFolder, () => setApplicationWestWorkspace(current, fresh.westWorkspaceRoot!));
        current = await reload();
      }
      if (fresh.pick) {
        const result = await writeSettings(settingsFolder, () => applyApplicationToolchain(current, fresh.pick!, { compilerPath: 'if-configured' }));
        if (result.error) {
          throw invalid(result.error, 'Call list_toolchains and pick a toolchain it reports as installed.');
        }
        launchConfigsRemoved = result.launchConfigsRemoved;
        if (result.launchCleanupWarning) {
          warnings.push(result.launchCleanupWarning);
        }
        if (result.compilerPathDeferred) {
          warnings.push('IntelliSense gets the compiler of the new toolchain at the next build, since the active configuration has no build folder yet.');
        }
        current = await reload();
      }
      if (fresh.venv !== undefined) {
        await writeSettings(settingsFolder, () => updateApplicationSettings(current, {
          [ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY]: fresh.venv ?? undefined,
        }));
        current = await reload();
      }
      if (fresh.provider) {
        try {
          await setApplicationIntelliSenseProvider(current, fresh.provider, reload);
        } catch (error) {
          current = await reload();
          if (current.intellisenseProvider !== fresh.provider) {
            throw creationFailure(error, current.appRootPath);
          }
          warnings.push(`IntelliSense was not fully reconfigured: ${messageOf(error)}. It catches up at the next build.`);
        }
        current = await reload();
      }
    });
    await ctx.deps.refreshViews(['apps']);
    const dto = services.toAppDto(current);
    const needsPristine = pristineNeeds(ctx, current, fresh.changed);
    const pristine = Object.entries(needsPristine).filter(([, needed]) => needed).map(([name]) => name);
    return {
      ...base,
      app: dto,
      changed: fresh.changed,
      needs_pristine: needsPristine,
      ...(dto.sdk_compat ? { sdk_compat: dto.sdk_compat } : {}),
      launch_configs_removed: launchConfigsRemoved,
      venv: dto.venv,
      ...(confirmationOf(ctx, outcome) ? { confirmation: confirmationOf(ctx, outcome) } : {}),
      warnings,
      next: pristine.length > 0
        ? `Call build_app with pristine "always" for ${pristine.join(', ')}: their build folders were configured with the previous settings.`
        : `Call build_app with app_path "${current.appRootPath}" to build with the new settings.`,
    };
  });
}

// remove_or_delete what "application" and "application_files"

/**
 * remove_or_delete with what "application" or "application_files".
 *
 * force changes nothing here: no other application or toolchain depends on an
 * application, and a job, a task or a Kconfig session still working on it is
 * never overridden, so there is nothing for force to go ahead despite.
 */
export async function removeApplication(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  const { services, jobs, defaultWaitSeconds } = ctx.deps;
  checkTypes(args, { app_path: 'string', force: 'boolean', dry_run: 'boolean', wait_sec: 'number' });
  const what = args.what === 'application_files' ? 'application_files' : 'application';
  const requested = str(args.app_path);
  if (!requested) {
    throw invalid(`what "${what}" needs app_path, the application root as list_apps returns it: it never defaults to the only application.`);
  }
  const app = await services.resolveApp(requested);
  if (!same(requested, app.appRootPath)) {
    throw invalid(`app_path "${logSafe(requested, 300)}" is inside the application "${app.appRootPath}", not its root.`,
      `Pass app_path "${app.appRootPath}" if that is the application to remove.`);
  }
  const root = app.appRootPath;
  const kind: ApplicationKind = app.isWestWorkspaceApplication ? 'workspace' : 'freestanding';
  const westRoot = app.isWestWorkspaceApplication ? app.appWorkspaceFolder.uri.fsPath : undefined;
  const dryRun = bool(args.dry_run) === true;
  const waitSec = num(args.wait_sec) ?? defaultWaitSeconds;
  const deleting = what === 'application_files';

  const fence = async () => {
    const apps = await services.listApplications();
    const workspaceRoots = [
      ...services.listWestWorkspaces().map(workspace => workspace.rootUri.fsPath),
      ...apps.map(candidate => candidate.westWorkspaceRootPath).filter((candidate): candidate is string => !!candidate),
    ];
    return checkAppFolderDeletion({
      target: root,
      registeredApps: apps.map(candidate => candidate.appRootPath),
      westWorkspaces: [...new Set(workspaceRoots.map(candidate => normalizeForCompare(candidate)))].map(key => {
        const workspaceRoot = workspaceRoots.find(candidate => normalizeForCompare(candidate) === key)!;
        const workspace = (() => {
          try {
            return new WestWorkspace(path.basename(workspaceRoot), vscode.Uri.file(workspaceRoot));
          } catch {
            return undefined;
          }
        })();
        return {
          root: workspaceRoot,
          protectedTrees: workspace ? [workspace.kernelUri.fsPath, workspace.rustModuleUri.fsPath] : [path.join(workspaceRoot, 'zephyr')],
        };
      }),
      knownRoots: await services.knownRoots(),
    });
  };
  const checks = async () => {
    assertAppIdle(ctx, app);
    return deleting ? (await fence()).exists : fs.existsSync(root);
  };
  const exists = await checks();
  const restartExpected = kind === 'freestanding' && restartsHost({ remove: [app.appWorkspaceFolder.uri.fsPath] });
  const configurations = app.buildConfigs.map(config => config.name);
  const base = { what, app_path: root, kind, ...(westRoot ? { west_workspace: westRoot } : {}) };

  if (dryRun) {
    const size = deleting && exists ? measureFolder(root) : undefined;
    return {
      ...base,
      dry_run: true,
      would_unregister: kind === 'workspace'
        ? { from: settingsFileIn(westRoot!), configurations }
        : { folder: root, keeps_settings: !deleting, restart_expected: restartExpected },
      ...(deleting ? {
        would_delete: exists
          ? [{ path: root, size_bytes: size!.bytes, files: size!.files, ...(size!.complete ? {} : { size_is_lower_bound: true }) }]
          : [],
      } : {}),
      confirmation_required: confirmationRequired(ctx, args),
      next: 'Call remove_or_delete again without dry_run to go ahead.',
    };
  }

  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: deleting
      ? `delete the application ${logSafe(app.appName, 64)} and its folder ${logSafe(root, 200)} from disk`
      : `remove the application ${logSafe(app.appName, 64)} from ${kind === 'workspace' ? 'its west workspace' : 'the window'}, keeping its files`,
    appPath: root, folder: deleting ? root : undefined, scope: root,
  }, args));
  const confirmation = confirmationOf(ctx, outcome);

  // A build may have started, or the folder changed, while the dialog was open.
  const stillExists = await checks();
  const warnings: string[] = [];
  let folders: FolderChangeOutcome = { applied: true, restart_pending: false };

  const unregister = async (jobId?: string) => {
    await unregisterApplication(app, {
      removeFolder: async folder => {
        folders = await ctx.deps.folders.apply({ remove: [folder.uri.fsPath] }, {
          reason: `remove_or_delete ${what} ${app.appName}`, ...(jobId ? { jobId } : {}),
        });
      },
    });
  };
  const unregisterUnderLock = async (jobId?: string) => {
    if (westRoot) {
      await services.withFolderSettingsLock(westRoot, () =>
        writeSettings(westRoot, () => collectSettingsWarnings(warnings, () => unregister(jobId))));
    } else {
      await unregister(jobId);
    }
  };

  if (!deleting || !stillExists) {
    await unregisterUnderLock();
    if (!folders.applied && !folders.restart_pending) {
      warnings.push(`VS Code did not remove "${root}" from the window. Ask the user to remove the folder from the workspace.`);
    }
    await ctx.deps.refreshViews(kind === 'workspace' ? ['apps', 'westWorkspaces'] : ['apps']);
    return {
      ...base,
      removed: true,
      ...(kind === 'workspace' ? { removed_configurations: configurations } : {}),
      ...(deleting ? { deleted: [], already_gone: true } : { kept_files: true }),
      ...folderOutcome(folders),
      ...(confirmation ? { confirmation } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      next: deleting
        ? 'Done: the folder was already gone.'
        : `The files stay in "${root}". Call manage_app with action import and path "${root}" to register it again.`,
    };
  }

  // The job starts before anything is unregistered, so when the job manager
  // refuses it (a conflicting job, or a folder change restarting the window)
  // the application stays as it was. It deletes nothing until the application
  // is unregistered, as the Applications view does; a removal that restarts
  // the extensions of the window waits for the deletion job.
  let unregistered: (done: boolean) => void = () => undefined;
  const whenUnregistered = new Promise<boolean>(resolve => { unregistered = resolve; });
  let removal: 'removed' | 'absent' | 'busy' | undefined;
  const spec: JobSpec = {
    kind: 'clean',
    lockKey: root,
    requestKey: `delete-app:${normalizeForCompare(root)}`,
    appPath: root,
    buildDir: root,
    command: `delete ${root}`,
    run: async (sink, signal) => {
      if (!await whenUnregistered || signal.aborted) {
        sink.onData(`${root} was not deleted: ${signal.aborted ? 'the deletion was cancelled' : 'the application could not be unregistered'}.\n`);
        return { exitCode: 1 };
      }
      sink.onData(`Deleting ${root}\n`);
      // Agent Kconfig sessions inside the folder are stopped first, and none may start there until the deletion ends.
      const reopenKconfig = await ctx.deps.kconfig.closeWithin(root);
      try {
        removal = await removeDirectory(root);
      } catch (error) {
        sink.onData(`${root} could not be deleted: ${messageOf(error)}\n`);
        return { exitCode: 1 };
      } finally {
        reopenKconfig();
      }
      if (removal === 'busy') {
        sink.onData(`Some files in ${root} are in use, so it was not fully deleted.\n`);
        return { exitCode: 1 };
      }
      sink.onData(`Deleted ${root}\n`);
      return { exitCode: 0 };
    },
  };
  const { job } = jobs.start(spec);
  ctx.audit.jobId = job.id;
  try {
    await unregisterUnderLock(job.id);
  } catch (error) {
    unregistered(false);
    throw error;
  }
  unregistered(true);
  await ctx.deps.refreshViews(kind === 'workspace' ? ['apps', 'westWorkspaces'] : ['apps']);
  await jobs.wait(job, remainingWaitMs(ctx, waitSec), progressWait(ctx, jobs));

  if (!isTerminal(job.status)) {
    return {
      ...base,
      removed: true,
      status: 'running',
      job: jobs.view(job, { parse: false }),
      ...folderOutcome(folders),
      ...(confirmation ? { confirmation } : {}),
      next: `The deletion is still running. Call job {"action": "status", "job_id": "${job.id}"} until it ends.`,
    };
  }
  if (removal === 'busy') {
    throw new McpToolError('BUSY_EXTERNAL', `Some files in "${root}" are in use, so it was only partly deleted. It is no longer registered.`, {
      hint: 'Ask the user to close any terminal, editor or tool using that folder, then delete what is left by hand.',
      details: { folder: root, still_exists: fs.existsSync(root), job_id: job.id },
    });
  }
  if (job.status !== 'succeeded') {
    throw new McpToolError('INTERNAL', `Deleting "${root}" ${job.status === 'cancelled' ? 'was cancelled' : 'failed'}: ${jobs.lastLine(job, 300)}. It is no longer registered.`, {
      details: { job_id: job.id, log: job.log.filePath },
    });
  }
  return {
    ...base,
    removed: true,
    ...(kind === 'workspace' ? { removed_configurations: configurations } : {}),
    deleted: removal === 'absent' ? [] : [root],
    ...folderOutcome(folders),
    ...(confirmation ? { confirmation } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    job_id: job.id,
    next: folders.restart_pending
      ? 'Done. VS Code restarts the extensions of the window in a few seconds to drop the folder: call get_status until it answers again.'
      : 'Done. Call list_apps to see the applications left.',
  };
}
