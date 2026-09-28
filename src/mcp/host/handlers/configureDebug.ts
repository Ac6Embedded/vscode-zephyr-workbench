// configure_debug: the Debug Manager's Apply for agents, and the list and
// read of existing debug entries. Also removes debug entries for
// remove_or_delete.
//
// Apply goes through the same headless setup as the Debug Manager, so both
// write the same entry. What differs is who is asked: the panel offers to
// install Cortex-Debug and the pyOCD target pack, while an agent gets an error
// or a warning naming the tool that installs them. Nothing here shows UI.

import * as fs from 'fs';
import * as path from 'path';
import {
  applyDebugSetup, checkPyOCDTargetSupport, debugEntryFields, DebugEntryInfo, DebugSetupFailure, defaultDebugDomain,
  findApplicationDebugEntry, LaunchJsonFile, listApplicationDebugEntries, readLaunchJsonFile,
} from '../../../debug/debugSetup';
import {
  autoDetectSvdPath, collectLaunchConfigurationArtifacts, createLaunchConfiguration, findLaunchConfiguration,
  getDebugRunners, getLaunchJsonPath, getRunner, LaunchConfigurationArtifacts, writeLaunchJson,
} from '../../../utils/debugTools/debugUtils';
import { WestCommandError } from '../../../commands/WestCommands';
import { readPanelStateFromConfig } from '../../../debug/backends/backendState';
import { isCortexDebugInstalled, CORTEX_DEBUG_EXTENSION_ID } from '../../../debug/backends/cortexDebugExtension';
import { detectJlinkDevice } from '../../../debug/backends/cortexNative';
import { CORTEX_NATIVE_RUNNER_NAMES, DebugBackendId, GdbMode, getDefaultGdbPort } from '../../../debug/backends/types';
import { debugSessionsFor } from '../../../debug/sessionTracker';
import { ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from '../../../constants';
import { ZephyrApplication } from '../../../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../../../models/ZephyrBuildConfig';
import { findDebugToolIdsForRunner } from '../../../utils/debugTools/debugToolManifestUtils';
import { getConfiguredWorkbenchPath } from '../../../utils/execUtils';
import { getWestWorkspace } from '../../../utils/utils';
import { findRunnersYamlForBuildDir } from '../../../utils/zephyr/runnersYamlUtils';
import { westFailureToToolError } from '../../core/catalogSearch';
import { assertConfigName, assertRunnerName, assertSafeShellFragment, isPlainPath, normalizeForCompare } from '../../core/argSafety';
import { McpToolError, toToolError } from '../../core/errors';
import { KeyedMutex } from '../../core/keyedMutex';
import { logSafe } from '../../core/redact';
import { CONFIGURE_DEBUG_ACTIONS, ConfigureDebugAction, DEBUG_BACKENDS } from '../../core/tools/configureDebug';
import { ToolContext, ToolHandler } from '../../core/toolSpec';
import { WEST_LIST_TIMEOUT_MS } from '../catalogSources';
import { ConfirmOutcome, ConfirmSubject } from '../confirmations';
import { HostDeps } from './deps';
import { fullToolHint } from './toolchainArgs';

type Ctx = ToolContext<HostDeps>;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

/** A host name or an IPv4 address: it becomes `<address>:<port>` in the gdb connect command. */
const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/**
 * launch.json is rewritten whole, so two agent calls on the same file would
 * drop one change. One at a time per file.
 */
const launchJsonLock = new KeyedMutex();

function confirmationOf(ctx: Ctx, outcome: ConfirmOutcome) {
  return outcome === 'not-required' || outcome === 'not-asked'
    ? undefined
    : { category: ctx.audit.confirmCategory, outcome };
}

/** The request is part of the subject, so an answer given late is only used by the identical call. */
function subjectOf(base: ConfirmSubject, args: Record<string, unknown>): ConfirmSubject {
  const { wait_sec: _waitSec, ...request } = args;
  const subject: ConfirmSubject & { request: Record<string, unknown> } = { ...base, request };
  return subject;
}

/** The runners configure_debug accepts: the Debug Manager's, without the emulator. */
export function debugRunnerNames(): string[] {
  return getDebugRunners().map(runner => runner.name).filter(name => name !== 'qemu');
}

function readLaunchJsonOrThrow(app: ZephyrApplication): LaunchJsonFile {
  const file = readLaunchJsonFile(app);
  if (file.unreadable) {
    throw new McpToolError('INTERNAL', `${file.path} is not valid JSON, so its debug configurations cannot be read or changed.`, {
      hint: 'Ask the user to fix or remove that file in VS Code, then retry.',
      details: { launch_json: file.path },
    });
  }
  return file;
}

/** The text of launch.json now, to notice a change made while the user was asked. */
function currentText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function assertUnchanged(file: LaunchJsonFile): void {
  if (currentText(file.path) !== file.text) {
    throw new McpToolError('BUSY', `${file.path} changed while waiting for the confirmation, so nothing was written.`, {
      hint: 'Repeat the call: it reads the file again.',
    });
  }
}

/** The domain a call means: the one given, checked against the build, else the sysbuild default. */
function resolveDebugDomain(ctx: Ctx, app: ZephyrApplication, config: ZephyrBuildConfig, domain?: string): string | undefined {
  return domain ? ctx.deps.services.resolveDomain(app, config, domain) : defaultDebugDomain(app, config);
}

function entryView(info: DebugEntryInfo) {
  return {
    name: info.name,
    ...(info.backend ? { backend: info.backend } : {}),
    ...(info.type ? { type: info.type } : {}),
    ...(info.configName ? { config_name: info.configName } : {}),
    ...(info.domain ? { domain: info.domain } : {}),
    ...(info.runner ? { runner: info.runner } : {}),
    mode: info.mode,
    ...(info.gdbPort ? { gdb_port: Number(info.gdbPort) || info.gdbPort } : {}),
    program: info.program,
    stale: info.stale,
    ...(info.legacy ? { legacy: info.legacy } : {}),
  };
}

/**
 * How to get rid of stale entries: remove_or_delete when this window serves
 * it, which the core preset does not, else the user.
 */
export function staleEntryRemoval(ctx: Ctx, them: string): string {
  return fullToolHint(ctx, 'remove_or_delete',
    `remove ${them} with remove_or_delete and what "debug_config"`,
    `ask the user to delete ${them} from .vscode/launch.json, or to allow remove_or_delete in the AI Manager`);
}

// list

async function listEntries(args: Record<string, unknown>, ctx: Ctx) {
  const app = await ctx.deps.services.resolveApp(str(args.app_path));
  const configName = str(args.config_name);
  if (configName) {
    // May name a configuration that no longer exists, to find its stale entries.
    assertConfigName(configName);
  }
  const file = readLaunchJsonOrThrow(app);
  const entries = (file.launchJson ? listApplicationDebugEntries(app, file.launchJson) : [])
    .filter(entry => !configName || entry.configName === configName);
  const stale = entries.filter(entry => entry.stale).length;
  return {
    action: 'list',
    app_path: app.appRootPath,
    launch_json: file.path,
    exists: file.exists,
    entries: entries.map(entryView),
    next: entries.length === 0
      ? 'Call configure_debug with action "apply" to create the debug configuration of a build configuration.'
      : 'Call debug_app with action "start" and one of these names to debug.'
        + (stale > 0 ? ` ${stale} stale ${stale === 1 ? 'entry belongs' : 'entries belong'} to build configurations that no longer exist: ${staleEntryRemoval(ctx, 'them')}.` : ''),
  };
}

// get

async function getEntry(args: Record<string, unknown>, ctx: Ctx) {
  const { services } = ctx.deps;
  const name = str(args.name);
  if (name && (args.config_name !== undefined || args.domain !== undefined)) {
    throw new McpToolError('INVALID_ARGUMENT', 'Pass name, or config_name and domain, not both.', {
      hint: 'name already says which build configuration and domain the entry is for.',
    });
  }
  const app = await services.resolveApp(str(args.app_path));
  const file = readLaunchJsonOrThrow(app);
  const entries = file.launchJson ? listApplicationDebugEntries(app, file.launchJson) : [];
  let found: DebugEntryInfo | undefined;
  if (name) {
    found = entries.find(entry => entry.name === name);
    if (!found) {
      throw new McpToolError('INVALID_ARGUMENT', `${app.appRootPath} has no debug configuration named "${logSafe(name, 200)}".`, {
        hint: 'Use one of the names in details, as configure_debug with action "list" returns them.',
        details: { names: entries.map(entry => entry.name) },
      });
    }
  } else {
    const config = services.resolveConfig(app, str(args.config_name));
    const domain = resolveDebugDomain(ctx, app, config, str(args.domain));
    found = findApplicationDebugEntry(app, entries, config, domain);
    if (!found) {
      throw new McpToolError('CONFIG_NOT_FOUND',
        `${file.path} has no debug configuration for "${config.name}"${domain ? ` (domain ${domain})` : ''}.`, {
          hint: `Call configure_debug with action "apply" and config_name "${config.name}" to create it.`,
          details: { names: entries.map(entry => entry.name) },
        });
    }
  }
  return {
    action: 'get',
    app_path: app.appRootPath,
    launch_json: file.path,
    ...entryView(found),
    entry: found.entry,
    fields: debugEntryFields(found.entry),
    next: found.stale
      ? `Its build configuration no longer exists: ${staleEntryRemoval(ctx, 'it')}.`
      : `Call debug_app with action "start" and name "${found.name}" to debug, or configure_debug with action "apply" to change it.`,
  };
}

// apply

/** An absolute path that must exist, or undefined when the argument is not given. */
function existingPathArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = str(args[key]);
  if (value === undefined) {
    return undefined;
  }
  if (!path.isAbsolute(value)) {
    throw new McpToolError('INVALID_ARGUMENT', `${key} must be an absolute path, not "${logSafe(value, 300)}".`);
  }
  if (!fs.existsSync(value)) {
    throw new McpToolError('INVALID_ARGUMENT', `${key} "${logSafe(value, 300)}" does not exist.`, {
      hint: `Pass the absolute path of an existing file, or omit ${key} for the default.`,
    });
  }
  return value;
}

