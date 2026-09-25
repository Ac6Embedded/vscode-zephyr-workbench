// Binds catalog entries to their implementations. A catalog entry with no
// handler here is simply not registered, which is how a phase ships a subset
// of the catalog without editing it.

import { ToolHandler } from '../../core/toolSpec';
import { HostDeps } from './deps';
import { buildApp } from './actions';
import { analyze } from './analysis';
import { manageApp } from './apps';
import { configure } from './buildConfigs';
import { getDiagnostics } from './diagnostics';
import { getBuildInfo, getMemoryReport, listRunners, queryDevicetree, queryKconfig } from './artifacts';
import { setKconfig } from './kconfig';
import { job } from './jobs';
import { searchZephyrCatalog } from './catalogSearch';
import { getStatus, listApps } from './queries';
import { checkEnvironment } from './environment';
import { openInWorkbench } from './openInWorkbench';
import { removeOrDelete } from './removals';
import { listToolchains, manageToolchain } from './toolchains';
import { manageWestWorkspace } from './westWorkspaces';

export const HANDLERS: Readonly<Record<string, ToolHandler<HostDeps>>> = {
  get_status: getStatus,
  check_environment: checkEnvironment,
  list_apps: listApps,
  list_toolchains: listToolchains,
  search_zephyr_catalog: searchZephyrCatalog,
  get_build_info: getBuildInfo,
  get_memory_report: getMemoryReport,
  query_kconfig: queryKconfig,
  set_kconfig: setKconfig,
  query_devicetree: queryDevicetree,
  list_runners: listRunners,
  get_diagnostics: getDiagnostics,
  build_app: buildApp,
  analyze,
  configure,
  manage_app: manageApp,
  manage_west_workspace: manageWestWorkspace,
  manage_toolchain: manageToolchain,
  open_in_workbench: openInWorkbench,
  remove_or_delete: removeOrDelete,
  job,
};

export { HostDeps };
