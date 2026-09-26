// Everything the tool handlers need from the workbench, in one place.
//
// This is the only layer that knows both the MCP contract and the workbench
// internals, which keeps the handlers short and keeps `src/mcp/core` free of
// any `vscode` import.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY } from '../../constants';
import { RustToolchainInstallation, ToolchainVariantId } from '../../models/ToolchainInstallations';
import { ZephyrApplication } from '../../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../../models/ZephyrBuildConfig';
import { WestWorkspace } from '../../models/WestWorkspace';
import {
  getAllZephyrSdkInstallations, getRegisteredArmGnuToolchainInstallations, getRegisteredIarToolchainInstallations,
  getRegisteredRustToolchainInstallations, getWestWorkspace, getWestWorkspaces,
} from '../../utils/utils';
import { checkHostTools } from '../../utils/installUtils';
import { collectHostToolsStatus, HostToolsStatus } from '../../utils/hostToolsStatusCollector';
import { macDeveloperToolsMissing } from '../../utils/macDeveloperTools';
import { collectDebugToolsStatus, DebugToolStatus, loadDebugToolsManifest } from '../../utils/debugTools/debugToolStatusUtils';
import { DebugToolsManifest } from '../../utils/debugTools/debugToolVersionUtils';
import { BuildReportPaths } from '../../utils/zephyr/buildReport';
import { readDomainsForBuildDir } from '../../utils/zephyr/domainsYamlUtils';
import { addExtraConfFile, AddExtraConfFileResult } from '../../utils/kconfig/extraConfFileSettings';
import { resolveEffectiveVenv } from '../../utils/env/venvResolution';
import { getConfiguredWorkbenchPath, resolveConfiguredPath, sanitizeConfiguredVenvPath } from '../../utils/execUtils';
import { IntelliSenseProviderId, isClangdInstalled, isCppToolsInstalled } from '../../utils/intellisense/providerAvailability';
import { checkSdkCompatibility, formatSdkCompatMessage } from '../../utils/zephyr/sdkCompatUtils';
import { getWorkspaceApplicationPathSetting } from '../../utils/zephyr/workspaceApplications';
import { KconfigEditorInfo, KconfigManagerPanel } from '../../panels/KconfigManagerPanel';
import { assertConfigName, assertInside, isInside, normalizeForCompare } from '../core/argSafety';
import { McpToolError } from '../core/errors';
import { KeyedMutex } from '../core/keyedMutex';
import { logSafe } from '../core/redact';
import { chooseWestWorkspaceRoot } from '../core/westWorkspaceChoice';
import { findExternalRun } from './buildConflicts';
import { CatalogSources } from './catalogSources';

export interface ResolvedTarget {
  app: ZephyrApplication;
  config: ZephyrBuildConfig;
  buildDir: string;
}

export interface AppConfigDto {
  name: string;
  active: boolean;
  board: string;
  sysbuild: boolean;
  build_dir: string;
  configured: boolean;
  built: boolean;
  default_runner?: string;
  runner_args?: string;
  west_args?: string;
  west_flags?: string[];
  env?: Record<string, unknown>;
}

export type AppToolchainFamily = 'zephyr_sdk' | 'global_sdk' | 'arm_gnu' | 'iar' | 'rust';

/** The toolchain of an application, named the way configure and manage_app take it. */
export interface AppToolchainDto {
  family: AppToolchainFamily;
  /** The toolchain root as list_toolchains reports it; absent for the global SDK, or when the stored one is not registered. */
  path?: string;
  /** The compiler suite of a Zephyr SDK: gnu or llvm. */
  variant?: 'gnu' | 'llvm';
  /** The application uses whichever global Zephyr SDK the build finds. */
  global_sdk: boolean;
  /** The Zephyr SDK version the application builds with, when it uses one. */
  sdk_version?: string;
  /** For a Rust toolchain, the C toolchain it is linked to. */
  c_toolchain?: { family: 'zephyr_sdk' | 'global_sdk' | 'arm_gnu'; path?: string };
  /** The settings name a toolchain that is not registered any more. */
  missing?: true;
}

