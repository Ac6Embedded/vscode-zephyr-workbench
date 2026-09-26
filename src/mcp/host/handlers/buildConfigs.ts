// Build configurations. configure creates, changes, renames and activates
// them, and selects the application of a west workspace; remove_or_delete
// removes build output or a whole configuration through deleteBuild. Both go through the functions the
// Zephyr Workbench Applications view uses, so the settings, IntelliSense and
// tasks.json end up exactly as a change made by hand would leave them, and
// neither shows any UI except the confirmation dialog.
//
// Every handler follows one order: validate, resolve, run each check that can
// refuse the call, return early for a dry run or when nothing would change,
// ask the user when they chose to be asked, then act under the settings lock
// against freshly read values.

import * as fs from 'fs';
import * as path from 'path';
import { ZephyrApplication } from '../../../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../../../models/ZephyrBuildConfig';
import { getStaticFlashRunnerNames } from '../../../utils/debugTools/debugUtils';
import { resolveConfiguredPath } from '../../../utils/execUtils';
import { isSelectedIntelliSenseApplication, updateBuildConfigCompileCommandsSetting } from '../../../utils/intellisense/intellisenseSync';
import { removeDirectory } from '../../../utils/utils';
import {
  BuildConfigPatch, createApplicationConfig, readStoredBuildConfigs, removeApplicationConfig, setActiveApplicationConfig, updateApplicationConfig,
} from '../../../utils/zephyr/applicationSettings';
import { getActiveOrDefaultBuildConfig, selectWorkspaceApplication, syncActiveBuildConfig } from '../../../utils/zephyr/buildConfigActions';
import {
  canDeleteBuildConfig, defaultNewConfigName, resolveBuildDirToDelete, StoredBuildConfig,
} from '../../../utils/zephyr/buildConfigRules';
import { readRunnersYamlForProject } from '../../../utils/zephyr/runnersYamlUtils';
import { assertConfigName, assertInside, isInside, normalizeForCompare } from '../../core/argSafety';
import {
  assertNewConfigName, ConfigEdit, ConfigPlan, ConfigValues, EDIT_FIELDS, editFieldsIn, emptyConfigValues, ENV_LIST_KEYS, ListEdit,
  planConfigEdit, PlanOptions, toEnvList,
} from '../../core/buildConfigEdit';
import { checkBuildDirDeletion } from '../../core/buildDirFence';
import { McpToolError } from '../../core/errors';
import { logSafe } from '../../core/redact';
import { confirmCategoryOf, ToolContext, ToolHandler } from '../../core/toolSpec';
import { isTerminal } from '../../jobs/jobManager';
import { ConfirmOutcome, ConfirmSubject } from '../confirmations';
import { updateApp } from './apps';
import { HostDeps } from './deps';
import { progressWait, remainingWaitMs } from './progress';
import { updateWestWorkspace } from './westWorkspaces';

type Ctx = ToolContext<HostDeps>;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);

function invalid(message: string, hint?: string, details?: Record<string, unknown>): McpToolError {
  return new McpToolError('INVALID_ARGUMENT', message, { hint, details });
}

/** Refuse a value of the wrong type instead of silently ignoring it. */
function checkTypes(args: Record<string, unknown>, strings: readonly string[], booleans: readonly string[]): void {
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
}

function settingsFileOf(app: ZephyrApplication): string {
  return path.join(app.appWorkspaceFolder.uri.fsPath, '.vscode', 'settings.json');
}

function storageOf(app: ZephyrApplication) {
  return {
    kind: app.isWestWorkspaceApplication ? 'workspace' : 'freestanding',
    settings_file: settingsFileOf(app),
    setting: app.isWestWorkspaceApplication
      ? 'zephyr-workbench.westWorkspace.applications'
      : 'zephyr-workbench.build.configurations',
  };
}

/** A settings write, with a failure turned into an error that names the file to fix. */
async function writeSettings<T>(app: ZephyrApplication, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const file = settingsFileOf(app);
    throw new McpToolError('INTERNAL', `VS Code could not write ${file}: ${error instanceof Error ? error.message : String(error)}`, {
      hint: `Ask the user to save or close ${file} if it has unsaved changes, and to fix it if it is not valid JSON, then retry.`,
    });
  }
}

