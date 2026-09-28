// The Apply of the Debug Manager, without its panel: checks the form, builds
// the launch.json entry of the chosen backend and writes it with the files it
// needs (the west wrapper for cppdbg, the OpenOCD gdb.cfg). It shows nothing:
// a failure comes back with the message the Debug Manager shows, and the two
// steps that can involve the user, Cortex-Debug presence and pyOCD target
// support, are hooks, so the panel can offer installs while an agent only
// checks. Also reads the Workbench entries of an application for the MCP.

import fs from 'fs';
import path from 'path';
// debugUtils first: loading a runner module first runs into the
// WestRunner -> ... -> debugUtils -> Linkserver -> WestRunner import cycle.
import {
  createLaunchConfiguration,
  createOpenocdCfg,
  createWestWrapper,
  getDebugLaunchConfigurationName,
  getDebugSessionVenvPath,
  getLaunchConfiguration,
  getLaunchJsonPath,
  getRunner,
  getWestDebugArgsForProject,
  getWestWrapperPath,
  isLaunchConfigurationForApplication,
  LaunchConfigurationArtifacts,
  parseLaunchJsonText,
  pyocdLaunchJson,
  writeLaunchJson,
} from '../utils/debugTools/debugUtils';
import {
  extractDebugBuildConfigName,
  extractDebugDomainName,
  getFreestandingDebugLaunchConfigurationName,
  ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME,
} from '../utils/debugTools/debugConfigNames';
import { checkPyOCDTarget } from '../utils/execUtils';
import { readDomainsForBuildDir } from '../utils/zephyr/domainsYamlUtils';
import { ZephyrApplication } from '../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../models/ZephyrBuildConfig';
import { getSetupCommands } from './gdbUtils';
import { StlinkGdbserver } from './runners/StlinkGdbserver';
import { readPanelStateFromConfig } from './backends/backendState';
import { buildCortexWestLaunchConfig } from './backends/cortexWest';
import { buildCortexNativeLaunchConfig } from './backends/cortexNative';
import { DebugBackendId, GdbMode, runnerNameToNativeServer, ZW_DEBUG_TYPE } from './backends/types';

/** What the Debug Manager form holds when Apply is pressed. */
export interface DebugSetupInput {
  project: ZephyrApplication;
  /** Undefined when the form names no build configuration: nothing is written then. */
  buildConfig: ZephyrBuildConfig | undefined;
  domain?: string;
  backend: DebugBackendId;
  runnerName: string | undefined;
  programPath: string;
  svdPath: string;
  gdbPath: string;
  gdbAddress: string;
  gdbPort: string;
  gdbMode: GdbMode;
  runnerPath?: string;
  runnerArgs?: string;
  device?: string;
  deviceInterface?: 'swd' | 'jtag';
  /** The board's architecture when known, for the QEMU check of the cortex-west backend. */
  targetArch?: string;
}

export type DebugSetupFailure =
  | 'no-runner' | 'no-program' | 'no-gdb' | 'no-gdb-address' | 'no-gdb-port' | 'no-device'
  | 'no-build-config' | 'no-cortex-debug' | 'qemu-not-arm' | 'not-native-runner' | 'pyocd-target'
  | 'launch-json-unreadable';

/** The launch.json of the application, the entry of the configuration, and every file Apply writes. */
export interface DebugSetupPlan {
  launchJson: any;
  entry: any;
  launchJsonPath: string;
  /** Files written, in order: the west wrapper, the OpenOCD gdb.cfg, launch.json. */
  files: string[];
}

export interface DebugSetupHooks {
  /** Whether the Cortex-Debug extension can be used. The Debug Manager offers to install it. */
  ensureCortexDebug(): Promise<boolean>;
  /** Whether pyOCD has support for the build's target. The Debug Manager installs it; an agent only checks. */
  preparePyOCDTarget(): Promise<boolean>;
  /**
   * The launch.json and the entry of the configuration, when the caller read
   * them itself. By default they are read as the Debug Manager reads them.
   */
  load?(): Promise<[any, any]>;
  /** Called once every check passed, before anything is written. False writes nothing. */
  beforeWrite?(plan: DebugSetupPlan): Promise<boolean>;
  /** The build's artifacts when the caller already collected them. */
  artifacts?: LaunchConfigurationArtifacts;
  /** Show no notification while a missing entry is created. */
  silent?: boolean;
}

