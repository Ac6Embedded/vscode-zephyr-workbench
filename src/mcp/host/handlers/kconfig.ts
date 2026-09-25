// Kconfig through the build's real Kconfig tree: query_kconfig's explain mode and
// defconfig format, and set_kconfig.
//
// Both run a kconfiglib session (kconfig_server.py) from the MCP's own pool, never the
// Kconfig Manager's, and neither writes .config. set_kconfig writes the workbench
// managed region of prj.conf or a .conf fragment, which the next build merges. Before
// it writes, it runs the same fragment merge that configure will run, with the new text
// standing in for the file, so an assignment that would not take, or that Zephyr would
// refuse, is reported with its reason instead of being written. Nothing here opens a
// dialog, except the confirmation the user asked for.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ZephyrApplication } from '../../../models/ZephyrApplication';
import type { ZephyrBuildConfig } from '../../../models/ZephyrBuildConfig';
import type { KconfigEditorInfo } from '../../../panels/KconfigManagerPanel';
import { isInExtraConfFiles } from '../../../utils/kconfig/extraConfFiles';
import { driftExportEdits } from '../../../utils/kconfig/driftExport';
import {
  checkFragmentStaleness, findBuildInfoYml, findFragmentAssignments, findLaterFragmentOverrides, fragmentsMergedAfter,
  KconfigFragmentInfo, mergeListWithTarget, readKconfigFragments,
} from '../../../utils/kconfig/fragmentStaleness';
import { preflight } from '../../../utils/kconfig/kconfigEnvExtractor';
import type { KcCheckMergeResult, KcDriftEntry, KcExplainResult, KcFindResult } from '../../../utils/kconfig/kconfigRpcTypes';
import { resolveKconfigFile } from '../../../utils/kconfig/kconfigSession';
import type { PoolClient, PooledSession } from '../../../utils/kconfig/kconfigSessionPool';
import { planPrjConfUpsert, readPrjConfManagedRegion, symbolOf, upsertPrjConfManagedRegion } from '../../../utils/kconfig/prjConfWriter';
import { getDomainBuildDir, readDomainsForBuildDir } from '../../../utils/zephyr/domainsYamlUtils';
import { readZephyrKconfigReport } from '../../../utils/zephyr/kconfigReportParser';
import { assertEnvListElement, assertInside, assertSafeShellFragment, isInside, normalizeForCompare } from '../../core/argSafety';
import { McpToolError } from '../../core/errors';
import {
  Assignment, CONFIG_PREFIX, evaluateAssignment, explainOutput, formatAssignment, FormattedValue,
  kconfigToolError, MAX_EXPLAIN_SYMBOLS, parseAssignments, SetResult, symbolName,
} from '../../core/kconfigRules';
import { ToolContext, ToolHandler } from '../../core/toolSpec';
import { isTerminal } from '../../jobs/jobManager';
import type { ConfirmSubject } from '../confirmations';
import { HostDeps } from './deps';

type Ctx = ToolContext<HostDeps>;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);

const CONFIGURE_HINT = 'Call build_app with cmake_only true, then retry.';
/** Longest list of side effects or discarded values returned, per list. */
const LIST_LIMIT = 40;
/** Characters of minimal configuration text returned. */
const DEFCONFIG_LIMIT = 90000;
/** A cold session parses the whole Kconfig tree; tell the agent while it waits. */
const HEARTBEAT_MS = 5000;

/** The image of a build whose Kconfig is read or written. */
interface KconfigImage {
  app: ZephyrApplication;
  config: ZephyrBuildConfig;
  /** The configuration's build directory: what agent build jobs and the Kconfig Manager are keyed by. */
  buildDir: string;
  /** The sysbuild domain, when the build has domains. */
  domain?: string;
  /** False for a sysbuild image other than the default one. */
  isDefaultDomain: boolean;
  /** Where the image's build.ninja and zephyr/.config are. */
  imageDir: string;
}

/**
 * Resolve the application, configuration and image directory, and require a configured
 * build. Sysbuild writes a zephyr/.config of its own (SB_CONFIG_*) in the top build
 * directory, so an image's Kconfig is always read from its domain directory.
 */
async function resolveImage(ctx: Ctx, args: Record<string, unknown>): Promise<KconfigImage> {
  const { services } = ctx.deps;
  const { app, config, buildDir } = await services.resolveTarget(str(args.app_path), str(args.config_name));
  const requested = services.resolveDomain(app, config, str(args.domain));
  const domains = readDomainsForBuildDir(buildDir);
  let domain: string | undefined;
  let artifacts: ReturnType<typeof preflight>;
  if (domains) {
    domain = requested ?? domains.defaultDomain;
    artifacts = preflight(getDomainBuildDir(domains, domain) ?? path.join(buildDir, domain));
  } else {
    artifacts = preflight(buildDir, app.appName);
  }
  if (!artifacts.ready) {
    throw new McpToolError('BUILD_NOT_CONFIGURED',
      `The Kconfig output of "${artifacts.buildDir}" is incomplete: ${artifacts.missing.join(', ')} missing.`, {
        hint: CONFIGURE_HINT,
      });
  }
  return {
    app, config, buildDir, domain,
    isDefaultDomain: !domains || domain === domains.defaultDomain,
    imageDir: artifacts.buildDir,
  };
}

