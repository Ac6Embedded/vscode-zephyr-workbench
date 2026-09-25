// State queries. All read-only, all cheap enough to call repeatedly.

import * as vscode from 'vscode';
import { isSdkMissing, summarizeQuickEnvironment } from '../../core/environmentReport';
import { ToolContext, ToolHandler } from '../../core/toolSpec';
import { captureFields } from '../serial/captures';
import { HostDeps } from './deps';
import { readEnvironmentBasis, soleApplication } from './environment';
import { westWorkspaceStatus } from './westWorkspaces';

type Ctx = ToolContext<HostDeps>;

export const getStatus: ToolHandler<HostDeps> = async (_args, ctx: Ctx) => {
  const { services, jobs } = ctx.deps;
  const apps = await services.listApplications();
  const workspaces = services.listWestWorkspaces();
  const sdks = await services.listSdks();
  // Files and settings only, so this stays fast enough to call first in every
  // session; check_environment runs the probes.
  const hostTools = await services.hostToolsStatus('quick');
  // The application check_environment covers when called without app_path,
  // read the same way, so the two never disagree on ready.
  const { settings, build, toolchain } = readEnvironmentBasis(soleApplication(apps));
  const unregistered = await services.findUnregisteredCandidates(apps);
  const { environment, nextSteps } = summarizeQuickEnvironment({
    hostToolsInstalled: hostTools.installed,
    hostToolsComplete: hostTools.complete,
    zinstallerUpToDate: hostTools.zinstaller.upToDate,
    envScriptOk: settings.envScript.ok,
    venvSettingOk: settings.venvSetting.ok,
    venvExists: build.exists,
    westFound: build.westFound,
    sdkCount: sdks.length,
    ...(toolchain ? { application: toolchain } : {}),
  });

  // Only a tool this window serves is named; otherwise the command that does the same.
  const served = ctx.deps.servedTools?.() ?? new Set<string>();
  const next_steps: string[] = [...nextSteps];
  if (workspaces.length === 0) {
    next_steps.push(served.has('manage_west_workspace')
      ? 'No west workspace is registered. Create one with manage_west_workspace action "create", or register an existing one with action "import".'
      : 'No west workspace is registered. Add one with the Zephyr Workbench command "Add West Workspace".');
  }
  if (isSdkMissing(sdks.length, toolchain)) {
    next_steps.push(served.has('manage_toolchain')
      ? 'No Zephyr SDK is registered. Install one with manage_toolchain action "install", or register an existing one with action "register".'
      : 'No Zephyr SDK is registered. Add one with the Zephyr Workbench command "Add Toolchain".');
  }
  if (apps.length === 0) {
    next_steps.push(served.has('manage_app')
      ? 'This window has no Zephyr application. Create one with manage_app action "create", or register an existing one with action "import".'
      : 'This window has no Zephyr application. Open one, or add it with "Add Application".');
  }
  for (const candidate of unregistered) {
    next_steps.push(`"${candidate}" looks like a Zephyr application but is not registered with the workbench yet.`
      + (served.has('manage_app') ? ' Register it with manage_app action "import".' : ''));
  }
  // Set when a folder change an agent asked for restarted the extensions of this window.
  const restartNotice = ctx.deps.folders?.restartNotice?.();
  const pendingFolderChanges = ctx.deps.folders?.pending?.() ?? [];

  return {
    workbench: {
      extension_version: vscode.extensions.getExtension('Ac6.zephyr-workbench')?.packageJSON?.version ?? 'unknown',
      vscode: vscode.version,
      remote: vscode.env.remoteName ?? null,
    },
    workspace_folders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
    environment,
    apps: apps.map(app => {
      const config = app.buildConfigs.find(c => c.active) ?? app.buildConfigs[0];
      return {
        app_path: app.appRootPath,
        name: app.appName,
        active_config: config?.name,
        board: config?.boardIdentifier,
        built: config ? services.isBuilt(app, config) : false,
      };
    }),
    west_workspaces: westWorkspaceStatus(workspaces, apps),
    toolchains: { zephyr_sdks: sdks.length },
    // So an agent can tell the user to watch VS Code before an action that asks.
    safety: { confirm_actions: [...ctx.deps.confirmActions] },
    running_jobs: jobs.list().filter(j => j.status === 'running').map(j => ({
      job_id: j.id, kind: j.spec.kind, app_path: j.spec.appPath, config_name: j.spec.configName,
      // A serial capture names its port and speed instead of an application.
      ...(j.spec.kind === 'serial' ? captureFields(j.id) : {}),
    })),
    integrations: {
      devicetree_manager: !!vscode.extensions.getExtension('Ac6.devicetree-manager-for-zephyr'),
    },
    ...(restartNotice ? { restart_notice: restartNotice } : {}),
    ...(pendingFolderChanges.length > 0 ? { pending_folder_changes: pendingFolderChanges } : {}),
    next_steps,
  };
};

export const listApps: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const { services } = ctx.deps;
  const wanted = typeof args.app_path === 'string' ? args.app_path : undefined;
  const apps = await services.listApplications();
  const selected = wanted ? [await services.resolveApp(wanted)] : apps;
  return {
    apps: selected.map(app => services.toAppDto(app)),
    hints: (await services.findUnregisteredCandidates(apps)).map(path => ({
      path,
      message: 'This folder has prj.conf and CMakeLists.txt but is not a registered workbench application.',
    })),
  };
};