export type DebugSetupResult =
  | { ok: true; written: boolean; plan: DebugSetupPlan }
  /** `message` is what the Debug Manager shows; absent when a hook already told the user. */
  | { ok: false; failure: DebugSetupFailure; message?: string };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Put the runner's executable path into the debugserver arguments, as `--<runner> <path>`. */
export function runnerPathArg(debugServerArgs: string, runnerName: string, runnerPath?: string): string {
  const path = runnerPath?.trim();
  const runner = runnerName?.trim().toLowerCase();
  const args = debugServerArgs?.trim() ?? '';

  if (!path || !runner) {
    return args;
  }

  // ST-LINK GDB Server is launched indirectly (via west / the CubeCLT bundle)
  // and does not accept an executable-path flag on the command line. QEMU is
  // resolved by the Zephyr build and started through the debugserver_qemu
  // CMake target, which likewise takes no executable-path flag. The path is
  // only used internally for detection, so we must not inject it into
  // `debugServerArgs`, which would put an invalid flag in launch.json.
  if (runner === 'stlink_gdbserver' || runner === 'qemu') {
    return args;
  }
  // The J-Link runner passes its path itself, as --gdbserver: west's jlink
  // runner has no --jlink option and refuses one.
  if (runner === 'jlink') {
    return args;
  }

  const flag = `--${runner}`;
  const quotedPath = path.includes(' ') ? `"${path}"` : path;
  const flagPattern = new RegExp(`(${escapeRegExp(flag)})(?:\\s+|=)(?:"[^"]*"|\\S+)`, 'gi');

  // Replace existing flag value
  if (flagPattern.test(args)) {
    return args.replace(flagPattern, `$1 ${quotedPath}`);
  }

  // Insert after --runner <name> if it matches
  const runnerPattern = new RegExp(`(--runner(?:\\s+|=)(?:"${runner}"|${runner}))`, 'i');
  if (runnerPattern.test(args)) {
    return args.replace(runnerPattern, `$1 ${flag} ${quotedPath}`);
  }

  // Otherwise append
  return args ? `${args} ${flag} ${quotedPath}` : `${flag} ${quotedPath}`;
}

const fail = (failure: DebugSetupFailure, message?: string): DebugSetupResult => ({ ok: false, failure, ...(message ? { message } : {}) });

/** The checks Apply makes on the form before it reads anything. */
function checkForm(input: DebugSetupInput): DebugSetupResult | undefined {
  if (!input.runnerName || !getRunner(input.runnerName)) {
    return fail('no-runner', 'Debug manager: No debug runner selected!');
  }
  if (!input.programPath) {
    return fail('no-program', 'Debug manager: Program path is required. Select a program executable before applying or debugging.');
  }
  // Missing debugger detection is represented as an empty field in the UI.
  // Block writes here so we never persist a placeholder like CMAKE_GDB-NOTFOUND.
  if (!input.gdbPath) {
    return fail('no-gdb', 'Debug manager: GDB path is required. Select a debugger executable before applying or debugging.');
  }
  // The native backend has no GDB target address/port (cortex-debug manages
  // the server connection itself) but J-Link requires a device name.
  if (input.backend !== 'cortex-native') {
    if (!input.gdbAddress) {
      return fail('no-gdb-address', 'Debug manager: GDB address is required before applying or debugging.');
    }
    if (!input.gdbPort) {
      return fail('no-gdb-port', 'Debug manager: GDB port is required before applying or debugging.');
    }
  } else if (input.runnerName === 'jlink' && !input.device) {
    return fail('no-device', 'Debug manager: Device name is required for J-Link. Enter the SEGGER device name (e.g. STM32F429ZI, EFR32MG24BxxxF1536).');
  }
  return undefined;
}

/** True when the build's Kconfig lets a debugger see the Zephyr threads. */
function hasThreadInfo(project: ZephyrApplication, buildConfig: ZephyrBuildConfig, domain?: string): boolean {
  try {
    return buildConfig.getKConfigValue(project, 'DEBUG_THREAD_INFO', domain) === 'y';
  } catch {
    return false;
  }
}