/** The ordered fragment list the image was configured from. */
function fragmentsOf(image: KconfigImage): KconfigFragmentInfo | undefined {
  const file = findBuildInfoYml(image.imageDir);
  return file ? readKconfigFragments(file) : undefined;
}

/**
 * Run `fn` on the pooled session of the image, mapping any failure to the tool error
 * contract. A session that has to start sends progress, because the first parse of a
 * large tree can take several seconds.
 */
async function withSession<T>(ctx: Ctx, image: KconfigImage, fn: (session: PooledSession) => Promise<T>): Promise<T> {
  let client: PoolClient | undefined;
  let pulse: NodeJS.Timeout | undefined;
  const report = () => ctx.progress({
    progress: Math.round((Date.now() - ctx.startedAt) / 1000),
    message: 'Loading the Kconfig tree of this build',
  });
  try {
    return await ctx.deps.kconfig.use(image.imageDir, {
      venvPath: image.app.venvPath,
      onStart: () => {
        report();
        pulse = setInterval(report, HEARTBEAT_MS);
      },
    }, session => {
      if (pulse) {
        clearInterval(pulse);
        pulse = undefined;
      }
      client = session.client;
      return fn(session);
    });
  } catch (error) {
    const tail = client?.recentStderr ?? (error as { stderrTail?: string[] } | undefined)?.stderrTail ?? [];
    throw kconfigToolError(error, tail);
  } finally {
    if (pulse) {
      clearInterval(pulse);
    }
  }
}

function uniqueNames(raw: unknown[]): string[] {
  return [...new Set(raw.map(symbolName))];
}

// -- explain ------------------------------------------------------------------

/**
 * query_kconfig with explain true: type, value, help, dependencies with the terms that
 * block, selectors with their state, definition sites and how to change each symbol,
 * from the live Kconfig tree of the build.
 */
export async function explainKconfig(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  for (const key of ['pattern', 'only_set', 'limit', 'offset']) {
    if (args[key] !== undefined) {
      throw new McpToolError('INVALID_ARGUMENT', `${key} cannot be combined with explain, which reads the exact names in symbols.`, {
        hint: 'Find names with pattern first (explain false), then explain up to 10 of them.',
      });
    }
  }
  const raw = Array.isArray(args.symbols) ? args.symbols : [];
  if (raw.length === 0 || raw.length > MAX_EXPLAIN_SYMBOLS) {
    throw new McpToolError('INVALID_ARGUMENT',
      `explain needs symbols with 1 to ${MAX_EXPLAIN_SYMBOLS} names; ${raw.length} were given.`);
  }
  const names = uniqueNames(raw);
  const image = await resolveImage(ctx, args);
  const editor = ctx.deps.services.kconfigEditorState(image.buildDir);
  const fragments = fragmentsOf(image);

  return withSession(ctx, image, async ({ client, spec }) => {
    const result = await client.call<KcExplainResult>('explain', { names });
    // Why each symbol holds its value in the last build, from the trace Zephyr writes.
    const report = readZephyrKconfigReport({
      traceJsonPath: path.join(image.imageDir, 'zephyr', '.config-trace.json'),
      dotConfigPath: spec.configPath,
      zephyrBase: spec.zephyrBase,
      westWorkspaceRoot: image.app.westWorkspaceRootPath,
    });
    const traced = new Map((report?.source === 'trace' ? report.symbols : [])
      .map(symbol => [symbol.name.replace(/^CONFIG_/, ''), symbol]));
    const assignments = fragments ? findFragmentAssignments(fragments.files, names) : new Map();
    const stale = fragments
      ? checkFragmentStaleness(image.imageDir, fragments.files)
      : { stale: true, reason: 'build_info.yml has no Kconfig fragment list' };

    const symbols = result.symbols.map(entry => {
      const trace = traced.get(entry.name);
      return explainOutput(entry, {
        resolveFile: file => resolveKconfigFile(file, spec.zephyrBase),
        origin: trace ? {
          kind: trace.source,
          ...(trace.locPath ? { file: trace.locPath, line: trace.locLine } : {}),
          ...((trace.source === 'select' || trace.source === 'imply') && trace.locDisplay ? { expr: trace.locDisplay } : {}),
        } : undefined,
        assignedIn: assignments.get(entry.name),
      });
    });
    const notFound = Object.entries(result.unknown).map(([name, suggestions]) => ({
      symbol: `${CONFIG_PREFIX}${name}`,
      ...(suggestions.length ? { did_you_mean: suggestions.map(s => `${CONFIG_PREFIX}${s}`) } : {}),
    }));
    return {
      config_path: spec.configPath,
      ...(image.domain ? { domain: image.domain } : {}),
      ...(stale.stale ? { stale: { reason: stale.reason } } : {}),
      ...(editor?.dirty ? {
        editor_unsaved: true,
        note: 'The Kconfig Manager has unsaved changes on this build. These values come from the saved .config and do not include them.',
      } : {}),
      symbols,
      ...(notFound.length ? { not_found: notFound } : {}),
    };
  });
}