export interface AppDto {
  app_path: string;
  name: string;
  kind: 'freestanding' | 'workspace';
  west_workspace?: string;
  toolchain: AppToolchainDto;
  /** Whether the Zephyr SDK suits the Zephyr version of the west workspace, when both are known. */
  sdk_compat?: { status: string; zephyr_version?: string; recommended_sdk?: string; message?: string };
  intellisense_provider: { name: IntelliSenseProviderId; installed: boolean };
  /** The Python environment builds use: the application's own, its west workspace's, or the global one. */
  venv: { path?: string; source: 'app' | 'west_workspace' | 'global' };
  configs: AppConfigDto[];
}

/**
 * What an application DTO is built from: a ZephyrApplication, or the
 * settings file of an application folder VS Code has not opened yet.
 */
export interface AppFacts {
  appRootPath: string;
  appName: string;
  kind: 'freestanding' | 'workspace';
  westWorkspaceRoot?: string;
  toolchainVariant: ToolchainVariantId;
  isGlobalSdk: boolean;
  zephyrSdkPath?: string;
  zephyrSdkVersion?: string;
  /** The registered Arm GNU or IAR toolchain the settings name, found. */
  armGnuPath?: string;
  iarPath?: string;
  rust?: RustToolchainInstallation;
  /** The settings name a Rust toolchain that is not registered any more. */
  rustMissing?: boolean;
  intellisenseProvider: IntelliSenseProviderId;
  /** The application's own venv.path, resolved, if it sets one. */
  ownVenvPath?: string;
  /**
   * The venv builds export as PYTHON_VENV_PATH (ZephyrApplication.venvPath):
   * the own one, else the venv.path in effect for the application or its
   * west workspace, else the workspace's .venv. Undefined when builds fall
   * back to the global venv.
   */
  venvPath?: string;
  /** The folder the application's settings resolve against. */
  scope: vscode.WorkspaceFolder;
}

function sdkFamily(isGlobalSdk: boolean): 'zephyr_sdk' | 'global_sdk' {
  return isGlobalSdk ? 'global_sdk' : 'zephyr_sdk';
}

function toolchainDtoOf(facts: AppFacts): AppToolchainDto {
  const sdkBased = facts.toolchainVariant === 'zephyr' || facts.toolchainVariant === 'zephyr/llvm';
  const common = {
    global_sdk: facts.isGlobalSdk,
    ...(facts.zephyrSdkVersion ? { sdk_version: facts.zephyrSdkVersion } : {}),
  };
  const variant = sdkBased ? { variant: facts.toolchainVariant === 'zephyr/llvm' ? 'llvm' as const : 'gnu' as const } : {};
  if (facts.rust || facts.rustMissing) {
    const cFamily = facts.toolchainVariant === 'gnuarmemb' ? 'arm_gnu' as const : sdkFamily(facts.isGlobalSdk);
    const cPath = cFamily === 'arm_gnu' ? facts.armGnuPath : cFamily === 'zephyr_sdk' ? facts.zephyrSdkPath : undefined;
    return {
      family: 'rust',
      ...(facts.rust ? { path: facts.rust.toolchainPath } : { missing: true }),
      ...variant,
      ...common,
      c_toolchain: { family: cFamily, ...(cPath ? { path: cPath } : {}) },
    };
  }
  if (facts.toolchainVariant === 'gnuarmemb') {
    return { family: 'arm_gnu', ...(facts.armGnuPath ? { path: facts.armGnuPath } : { missing: true }), ...common };
  }
  if (facts.toolchainVariant === 'iar') {
    return { family: 'iar', ...(facts.iarPath ? { path: facts.iarPath } : { missing: true }), ...common };
  }
  if (facts.isGlobalSdk) {
    return { family: 'global_sdk', ...variant, ...common };
  }
  const present = !!facts.zephyrSdkPath && fs.existsSync(facts.zephyrSdkPath);
  return {
    family: 'zephyr_sdk',
    ...(facts.zephyrSdkPath ? { path: facts.zephyrSdkPath } : {}),
    ...(present ? {} : { missing: true as const }),
    ...variant,
    ...common,
  };
}