/** The entry of a Cortex-Debug backend, rebuilt from scratch so no key of another backend survives. */
async function buildCortexEntry(
  input: DebugSetupInput, buildConfig: ZephyrBuildConfig, existing: any,
): Promise<{ entry: any } | { failure: DebugSetupResult }> {
  const { project, domain } = input;
  const runner = getRunner(input.runnerName as string)!;
  const name = typeof existing?.name === 'string' && existing.name.length > 0
    ? existing.name
    : getDebugLaunchConfigurationName(project, buildConfig.name, domain);
  const cwd = typeof existing?.cwd === 'string' && existing.cwd.length > 0
    ? existing.cwd
    : '${workspaceFolder}';

  if (input.backend === 'cortex-west') {
    // The Cortex-Debug client is ARM oriented. QEMU boards for other
    // architectures (x86, RISC-V, ...) must use the C/C++ (cppdbg) backend,
    // which is architecture agnostic. Allow it when the arch is unknown so we
    // never block a valid ARM board on missing metadata.
    if (runner.name === 'qemu') {
      const arch = input.targetArch?.toLowerCase();
      if (arch && arch !== 'arm' && arch !== 'arm64') {
        return { failure: fail('qemu-not-arm', 'Debug manager: QEMU debugging with the Cortex-Debug backend is only supported for ARM boards. Use the C/C++ Debug (cppdbg) backend for this board.') };
      }
    }
    runner.loadArgs(input.runnerArgs);
    runner.serverPath = input.runnerPath;
    runner.serverAddress = input.gdbAddress;
    runner.serverPort = input.gdbPort;
    let debugServerArgs = getWestDebugArgsForProject(runner, project, buildConfig, domain);
    debugServerArgs = runnerPathArg(debugServerArgs, runner.name, input.runnerPath);
    const entry = buildCortexWestLaunchConfig({
      name,
      cwd,
      programPath: input.programPath,
      svdPath: input.svdPath,
      gdbPath: input.gdbPath,
      gdbMode: input.gdbMode,
      gdbAddress: input.gdbAddress,
      gdbPort: input.gdbPort,
    }, debugServerArgs);
    if (runner.name === 'qemu') {
      // `west build -t debugserver_qemu` may recompile before QEMU starts,
      // so give the server-ready wait extra headroom over the default.
      entry.serverReadyTimeout = 60000;
    }
    return { entry };
  }

  const nativeServer = runnerNameToNativeServer(input.runnerName);
  if (!nativeServer) {
    return { failure: fail('not-native-runner', 'Debug manager: select J-Link or ST-LINK GDB Server for the native Cortex-Debug backend.') };
  }
  let serverPath = typeof input.runnerPath === 'string' ? input.runnerPath.trim() : '';
  let stm32CubeProgrammerDir: string | undefined;
  if (nativeServer === 'stlink') {
    const stlinkRunner = new StlinkGdbserver();
    try {
      await stlinkRunner.loadInternalArgs();
    } catch {
      // CubeCLT probing is best effort; cortex-debug falls back to its settings.
    }
    if (!serverPath) {
      serverPath = stlinkRunner.serverPath ?? '';
    }
    stm32CubeProgrammerDir = stlinkRunner.findCubeCltFile('STM32CubeProgrammer', 'bin');
  }
  const entry = buildCortexNativeLaunchConfig({
    name,
    cwd,
    programPath: input.programPath,
    svdPath: input.svdPath,
    gdbPath: input.gdbPath,
    gdbMode: input.gdbMode,
    server: nativeServer,
    device: input.device,
    interface: input.deviceInterface === 'jtag' ? 'jtag' : 'swd',
    serverPath,
    serverArgs: input.runnerArgs,
    stm32CubeProgrammerDir,
  });
  // J-Link's Zephyr RTOS plugin shows the threads, which needs the thread
  // information the build keeps only with CONFIG_DEBUG_THREAD_INFO.
  if (nativeServer === 'jlink' && hasThreadInfo(project, buildConfig, domain)) {
    entry.rtos = 'Zephyr';
  }
  return { entry };
}

