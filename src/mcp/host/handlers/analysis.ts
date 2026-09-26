// analyze: DT Doctor, hardenconfig, SPDX and ECLAIR runs of a build configuration.
//
// Each analysis is a west build variant or build target, so each runs as a job
// of kind 'build' on the configuration's build folder, exactly like build_app:
// the same refusals while the user builds or an agent deletes that folder, the
// same launch guard for the user's own tasks, and the Kconfig sessions stopped
// first when the folder is deleted. Steps run in visible captured terminals,
// and the job's result carries what the analysis found.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from '../../../constants';
import type { WestWorkspace } from '../../../models/WestWorkspace';
import type { ZephyrApplication } from '../../../models/ZephyrApplication';
import type { ZephyrBuildConfig } from '../../../models/ZephyrBuildConfig';
import { local_checkout_revs, looks_like_sha, PresetRepositories } from '../../../panels/EclairManagerPanel/repo_manage';
import { buildDirectTask, createCppPropertiesCompileCommandsRefresh } from '../../../providers/ZephyrTaskProvider';
import { buildWestProjectTask } from '../../../commands/WestCommands';
import {
  eclairOutputDir, EclairProbe, loadAppEclairScaConfig, prepareEclairRun, probeEclair, resolveEclairSdkDir, writeEclairRunFiles,
} from '../../../utils/eclair/analysis';
import { ALL_ECLAIR_REPORTS, EclairRepos, EclairScaConfig } from '../../../utils/eclair/config';
import { buildEnvSourcedShellTask, getConfiguredVenvPath } from '../../../utils/execUtils';
import { removeDirectory } from '../../../utils/utils';
import { resolveBuildDirToDelete } from '../../../utils/zephyr/buildConfigRules';
import { runSpdxPipeline, SpdxPipelineError, SpdxStep, SpdxVersion } from '../../../utils/zephyr/spdxPipeline';
import { isInside } from '../../core/argSafety';
import { checkBuildDirDeletion } from '../../core/buildDirFence';
import { McpToolError, toToolError } from '../../core/errors';
import { redactCommandLine } from '../../core/redact';
import { countByRule, readSarif } from '../../core/sarifReader';
import { ToolContext, ToolHandler } from '../../core/toolSpec';
import { parseDtDoctor } from '../../jobs/dtdoctorParser';
import { parseHardenconfig } from '../../jobs/hardenconfigParser';
import { JobRunResult, JobSink, JobView } from '../../jobs/jobManager';
import { findExternalRun } from '../buildConflicts';
import { runCapturedTask } from '../taskRunner';
import { persistBuildState, REVEAL } from './actions';
import { HostDeps } from './deps';
import { progressWait, remainingWaitMs } from './progress';

type Ctx = ToolContext<HostDeps>;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

const ANALYSES = ['dt_doctor', 'hardenconfig', 'spdx', 'eclair'] as const;
type Analysis = typeof ANALYSES[number];

/** The arguments each analysis takes besides analysis, app_path, config_name and wait_sec. */
const OWN_ARGUMENTS: Record<Analysis, readonly string[]> = {
  dt_doctor: [],
  hardenconfig: [],
  spdx: ['spdx_version', 'include_sdk'],
  eclair: ['sca_config', 'ruleset', 'reports'],
};

const RULESETS = [
  'ECLAIR_RULESET_FIRST_ANALYSIS', 'ECLAIR_RULESET_STU', 'ECLAIR_RULESET_STU_HEAVY', 'ECLAIR_RULESET_WP',
  'ECLAIR_RULESET_STD_LIB', 'ECLAIR_RULESET_ZEPHYR_GUIDELINES',
];

/** Output kept for the parsers: the end of it, which is where a failing build stops. */
const MAX_KEPT_OUTPUT = 4 * 1024 * 1024;
/** Characters of the ECLAIR summary returned. */
const MAX_SUMMARY_CHARS = 6000;
/** Rules listed with their counts in the ECLAIR result. */
const MAX_RULES = 50;

