// Decides whether an agent may delete a whole west workspace from disk, before
// anything is deleted and again right before it is.
//
// A west workspace root is only a registration: `west init` in the home folder
// makes the home folder a workspace, and a root can hold other workspaces,
// toolchains or applications the user keeps. So the fence checks the path on
// the real file system (symbolic links refused, a .west folder required), then
// refuses the home folder and anything above it, a filesystem root, and any
// root that holds another registered west workspace, a registered toolchain or
// a folder of the window that is not part of this workspace. Free of `vscode`
// so it is unit tested against real folders.

import * as fs from 'fs';
import * as path from 'path';
import { isInside, normalizeForCompare } from './argSafety';
import { McpToolError } from './errors';

export interface WestWorkspaceFenceInput {
  /** The registered west workspace root to delete. */
  root: string;
  /** The user's home folder. */
  home: string;
  /** Every other west workspace root the window knows. */
  otherWorkspaces: readonly string[];
  /** Every registered toolchain root: Zephyr SDKs, Arm GNU, IAR and Rust. */
  toolchains: readonly string[];
  /**
   * Folders the window works in that are not part of this workspace: other
   * window folders and freestanding applications. Applications declared by the
   * workspace itself go with it and are not listed here.
   */
  foreignFolders: readonly string[];
  platform?: NodeJS.Platform;
}

function refuse(message: string, details?: Record<string, unknown>): McpToolError {
  return new McpToolError('PATH_OUTSIDE_WORKSPACE', message, {
    hint: 'Only a west workspace that holds nothing else the workbench uses can be deleted. Remove the other items first, or delete the folder by hand if you are sure.',
    details,
  });
}

function realOrSelf(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return target;
  }
}

function isFilesystemRoot(target: string, platform: NodeJS.Platform): boolean {
  const parse = platform === 'win32' ? path.win32.parse : path.posix.parse;
  const normalized = target.replace(/[\\/]+$/, '') || target;
  const { root } = parse(normalized);
  return normalizeForCompare(root, platform) === normalizeForCompare(normalized, platform) || normalized === '';
}

/**
 * Throw unless deleting `root` would only remove that west workspace. Returns
 * whether it exists: a workspace already gone needs no deletion, which keeps
 * the tool idempotent.
 */
export function checkWestWorkspaceDeletion(input: WestWorkspaceFenceInput): { exists: boolean; realPath: string } {
  const platform = input.platform ?? process.platform;
  const same = (a: string, b: string) => normalizeForCompare(a, platform) === normalizeForCompare(b, platform);
  const inside = (child: string, parent: string) => isInside(child, parent, platform);

  if (isFilesystemRoot(input.root, platform)) {
    throw refuse(`"${input.root}" is the root of a filesystem.`);
  }
  if (inside(input.home, input.root)) {
    throw refuse(same(input.home, input.root)
      ? `"${input.root}" is the home folder.`
      : `"${input.root}" contains the home folder "${input.home}".`);
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(input.root);
  } catch {
    return { exists: false, realPath: input.root };
  }
  if (stat.isSymbolicLink()) {
    throw refuse(`"${input.root}" is a symbolic link, so deleting through it could remove files elsewhere.`);
  }
  if (!stat.isDirectory()) {
    throw new McpToolError('INVALID_ARGUMENT', `"${input.root}" is a file, not a west workspace.`);
  }
  if (!fs.existsSync(path.join(input.root, '.west'))) {
    throw new McpToolError('INVALID_ARGUMENT', `"${input.root}" has no .west folder, so it is not a west workspace.`, {
      hint: 'Delete it by hand if you are sure it is not needed.',
    });
  }

  const realRoot = realOrSelf(input.root);
  const realHome = realOrSelf(input.home);
  if (isFilesystemRoot(realRoot, platform) || inside(realHome, realRoot)) {
    throw refuse(`"${input.root}" resolves to "${realRoot}", which is the home folder, holds it, or is a filesystem root.`);
  }

  const contained = (candidates: readonly string[]) => candidates.find(candidate =>
    !same(candidate, input.root) && !same(realOrSelf(candidate), realRoot)
    && (inside(candidate, input.root) || inside(realOrSelf(candidate), realRoot)));

  const workspace = contained(input.otherWorkspaces);
  if (workspace) {
    throw refuse(`"${input.root}" contains another west workspace, "${workspace}".`, { contains: workspace });
  }
  const toolchain = contained(input.toolchains);
  if (toolchain) {
    throw refuse(`"${input.root}" contains the registered toolchain "${toolchain}".`, { contains: toolchain });
  }
  const folder = contained(input.foreignFolders);
  if (folder) {
    throw refuse(`"${input.root}" contains "${folder}", a folder this window works in that is not part of the workspace.`, { contains: folder });
  }
  return { exists: true, realPath: realRoot };
}

/**
 * The size of a folder, walking at most `maxEntries` entries and stopping at
 * `deadline` (epoch ms): a west workspace holds hundreds of thousands of
 * files, and a dry run must answer in seconds. Symbolic links are counted, not
 * followed. `complete` is false when the walk stopped early.
 */
export async function folderSize(root: string, opts: { deadline: number; maxEntries?: number }): Promise<{ bytes: number; files: number; complete: boolean }> {
  const maxEntries = opts.maxEntries ?? 500_000;
  let bytes = 0;
  let files = 0;
  let seen = 0;
  const pending = [root];
  while (pending.length > 0) {
    if (Date.now() > opts.deadline || seen >= maxEntries) {
      return { bytes, files, complete: false };
    }
    const dir = pending.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    seen += entries.length;
    const sizes = await Promise.all(entries.map(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
        return undefined;
      }
      // A file gone since the listing counts for nothing.
      return fs.promises.lstat(full).then(stat => stat.size, () => undefined);
    }));
    for (const size of sizes) {
      if (size !== undefined) {
        bytes += size;
        files++;
      }
    }
  }
  return { bytes, files, complete: true };
}
