// Arguments of manage_app and configure target "app" that name folders. The
// Add Application wizard refuses spaces anywhere in an application path, and
// the path ends up in settings, task working directories and CMake, so an
// agent's value is held to a stricter allow-list: no spaces, no shell or glob
// characters, no parent references. Free of `vscode` so it is unit tested.

import * as path from 'path';
import { isPlainPath } from './argSafety';
import { McpToolError } from './errors';
import { logSafe } from './redact';

/** A folder name for a new application: what `west build` and every shell take unquoted. */
const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** One segment of the applications subfolder. */
const SUBFOLDER_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

function invalid(message: string, hint?: string): McpToolError {
  return new McpToolError('INVALID_ARGUMENT', message, { hint });
}

/** Throw unless `name` can be the folder name of a new application. */
export function assertAppName(name: string, label = 'name'): string {
  if (!APP_NAME.test(name) || name === '.' || name === '..') {
    throw invalid(`${label} "${logSafe(name, 80)}" is not a valid application folder name.`,
      'Use 1 to 64 letters, digits, dots, dashes and underscores, starting with a letter or digit, without spaces.');
  }
  return name;
}

/**
 * The applications subfolder of a west workspace, normalized to forward
 * slashes, or '' for the workspace root. Throws unless it is relative, stays
 * inside the workspace and has no spaces.
 */
export function assertApplicationsSubfolder(value: string): string {
  if (value.includes(' ')) {
    throw invalid('applications_subfolder cannot contain spaces.');
  }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw invalid(`applications_subfolder "${logSafe(value, 200)}" must be relative to the west workspace root.`);
  }
  const trimmed = value.replace(/[\\/]+$/g, '');
  if (trimmed.length === 0) {
    return '';
  }
  const segments = trimmed.split(/[\\/]+/);
  const bad = segments.find(segment => !SUBFOLDER_SEGMENT.test(segment) || segment === '.' || segment === '..');
  if (bad !== undefined) {
    throw invalid(`applications_subfolder "${logSafe(value, 200)}" has the segment "${logSafe(bad, 64)}", which is not allowed.`,
      'Use folder names of letters, digits, dots, dashes and underscores separated by /, without spaces or "..".');
  }
  return segments.join('/');
}

/**
 * Throw unless `value` is an absolute folder path an application may live in
 * or be imported from: a plain path, without spaces.
 */
export function assertAppFolderPath(value: string, label: string): string {
  if (!path.isAbsolute(value)) {
    throw invalid(`${label} "${logSafe(value, 300)}" is not an absolute path.`);
  }
  if (value.includes(' ')) {
    throw invalid(`${label} "${logSafe(value, 300)}" contains a space, which Zephyr Workbench does not allow in an application path.`,
      'Pick a folder whose path has no spaces.');
  }
  if (!isPlainPath(value) || value.split(/[\\/]+/).includes('..')) {
    throw invalid(`${label} "${logSafe(value, 300)}" contains characters that are not allowed in an application path.`,
      'Use a path of letters, digits, path separators and . _ - only.');
  }
  return value;
}