// -- defconfig ------------------------------------------------------------------

/**
 * query_kconfig with format defconfig: the minimal configuration of the build, as
 * menuconfig's "save minimal config" writes it (kconfiglib's write_min_config), read
 * from a temporary file that is deleted afterwards. Nothing in the workspace is written.
 */
export async function minimalKconfig(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  for (const key of ['symbols', 'pattern', 'only_set', 'limit', 'offset']) {
    if (args[key] !== undefined) {
      throw new McpToolError('INVALID_ARGUMENT', `${key} cannot be combined with format "defconfig", which returns the whole minimal configuration.`, {
        hint: 'Call query_kconfig again without it, or with format "values" to filter symbols.',
      });
    }
  }
  if (args.explain === true) {
    throw new McpToolError('INVALID_ARGUMENT', 'explain cannot be combined with format "defconfig".', {
      hint: 'Call query_kconfig with explain true and format "values" to explain symbols.',
    });
  }
  const image = await resolveImage(ctx, args);
  const editor = ctx.deps.services.kconfigEditorState(image.buildDir);
  const fragments = fragmentsOf(image);

  return withSession(ctx, image, async ({ client, spec }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-defconfig-'));
    try {
      const file = path.join(dir, 'defconfig');
      await client.call('write_min_config', { path: file });
      const text = fs.readFileSync(file, 'utf8');
      const stale = fragments
        ? checkFragmentStaleness(image.imageDir, fragments.files)
        : { stale: true, reason: 'build_info.yml has no Kconfig fragment list' };
      return {
        format: 'defconfig',
        config_path: spec.configPath,
        ...(image.domain ? { domain: image.domain } : {}),
        options: text.split('\n').filter(line => /^(CONFIG_|# CONFIG_.* is not set)/.test(line)).length,
        defconfig: text.length > DEFCONFIG_LIMIT ? text.slice(0, DEFCONFIG_LIMIT) : text,
        ...(text.length > DEFCONFIG_LIMIT ? { truncated: true } : {}),
        ...(stale.stale ? { stale: { reason: stale.reason } } : {}),
        ...(editor?.dirty ? {
          editor_unsaved: true,
          note: 'The Kconfig Manager has unsaved changes on this build. This comes from the saved .config and does not include them.',
        } : {}),
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// -- set ----------------------------------------------------------------------

/** The file a set_kconfig call writes, and how it relates to the build. */
interface SetTarget {
  kind: 'prj_conf' | 'fragment';
  path: string;
  /** Listed in the fragment list the build was configured from. */
  inBuild: boolean;
}

/** Resolve symlinks of whatever part of `target` exists, so a link cannot lead outside the application. */
function realTarget(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    const parent = path.dirname(target);
    return parent === target ? target : path.join(realTarget(parent), path.basename(target));
  }
}

function assertInApplication(file: string, image: KconfigImage, label: string): void {
  assertInside(file, [image.app.appRootPath], label);
  assertInside(realTarget(file), [realTarget(image.app.appRootPath)], label);
  if (isInside(file, image.buildDir)) {
    throw new McpToolError('INVALID_ARGUMENT',
      `${label} "${file}" is inside the build directory, which a pristine build deletes and which holds only generated files.`, {
        hint: 'Use prj.conf, or a .conf file in the application folder.',
      });
  }
}

/**
 * Where the assignments go. prj_conf means the application's own configuration file as
 * the build used it (CONF_FILE may name prj_<variant>.conf), so it comes from the
 * fragment list rather than being assumed.
 */
function resolveSetTarget(args: Record<string, unknown>, image: KconfigImage, fragments: KconfigFragmentInfo): SetTarget {
  const inList = (file: string) => fragments.files.some(f => normalizeForCompare(f) === normalizeForCompare(file));
  if ((str(args.target) ?? 'prj_conf') === 'prj_conf') {
    const own = fragments.userFiles.find(f => inList(f) && isInside(f, image.app.appRootPath));
    const fallback = path.join(image.app.appRootPath, 'prj.conf');
    const chosen = own ?? (inList(fallback) ? fallback : undefined);
    if (!chosen) {
      if (fragments.userFiles.length > 0) {
        throw new McpToolError('PATH_OUTSIDE_WORKSPACE',
          `This image's configuration file ${fragments.userFiles.join(', ')} is outside the application, so set_kconfig does not write it.`, {
            hint: image.isDefaultDomain
              ? 'Use target "fragment" with a fragment_path inside the application and register_fragment true.'
              : 'Ask the user to change that file, or to give this image a configuration file inside the application.',
            details: { user_files: fragments.userFiles },
          });
      }
      throw new McpToolError('INVALID_ARGUMENT', 'This build merges no configuration file of the application, so there is no prj.conf to write.', {
        hint: 'Use target "fragment" with a fragment_path inside the application and register_fragment true.',
      });
    }
    assertInApplication(chosen, image, 'prj.conf');
    return { kind: 'prj_conf', path: chosen, inBuild: true };
  }
  const file = path.normalize(str(args.fragment_path) as string);
  assertInApplication(file, image, 'fragment_path');
  return { kind: 'fragment', path: file, inBuild: inList(file) };
}

/** Validate what can be checked before anything is resolved. */
function checkSetArguments(args: Record<string, unknown>): { assignments: Assignment[]; persist: boolean; register: boolean; dryRun: boolean } {
  if (args.persist_temporary !== undefined && typeof args.persist_temporary !== 'boolean') {
    throw new McpToolError('INVALID_ARGUMENT', 'persist_temporary must be true or false.');
  }
  const persist = args.persist_temporary === true;
  if (args.assignments === undefined && !persist) {
    throw new McpToolError('INVALID_ARGUMENT', 'set_kconfig needs assignments, persist_temporary true, or both.', {
      hint: 'Pass the options to change in assignments, or persist_temporary true to save the values changed in menuconfig, guiconfig or the Kconfig Manager.',
    });
  }
  const assignments = args.assignments === undefined ? [] : parseAssignments(args.assignments);
  const target = str(args.target) ?? 'prj_conf';
  const register = bool(args.register_fragment) ?? false;
  const fragmentPath = args.fragment_path;
  if (target === 'fragment') {
    if (typeof fragmentPath !== 'string' || fragmentPath.length === 0) {
      throw new McpToolError('INVALID_ARGUMENT', 'target "fragment" needs fragment_path, the absolute path of a .conf file in the application.');
    }
    if (!path.isAbsolute(fragmentPath)) {
      throw new McpToolError('INVALID_ARGUMENT', `fragment_path must be absolute; "${fragmentPath}" is not.`);
    }
    if (path.extname(fragmentPath) !== '.conf') {
      throw new McpToolError('INVALID_ARGUMENT', `fragment_path must name a .conf file; "${path.basename(fragmentPath)}" does not.`);
    }
    // The path can end up in EXTRA_CONF_FILE, a ';' separated CMake list handed to the
    // build, so it gets the same check as any value that reaches a command line. That
    // check lets ${workspaceFolder} and balanced quotes through for west arguments, but
    // here they would name one file on disk and another once the setting is expanded.
    assertSafeShellFragment(fragmentPath, 'fragment_path');
    if (/[$"']/.test(fragmentPath)) {
      throw new McpToolError('INVALID_ARGUMENT', 'fragment_path must be a plain path, without $ or quotes.');
    }
  } else {
    if (fragmentPath !== undefined) {
      throw new McpToolError('INVALID_ARGUMENT', 'fragment_path is only used with target "fragment".');
    }
    if (register) {
      throw new McpToolError('INVALID_ARGUMENT', 'register_fragment is only used with target "fragment": prj.conf is always part of the build.');
    }
  }
  return { assignments, persist, register, dryRun: bool(args.dry_run) ?? false };
}

/**
 * A Kconfig Manager tab with unsaved edits on a build that merges `file`, if there is
 * one. prj.conf is merged by every configuration of the application, and a fragment by
 * every build that lists it, so the targeted build is not the only one whose edits a
 * change to it would make the next build discard.
 */
function dirtyEditorMerging(ctx: Ctx, image: KconfigImage, file: string): KconfigEditorInfo | undefined {
  const wanted = normalizeForCompare(file);
  return ctx.deps.services.kconfigEditors().find(editor => {
    if (!editor.dirty) {
      return false;
    }
    const buildInfo = findBuildInfoYml(editor.imageDir);
    const fragments = buildInfo ? readKconfigFragments(buildInfo) : undefined;
    if (!fragments) {
      // No fragment list to tell: a build of this application is assumed to merge its files.
      return isInside(editor.buildDir, image.app.appRootPath);
    }
    return fragments.files.some(f => normalizeForCompare(f) === wanted);
  });
}

/**
 * Refuse while something else owns the configuration: unsaved Kconfig Manager edits on
 * a build that merges the file (the next build would re-merge the fragments and silently
 * drop them), an agent build, or a task the user started. Checked before and again after
 * the confirmation.
 */
function assertNothingRunning(ctx: Ctx, image: KconfigImage, target: SetTarget): void {
  const editor = ctx.deps.services.kconfigEditorState(image.buildDir);
  if (editor?.dirty) {
    throw new McpToolError('BUSY_EXTERNAL',
      `The Kconfig Manager has unsaved changes on ${image.config.name}. Changing the configuration files now would make the next build discard them.`, {
        hint: 'Ask the user to save or discard the changes in the Kconfig Manager tab, then retry.',
        details: { editor: 'kconfig_manager' },
      });
  }
  const sharing = dirtyEditorMerging(ctx, image, target.path);
  if (sharing) {
    throw new McpToolError('BUSY_EXTERNAL',
      `The Kconfig Manager has unsaved changes on ${sharing.configName}, whose build also merges ${target.path}. Changing that file now would make its next build discard them.`, {
        hint: `Ask the user to save or discard the changes in the Kconfig Manager tab of ${sharing.configName}, then retry.`,
        details: { editor: 'kconfig_manager', config_name: sharing.configName },
      });
  }
  const job = ctx.deps.jobs.list().find(candidate =>
    normalizeForCompare(candidate.spec.lockKey) === normalizeForCompare(image.buildDir)
    && (!isTerminal(candidate.status) || candidate.endedAt === undefined));
  if (job) {
    throw new McpToolError('BUSY', `A ${job.spec.kind} job is running in this build directory (job_id "${job.id}").`, {
      hint: `Wait for it with job {"action": "status", "job_id": "${job.id}"}, then retry.`,
      details: { job_id: job.id },
    });
  }
  const external = ctx.deps.services.externalTaskName(image.app, image.config);
  if (external) {
    throw new McpToolError('BUSY_EXTERNAL', `"${external}" is running for ${image.config.name}, started from VS Code.`, {
      hint: 'Wait for it to finish in its terminal, then retry.',
    });
  }
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw new McpToolError('INTERNAL', `Cannot read "${file}": ${(error as Error).message}`);
  }
}

interface Planned {
  assignment: Assignment;
  type: string;
  formatted?: FormattedValue;
  /** Set when the value does not fit the symbol, before any simulation. */
  rejected?: string;
  /** A value the user set in menuconfig, guiconfig or the Kconfig Manager, saved by persist_temporary. */
  temporary?: KcDriftEntry;
}

interface Simulation {
  results: SetResult[];
  check: Extract<KcCheckMergeResult, { ok: true }>;
  /** Assignments elsewhere that stop taking effect, and warnings Zephyr would abort on. */
  conflicts: { symbol: string; reason: string }[];
  warnings: string[];
}

/** The winning assignment site, reported against the real file rather than the stand-in. */
function realSite(site: { file: string; line: number } | null, standIn: string, target: string) {
  if (!site) {
    return undefined;
  }
  return { file: normalizeForCompare(site.file) === normalizeForCompare(standIn) ? target : site.file, line: site.line };
}

async function simulate(
  client: PoolClient, image: KconfigImage, fragments: KconfigFragmentInfo, target: SetTarget,
  planned: Planned[], proposedText: string, regionBefore: Map<string, string>,
): Promise<Simulation> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-kconfig-'));
  const standIn = path.join(dir, path.basename(target.path));
  try {
    fs.writeFileSync(standIn, proposedText, 'utf8');
    const merge = mergeListWithTarget(fragments, target.path, standIn, image.imageDir);
    const names = planned.map(p => p.assignment.name);
    const check = await client.call<KcCheckMergeResult>('check_merge', {
      fragments: merge.files, compare: fragments.files, names, limit: LIST_LIMIT,
    });
    if (!check.ok) {
      throw new McpToolError('INTERNAL', `The Kconfig merge check failed: ${check.error}`);
    }
    const results = planned.map(p => {
      const key = `${CONFIG_PREFIX}${p.assignment.name}`;
      if (p.rejected) {
        return {
          symbol: key,
          requested: typeof p.assignment.value === 'string' ? p.assignment.value : String(p.assignment.value),
          previous: check.current[p.assignment.name] ?? null,
          status: 'rejected' as const,
          effective_after_merge: check.before[p.assignment.name] ?? null,
          reason: p.rejected,
        };
      }
      const merged = check.symbols[p.assignment.name];
      return evaluateAssignment({
        name: p.assignment.name,
        type: p.type,
        unset: p.assignment.unset,
        formatted: p.formatted,
        previous: check.current[p.assignment.name] ?? null,
        merge: merged,
        regionAlready: p.assignment.unset
          ? !regionBefore.has(key)
          : regionBefore.get(key) === p.formatted?.line,
        regionHadLine: regionBefore.has(key),
        winner: realSite(merged?.assignedAt ?? null, standIn, target.path),
        targetPath: target.path,
        buildDir: image.buildDir,
        appRoot: image.app.appRootPath,
      });
    });
    const conflicts = Object.entries(check.newFailures)
      .map(([name, reason]) => ({ symbol: `${CONFIG_PREFIX}${name}`, reason }));
    const warnings = check.newWarnings.map(w => w.split(standIn).join(target.path));
    return { results, check, conflicts, warnings };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Add the fragment to the configuration's EXTRA_CONF_FILE, as configure writes settings:
 * under the settings lock, from the configuration as stored now. The Kconfig check and
 * the confirmation can take a while, and a change configure made meanwhile must not be
 * written over, nor a configuration renamed or removed meanwhile be written to. Throws
 * with the reason; the caller reports it, since the file itself is already written.
 */
async function registerFragment(ctx: Ctx, image: KconfigImage, file: string): Promise<void> {
  const { services } = ctx.deps;
  await services.withSettingsLock(image.app, async () => {
    const fresh = await services.resolveApp(image.app.appRootPath);
    const config = fresh.buildConfigs.find(candidate => candidate.name === image.config.name);
    if (config?.isSysbuild()) {
      throw new Error(`${image.config.name} now uses sysbuild, and the workbench does not pass EXTRA_CONF_FILE to a sysbuild build`);
    }
    const outcome = config ? await services.addExtraConfFile(fresh, config, file) : 'missing';
    if (outcome === 'missing') {
      throw new Error(`the build configuration "${image.config.name}" was renamed or removed while this call ran`);
    }
  });
}

function describeNames(planned: Planned[]): string {
  const names = planned.map(p => `${CONFIG_PREFIX}${p.assignment.name}`);
  return names.length > 4 ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more` : names.join(', ');
}

function describeChange(planned: Planned[]): string {
  const temporary = planned.filter(p => p.temporary);
  const explicit = planned.filter(p => !p.temporary);
  const saved = temporary.length > 0
    ? `save ${temporary.length === 1 ? 'the temporary value of' : 'the temporary values of'} ${describeNames(temporary)}`
    : '';
  const changed = explicit.length > 0 ? `change ${describeNames(explicit)}` : '';
  return [changed, saved].filter(Boolean).join(' and ');
}

/**
 * The temporary values of the build, as the Kconfig Manager's export computes them:
 * what differs in the loaded .config from what the configuration files give, plus the
 * managed lines of the target that no longer give the current value. Those that a
 * fragment merged after the target assigns are marked, since that fragment would win.
 */
async function temporaryValues(
  client: PoolClient, fragments: KconfigFragmentInfo, target: SetTarget, explicit: ReadonlySet<string>,
): Promise<KcDriftEntry[]> {
  const res = await client.call<{ ok: boolean; error?: string; drift?: KcDriftEntry[] }>('get_drift', {
    fragments: fragments.files, managed: { path: target.path, lines: readPrjConfManagedRegion(target.path) },
  });
  if (!res.ok) {
    throw new McpToolError('INTERNAL', `The temporary values could not be computed, so nothing was written: ${res.error ?? 'unknown error'}`);
  }
  // An assignment given in the same call wins over the temporary value of its symbol.
  const drift = (res.drift ?? []).filter(entry => !explicit.has(entry.name));
  const later = fragmentsMergedAfter(fragments, target.path, target.kind === 'prj_conf');
  const overrides = findLaterFragmentOverrides(later, drift.filter(entry => entry.managedLine !== 'remove').map(entry => entry.name));
  for (const entry of drift) {
    const by = overrides.get(entry.name);
    if (by) {
      entry.overriddenBy = by;
    }
  }
  return drift;
}

export const setKconfig: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const { assignments, persist, register, dryRun } = checkSetArguments(args);
  const image = await resolveImage(ctx, args);
  const fragments = fragmentsOf(image);
  if (!fragments) {
    throw new McpToolError('BUILD_NOT_CONFIGURED', `No Kconfig fragment list in the build_info.yml of "${image.imageDir}".`, {
      hint: CONFIGURE_HINT,
    });
  }
  const target = resolveSetTarget(args, image, fragments);
  if (register && !target.inBuild) {
    if (image.config.isSysbuild()) {
      // The workbench leaves EXTRA_CONF_FILE out of a sysbuild build's environment so it
      // cannot leak into MCUboot, so a registered fragment would never be merged.
      throw new McpToolError('INVALID_ARGUMENT',
        `${image.config.name} uses sysbuild, and the workbench does not pass EXTRA_CONF_FILE to a sysbuild build, so registering a fragment would have no effect.`, {
          hint: 'Use target "prj_conf" instead.',
        });
    }
  }
  assertNothingRunning(ctx, image, target);
  if (persist) {
    // After a configuration file changed, .config differs from the merge for that
    // reason too, and saving those differences would undo the change.
    const stale = checkFragmentStaleness(image.imageDir, fragments.files);
    if (stale.stale) {
      throw new McpToolError('INVALID_ARGUMENT',
        `persist_temporary cannot tell the temporary values apart, because the configuration files changed since the last configure (${stale.reason}).`, {
          hint: 'Pass the values to keep in assignments instead, or ask the user to export them from the Kconfig Manager, which shows each one.',
        });
    }
  }

  const existing = readText(target.path);
  const currentRegion = planPrjConfUpsert(existing, []).regionLines;
  const regionBefore = new Map(currentRegion
    .map(line => [symbolOf(line), line] as const)
    .filter((entry): entry is readonly [string, string] => !!entry[0]));

  const sim = await withSession(ctx, image, async ({ client }) => {
    const explicitNames = assignments.map(a => a.name);
    // Entries with nothing to write are left out, as the Kconfig Manager export does.
    const temporary = persist
      ? (await temporaryValues(client, fragments, target, new Set(explicitNames)))
        .filter(entry => entry.managedLine === 'remove' || entry.configString)
      : [];
    if (explicitNames.length === 0 && temporary.length === 0) {
      return undefined;
    }
    const names = [...explicitNames, ...temporary.map(entry => entry.name)];
    const found = await client.call<KcFindResult>('find', { names });
    const unknown = Object.entries(found.unknown).filter(([name]) => explicitNames.includes(name));
    if (unknown.length > 0) {
      // Zephyr aborts the configure on an assignment to an undefined symbol.
      throw new McpToolError('INVALID_ARGUMENT',
        `Not defined in this build's Kconfig tree: ${unknown.map(([name]) => `${CONFIG_PREFIX}${name}`).join(', ')}.`, {
          hint: 'Check the spelling against did_you_mean, or call query_kconfig with a pattern to find the right name.',
          details: {
            did_you_mean: Object.fromEntries(unknown.map(([name, list]) => [`${CONFIG_PREFIX}${name}`, list.map(s => `${CONFIG_PREFIX}${s}`)])),
          },
        });
    }
    const choices = explicitNames.filter(name => found.found[name]?.kind === 'choice');
    if (choices.length > 0) {
      throw new McpToolError('INVALID_ARGUMENT',
        `${choices.join(', ')} ${choices.length === 1 ? 'is a choice' : 'are choices'}, which a configuration file cannot assign.`, {
          hint: 'Set the member of the choice you want to y instead; query_kconfig with explain true lists the members.',
        });
    }
    const planned: Planned[] = assignments.map(assignment => {
      const type = found.found[assignment.name].type;
      if (assignment.unset) {
        return { assignment, type };
      }
      const formatted = formatAssignment(assignment.name, type, assignment.value as string | boolean | number);
      return 'error' in formatted ? { assignment, type, rejected: formatted.error } : { assignment, type, formatted };
    });
    // A temporary value is written as kconfiglib spells it in .config, exactly as the
    // Kconfig Manager export writes it, and goes through the same merge check.
    for (const entry of temporary) {
      const remove = entry.managedLine === 'remove';
      planned.push({
        assignment: remove ? { name: entry.name, unset: true } : { name: entry.name, unset: false, value: entry.current },
        type: found.found[entry.name]?.type ?? 'unknown',
        ...(remove ? {} : { formatted: { line: entry.configString, value: entry.current } }),
        temporary: entry,
      });
    }
    const exported = driftExportEdits(temporary);
    const upserts = [
      ...planned.filter(p => p.formatted && !p.temporary).map(p => (p.formatted as FormattedValue).line),
      ...exported.lines,
    ];
    const removals = [
      ...planned.filter(p => p.assignment.unset && !p.temporary).map(p => `${CONFIG_PREFIX}${p.assignment.name}`),
      ...exported.remove.map(name => `${CONFIG_PREFIX}${name}`),
    ];
    const plan = planPrjConfUpsert(existing, upserts, removals);
    const result = await simulate(client, image, fragments, target, planned, plan.text, regionBefore);
    return { ...result, planned, plan, upserts, removals };
  });

  if (!sim) {
    return {
      dry_run: dryRun,
      written: false,
      target: { kind: target.kind, path: target.path, in_build: target.inBuild },
      ...(image.domain ? { domain: image.domain } : {}),
      results: [],
      temporary_values: [],
      managed_region: { path: target.path, lines: currentRegion },
      note: 'There are no temporary values: build/zephyr/.config holds exactly what the configuration files give.',
      next: 'Nothing to save.',
    };
  }

  const blocked = sim.results.filter(r => r.status === 'rejected' || r.status === 'overridden');
  const acceptable = blocked.length === 0 && sim.conflicts.length === 0 && sim.warnings.length === 0;
  const alreadyListed = target.kind === 'fragment' && isInExtraConfFiles(image.config.envVars, target.path);
  const needsRegistration = register && !target.inBuild && !alreadyListed;
  const willWrite = acceptable && (sim.plan.changed || needsRegistration);
  const stale = checkFragmentStaleness(image.imageDir, fragments.files);
  const outsideConflicts = sim.plan.outsideAssignments.map(a => ({ symbol: a.symbol, line: a.line, after_region: a.afterRegion }));

  const out = (written: boolean, registered?: boolean, extra: Record<string, unknown> = {}) => ({
    dry_run: dryRun,
    written,
    ...(dryRun ? { would_write: willWrite } : {}),
    target: {
      kind: target.kind,
      path: target.path,
      in_build: target.inBuild,
      ...(target.kind === 'fragment' ? { registered: registered ?? alreadyListed } : {}),
    },
    ...(image.domain ? { domain: image.domain } : {}),
    results: sim.results.map((result, index) => (sim.planned[index].temporary ? { ...result, temporary: true } : result)),
    ...(persist ? {
      temporary_values: sim.planned.filter(p => p.temporary).map(p => {
        const entry = p.temporary as KcDriftEntry;
        return {
          symbol: `${CONFIG_PREFIX}${entry.name}`,
          value: entry.current,
          configuration_files_give: entry.baseline,
          ...(entry.managedLine === 'remove' ? { action: 'remove_managed_line' } : { line: entry.configString }),
          ...(entry.overriddenBy ? { overridden_by: entry.overriddenBy } : {}),
        };
      }),
    } : {}),
    ...(sim.conflicts.length ? { conflicts: sim.conflicts } : {}),
    ...(sim.warnings.length ? { merge_warnings: sim.warnings } : {}),
    // What the region holds once this call returns, and what it would hold otherwise.
    managed_region: { path: target.path, lines: written ? sim.plan.regionLines : currentRegion },
    ...(!written && sim.plan.changed ? { proposed_region: sim.plan.regionLines } : {}),
    ...(outsideConflicts.length ? { outside_conflicts: outsideConflicts } : {}),
    side_effects: sim.check.sideEffects.map(e => ({ symbol: `${CONFIG_PREFIX}${e.name}`, from: e.from, to: e.to })),
    ...(sim.check.sideEffectsTotal > sim.check.sideEffects.length ? { side_effects_total: sim.check.sideEffectsTotal } : {}),
    discarded_on_next_build: sim.check.discarded.map(e => ({ symbol: `${CONFIG_PREFIX}${e.name}`, current: e.current, after_merge: e.afterMerge })),
    ...(stale.stale ? { stale_before: { reason: stale.reason } } : {}),
    ...extra,
  });

  if (!acceptable) {
    return out(false, undefined, {
      note: 'Nothing was written: every assignment must pass for any of them to be written.',
      next: 'Fix what results, conflicts and merge_warnings report, then call set_kconfig again.',
    });
  }
  const notInBuild = target.kind === 'fragment' && !target.inBuild && !register && !alreadyListed
    ? {
      in_build_note: image.config.isSysbuild()
        // register_fragment is refused for sysbuild, so do not suggest it.
        ? 'This fragment is not part of the build, and a sysbuild configuration does not pass EXTRA_CONF_FILE to its images, so the change has no effect. Use target "prj_conf" instead.'
        : 'This fragment is not part of the build, so the change has no effect until it is added to EXTRA_CONF_FILE. Repeat with register_fragment true to add it.',
    }
    : {};
  if (dryRun) {
    return out(false, undefined, { ...notInBuild, next: willWrite ? 'Repeat without dry_run to write the change.' : 'Nothing would change.' });
  }
  if (!willWrite) {
    return out(false, undefined, { ...notInBuild, note: 'Every value is already set this way, so nothing was written.' });
  }

  const subject: ConfirmSubject & { file: string; lines: string[]; removed: string[]; register: boolean } = {
    summary: `${describeChange(sim.planned)} in ${target.path}${needsRegistration ? ' and add that file to EXTRA_CONF_FILE' : ''}`,
    appPath: image.app.appRootPath,
    configName: image.config.name,
    board: image.config.boardIdentifier,
    scope: image.app.appRootPath,
    // Not shown: these make the confirmation's fingerprint cover exactly this change,
    // so an Allow given late for one change is not used by a different one.
    file: target.path,
    lines: sim.upserts,
    removed: sim.removals,
    register: needsRegistration,
  };
  await ctx.deps.confirmations.require(ctx, args, subject);

  // The dialog can stay open for a while: whatever started meanwhile still wins.
  assertNothingRunning(ctx, image, target);
  if (readText(target.path) !== existing) {
    throw new McpToolError('BUSY_EXTERNAL', `${target.path} changed while the change was being checked, so nothing was written.`, {
      hint: 'Repeat the call; it checks the file again.',
    });
  }

  let written = false;
  if (sim.plan.changed) {
    try {
      upsertPrjConfManagedRegion(target.path, sim.upserts, sim.removals);
    } catch (error) {
      throw new McpToolError('INTERNAL', `Could not write ${target.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    written = true;
  }
  let registered: boolean | undefined;
  let registrationError: string | undefined;
  if (needsRegistration) {
    try {
      // Checked again as it is stored, like every entry configure adds: the value reaches
      // the build's command line.
      assertEnvListElement(target.path, 'fragment_path');
      await registerFragment(ctx, image, target.path);
      registered = true;
    } catch (error) {
      registered = false;
      registrationError = error instanceof Error ? error.message : String(error);
    }
  }
  return out(written, registered, {
    ...(registrationError ? { registration_error: `The file was written, but adding it to EXTRA_CONF_FILE failed: ${registrationError}` } : {}),
    ...(target.kind === 'fragment' && !target.inBuild && !registered && !alreadyListed ? notInBuild : {}),
    next: 'Call build_app to apply the change.',
  });
};
