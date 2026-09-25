// The git and west values an agent passes to create or inspect a west
// workspace. They reach the command line unquoted (west init splices the
// repository URL and revision as they are) or a git ls-remote run, so each
// one is checked against a strict shape here instead of being escaped later.
// Free of `vscode`, so every rule is unit tested.

import * as path from 'path';
import { assertSafeShellFragment } from './argSafety';
import { McpToolError } from './errors';
import { logSafe } from './redact';

/** https://host[:port]/path, with no credentials, query or fragment. */
const HTTPS_URL = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})(?::\d{1,5})?\/[A-Za-z0-9._~+-][A-Za-z0-9._~/+-]*$/;
/** The scp-like form git and west take for ssh: git@host:path. */
const SSH_URL = /^git@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}):[A-Za-z0-9._~+-][A-Za-z0-9._~/+-]*$/;
/** A tag, branch or commit, never starting with "-" so git cannot read it as an option. */
const REVISION = /^[A-Za-z0-9_][A-Za-z0-9._/+-]{0,127}$/;
const MANIFEST_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\.ya?ml$/;
/** A west project name, as a manifest lists it and west blobs fetch takes it. */
const PROJECT_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
/** One folder name: no separator, no space, nothing a shell reads. */
const FOLDER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

const MAX_URL_LENGTH = 512;

function invalid(message: string, hint?: string): McpToolError {
  return new McpToolError('INVALID_ARGUMENT', message, { hint });
}

/** Throw unless `value` is an https or git@ repository URL safe to put on a command line. */
export function assertGitUrl(value: string, label = 'url'): string {
  if (value.length > MAX_URL_LENGTH) {
    throw invalid(`${label} is too long (${value.length} characters, maximum ${MAX_URL_LENGTH}).`);
  }
  if (!HTTPS_URL.test(value) && !SSH_URL.test(value)) {
    throw invalid(`${label} "${logSafe(value, 200)}" is not a repository URL this tool accepts.`,
      'Pass https://host/path or git@host:path, without spaces, credentials, a query or shell characters.');
  }
  // Belt and braces: the shape above already leaves out every shell metacharacter.
  assertSafeShellFragment(value, label);
  if (value.split(/[/:]/).some(segment => segment === '..')) {
    throw invalid(`${label} "${logSafe(value, 200)}" has a ".." segment.`);
  }
  return value;
}

/** Throw unless `value` is a git revision (tag, branch or commit) safe to put on a command line. */
export function assertGitRevision(value: string, label = 'revision'): string {
  if (!REVISION.test(value) || value.includes('..') || value.endsWith('/') || value.endsWith('.lock')) {
    throw invalid(`${label} "${logSafe(value, 140)}" is not a valid git revision.`,
      'Pass a tag, branch or commit such as v4.2.0 or main, as search_zephyr_catalog kind revision lists them.');
  }
  return value;
}

/** Throw unless `value` is the file name of a west manifest: a .yml or .yaml basename. */
export function assertManifestFileName(value: string, label = 'manifest_file'): string {
  if (!MANIFEST_FILE.test(value)) {
    throw invalid(`${label} "${logSafe(value, 100)}" must be a .yml or .yaml file name, such as west.yml, with no folder.`);
  }
  return value;
}

/** Throw unless `value` is a west project name. */
export function assertWestProjectName(value: string, label: string): string {
  if (!PROJECT_NAME.test(value)) {
    throw invalid(`${label} "${logSafe(value, 140)}" is not a west project name.`,
      'Pass names as search_zephyr_catalog kind project or blob lists them.');
  }
  return value;
}

/** Throw unless `value` names one folder, with no separator or space. */
export function assertFolderName(value: string, label: string): string {
  if (!FOLDER_NAME.test(value) || value === '.' || value === '..') {
    throw invalid(`${label} "${logSafe(value, 100)}" must be one folder name of letters, digits and . _ - with no space or separator.`);
  }
  return value;
}

/**
 * Throw unless `value` is an absolute path with no whitespace, which west and
 * the environment scripts do not handle. The plain-path rule of the caller
 * still applies on top.
 */
export function assertNoWhitespacePath(value: string, label: string, platform: NodeJS.Platform = process.platform): string {
  const isAbsolute = platform === 'win32' ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value);
  if (!isAbsolute) {
    throw invalid(`${label} "${logSafe(value, 300)}" is not an absolute path.`);
  }
  if (/\s/.test(value)) {
    throw invalid(`${label} "${logSafe(value, 300)}" contains a space. West workspaces cannot live in a path with spaces.`,
      'Pick a folder whose path has no spaces.');
  }
  return value;
}
