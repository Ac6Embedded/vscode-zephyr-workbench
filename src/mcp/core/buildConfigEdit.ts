// What a configure call changes in a build configuration, worked out before
// anything is written.
//
// Pure and free of `vscode`, so every rule an agent can trip over is unit
// tested. The handler plans once to validate the call and word the
// confirmation, then plans again under the settings lock against the values
// stored at that moment, so two calls editing one list never drop each
// other's change.
//
// Every value planned here reaches a shell on the next build (board, runner,
// west arguments, -D flags, snippets) or is echoed by a terminal (the build
// variable lists), so it is validated here, when it is persisted, and not only
// when it is used.

import * as fs from 'fs';
import {
  ZEPHYR_BUILD_CONFIG_CUSTOM_ARGS_SETTING_KEY,
  ZEPHYR_BUILD_CONFIG_DEFAULT_RUNNER_SETTING_KEY,
  ZEPHYR_BUILD_CONFIG_SYSBUILD_SETTING_KEY,
  ZEPHYR_BUILD_CONFIG_WEST_ARGS_SETTING_KEY,
  ZEPHYR_BUILD_CONFIG_WEST_FLAGS_D_SETTING_KEY,
} from '../../constants';
import { validateBuildConfigName } from '../../utils/zephyr/buildConfigRules';
import {
  addWestFlagDValue, normalizeWestFlagDValue, removeWestFlagDValue, replaceWestFlagDValue, tokenizeWestArgs, westFlagDName,
} from '../../utils/zephyr/westArgUtils';
import {
  assertBoardIdentifier, assertCmakeVariableName, assertEnvListElement, assertRunnerName, assertSafeShellFragment,
  assertShieldOrSnippetName, normalizeForCompare,
} from './argSafety';
import { McpToolError } from './errors';

/** The build variable lists a configuration stores; the only env keys a build reads back. */
export const ENV_LIST_KEYS = ['EXTRA_CONF_FILE', 'EXTRA_DTC_OVERLAY_FILE', 'EXTRA_ZEPHYR_MODULES', 'SHIELD', 'SNIPPETS'] as const;
export type EnvListKey = typeof ENV_LIST_KEYS[number];
const PATH_LIST_KEYS: ReadonlySet<string> = new Set(['EXTRA_CONF_FILE', 'EXTRA_DTC_OVERLAY_FILE', 'EXTRA_ZEPHYR_MODULES']);

/** The fields of a configure call that change a configuration. */
export const EDIT_FIELDS = ['board', 'sysbuild', 'west_args', 'west_flags', 'default_runner', 'runner_args', 'env'] as const;
export type EditField = typeof EDIT_FIELDS[number];

const MAX_LIST_ITEMS = 32;
const MAX_BOARD_LENGTH = 128;

export interface ListEdit {
  set?: string[];
  add?: string[];
  remove?: string[];
}

/** A configuration's current values, with path list entries already absolute. */
export interface ConfigValues {
  board?: string;
  sysbuild: boolean;
  westArgs: string;
  westFlags: string[];
  defaultRunner?: string;
  runnerArgs?: string;
  env: Partial<Record<EnvListKey, string[]>>;
}

export interface ConfigEdit {
  board?: string;
  sysbuild?: boolean;
  west_args?: string;
  west_flags?: ListEdit;
  default_runner?: string;
  runner_args?: string;
  env?: Partial<Record<EnvListKey, ListEdit>>;
}

export interface PlanOptions {
  /** Make an agent path absolute (variables expanded, relative to the application). Never checks where it points. */
  absolutePath(value: string): string;
  /** Throw unless an absolute path may be stored, for example because it is outside every known folder. */
  assertAllowedPath(absolute: string, label: string): void;
  /** Runners listed by the build's runners.yaml, when there is one for the board being kept. */
  buildRunners?: readonly string[];
  /** Runners the workbench knows without a build. */
  staticRunners: readonly string[];
  exists?(absolute: string): boolean;
  /** Compare paths the way the host file system does. Defaults to this platform's rule. */
  samePath?(a: string, b: string): boolean;
}

