// remove_or_delete: one tool for every removal, dispatched on `what` to the
// module that owns the thing removed. Each value accepts only its own
// arguments, so a misplaced one is refused instead of silently ignored.

import { McpToolError } from '../../core/errors';
import { logSafe } from '../../core/redact';
import { REMOVE_OR_DELETE_WHATS } from '../../core/tools/removeOrDelete';
import { ToolContext, ToolHandler } from '../../core/toolSpec';
import { removeApplication } from './apps';
import { deleteBuild } from './buildConfigs';
import { HostDeps } from './deps';
import { removeToolchain } from './toolchains';
import { removeWestWorkspaceItem } from './westWorkspaces';

type Ctx = ToolContext<HostDeps>;
type What = typeof REMOVE_OR_DELETE_WHATS[number];

const COMMON = ['what', 'dry_run', 'wait_sec'];

const ROUTES: Readonly<Record<What, {
  args: readonly string[];
  run(args: Record<string, unknown>, ctx: Ctx): Promise<unknown>;
}>> = {
  build_folder: { args: ['app_path', 'config_name'], run: deleteBuild },
  all_build_folders: { args: ['app_path'], run: deleteBuild },
  configuration: { args: ['app_path', 'config_name', 'delete_build_folder'], run: deleteBuild },
  application: { args: ['app_path', 'force'], run: removeApplication },
  application_files: { args: ['app_path', 'force'], run: removeApplication },
  west_workspace: { args: ['west_workspace', 'force'], run: removeWestWorkspaceItem },
  west_workspace_files: { args: ['west_workspace', 'force'], run: removeWestWorkspaceItem },
  workspace_venv: { args: ['west_workspace'], run: removeWestWorkspaceItem },
  west_blobs: { args: ['west_workspace'], run: removeWestWorkspaceItem },
  toolchain: { args: ['path', 'force'], run: removeToolchain },
  toolchain_files: { args: ['path', 'force'], run: removeToolchain },
};

export const removeOrDelete: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const what = typeof args.what === 'string' ? args.what : '';
  const route = Object.prototype.hasOwnProperty.call(ROUTES, what) ? ROUTES[what as What] : undefined;
  if (!route) {
    throw new McpToolError('INVALID_ARGUMENT', `what must be one of ${REMOVE_OR_DELETE_WHATS.join(', ')}, not "${logSafe(what, 40)}".`);
  }
  const accepted = new Set([...COMMON, ...route.args]);
  const unexpected = Object.keys(args).filter(key => args[key] !== undefined && !accepted.has(key));
  if (unexpected.length > 0) {
    throw new McpToolError('INVALID_ARGUMENT', `what "${what}" does not take ${unexpected.join(', ')}.`, {
      details: { accepted: [...accepted] },
    });
  }
  return route.run(args, ctx);
};
