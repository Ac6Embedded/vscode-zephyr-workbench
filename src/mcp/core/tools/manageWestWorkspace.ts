// manage_west_workspace: create, import and maintain west workspaces.

import { z } from 'zod';
import { ToolMeta } from '../toolSpec';
import { dryRun, listEdit, waitSec } from './shared';

export const MANAGE_WEST_WORKSPACE: ToolMeta = {
  name: 'manage_west_workspace',
  title: 'Create and maintain west workspaces',
  summary: 'Creates, imports and updates west workspaces: west update, manifest changes, Python environment and binary blobs.',
  description: [
    'Creates a west workspace (west init from a bundled template, a remote manifest repository or a local manifest file, then west update), imports an existing one, and maintains it: west update, manifest edits (Zephyr revision, module allowlist, Rust module), its own Python virtual environment and requirements, and binary blobs, doing what the Add West Workspace wizard, the West Manager and the west workspace actions of Zephyr Workbench do.',
    'Use it before manage_app when no west workspace fits; find templates, Zephyr revisions, projects and blobs with search_zephyr_catalog kinds template, revision, project and blob, and change the board, DTS, SoC and snippet roots or the venv setting with configure target west_workspace.',
    'create needs source, destination and the inputs of that source, update, create_venv, install_python_deps and fetch_blobs act on west_workspace, set_manifest edits the manifest and runs west update when update is true, and fetch_blobs on Zephyr 4.2 or later needs accept_blob_licenses true because it accepts click-through licenses for the user.',
    'Returns a job for anything that downloads, which can take 10 to 45 minutes for a new workspace, else the result at once; the user approves each action in a VS Code dialog unless they chose not to be asked, and adding the workspace to the window may restart the extensions of the window, reported as restart_pending.',
  ].join(' '),
  inputSchema: z.object({
    action: z.enum(['create', 'import', 'update', 'set_manifest', 'create_venv', 'install_python_deps', 'fetch_blobs']).describe(
      'create: a new west workspace; import: register an existing one; update: west update; set_manifest: edit the manifest; create_venv: a virtual environment for the workspace; install_python_deps: install the Python requirements of the workspace into its environment; fetch_blobs: west blobs fetch.'),
    west_workspace: z.string().optional().describe(
      'Absolute west workspace root, one of the west_workspaces[].path values get_status returns, for every action except create and import. Omit it when the window has a single west workspace.'),
    source: z.enum(['template', 'remote', 'manifest']).optional().describe(
      'create only: template generates the manifest from a bundled template, remote runs west init on a manifest repository, manifest uses a local west.yml.'),
    destination: z.string().optional().describe(
      'create only: absolute existing folder, without spaces, that receives the workspace folder.'),
    folder_name: z.string().optional().describe(
      'create only: name of the workspace folder created in destination, defaulting to zephyrproject. It must not exist, or be empty.'),
    url: z.string().optional().describe(
      'create with source remote: the manifest repository, https://host/path or git@host:path. With source template: the Zephyr repository, defaulting to the upstream one.'),
    revision: z.string().optional().describe(
      'create with source template or remote, and set_manifest: the Zephyr revision (tag, branch or commit), as search_zephyr_catalog kind revision lists them.'),
    manifest_file: z.string().optional().describe(
      'create with source remote: manifest file name inside the repository, defaulting to west.yml.'),
    manifest_path: z.string().optional().describe(
      'create with source manifest: absolute path of the local west.yml to start from.'),
    template_mode: z.enum(['minimal', 'full']).optional().describe(
      'create with source template: minimal (the default) fetches only the modules the chosen templates or projects need, full fetches every module Zephyr lists.'),
    templates: z.array(z.string()).max(32).optional().describe(
      'create with source template and template_mode minimal: template names, as search_zephyr_catalog kind template lists them, such as a vendor HAL set.'),
    projects: z.array(z.string()).max(200).optional().describe(
      'create with source template and template_mode minimal: extra west project names to fetch, as search_zephyr_catalog kind project lists them.'),
    allowlist: listEdit('west project names').optional().describe(
      'set_manifest only: the projects the manifest imports from Zephyr. Cannot be combined with import_all true.'),
    import_all: z.boolean().optional().describe(
      'set_manifest only: true imports every project Zephyr lists instead of an allowlist.'),
    enable_rust: z.boolean().optional().describe(
      'create and set_manifest: include the Zephyr Rust module (zephyr-lang-rust), or with false leave it out.'),
    update: z.boolean().optional().describe(
      'set_manifest only: run west update after the edit, as a job. Without it, the result says needs_update.'),
    path: z.string().optional().describe(
      'import only: absolute root of an existing west workspace, the folder that holds .west.'),
    modules: z.array(z.string()).max(100).optional().describe(
      'fetch_blobs only: fetch the blobs of these modules only, as search_zephyr_catalog kind blob lists them. Defaults to every module.'),
    accept_blob_licenses: z.boolean().optional().describe(
      'fetch_blobs only: must be true when the Zephyr version accepts click-through blob licenses automatically (4.2 and later). Ask the user before passing it.'),
    dry_run: dryRun,
    wait_sec: waitSec,
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  category: 'action',
  toolsets: [],
  confirm: {
    create: 'workspace', import: 'workspace', update: 'workspace', set_manifest: 'workspace',
    create_venv: 'install', install_python_deps: 'install', fetch_blobs: 'install',
  },
  routeBy: ['west_workspace'],
  // A new or imported workspace is not in the window yet, so it cannot route by its folder.
  machineScope: { create: true, import: true },
};