export interface ConfigPlan {
  /** Stored keys to write; undefined removes the key. */
  settings: Record<string, string | string[] | undefined>;
  /** Build variable lists to write, path entries absolute; an emptied list is []. */
  env: Partial<Record<EnvListKey, string[]>>;
  /** The tool fields whose stored value changes. */
  changed: string[];
  warnings: string[];
  boardChanged: boolean;
  sysbuildChanged: boolean;
}

/** The empty starting point of a configuration created from nothing. */
export function emptyConfigValues(): ConfigValues {
  return { sysbuild: false, westArgs: '', westFlags: [], env: {} };
}

/** A stored env value as a list, whatever shape a hand edit left it in. */
export function toEnvList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  }
  return typeof value === 'string' && value.length > 0 ? [value] : [];
}

function invalid(message: string, hint?: string, details?: Record<string, unknown>): McpToolError {
  return new McpToolError('INVALID_ARGUMENT', message, { hint, details });
}

/**
 * Throw unless `name` may name a new configuration. Stricter than the lookup
 * rule (no "."), so the name can be typed again in the Applications view.
 */
export function assertNewConfigName(name: string, existingNames: readonly string[], label: string): string {
  const problem = validateBuildConfigName(name, existingNames);
  if (problem) {
    const taken = problem.includes('already exists');
    throw invalid(`${label} "${name}" cannot be used: ${problem.replace(/\.$/, '')}.`,
      taken ? 'Pick another name, or call list_apps to see the configurations this application has.' : undefined,
      taken ? { existing: [...existingNames] } : undefined);
  }
  return name;
}

// West build options whose meaning a configure field already owns. Stored in
// west_args they would fight that field on every build.
const RESERVED_WEST_OPTIONS: ReadonlyArray<{ short?: string; long: string[]; field: string }> = [
  { short: 'b', long: ['--board'], field: 'board' },
  { short: 'd', long: ['--build-dir'], field: 'config_name (the build folder is always build/<config_name>)' },
  { long: ['--sysbuild', '--no-sysbuild'], field: 'sysbuild' },
  { short: 'S', long: ['--snippet'], field: 'env.SNIPPETS' },
  { long: ['--shield'], field: 'env.SHIELD' },
  { long: ['--extra-conf'], field: 'env.EXTRA_CONF_FILE' },
  { long: ['--extra-dtc-overlay'], field: 'env.EXTRA_DTC_OVERLAY_FILE' },
  { short: 'p', long: ['--pristine'], field: 'the pristine argument of build_app' },
  { short: 't', long: ['--target'], field: 'nothing: a stored build target would change every build' },
  { long: ['--cmake-only'], field: 'the cmake_only argument of build_app' },
];
/** Complete west build options that happen to be the start of a reserved one. */
const COMPLETE_LONG_OPTIONS = new Set(['--cmake']);
/** Short west build flags that take no value, so letters after them in one word are more options. */
const VALUELESS_SHORT_FLAGS = new Set(['c', 'f', 'n']);

/**
 * The first word of `westArgs` that a dedicated field owns, if any. Handles
 * `--opt=value`, attached short values (`-bboard`), clustered short flags
 * (`-cb`), and the unique abbreviations argparse accepts (`--boa`). A -D flag
 * anywhere belongs in west_flags.
 */
