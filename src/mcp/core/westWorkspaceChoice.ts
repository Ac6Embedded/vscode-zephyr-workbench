// Which west workspace a call means. Pure, so the rules are unit tested: an
// agent may only name a workspace the window already knows about, because the
// chosen root becomes the working directory and environment of a west run.

import * as path from 'path';
import { isInside, normalizeForCompare } from './argSafety';
import { McpToolError } from './errors';
import { logSafe } from './redact';

export interface WestWorkspaceChoice {
  /** The west_workspace argument, if given. */
  requested?: string;
  /** The application app_path resolved to, with the west workspace it is linked to. */
  application?: { appPath: string; westWorkspaceRoot?: string };
  /** Workspace roots this window registers: west workspace folders and the ones applications link to. */
  registered: readonly string[];
  /** Every folder the window may touch, used to tell a wrong path from a foreign one. */
  knownRoots: readonly string[];
  platform?: NodeJS.Platform;
}

const PICK_HINT = 'Call get_status and pass one of its west_workspaces[].path values, or pass app_path instead.';

/** The registered root the call selects, or an McpToolError that says how to fix the call. */
export function chooseWestWorkspaceRoot(choice: WestWorkspaceChoice): string {
  const platform = choice.platform ?? process.platform;
  const same = (a: string, b: string) => normalizeForCompare(a, platform) === normalizeForCompare(b, platform);
  const { requested, application, registered } = choice;

  if (application) {
    const root = application.westWorkspaceRoot;
    if (!root) {
      throw new McpToolError('INVALID_ARGUMENT', `Application "${application.appPath}" is not linked to a west workspace.`, {
        hint: 'Ask the user to link the application to a west workspace in the Zephyr Workbench applications view, or pass west_workspace instead of app_path.',
      });
    }
    if (requested && !same(requested, root)) {
      throw new McpToolError('INVALID_ARGUMENT',
        `app_path uses the west workspace "${root}", not "${logSafe(requested, 300)}".`, {
          hint: 'Pass only app_path, or only west_workspace.',
        });
    }
    return root;
  }

  if (requested) {
    const isAbsolute = platform === 'win32' ? path.win32.isAbsolute(requested) : path.posix.isAbsolute(requested);
    if (!isAbsolute) {
      throw new McpToolError('INVALID_ARGUMENT', `west_workspace "${logSafe(requested, 300)}" is not an absolute path.`, {
        hint: PICK_HINT,
        details: { available: [...registered] },
      });
    }
    const match = registered.find(root => same(root, requested));
    if (match) {
      return match;
    }
    const containing = registered.find(root => isInside(requested, root, platform));
    if (containing) {
      throw new McpToolError('INVALID_ARGUMENT',
        `"${logSafe(requested, 300)}" is inside the west workspace "${containing}"; pass the workspace root itself.`, {
          hint: PICK_HINT,
          details: { available: [...registered] },
        });
    }
    const known = [...choice.knownRoots, ...registered].some(root => isInside(requested, root, platform));
    throw new McpToolError(known ? 'INVALID_ARGUMENT' : 'PATH_OUTSIDE_WORKSPACE',
      known
        ? `"${logSafe(requested, 300)}" is not a west workspace this window knows about.`
        : `west_workspace "${logSafe(requested, 300)}" is outside every folder this window knows about.`, {
        hint: PICK_HINT,
        details: { available: [...registered] },
      });
  }

  if (registered.length === 1) {
    return registered[0];
  }
  if (registered.length === 0) {
    throw new McpToolError('ENV_NOT_READY', 'This VS Code window has no west workspace.', {
      hint: 'Ask the user to add one with the Zephyr Workbench command "Add West Workspace", then call get_status.',
    });
  }
  throw new McpToolError('INVALID_ARGUMENT',
    `This window has ${registered.length} west workspaces, so west_workspace or app_path is required.`, {
      hint: PICK_HINT,
      details: { candidates: [...registered] },
    });
}
