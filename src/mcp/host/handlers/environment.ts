// The environment check. Read-only on purpose: it never installs anything,
// never writes a setting or env.yml, and never opens a dialog. It reports what
// is missing and names the Zephyr Workbench command that fixes it, because the
// fix is the user's to run.
//
// Everything that spawns is bounded: each probe by PROBE_TIMEOUT_MS and the
// whole call by TOTAL_BUDGET_MS, which keeps it under the 60 second timeout
// most agents apply. A probe that runs out of time becomes a note, not an error.

import * as path from 'path';
import { ZephyrApplication } from '../../../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../../../models/ZephyrBuildConfig';
import { GlobalZephyrSdkInstallation } from '../../../models/ToolchainInstallations';
import { resolveBuildVenv } from '../../../utils/env/venvResolution';
import { collectEnvironmentSettings, EnvironmentSettingsStatus, HostToolsStatus } from '../../../utils/hostToolsStatusCollector';
import {
  PYTHON_MIN_RECOMMENDED,
  probePythonInterpreter,
  probeWestVersion,
  PythonProbeResult,
  WestVersionProbeResult,
} from '../../../utils/hostToolsStatusUtils';
import { getInternalZephyrSdkInstallation, getWestWorkspace } from '../../../utils/utils';
import { checkSdkCompatibility, formatSdkCompatMessage } from '../../../utils/zephyr/sdkCompatUtils';
import { ParsedRunnersYaml, readRunnersYamlForProject } from '../../../utils/zephyr/runnersYamlUtils';
import { DebugToolStatus } from '../../../utils/debugTools/debugToolStatusUtils';
import {
  findDebugToolIdsForRunner,
  listDebugToolSelectors,
  resolveDebugToolSelectors,
} from '../../../utils/debugTools/debugToolManifestUtils';
import { DebugToolsManifest } from '../../../utils/debugTools/debugToolVersionUtils';
import { assertRunnerName, normalizeForCompare } from '../../core/argSafety';
import {
  ApplicationToolchain,
  deriveEnvironmentProblems,
  EnvironmentFacts,
  environmentNextSteps,
  isEnvironmentReady,
} from '../../core/environmentReport';
import { McpToolError } from '../../core/errors';
import { ToolContext, ToolHandler } from '../../core/toolSpec';
import { probePyserial } from '../serial/helper';
import { HostDeps } from './deps';

type Ctx = ToolContext<HostDeps>;

export const ENVIRONMENT_SECTIONS = ['host_tools', 'settings', 'python', 'west', 'sdks', 'debug_tools'] as const;
type Section = typeof ENVIRONMENT_SECTIONS[number];

/** One spawned probe. */
export const PROBE_TIMEOUT_MS = 15000;
/** The whole call, leaving room under the 60 second timeout most agents use. */
export const TOTAL_BUDGET_MS = 40000;
/**
 * No tool probe starts this close to the end of the budget, so the probes
 * report their rows (some marked not probed) before the call stops waiting.
 */
const PROBE_MARGIN_MS = 1500;
const HEARTBEAT_MS = 5000;

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);

/**
 * Race `work` against the call's remaining budget and the caller's abort.
 * The probes carry their own timeouts, so a lost race only stops waiting.
 */