export function findReservedWestArg(westArgs: string): { token: string; field: string } | undefined {
  let afterSeparator = false;
  for (const token of tokenizeWestArgs(westArgs)) {
    if (token === '--') {
      afterSeparator = true;
      continue;
    }
    if (/^-D/.test(token)) {
      return { token, field: 'west_flags' };
    }
    if (afterSeparator) {
      // Everything after -- goes to CMake, where only -D can clash.
      continue;
    }
    if (token.startsWith('--')) {
      const name = token.split('=', 1)[0];
      for (const option of RESERVED_WEST_OPTIONS) {
        const abbreviated = name.length >= 3 && !COMPLETE_LONG_OPTIONS.has(name)
          && option.long.some(long => long.startsWith(name));
        if (option.long.includes(name) || abbreviated) {
          return { token, field: option.field };
        }
      }
      continue;
    }
    if (/^-[A-Za-z]/.test(token)) {
      let index = 1;
      while (index < token.length && VALUELESS_SHORT_FLAGS.has(token[index])) {
        index++;
      }
      const letter = token[index];
      const option = RESERVED_WEST_OPTIONS.find(candidate => candidate.short === letter);
      if (option) {
        return { token, field: option.field };
      }
    }
  }
  return undefined;
}

/** Throw unless `value` may be stored as the west arguments of a configuration. */
export function assertWestArgs(value: string): string {
  assertSafeShellFragment(value, 'west_args');
  const reserved = findReservedWestArg(value);
  if (reserved) {
    throw invalid(`west_args must not contain "${reserved.token}": that is set through ${reserved.field}.`,
      'Remove it from west_args and use the dedicated field instead.');
  }
  return value;
}

/** Validate one -D flag and return it normalized as NAME or NAME=VALUE. */
export function parseWestFlag(raw: string, label = 'west_flags'): string {
  const normalized = normalizeWestFlagDValue(raw);
  if (!normalized) {
    throw invalid(`${label} has an empty entry.`);
  }
  const name = westFlagDName(normalized);
  assertCmakeVariableName(name, `${label} entry name`);
  const separatorIndex = normalized.indexOf('=');
  if (separatorIndex !== -1) {
    try {
      assertSafeShellFragment(normalized.slice(separatorIndex + 1), `${label} value of ${name}`);
    } catch (error) {
      if (error instanceof McpToolError && /";"/.test(error.message)) {
        // A CMake list is the usual reason for a ";" here.
        throw invalid(error.message,
          'A CMake list cannot be stored as a -D flag. Put configuration files and overlays in env.EXTRA_CONF_FILE or env.EXTRA_DTC_OVERLAY_FILE, which take lists.');
      }
      throw error;
    }
  }
  return normalized;
}

