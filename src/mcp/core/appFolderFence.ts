// Decides whether an agent may delete an application folder from disk, before
// anything is deleted and again right before it is.
//
// The folder comes from the workbench settings, which a hand edit or a stale
// entry can point anywhere: at a west workspace, at a sample inside the
// Zephyr tree that was configured in place, at a folder that holds other
// applications, or through a symbolic link at anything on the disk. So the
// fence only accepts a registered application root, checks it lexically and
// on the real file system (symbolic links refused), refuses a west workspace
// root, anything inside a Zephyr tree, a sample or test configured in place
// (in a west workspace, or in a git checkout it is not the root of) or a
// folder containing another folder the window works in, and last requires it
// to still look like an application. Free of `vscode` so it is unit tested
// against real folders.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { APP_TEMPLATE_METADATA_FILES } from '../../utils/zephyr/appTemplateMetadata';
import { isInside, normalizeForCompare } from './argSafety';
import { McpToolError } from './errors';

export interface AppFolderWestWorkspace {
  root: string;
  /** Upstream checkouts an application must never be deleted from: the Zephyr tree, the Rust module. */
  protectedTrees: readonly string[];
}

export interface AppFolderFenceInput {
  /** The application root to delete. */
  target: string;
  /** Every application root the window registers; the target must be one of them. */
  registeredApps: readonly string[];
  /** Every west workspace the window registers or an application links to. */
  westWorkspaces: readonly AppFolderWestWorkspace[];
  /** Every folder of the window; none other than the target may be inside it. */
  knownRoots: readonly string[];
  homeDir?: string;
  platform?: NodeJS.Platform;
}

function refused(message: string, details?: Record<string, unknown>): McpToolError {
  return new McpToolError('PATH_OUTSIDE_WORKSPACE', message, {
    hint: 'Only the folder of a registered application, holding nothing else the workbench manages, can be deleted. Delete anything else by hand if you are sure.',
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

/** The sample or test metadata file at the root of `dir`, which an application made from a template never has. */
function templateMetadataIn(dir: string): string | undefined {
  try {
    const names = fs.readdirSync(dir);
    return Object.keys(APP_TEMPLATE_METADATA_FILES).find(name => names.includes(name));
  } catch {
    return undefined;
  }
}

/**
 * The git checkout `dir` lies in, looked up from its parent (lexically, then
 * on the real file system), so the application's own repository is not one.
 */
function enclosingCheckout(dir: string, real: string): string | undefined {
  for (const start of [dir, real]) {
    let current = path.dirname(start);
    for (;;) {
      if (lstatOrUndefined(path.join(current, '.git'))) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return undefined;
}

function looksLikeApplication(dir: string): boolean {
  try {
    const names = fs.readdirSync(dir);
    return names.includes('CMakeLists.txt') || names.some(name => /^prj.*\.conf$/i.test(name));
  } catch {
    return false;
  }
}

/**
 * Throw unless deleting `target` would only remove one registered
 * application. Returns whether the folder exists: a missing one needs no
 * deletion, which keeps the tool idempotent.
 */
export function checkAppFolderDeletion(input: AppFolderFenceInput): { exists: boolean } {
  const platform = input.platform ?? process.platform;
  const same = (a: string, b: string) => normalizeForCompare(a, platform) === normalizeForCompare(b, platform);
  const inside = (child: string, parent: string) => isInside(child, parent, platform);
  const { target } = input;

  if (!input.registeredApps.some(app => same(app, target))) {
    throw new McpToolError('APP_NOT_FOUND', `"${target}" is not the root of an application this window registers.`, {
      hint: 'Call list_apps and pass one of the app_path values it returns.',
    });
  }

  const stat = lstatOrUndefined(target);
  if (!stat) {
    return { exists: false };
  }
  if (stat.isSymbolicLink()) {
    throw refused(`"${target}" is a symbolic link, so deleting it could remove files outside the application.`);
  }
  if (!stat.isDirectory()) {
    throw new McpToolError('INVALID_ARGUMENT', `"${target}" is a file, not an application folder.`, {
      hint: 'Delete it by hand if you are sure it is not needed.',
    });
  }

  const real = realOrSelf(target);
  const home = input.homeDir ?? os.homedir();
  if (same(real, path.parse(real).root) || same(real, home) || same(target, home)) {
    throw refused(`"${target}" is the home folder or the root of a drive.`);
  }

  if (fs.existsSync(path.join(target, '.west'))) {
    throw refused(`"${target}" is a west workspace root, not an application folder.`);
  }
  for (const workspace of input.westWorkspaces) {
    if (same(workspace.root, target) || same(realOrSelf(workspace.root), real)) {
      throw refused(`"${target}" is the root of the west workspace "${workspace.root}".`);
    }
    const tree = workspace.protectedTrees.find(candidate =>
      inside(target, candidate) || inside(real, realOrSelf(candidate)));
    if (tree) {
      throw refused(`"${target}" is inside "${tree}", which west manages: it is a sample configured in place, and deleting it would change that checkout.`,
        { inside: tree });
    }
  }
  // Samples live in every west project (and in plain checkouts), not only
  // in the trees above, and a copy made from one never keeps its metadata.
  // An application of the user's own may keep such metadata for CI, so it
  // only marks a sample inside a west workspace or inside a git checkout the
  // application is not the root of.
  const metadata = templateMetadataIn(target);
  if (metadata) {
    const workspace = input.westWorkspaces.find(candidate =>
      inside(target, candidate.root) || inside(real, realOrSelf(candidate.root)));
    if (workspace) {
      throw refused(`"${target}" holds ${metadata} inside the west workspace "${workspace.root}", so it is taken for a sample or test of one of its projects configured in place, and deleting it would change that checkout.`,
        { metadata, inside: workspace.root });
    }
    const checkout = enclosingCheckout(target, real);
    if (checkout) {
      throw refused(`"${target}" holds ${metadata} inside the git checkout "${checkout}", so it is taken for a sample or test configured in place, and deleting it would change that checkout.`,
        { metadata, inside: checkout });
    }
  }

  const others = [
    ...input.registeredApps,
    ...input.westWorkspaces.map(workspace => workspace.root),
    ...input.knownRoots,
  ].filter(other => !same(other, target));
  const contained = others.find(other => inside(other, target) || inside(realOrSelf(other), real));
  if (contained) {
    throw refused(`"${target}" contains "${contained}", which the workbench also manages.`, { contains: contained });
  }

  if (!looksLikeApplication(target)) {
    throw new McpToolError('INVALID_ARGUMENT', `"${target}" holds neither CMakeLists.txt nor a prj*.conf file, so it does not look like an application and was not deleted.`, {
      hint: 'Delete it by hand if you are sure it is not needed, or remove only the registration with what "application".',
    });
  }
  return { exists: true };
}

export interface FolderSize {
  bytes: number;
  files: number;
  /** False when the walk stopped at its limit, so bytes and files are lower bounds. */
  complete: boolean;
}

/**
 * The size of a folder, not following symbolic links, for a dry run. Stops
 * after `maxEntries` entries so a huge folder cannot hold the call.
 */
export function measureFolder(dir: string, maxEntries = 200_000): FolderSize {
  let bytes = 0;
  let files = 0;
  let seen = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > maxEntries) {
        return { bytes, files, complete: false };
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile()) {
        files++;
        try {
          bytes += fs.lstatSync(full).size;
        } catch {
          // Gone meanwhile: nothing to count.
        }
      }
    }
  }
  return { bytes, files, complete: true };
}