async function withinBudget<T>(
  ctx: Ctx,
  deadline: number,
  label: string,
  notes: string[],
  work: Promise<T>,
): Promise<T | undefined> {
  const remaining = deadline - Date.now();
  if (remaining <= 0 || ctx.signal.aborted) {
    notes.push(ctx.signal.aborted
      ? `${label} was skipped: the call was cancelled.`
      : `${label} was skipped: the ${TOTAL_BUDGET_MS / 1000} second budget of this call ran out.`);
    work.catch(() => undefined);
    return undefined;
  }
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<'stop'>(resolve => {
    timer = setTimeout(() => resolve('stop'), remaining);
    onAbort = () => resolve('stop');
    ctx.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const result = await Promise.race([work, stop]);
    if (result === 'stop') {
      notes.push(ctx.signal.aborted
        ? `${label} was not finished when the call was cancelled.`
        : `${label} did not finish within the ${TOTAL_BUDGET_MS / 1000} second budget of this call.`);
      work.catch(() => undefined);
      return undefined;
    }
    return result as T;
  } catch (error) {
    notes.push(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  } finally {
    if (timer) { clearTimeout(timer); }
    if (onAbort) { ctx.signal.removeEventListener('abort', onAbort); }
  }
}

/** Resolve the `tools` argument to manifest ids, refusing names the manifest does not know. */
function resolveToolsArgument(raw: unknown, manifest: DebugToolsManifest | undefined): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const names = raw.filter((v): v is string => typeof v === 'string');
  if (names.length === 0) {
    return undefined;
  }
  if (names.length > 50) {
    throw new McpToolError('INVALID_ARGUMENT', `tools lists ${names.length} names, the maximum is 50.`);
  }
  // Only ever compared with manifest names, never passed to a shell: the
  // probe command always comes from the manifest. Checked anyway so an odd
  // value is refused with a clear message instead of silently matching nothing.
  names.forEach(name => assertRunnerName(name));
  if (!manifest) {
    throw new McpToolError('INTERNAL', 'The workbench runner manifest (debug-tools.yml) could not be read, so tools cannot be resolved.');
  }
  const { ids, unknown } = resolveDebugToolSelectors(manifest, names);
  if (unknown.length > 0) {
    throw new McpToolError('INVALID_ARGUMENT',
      `tools has names that are not a tool, an alias or a runner in the workbench runner manifest: ${unknown.join(', ')}.`, {
        hint: 'Use names from details.available, or omit tools to check every flash and debug tool.',
        details: { available: listDebugToolSelectors(manifest) },
      });
  }
  return ids;
}

function venvBinDir(venvPath: string): string {
  return process.platform === 'win32' ? path.join(venvPath, 'Scripts') : path.join(venvPath, 'bin');
}

/**
 * Whether the application's own toolchain resolves. The Arm GNU and IAR
 * variants name a registered installation; when it is gone the application
 * still loads, but its build cannot find a compiler.
 */
function toolchainResolved(app: ZephyrApplication): boolean {
  if (app.toolchainVariant === 'gnuarmemb') {
    return !!app.selectedArmGnuToolchainInstallation;
  }
  if (app.toolchainVariant === 'iar') {
    return !!app.selectedIarToolchainInstallation;
  }
  return true;
}

/** What an application needs from the toolchains: the Arm GNU variant builds without a Zephyr SDK. */
export function applicationToolchain(app: ZephyrApplication): ApplicationToolchain & { toolchainVariant: string } {
  return { toolchainVariant: app.toolchainVariant, needsSdk: app.toolchainVariant !== 'gnuarmemb', toolchainResolved: toolchainResolved(app) };
}

/**
 * The application an environment answer covers when none is named: the only
 * one in the window, else none, so the answer is about the machine.
 */
export function soleApplication<T>(apps: readonly T[]): T | undefined {
  return apps.length === 1 ? apps[0] : undefined;
}

/**
 * The settings, venv and toolchain needs an environment answer rests on,
 * read for `app` the way its builds read them, or for the machine without
 * one. get_status and check_environment both start here, so their ready
 * flags cannot disagree. Files and settings only.
 */
export function readEnvironmentBasis(app?: ZephyrApplication) {
  const scope = app?.appWorkspaceFolder;
  return {
    settings: collectEnvironmentSettings(scope),
    build: resolveBuildVenv(app, scope),
    ...(app ? { toolchain: applicationToolchain(app) } : {}),
  };
}

/**
 * Whose venv an application builds with: its west workspace's dedicated venv,
 * or its own (a per-application venv.path). Each is rebuilt by a different
 * command. Undefined when the west workspace cannot be read.
 */
function applicationVenvOwner(app: ZephyrApplication, venvPath: string): 'west_workspace' | 'application' | undefined {
  if (!app.westWorkspaceRootPath) {
    return 'application';
  }
  try {
    const workspaceVenv = getWestWorkspace(app.westWorkspaceRootPath).venvPath;
    return workspaceVenv && normalizeForCompare(workspaceVenv) === normalizeForCompare(venvPath) ? 'west_workspace' : 'application';
  } catch {
    return undefined;
  }
}

interface RunnerRole {
  runner: string;
  role: 'configured' | 'default_flash' | 'default_debug';
  toolIds: string[];
}

interface RunnerPlan {
  parsed?: ParsedRunnersYaml;
  configured?: string;
  /** The runners this configuration flashes and debugs with that have a manifest tool. */
  roles: RunnerRole[];
}

/**
 * The runners a configuration uses: the one it pins, else the board's
 * default flash runner, plus the default debug runner. Files only.
 */
function planRunners(app: ZephyrApplication, config: ZephyrBuildConfig, manifest: DebugToolsManifest | undefined): RunnerPlan {
  let parsed: ParsedRunnersYaml | undefined;
  try {
    parsed = readRunnersYamlForProject(app, config);
  } catch {
    parsed = undefined;
  }
  const configured = config.defaultRunner || undefined;
  const candidates: Array<[string | undefined, RunnerRole['role']]> = [
    [configured, 'configured'],
    [configured ? undefined : parsed?.defaultFlashRunner, 'default_flash'],
    [parsed?.defaultDebugRunner, 'default_debug'],
  ];
  const roles: RunnerRole[] = [];
  const seen = new Set<string>();
  for (const [runner, role] of candidates) {
    if (!runner || seen.has(runner)) {
      continue;
    }
    seen.add(runner);
    const toolIds = manifest ? findDebugToolIdsForRunner(manifest, runner) : [];
    // A runner with no manifest tool (qemu, a vendor runner the workbench
    // does not install) has nothing to check here.
    if (toolIds.length > 0) {
      roles.push({ runner, role, toolIds });
    }
  }
  return { ...(parsed ? { parsed } : {}), ...(configured ? { configured } : {}), roles };
}

/**
 * Whether a runner's tool is installed: yes when any of its tools is, no only
 * when every one of them was checked and is absent, otherwise unknown.
 *
 * A tool whose version command timed out already carries the filesystem
 * answer, so its false is the manifest's explicit-detect verdict, never a
 * guess from the timeout.
 */
function runnerToolAnswer(toolIds: string[], byId: Map<string, DebugToolStatus>) {
  const statuses = toolIds.map(id => byId.get(id)).filter((t): t is DebugToolStatus => !!t);
  const installed = statuses.some(t => t.installed === true)
    ? true
    : statuses.length > 0 && statuses.length === toolIds.length && statuses.every(t => t.installed === false) ? false : null;
  return {
    toolNames: statuses.map(t => t.name ?? t.id),
    installed,
    updateAvailable: statuses.some(t => t.installed === true && t.updateAvailable),
    /** The tools that left the answer unknown because their version command timed out. */
    timedOut: statuses.filter(t => t.timedOut && t.installed === null).map(t => t.name ?? t.id),
  };
}

function hostToolsDto(status: HostToolsStatus, depth: 'quick' | 'full') {
  return {
    installed: status.installed,
    complete: status.complete,
    internal_dir: status.internalDir,
    env_file: { path: status.envFile.path, exists: status.envFile.exists },
    stamp: { path: status.stamp.path, exists: status.stamp.exists },
    zinstaller: {
      ...(status.zinstaller.installedVersion ? { installed_version: status.zinstaller.installedVersion } : {}),
      minimum: status.zinstaller.minimum,
      up_to_date: status.zinstaller.upToDate,
    },
    parts: status.parts.map(part => ({
      id: part.part,
      label: part.label,
      ...(part.provider ? { provider: part.provider } : {}),
      ...(part.sudo ? { sudo: true } : {}),
      present: status.undetermined.includes(part.part) ? null : part.present,
      ...(part.detectedVersion && part.detectedVersion !== '-' ? { detected_version: part.detectedVersion } : {}),
      ...(part.targetVersion ? { target_version: part.targetVersion } : {}),
      system_only: part.systemDetected,
    })),
    missing: status.missing,
    ...(depth === 'full' && status.checkedVersions ? { checked_versions: status.checkedVersions } : {}),
    version_check: {
      ran: status.versionCheck.ran,
      ...(status.versionCheck.exitCode !== undefined ? { exit_code: status.versionCheck.exitCode } : {}),
      ...(status.versionCheck.timedOut ? { timed_out: true } : {}),
    },
    ...(status.homebrew ? { homebrew: { found: status.homebrew.ok, ...(status.homebrew.prefix ? { prefix: status.homebrew.prefix } : {}) } } : {}),
    ...(status.executionPolicy ? { powershell_policy: { current: status.executionPolicy.current, allowed: status.executionPolicy.allowed } } : {}),
  };
}

function settingsDto(settings: EnvironmentSettingsStatus) {
  return {
    env_script: {
      ...(settings.envScript.configured ? { configured: settings.envScript.configured } : {}),
      exists: settings.envScript.exists,
      ok: settings.envScript.ok,
    },
    venv_setting: {
      ...(settings.venvSetting.configured ? { configured: settings.venvSetting.configured } : {}),
      exists: settings.venvSetting.exists,
      ok: settings.venvSetting.ok,
      ...(settings.venvSetting.spdxOnlyIgnored ? { spdx_only_ignored: true } : {}),
    },
    shell: {
      path: settings.shell.path,
      kind: settings.shell.kind,
      ...(settings.shell.substitutedFrom ? { substituted_from: settings.shell.substitutedFrom } : {}),
    },
  };
}

function debugToolDto(tool: DebugToolStatus) {
  return {
    id: tool.id,
    ...(tool.isAlias ? { is_alias: true } : {}),
    ...(tool.alias ? { alias: tool.alias } : {}),
    ...(tool.name ? { name: tool.name } : {}),
    ...(tool.type ? { type: tool.type } : {}),
    ...(tool.vendor ? { vendor: tool.vendor } : {}),
    installable_here: tool.installableHere,
    ...(tool.isDefaultForAlias !== undefined ? { is_default_for_alias: tool.isDefaultForAlias } : {}),
    ...(tool.defaultTool ? { default_tool: tool.defaultTool } : {}),
    installed: tool.installed,
    ...(tool.version ? { version: tool.version } : {}),
    ...(tool.referenceVersion ? { reference_version: tool.referenceVersion } : {}),
    update_available: tool.updateAvailable,
    ...(tool.configuredPath ? { configured_path: tool.configuredPath } : {}),
    ...(tool.detectedPath ? { detected_path: tool.detectedPath } : {}),
    ...(tool.timedOut ? { timed_out: true } : {}),
    ...(tool.note ? { note: tool.note } : {}),
  };
}

export const checkEnvironment: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const { services } = ctx.deps;
  const started = Date.now();
  const deadline = ctx.startedAt + TOTAL_BUDGET_MS;
  const depth: 'quick' | 'full' = args.depth === 'quick' ? 'quick' : 'full';
  const requested = Array.isArray(args.sections)
    ? args.sections.filter((s): s is Section => (ENVIRONMENT_SECTIONS as readonly string[]).includes(s as string))
    : [];
  const sections = new Set<Section>(requested.length > 0 ? requested : ENVIRONMENT_SECTIONS);
  const notes: string[] = [];

  // Validate every argument before anything is probed.
  let manifest: DebugToolsManifest | undefined;
  try {
    manifest = services.debugToolsManifest();
  } catch (error) {
    notes.push(`The workbench runner manifest could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const toolIds = resolveToolsArgument(args.tools, manifest);

  const appPath = str(args.app_path);
  const configName = str(args.config_name);
  let app: ZephyrApplication | undefined;
  if (appPath) {
    app = await services.resolveApp(appPath);
  } else {
    // The check is mostly about the machine, so several applications are a
    // note here, not the AMBIGUOUS_APP an action would raise.
    const apps = await services.listApplications();
    app = soleApplication(apps);
    if (apps.length > 1) {
      notes.push(`This window has ${apps.length} applications, so no application was checked. Pass app_path to add its venv, SDK compatibility and runner tools: ${apps.map(a => a.appRootPath).join(', ')}.`);
    }
  }
  if (configName && !app) {
    throw new McpToolError('INVALID_ARGUMENT', 'config_name was given, but no application is selected.', {
      hint: 'Pass app_path together with config_name. Call list_apps for the values.',
    });
  }
  let config: ZephyrBuildConfig | undefined;
  if (app) {
    if (configName) {
      config = services.resolveConfig(app, configName);
    } else {
      try {
        config = services.resolveConfig(app);
      } catch {
        notes.push(`Application "${app.appRootPath}" has no build configuration, so its runners were not checked.`);
      }
    }
    ctx.audit.target = { app_path: app.appRootPath, ...(config ? { config_name: config.name } : {}) };
  }

  let phase = 'settings';
  const heartbeat = setInterval(() => {
    ctx.progress({ progress: Math.round((Date.now() - ctx.startedAt) / 1000), message: `Checking ${phase}` });
  }, HEARTBEAT_MS);

  try {
    const basis = readEnvironmentBasis(app);
    const settings = basis.settings;
    const envSourced = settings.envSourcedReady;

    // Asked before any probe runs: on a Mac without the Command Line Tools,
    // /usr/bin/python3, git, make and gperf open the system install dialog
    // when run, and a tool call must show none. xcode-select itself never does.
    const developerToolsMissing = depth === 'full' && await services.macDeveloperToolsMissing();
    if (developerToolsMissing) {
      notes.push('The macOS Command Line Tools are not installed, so python3, git, make and gperf in /usr/bin were not run (each would open the macOS install dialog) and read as not installed.');
    }

    // Everything below is independent, so it runs in parallel. The quick
    // host-tools read always runs: `ready` needs it whatever sections asks for.
    phase = 'host tools';
    const fullHostTools = depth === 'full' && sections.has('host_tools');
    const hostQuickWork = services.hostToolsStatus('quick');
    const hostFullWork = fullHostTools ? services.hostToolsStatus('full', PROBE_TIMEOUT_MS, { developerToolsMissing }) : undefined;

    const { venv, exists: venvExists, westPath, westFound } = basis.build;
    // Only paths the workbench resolved itself are ever run here, never one an agent passed.
    const venvPythonWork: Promise<PythonProbeResult> | undefined = depth === 'full' && sections.has('python') && venv.path && venvExists
      ? probePythonInterpreter('custom', venvBinDir(venv.path))
      : undefined;
    // The serial actions of the hardware tool run on that venv's pyserial.
    const pyserialWork = depth === 'full' && sections.has('python') && venv.path && venvExists
      ? probePyserial(venv.path)
      : undefined;
    const systemPythonWork: Promise<PythonProbeResult> | undefined = depth === 'full' && sections.has('python')
      ? probePythonInterpreter('system', undefined, { developerToolsMissing })
      : undefined;
    const westWork: Promise<WestVersionProbeResult> | undefined = depth === 'full' && sections.has('west') && westPath && westFound
      ? probeWestVersion(westPath, PROBE_TIMEOUT_MS)
      : undefined;

    // The runners this configuration uses, read from its build (files only)
    // before probing, so their tools are probed even when `tools` names others.
    const runnerPlan = app && config && sections.has('debug_tools') ? planRunners(app, config, manifest) : undefined;
    // The version commands run through the env-sourced shell. When that shell
    // would be refused, a probe would read every tool as missing, so only the
    // filesystem is consulted and the answer says so.
    const probeTools = depth === 'full' && envSourced;
    if (depth === 'full' && sections.has('debug_tools') && !envSourced) {
      notes.push('Flash and debug tool versions were not probed because the environment script cannot be sourced (see settings). installed comes from the filesystem only, and is null where only a probe could tell.');
    }
    const probedToolIds = toolIds && runnerPlan
      ? [...new Set([...toolIds, ...runnerPlan.roles.flatMap(role => role.toolIds)])]
      : toolIds;
    const debugWork = sections.has('debug_tools')
      ? services.debugToolsStatus(probeTools ? 'full' : 'quick', {
        toolIds: probedToolIds,
        timeoutMs: PROBE_TIMEOUT_MS,
        deadline: deadline - PROBE_MARGIN_MS,
      })
      : undefined;
    const sdksWork = services.listSdks();
    // An SDK inside the host tools folder, from older installs. Files only;
    // its constructor reads sdk_version, which a half-deleted SDK lacks.
    const internalSdkWork = sections.has('sdks')
      ? getInternalZephyrSdkInstallation().catch(() => undefined)
      : undefined;

    const hostQuick = await withinBudget(ctx, deadline, 'The host tools check', notes, hostQuickWork);
    phase = 'Python, west and the SDKs';
    const [venvPython, pyserial, systemPython, westVersion, sdks, internalSdk] = await Promise.all([
      venvPythonWork ? withinBudget(ctx, deadline, 'The virtual environment Python probe', notes, venvPythonWork) : undefined,
      pyserialWork ? withinBudget(ctx, deadline, 'The pyserial probe', notes, pyserialWork) : undefined,
      systemPythonWork ? withinBudget(ctx, deadline, 'The system Python probe', notes, systemPythonWork) : undefined,
      westWork ? withinBudget(ctx, deadline, 'The west version probe', notes, westWork) : undefined,
      withinBudget(ctx, deadline, 'The SDK listing', notes, sdksWork),
      internalSdkWork,
    ]);
    phase = 'flash and debug tools';
    const debugTools = debugWork ? await withinBudget(ctx, deadline, 'The flash and debug tool probes', notes, debugWork) : undefined;
    phase = 'the host tools versions';
    const hostFull = hostFullWork ? await withinBudget(ctx, deadline, 'The host tools version check', notes, hostFullWork) : undefined;
    const host = hostFull ?? hostQuick;
    if (host?.versionCheck.timedOut) {
      notes.push(`The installer's check mode did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds, so detected versions may be incomplete.`);
    }
    if (depth === 'quick') {
      notes.push('depth quick ran no process: versions are not reported, and parts or tools that only a probe can confirm read null.');
    }

    // The application's SDK and its compatibility with the application's Zephyr.
    let application: EnvironmentFacts['sdks']['application'];
    let applicationSdk: Record<string, unknown> | undefined;
    if (app && basis.toolchain) {
      const { needsSdk, toolchainResolved: resolved } = basis.toolchain;
      let compat: { status: string; zephyr_version?: string; recommended_sdk?: string; message?: string } | undefined;
      if (needsSdk && app.westWorkspaceRootPath) {
        try {
          const kernel = getWestWorkspace(app.westWorkspaceRootPath).kernelUri.fsPath;
          const verdict = checkSdkCompatibility(app.zephyrSdkVersion, kernel);
          const message = formatSdkCompatMessage(verdict, app.zephyrSdkVersion);
          compat = {
            status: verdict.status,
            ...(verdict.zephyrVersion ? { zephyr_version: verdict.zephyrVersion } : {}),
            ...(verdict.recommendedSdk ? { recommended_sdk: verdict.recommendedSdk } : {}),
            ...(message ? { message } : {}),
          };
        } catch {
          notes.push(`The west workspace of "${app.appRootPath}" could not be read, so SDK compatibility is unknown.`);
        }
      }
      application = { ...basis.toolchain, ...(compat ? { compat } : {}) };
      applicationSdk = {
        app_path: app.appRootPath,
        toolchain_variant: app.toolchainVariant,
        toolchain_resolved: resolved,
        ...(app.isGlobalSdk ? { sdk: 'global' } : app.zephyrSdkPath ? { sdk_path: app.zephyrSdkPath } : {}),
        ...(app.zephyrSdkVersion ? { sdk_version: app.zephyrSdkVersion } : {}),
        ...(compat ? { compat } : {}),
      };
    }

    // The runners this configuration uses, cross-checked against the tools.
    let runnersDto: Record<string, unknown> | undefined;
    const runnerFacts: NonNullable<EnvironmentFacts['runners']> = [];
    if (runnerPlan && app && config) {
      const byId = new Map((debugTools ?? []).map(tool => [tool.id, tool]));
      for (const role of runnerPlan.roles) {
        const { timedOut, ...answer } = runnerToolAnswer(role.toolIds, byId);
        runnerFacts.push({ runner: role.runner, role: role.role, toolIds: role.toolIds, ...answer });
        // No problem is raised for an unknown answer, so say why it is unknown
        // and how to get one, instead of leaving the runner silently unchecked.
        if (answer.installed === null && timedOut.length > 0) {
          notes.push(`The version command of ${timedOut.join(' and ')} did not answer in time, so whether the ${role.runner} runner's tool is installed is unknown. Call check_environment again with tools ["${role.runner}"] to retry it with fewer probes at once.`);
        }
      }
      const parsed = runnerPlan.parsed;
      runnersDto = {
        app_path: app.appRootPath,
        config_name: config.name,
        built: !!parsed,
        ...(runnerPlan.configured ? { configured_runner: runnerPlan.configured } : {}),
        ...(parsed?.defaultFlashRunner ? { default_flash_runner: parsed.defaultFlashRunner } : {}),
        ...(parsed?.defaultDebugRunner ? { default_debug_runner: parsed.defaultDebugRunner } : {}),
        ...(parsed ? {
          compatible: parsed.runners.map(runner => {
            const ids = manifest ? findDebugToolIdsForRunner(manifest, runner) : [];
            return {
              runner,
              tool_ids: ids,
              installed: ids.length > 0 ? runnerToolAnswer(ids, byId).installed : null,
              ...(ids.length === 0 ? { note: 'The workbench does not manage a tool for this runner.' } : {}),
            };
          }),
        } : {
          note: 'This configuration has no runners.yaml yet, so the runners the board supports are unknown. Build it, then check again.',
        }),
      };
    }

    const sdkList = sdks ?? [];
    const facts: EnvironmentFacts = {
      platform: process.platform,
      hostTools: {
        internalDir: host?.internalDir ?? '',
        installed: host?.installed ?? false,
        complete: host?.complete ?? false,
        envFileExists: host?.envFile.exists ?? false,
        stampExists: host?.stamp.exists ?? false,
        ...(host?.zinstaller.installedVersion ? { zinstallerVersion: host.zinstaller.installedVersion } : {}),
        zinstallerMinimum: host?.zinstaller.minimum ?? '',
        zinstallerUpToDate: host?.zinstaller.upToDate ?? false,
        missingParts: (host?.parts ?? []).filter(p => host?.missing.includes(p.part)).map(p => p.label),
        ...(host?.homebrew ? { homebrewOk: host.homebrew.ok } : {}),
        ...(host?.executionPolicy ? { powershellPolicy: host.executionPolicy } : {}),
        ...(developerToolsMissing ? { developerToolsMissing: true } : {}),
      },
      settings: {
        ...(settings.envScript.configured ? { envScript: settings.envScript.configured } : {}),
        envScriptExists: settings.envScript.exists,
        ...(settings.venvSetting.configured ? { venvSetting: settings.venvSetting.configured } : {}),
        venvSettingOk: settings.venvSetting.ok,
        ...(settings.shell.substitutedFrom ? { shellSubstitutedFrom: settings.shell.substitutedFrom } : {}),
        shellUsed: path.basename(settings.shell.path),
      },
      venv: {
        ...(venv.path ? { path: venv.path } : {}),
        source: venv.source,
        ...(app && venv.source === 'application' && venv.path ? { owner: applicationVenvOwner(app, venv.path) } : {}),
        exists: venvExists,
        ...(venvPython?.ok && venvPython.version ? { version: venvPython.version, tooOld: venvPython.tooOld === true } : {}),
        minimum: PYTHON_MIN_RECOMMENDED,
      },
      west: { found: westFound, ...(westPath ? { path: westPath } : {}) },
      sdks: { count: sdkList.length, ...(application ? { application } : {}) },
      ...(runnerFacts.length > 0 ? { runners: runnerFacts } : {}),
    };
    const problems = deriveEnvironmentProblems(facts);
    const nextSteps = environmentNextSteps(problems);
    if (!app && sections.has('debug_tools')) {
      nextSteps.push('Pass app_path to also check which runners the board supports and whether their tools are installed.');
    }

    return {
      checked_at: new Date(started).toISOString(),
      duration_ms: Date.now() - started,
      depth,
      platform: process.platform,
      arch: process.arch,
      install_dir: host?.internalDir,
      ready: isEnvironmentReady(facts),
      ...(sections.has('host_tools') && host ? { host_tools: hostToolsDto(host, hostFull ? 'full' : 'quick') } : {}),
      ...(sections.has('settings') ? { settings: settingsDto(settings) } : {}),
      ...(sections.has('python') ? {
        python: {
          venv: {
            ...(venv.path ? { path: venv.path } : {}),
            source: venv.source,
            exists: venvExists,
            ...(venvPython?.ok ? { version: venvPython.version, too_old: venvPython.tooOld === true } : {}),
            ...(pyserial ? { pyserial } : {}),
          },
          ...(systemPython ? {
            system: {
              ok: systemPython.ok,
              ...(systemPython.exePath ? { exe_path: systemPython.exePath } : {}),
              ...(systemPython.version ? { version: systemPython.version, too_old: systemPython.tooOld === true } : {}),
            },
          } : {}),
        },
      } : {}),
      ...(sections.has('west') ? {
        west: {
          ...(westPath ? { path: westPath } : {}),
          found: westFound,
          ...(westVersion?.version ? { version: westVersion.version } : {}),
          ...(westVersion?.timedOut ? { timed_out: true } : {}),
        },
      } : {}),
      ...(sections.has('sdks') ? {
        sdks: {
          count: sdkList.length,
          items: sdkList.map(sdk => ({
            path: sdk.rootUri.fsPath,
            version: sdk.version?.trim(),
            global: sdk instanceof GlobalZephyrSdkInstallation,
          })),
          ...(internalSdk ? { internal: internalSdk.rootUri.fsPath } : {}),
          ...(applicationSdk ? { application: applicationSdk } : {}),
        },
      } : {}),
      ...(sections.has('debug_tools') && debugTools ? { debug_tools: debugTools.map(debugToolDto) } : {}),
      ...(runnersDto ? { runners: runnersDto } : {}),
      problems,
      next_steps: nextSteps,
      notes,
    };
  } finally {
    clearInterval(heartbeat);
  }
};