function checkListEdit(edit: ListEdit, label: string): void {
  if (edit.set !== undefined && (edit.add !== undefined || edit.remove !== undefined)) {
    throw invalid(`${label}: set replaces the whole list, so it cannot be combined with add or remove.`);
  }
  if (edit.set === undefined && edit.add === undefined && edit.remove === undefined) {
    throw invalid(`${label} needs set, add or remove.`);
  }
  for (const part of ['set', 'add', 'remove'] as const) {
    const items = edit[part];
    if (items !== undefined && (!Array.isArray(items) || items.some(item => typeof item !== 'string'))) {
      throw invalid(`${label}.${part} must be a list of strings.`);
    }
    if (items && items.length > MAX_LIST_ITEMS) {
      throw invalid(`${label}.${part} has ${items.length} entries; at most ${MAX_LIST_ITEMS} are accepted.`);
    }
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/** Apply set, or remove then add, keeping the order and never adding a duplicate. */
export function editList(
  current: readonly string[], edit: ListEdit, label: string,
  prepare: (value: string) => string, prepareRemoval: (value: string) => string,
  same: (a: string, b: string) => boolean, warnings: string[],
): string[] {
  checkListEdit(edit, label);
  const unique = (values: string[]) => values.filter((value, index) => values.findIndex(other => same(other, value)) === index);
  if (edit.set) {
    return unique(edit.set.map(prepare));
  }
  let next = [...current];
  for (const raw of edit.remove ?? []) {
    const wanted = prepareRemoval(raw);
    const before = next.length;
    next = next.filter(entry => !same(entry, wanted));
    if (next.length === before) {
      warnings.push(`${label}: "${raw}" was not in the list, so nothing was removed for it.`);
    }
  }
  for (const raw of edit.add ?? []) {
    const value = prepare(raw);
    if (!next.some(entry => same(entry, value))) {
      next.push(value);
    }
  }
  return next;
}

/** -D flags: an added flag replaces one of the same name, and a bare NAME removes it whatever its value. */
function editWestFlags(current: readonly string[], edit: ListEdit, warnings: string[]): string[] {
  checkListEdit(edit, 'west_flags');
  if (edit.set) {
    const flags = edit.set.map(raw => parseWestFlag(raw));
    const names = flags.map(westFlagDName);
    const repeated = names.find((name, index) => names.indexOf(name) !== index);
    if (repeated) {
      throw invalid(`west_flags.set gives ${repeated} more than once.`);
    }
    return flags;
  }
  const next = [...current];
  for (const raw of edit.remove ?? []) {
    const wanted = normalizeWestFlagDValue(raw);
    const byName = !wanted.includes('=');
    const matches = next.filter(flag => (byName ? westFlagDName(flag) === wanted : flag === wanted));
    if (matches.length === 0) {
      warnings.push(`west_flags: "${raw}" was not in the list, so nothing was removed for it.`);
    }
    for (const flag of matches) {
      removeWestFlagDValue(next, flag);
    }
  }
  for (const raw of edit.add ?? []) {
    const flag = parseWestFlag(raw);
    const existing = next.find(entry => westFlagDName(entry) === westFlagDName(flag));
    if (existing !== undefined) {
      replaceWestFlagDValue(next, existing, flag);
    } else {
      addWestFlagDValue(next, flag);
    }
  }
  return next;
}

/** Work out what `edit` changes in a configuration holding `current`. Throws on the first invalid field. */
export function planConfigEdit(current: ConfigValues, edit: ConfigEdit, options: PlanOptions): ConfigPlan {
  const plan: ConfigPlan = { settings: {}, env: {}, changed: [], warnings: [], boardChanged: false, sysbuildChanged: false };
  const exists = options.exists ?? fs.existsSync;
  const samePath = options.samePath ?? ((a: string, b: string) => normalizeForCompare(a) === normalizeForCompare(b));

  if (edit.board !== undefined) {
    const board = edit.board.trim();
    if (!board) {
      throw invalid('board cannot be empty: every configuration builds for a board.');
    }
    if (board.length > MAX_BOARD_LENGTH) {
      throw invalid(`board is too long (${board.length} characters, maximum ${MAX_BOARD_LENGTH}).`);
    }
    assertBoardIdentifier(board);
    if (board !== current.board) {
      plan.settings.board = board;
      plan.changed.push('board');
      plan.boardChanged = true;
    }
  }

  if (edit.sysbuild !== undefined && edit.sysbuild !== current.sysbuild) {
    plan.settings[ZEPHYR_BUILD_CONFIG_SYSBUILD_SETTING_KEY] = edit.sysbuild ? 'true' : 'false';
    plan.changed.push('sysbuild');
    plan.sysbuildChanged = true;
  }

  if (edit.west_args !== undefined) {
    const westArgs = edit.west_args.trim();
    if (westArgs) {
      assertWestArgs(westArgs);
    }
    if (westArgs !== current.westArgs) {
      plan.settings[ZEPHYR_BUILD_CONFIG_WEST_ARGS_SETTING_KEY] = westArgs || undefined;
      plan.changed.push('west_args');
    }
  }

  if (edit.west_flags !== undefined) {
    const flags = editWestFlags(current.westFlags, edit.west_flags, plan.warnings);
    if (!sameList(flags, current.westFlags)) {
      plan.settings[ZEPHYR_BUILD_CONFIG_WEST_FLAGS_D_SETTING_KEY] = flags.length > 0 ? flags : undefined;
      plan.changed.push('west_flags');
    }
  }

  // The runner and its arguments go together: arguments without a runner are
  // never used, so the same rule as the Applications view applies.
  let runner = current.defaultRunner || undefined;
  if (edit.default_runner !== undefined) {
    const wanted = edit.default_runner.trim();
    if (wanted) {
      assertRunnerName(wanted);
      if (options.buildRunners && !options.buildRunners.includes(wanted)) {
        throw new McpToolError('RUNNER_UNKNOWN', `The board of this configuration has no runner "${wanted}" in its runners.yaml.`, {
          hint: 'Use one of the runners listed in details, or call list_runners.',
          details: { available: [...options.buildRunners] },
        });
      }
      if (!options.buildRunners && !options.staticRunners.includes(wanted)) {
        plan.warnings.push(`"${wanted}" is not a runner the workbench knows. It is stored anyway; build first and call list_runners to see the runners this board supports.`);
      }
    }
    if ((wanted || undefined) !== runner) {
      plan.settings[ZEPHYR_BUILD_CONFIG_DEFAULT_RUNNER_SETTING_KEY] = wanted || undefined;
      plan.changed.push('default_runner');
    }
    runner = wanted || undefined;
  }

  let runnerArgs = current.runnerArgs || undefined;
  if (edit.runner_args !== undefined) {
    const wanted = edit.runner_args.trim();
    if (wanted) {
      assertSafeShellFragment(wanted, 'runner_args');
      if (!runner) {
        throw invalid('runner_args needs a default runner, and this configuration has none.',
          'Pass default_runner in the same call, or set it first.');
      }
    }
    if ((wanted || undefined) !== runnerArgs) {
      plan.settings[ZEPHYR_BUILD_CONFIG_CUSTOM_ARGS_SETTING_KEY] = wanted || undefined;
      plan.changed.push('runner_args');
    }
    runnerArgs = wanted || undefined;
  }
  if (edit.default_runner !== undefined && !runner && runnerArgs && edit.runner_args === undefined) {
    // Clearing the runner clears its arguments too.
    plan.settings[ZEPHYR_BUILD_CONFIG_CUSTOM_ARGS_SETTING_KEY] = undefined;
    plan.changed.push('runner_args');
  }

  if (edit.env !== undefined) {
    if (!edit.env || typeof edit.env !== 'object' || Array.isArray(edit.env)) {
      throw invalid('env must be an object keyed by build variable name.');
    }
    for (const [key, listEdit] of Object.entries(edit.env)) {
      if (listEdit === undefined) {
        continue;
      }
      if (!(ENV_LIST_KEYS as readonly string[]).includes(key)) {
        throw invalid(`env.${key} is not a build variable a configuration stores.`, undefined, { allowed: [...ENV_LIST_KEYS] });
      }
      const envKey = key as EnvListKey;
      const label = `env.${envKey}`;
      const currentList = current.env[envKey] ?? [];
      const next = PATH_LIST_KEYS.has(envKey)
        ? editList(currentList, listEdit, label,
          value => {
            assertEnvListElement(value, label);
            const absolute = options.absolutePath(value);
            options.assertAllowedPath(absolute, label);
            if (!exists(absolute)) {
              plan.warnings.push(`${label}: "${absolute}" does not exist yet. It is stored anyway; the build fails until it exists.`);
            }
            return absolute;
          },
          value => options.absolutePath(value),
          samePath, plan.warnings)
        : editList(currentList, listEdit, label,
          value => assertShieldOrSnippetName(value.trim(), label),
          value => value.trim(),
          (a, b) => a === b, plan.warnings);
      if (!sameList(next, currentList)) {
        // An emptied list is stored as [], as the Applications view does: a
        // missing key makes the workbench look for the value elsewhere.
        plan.env[envKey] = next;
        plan.changed.push(label);
      }
    }
  }

  return plan;
}

/** The fields of `args` that change a configuration, in catalog order. */
export function editFieldsIn(args: Record<string, unknown>): EditField[] {
  return EDIT_FIELDS.filter(field => args[field] !== undefined);
}