/** Keep IntelliSense and tasks.json in step, without failing a change that already landed. */
async function sideEffect(what: string, run: () => Promise<unknown>, warnings: string[]): Promise<void> {
  try {
    await run();
  } catch (error) {
    warnings.push(`${what} was not updated: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function findConfig(app: ZephyrApplication, name: string): ZephyrBuildConfig {
  const found = app.buildConfigs.find(config => config.name === name);
  if (!found) {
    throw new McpToolError('CONFIG_NOT_FOUND', `Application "${app.appRootPath}" no longer has a build configuration "${name}".`, {
      hint: 'It was changed while this call ran. Call list_apps and retry with a current name.',
      details: { available: app.buildConfigs.map(config => config.name) },
    });
  }
  return found;
}

function storedIndexOf(app: ZephyrApplication, name: string): number {
  return readStoredBuildConfigs(app).findIndex(config => config?.name === name);
}

/** Refuse while an agent job or a task started from VS Code works on these folders or configurations. */
function assertNotBusy(ctx: Ctx, app: ZephyrApplication, folders: readonly string[], configNames: readonly string[]): void {
  for (const folder of folders) {
    const running = ctx.deps.jobs.runningOverlapping(folder)[0];
    if (running) {
      throw new McpToolError('BUSY', `A ${running.spec.kind} job is working in "${running.spec.buildDir}" (job_id "${running.id}").`, {
        hint: `Wait for it with job {"action": "status", "job_id": "${running.id}"}, or stop it with job {"action": "cancel", "job_id": "${running.id}"}, then retry.`,
        details: { job_id: running.id, kind: running.spec.kind },
      });
    }
  }
  for (const name of configNames) {
    const external = ctx.deps.services.externalRun(app.appRootPath, name);
    if (external) {
      throw new McpToolError('BUSY_EXTERNAL', `"${external.task.name}" is running for ${name}, started from VS Code.`, {
        hint: 'Wait for it to finish in its terminal, then retry.',
      });
    }
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

// configure

const TARGET_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  build_config: ['create', 'update', 'rename', 'activate'],
  app: ['select', 'update'],
  west_workspace: ['update'],
};

/** Fields of an application or west workspace update, refused anywhere else. */
const SETTINGS_ONLY_ARGS = ['west_workspace', 'toolchain', 'intellisense_provider', 'venv', 'roots', 'dry_run'];

/** What each action accepts beyond target, action and app_path. */
const ACTION_ARGS: Readonly<Record<string, readonly string[]>> = {
  create: ['config_name', 'copy_from', 'activate', ...EDIT_FIELDS],
  update: ['config_name', ...EDIT_FIELDS],
  rename: ['config_name', 'new_name'],
  activate: ['config_name'],
  select: [],
};
const OPTIONAL_ARGS = ['config_name', 'new_name', 'copy_from', 'activate', ...EDIT_FIELDS];

function valuesOf(config: ZephyrBuildConfig): ConfigValues {
  const env: ConfigValues['env'] = {};
  for (const key of ENV_LIST_KEYS) {
    env[key] = toEnvList(config.envVars?.[key]);
  }
  return {
    board: config.boardIdentifier || undefined,
    sysbuild: String(config.sysbuild).toLowerCase() === 'true',
    westArgs: config.westArgs ?? '',
    westFlags: [...(config.westFlagsD ?? [])],
    defaultRunner: config.defaultRunner || undefined,
    runnerArgs: config.customArgs || undefined,
    env,
  };
}

function editOf(args: Record<string, unknown>): ConfigEdit {
  for (const key of ['west_flags', 'env']) {
    const value = args[key];
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
      throw invalid(`${key} must be an object.`);
    }
  }
  return {
    board: str(args.board),
    sysbuild: bool(args.sysbuild),
    west_args: str(args.west_args),
    west_flags: args.west_flags as ListEdit | undefined,
    default_runner: str(args.default_runner),
    runner_args: str(args.runner_args),
    env: args.env as ConfigEdit['env'],
  };
}

/** An agent path made absolute: workbench variables expanded, relative paths taken from the application. */
function absolutePathFor(app: ZephyrApplication, value: string): string {
  const trimmed = value.trim();
  const expanded = trimmed.includes('${') ? resolveConfiguredPath(trimmed, app.appWorkspaceFolder) ?? trimmed : trimmed;
  if (expanded.includes('${')) {
    throw invalid(`"${logSafe(value, 200)}" uses a variable that cannot be expanded here.`,
      'Pass an absolute path, or one relative to app_path.');
  }
  return path.resolve(app.appRootPath, expanded);
}

async function planOptionsFor(ctx: Ctx, app: ZephyrApplication, config: ZephyrBuildConfig | undefined, edit: ConfigEdit): Promise<PlanOptions> {
  const roots = await ctx.deps.services.knownRoots();
  // runners.yaml belongs to the board it was built for, so it only checks a
  // runner when the board stays the same.
  const keepsBoard = !!config && (edit.board === undefined || edit.board.trim() === config.boardIdentifier);
  const runnersYaml = keepsBoard && config ? readRunnersYamlForProject(app, config) : undefined;
  return {
    absolutePath: value => absolutePathFor(app, value),
    assertAllowedPath: (absolute, label) => {
      assertInside(absolute, roots, label);
    },
    buildRunners: runnersYaml && runnersYaml.runners.length > 0 ? runnersYaml.runners : undefined,
    staticRunners: getStaticFlashRunnerNames(),
  };
}

function patchOf(plan: ConfigPlan): BuildConfigPatch {
  return { settings: plan.settings, env: plan.env };
}

/**
 * Confirm the write landed by reading the stored values back. A settings file
 * VS Code could not parse, or one that overrides the value elsewhere, would
 * otherwise report a change that never happened.
 */
function assertLanded(app: ZephyrApplication, name: string, plan: ConfigPlan): void {
  const stored = readStoredBuildConfigs(app).find(config => config?.name === name);
  const mismatched = stored
    ? Object.entries(plan.settings).filter(([key, value]) => {
      const expected = value === undefined || (Array.isArray(value) && value.length === 0) ? undefined : value;
      return JSON.stringify(stored[key]) !== JSON.stringify(expected);
    }).map(([key]) => key)
    : ['name'];
  if (mismatched.length > 0) {
    throw new McpToolError('INTERNAL', `The change to "${name}" did not reach the settings (${mismatched.join(', ')}).`, {
      hint: `Ask the user to check ${settingsFileOf(app)}: save it if it has unsaved changes and fix it if it is not valid JSON, then retry.`,
    });
  }
}

function nextAfterChange(name: string, needsPristine: boolean): string {
  return needsPristine
    ? `Call build_app with config_name "${name}" and pristine "always": the board or sysbuild changed and the build folder was configured before.`
    : `Call build_app with config_name "${name}" to build with these settings.`;
}

function launchEntriesMention(app: ZephyrApplication, configName: string): boolean {
  try {
    return fs.readFileSync(path.join(app.appWorkspaceFolder.uri.fsPath, '.vscode', 'launch.json'), 'utf8').includes(`[${configName}]`);
  } catch {
    return false;
  }
}

async function createConfig(args: Record<string, unknown>, ctx: Ctx, app: ZephyrApplication) {
  const { services } = ctx.deps;
  const name = str(args.config_name) ?? defaultNewConfigName(app.buildConfigs);
  assertNewConfigName(name, app.buildConfigs.map(config => config.name), 'config_name');
  const copyFrom = str(args.copy_from);
  const source = copyFrom ? services.resolveConfig(app, copyFrom) : undefined;
  const edit = editOf(args);
  const plan = planConfigEdit(source ? valuesOf(source) : emptyConfigValues(), edit, await planOptionsFor(ctx, app, source, edit));
  const board = str(plan.settings.board) ?? source?.boardIdentifier;
  if (!board) {
    throw invalid('create needs a board.', 'Pass board, or copy_from an existing configuration.');
  }
  // The first configuration of an application is its active one.
  const activate = bool(args.activate) === true || app.buildConfigs.length === 0;
  const buildDir = path.join(app.appRootPath, 'build', name);
  // A folder left behind by an earlier configuration of the same name is reused.
  assertNotBusy(ctx, app, [buildDir], []);

  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: `create the build configuration "${name}" for ${logSafe(board, 128)} in ${logSafe(app.appName, 64)}`,
    appPath: app.appRootPath, configName: name, board, scope: app.appRootPath,
  }, args));

  return services.withSettingsLock(app, async () => {
    const fresh = await services.resolveApp(app.appRootPath);
    assertNewConfigName(name, fresh.buildConfigs.map(config => config.name), 'config_name');
    const freshSource = copyFrom ? findConfig(fresh, copyFrom) : undefined;
    const freshPlan = planConfigEdit(freshSource ? valuesOf(freshSource) : emptyConfigValues(), edit,
      await planOptionsFor(ctx, fresh, freshSource, edit));
    const base: StoredBuildConfig = copyFrom
      ? readStoredBuildConfigs(fresh).find(config => config?.name === copyFrom) ?? {}
      : {};
    const index = await writeSettings(fresh, () => createApplicationConfig(fresh, name, base, patchOf(freshPlan), { active: activate }));
    if (index === -1) {
      const wanted = name.toLowerCase();
      if (readStoredBuildConfigs(fresh).some(config => typeof config?.name === 'string' && config.name.toLowerCase() === wanted)) {
        throw invalid(`config_name "${name}" was taken while this call ran.`, 'Call list_apps and pick another name.');
      }
      // Only a west workspace application that vanished from the settings gets here.
      throw new McpToolError('APP_NOT_FOUND', `"${fresh.appRootPath}" is no longer declared in ${settingsFileOf(fresh)}.`, {
        hint: 'Call list_apps to see the applications of this window.',
      });
    }

    const after = await services.resolveApp(app.appRootPath);
    assertLanded(after, name, freshPlan);
    const created = findConfig(after, name);
    const warnings = [...freshPlan.warnings];
    if (activate) {
      await sideEffect('IntelliSense or tasks.json', () => syncActiveBuildConfig(after, created, index), warnings);
    }
    const reused = fs.existsSync(buildDir);
    if (reused) {
      warnings.push(`"${buildDir}" already exists from an earlier configuration and will be reused.`);
    }
    const needsPristine = services.isConfigured(buildDir);
    return {
      target: 'build_config',
      action: 'create',
      app_path: after.appRootPath,
      storage: storageOf(after),
      config: services.toConfigDto(after, created),
      ...(copyFrom ? { copied_from: copyFrom } : {}),
      changed: freshPlan.changed,
      needs_pristine: needsPristine,
      active_config: getActiveOrDefaultBuildConfig(after)?.name,
      ...(confirmationOf(ctx, outcome) ? { confirmation: confirmationOf(ctx, outcome) } : {}),
      warnings,
      next: nextAfterChange(name, needsPristine),
    };
  });
}

async function updateConfig(args: Record<string, unknown>, ctx: Ctx, app: ZephyrApplication) {
  const { services } = ctx.deps;
  if (editFieldsIn(args).length === 0) {
    throw invalid('update needs at least one field to change.', `Pass one or more of ${EDIT_FIELDS.join(', ')}.`);
  }
  const config = services.resolveConfig(app, str(args.config_name));
  const edit = editOf(args);
  const buildDir = config.getBuildDir(app);
  const plan = planConfigEdit(valuesOf(config), edit, await planOptionsFor(ctx, app, config, edit));
  if (plan.changed.length === 0) {
    return {
      target: 'build_config', action: 'update', app_path: app.appRootPath, storage: storageOf(app),
      config: services.toConfigDto(app, config), changed: [], needs_pristine: false, warnings: plan.warnings,
      next: 'Nothing changed: the configuration already has these values.',
    };
  }
  assertNotBusy(ctx, app, [buildDir], [config.name]);

  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: `change ${plan.changed.join(', ')} of the build configuration "${config.name}" in ${logSafe(app.appName, 64)}`,
    appPath: app.appRootPath, configName: config.name, board: str(plan.settings.board) ?? config.boardIdentifier,
    scope: app.appRootPath,
  }, args));

  return services.withSettingsLock(app, async () => {
    const fresh = await services.resolveApp(app.appRootPath);
    const freshConfig = findConfig(fresh, config.name);
    // A build may have started while the dialog was open.
    assertNotBusy(ctx, fresh, [buildDir], [config.name]);
    const freshPlan = planConfigEdit(valuesOf(freshConfig), edit, await planOptionsFor(ctx, fresh, freshConfig, edit));
    if (freshPlan.changed.length > 0) {
      const written = await writeSettings(fresh, () => updateApplicationConfig(fresh, config.name, patchOf(freshPlan)));
      if (!written) {
        findConfig(await services.resolveApp(app.appRootPath), config.name);
      }
    }

    const after = await services.resolveApp(app.appRootPath);
    assertLanded(after, config.name, freshPlan);
    const updated = findConfig(after, config.name);
    const warnings = [...freshPlan.warnings];
    if (freshPlan.sysbuildChanged && getActiveOrDefaultBuildConfig(after)?.name === updated.name) {
      // With sysbuild the application's compile_commands.json moves one folder
      // down. Only for the configuration IntelliSense follows: an agent editing
      // another one must not move the editor away from it.
      await sideEffect('IntelliSense', () => updateBuildConfigCompileCommandsSetting(after, updated), warnings);
    }
    const needsPristine = (freshPlan.boardChanged || freshPlan.sysbuildChanged) && services.isConfigured(buildDir);
    return {
      target: 'build_config',
      action: 'update',
      app_path: after.appRootPath,
      storage: storageOf(after),
      config: services.toConfigDto(after, updated),
      changed: freshPlan.changed,
      needs_pristine: needsPristine,
      ...(confirmationOf(ctx, outcome) ? { confirmation: confirmationOf(ctx, outcome) } : {}),
      warnings,
      next: nextAfterChange(config.name, needsPristine),
    };
  });
}

function requiredName(args: Record<string, unknown>, key: 'config_name' | 'new_name', action: string): string {
  const value = str(args[key]);
  if (!value) {
    throw invalid(`action "${action}" needs ${key}.`, key === 'config_name'
      ? 'Call list_apps to see the configuration names, then pass config_name.'
      : 'Pass new_name with the name the configuration should get.');
  }
  return value;
}

async function renameConfig(args: Record<string, unknown>, ctx: Ctx, app: ZephyrApplication) {
  const { services } = ctx.deps;
  const oldName = requiredName(args, 'config_name', 'rename');
  const newName = requiredName(args, 'new_name', 'rename');
  const config = services.resolveConfig(app, oldName);
  if (newName === config.name) {
    return {
      target: 'build_config', action: 'rename', app_path: app.appRootPath, storage: storageOf(app),
      config: services.toConfigDto(app, config), changed: [], needs_pristine: false, warnings: [],
      next: 'Nothing changed: the configuration already has this name.',
    };
  }
  if (newName.toLowerCase() === oldName.toLowerCase()) {
    throw invalid(`new_name "${newName}" differs from "${oldName}" only by case.`,
      'Build folders are named after configurations, and on macOS and Windows build/<name> ignores case. Pick a different name.');
  }
  const others = (target: ZephyrApplication) => target.buildConfigs.filter(other => other.name !== oldName).map(other => other.name);
  assertNewConfigName(newName, others(app), 'new_name');
  const oldBuildDir = config.getBuildDir(app);
  const newBuildDir = path.join(app.appRootPath, 'build', newName);
  assertNotBusy(ctx, app, [oldBuildDir, newBuildDir], [oldName]);

  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: `rename the build configuration "${oldName}" to "${newName}" in ${logSafe(app.appName, 64)}`,
    appPath: app.appRootPath, configName: oldName, board: config.boardIdentifier, scope: app.appRootPath,
  }, args));

  return services.withSettingsLock(app, async () => {
    const fresh = await services.resolveApp(app.appRootPath);
    findConfig(fresh, oldName);
    assertNewConfigName(newName, others(fresh), 'new_name');
    assertNotBusy(ctx, fresh, [oldBuildDir, newBuildDir], [oldName]);
    const plan: ConfigPlan = {
      settings: { name: newName }, env: {}, changed: ['name'], warnings: [], boardChanged: false, sysbuildChanged: false,
    };
    const written = await writeSettings(fresh, () => updateApplicationConfig(fresh, oldName, patchOf(plan)));
    if (!written) {
      findConfig(await services.resolveApp(app.appRootPath), oldName);
    }

    const after = await services.resolveApp(app.appRootPath);
    assertLanded(after, newName, plan);
    const renamed = findConfig(after, newName);
    const warnings: string[] = [];
    if (renamed.active) {
      // IntelliSense and the workbench tasks point at the active configuration by name.
      await sideEffect('IntelliSense or tasks.json',
        () => syncActiveBuildConfig(after, renamed, storedIndexOf(after, newName)), warnings);
    }
    const orphaned = fs.existsSync(oldBuildDir) ? oldBuildDir : undefined;
    if (orphaned) {
      warnings.push(`"${oldBuildDir}" keeps its old name, because CMake records absolute paths in it; the next build of "${newName}" configures build/${newName} from scratch.`);
    }
    if (launchEntriesMention(after, oldName)) {
      warnings.push(`.vscode/launch.json still has debug configurations for "${oldName}" that point at its old build folder. The Debug Manager creates matching ones for "${newName}".`);
    }
    // A folder an earlier configuration of the new name left behind is built
    // into next, and it may have been configured for another board.
    const needsPristine = services.isConfigured(newBuildDir);
    if (fs.existsSync(newBuildDir)) {
      warnings.push(`"${newBuildDir}" already exists from an earlier configuration and will be reused.`);
    }
    return {
      target: 'build_config',
      action: 'rename',
      app_path: after.appRootPath,
      storage: storageOf(after),
      config: services.toConfigDto(after, renamed),
      previous_name: oldName,
      changed: ['name'],
      needs_pristine: needsPristine,
      ...(orphaned ? { orphaned_build_dir: orphaned } : {}),
      ...(confirmationOf(ctx, outcome) ? { confirmation: confirmationOf(ctx, outcome) } : {}),
      warnings,
      next: `Call build_app with config_name "${newName}"${needsPristine ? ' and pristine "always", because its build folder was configured before,' : ''} to build it.`
        + (orphaned
          ? ` To free the space of the old folder, call remove_or_delete with what "build_folder" and config_name "${oldName}" when that tool is available.`
          : ''),
    };
  });
}

async function activateConfig(args: Record<string, unknown>, ctx: Ctx, app: ZephyrApplication) {
  const { services } = ctx.deps;
  const name = requiredName(args, 'config_name', 'activate');
  const config = services.resolveConfig(app, name);
  const activeNames = app.buildConfigs.filter(other => other.active).map(other => other.name);
  if (activeNames.length === 1 && activeNames[0] === name) {
    return {
      target: 'build_config', action: 'activate', app_path: app.appRootPath, storage: storageOf(app),
      config: services.toConfigDto(app, config), changed: [], needs_pristine: false, active_config: name, warnings: [],
      next: `"${name}" is already the active configuration.`,
    };
  }
  const buildDir = config.getBuildDir(app);
  assertNotBusy(ctx, app, [buildDir], [name]);

  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: `make "${name}" the active build configuration of ${logSafe(app.appName, 64)}`,
    appPath: app.appRootPath, configName: name, board: config.boardIdentifier, scope: app.appRootPath,
  }, args));

  return services.withSettingsLock(app, async () => {
    const fresh = await services.resolveApp(app.appRootPath);
    findConfig(fresh, name);
    assertNotBusy(ctx, fresh, [buildDir], [name]);
    // The two steps activateBuildConfig takes for the Applications view, kept
    // apart so a failed IntelliSense or tasks.json refresh is reported as a
    // warning and not as a settings write that failed.
    const index = await writeSettings(fresh, () => setActiveApplicationConfig(fresh, name));
    if (index === -1) {
      findConfig(await services.resolveApp(app.appRootPath), name);
    }

    const after = await services.resolveApp(app.appRootPath);
    const activated = findConfig(after, name);
    if (!activated.active || after.buildConfigs.some(other => other.active && other.name !== name)) {
      throw new McpToolError('INTERNAL', `"${name}" did not become the only active configuration.`, {
        hint: `Ask the user to check ${settingsFileOf(after)}: save it if it has unsaved changes and fix it if it is not valid JSON, then retry.`,
      });
    }
    const warnings: string[] = [];
    await sideEffect('IntelliSense or tasks.json', () => syncActiveBuildConfig(after, activated, index), warnings);
    return {
      target: 'build_config',
      action: 'activate',
      app_path: after.appRootPath,
      storage: storageOf(after),
      config: services.toConfigDto(after, activated),
      changed: ['active'],
      needs_pristine: false,
      active_config: name,
      ...(confirmationOf(ctx, outcome) ? { confirmation: confirmationOf(ctx, outcome) } : {}),
      warnings,
      next: `"${name}" is now used whenever config_name is omitted. Call build_app to build it.`,
    };
  });
}

async function selectApp(args: Record<string, unknown>, ctx: Ctx, app: ZephyrApplication) {
  const { services } = ctx.deps;
  if (!app.isWestWorkspaceApplication) {
    throw invalid(`"${app.appRootPath}" is a freestanding application, so there is no west workspace selection to change.`,
      'Only an application declared inside a west workspace is selected; every tool takes app_path directly.');
  }
  const westRoot = app.appWorkspaceFolder.uri.fsPath;
  const storage = {
    kind: 'workspace',
    settings_file: settingsFileOf(app),
    setting: 'zephyr-workbench.westWorkspace.selectedApplication',
  };
  const activeConfig = getActiveOrDefaultBuildConfig(app)?.name;
  if (isSelectedIntelliSenseApplication(app)) {
    return {
      target: 'app', action: 'select', app_path: app.appRootPath, west_workspace: westRoot, storage,
      changed: [], active_config: activeConfig, warnings: [],
      next: 'Nothing changed: this application is already the selected one.',
    };
  }

  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary: `select ${logSafe(app.appName, 64)} as the application of the west workspace ${logSafe(path.basename(westRoot), 64)}`,
    appPath: app.appRootPath, scope: westRoot,
  }, args));

  return services.withSettingsLock(app, async () => {
    const warnings: string[] = [];
    await writeSettings(app, async () => {
      try {
        await selectWorkspaceApplication(app.appWorkspaceFolder, app.appRootPath, app);
      } catch (error) {
        const fresh = await services.resolveApp(app.appRootPath);
        if (!isSelectedIntelliSenseApplication(fresh)) {
          throw error;
        }
        warnings.push(`IntelliSense was not updated: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    const after = await services.resolveApp(app.appRootPath);
    if (!isSelectedIntelliSenseApplication(after)) {
      throw new McpToolError('INTERNAL', `"${app.appRootPath}" did not become the selected application.`, {
        hint: `Ask the user to check ${settingsFileOf(app)}: save it if it has unsaved changes and fix it if it is not valid JSON, then retry.`,
      });
    }
    return {
      target: 'app',
      action: 'select',
      app_path: after.appRootPath,
      west_workspace: westRoot,
      storage,
      changed: ['selected_application'],
      active_config: getActiveOrDefaultBuildConfig(after)?.name,
      ...(confirmationOf(ctx, outcome) ? { confirmation: confirmationOf(ctx, outcome) } : {}),
      warnings,
      next: 'The Applications view, status bar and IntelliSense now follow this application. Tools still take app_path.',
    };
  });
}

