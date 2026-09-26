// manage_app: create an application from a sample, import an existing one,
// or give one its own Python environment.

import { z } from 'zod';
import { ToolMeta } from '../toolSpec';
import { appPath, dryRun, toolchainChoice, waitSec } from './shared';

export const MANAGE_APP: ToolMeta = {
  name: 'manage_app',
  title: 'Create or import an application',
  summary: 'Creates an application from a sample, imports an existing one, or gives it its own Python environment.',
  description: [
    'Creates a Zephyr application from a sample or test of a west workspace, imports an existing application folder, or creates a Python virtual environment for one application, doing what the Add Application wizard and the Create Venv action of Zephyr Workbench do.',
    'Use action "create" to start a new application, finding the template with search_zephyr_catalog kind sample or test and the board with kind board, and "import" for a folder that already holds an application; change an existing application with configure instead.',
    'kind "workspace" (the default) creates the application inside its west workspace under applications_subfolder, "freestanding" creates it in parent_dir linked to west_workspace, and a freestanding application is added to the VS Code window, which may restart the extensions of the window: the result then says restart_pending, and the agent should call get_status after a few seconds.',
    'Returns the application as list_apps reports it with the files written and any SDK compatibility warning, or for "create_venv" a job; the user approves each action in a VS Code dialog unless they chose not to be asked, and dry_run reports the plan without writing.',
  ].join(' '),
  inputSchema: z.object({
    action: z.enum(['create', 'import', 'create_venv']).describe(
      'create: a new application from a template; import: register an existing application folder; create_venv: a Python virtual environment for the application app_path, used instead of the west workspace or global one.'),
    app_path: appPath.describe('create_venv only: the application that gets its own virtual environment. Omit it when the window has a single application.'),
    kind: z.enum(['workspace', 'freestanding']).optional().describe(
      'create only: workspace (the default) puts the application inside its west workspace; freestanding puts it in parent_dir and links it to west_workspace.'),
    west_workspace: z.string().optional().describe(
      'Absolute west workspace root, one of the west_workspaces[].path values get_status returns: the workspace the new application uses, or for import the one to link the application to. Omit it when the window has a single west workspace.'),
    template: z.string().optional().describe(
      'create only: absolute path of a sample or test folder, exactly as search_zephyr_catalog with kind sample or test returns it for the same west workspace.'),
    name: z.string().optional().describe(
      'create only: folder name of the new application: letters, digits, dot, dash and underscore, no spaces. Defaults to the template folder name.'),
    applications_subfolder: z.string().optional().describe(
      'create with kind workspace: folder inside the west workspace that receives the application, relative, defaulting to applications.'),
    parent_dir: z.string().optional().describe(
      'create with kind freestanding: absolute existing folder, without spaces, in which the application folder is created. The application folder must not exist yet.'),
    path: z.string().optional().describe(
      'import only: absolute path of the existing application folder, the one holding CMakeLists.txt and prj.conf. Given alone, it adds a folder that already has its workbench settings back to the window, or selects the application its west workspace already declares there.'),
    board: z.string().optional().describe(
      'Board identifier as west build -b takes it, such as nrf52840dk/nrf52840: required for create, and for importing a folder that has no workbench settings yet.'),
    toolchain: toolchainChoice.optional().describe(
      'The toolchain the application builds with, one list_toolchains reports as installed. Defaults to the installed Zephyr SDK of the version the Zephyr of the west workspace recommends, else the newest compatible one.'),
    intellisense_provider: z.enum(['cpptools', 'clangd']).optional().describe(
      'The C/C++ language support the application is set up for. Defaults, as in the wizard, to cpptools, or to clangd when only the clangd extension is installed.'),
    debug_preset: z.boolean().optional().describe(
      'create only: append the debug preset of the wizard to the new application\'s prj.conf (CONFIG_DEBUG_OPTIMIZATIONS, thread info, stack usage and build output options). Defaults to true, as in the wizard.'),
    dry_run: dryRun,
    wait_sec: waitSec.describe('create_venv only: seconds to wait before returning the job handle. Defaults to the workbench setting, normally 45.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  category: 'action',
  toolsets: ['core'],
  confirm: { create: 'workspace', import: 'workspace', create_venv: 'install' },
  routeBy: ['app_path', 'west_workspace'],
  // A new application is by definition not in the window yet, so it cannot route by its folder.
  machineScope: { create: true, import: true },
};