/** Refuse while a build or a deletion works in the build folder, where the debug files go. */
function assertNotBusy(ctx: Ctx, app: ZephyrApplication, config: ZephyrBuildConfig, buildDir: string): void {
  const { jobs, services } = ctx.deps;
  const running = jobs.runningOverlapping(buildDir).find(job => job.spec.kind === 'build' || job.spec.kind === 'clean');
  if (running) {
    throw new McpToolError('BUSY', `A ${running.spec.kind} job works in the build folder of ${config.name} (job_id "${running.id}").`, {
      hint: `Wait for it with job {"action": "status", "job_id": "${running.id}"}, then call configure_debug again.`,
      details: { job_id: running.id, kind: running.spec.kind },
    });
  }
  const external = services.externalRun(app.appRootPath, config.name);
  if (external) {
    throw new McpToolError('BUSY_EXTERNAL', `"${external.task.name}" is running for ${config.name}, started from VS Code.`, {
      hint: 'Wait for it to finish in its terminal, then call configure_debug again.',
    });
  }
}

/** A warning when the host tool of the runner is not found. Never fails the call. */
async function runnerToolWarning(ctx: Ctx, runner: string): Promise<string | undefined> {
  const { services } = ctx.deps;
  try {
    const ids = findDebugToolIdsForRunner(services.debugToolsManifest(), runner);
    if (ids.length === 0) {
      return undefined;
    }
    // quick reads the filesystem only; a tool it cannot place is not reported missing.
    const rows = await services.debugToolsStatus('quick', { toolIds: ids });
    if (rows.length > 0 && rows.every(row => row.installed === false)) {
      return `The host tool of the ${runner} runner (${ids.join(', ')}) was not found on this machine, and the session cannot start without it: `
        + 'install it with manage_runners, and check it with list_runners and include ["tools"].';
    }
  } catch {
    // An unreadable manifest only loses the warning.
  }
  return undefined;
}