const PRISTINE_HINT = 'call build_app with pristine "always" before the next normal build, since this analysis stays switched on in the build folder until then';

function invalid(message: string, hint?: string, details?: Record<string, unknown>): McpToolError {
  return new McpToolError('INVALID_ARGUMENT', message, { hint, details });
}

/** Refuse arguments of another analysis and values of the wrong shape, before anything is resolved. */
function checkArguments(args: Record<string, unknown>): Analysis {
  const analysis = str(args.analysis) as Analysis | undefined;
  if (!analysis || !ANALYSES.includes(analysis)) {
    throw invalid(`analysis must be one of ${ANALYSES.join(', ')}.`);
  }
  for (const other of ANALYSES) {
    for (const key of OWN_ARGUMENTS[other]) {
      if (other !== analysis && args[key] !== undefined) {
        throw invalid(`${key} only applies to analysis "${other}".`, `Call analyze again without ${key}.`);
      }
    }
  }
  for (const key of ['app_path', 'config_name', 'sca_config']) {
    if (args[key] !== undefined && typeof args[key] !== 'string') {
      throw invalid(`${key} must be a string.`);
    }
  }
  if (args.include_sdk !== undefined && typeof args.include_sdk !== 'boolean') {
    throw invalid('include_sdk must be true or false.');
  }
  if (args.spdx_version !== undefined && !['auto', '2.3', '3.0'].includes(String(args.spdx_version))) {
    throw invalid('spdx_version must be auto, 2.3 or 3.0.');
  }
  if (analysis === 'eclair') {
    const scaConfig = str(args.sca_config);
    const ruleset = args.ruleset;
    if (scaConfig !== undefined && ruleset !== undefined) {
      throw invalid('Pass either sca_config or ruleset, not both.');
    }
    if (ruleset !== undefined && !RULESETS.includes(String(ruleset))) {
      throw invalid(`ruleset must be one of ${RULESETS.join(', ')}.`);
    }
    if (args.reports !== undefined) {
      if (scaConfig !== undefined) {
        throw invalid('reports only goes with ruleset: a saved ECLAIR configuration names its own reports.');
      }
      const reports = args.reports;
      const valid = [...ALL_ECLAIR_REPORTS, 'ALL'];
      if (!Array.isArray(reports) || reports.some(report => typeof report !== 'string' || !valid.includes(report))) {
        throw invalid('reports must list ECLAIR report names.', undefined, { valid: valid });
      }
    }
  }
  return analysis;
}

/** Keeps the end of what a job's steps print, and passes everything on to the job. */
function keepOutput(sink: JobSink): { sink: JobSink; text(): string } {
  let kept = '';
  return {
    sink: {
      onData: chunk => {
        kept = (kept + chunk).slice(-MAX_KEPT_OUTPUT);
        sink.onData(chunk);
      },
    },
    text: () => kept,
  };
}

/**
 * Where the analyses get their tasks and how a job runs them: the workbench
 * task builders and the captured task runner. Unit tests, which have no VS
 * Code task system, replace them.
 */
export const analysisTasks = {
  direct: (app: ZephyrApplication, config: ZephyrBuildConfig, taskName: string): vscode.Task | undefined =>
    buildDirectTask(app.appWorkspaceFolder, taskName, config.name, {}, app),
  project: buildWestProjectTask,
  shell: buildEnvSourcedShellTask,
  run: runCapturedTask,
};

/** A task of the workbench task table for this configuration, as the Applications view runs it. */
function directTask(app: ZephyrApplication, config: ZephyrBuildConfig, taskName: string): vscode.Task {
  let task: vscode.Task | undefined;
  try {
    task = analysisTasks.direct(app, config, taskName);
  } catch (error) {
    // A missing environment script or an unlinked west workspace application.
    throw toToolError(error);
  }
  if (!task) {
    throw invalid(`Cannot run "${taskName}" for "${config.name}".`,
      'Check with list_apps that the configuration has a board, then retry.');
  }
  return task;
}

