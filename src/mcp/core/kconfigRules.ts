// The rules behind query_kconfig's explain mode and set_kconfig: what an agent may
// assign, how each value is written, and how the result of a simulated merge becomes
// a per-assignment verdict. Pure, so every rule is unit tested without Python.
//
// The verdicts mirror Zephyr's scripts/kconfig/kconfig.py, which runs whenever the
// fragments change. An assignment to a symbol without a prompt, or to one that does not
// exist, aborts the configure, so writing it would break the user's build. A value that
// does not take (unmet dependencies, a selecting symbol, a range) only prints a warning
// there, but the line then changes nothing and misleads whoever reads the file later,
// so set_kconfig refuses both kinds and says why.

import * as path from 'path';
import { assertKconfigSymbol } from './argSafety';
import { McpToolError } from './errors';
import { logSafe } from './redact';
import type {
  KcChoiceSummary, KcExplainDefinition, KcExplainChoice, KcExplainSymbol, KcMergeSymbol, KcReverseDep, KcTerm,
} from '../../utils/kconfig/kconfigRpcTypes';

export const CONFIG_PREFIX = 'CONFIG_';
export const MAX_ASSIGNMENTS = 50;
export const MAX_EXPLAIN_SYMBOLS = 10;
export const MAX_STRING_VALUE = 1024;

/**
 * Control characters are refused in every string value: kconfiglib escapes only quotes
 * and backslashes, so a newline would end the line and start an assignment of its own.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** A symbol name as the agent gave it, with or without CONFIG_, checked. */
export function symbolName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new McpToolError('INVALID_ARGUMENT', 'Every symbol must be a string such as CONFIG_GPIO or GPIO.');
  }
  const name = raw.trim().replace(/^CONFIG_/, '');
  assertKconfigSymbol(name);
  return name;
}

export interface Assignment {
  /** Without the CONFIG_ prefix. */
  name: string;
  unset: boolean;
  value?: string | boolean | number;
}

/** Check the shape of set_kconfig's assignments before anything is resolved. */
export function parseAssignments(raw: unknown): Assignment[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new McpToolError('INVALID_ARGUMENT', 'assignments must list at least one change.');
  }
  if (raw.length > MAX_ASSIGNMENTS) {
    throw new McpToolError('INVALID_ARGUMENT', `assignments has ${raw.length} entries; at most ${MAX_ASSIGNMENTS} are allowed in one call.`);
  }
  const seen = new Set<string>();
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new McpToolError('INVALID_ARGUMENT', `assignments[${index}] must be an object with symbol and value, or symbol and unset.`);
    }
    const entry = item as Record<string, unknown>;
    const name = symbolName(entry.symbol);
    if (seen.has(name)) {
      throw new McpToolError('INVALID_ARGUMENT', `CONFIG_${name} appears twice in assignments. Give each symbol once.`);
    }
    seen.add(name);
    const hasValue = entry.value !== undefined && entry.value !== null;
    const unset = entry.unset === true;
    if (hasValue === unset) {
      throw new McpToolError('INVALID_ARGUMENT',
        `assignments[${index}] (CONFIG_${name}) needs exactly one of value or unset true.`);
    }
    if (unset) {
      return { name, unset: true };
    }
    const value = entry.value;
    if (typeof value === 'string') {
      if (CONTROL_CHARS.test(value)) {
        throw new McpToolError('INVALID_ARGUMENT',
          `The value for CONFIG_${name} contains a control character such as a newline, which a configuration line cannot hold.`);
      }
      if (value.length > MAX_STRING_VALUE) {
        throw new McpToolError('INVALID_ARGUMENT',
          `The value for CONFIG_${name} is ${value.length} characters long; at most ${MAX_STRING_VALUE} are allowed.`);
      }
      return { name, unset: false, value };
    }
    if (typeof value === 'boolean') {
      return { name, unset: false, value };
    }
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      return { name, unset: false, value };
    }
    throw new McpToolError('INVALID_ARGUMENT',
      `The value for CONFIG_${name} must be text, true or false, or a whole number.`);
  });
}

