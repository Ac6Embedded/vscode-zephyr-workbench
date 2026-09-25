// Decides whether an agent may delete a build folder, before anything is
// deleted and again right before it is.
//
// The folder comes from a configuration name, which is only a settings value:
// a hand-edited ".." would point at the application, a symbolic link at
// anything on the disk, and an unexpected folder could hold user files. So the
// fence checks the path lexically, then on the real file system (symbolic
// links refused, real path inside the real application root), then that no
// folder this window works in lies inside it, and last that it only holds
// build output. Free of `vscode` so it is unit tested against real folders.

import * as fs from 'fs';
import * as path from 'path';
import { looksLikeBuildDir } from '../../utils/zephyr/westBuildState';
import { isInside, normalizeForCompare } from './argSafety';
import { McpToolError } from './errors';

/** Files an operating system drops into any folder, never user data. */
const OS_METADATA_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const MAX_LISTED = 20;

export interface BuildDirFenceInput {
  appRootPath: string;
  /** From resolveBuildDirToDelete: <app>/build or <app>/build/<name>. */
  target: string;
  /** The application's configuration names: their folders count as build output. */
  configNames: readonly string[];
  /** Every folder this window works in; none may be inside the target. */
  knownRoots: readonly string[];
  platform?: NodeJS.Platform;
}

function outside(message: string, details?: Record<string, unknown>): McpToolError {
  return new McpToolError('PATH_OUTSIDE_WORKSPACE', message, {
    hint: 'Only build output inside the application can be deleted. Delete anything else by hand if you are sure.',
    details,
  });
}

function lstatOrUndefined(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target);
  } catch {
    return undefined;
  }
}

function realOrSelf(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return target;
  }
}

function isEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/**
 * Throw unless deleting `target` would only remove build output of the
 * application. Returns whether the folder exists: a missing one needs no
 * deletion, which keeps the tool idempotent.
 */
export function checkBuildDirDeletion(input: BuildDirFenceInput): { exists: boolean } {
  const platform = input.platform ?? process.platform;
  const same = (a: string, b: string) => normalizeForCompare(a, platform) === normalizeForCompare(b, platform);
  const buildRoot = path.join(input.appRootPath, 'build');
  const whole = same(input.target, buildRoot);
  const relative = path.relative(buildRoot, input.target);
  if (!whole && (!relative || relative === '.' || relative === '..' || relative.includes('/') || relative.includes('\\')
    || path.isAbsolute(relative))) {
    throw outside(`"${input.target}" is not a build folder of "${input.appRootPath}".`);
  }

  const rootStat = lstatOrUndefined(buildRoot);
  if (!rootStat) {
    return { exists: false };
  }
  if (rootStat.isSymbolicLink()) {
    throw outside(`"${buildRoot}" is a symbolic link, so deleting through it could remove files outside the application.`);
  }
  const targetStat = whole ? rootStat : lstatOrUndefined(input.target);
  if (!targetStat) {
    return { exists: false };
  }
  if (targetStat.isSymbolicLink()) {
    throw outside(`"${input.target}" is a symbolic link, so deleting it could remove files outside the application.`);
  }
  if (!targetStat.isDirectory()) {
    throw new McpToolError('INVALID_ARGUMENT', `"${input.target}" is a file, not a build folder.`, {
      hint: 'Delete it by hand if you are sure it is not needed.',
    });
  }

  const realTarget = realOrSelf(input.target);
  const realApp = realOrSelf(input.appRootPath);
  if (!isInside(realTarget, realApp, platform) || same(realTarget, realApp)) {
    throw outside(`"${input.target}" resolves to "${realTarget}", which is not inside the application "${realApp}".`);
  }
  const containedRoot = input.knownRoots.find(root =>
    isInside(root, input.target, platform) || isInside(realOrSelf(root), realTarget, platform));
  if (containedRoot) {
    throw outside(`"${input.target}" contains "${containedRoot}", a folder this window works in.`, { contains: containedRoot });
  }

  const isConfigFolder = (name: string) => input.configNames.some(config => same(config, name));
  const holdsOnlyBuildOutput = (dir: string, name: string) => isConfigFolder(name) || looksLikeBuildDir(dir) || isEmptyDir(dir);

  if (!whole) {
    if (!holdsOnlyBuildOutput(input.target, path.basename(input.target))) {
      throw notBuildOutput(input.target, [path.basename(input.target)]);
    }
    return { exists: true };
  }

  // A flat build straight into <app>/build is build output as a whole.
  if (looksLikeBuildDir(buildRoot)) {
    return { exists: true };
  }
  const unexpected: string[] = [];
  for (const entry of fs.readdirSync(buildRoot, { withFileTypes: true })) {
    const full = path.join(buildRoot, entry.name);
    if (entry.isDirectory() && holdsOnlyBuildOutput(full, entry.name)) {
      continue;
    }
    if (entry.isFile() && OS_METADATA_FILES.has(entry.name.toLowerCase())) {
      continue;
    }
    unexpected.push(entry.name);
  }
  if (unexpected.length > 0) {
    throw notBuildOutput(buildRoot, unexpected);
  }
  return { exists: true };
}

function notBuildOutput(folder: string, unexpected: string[]): McpToolError {
  return new McpToolError('INVALID_ARGUMENT', `"${folder}" does not look like a Zephyr build folder, so it was not deleted.`, {
    hint: 'A build folder holds CMakeCache.txt, build_info.yml or domains.yaml, or is named after a configuration. Delete it by hand if you are sure it is not needed.',
    details: { unexpected: unexpected.slice(0, MAX_LISTED), unexpected_count: unexpected.length },
  });
}