/** The ELF a launch.json program points at, when it can be told without VS Code's variables. */
function resolveProgram(app: ZephyrApplication, program: string): string | undefined {
  const token = '${workspaceFolder}';
  if (program.startsWith(token)) {
    return path.join(app.appWorkspaceFolder.uri.fsPath, program.slice(token.length));
  }
  return path.isAbsolute(program) ? program : undefined;
}

function failureError(failure: DebugSetupFailure, config: ZephyrBuildConfig): McpToolError {
  switch (failure) {
    case 'no-program':
      return new McpToolError('INVALID_ARGUMENT', `No program was found for ${config.name}.`, {
        hint: 'Pass program_path with the absolute path of the ELF to debug.',
      });
    case 'no-gdb':
      return new McpToolError('INVALID_ARGUMENT', `No gdb was found for ${config.name}: the build names none and the toolchain has none for this board.`, {
        hint: 'Pass gdb_path with the absolute path of a gdb for this architecture. Call list_toolchains to see the installed toolchains.',
      });
    case 'no-gdb-address':
    case 'no-gdb-port':
      return new McpToolError('INVALID_ARGUMENT', 'The gdb server address and port are required.', {
        hint: 'Pass gdb_address and gdb_port.',
      });
    case 'no-device':
      return new McpToolError('INVALID_ARGUMENT', `The J-Link device of ${config.name} was not found in its build.`, {
        hint: 'Pass device with the SEGGER device name, such as nRF52840_xxAA or STM32F429ZI.',
      });
    case 'no-cortex-debug':
      return cortexDebugMissing();
    case 'not-native-runner':
      return new McpToolError('INVALID_ARGUMENT', 'The cortex-native backend takes the jlink or stlink_gdbserver runner only.');
    default:
      return new McpToolError('INTERNAL', `The debug configuration of ${config.name} could not be written (${failure}).`);
  }
}