function commandOf(task: vscode.Task, fallback: string): string {
  return redactCommandLine((task.execution as vscode.ShellExecution | undefined)?.commandLine ?? fallback);
}

/** What one analysis runs, planned and checked before its job starts. */
interface AnalysisPlan {
  /** Identifies the request, so an identical one attaches to the running job. */
  variant: string;
  command: string;
  run(sink: JobSink, signal: AbortSignal): Promise<JobRunResult>;
  next(view: JobView): string;
}

interface Target {
  app: ZephyrApplication;
  config: ZephyrBuildConfig;
  buildDir: string;
}

async function westWorkspaceOf(ctx: Ctx, app: ZephyrApplication): Promise<WestWorkspace> {
  return (await ctx.deps.services.resolveWestWorkspace(undefined, app.appRootPath)).workspace;
}

function header(ctx: Ctx, what: string, config: ZephyrBuildConfig): string {
  return `> [agent ${ctx.client.name ?? 'mcp'}] ${what} [${config.name}]`;
}

/**
 * Run a captured task of the job, recording the west build state as the
 * UI's task runner does, but only for a run that really started.
 */
async function runTask(ctx: Ctx, task: vscode.Task, sink: JobSink, signal: AbortSignal, title: string): Promise<number | undefined> {
  const { exitCode, started } = await analysisTasks.run(task, sink, signal, {
    reveal: REVEAL[ctx.deps.revealTerminal] ?? vscode.TaskRevealKind.Silent,
    header: title,
  });
  if (started) {
    persistBuildState(task.definition);
  }
  return exitCode;
}

// -- DT Doctor ------------------------------------------------------------------

async function planDtDoctor(ctx: Ctx, { app, config }: Target): Promise<AnalysisPlan> {
  const workspace = await westWorkspaceOf(ctx, app);
  if (!fs.existsSync(path.join(workspace.kernelUri.fsPath, 'cmake', 'sca', 'dtdoctor'))) {
    throw invalid(`DT Doctor is not part of Zephyr ${workspace.version} in ${workspace.rootUri.fsPath}: it has no cmake/sca/dtdoctor.`,
      'DT Doctor needs a newer Zephyr. Read devicetree errors from build_app, or with get_diagnostics, instead.',
      { zephyr_version: workspace.version });
  }
  const task = directTask(app, config, 'DT Doctor');
  return {
    variant: 'dtdoctor',
    command: commandOf(task, 'DT Doctor'),
    run: async (sink, signal) => {
      const output = keepOutput(sink);
      const exitCode = await runTask(ctx, task, output.sink, signal, header(ctx, 'DT Doctor', config));
      const findings = parseDtDoctor(output.text());
      return { exitCode, extra: { analysis: 'dt_doctor', sca_variant: 'dtdoctor', findings_count: findings.length, findings } };
    },
    next: view => {
      const findings = (view.result?.findings as unknown[] | undefined)?.length ?? 0;
      const first = findings > 0
        ? 'Fix what result.findings says (enable the node in an overlay, or set the Kconfig options with set_kconfig), then build again'
        : view.status === 'succeeded'
          ? 'The build passed and DT Doctor diagnosed nothing'
          : 'DT Doctor diagnosed nothing; read the diagnostics, or call job with action "log" for the full output';
      return `${first}. DT Doctor wraps every compile of this build folder until a pristine build: ${PRISTINE_HINT}.`;
    },
  };
}

// -- hardenconfig ---------------------------------------------------------------

