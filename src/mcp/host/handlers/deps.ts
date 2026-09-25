// What every handler is given. Injected so handlers stay testable and so the
// tool layer never reaches for globals.

import type * as vscode from 'vscode';
import { JobManager } from '../../jobs/jobManager';
import { ConfirmCategory } from '../../core/toolSpec';
import { KconfigSessionPool } from '../../../utils/kconfig/kconfigSessionPool';
import { Confirmations } from '../confirmations';
import { FolderChangeScheduler } from '../folderChanges';
import { HostServices } from '../services';

/** Workbench views a tool can ask to refresh after changing what they show. */
export type WorkbenchView = 'apps' | 'westWorkspaces' | 'toolchains' | 'dashboard';

export interface HostDeps {
  services: HostServices;
  jobs: JobManager;
  // The two settings below are read on every call, so a change applies to the
  // next call without restarting the server.
  /** Default seconds an action waits before handing back a job handle. */
  readonly defaultWaitSeconds: number;
  /** Whether an agent-started task reveals its terminal. */
  readonly revealTerminal: 'always' | 'silent' | 'never';
  /** Asks the user before an action in one of their confirmActions categories. */
  confirmations: Confirmations;
  /** The zephyr-workbench.mcp.confirmActions setting, read on every call. */
  readonly confirmActions: readonly ConfirmCategory[];
  /** Kconfig sessions for query_kconfig's explain mode and set_kconfig, stopped with the server. */
  kconfig: KconfigSessionPool;
  /** The extension's context, for state that must outlive a restart of the extension host. */
  extensionContext: vscode.ExtensionContext;
  /** Adds and removes workspace folders, deferring a change that would restart the host under the call. */
  folders: FolderChangeScheduler;
  /** Refresh workbench views after a tool changed what they show. Never throws. */
  refreshViews(views: ReadonlyArray<WorkbenchView>): Promise<void>;
  /**
   * The tools this window serves under the current settings, so a hint only
   * names a tool the agent can call, and names the Zephyr Workbench command
   * for one it cannot.
   */
  servedTools(): ReadonlySet<string>;
}