function cortexDebugMissing(): McpToolError {
  return new McpToolError('DEPENDENCY_MISSING', 'The Cortex-Debug backends need the Cortex-Debug extension, which is not installed or is disabled.', {
    hint: `Ask the user to install the Cortex-Debug extension (${CORTEX_DEBUG_EXTENSION_ID}) in VS Code, or use backend "cppdbg".`,
  });
}

/**
 * What the build tells about debugging it, read without starting any task.
 * `west boards` still runs when the build's board folder has no board yaml,
 * so it is bounded: it runs under the launch.json lock.
 */
async function artifactsOf(ctx: Ctx, app: ZephyrApplication, config: ZephyrBuildConfig, domain?: string): Promise<LaunchConfigurationArtifacts> {
  let westWorkspace: ReturnType<typeof getWestWorkspace>;
  try {
    westWorkspace = getWestWorkspace(app.westWorkspaceRootPath);
  } catch (error) {
    throw new McpToolError('ENV_NOT_READY', `The west workspace of ${app.appRootPath} cannot be read: ${error instanceof Error ? error.message : String(error)}`, {
      hint: 'Call get_status to see the west workspaces, and link the application to one with configure.',
    });
  }
  // The build folder exists (checked before), so no temporary CMake build is started.
  try {
    return await collectLaunchConfigurationArtifacts(app, config, westWorkspace, domain, {
      signal: ctx.signal, timeoutMs: WEST_LIST_TIMEOUT_MS,
    });
  } catch (error) {
    if (!(error instanceof WestCommandError)) {
      throw error;
    }
    const mapped = westFailureToToolError('west boards', { message: error.message, stderr: error.stderr, stopped: error.stopped });
    if (mapped.code !== 'INTERNAL') {
      throw mapped;
    }
    throw new McpToolError('INTERNAL', `${mapped.message} It was run to find the board of ${config.name}.`, {
      hint: 'Call get_status to check that the west workspace is ready, then retry.',
    });
  }
}

function boardNotFound(app: ZephyrApplication, config: ZephyrBuildConfig, domain?: string): McpToolError {
  const message = `The board of ${config.name} (${config.boardIdentifier}) was not found from its build folder, and west boards does not list it.`;
  // Only a build that stopped before writing runners.yaml gains from building again.
  if (!findRunnersYamlForBuildDir(config.getBuildDir(app), domain ?? path.basename(app.appRootPath))) {
    return new McpToolError('NOT_BUILT', message, {
      hint: `Call build_app with config_name "${config.name}" to complete the build, whose runners.yaml names the board folder, then retry.`,
    });
  }
  return new McpToolError('ENV_NOT_READY', message, {
    hint: 'The board folder its runners.yaml names has no <board>.yaml, and no board root west searches holds the board. '
      + 'Ask the user to add that folder\'s board root to BOARD_ROOT, then retry.',
  });
}