export const configure: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const target = str(args.target) ?? '';
  const action = str(args.action) ?? '';
  // Application and west workspace settings live in their own modules.
  if (target === 'app' && action === 'update') {
    return updateApp(args, ctx);
  }
  if (target === 'west_workspace' && action === 'update') {
    return updateWestWorkspace(args, ctx);
  }
  checkTypes(args, ['target', 'action', 'app_path', 'config_name', 'new_name', 'copy_from', 'board', 'west_args', 'default_runner', 'runner_args'],
    ['activate', 'sysbuild']);
  if (!TARGET_ACTIONS[target]?.includes(action)) {
    throw invalid(`target "${logSafe(target, 40)}" has no action "${logSafe(action, 40)}".`,
      'Use target "build_config" with action create, update, rename or activate, target "app" with action select or update, or target "west_workspace" with action update.',
      { valid: TARGET_ACTIONS });
  }
  const foreign = SETTINGS_ONLY_ARGS.filter(key => args[key] !== undefined);
  if (foreign.length > 0) {
    throw invalid(`${foreign.join(', ')} only apply to target "app" or "west_workspace" with action "update".`);
  }
  const unexpected = OPTIONAL_ARGS.filter(key => args[key] !== undefined && !ACTION_ARGS[action].includes(key));
  if (unexpected.length > 0) {
    throw invalid(`action "${action}" does not take ${unexpected.join(', ')}.`, undefined, { accepted: ACTION_ARGS[action] });
  }

  const app = await ctx.deps.services.resolveApp(str(args.app_path));
  switch (action) {
    case 'create':
      return createConfig(args, ctx, app);
    case 'update':
      return updateConfig(args, ctx, app);
    case 'rename':
      return renameConfig(args, ctx, app);
    case 'activate':
      return activateConfig(args, ctx, app);
    default:
      return selectApp(args, ctx, app);
  }
};