/** How a value is written to a fragment, and how kconfiglib then holds it. */
export interface FormattedValue {
  /** The complete configuration line. */
  line: string;
  /** The user value kconfiglib stores for that line (unescaped). */
  value: string;
}

/** kconfiglib's escape(): backslash first, then the double quote. */
function escapeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Format one value for a symbol of `type`, or explain why it does not fit. */
export function formatAssignment(name: string, type: string, raw: string | boolean | number): FormattedValue | { error: string } {
  const key = `${CONFIG_PREFIX}${name}`;
  switch (type) {
    case 'bool':
    case 'tristate': {
      const allowed = type === 'bool' ? ['y', 'n'] : ['y', 'm', 'n'];
      const text = typeof raw === 'boolean' ? (raw ? 'y' : 'n') : typeof raw === 'string' ? raw.trim().toLowerCase() : undefined;
      if (text === undefined || !allowed.includes(text)) {
        return { error: `${key} is a ${type} symbol, so its value must be ${allowed.join(', ')} (or true/false).` };
      }
      return { line: `${key}=${text}`, value: text };
    }
    case 'int': {
      const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : undefined;
      if (text === undefined || !/^-?\d+$/.test(text)) {
        return { error: `${key} is an int symbol, so its value must be a decimal whole number such as 1024.` };
      }
      // Written without leading zeros: the value is copied as is into C headers,
      // where 0100 would be an octal 64.
      const canonical = BigInt(text).toString();
      return { line: `${key}=${canonical}`, value: canonical };
    }
    case 'hex': {
      let digits: string | undefined;
      if (typeof raw === 'number') {
        digits = raw >= 0 ? raw.toString(16) : undefined;
      } else if (typeof raw === 'string' && /^(0[xX])?[0-9a-fA-F]+$/.test(raw.trim())) {
        digits = raw.trim().replace(/^0[xX]/, '');
      }
      if (digits === undefined) {
        return { error: `${key} is a hex symbol, so its value must be a hexadecimal number such as 0x2000.` };
      }
      // Always with 0x: the value lands in C headers as it is written.
      return { line: `${key}=0x${digits}`, value: `0x${digits}` };
    }
    case 'string': {
      if (typeof raw === 'boolean') {
        return { error: `${key} is a string symbol, so its value must be text.` };
      }
      const text = String(raw);
      if (CONTROL_CHARS.test(text)) {
        return { error: `The value for ${key} contains a control character, which a configuration line cannot hold.` };
      }
      return { line: `${key}="${escapeString(text)}"`, value: text };
    }
    default:
      return { error: `${key} has no type in this build's Kconfig tree, so it cannot be assigned.` };
  }
}

/** Whether two values of a symbol mean the same thing (0x10 and 0x010 do). */
export function sameValue(type: string, a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    return a === b;
  }
  if (type === 'int' || type === 'hex') {
    try {
      const parse = (v: string) => BigInt(type === 'hex' && !/^-?0[xX]/.test(v) ? `0x${v}` : v);
      return parse(a) === parse(b);
    } catch {
      return a === b;
    }
  }
  return a === b;
}

/** Where a file sits relative to the build, for pointing the agent at the fix. */
export interface OverrideSite {
  file: string;
  line?: number;
}

export type SetStatus = 'applied' | 'unchanged' | 'removed' | 'rejected' | 'overridden';

export interface SetResult {
  symbol: string;
  requested: string | null;
  previous: string | null;
  status: SetStatus;
  effective_after_merge: string | null;
  line?: string;
  reason?: string;
  blocked_by?: KcTerm[];
  selected_by_active?: string[];
  overridden_by?: OverrideSite;
  hint?: string;
}