function planHardenconfig(ctx: Ctx, { app, config }: Target): AnalysisPlan {
  const task = directTask(app, config, 'Harden Config');
  return {
    variant: 'hardenconfig',
    command: commandOf(task, 'Harden Config'),
    run: async (sink, signal) => {
      const output = keepOutput(sink);
      const exitCode = await runTask(ctx, task, output.sink, signal, header(ctx, 'Harden Config', config));
      const rows = parseHardenconfig(output.text());
      return { exitCode, extra: { analysis: 'hardenconfig', differing: rows.length, rows } };
    },
    next: view => {
      if (view.status !== 'succeeded') {
        return 'hardenconfig did not finish. Read the diagnostics, fix the build, and call analyze again.';
      }
      return (view.result?.rows as unknown[] | undefined)?.length
        ? 'Each row is an option whose value differs from Zephyr\'s hardening recommendation. Apply the ones you accept with set_kconfig (symbol and the recommended value), then call build_app.'
        : 'Every option hardenconfig checks already has its recommended value.';
    },
  };
}

// -- SPDX -------------------------------------------------------------------------

/** Refuse while the Kconfig Manager or an agent Kconfig call keeps files open in the folder to delete. */
function assertNoKconfigInside(ctx: Ctx, folder: string): void {
  const editor = ctx.deps.services.kconfigEditors().find(candidate => isInside(candidate.buildDir, folder));
  if (editor) {
    throw new McpToolError('BUSY_EXTERNAL', `The Kconfig Manager is open on ${editor.configName}, and its Kconfig server runs inside "${folder}", which the SPDX run deletes first.`, {
      hint: editor.dirty
        ? `Ask the user to save or discard the changes in the Kconfig Manager tab of ${editor.configName} and close it, then retry.`
        : `Ask the user to close the Kconfig Manager tab of ${editor.configName}, then retry.`,
      details: { editor: 'kconfig_manager', config_name: editor.configName, unsaved: editor.dirty },
    });
  }
  const querying = ctx.deps.kconfig.inUseWithin(folder)[0];
  if (querying) {
    throw new McpToolError('BUSY', `A query_kconfig or set_kconfig call is reading the Kconfig tree of "${querying}".`, {
      hint: 'Retry once it has answered.',
    });
  }
}