function kernelPathOf(westWorkspaceRoot: string | undefined): string | undefined {
  if (!westWorkspaceRoot) {
    return undefined;
  }
  try {
    return getWestWorkspace(westWorkspaceRoot).kernelUri.fsPath;
  } catch {
    return undefined;
  }
}

function sdkCompatDtoOf(facts: AppFacts): AppDto['sdk_compat'] {
  const kernelPath = kernelPathOf(facts.westWorkspaceRoot);
  if (!facts.zephyrSdkVersion || !kernelPath) {
    return undefined;
  }
  const verdict = checkSdkCompatibility(facts.zephyrSdkVersion, kernelPath);
  const message = formatSdkCompatMessage(verdict, facts.zephyrSdkVersion);
  return {
    status: verdict.status,
    ...(verdict.zephyrVersion ? { zephyr_version: verdict.zephyrVersion } : {}),
    ...(verdict.recommendedSdk ? { recommended_sdk: verdict.recommendedSdk } : {}),
    ...(message ? { message } : {}),
  };
}

/** The venv.path a west workspace folder sets for itself, or the <root>/.venv it would detect. */
function westWorkspaceVenvOf(root: string): string | undefined {
  const rootUri = vscode.Uri.file(root);
  const own = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, rootUri)
    .inspect?.<string>(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY)?.workspaceFolderValue;
  // An SPDX-only venv is skipped for builds, as WestWorkspace does.
  if (typeof own === 'string' && sanitizeConfiguredVenvPath(own)) {
    return resolveConfiguredPath(own, rootUri) ?? own;
  }
  const detected = path.join(root, '.venv');
  return fs.existsSync(detected) ? detected : undefined;
}

/**
 * The venv the builds of a freestanding application use, as
 * ZephyrApplication.venvPath resolves it, for a folder VS Code has not opened
 * yet: its own venv.path, else the one in effect at its scope (user level
 * included), else its west workspace's venv.
 */
export function freestandingVenvPathOf(ownVenvPath: string | undefined, scope: vscode.WorkspaceFolder, westWorkspaceRoot?: string): string | undefined {
  const effective = ownVenvPath ?? getConfiguredWorkbenchPath(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY, scope);
  if (effective || !westWorkspaceRoot) {
    return effective;
  }
  try {
    return getWestWorkspace(westWorkspaceRoot).venvPath;
  } catch {
    return undefined;
  }
}

/** The venv builds use, and whose it is: a user level venv.path the workspace does not set is the global one. */
function venvDtoOf(facts: AppFacts): AppDto['venv'] {
  if (facts.ownVenvPath) {
    return { path: facts.ownVenvPath, source: 'app' };
  }
  if (facts.venvPath) {
    const workspaceVenv = facts.westWorkspaceRoot ? westWorkspaceVenvOf(facts.westWorkspaceRoot) : undefined;
    const fromWorkspace = !!workspaceVenv && normalizeForCompare(workspaceVenv) === normalizeForCompare(facts.venvPath);
    return { path: facts.venvPath, source: fromWorkspace ? 'west_workspace' : 'global' };
  }
  const global = resolveEffectiveVenv(undefined, facts.scope).path;
  return { ...(global ? { path: global } : {}), source: 'global' };
}