/** Fill the cppdbg entry in place, as the Debug Manager always has, and return it. */
async function buildCppdbgEntry(
  input: DebugSetupInput, buildConfig: ZephyrBuildConfig, launchJson: any, found: any, hooks: DebugSetupHooks,
): Promise<any> {
  const { project, domain } = input;
  let config = found;
  if (config?.type && config.type !== 'cppdbg') {
    // Switching back to the cppdbg backend: rebuild the template entry,
    // then let the historical mutation block below fill the panel fields.
    const configIndex = launchJson.configurations.indexOf(config);
    config = await createLaunchConfiguration(project, buildConfig.name, hooks.artifacts, domain, { silent: hooks.silent });
    if (configIndex >= 0) {
      launchJson.configurations[configIndex] = config;
    } else {
      launchJson.configurations.push(config);
    }
  }
  config.program = input.programPath;
  config.svdPath = input.svdPath ? input.svdPath : '';
  config.miDebuggerPath = input.gdbPath;

  const runner = getRunner(input.runnerName as string)!;
  runner.loadArgs(input.runnerArgs);
  runner.serverPath = input.runnerPath;
  runner.serverAddress = input.gdbAddress;
  runner.serverPort = input.gdbPort;
  config.serverStarted = runner.serverStartedPattern;
  config.debugServerArgs = getWestDebugArgsForProject(runner, project, buildConfig, domain);
  config.debugServerArgs = runnerPathArg(config.debugServerArgs, runner.name, input.runnerPath);
  config.setupCommands = [];
  for (const arg of getSetupCommands(input.programPath, runner.serverAddress, runner.serverPort, input.gdbMode, runner.name)) {
    config.setupCommands.push(arg);
  }
  // pyOCD requires specialized GDB configuration with specific setup commands
  if (runner.name === 'pyocd' && runner.serverAddress && runner.serverPort) {
    const configIndex = launchJson.configurations.indexOf(config);
    config = pyocdLaunchJson(config, runner.serverAddress, runner.serverPort);
    if (configIndex >= 0) {
      launchJson.configurations[configIndex] = config;
    }
  }
  return config;
}

/** The OpenOCD gdb.cfg createOpenocdCfg writes for a build configuration. */
function gdbCfgPath(project: ZephyrApplication, buildConfig: ZephyrBuildConfig): string {
  return path.join(buildConfig.getInternalDebugDir(project), 'gdb.cfg');
}

/**
 * Apply the Debug Manager form: check it, build the entry of its backend in
 * the application's launch.json, and write launch.json with the west wrapper
 * (cppdbg) and the OpenOCD gdb.cfg (west backends). Nothing is written when a
 * check fails, when pyOCD has no support for the target, or when beforeWrite
 * says no.
 */
export async function applyDebugSetup(input: DebugSetupInput, hooks: DebugSetupHooks): Promise<DebugSetupResult> {
  const refused = checkForm(input);
  if (refused) {
    return refused;
  }
  const { project, buildConfig, domain, backend } = input;
  if (!buildConfig) {
    return fail('no-build-config');
  }
  if (backend !== 'cppdbg' && !(await hooks.ensureCortexDebug())) {
    return fail('no-cortex-debug');
  }

  if (!hooks.load) {
    // getLaunchConfiguration starts from a fresh launch.json when the file
    // cannot be read, and writing that would delete every other entry.
    const file = readLaunchJsonFile(project);
    if (file.unreadable) {
      return fail('launch-json-unreadable', `Debug manager: ${file.path} is not valid JSON. Fix it by hand, then apply again.`);
    }
  }
  const [launchJson, found] = hooks.load
    ? await hooks.load()
    : await getLaunchConfiguration(project, buildConfig.name, false, hooks.artifacts, domain, { silent: hooks.silent });

  let entry: any;
  if (backend === 'cppdbg') {
    entry = await buildCppdbgEntry(input, buildConfig, launchJson, found, hooks);
  } else {
    const built = await buildCortexEntry(input, buildConfig, found);
    if ('failure' in built) {
      return built.failure;
    }
    entry = built.entry;
    const existingIndex = launchJson.configurations.indexOf(found);
    if (existingIndex >= 0) {
      launchJson.configurations[existingIndex] = entry;
    } else {
      launchJson.configurations.push(entry);
    }
  }

  const runnerName = input.runnerName as string;
  // The west debug server keeps the same runner-side requirements for both
  // west backends (generated openocd cfg, pyocd target pack); only cppdbg
  // needs the west wrapper script.
  const westBackend = backend === 'cppdbg' || backend === 'cortex-west';
  // Failed or cancelled target-pack setup: don't write launch.json or let the
  // caller start a session that cannot connect.
  if (westBackend && runnerName === 'pyocd' && !(await hooks.preparePyOCDTarget())) {
    return fail('pyocd-target');
  }

  const files: string[] = [];
  const wrapperPath = backend === 'cppdbg' ? getWestWrapperPath(project, buildConfig) : undefined;
  if (wrapperPath) {
    files.push(wrapperPath);
  }
  if (westBackend && runnerName === 'openocd') {
    files.push(gdbCfgPath(project, buildConfig));
  }
  const launchJsonPath = getLaunchJsonPath(project);
  files.push(launchJsonPath);
  const plan: DebugSetupPlan = { launchJson, entry, launchJsonPath, files };

  if (hooks.beforeWrite && !(await hooks.beforeWrite(plan))) {
    return { ok: true, written: false, plan };
  }
  if (backend === 'cppdbg') {
    createWestWrapper(project, buildConfig.name);
  }
  if (westBackend && runnerName === 'openocd') {
    createOpenocdCfg(project, buildConfig.name);
  }
  writeLaunchJson(launchJson, project);
  return { ok: true, written: true, plan };
}