export interface EvaluateInput {
  name: string;
  type: string;
  unset: boolean;
  formatted?: FormattedValue;
  /** Value in the loaded .config. */
  previous: string | null;
  merge: KcMergeSymbol | undefined;
  /** The managed region already had exactly this line (or, for unset, had no line). */
  regionAlready: boolean;
  /** Whether the managed region had a line for the symbol before this call. */
  regionHadLine: boolean;
  /** Where the winning assignment is, already mapped from the stand-in to the real file. */
  winner?: OverrideSite;
  /** The file being written, to tell a same-file override from a later fragment. */
  targetPath: string;
  /** The build directory, where generated fragments live. */
  buildDir: string;
  appRoot: string;
}

function isUnder(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function describeSite(site: OverrideSite): string {
  return `${site.file}${site.line ? `:${site.line}` : ''}`;
}

function choiceMembers(choice: KcChoiceSummary): string {
  return choice.members.map(member => `${CONFIG_PREFIX}${member.name}`).join(', ');
}

/** Turn the merge simulation for one assignment into its verdict. */
export function evaluateAssignment(input: EvaluateInput): SetResult {
  const key = `${CONFIG_PREFIX}${input.name}`;
  const m = input.merge;
  const base: SetResult = {
    symbol: key,
    requested: input.unset ? null : input.formatted?.value ?? null,
    previous: input.previous,
    status: 'applied',
    effective_after_merge: m?.value ?? null,
    ...(input.formatted && !input.unset ? { line: input.formatted.line } : {}),
  };

  if (!m) {
    return { ...base, status: 'rejected', reason: `${key} is not defined in this build's Kconfig tree.` };
  }

  if (input.unset) {
    if (!input.regionHadLine) {
      return {
        ...base, status: 'unchanged',
        reason: m.userValue !== null && input.winner
          ? `No managed line assigns it, so there is nothing to remove. It is assigned at ${describeSite(input.winner)}, which set_kconfig never edits.`
          : 'No managed line assigns it, so there is nothing to remove.',
      };
    }
    if (m.userValue !== null && !m.took) {
      return {
        ...base, status: 'rejected',
        reason: `Without the managed line, the assignment at ${input.winner ? describeSite(input.winner) : 'another fragment'} would win, and it does not take: ${m.failure ?? `the value would be ${m.value}`}.`,
        ...(m.missingDeps.length ? { blocked_by: m.missingDeps } : {}),
      };
    }
    return {
      ...base, status: 'removed',
      ...(m.userValue !== null && input.winner
        ? { reason: `It is still assigned at ${describeSite(input.winner)}, which now decides its value.` }
        : {}),
    };
  }

  const formatted = input.formatted as FormattedValue;
  if (m.promptless) {
    return {
      ...base, status: 'rejected',
      reason: `${key} has no prompt, so Zephyr refuses to assign it in a configuration file: it only follows its defaults and the symbols that select it.`,
      hint: `Call query_kconfig with explain true for ${key} to see what selects it, and change that instead.`,
    };
  }

  if (!sameValue(input.type, m.userValue, formatted.value)) {
    const site = input.winner;
    const generated = !!site && isUnder(site.file, input.buildDir);
    const sameFile = !!site && path.resolve(site.file) === path.resolve(input.targetPath);
    let hint: string;
    if (site && generated && path.basename(site.file) === 'extra_kconfig_options.conf') {
      hint = `The winning line is generated from a -D${key} flag in the build configuration's CMake arguments. Remove that flag first, or ask the user to.`;
    } else if (generated) {
      hint = 'The winning line is generated by the build itself (for example by sysbuild from an SB_CONFIG option), so change what generates it instead.';
    } else if (sameFile) {
      hint = `That line sits after the managed region of the same file. Remove or change it there, then repeat the call.`;
    } else if (site && isUnder(site.file, input.appRoot)) {
      hint = `That file merges later. Set the value there instead with target "fragment" and fragment_path "${site.file}".`;
    } else {
      hint = 'That file merges later and is outside the application, so ask the user whether to change it.';
    }
    return {
      ...base, status: 'overridden',
      reason: `A later assignment wins: ${site ? describeSite(site) : 'another fragment'} sets it to ${m.userValue ?? 'nothing'}.`,
      ...(site ? { overridden_by: site } : {}),
      hint,
    };
  }

  if (!m.took) {
    const wanted = formatted.value;
    if (m.choice) {
      const choice = m.choice;
      if (wanted === 'n' && choice.mode === 'y') {
        return {
          ...base, status: 'rejected',
          reason: `${key} belongs to the choice "${choice.prompt ?? choice.name}", which always has one member selected, so it cannot simply be turned off.`,
          hint: `Set another member to y instead: ${choiceMembers(choice)}.`,
        };
      }
      return {
        ...base, status: 'rejected',
        reason: `${key} would not be the selected member of its choice: ${choice.selected ? `${CONFIG_PREFIX}${choice.selected}` : 'no member'} ends up selected.`,
        ...(m.missingDeps.length ? { blocked_by: m.missingDeps } : {}),
        hint: 'Set only one member of a choice to y, and check its dependencies with query_kconfig explain.',
      };
    }
    if (m.missingDeps.length) {
      return {
        ...base, status: 'rejected',
        reason: `${key} would be ${m.value || 'unset'} instead of ${wanted}: its dependencies are not met.`,
        blocked_by: m.missingDeps,
        hint: 'Enable what blocked_by lists first (in the same call when those symbols can be set), or call query_kconfig with explain true for them.',
      };
    }
    if (m.activeSelectors.length && (wanted === 'n' || wanted === 'm')) {
      return {
        ...base, status: 'rejected',
        reason: `${key} is selected by ${m.activeSelectors.map(s => `${CONFIG_PREFIX}${s}`).join(', ')}, which ${m.activeSelectors.length === 1 ? 'forces' : 'force'} it on.`,
        selected_by_active: m.activeSelectors.map(s => `${CONFIG_PREFIX}${s}`),
        hint: 'Turn the selecting symbols off first, if that is really wanted.',
      };
    }
    if (m.activeRange && (input.type === 'int' || input.type === 'hex')) {
      return {
        ...base, status: 'rejected',
        reason: `${wanted} is outside the allowed range of ${key}, ${m.activeRange.low} to ${m.activeRange.high}.`,
      };
    }
    return {
      ...base, status: 'rejected',
      reason: `${key} ${m.failure ?? `would end up as ${m.value}`}.`,
      hint: `Call query_kconfig with explain true for ${key} to see what decides its value.`,
    };
  }

  return { ...base, status: input.regionAlready ? 'unchanged' : 'applied' };
}

// -- explain -----------------------------------------------------------------

export interface ExplainExtras {
  /** Absolute path for a definition file (kconfiglib gives in-tree files relative). */
  resolveFile(file: string): string;
  /** Why the last build gave the symbol its value, from the configuration trace. */
  origin?: { kind: string; file?: string; line?: number; expr?: string };
  /** Every assignment of the symbol in the build's fragments, in merge order. */
  assignedIn?: { file: string; line: number; value: string }[];
}

/** Definition sites returned per symbol; common symbols are defined again for every SoC. */
const DEFINITIONS_CAP = 10;

/** One plain sentence on how to change the symbol, from what blocks it. */
export function howToChange(sym: KcExplainSymbol): string {
  const key = `${CONFIG_PREFIX}${sym.name}`;
  const selectors = sym.selectedBy.filter(s => s.active && s.name).map(s => `${CONFIG_PREFIX}${s.name}`);
  if (sym.promptless) {
    const why = selectors.length
      ? ` Right now it is selected by ${selectors.join(', ')}.`
      : sym.defaults.length ? ' It takes its value from the defaults listed here.' : '';
    return `${key} has no prompt, so no configuration file can set it: change the symbols that select it or the conditions of its defaults instead.${why}`;
  }
  const depends = sym.blockedBy.filter(term => term.kind === 'depends_on').map(term => term.expr);
  if (depends.length) {
    return `Enable its dependencies first (${depends.join('; ')}), then set ${key} with set_kconfig.`;
  }
  const hidden = sym.blockedBy.filter(term => term.kind === 'visibility').map(term => term.expr);
  if (hidden.length || sym.visibility === 'n') {
    return hidden.length
      ? `Its prompt is hidden by ${hidden.join('; ')} (a "visible if" or "prompt ... if" condition); make that true, then set ${key} with set_kconfig.`
      : 'Its prompt is not visible in this configuration, so it cannot be set; see depends_on and prompt_conditions.';
  }
  if (sym.choice) {
    const current = sym.choice.selected && sym.choice.selected !== sym.name ? `${CONFIG_PREFIX}${sym.choice.selected}` : 'the current member';
    return `${key} belongs to the choice "${sym.choice.prompt ?? sym.choice.name}": select it by setting it to y with set_kconfig, which deselects ${current}. Members: ${choiceMembers(sym.choice)}.`;
  }
  if (selectors.length && sym.value === 'y') {
    return `${key} is forced on by ${selectors.join(', ')}; turn those off first to turn it off. It can be set with set_kconfig otherwise.`;
  }
  if ((sym.type === 'int' || sym.type === 'hex') && sym.activeRange) {
    return `Set it with set_kconfig to a value from ${sym.activeRange.low} to ${sym.activeRange.high}.`;
  }
  const allowed = sym.type === 'bool' || sym.type === 'tristate'
    ? sym.assignable.join(' or ')
    : sym.type === 'string' ? 'text' : `an ${sym.type} value`;
  return `Set it with set_kconfig to ${allowed}.`;
}

/** Definition sites with absolute paths, the ones that apply on this board first. */
function definitionsOut(definitions: KcExplainDefinition[], resolveFile: (file: string) => string) {
  const ordered = [...definitions.filter(d => d.active), ...definitions.filter(d => !d.active)];
  return {
    defined_at: ordered.slice(0, DEFINITIONS_CAP).map(def => ({
      file: resolveFile(def.file), line: def.line, menu_path: def.menuPath, active: def.active,
    })),
    ...(ordered.length > DEFINITIONS_CAP ? { defined_at_total: ordered.length } : {}),
  };
}

function reverseDeps(list: KcReverseDep[]) {
  return list.map(entry => ({
    ...(entry.name ? { name: `${CONFIG_PREFIX}${entry.name}`, value: entry.value } : {}),
    active: entry.active,
    expr: entry.expr,
  }));
}

/** The agent-facing explanation of one symbol or choice. */
export function explainOutput(raw: KcExplainSymbol | KcExplainChoice, extras: ExplainExtras): Record<string, unknown> {
  const definitions = definitionsOut(raw.definitions, extras.resolveFile);
  if (raw.kind === 'choice') {
    return {
      name: raw.name === '<choice>' ? raw.name : `${CONFIG_PREFIX}${raw.name}`,
      kind: 'choice',
      prompt: raw.prompt,
      mode: raw.mode,
      selected: raw.selected ? `${CONFIG_PREFIX}${raw.selected}` : null,
      members: raw.members.map(m => ({ name: `${CONFIG_PREFIX}${m.name}`, value: m.value })),
      visible: raw.visibility !== 'n',
      help: raw.helps.join('\n\n') || undefined,
      depends_on: raw.dependsOn,
      blocked_by: raw.blockedBy,
      ...definitions,
      how_to_change: 'A choice is changed through its members: set the member you want to y with set_kconfig.',
    };
  }
  return {
    name: `${CONFIG_PREFIX}${raw.name}`,
    kind: 'symbol',
    type: raw.type,
    value: raw.value,
    assignable_values: raw.assignable,
    visible: raw.visibility !== 'n',
    promptless: raw.promptless,
    prompts: raw.prompts,
    help: raw.helps.join('\n\n') || undefined,
    ...(extras.origin ? { origin: extras.origin } : {}),
    depends_on: raw.dependsOn,
    ...(raw.promptConditions.length ? { prompt_conditions: raw.promptConditions } : {}),
    blocked_by: raw.blockedBy,
    selected_by: reverseDeps(raw.selectedBy),
    ...(raw.selectedByTotal > raw.selectedBy.length ? { selected_by_total: raw.selectedByTotal } : {}),
    implied_by: reverseDeps(raw.impliedBy),
    ...(raw.impliedByTotal > raw.impliedBy.length ? { implied_by_total: raw.impliedByTotal } : {}),
    selects: raw.selects.map(s => `${CONFIG_PREFIX}${s.name}`),
    implies: raw.implies.map(s => `${CONFIG_PREFIX}${s.name}`),
    defaults: raw.defaults.map(d => ({
      value: d.value,
      ...(d.used ? { used: true } : {}),
      ...(d.condition ? { condition: d.condition, condition_value: d.conditionValue } : {}),
      ...(d.file ? { file: extras.resolveFile(d.file), line: d.line } : {}),
    })),
    ...(raw.defaultsTotal > raw.defaults.length ? { defaults_total: raw.defaultsTotal } : {}),
    ...(raw.choice ? {
      choice: {
        name: raw.choice.name, prompt: raw.choice.prompt, mode: raw.choice.mode,
        selected: raw.choice.selected ? `${CONFIG_PREFIX}${raw.choice.selected}` : null,
        members: raw.choice.members.map(m => `${CONFIG_PREFIX}${m.name}`),
      },
    } : {}),
    ...(raw.activeRange ? { range: raw.activeRange } : {}),
    ...definitions,
    ...(extras.assignedIn && extras.assignedIn.length ? { assigned_in: extras.assignedIn } : {}),
    config_string: raw.configString || undefined,
    how_to_change: howToChange(raw),
  };
}

// -- errors ------------------------------------------------------------------

const CONFIGURE_HINT = 'Call build_app with cmake_only true, then retry.';

/**
 * Map a failure to start or use a Kconfig session onto the tool error contract.
 * `stderrTail` is the end of the server's own output, for crashes.
 */
export function kconfigToolError(error: unknown, stderrTail: string[] = []): McpToolError {
  if (error instanceof McpToolError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | undefined)?.code;
  switch (code) {
    case 'env-unavailable':
    case 'fallback-env-failed':
      return new McpToolError('BUILD_NOT_CONFIGURED', message, { hint: CONFIGURE_HINT });
    case 'no-python':
    case 'spawn-failed':
    case 'no-kconfiglib':
      return new McpToolError('DEPENDENCY_MISSING', message, {
        hint: 'The build\'s Python environment is missing or broken. Ask the user to check the Zephyr Workbench Python environment; get_status shows what is missing.',
      });
    case 'init-timeout':
    case 'timeout':
      return new McpToolError('TIMEOUT', message, { hint: 'Loading the Kconfig tree took too long. Repeat the call; a warm session answers quickly.' });
    case 'closing':
      // The session pool keeps servers out of a build folder while remove_or_delete removes it.
      return new McpToolError('BUSY', message, { hint: 'Wait for the deletion job to end, then call build_app to configure the build again.' });
    default: {
      const tail = stderrTail.slice(-8).map(line => logSafe(line, 300)).join('\n');
      return new McpToolError('INTERNAL', `The Kconfig server failed: ${logSafe(message, 1000)}`, {
        ...(tail ? { details: { server_output: tail } } : {}),
      });
    }
  }
}
