// Argument checks and confirmation subjects the toolchain handlers share.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isWritableLocation } from '../../../utils/zephyr/sdkUtils';
import { isPlainPath } from '../../core/argSafety';
import { McpToolError } from '../../core/errors';
import { logSafe } from '../../core/redact';
import { confirmCategoryOf, ToolContext } from '../../core/toolSpec';
import { ConfirmOutcome, ConfirmSubject } from '../confirmations';
import { HostDeps } from './deps';

type Ctx = ToolContext<HostDeps>;

export const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
export const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
export const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

export function invalid(message: string, hint?: string, details?: Record<string, unknown>): McpToolError {
  return new McpToolError('INVALID_ARGUMENT', message, { hint, details });
}

/** Refuse an argument this action does not take, instead of silently ignoring it. */
export function refuseUnexpected(args: Record<string, unknown>, accepted: readonly string[], what: string): void {
  const allowed = new Set(accepted);
  const unexpected = Object.keys(args).filter(key => args[key] !== undefined && !allowed.has(key));
  if (unexpected.length > 0) {
    throw invalid(`${what} does not take ${unexpected.join(', ')}.`, undefined, { accepted: [...allowed] });
  }
}

/** Refuse a value of the wrong type. */
export function checkTypes(args: Record<string, unknown>, types: {
  strings?: readonly string[]; booleans?: readonly string[]; stringArrays?: readonly string[];
}): void {
  for (const key of types.strings ?? []) {
    if (args[key] !== undefined && typeof args[key] !== 'string') {
      throw invalid(`${key} must be a string.`);
    }
  }
  for (const key of types.booleans ?? []) {
    if (args[key] !== undefined && typeof args[key] !== 'boolean') {
      throw invalid(`${key} must be true or false.`);
    }
  }
  for (const key of types.stringArrays ?? []) {
    const value = args[key];
    if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) {
      throw invalid(`${key} must be a list of strings.`);
    }
  }
}

export function requireString(args: Record<string, unknown>, key: string, what: string): string {
  const value = str(args[key]);
  if (!value || !value.trim()) {
    throw invalid(`${what} needs ${key}.`);
  }
  return value.trim();
}

/**
 * An absolute path an agent gives that may reach a shell or a URL: plain
 * characters only and, where a tar command line takes it, no spaces.
 */
export function assertPlainAbsolutePath(value: string, label: string, opts: { spaces?: boolean } = {}): string {
  if (!path.isAbsolute(value) || !isPlainPath(value) || value.includes('"') || (!opts.spaces && /\s/.test(value))) {
    throw invalid(`${label} must be an absolute path of plain characters${opts.spaces ? '' : ' without spaces'}, not "${logSafe(value, 200)}".`);
  }
  return path.resolve(value);
}

/** The longest path an agent may name to pick a listed toolchain. */
const MAX_LISTED_PATH_LENGTH = 4096;

/**
 * An absolute path an agent gives only to pick a toolchain list_toolchains
 * lists: it is compared with the listed paths and never reaches a shell, so it
 * may hold any character a folder name can, such as the parentheses of
 * "Program Files (x86)". Kept on one line and of bounded length.
 */
export function assertListedPath(value: string, label: string): string {
  if (value.length > MAX_LISTED_PATH_LENGTH || !path.isAbsolute(value) || /\p{Cc}/u.test(value)) {
    throw invalid(`${label} must be an absolute path on one line of at most ${MAX_LISTED_PATH_LENGTH} characters, not "${logSafe(value, 200)}".`,
      'Pass a path list_toolchains returns, exactly.');
  }
  return path.resolve(value);
}

/** The home folder or a filesystem root: never a toolchain folder to create in or delete. */
export function isHomeOrRoot(target: string): boolean {
  const resolved = path.resolve(target);
  return path.dirname(resolved) === resolved || path.resolve(os.homedir()) === resolved;
}

/** An existing folder the user can write to, which receives a new toolchain folder. */
export function assertParentFolder(value: string, label = 'parent_path'): string {
  const parent = assertPlainAbsolutePath(value, label);
  let isFolder = false;
  try {
    isFolder = fs.statSync(parent).isDirectory();
  } catch {
    isFolder = false;
  }
  if (!isFolder) {
    throw invalid(`${label} "${parent}" is not an existing folder.`, 'Create the folder first, or pass another one.');
  }
  if (!isWritableLocation(parent)) {
    throw permissionDenied(parent);
  }
  return parent;
}

/** The user cannot write there, and the workbench never asks for administrator rights. */
export function permissionDenied(target: string): McpToolError {
  return invalid(`You do not have permission to write to ${target}.`,
    'Pass a folder the user can write to. The workbench never asks for administrator rights; the user can fix the permissions themselves.');
}

/** Machine-wide changes are approved for the session as "actions on toolchains". */
export function toolchainSubject(summary: string, args: Record<string, unknown>, folder?: string): ConfirmSubject {
  const { wait_sec: _waitSec, ...request } = args;
  // The request is part of the subject, so an answer given late to one
  // install is never taken for another.
  const subject: ConfirmSubject & { request: Record<string, unknown> } = {
    summary, ...(folder ? { folder } : {}), scope: 'toolchains', scopeLabel: 'toolchains', request,
  };
  return subject;
}

export function confirmationOf(ctx: Ctx, outcome: ConfirmOutcome) {
  return outcome === 'not-required' || outcome === 'not-asked'
    ? undefined
    : { category: ctx.audit.confirmCategory, outcome };
}

/** Whether the call would ask the user; an approval given for the session may still skip it. */
export function confirmationRequired(ctx: Ctx, args: Record<string, unknown>): boolean {
  const category = confirmCategoryOf(ctx.tool, args);
  return !!category && ctx.deps.permissionOf(ctx.tool) === 'ask';
}

/**
 * A hint that points at a tool the user may have blocked: `served` when this
 * window serves it, else `unserved`, which says the user can allow it in the
 * AI Manager and names the Zephyr Workbench way for the user.
 */
export function fullToolHint(ctx: Ctx, tool: string, served: string, unserved: string): string {
  return ctx.deps.servedTools().has(tool) ? served : unserved;
}