async function applyEntry(args: Record<string, unknown>, ctx: Ctx) {
  const { services } = ctx.deps;
  const { app, config, buildDir } = await services.resolveTarget(str(args.app_path), str(args.config_name));
  // Never the temporary CMake build the Debug Manager starts for a missing
  // build folder: it is a VS Code task that would run under the agent's call.
  if (!services.isConfigured(buildDir)) {
    throw new McpToolError('NOT_BUILT', `${config.name} has not been built, and a debug configuration is made from its build.`, {
      hint: `Call build_app with config_name "${config.name}" first, then retry.`,
      details: { build_dir: buildDir },
    });
  }
  const domain = resolveDebugDomain(ctx, app, config, str(args.domain));
  assertNotBusy(ctx, app, config, buildDir);

  // Arguments on their own.
  const backendArg = str(args.backend);
  if (backendArg !== undefined && !(DEBUG_BACKENDS as readonly string[]).includes(backendArg)) {
    throw new McpToolError('INVALID_ARGUMENT', `backend must be one of ${DEBUG_BACKENDS.join(', ')}, not "${logSafe(backendArg, 40)}".`);
  }
  const modeArg = str(args.mode);
  if (modeArg !== undefined && modeArg !== 'program' && modeArg !== 'attach') {
    throw new McpToolError('INVALID_ARGUMENT', `mode must be program or attach, not "${logSafe(modeArg, 40)}".`);
  }
  const interfaceArg = str(args.interface);
  if (interfaceArg !== undefined && interfaceArg !== 'swd' && interfaceArg !== 'jtag') {
    throw new McpToolError('INVALID_ARGUMENT', `interface must be swd or jtag, not "${logSafe(interfaceArg, 40)}".`);
  }
  const programArg = existingPathArg(args, 'program_path');
  const gdbArg = existingPathArg(args, 'gdb_path');
  const svdArg = existingPathArg(args, 'svd_path');
  const runnerPathRaw = str(args.runner_path);
  const runnerPathArg = runnerPathRaw === '' ? '' : existingPathArg(args, 'runner_path');
  if (runnerPathArg && !isPlainPath(runnerPathArg)) {
    // It goes onto the west debugserver command line, through the wrapper's shell.
    throw new McpToolError('INVALID_ARGUMENT', `runner_path "${logSafe(runnerPathArg, 300)}" holds characters a shell would read.`, {
      hint: 'Use a path of letters, digits, spaces and . _ - / \\ : + @ = ~ only.',
    });
  }
  const runnerArgsArg = str(args.runner_args);
  if (runnerArgsArg) {
    assertSafeShellFragment(runnerArgsArg, 'runner_args');
    // On Windows they reach a batch file, where % expands.
    if (runnerArgsArg.includes('%')) {
      throw new McpToolError('INVALID_ARGUMENT', 'runner_args contains "%", which is not allowed because the value is passed to a shell.');
    }
  }
  const addressArg = str(args.gdb_address);
  if (addressArg !== undefined && !HOST_PATTERN.test(addressArg)) {
    throw new McpToolError('INVALID_ARGUMENT', `gdb_address must be a host name or an IPv4 address, not "${logSafe(addressArg, 100)}".`);
  }
  const portArg = num(args.gdb_port);
  if (portArg !== undefined && (!Number.isInteger(portArg) || portArg < 1 || portArg > 65535)) {
    throw new McpToolError('INVALID_ARGUMENT', `gdb_port must be a whole number from 1 to 65535, not ${portArg}.`);
  }
  const runnerArg = str(args.runner);
  const validRunners = debugRunnerNames();
  if (runnerArg !== undefined) {
    assertRunnerName(runnerArg);
    if (!validRunners.includes(runnerArg)) {
      throw new McpToolError('RUNNER_UNKNOWN', `"${runnerArg}" is not a debug runner configure_debug can set up.`, {
        hint: `Pass one of ${validRunners.join(', ')}. Flash-only runners and emulators cannot debug here; call list_runners to see the runners the board supports.`,
        details: { valid: validRunners },
      });
    }
  }
  const dryRun = args.dry_run === true;

  return launchJsonLock.run(normalizeForCompare(getLaunchJsonPath(app)), async () => {
    const file = readLaunchJsonOrThrow(app);
    const launchJson = file.launchJson ?? { version: '0.2.0', configurations: [] };
    const artifacts = await artifactsOf(ctx, app, config, domain);

    const namesBefore: unknown[] = launchJson.configurations.map((entry: any) => entry?.name);
    let found: any;
    try {
      found = await findLaunchConfiguration(launchJson, app, config.name, artifacts, domain, { silent: true });
    } catch (error) {
      if (error instanceof Error && /target board not found/.test(error.message)) {
        throw boardNotFound(app, config, domain);
      }
      throw toToolError(error);
    }
    // A missing entry is created from the template and appended.
    const existed = launchJson.configurations.length === namesBefore.length;
    const renamedFrom = existed ? namesBefore[launchJson.configurations.indexOf(found)] : undefined;
    const stored = readPanelStateFromConfig(found);
    let template: any = existed ? undefined : found;
    const templateEntry = async () => {
      if (!template) {
        try {
          template = await createLaunchConfiguration(app, config.name, artifacts, domain, { silent: true });
        } catch {
          throw boardNotFound(app, config, domain);
        }
      }
      return template;
    };

    // Backend and runner: the arguments, else the stored entry, else the
    // defaults the Debug Manager starts from.
    const backend: DebugBackendId = (backendArg as DebugBackendId | undefined) ?? (existed ? stored.backend : 'cppdbg');
    if (backend !== 'cppdbg' && !isCortexDebugInstalled()) {
      throw cortexDebugMissing();
    }
    const native = backend === 'cortex-native';
    if (!native && (args.device !== undefined || interfaceArg !== undefined)) {
      throw new McpToolError('INVALID_ARGUMENT', 'device and interface apply to backend "cortex-native" only.');
    }
    if (native && (addressArg !== undefined || portArg !== undefined)) {
      throw new McpToolError('INVALID_ARGUMENT', 'gdb_address and gdb_port do not apply to backend "cortex-native": Cortex-Debug starts and connects to the server itself.');
    }
    const nativeRunners: readonly string[] = CORTEX_NATIVE_RUNNER_NAMES;
    const usable = native ? nativeRunners : validRunners;
    let runner: string | undefined;
    if (runnerArg !== undefined) {
      if (!usable.includes(runnerArg)) {
        throw new McpToolError('INVALID_ARGUMENT', `The cortex-native backend takes the jlink or stlink_gdbserver runner, not ${runnerArg}.`, {
          hint: 'Pass runner "jlink" or "stlink_gdbserver", or use backend "cortex-west", which debugs through west with any debug runner.',
          details: { valid: [...nativeRunners] },
        });
      }
      runner = runnerArg;
    } else {
      const compatible = validRunners.filter(name => artifacts.compatibleRunners.includes(name));
      runner = [existed ? stored.runnerName : undefined, artifacts.defaultDebugRunner, ...compatible]
        .find((name): name is string => !!name && usable.includes(name));
      if (!runner && native) {
        runner = artifacts.compatibleRunners.includes('stlink_gdbserver') && !artifacts.compatibleRunners.includes('jlink')
          ? 'stlink_gdbserver'
          : 'jlink';
      }
      if (!runner) {
        throw new McpToolError('RUNNER_UNKNOWN', `The build of ${config.name} names no debug runner configure_debug can set up.`, {
          hint: `Pass runner, one of ${validRunners.join(', ')}. Call list_runners to see the runners the board supports.`,
          details: { valid: validRunners, board_runners: artifacts.compatibleRunners },
        });
      }
    }
    // cppdbg and cortex-west run the same west debugserver command line, so
    // its runner path, arguments and port carry over between them. The server
    // cortex-native starts takes other arguments, so they never cross to or
    // from it.
    const westBackend = (id: DebugBackendId) => id === 'cppdbg' || id === 'cortex-west';
    const sameServer = existed && (stored.backend === backend || (westBackend(stored.backend) && westBackend(backend)));
    const sameRunner = sameServer && stored.runnerName === runner;

    // What the stored entry holds for its runner.
    let storedRunnerPath: string | undefined;
    let storedRunnerArgs: string | undefined;
    if (existed && stored.runnerName) {
      if (stored.backend === 'cortex-native') {
        storedRunnerPath = stored.runnerPath || undefined;
        storedRunnerArgs = stored.runnerArgs || undefined;
      } else if (stored.debugServerArgs) {
        const parser = getRunner(stored.runnerName);
        parser?.loadArgs(stored.debugServerArgs);
        storedRunnerPath = parser?.serverPath || undefined;
        storedRunnerArgs = parser?.userArgs || undefined;
      }
    }
    // Only a backend switch drops them silently: another runner is expected to
    // start from its own defaults.
    const dropped = existed && !sameServer && stored.runnerName === runner
      ? [
        ...(runnerArgsArg === undefined && storedRunnerArgs ? ['runner_args'] : []),
        ...(runnerPathArg === undefined && storedRunnerPath ? ['runner_path'] : []),
      ]
      : [];
    if (!sameRunner) {
      storedRunnerPath = undefined;
      storedRunnerArgs = undefined;
    }

    const programPath = programArg ?? (stored.programPath || (await templateEntry()).program || '');
    const gdbPath = gdbArg ?? (stored.gdbPath || (await templateEntry()).miDebuggerPath || '');
    const svdPath = svdArg ?? (stored.svdPath || (artifacts.targetBoard ? autoDetectSvdPath(artifacts.targetBoard) : ''));
    const gdbMode: GdbMode = (modeArg as GdbMode | undefined) ?? (existed ? stored.gdbMode : 'program');
    const gdbAddress = addressArg ?? (existed && stored.backend !== 'cortex-native' ? stored.gdbAddress : 'localhost');
    // cppdbg keeps the port of its template, which west passes to every runner;
    // the Cortex-Debug backends start from the runner's usual port.
    const gdbPort = portArg !== undefined
      ? String(portArg)
      : sameRunner && !native
        ? stored.gdbPort
        : backend === 'cppdbg' ? readPanelStateFromConfig(await templateEntry()).gdbPort : getDefaultGdbPort(runner);
    const runnerPath = runnerPathArg !== undefined ? runnerPathArg : storedRunnerPath;
    const runnerArgs = runnerArgsArg !== undefined ? runnerArgsArg : (storedRunnerArgs ?? '');
    let device = str(args.device)?.trim();
    if (native && device === undefined) {
      device = (sameRunner ? stored.device : undefined)
        || (runner === 'jlink' ? detectJlinkDevice(app, config, artifacts.targetBoard)?.device : undefined)
        || '';
    }
    const deviceInterface = (interfaceArg as 'swd' | 'jtag' | undefined)
      ?? (existed && stored.backend === 'cortex-native' ? stored.deviceInterface : undefined) ?? 'swd';

    if (backend === 'cppdbg' && !getConfiguredWorkbenchPath(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, app.appWorkspaceFolder)) {
      // The west wrapper sources it; toToolError turns this into ENV_NOT_READY.
      throw toToolError(new Error('The Zephyr environment script is not set, and the cppdbg backend runs west through it.', {
        cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}`,
      }));
    }

    const warnings: string[] = [];
    if (dropped.length > 0) {
      warnings.push(`The stored ${dropped.join(' and ')} of ${runner} were not kept, as ${stored.backend} and ${backend} start the server differently: `
        + `pass ${dropped.join(' and ')} again for ${backend}.`);
    }
    if (artifacts.compatibleRunners.length > 0 && !artifacts.compatibleRunners.includes(runner) && !native) {
      warnings.push(`The board's runners.yaml does not list ${runner} (it lists ${artifacts.compatibleRunners.join(', ')}), so west debugserver may refuse it.`);
    }
    if (!runnerPath) {
      const missing = await runnerToolWarning(ctx, runner);
      if (missing) {
        warnings.push(missing);
      }
    }
    const programFile = resolveProgram(app, programPath);
    if (programFile && !fs.existsSync(programFile)) {
      warnings.push(`${programFile} does not exist yet: call build_app with config_name "${config.name}" before debug_app.`);
    }
    if (file.hasComments) {
      warnings.push(`${file.path} has comments or trailing commas, which are not kept when it is written.`);
    }

    let outcome: ConfirmOutcome = 'not-required';
    const result = await applyDebugSetup({
      project: app,
      buildConfig: config,
      domain,
      backend,
      runnerName: runner,
      programPath,
      svdPath,
      gdbPath,
      gdbAddress,
      gdbPort,
      gdbMode,
      runnerPath,
      runnerArgs,
      device,
      deviceInterface,
      targetArch: artifacts.targetBoard?.arch,
    }, {
      artifacts,
      silent: true,
      load: async () => [launchJson, found],
      ensureCortexDebug: async () => isCortexDebugInstalled(),
      // Checks only: the pack download is manage_runners' to do, where the user is asked.
      preparePyOCDTarget: async () => {
        const support = await checkPyOCDTargetSupport(app, config, domain);
        if (!support.target) {
          throw new McpToolError('INVALID_ARGUMENT', `The runners.yaml of ${config.name} gives pyOCD no target, so pyOCD cannot debug this board.`, {
            hint: 'Pass another runner; call list_runners to see the runners the board supports.',
          });
        }
        if (support.installed === false) {
          warnings.push(`pyOCD has no support for the target ${support.target} yet, and the session cannot connect without it: `
            + `call manage_runners with action "pyocd_install_pack" and pyocd_target "${support.target}" before debug_app.`);
        } else if (support.installed === undefined) {
          warnings.push(`pyOCD could not be run to check its support for the target ${support.target}${support.error ? ` (${logSafe(support.error, 300)})` : ''}: `
            + 'call list_runners with include ["tools", "pyocd"] to check it, and install pyOCD with manage_runners.');
        }
        return true;
      },
      beforeWrite: async plan => {
        if (dryRun) {
          return false;
        }
        const details = [`runner ${runner}`, `backend ${backend}`];
        if (runnerArgs) {
          details.push(`runner arguments ${logSafe(runnerArgs, 200)}`);
        }
        outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
          summary: `write the debug configuration "${plan.entry.name}" (${details.join(', ')}) to ${plan.launchJsonPath}`,
          appPath: app.appRootPath,
          configName: config.name,
          board: config.boardIdentifier,
          runner,
          scope: app.appRootPath,
        }, args));
        assertUnchanged(file);
        return true;
      },
    });
    if (!result.ok) {
      throw failureError(result.failure, config);
    }

    const { entry, files, launchJsonPath } = result.plan;
    if (debugSessionsFor(app, config.name).some(session => session.name === entry.name)) {
      warnings.push(`A debug session of "${entry.name}" is running: the new configuration applies the next time it starts.`);
    }
    const confirmation = confirmationOf(ctx, outcome);
    return {
      action: 'apply',
      app_path: app.appRootPath,
      config_name: config.name,
      ...(domain ? { domain } : {}),
      name: entry.name,
      backend,
      runner,
      launch_json: launchJsonPath,
      created: !existed,
      ...(typeof renamedFrom === 'string' && renamedFrom !== entry.name ? { renamed_from: renamedFrom } : {}),
      entry,
      fields: debugEntryFields(entry),
      ...(dryRun ? { dry_run: true, files_to_write: files } : { files_written: files }),
      warnings,
      ...(confirmation ? { confirmation } : {}),
      next: dryRun
        ? 'Call configure_debug again without dry_run to write it.'
        : `Call debug_app with action "start" and name "${entry.name}" to start the session.`,
    };
  });
}