// remove_or_delete: build folders and configurations

const WHATS = ['build_folder', 'all_build_folders', 'configuration'] as const;

/** The folder a deletion targets, refused when a stored name would leave the build folder. */
function buildFolderFor(app: ZephyrApplication, configName?: string): string {
  try {
    return resolveBuildDirToDelete(app.appRootPath, configName);
  } catch (error) {
    throw new McpToolError('PATH_OUTSIDE_WORKSPACE', error instanceof Error ? error.message : String(error), {
      hint: 'Only a folder directly under <app_path>/build can be deleted. Delete anything else by hand if you are sure.',
    });
  }
}

/** Remove a configuration from the settings; when it was active another one becomes active. */
async function removeConfiguration(ctx: Ctx, app: ZephyrApplication, name: string, warnings: string[]): Promise<string | undefined> {
  const { services } = ctx.deps;
  return services.withSettingsLock(app, async () => {
    const fresh = await services.resolveApp(app.appRootPath);
    findConfig(fresh, name);
    if (!canDeleteBuildConfig(fresh.buildConfigs.length)) {
      throw lastConfiguration(fresh, name);
    }
    const { removed, elected } = await writeSettings(fresh, () => removeApplicationConfig(fresh, name));
    if (!removed) {
      findConfig(await services.resolveApp(app.appRootPath), name);
    }
    const after = await services.resolveApp(app.appRootPath);
    if (after.buildConfigs.some(config => config.name === name)) {
      throw new McpToolError('INTERNAL', `"${name}" is still in the settings after it was removed.`, {
        hint: `Ask the user to check ${settingsFileOf(after)}: save it if it has unsaved changes and fix it if it is not valid JSON, then retry.`,
      });
    }
    const electedConfig = elected ? after.buildConfigs.find(config => config.name === elected.name) : undefined;
    if (elected && electedConfig) {
      await sideEffect('IntelliSense or tasks.json', () => syncActiveBuildConfig(after, electedConfig, elected.index), warnings);
    }
    if (launchEntriesMention(after, name)) {
      warnings.push(`.vscode/launch.json still has debug configurations for "${name}". They stop working and can be removed from the Debug Manager or by hand.`);
    }
    return getActiveOrDefaultBuildConfig(after)?.name;
  });
}