// Reading the entries of an application.

/** The debug backend a launch.json entry runs with, from its type. */
export function backendOfEntry(entry: any): DebugBackendId | undefined {
  switch (entry?.type) {
    case 'cppdbg':
      return 'cppdbg';
    case ZW_DEBUG_TYPE:
      return 'cortex-west';
    case 'cortex-debug':
      return 'cortex-native';
    default:
      return undefined;
  }
}

/** The Debug Manager fields of an entry, as the panel shows them. */
export function debugEntryFields(entry: any): Record<string, unknown> {
  const state = readPanelStateFromConfig(entry);
  let runnerPath = state.runnerPath;
  let runnerArgs = state.runnerArgs;
  if (state.backend !== 'cortex-native' && state.runnerName && state.debugServerArgs) {
    const runner = getRunner(state.runnerName);
    if (runner) {
      runner.loadArgs(state.debugServerArgs);
      runnerPath = runner.serverPath;
      runnerArgs = runner.userArgs;
    }
  }
  const native = state.backend === 'cortex-native';
  return {
    backend: state.backend,
    ...(state.runnerName ? { runner: state.runnerName } : {}),
    mode: state.gdbMode,
    program_path: state.programPath,
    svd_path: state.svdPath,
    gdb_path: state.gdbPath,
    ...(native ? {} : { gdb_address: state.gdbAddress, gdb_port: Number(state.gdbPort) || state.gdbPort }),
    ...(runnerPath ? { runner_path: runnerPath } : {}),
    ...(runnerArgs ? { runner_args: runnerArgs } : {}),
    ...(native ? { device: state.device ?? '', interface: state.deviceInterface ?? 'swd' } : {}),
    ...(typeof entry?.rtos === 'string' ? { rtos: entry.rtos } : {}),
  };
}

export interface LaunchJsonFile {
  path: string;
  exists: boolean;
  /** The parsed file, with a configurations array; undefined when missing or unreadable. */
  launchJson?: any;
  /** Only the tolerant parser could read it: comments and trailing commas are lost when it is written. */
  hasComments: boolean;
  /** The file exists but is not JSON, so nothing may overwrite it. */
  unreadable: boolean;
  /** The text read, to notice a change made after it. */
  text?: string;
}

/** Read an application's launch.json as VS Code does, comments included. */
export function readLaunchJsonFile(project: ZephyrApplication): LaunchJsonFile {
  const file = getLaunchJsonPath(project);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { path: file, exists: false, hasComments: false, unreadable: false };
  }
  if (raw.trim().length === 0) {
    return { path: file, exists: true, hasComments: false, unreadable: false, text: raw };
  }
  const parsed = parseLaunchJsonText(raw);
  if (!parsed) {
    return { path: file, exists: true, hasComments: false, unreadable: true, text: raw };
  }
  if (!Array.isArray(parsed.launchJson.configurations)) {
    parsed.launchJson.configurations = [];
  }
  return { path: file, exists: true, launchJson: parsed.launchJson, hasComments: !parsed.strict, unreadable: false, text: raw };
}

export interface DebugEntryInfo {
  name: string;
  /** Its index in launch.json's configurations. */
  index: number;
  entry: any;
  type?: string;
  backend?: DebugBackendId;
  configName?: string;
  domain?: string;
  runner?: string;
  mode: GdbMode;
  gdbPort?: string;
  program: string;
  /** Its build configuration no longer exists. */
  stale: boolean;
  /**
   * Written under an older name the Debug Manager renames when it opens the
   * configuration: a sysbuild entry without its domain, or a west workspace
   * application's entry named as for a freestanding application.
   */
  legacy?: 'no-domain' | 'freestanding-name';
}

const isFreestandingStyleName = (name: string): boolean =>
  name === ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME || name.startsWith(`${ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME} [`);