/** An application's DTO from its facts and its configurations. Reads no credential, such as an IAR token. */
export function appDtoOf(facts: AppFacts, configs: AppConfigDto[]): AppDto {
  const sdkCompat = sdkCompatDtoOf(facts);
  return {
    app_path: facts.appRootPath,
    name: facts.appName,
    kind: facts.kind,
    ...(facts.westWorkspaceRoot ? { west_workspace: facts.westWorkspaceRoot } : {}),
    toolchain: toolchainDtoOf(facts),
    ...(sdkCompat ? { sdk_compat: sdkCompat } : {}),
    intellisense_provider: {
      name: facts.intellisenseProvider,
      installed: facts.intellisenseProvider === 'clangd' ? isClangdInstalled() : isCppToolsInstalled(),
    },
    venv: venvDtoOf(facts),
    configs,
  };
}

/** The venv.path the application itself sets, resolved: its west workspace entry, or its own folder settings. */
function ownVenvPathOf(app: ZephyrApplication): string | undefined {
  const folder = app.appWorkspaceFolder;
  if (app.workspaceApplicationSettings) {
    return getWorkspaceApplicationPathSetting(app.workspaceApplicationSettings, ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY, folder) || undefined;
  }
  const inspected = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, folder)
    .inspect?.<string>(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY);
  // In a window with a single folder, its settings are the workspace settings.
  const own = inspected?.workspaceFolderValue ?? (vscode.workspace.workspaceFile ? undefined : inspected?.workspaceValue);
  return typeof own === 'string' && own.trim().length > 0 ? resolveConfiguredPath(own, folder) ?? own : undefined;
}

function isTruthy(value: unknown): boolean {
  return typeof value === 'string' ? value.toLowerCase() === 'true' : Boolean(value);
}

export type EnvironmentDepth = 'quick' | 'full';

export class HostServices {
  private readonly settingsLock = new KeyedMutex();
  /** Boards, shields, snippets and samples, cached for this window. */
  readonly catalog = new CatalogSources();
  /**
   * Environment probes in flight, by what they probe. Two agents asking at
   * once share one run instead of doubling every spawn.
   */
  private readonly inflight = new Map<string, Promise<unknown>>();

  /** The extension's own folder: the installer scripts, tools.yml and debug-tools.yml live there. */
  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Every application in this window. */
  async listApplications(): Promise<ZephyrApplication[]> {
    return ZephyrApplication.getApplications(vscode.workspace.workspaceFolders ?? []);
  }

  /** Folders this window is allowed to touch. */
  async knownRoots(): Promise<string[]> {
    const apps = await this.listApplications();
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    return [...new Set([
      ...apps.map(a => a.appRootPath),
      ...folders,
      ...getWestWorkspaces().map(w => w.rootUri.fsPath),
    ])];
  }

  /**
   * Resolve `app_path`. Omitting it is only allowed when there is exactly one
   * application, because silently picking one of several is how an agent
   * builds the wrong thing.
   */
  async resolveApp(appPath?: string): Promise<ZephyrApplication> {
    const apps = await this.listApplications();
    if (!appPath) {
      if (apps.length === 1) {
        return apps[0];
      }
      if (apps.length === 0) {
        throw new McpToolError('APP_NOT_FOUND', 'This VS Code window has no Zephyr application.', {
          hint: 'Open a Zephyr application folder in VS Code, then call list_apps.',
        });
      }
      throw new McpToolError('AMBIGUOUS_APP',
        `This window has ${apps.length} applications, so app_path is required.`, {
          hint: 'Call list_apps and pass the app_path you want.',
          details: { candidates: apps.map(a => a.appRootPath) },
        });
    }
    const roots = await this.knownRoots();
    assertInside(appPath, roots, 'app_path');
    const wanted = normalizeForCompare(appPath);
    const exact = apps.find(a => normalizeForCompare(a.appRootPath) === wanted);
    if (exact) {
      return exact;
    }
    // A file or folder inside an application means that application. The
    // deepest root wins, so an app nested in a west workspace beats the workspace.
    const containing = apps
      .filter(a => isInside(appPath, a.appRootPath))
      .sort((a, b) => b.appRootPath.length - a.appRootPath.length)[0];
    if (containing) {
      return containing;
    }
    // Never a lenient UI lookup here: it can pick a different application and
    // it shows VS Code notifications carrying the agent's text.
    throw new McpToolError('APP_NOT_FOUND', `No Zephyr application at "${logSafe(appPath, 300)}".`, {
      hint: 'Call list_apps and pass one of the app_path values it returns.',
      details: { candidates: apps.map(a => a.appRootPath) },
    });
  }

