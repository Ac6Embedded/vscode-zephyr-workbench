// remove_or_delete: every removal, following the workbench vocabulary:
// Remove unregisters and keeps the files, Delete removes them from disk.

import { z } from 'zod';
import { ToolMeta } from '../toolSpec';
import { appPath, dryRun, waitSec } from './shared';

export const REMOVE_OR_DELETE_WHATS = [
  'build_folder', 'all_build_folders', 'configuration', 'application', 'application_files',
  'west_workspace', 'west_workspace_files', 'workspace_venv', 'west_blobs', 'toolchain', 'toolchain_files',
] as const;

export const REMOVE_OR_DELETE: ToolMeta = {
  name: 'remove_or_delete',
  title: 'Remove or delete',
  summary: 'Removes or deletes build folders, build configurations, applications, west workspaces or toolchains.',
  description: [
    'Removes or deletes what Zephyr Workbench manages, as its views do: build folders and build configurations, applications (application unregisters and keeps the files, application_files deletes the folder), west workspaces (west_workspace removes it from the window, west_workspace_files deletes it), the venv of a west workspace, fetched binary blobs, and toolchains (toolchain unregisters, toolchain_files deletes it from disk).',
    'Use it when something is no longer wanted or is broken beyond repair; to rebuild from scratch call build_app with pristine "always" instead, and to switch an application to another toolchain use configure.',
    'what picks the removal, app_path and config_name name the application and configuration (config_name is required for build_folder and configuration and never defaults to the active one), west_workspace names the workspace, path names a toolchain root as list_toolchains returns it, and force goes ahead although applications still use the workspace or toolchain.',
    'Returns what was removed, or a job for large deletions; dry_run reports what would go, and what still uses it, without asking or deleting; the user approves in a VS Code dialog unless they chose not to be asked, the last configuration of an application is always kept, IAR toolchains and the toolchain of the host tools are never deleted from disk, and a folder that does not look like what it claims to be is refused.',
  ].join(' '),
  inputSchema: z.object({
    what: z.enum(REMOVE_OR_DELETE_WHATS).describe(
      'build_folder: <app_path>/build/<config_name>; all_build_folders: <app_path>/build; configuration: a build configuration; application / application_files: unregister or delete an application; west_workspace / west_workspace_files: remove from the window or delete a west workspace; workspace_venv: the venv of a west workspace; west_blobs: west blobs clean; toolchain / toolchain_files: unregister or delete a toolchain.'),
    app_path: appPath,
    config_name: z.string().optional().describe(
      'The configuration whose build folder or settings go. Required for build_folder and configuration, never taken from the active one, and not accepted with all_build_folders.'),
    delete_build_folder: z.boolean().optional().describe(
      'With what "configuration" only: also delete its build folder. Defaults to false, which keeps the folder and reports it as orphaned_build_dir.'),
    west_workspace: z.string().optional().describe(
      'west_workspace, west_workspace_files, workspace_venv and west_blobs: absolute west workspace root, one of the west_workspaces[].path values get_status returns.'),
    path: z.string().optional().describe(
      'toolchain and toolchain_files: absolute toolchain root, exactly as list_toolchains returns it.'),
    force: z.boolean().optional().describe(
      'Go ahead although applications still use the west workspace or toolchain; they then need another one before they build again.'),
    dry_run: dryRun,
    wait_sec: waitSec,
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  category: 'action',
  confirm: 'delete',
  routeBy: ['app_path', 'west_workspace'],
  machineScope: { toolchain: true, toolchain_files: true },
};