const ROUTES: Readonly<Record<ConfigureDebugAction, {
  args: readonly string[];
  run(args: Record<string, unknown>, ctx: Ctx): Promise<unknown>;
}>> = {
  list: { args: ['app_path', 'config_name'], run: listEntries },
  get: { args: ['app_path', 'config_name', 'domain', 'name'], run: getEntry },
  apply: {
    args: [
      'app_path', 'config_name', 'domain', 'runner', 'backend', 'mode', 'program_path', 'gdb_path', 'svd_path',
      'gdb_address', 'gdb_port', 'runner_path', 'runner_args', 'device', 'interface', 'dry_run',
    ],
    run: applyEntry,
  },
};

export const configureDebug: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const action = typeof args.action === 'string' ? args.action : '';
  const route = Object.prototype.hasOwnProperty.call(ROUTES, action) ? ROUTES[action as ConfigureDebugAction] : undefined;
  if (!route) {
    throw new McpToolError('INVALID_ARGUMENT', `action must be one of ${CONFIGURE_DEBUG_ACTIONS.join(', ')}, not "${logSafe(action, 40)}".`);
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

/**
 * remove_or_delete what "debug_config": one entry by name, or the entries of
 * the application whose build configuration no longer exists, narrowed to one
 * configuration name. Other entries of launch.json are kept as they are.
 */
export async function removeDebugConfig(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  const { services } = ctx.deps;
  const name = str(args.name);
  const configName = str(args.config_name);
  if (name && configName) {
    throw new McpToolError('INVALID_ARGUMENT', 'Pass name, or config_name, not both.', {
      hint: 'name removes one entry; config_name removes the stale entries of a build configuration that no longer exists.',
    });
  }
  if (configName) {
    assertConfigName(configName);
  }
  const app = await services.resolveApp(str(args.app_path));
  const dryRun = args.dry_run === true;

  return launchJsonLock.run(normalizeForCompare(getLaunchJsonPath(app)), async () => {
    const file = readLaunchJsonOrThrow(app);
    const entries = file.launchJson ? listApplicationDebugEntries(app, file.launchJson) : [];
    let targets: DebugEntryInfo[];
    if (name) {
      const found = entries.find(entry => entry.name === name);
      if (!found) {
        throw new McpToolError('INVALID_ARGUMENT', `${app.appRootPath} has no debug configuration named "${logSafe(name, 200)}".`, {
          hint: 'Use one of the names in details, as configure_debug with action "list" returns them.',
          details: { names: entries.map(entry => entry.name) },
        });
      }
      targets = [found];
    } else {
      targets = entries.filter(entry => entry.stale && (!configName || entry.configName === configName));
    }
    const base = { what: 'debug_config', app_path: app.appRootPath, launch_json: file.path };
    if (targets.length === 0) {
      const live = configName && app.buildConfigs.some(config => config.name === configName);
      return {
        ...base,
        removed: [],
        note: live
          ? `"${configName}" still exists, so its debug configurations are not stale.`
          : 'No debug configuration of this application belongs to a build configuration that no longer exists.',
        next: live
          ? 'Pass name, as configure_debug with action "list" returns it, to remove one of its entries.'
          : 'Nothing to do.',
      };
    }
    const names = targets.map(target => target.name);
    const warnings: string[] = [];
    if (file.hasComments) {
      warnings.push(`${file.path} has comments or trailing commas, which are not kept when it is written.`);
    }
    const running = debugSessionsFor(app).filter(session => names.includes(session.name));
    if (running.length > 0) {
      warnings.push(`A debug session of ${running.map(session => `"${session.name}"`).join(', ')} is running; it goes on until it is stopped.`);
    }
    if (dryRun) {
      return {
        ...base, dry_run: true, would_remove: names, warnings,
        next: 'Call remove_or_delete again without dry_run to remove them.',
      };
    }

    const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
      summary: names.length === 1
        ? `remove the debug configuration "${names[0]}" from ${file.path}`
        : `remove ${names.length} debug configurations of build configurations that no longer exist (${names.map(n => `"${n}"`).join(', ')}) from ${file.path}`,
      appPath: app.appRootPath,
      ...(targets.length === 1 && targets[0].configName ? { configName: targets[0].configName } : {}),
      scope: app.appRootPath,
    }, args));
    assertUnchanged(file);

    const drop = new Set(targets.map(target => target.index));
    const launchJson = file.launchJson;
    launchJson.configurations = launchJson.configurations.filter((_entry: unknown, index: number) => !drop.has(index));
    writeLaunchJson(launchJson, app);
    const confirmation = confirmationOf(ctx, outcome);
    return {
      ...base,
      removed: names,
      warnings,
      ...(confirmation ? { confirmation } : {}),
      next: 'Call configure_debug with action "list" to see the entries left.',
    };
  });
}