  /** Resolve a build configuration, defaulting to the active one. */
  resolveConfig(app: ZephyrApplication, configName?: string): ZephyrBuildConfig {
    if (configName) {
      assertConfigName(configName);
      const found = app.buildConfigs.find(c => c.name === configName);
      if (!found) {
        throw new McpToolError('CONFIG_NOT_FOUND',
          `Application "${app.appRootPath}" has no build configuration "${configName}".`, {
            hint: 'Call list_apps to see the configurations this application has.',
            details: { available: app.buildConfigs.map(c => c.name) },
          });
      }
      return found;
    }
    // The same rule the UI uses: the active configuration, else the first.
    const chosen = app.buildConfigs.find(c => c.active) ?? app.buildConfigs[0];
    if (!chosen) {
      throw new McpToolError('CONFIG_NOT_FOUND',
        `Application "${app.appRootPath}" has no build configuration.`, {
          hint: 'Create one with configure, target "build_config" and action "create".',
        });
    }
    return chosen;
  }

  async resolveTarget(appPath?: string, configName?: string): Promise<ResolvedTarget> {
    const app = await this.resolveApp(appPath);
    const config = this.resolveConfig(app, configName);
    return { app, config, buildDir: config.getBuildDir(app) };
  }

  /**
   * Run `work` alone for the settings file of `app`. Every build configuration
   * writer rewrites a whole array, so two agent calls writing one file at once
   * would drop a change. A west workspace shares one file across its apps.
   */
  withSettingsLock<T>(app: ZephyrApplication, work: () => Promise<T>): Promise<T> {
    return this.withFolderSettingsLock(app.appWorkspaceFolder.uri.fsPath, work);
  }

  /**
   * Run `work` alone for the .vscode/settings.json of `folderPath`, the same
   * lock withSettingsLock takes for an application in that folder. For a
   * folder that is not an application yet, such as one being created.
   */
  withFolderSettingsLock<T>(folderPath: string, work: () => Promise<T>): Promise<T> {
    return this.settingsLock.run(normalizeForCompare(folderPath), work);
  }

  /**
   * Run `work` alone for the toolchain lists in the user settings: each
   * writer rewrites a whole list, so two installs finishing at once would
   * drop one of them.
   */
  withToolchainSettingsLock<T>(work: () => Promise<T>): Promise<T> {
    // Never a path, so it cannot collide with a folder's key.
    return this.settingsLock.run('user-settings:toolchains', work);
  }

  /** A task the user started from VS Code on this configuration, if one runs. */
  externalRun(appRootPath: string, configName: string): vscode.TaskExecution | undefined {
    return findExternalRun(appRootPath, configName);
  }

  /** True when the build directory has been configured by CMake at least once. */
  isConfigured(buildDir: string): boolean {
    return fs.existsSync(`${buildDir}/CMakeCache.txt`);
  }

  isBuilt(app: ZephyrApplication, config: ZephyrBuildConfig): boolean {
    const elf = config.getBuildArtifactPath(app, 'zephyr', 'zephyr.elf');
    return !!elf && fs.existsSync(elf);
  }