function spdxDocuments(spdxDir: string): { name: string; path: string; bytes: number }[] {
  try {
    return fs.readdirSync(spdxDir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => {
        const file = path.join(spdxDir, entry.name);
        return { name: entry.name, path: file, bytes: fs.statSync(file).size };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

async function planSpdx(ctx: Ctx, args: Record<string, unknown>, { app, config }: Target): Promise<AnalysisPlan> {
  const workspace = await westWorkspaceOf(ctx, app);
  const requested = str(args.spdx_version) ?? 'auto';
  if (requested === '3.0' && !workspace.supportsSpdx3) {
    throw invalid(`SPDX 3.0 needs Zephyr 4.5.0 or newer; this west workspace has Zephyr ${workspace.version}.`,
      'Call analyze again with spdx_version "2.3", or "auto".', { zephyr_version: workspace.version });
  }
  const version: SpdxVersion = requested === 'auto' ? (workspace.supportsSpdx3 ? '3.0' : '2.3') : requested as SpdxVersion;
  const includeSdk = typeof args.include_sdk === 'boolean'
    ? args.include_sdk
    : vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get<boolean>('sbomTotal.includeSdk', false) === true;

  let folder: string;
  try {
    folder = resolveBuildDirToDelete(app.appRootPath, config.name);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error), 'Rename the configuration with configure, then retry.');
  }
  const roots = await ctx.deps.services.knownRoots();
  const fence = () => checkBuildDirDeletion({
    appRootPath: app.appRootPath, target: folder, configNames: app.buildConfigs.map(candidate => candidate.name), knownRoots: roots,
  });
  fence();
  assertNoKconfigInside(ctx, folder);

  // Tried now, so a configuration that cannot build is refused before anything is deleted.
  const taskOf = (step: SpdxStep): vscode.Task => {
    const task = analysisTasks.project(app, step.spec);
    if (!task) {
      throw new Error(`No "${step.spec.name}" task for ${config.name}.`);
    }
    return task;
  };
  try {
    taskOf({ kind: 'init', spec: { name: 'SPDX init', configName: config.name, options: {} } });
  } catch (error) {
    throw toToolError(error);
  }

  return {
    variant: `spdx:${version}:${includeSdk}`,
    command: `delete ${folder} && west spdx --init && west build -- -DCONFIG_BUILD_OUTPUT_META=y && west spdx${version === '3.0' ? ' --spdx-version 3.0' : ''}${includeSdk ? ' --include-sdk' : ''}`,
    run: async (sink, signal) => {
      let lastCode: number | undefined;
      const runStep = async (step: SpdxStep): Promise<number | undefined> => {
        const task = taskOf(step);
        // The build step keeps IntelliSense in step as westBuildCommand does: the
        // refresher is taken before the build, since it acts only when the build
        // creates compile_commands.json.
        const noRefresh = async () => undefined;
        const refreshCppProperties = step.kind !== 'build' || app.intellisenseProvider === 'clangd'
          ? noRefresh
          : await createCppPropertiesCompileCommandsRefresh(app.appWorkspaceFolder).catch(() => noRefresh);
        const code = await runTask(ctx, task, sink, signal, header(ctx, step.spec.name, config));
        await refreshCppProperties().catch(error => {
          sink.onData(`\nIntelliSense was not refreshed: ${error instanceof Error ? error.message : String(error)}\n`);
        });
        if (code === undefined) {
          throw new Error(`"${step.spec.name}" was cancelled or did not start.`);
        }
        lastCode = code;
        return code;
      };
      const deleteBuildDir = async (dir: string) => {
        // Checked again as it is deleted: the folder may have changed since the call.
        fence();
        sink.onData(`Deleting ${dir}\n`);
        if (await removeDirectory(dir) === 'busy') {
          throw new Error(`Some files in ${dir} are in use, so it was not fully deleted. Close any terminal, debug session or menuconfig using it, then retry.`);
        }
      };
      // As for a pristine build_app: the agent Kconfig sessions in the folder are
      // stopped before it is deleted, and none may start there until the run ends.
      const reopenKconfig = await ctx.deps.kconfig.closeWithin(folder);
      try {
        const outcome = await runSpdxPipeline(app, config, version, runStep, { deleteScope: 'config', includeSdk, deleteBuildDir });
        if (!outcome.ok) {
          return { exitCode: outcome.exitCode, extra: { analysis: 'spdx', spdx_version: version, failed_step: 'build' } };
        }
        const documents = spdxDocuments(outcome.spdxDir);
        return {
          exitCode: 0,
          extra: { analysis: 'spdx', spdx_version: version, include_sdk: includeSdk, spdx_dir: outcome.spdxDir, documents },
        };
      } catch (error) {
        const reason = error instanceof SpdxPipelineError ? error.reason : error;
        sink.onData(`\n${reason instanceof Error ? reason.message : String(reason)}\n`);
        return { exitCode: lastCode && lastCode !== 0 ? lastCode : 1, extra: { analysis: 'spdx', spdx_version: version } };
      } finally {
        reopenKconfig();
      }
    },
    next: view => (view.status === 'succeeded'
      ? `The SPDX ${version} documents are in result.spdx_dir; read them with your own file tools. The build folder was rebuilt from scratch with CONFIG_BUILD_OUTPUT_META.`
      : 'The SPDX run failed. Read the diagnostics and the log, fix the build, and call analyze again.'),
  };
}

// -- ECLAIR -----------------------------------------------------------------------

function assertEclairReady(probe: EclairProbe): string {
  if (!probe.dir) {
    throw new McpToolError('DEPENDENCY_MISSING', 'ECLAIR is not installed on this machine: env.yml records no ECLAIR folder and eclair is not on PATH.', {
      hint: 'ECLAIR is a licensed BUGSENG tool. Ask the user to install it and set its folder in the ECLAIR Manager, then retry.',
    });
  }
  const missing = [probe.eclairEnv ? undefined : 'eclair_env', probe.eclairReport ? undefined : 'eclair_report'].filter(Boolean);
  if (missing.length > 0) {
    throw new McpToolError('ENV_NOT_READY', `The ECLAIR folder ${probe.dir} has no ${missing.join(' or ')}, which the Zephyr ECLAIR integration needs.`, {
      hint: 'Ask the user to check the ECLAIR installation and the folder set in the ECLAIR Manager, then retry.',
      details: { eclair_dir: probe.dir },
    });
  }
  return probe.dir;
}

/**
 * The revision of each preset repository, from what is already checked out on
 * this machine: a locked revision, a ref that is a commit, else the checkout
 * most recently known to be what the configured ref names, because the ECLAIR
 * Manager resolved the ref to it or git fetched it for that ref. Never asks a
 * git server, unlike the ECLAIR Manager, so a repository with no such checkout
 * is left out, and loading a preset from it fails.
 */
async function localRepoRevs(repos: EclairRepos): Promise<Record<string, string>> {
  const revs: Record<string, string> = {};
  for (const [name, entry] of Object.entries(repos)) {
    const rev = entry.rev ?? (looks_like_sha(entry.ref) ? entry.ref.trim() : local_checkout_revs(entry.origin, entry.ref)[0]);
    if (rev) {
      revs[name] = rev;
    }
  }
  return revs;
}

/** A folder of this build's own for the files a run generates, kept for later reconfigures. */
function eclairRunDir(buildDir: string): string {
  const key = createHash('sha256').update(path.resolve(buildDir)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'zephyr-workbench-eclair', key);
}

function readSummary(file: string): string | undefined {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS)}\n...` : text;
  } catch {
    return undefined;
  }
}

async function planEclair(ctx: Ctx, args: Record<string, unknown>, { app, config, buildDir }: Target): Promise<AnalysisPlan> {
  const scaName = str(args.sca_config);
  const ruleset = str(args.ruleset);
  if (!scaName && !ruleset) {
    throw invalid('analysis "eclair" needs sca_config, the name of a saved ECLAIR configuration, or ruleset.',
      'Pass ruleset, for example ECLAIR_RULESET_FIRST_ANALYSIS, or a saved configuration name.', { rulesets: RULESETS });
  }
  const eclairDir = assertEclairReady(probeEclair());

  let scaConfig: EclairScaConfig;
  let repos: EclairRepos = {};
  if (scaName) {
    const loaded = await loadAppEclairScaConfig(app, () => undefined);
    if ('err' in loaded) {
      throw new McpToolError('INTERNAL', loaded.err);
    }
    const found = loaded.ok.configs.find(candidate => candidate.name === scaName);
    if (!found) {
      const names = loaded.ok.configs.map(candidate => candidate.name);
      throw invalid(`The application has no saved ECLAIR configuration "${scaName}".`,
        names.length > 0
          ? 'Use one of the names in details.saved, or pass ruleset instead.'
          : 'None is saved for this application: pass ruleset instead, or ask the user to save one in the ECLAIR Manager.',
        { saved: names });
    }
    scaConfig = found;
    repos = loaded.ok.repos ?? {};
  } else {
    const extra = Array.isArray(args.reports) ? (args.reports as string[]) : [];
    scaConfig = { name: ruleset as string, main_config: { type: 'zephyr-ruleset', ruleset: ruleset as string }, reports: extra };
  }
  // The findings are read back from SARIF, so it is always produced.
  const reports = scaConfig.reports ?? [];
  if (!reports.includes('ALL') && !reports.includes('ECLAIR_REPORTS_SARIF')) {
    scaConfig = { ...scaConfig, reports: [...reports, 'ECLAIR_REPORTS_SARIF'] };
  }

  const westTopDir = app.westWorkspaceRootPath;
  if (!westTopDir || !fs.existsSync(path.join(westTopDir, '.west'))) {
    throw new McpToolError('ENV_NOT_READY', `The west workspace of ${app.appName} (${westTopDir || 'none'}) was not found.`, {
      hint: 'Call get_status to see the west workspaces, and link the application to one with configure.',
    });
  }
  if (!config.boardIdentifier) {
    throw invalid(`${config.name} has no board.`, 'Set one with configure, then retry.');
  }

  // Refused before the presets load: a job working in the build folder keeps
  // this run from starting.
  const running = ctx.deps.jobs.runningOverlapping(buildDir)[0];
  if (running) {
    throw new McpToolError('BUSY', `A ${running.spec.kind} job is working in "${running.spec.buildDir}" (job_id "${running.id}").`, {
      hint: `Wait for it with job {"action": "status", "job_id": "${running.id}"}, then call analyze again.`,
      details: { job_id: running.id, kind: running.spec.kind },
    });
  }
  const runDir = eclairRunDir(buildDir);
  const presetRepos = new PresetRepositories(() => undefined, () => undefined);
  const usedRevs: Record<string, string> = {};
  let plan;
  try {
    plan = await prepareEclairRun({
      config: scaConfig,
      target: { appDir: app.appRootPath, buildDir, board: config.boardIdentifier, westTopDir },
      projectRootDir: app.appRootPath,
      eclairDir,
      sdkDir: resolveEclairSdkDir(app.zephyrSdkPath || undefined),
      tmpDir: runDir,
      presets: {
        repos,
        resolveRepoRevs: async wanted => Object.assign(usedRevs, await localRepoRevs(wanted)),
        loadPreset: (source, revs) => presetRepos.load_preset_no_checkout(app.appWorkspaceFolder.uri.toString(), source, repos, revs),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new McpToolError('ENV_NOT_READY', `The ECLAIR configuration "${scaConfig.name}" cannot be prepared: ${message}`, {
      hint: /preset/i.test(message)
        ? 'Its preset repositories are not checked out on this machine for the ref the configuration names. Call open_in_workbench with target "eclair_manager" so the user opens the ECLAIR Manager, which fetches them and resolves their refs (saving the configuration there also locks their revision), then retry.'
        : 'Ask the user to check the configuration in the ECLAIR Manager, then retry.',
    });
  }
  const { command, env, cwd, files } = plan;
  let task: vscode.Task;
  try {
    task = analysisTasks.shell('ECLAIR Analysis', command, { cwd, env });
  } catch (error) {
    throw toToolError(error);
  }

  const scaDir = eclairOutputDir(buildDir);
  const sarifPath = path.join(scaDir, 'reports.sarif');
  return {
    variant: `eclair:${scaName ? `config:${scaName}` : `ruleset:${ruleset}`}:${(scaConfig.reports ?? []).join(',')}`,
    command: redactCommandLine(command),
    run: async (sink, signal) => {
      const extra: Record<string, unknown> = {
        analysis: 'eclair',
        ...(scaName ? { sca_config: scaName } : { ruleset }),
        sca_dir: scaDir,
        ...(Object.keys(usedRevs).length ? { preset_revisions: usedRevs } : {}),
      };
      // Written only now that the job holds the build folder: the CMake cache of
      // an earlier analysis keeps naming these files, so a call refused on the
      // way must leave them as they are.
      try {
        writeEclairRunFiles(files);
      } catch (error) {
        sink.onData(`\nThe ECLAIR run files could not be written in ${runDir}: ${error instanceof Error ? error.message : String(error)}\n`);
        return { exitCode: 1, extra };
      }
      // --pristine deletes the build folder first, where an agent Kconfig session may keep files open.
      const reopenKconfig = await ctx.deps.kconfig.closeWithin(buildDir);
      let exitCode: number | undefined;
      try {
        exitCode = await runTask(ctx, task, sink, signal, header(ctx, 'ECLAIR Analysis', config));
      } finally {
        reopenKconfig();
      }
      const summary = readSummary(path.join(scaDir, 'summary_overall.txt'));
      if (summary !== undefined) {
        extra.summary = summary;
      }
      if (fs.existsSync(sarifPath)) {
        extra.sarif_path = sarifPath;
        try {
          const { findings } = readSarif(fs.readFileSync(sarifPath, 'utf8'));
          const byRule = countByRule(findings);
          extra.findings = {
            total: findings.length,
            errors: findings.filter(finding => finding.severity === 'error').length,
            warnings: findings.filter(finding => finding.severity === 'warning').length,
            by_rule: byRule.slice(0, MAX_RULES),
            ...(byRule.length > MAX_RULES ? { rules_total: byRule.length } : {}),
          };
        } catch (error) {
          extra.sarif_error = error instanceof Error ? error.message : String(error);
        }
      }
      return { exitCode, extra };
    },
    next: view => (view.result?.sarif_path
      ? `Call get_diagnostics with source "sca" to page through the findings, filtered by rule or path_prefix. ECLAIR wraps every compile of this build folder until a pristine build: ${PRISTINE_HINT}.`
      : `The analysis wrote no SARIF report. Read the diagnostics and call job with action "log" for the full output, fix what failed, and call analyze again. Then ${PRISTINE_HINT}.`),
  };
}

// -- the tool -----------------------------------------------------------------------

export const analyze: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const { services, jobs, defaultWaitSeconds } = ctx.deps;
  const analysis = checkArguments(args);
  const waitSec = num(args.wait_sec) ?? defaultWaitSeconds;
  const target = await services.resolveTarget(str(args.app_path), str(args.config_name));
  const { app, config, buildDir } = target;
  ctx.audit.target = { app_path: app.appRootPath, config_name: config.name };

  // The same refusals as build_app: the user's own task on this configuration,
  // and an agent deletion covering its folder.
  const external = findExternalRun(app.appRootPath, config.name);
  if (external) {
    throw new McpToolError('BUSY_EXTERNAL', `"${external.task.name}" is already running for ${config.name}, started from VS Code.`, {
      hint: 'Wait for it to finish in its terminal, then call analyze again.',
    });
  }
  const deleting = jobs.runningOverlapping(buildDir).find(running => running.spec.kind === 'clean');
  if (deleting) {
    throw new McpToolError('BUSY', `The build folder of ${config.name} is being deleted (job_id "${deleting.id}").`, {
      hint: `Wait for it with job {"action": "status", "job_id": "${deleting.id}"}, then call analyze again.`,
      details: { job_id: deleting.id, kind: deleting.spec.kind },
    });
  }

  const plan = analysis === 'dt_doctor' ? await planDtDoctor(ctx, target)
    : analysis === 'hardenconfig' ? planHardenconfig(ctx, target)
      : analysis === 'spdx' ? await planSpdx(ctx, args, target)
        : await planEclair(ctx, args, target);

  // The venv the build activates, with the precedence ZephyrTaskProvider.resolve uses.
  const venvPath = app.venvPath ?? getConfiguredVenvPath(app.appWorkspaceFolder);
  const { job, attached } = jobs.start({
    kind: 'build',
    lockKey: buildDir,
    requestKey: `analyze:${buildDir}:${plan.variant}`,
    appPath: app.appRootPath,
    configName: config.name,
    buildDir,
    ...(app.westWorkspaceRootPath ? { westWorkspace: app.westWorkspaceRootPath } : {}),
    ...(venvPath ? { venvPath } : {}),
    command: plan.command,
    run: (sink, signal) => plan.run(sink, signal),
    next: plan.next,
  });
  ctx.audit.jobId = job.id;
  await jobs.wait(job, remainingWaitMs(ctx, waitSec), progressWait(ctx, jobs));
  return jobs.view(job, { attached });
};