/**
 * Refuse while a Kconfig server runs inside a folder about to be deleted. A server's
 * working directory is its build's zephyr/kconfig folder, and Windows cannot delete a
 * folder a process runs in, so the deletion would stop halfway. The Kconfig Manager tab
 * is the user's to close (it may hold unsaved edits); an agent session that is idle is
 * stopped by the deletion itself, but one answering a call is not cut off.
 */
function assertNoKconfigServer(ctx: Ctx, folder: string): void {
  const editor = ctx.deps.services.kconfigEditors().find(candidate => isInside(candidate.buildDir, folder));
  if (editor) {
    throw new McpToolError('BUSY_EXTERNAL', `The Kconfig Manager is open on ${editor.configName}, and its Kconfig server runs inside "${folder}".`, {
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

function lastConfiguration(app: ZephyrApplication, name: string): McpToolError {
  return invalid(`"${name}" is the only build configuration of ${app.appName}, and an application always keeps one.`,
    'Create another one with configure first, or delete only its build output with what "build_folder".');
}

export const deleteBuild: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const { services, jobs, defaultWaitSeconds } = ctx.deps;
  checkTypes(args, ['what', 'app_path', 'config_name'], ['delete_build_folder', 'dry_run']);
  const what = str(args.what) as typeof WHATS[number] | undefined;
  if (!what || !WHATS.includes(what)) {
    throw invalid(`what must be one of ${WHATS.join(', ')}.`);
  }
  const configName = str(args.config_name);
  const withFolder = bool(args.delete_build_folder);
  const dryRun = bool(args.dry_run) === true;
  const waitSec = num(args.wait_sec) ?? defaultWaitSeconds;
  if (what !== 'all_build_folders' && !configName) {
    throw invalid(`what "${what}" needs config_name: a deletion never falls back to the active configuration.`,
      'Call list_apps to see the configuration names, then pass config_name.');
  }
  if (what === 'all_build_folders' && configName) {
    throw invalid('config_name cannot be combined with what "all_build_folders", which deletes every build folder.',
      'Use what "build_folder" to delete the folder of one configuration.');
  }
  if (withFolder !== undefined && what !== 'configuration') {
    throw invalid('delete_build_folder only applies to what "configuration".');
  }
  if (configName) {
    assertConfigName(configName);
  }

  const app = await services.resolveApp(str(args.app_path));
  const config = configName ? app.buildConfigs.find(candidate => candidate.name === configName) : undefined;
  if (what === 'configuration') {
    services.resolveConfig(app, configName);
    if (!canDeleteBuildConfig(app.buildConfigs.length)) {
      throw lastConfiguration(app, configName!);
    }
  }
  // On macOS and Windows build/primary is the folder of "Primary", but the
  // check for a task building it and the guard on tasks launched during the
  // deletion compare names exactly, so they would miss that task. Case is
  // folded only there, as the fence does: on Linux build/primary is a folder
  // of its own.
  const caseTwin = configName && !config
    ? app.buildConfigs.find(candidate => normalizeForCompare(candidate.name) === normalizeForCompare(configName))
    : undefined;
  if (caseTwin) {
    throw invalid(`config_name "${configName}" differs from the build configuration "${caseTwin.name}" only by case.`,
      `Pass config_name "${caseTwin.name}".`);
  }

  // build_folder may name a folder no configuration owns any more, such as one
  // a rename left behind; the fence then requires it to hold build output.
  const folder = what === 'configuration' && withFolder !== true
    ? undefined
    : buildFolderFor(app, what === 'all_build_folders' ? undefined : configName);
  const roots = await services.knownRoots();
  const fence = () => (folder
    ? checkBuildDirDeletion({ appRootPath: app.appRootPath, target: folder, configNames: app.buildConfigs.map(c => c.name), knownRoots: roots })
    : { exists: false });
  const { exists } = fence();
  const base = { what, app_path: app.appRootPath, ...(configName ? { config_name: configName } : {}) };

  if (what !== 'configuration' && !exists) {
    return {
      ...base, deleted: [], already_clean: true, ...(dryRun ? { dry_run: true, would_delete: [] } : {}),
      next: 'There is no build folder to delete. Call build_app to build again.',
    };
  }

  // A hand-edited name that is not a plain folder name owns no build folder.
  let configFolder: string | undefined;
  try {
    configFolder = configName ? resolveBuildDirToDelete(app.appRootPath, configName) : undefined;
  } catch {
    configFolder = undefined;
  }
  const busyFolders = [folder ?? configFolder].filter((entry): entry is string => !!entry);
  const busyConfigs = what === 'all_build_folders' ? app.buildConfigs.map(candidate => candidate.name) : [configName!];
  const checkBusy = () => {
    assertNotBusy(ctx, app, busyFolders, busyConfigs);
    if (folder) {
      assertNoKconfigServer(ctx, folder);
    }
  };
  checkBusy();

  const otherActive = app.buildConfigs.some(candidate => candidate !== config && candidate.active);
  const wouldActivate = what === 'configuration' && config?.active && !otherActive
    ? app.buildConfigs.find(candidate => candidate !== config)?.name
    : undefined;
  const orphaned = what === 'configuration' && withFolder !== true && configFolder && fs.existsSync(configFolder) ? configFolder : undefined;
  const deleting = folder && exists ? [{ path: folder, ...(configName ? { config_name: configName } : {}) }] : [];

  if (dryRun) {
    const category = confirmCategoryOf(ctx.tool, args);
    return {
      ...base,
      dry_run: true,
      would_delete: deleting,
      ...(what === 'configuration' ? { would_remove_configuration: configName } : {}),
      ...(wouldActivate ? { would_activate: wouldActivate } : {}),
      ...(orphaned ? { orphaned_build_dir: orphaned } : {}),
      // An approval the user already gave for this session can still skip the dialog.
      confirmation_required: !!category && ctx.deps.permissionOf(ctx.tool) === 'ask',
      next: 'Call remove_or_delete again without dry_run to delete.',
    };
  }

  const appName = logSafe(app.appName, 64);
  const summary = what === 'build_folder'
    ? `delete the build folder of "${configName}" in ${appName}`
    : what === 'all_build_folders'
      ? `delete every build folder of ${appName}`
      : `delete the build configuration "${configName}" of ${appName}${deleting.length > 0 ? ' and its build folder' : ''}`;
  const outcome = await ctx.deps.confirmations.require(ctx, args, subjectOf({
    summary, appPath: app.appRootPath, configName, board: config?.boardIdentifier,
    folder: deleting.length > 0 ? folder : undefined, scope: app.appRootPath,
  }, args));
  const confirmation = confirmationOf(ctx, outcome);

  // A build may have started, or the folder changed, while the dialog was open.
  const stillExists = fence().exists;
  checkBusy();

  const warnings: string[] = [];
  if (!folder || !stillExists) {
    const active = what === 'configuration' ? await removeConfiguration(ctx, app, configName!, warnings) : undefined;
    return {
      ...base,
      deleted: [],
      ...(folder ? { already_clean: true } : {}),
      ...(what === 'configuration' ? { removed_configuration: configName, active_config: active } : {}),
      ...(orphaned ? { orphaned_build_dir: orphaned } : {}),
      ...(confirmation ? { confirmation } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      next: orphaned
        ? `The build folder was kept. Call remove_or_delete with what "build_folder" and config_name "${configName}" to delete it too.`
        : what === 'configuration'
          ? 'Done. Call list_apps to see the remaining configurations.'
          : 'The build folder was already gone. The next build_app call configures from scratch.',
    };
  }

  // The deletion runs as a job, so build_app refuses to build in the folder
  // while it goes, and a large folder can outlast wait_sec.
  let removal: 'removed' | 'absent' | 'busy' | undefined;
  let activeAfter: string | undefined;
  let configError: unknown;
  const { job } = jobs.start({
    kind: 'clean',
    lockKey: folder,
    requestKey: `clean:${what}:${folder}`,
    appPath: app.appRootPath,
    configName,
    buildDir: folder,
    command: `delete ${folder}`,
    run: async (sink, signal) => {
      sink.onData(`Deleting ${folder}\n`);
      // The agent Kconfig sessions inside the folder are stopped first (see
      // assertNoKconfigServer), and none may start there until the deletion ends.
      const reopenKconfig = await ctx.deps.kconfig.closeWithin(folder);
      try {
        removal = await removeDirectory(folder);
      } catch (error) {
        // Written to the output so the result and job log say why.
        sink.onData(`${folder} could not be deleted: ${error instanceof Error ? error.message : String(error)}\n`);
        return { exitCode: 1 };
      } finally {
        reopenKconfig();
      }
      if (removal === 'busy') {
        sink.onData(`Some files in ${folder} are in use, so it was not fully deleted.\n`);
        return { exitCode: 1 };
      }
      sink.onData(`Deleted ${folder}\n`);
      if (what === 'configuration') {
        if (signal.aborted) {
          // A file deletion cannot be stopped halfway, but a cancelled job
          // must not go on to change the settings.
          sink.onData(`Cancelled: the build configuration ${configName} was kept in the settings.\n`);
          return { exitCode: 1 };
        }
        // Only once the folder is gone, so a retry after a failure repeats the whole deletion.
        try {
          activeAfter = await removeConfiguration(ctx, app, configName!, warnings);
        } catch (error) {
          configError = error;
          sink.onData(`The build configuration ${configName} was not removed: ${error instanceof Error ? error.message : String(error)}\n`);
          return { exitCode: 1 };
        }
        sink.onData(`Removed the build configuration ${configName} from ${settingsFileOf(app)}\n`);
      }
      return { exitCode: 0 };
    },
  });
  ctx.audit.jobId = job.id;
  await jobs.wait(job, remainingWaitMs(ctx, waitSec), progressWait(ctx, jobs));

  if (configError !== undefined) {
    // The folder is gone but the settings still hold the configuration, so the
    // agent gets the real reason rather than a failed job.
    throw configError;
  }
  if (!isTerminal(job.status)) {
    return {
      ...base,
      status: 'running',
      job: jobs.view(job, { parse: false }),
      ...(confirmation ? { confirmation } : {}),
      next: `The deletion is still running. Call job {"action": "status", "job_id": "${job.id}"} until it ends.`,
    };
  }
  if (removal === 'busy') {
    throw new McpToolError('BUSY_EXTERNAL', `Some files in "${folder}" are in use, so it was only partly deleted.`, {
      hint: 'Ask the user to close any terminal, debug session, serial monitor or menuconfig using that folder, then call remove_or_delete again.',
      details: { folder, still_exists: fs.existsSync(folder), job_id: job.id },
    });
  }
  if (job.status !== 'succeeded') {
    throw new McpToolError('INTERNAL', `Deleting "${folder}" ${job.status === 'cancelled' ? 'was cancelled' : 'failed'}: ${jobs.lastLine(job, 300)}`, {
      details: { job_id: job.id, log: job.log.filePath },
    });
  }
  return {
    ...base,
    // Something else may have removed the folder between the check and the job.
    ...(removal === 'absent' ? { deleted: [], already_clean: true } : { deleted: deleting }),
    ...(what === 'configuration' ? { removed_configuration: configName, active_config: activeAfter } : {}),
    ...(confirmation ? { confirmation } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    job_id: job.id,
    next: what === 'configuration'
      ? 'Done. Call list_apps to see the remaining configurations.'
      : 'Done. The next build_app call configures from scratch.',
  };
};