  toConfigDto(app: ZephyrApplication, config: ZephyrBuildConfig): AppConfigDto {
    const buildDir = config.getBuildDir(app);
    return {
      name: config.name,
      active: Boolean(config.active),
      board: config.boardIdentifier,
      sysbuild: isTruthy(config.sysbuild),
      build_dir: buildDir,
      configured: this.isConfigured(buildDir),
      built: this.isBuilt(app, config),
      ...(config.defaultRunner ? { default_runner: config.defaultRunner } : {}),
      ...(config.customArgs ? { runner_args: config.customArgs } : {}),
      ...(config.westArgs ? { west_args: config.westArgs } : {}),
      ...(config.westFlagsD?.length ? { west_flags: config.westFlagsD } : {}),
      ...(config.envVars && Object.keys(config.envVars).length ? { env: config.envVars } : {}),
    };
  }

  toAppDto(app: ZephyrApplication): AppDto {
    return appDtoOf({
      appRootPath: app.appRootPath,
      appName: app.appName,
      kind: app.isWestWorkspaceApplication ? 'workspace' : 'freestanding',
      westWorkspaceRoot: app.westWorkspaceRootPath || undefined,
      toolchainVariant: app.toolchainVariant,
      isGlobalSdk: app.isGlobalSdk,
      zephyrSdkPath: app.zephyrSdkPath || undefined,
      zephyrSdkVersion: app.zephyrSdkVersion,
      armGnuPath: app.selectedArmGnuToolchainInstallation?.toolchainPath,
      // Only the path: the installation also holds the IAR licence token.
      iarPath: app.selectedIarToolchainInstallation?.iarPath,
      rust: app.selectedRustToolchainInstallation,
      intellisenseProvider: app.intellisenseProvider,
      ownVenvPath: ownVenvPathOf(app),
      venvPath: app.venvPath,
      scope: app.appWorkspaceFolder,
    }, app.buildConfigs.map(config => this.toConfigDto(app, config)));
  }

  /** Folders that look like a Zephyr application but are not registered yet. */
  async findUnregisteredCandidates(apps: ZephyrApplication[]): Promise<string[]> {
    const known = new Set(apps.map(a => a.appRootPath));
    const hints: string[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = folder.uri.fsPath;
      if (!known.has(root) && fs.existsSync(`${root}/prj.conf`) && fs.existsSync(`${root}/CMakeLists.txt`)) {
        hints.push(root);
      }
    }
    return hints;
  }

  /**
   * Validate a sysbuild domain name against the build's own domains.yaml.
   * A domain given for a configuration that has none is an error rather than
   * something to ignore: ignoring it used to hand the agent the application's
   * data labelled as, say, mcuboot.
   */
  resolveDomain(app: ZephyrApplication, config: ZephyrBuildConfig, domain?: string): string | undefined {
    if (!domain) {
      return undefined;
    }
    const buildDir = config.getBuildDir(app);
    const parsed = readDomainsForBuildDir(buildDir);
    if (!parsed) {
      throw new McpToolError('INVALID_ARGUMENT',
        `domain "${domain}" was given, but "${buildDir}" has no domains.yaml. Only a sysbuild build has domains.`, {
          hint: 'Omit domain, or build a configuration with sysbuild enabled.',
        });
    }
    if (!parsed.domains.some(d => d.name === domain)) {
      throw new McpToolError('INVALID_ARGUMENT', `This build has no domain "${domain}".`, {
        hint: 'Use one of the domains listed in details, or omit domain for the default one.',
        details: { domains: parsed.domains.map(d => d.name), default: parsed.defaultDomain },
      });
    }
    return domain;
  }

  /** The domains of a sysbuild build, or undefined for a single-image build. */
  listDomains(app: ZephyrApplication, config: ZephyrBuildConfig) {
    const parsed = readDomainsForBuildDir(config.getBuildDir(app));
    return parsed
      ? { default: parsed.defaultDomain, domains: parsed.domains.map(d => ({ name: d.name, build_dir: d.buildDir })) }
      : undefined;
  }