/** The default domain of a sysbuild configuration, or undefined for a single image or one not built. */
export function defaultDebugDomain(project: ZephyrApplication, buildConfig: ZephyrBuildConfig): string | undefined {
  if (!buildConfig.isSysbuild()) {
    return undefined;
  }
  return readDomainsForBuildDir(buildConfig.getBuildDir(project))?.defaultDomain;
}

/**
 * The Workbench entries of an application in its launch.json: those named
 * for it, and the legacy names the Debug Manager adopts, which a west
 * workspace application shares with the others of its workspace.
 */
export function listApplicationDebugEntries(project: ZephyrApplication, launchJson: any): DebugEntryInfo[] {
  const configurations: unknown[] = Array.isArray(launchJson?.configurations) ? launchJson.configurations : [];
  const configNames = new Set(project.buildConfigs.map(config => config.name));
  const out: DebugEntryInfo[] = [];
  configurations.forEach((entry: any, index) => {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') {
      return;
    }
    const name: string = entry.name;
    const configName = extractDebugBuildConfigName(name);
    let legacy: DebugEntryInfo['legacy'];
    if (!isLaunchConfigurationForApplication(project, entry)) {
      // A west workspace application once wrote freestanding names into the
      // shared file; the application with that configuration adopts them.
      if (!project.isWestWorkspaceApplication || !isFreestandingStyleName(name) || !configName || !configNames.has(configName)) {
        return;
      }
      legacy = 'freestanding-name';
    }
    const buildConfig = configName ? project.getBuildConfiguration(configName) : undefined;
    let domain = extractDebugDomainName(name);
    if (!domain && buildConfig) {
      // A sysbuild entry saved before domains were named in entries debugs the default domain.
      const fallback = defaultDebugDomain(project, buildConfig);
      if (fallback) {
        domain = fallback;
        legacy = legacy ?? 'no-domain';
      }
    }
    const state = readPanelStateFromConfig(entry);
    const backend = backendOfEntry(entry);
    out.push({
      name,
      index,
      entry,
      ...(typeof entry.type === 'string' ? { type: entry.type } : {}),
      ...(backend ? { backend } : {}),
      ...(configName ? { configName } : {}),
      ...(domain ? { domain } : {}),
      ...(state.runnerName ? { runner: state.runnerName } : {}),
      mode: state.gdbMode,
      ...(backend === 'cortex-native' ? {} : { gdbPort: state.gdbPort }),
      program: state.programPath,
      stale: !buildConfig,
      ...(legacy ? { legacy } : {}),
    });
  });
  return out;
}

/**
 * The entry the Debug Manager uses for a configuration and domain: the one of
 * its name, else a legacy one it would adopt.
 */
export function findApplicationDebugEntry(
  project: ZephyrApplication, entries: readonly DebugEntryInfo[], buildConfig: ZephyrBuildConfig, domain?: string,
): DebugEntryInfo | undefined {
  const wanted = getDebugLaunchConfigurationName(project, buildConfig.name, domain);
  const exact = entries.find(entry => entry.name === wanted);
  if (exact) {
    return exact;
  }
  if (domain && defaultDebugDomain(project, buildConfig) === domain) {
    const unsuffixed = getDebugLaunchConfigurationName(project, buildConfig.name);
    const legacy = entries.find(entry => entry.name === unsuffixed);
    if (legacy) {
      return legacy;
    }
  }
  if (project.isWestWorkspaceApplication) {
    const legacyName = getFreestandingDebugLaunchConfigurationName(buildConfig.name);
    return entries.find(entry => entry.name === legacyName);
  }
  return undefined;
}

export interface PyOCDTargetSupport {
  /** The pyOCD target the build's runners.yaml names. */
  target?: string;
  /** Whether pyOCD lists it; undefined when pyOCD could not be run. */
  installed?: boolean;
  error?: string;
}

/**
 * Whether pyOCD has support for the build's target, read from pyOCD's own
 * target list in the venv the session will use. Downloads nothing.
 */
export async function checkPyOCDTargetSupport(
  project: ZephyrApplication, buildConfig: ZephyrBuildConfig, domain?: string,
): Promise<PyOCDTargetSupport> {
  let target: string | undefined;
  try {
    target = buildConfig.getPyOCDTarget(project, domain);
  } catch {
    target = undefined;
  }
  if (!target) {
    return {};
  }
  try {
    return { target, installed: await checkPyOCDTarget(target, getDebugSessionVenvPath(project)) };
  } catch (error) {
    return { target, error: error instanceof Error ? error.message : String(error) };
  }
}