  /** Every artifact path the report aggregator can read for one configuration and domain. */
  artifactPaths(app: ZephyrApplication, config: ZephyrBuildConfig, domain?: string): BuildReportPaths {
    // With no domain this probes the same shapes getBuildArtifactPath does.
    const at = (...segments: string[]) => config.getDomainBuildArtifactPath(app, domain, ...segments);
    return {
      buildDir: config.getBuildDir(app),
      elfPath: at('zephyr', 'zephyr.elf'),
      binPath: at('zephyr', 'zephyr.bin'),
      hexPath: at('zephyr', 'zephyr.hex'),
      mapPath: at('zephyr', 'zephyr.map'),
      dotConfigPath: at('zephyr', '.config'),
      cmakeCachePath: at('CMakeCache.txt'),
      buildInfoPath: at('build_info.yml'),
      metaPath: at('zephyr', 'zephyr.meta'),
      statPath: at('zephyr', 'zephyr.stat'),
      dtsPath: at('zephyr', 'zephyr.dts'),
      traceJsonPath: at('zephyr', '.config-trace.json'),
      devicetreeHeaderPath: at('zephyr', 'include', 'generated', 'zephyr', 'devicetree_generated.h'),
      westWorkspaceRoot: app.westWorkspaceRootPath,
      appRootPath: app.appRootPath,
    };
  }

  listWestWorkspaces(): WestWorkspace[] {
    return getWestWorkspaces();
  }

  /**
   * The west workspace a call means: the one `westWorkspace` names, or the
   * one the application `appPath` selects is linked to, or the only one the
   * window has. Only workspaces the window registers are accepted, because the
   * root becomes the working directory and environment of west.
   */
  async resolveWestWorkspace(westWorkspace?: string, appPath?: string): Promise<{ workspace: WestWorkspace; app?: ZephyrApplication }> {
    const app = appPath ? await this.resolveApp(appPath) : undefined;
    const folders = getWestWorkspaces();
    const apps = app ? [app] : await this.listApplications();
    const registered: string[] = [];
    for (const root of [...folders.map(w => w.rootUri.fsPath), ...apps.map(a => a.westWorkspaceRootPath)]) {
      if (root && !registered.some(known => normalizeForCompare(known) === normalizeForCompare(root))) {
        registered.push(root);
      }
    }
    const root = chooseWestWorkspaceRoot({
      requested: westWorkspace,
      application: app ? { appPath: app.appRootPath, westWorkspaceRoot: app.westWorkspaceRootPath || undefined } : undefined,
      registered,
      knownRoots: westWorkspace && !app ? await this.knownRoots() : [],
    });
    const open = folders.find(w => normalizeForCompare(w.rootUri.fsPath) === normalizeForCompare(root));
    if (open) {
      return { workspace: open, app };
    }
    try {
      return { workspace: getWestWorkspace(root), app };
    } catch (error) {
      // No .west folder, or a .west/config without a manifest section.
      throw new McpToolError('ENV_NOT_READY',
        `The west workspace "${root}" cannot be read: ${error instanceof Error ? error.message : String(error)}`, {
          hint: 'Ask the user to finish setting up that west workspace in Zephyr Workbench (west init and west update), then call get_status.',
        });
    }
  }

  async listSdks() {
    return getAllZephyrSdkInstallations();
  }

  /** Every other registered toolchain family. Each is independent, so one failing does not hide the rest. */
  async listOtherToolchains() {
    const settle = async <T>(read: () => Promise<T[]>): Promise<T[]> => {
      try {
        return await read();
      } catch {
        return [];
      }
    };
    const [armGnu, iar, rust] = await Promise.all([
      settle(getRegisteredArmGnuToolchainInstallations),
      settle(getRegisteredIarToolchainInstallations),
      settle(getRegisteredRustToolchainInstallations),
    ]);
    return { armGnu, iar, rust };
  }

  /**
   * Only whether the tools/ folder exists, which the installer creates before
   * it installs anything. Use hostToolsStatus('quick').complete to know the
   * install finished.
   */
  async hostToolsInstalled(): Promise<boolean> {
    try {
      return await checkHostTools();
    } catch {
      return false;
    }
  }

  private coalesce<T>(key: string, run: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key) as Promise<T> | undefined;
    if (running) {
      return running;
    }
    const started = run().finally(() => this.inflight.delete(key));
    this.inflight.set(key, started);
    return started;
  }

  /**
   * The host tools install. quick reads files only; full also runs the
   * installer's check mode and the presence probes, each bounded by timeoutMs.
   * A shared run takes no abort signal: one caller giving up must not cut
   * another caller's answer short.
   */
  hostToolsStatus(
    depth: EnvironmentDepth,
    timeoutMs?: number,
    opts: { developerToolsMissing?: boolean } = {},
  ): Promise<HostToolsStatus> {
    const key = `host-tools:${depth}${opts.developerToolsMissing ? ':no-developer-tools' : ''}`;
    return this.coalesce(key, () => collectHostToolsStatus(this.extensionUri, {
      versionCheck: depth === 'full',
      executionPolicy: depth === 'full',
      timeoutMs,
      developerToolsMissing: opts.developerToolsMissing,
    }));
  }

  /**
   * Whether the macOS Command Line Tools are known to be missing, in which
   * case /usr/bin/python3, git, make and gperf open the system install dialog
   * when run. Runs xcode-select, which never does; false off macOS.
   */
  async macDeveloperToolsMissing(): Promise<boolean> {
    try {
      return await macDeveloperToolsMissing();
    } catch {
      return false;
    }
  }

  /** debug-tools.yml as shipped with this version of the extension. Throws when it cannot be read. */
  debugToolsManifest(): DebugToolsManifest {
    return loadDebugToolsManifest(this.extensionUri);
  }

  /**
   * The flash and debug tools. full runs each version command, bounded by
   * timeoutMs, and starts none after `deadline` (epoch ms); quick only looks
   * at the filesystem. A shared run keeps the first caller's deadline, which
   * is never later than a second caller's own.
   */
  debugToolsStatus(
    depth: EnvironmentDepth,
    opts: { toolIds?: readonly string[]; timeoutMs?: number; deadline?: number } = {},
  ): Promise<DebugToolStatus[]> {
    const key = `debug-tools:${depth}:${opts.toolIds ? [...opts.toolIds].sort().join(',') : '*'}`;
    return this.coalesce(key, () => collectDebugToolsStatus({
      extensionUri: this.extensionUri,
      toolIds: opts.toolIds,
      probe: depth === 'full',
      timeoutMs: opts.timeoutMs,
      deadline: opts.deadline,
    }));
  }

  /** The Kconfig Manager tab on a build directory, if one is open, and whether it holds unsaved edits. */
  kconfigEditorState(buildDir: string): { open: boolean; dirty: boolean } | undefined {
    return KconfigManagerPanel.editorState(buildDir);
  }

  /** Every Kconfig Manager tab of the window, including one closed while its save prompt is open. */
  kconfigEditors(): KconfigEditorInfo[] {
    return KconfigManagerPanel.editors();
  }

  /** The name of a task the user started on this configuration, while it runs. */
  externalTaskName(app: ZephyrApplication, config: ZephyrBuildConfig): string | undefined {
    return findExternalRun(app.appRootPath, config.name)?.task.name;
  }

  /**
   * Add a Kconfig fragment to the configuration's EXTRA_CONF_FILE setting, extending the
   * list as stored now. Call it under withSettingsLock, like every other settings writer.
   */
  addExtraConfFile(app: ZephyrApplication, config: ZephyrBuildConfig, file: string): Promise<AddExtraConfFileResult> {
    return addExtraConfFile(app, config, file);
  }
}
