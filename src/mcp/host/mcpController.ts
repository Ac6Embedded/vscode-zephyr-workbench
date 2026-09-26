// Owns the lifetime of the MCP server for one VS Code window.
//
// Listener policy: `auto` (the default) publishes a dormant record with no port
// and no token, and only starts listening once something actually wants the
// server. A user who never connects an agent never has a socket open.

import * as vscode from 'vscode';
import { SERVER_NAME, TOOL_CATALOG } from '../core/catalog';
import { launcherSpec } from '../agents/launcher';
import { getMcpPaths } from '../core/paths';
import { readWindowRecords } from '../core/registry';
import { McpSettings, normalizeMcpSettings } from '../core/settings';
import { catalogVersion, confirmCategoriesOf, permissionOf, selectTools } from '../core/toolSpec';
import { JobManager } from '../jobs/jobManager';
import { KconfigSessionPool } from '../../utils/kconfig/kconfigSessionPool';
import { CreateZephyrAppPanel } from '../../panels/CreateZephyrAppPanel';
import { AuditLog } from './auditLog';
import { Confirmations, withAskBeforeUse } from './confirmations';
import { guardTaskLaunches, watchBuildConflicts } from './buildConflicts';
import { probeBridge } from './bridgeProbe';
import { checkInstall, DoctorCheck } from './doctor';
import { watchDocumentChecks } from './documentChecks';
import { FolderChangeScheduler } from './folderChanges';
import { HANDLERS } from './handlers';
import { HostDeps, WorkbenchView } from './handlers/deps';
import { startHttpServer, RunningServer } from './httpServer';
import { RegistryWriter, resolveWindowId } from './registryWriter';
import { installBridge } from './bridgeInstaller';
import { EditorRegistrations } from './editorRegistrations';
import { buildMcpServer } from './sdkAdapter';
import { isSdkSupported, loadSdk, UNSUPPORTED_MESSAGE } from './sdkLoader';
import { HostServices } from './services';
import { withSettingsWarnings } from './settingsWarnings';

const SECTION = 'zephyr-workbench.mcp';
const WAKE_POLL_MS = 3000;

/**
 * Read the settings, checked, at machine scope for everything that decides what
 * an agent may do, so a cloned repository's .vscode/settings.json cannot widen it.
 */
export function readSettingsChecked(): { settings: McpSettings; problems: string[] } {
  const config = vscode.workspace.getConfiguration(SECTION);
  const machine = (key: string): unknown => {
    const inspected = config.inspect<unknown>(key);
    return inspected?.globalValue ?? inspected?.defaultValue;
  };
  return normalizeMcpSettings({
    enabled: machine('enabled'),
    port: machine('port'),
    permissions: machine('permissions'),
    toolPermissions: machine('toolPermissions'),
    revealTerminal: config.get<unknown>('revealTerminal'),
    defaultWaitSeconds: config.get<unknown>('defaultWaitSeconds'),
    homeDir: machine('homeDir'),
    showStatusBar: config.get<unknown>('showStatusBar'),
  });
}

export function readSettings(): McpSettings {
  return readSettingsChecked().settings;
}

export type { McpSettings };

export class McpController implements vscode.Disposable {
  private readonly services: HostServices;
  private readonly audit: AuditLog;
  private readonly registry: RegistryWriter;
  private readonly jobs: JobManager;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly confirmations: Confirmations;
  private readonly kconfig: KconfigSessionPool;
  private readonly folders: FolderChangeScheduler;
  private readonly stateChanged = new vscode.EventEmitter<void>();
  /** Fires when something the AI Manager shows changes on its own, such as a pending dialog. */
  readonly onDidChangeState = this.stateChanged.event;
  private editors: EditorRegistrations | undefined;
  private server: RunningServer | undefined;
  private handlerClose: (() => Promise<void>) | undefined;
  private wakePoll: NodeJS.Timeout | undefined;
  private settings: McpSettings;
  private starting: Promise<void> | undefined;
  /** Set by the Stop command, so a waking agent cannot overrule the user. */
  private stoppedByUser = false;
  /** The connection test running now, which a second request joins. */
  private testRun: Promise<DoctorCheck[]> | undefined;
  /** The last connection test, for the AI Manager. */
  private lastTest: { at: string; checks: DoctorCheck[] } | undefined;
  private disposed = false;

  readonly windowId: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.services = new HostServices(context.extensionUri);
    this.settings = readSettings();
    this.windowId = resolveWindowId(context);
    const paths = getMcpPaths(this.settings.homeDir || undefined);
    this.audit = new AuditLog(paths);
    this.registry = new RegistryWriter(this.windowId, this.settings.homeDir || undefined, line => this.audit.info(line));
    this.confirmations = new Confirmations({
      permission: tool => permissionOf(tool, this.settings.permissions),
      // Leaves room in the default 45 second wait, which keeps a call under
      // the 60 second timeout most agents apply.
      waitMs: () => Math.min(120, Math.max(10, this.settings.defaultWaitSeconds - 5)) * 1000,
      log: this.audit,
      onDidChange: () => {
        this.refreshStatusBar();
        this.stateChanged.fire();
      },
    });
    this.jobs = new JobManager({
      windowId: this.windowId,
      logPathFor: jobId => paths.jobLog(this.windowId, jobId),
      // Finished jobs are recorded, so an agent still gets its answer after a
      // reload or an extension host restart.
      recordPathFor: jobId => paths.jobRecord(this.windowId, jobId),
      // Keeps the status bar spinner and the AI Manager's job list in step with agent jobs.
      onDidChange: () => {
        this.refreshStatusBar();
        this.stateChanged.fire();
      },
      // A folder change restarting this host would kill a job started meanwhile.
      admit: () => this.folders.refuseJobStart(),
    });
    // Kconfig sessions for the agent tools, kept apart from the Kconfig Manager's own.
    this.kconfig = new KconfigSessionPool({
      serverScriptPath: vscode.Uri.joinPath(context.extensionUri, 'scripts', 'kconfig', 'kconfig_server.py').fsPath,
      log: line => this.audit.info(line),
    });
    // Folder changes the agent tools ask for. Outlives a server restart, so a
    // change waiting for a job is not lost when the user stops the server.
    this.folders = new FolderChangeScheduler({
      context,
      windowId: this.windowId,
      jobs: this.jobs,
      log: line => this.audit.info(line),
    });
    this.statusBar = vscode.window.createStatusBarItem('zephyr-workbench.mcp', vscode.StatusBarAlignment.Right, 90);
    this.statusBar.command = 'zephyr-workbench.ai-manager';
    this.disposables.push(this.audit, this.registry, this.statusBar, this.stateChanged, this.folders);
  }

  get isRunning(): boolean {
    return !!this.server;
  }

  get endpoint(): { url: string; token: string; port: number } | undefined {
    return this.server ? { url: this.server.url, token: this.server.token, port: this.server.port } : undefined;
  }

  /** Tools the settings allow. */
  get visibleTools() {
    return selectTools(TOOL_CATALOG, this.settings.permissions);
  }

  /** Tools the settings allow and this version implements: what an agent really gets. */
  get servedTools() {
    return this.visibleTools.filter(meta => !!HANDLERS[meta.name]);
  }

  /** Called from activate(). Never blocks activation. */
  async initialize(): Promise<void> {
    const { settings, problems } = readSettingsChecked();
    this.settings = settings;
    this.reportSettingsProblems(problems);
    this.registerListeners();
    await this.applyEnabledSetting();
  }

  /**
   * Bring the window in line with `zephyr-workbench.mcp.enabled`. Runs on
   * activation and again on every change, so turning the setting off and on
   * again works without a reload.
   */
  private async applyEnabledSetting(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.settings.enabled === 'off') {
      this.stopWakePoll();
      this.editors?.dispose();
      this.editors = undefined;
      await this.stop();
      // No record at all: agents are told no window offers the server.
      this.registry.withdraw();
      this.audit.info('MCP server disabled by setting.');
      this.refreshStatusBar();
      return;
    }

    this.installBridgeFiles();
    if (!isSdkSupported()) {
      // Published with the reason, so an agent is told why instead of
      // waiting on a window that can never start the server.
      this.audit.warn(UNSUPPORTED_MESSAGE);
      await this.publishRecord();
      this.refreshStatusBar();
      return;
    }
    if (!this.editors) {
      // Copilot and Cursor get the server with no file written at all.
      this.editors = new EditorRegistrations({
        extensionUri: this.context.extensionUri,
        windowId: this.windowId,
        version: () => `${this.extensionVersion}+${catalogVersion(this.servedTools)}`,
        homeDir: () => this.settings.homeDir,
        ensureStarted: () => this.ensureStarted('agent'),
        log: line => this.audit.info(line),
      });
      this.editors.register();
    }
    // In both modes a bridge started by a hand-configured agent may drop a
    // wake marker; in `auto` that is the normal way the server starts.
    this.startWakePoll();
    await this.publishRecord();
    if (this.settings.enabled === 'on' && !this.stoppedByUser) {
      await this.ensureStarted('agent').catch(error => this.audit.warn(`could not start the MCP server: ${messageOf(error)}`));
    }
    this.refreshStatusBar();
  }

  private startWakePoll(): void {
    if (this.wakePoll) {
      return;
    }
    this.wakePoll = setInterval(() => {
      if (this.server || this.starting || !this.registry.consumeWakeRequest()) {
        return;
      }
      if (this.stoppedByUser) {
        this.audit.info('An agent asked for the MCP server, but it was stopped from VS Code. Start it from the AI Manager.');
        return;
      }
      this.audit.info('An agent asked for the MCP server, starting it.');
      this.ensureStarted('agent').catch(error => this.audit.warn(`could not start the MCP server: ${messageOf(error)}`));
    }, WAKE_POLL_MS);
  }

  private stopWakePoll(): void {
    if (this.wakePoll) {
      clearInterval(this.wakePoll);
      this.wakePoll = undefined;
    }
  }

  private get extensionVersion(): string {
    return this.context.extension.packageJSON?.version ?? '0.0.0';
  }

  /**
   * Keep the stable bridge copy and launcher current. Done on every activation
   * so an agent configured by hand from the docs works without the panel.
   */
  installBridgeFiles(): void {
    if (this.settings.enabled === 'off') {
      return;
    }
    const result = installBridge(
      getMcpPaths(this.settings.homeDir || undefined),
      vscode.Uri.joinPath(this.context.extensionUri, 'out').fsPath,
      this.extensionVersion,
      process.execPath,
    );
    if (!result.ok) {
      this.audit.warn(`could not install the MCP bridge: ${result.problem}`);
    } else if (result.copied) {
      this.audit.info('installed the MCP bridge and launcher.');
    }
  }

  /**
   * Start the listener if it is not already up. Safe to call concurrently.
   * `agent` is for starts nobody clicked, such as an editor starting its MCP
   * definition: those never overrule a Stop from the user.
   */
  async ensureStarted(origin: 'user' | 'agent' = 'user'): Promise<void> {
    if (this.disposed) {
      throw new Error('This VS Code window is closing.');
    }
    if (this.settings.enabled === 'off') {
      throw new Error('The MCP server is disabled by the zephyr-workbench.mcp.enabled setting.');
    }
    if (origin === 'agent' && this.stoppedByUser) {
      throw new Error('The Zephyr Workbench MCP server was stopped in VS Code. Start it from the AI Manager.');
    }
    this.stoppedByUser = false;
    if (this.server) {
      return;
    }
    if (!this.starting) {
      this.starting = this.startInternal().finally(() => { this.starting = undefined; });
    }
    return this.starting;
  }

  private async startInternal(): Promise<void> {
    const sdk = await loadSdk();
    const version = this.extensionVersion;
    const tools = this.servedTools.map(meta => ({
      meta, handler: withAskBeforeUse(meta, withSettingsWarnings(HANDLERS[meta.name], line => this.audit.warn(line))),
    }));
    const current = () => this.settings;
    const deps: HostDeps = {
      services: this.services,
      jobs: this.jobs,
      get defaultWaitSeconds() { return current().defaultWaitSeconds; },
      get revealTerminal() { return current().revealTerminal; },
      confirmations: this.confirmations,
      permissionOf: tool => permissionOf(tool, current().permissions),
      get permissionPreset() { return current().permissions.preset; },
      kconfig: this.kconfig,
      extensionContext: this.context,
      folders: this.folders,
      refreshViews: views => refreshViews(views, line => this.audit.warn(line)),
      servedTools: () => new Set(this.servedTools.map(meta => meta.name)),
    };

    const handler = sdk.server.createMcpHandler(
      () => buildMcpServer({
        sdk,
        version,
        tools,
        deps,
        onCall: event => this.audit.record(event),
      }),
      // `json` would drop mid-call notifications, which would silently kill
      // build progress, so the response mode stays `auto`.
      { legacy: 'stateless', responseMode: 'auto', onerror: error => this.audit.warn(String(error)) },
    );

    const listen = (port: number) => startHttpServer({
      port,
      fetch: request => handler.fetch(request, {}),
      health: () => ({ windowId: this.windowId, extensionVersion: version }),
      log: line => this.audit.info(line),
    });
    let server: RunningServer;
    try {
      server = await listen(this.settings.port);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && this.settings.port > 0) {
        this.audit.warn(`Port ${this.settings.port} is in use by another window, falling back to an automatic port.`);
        server = await listen(0);
      } else {
        await handler.close().catch(() => undefined);
        throw error;
      }
    }

    if (this.disposed || this.settings.enabled === 'off') {
      // The window closed or the user turned the feature off while starting.
      await handler.close().catch(() => undefined);
      await server.close();
      return;
    }
    this.server = server;
    this.handlerClose = () => handler.close();
    this.audit.info(`MCP server listening on ${server.url} with ${tools.length} tool(s).`);
    await this.publishRecord();
    this.refreshStatusBar();
  }

  async stop(): Promise<void> {
    this.confirmations.clear('the MCP server stopped');
    if (this.starting) {
      // Let a start in flight finish, or it would come up after this returns.
      await this.starting.catch(() => undefined);
    }
    const server = this.server;
    this.server = undefined;
    if (this.handlerClose) {
      await this.handlerClose().catch(() => undefined);
      this.handlerClose = undefined;
    }
    await server?.close();
    // Each session holds a parsed Kconfig tree in a Python process of its own.
    await this.kconfig.closeAll();
    if (server) {
      this.audit.info('MCP server stopped.');
    }
    if (!this.disposed) {
      await this.publishRecord();
      this.refreshStatusBar();
    }
  }

  /** The Stop command: stays stopped until the user starts it again. */
  async stopByUser(): Promise<void> {
    this.stoppedByUser = true;
    await this.stop();
  }

  async restart(origin: 'user' | 'agent' = 'user'): Promise<void> {
    await this.stop();
    await this.ensureStarted(origin);
  }

  private reportedProblems = '';

  /** Log settings problems, and tell the user once, because the log is easy to miss. */
  private reportSettingsProblems(problems: string[]): void {
    for (const problem of problems) {
      this.audit.warn(problem);
    }
    const key = problems.join('\n');
    if (problems.length > 0 && key !== this.reportedProblems) {
      void vscode.window.showWarningMessage(`Zephyr Workbench MCP: ${problems[0]}`, 'Open Settings').then(choice => {
        if (choice === 'Open Settings') {
          void vscode.commands.executeCommand('workbench.action.openSettings', SECTION);
        }
      });
    }
    this.reportedProblems = key;
  }

  private canPublish(): boolean {
    return !this.disposed && this.settings.enabled !== 'off';
  }

  private async publishRecord(): Promise<void> {
    if (!this.canPublish()) {
      return;
    }
    try {
      const apps = await this.services.listApplications();
      // Checked again: the user may have turned the integration off, or the
      // window may have closed, while the applications were being listed.
      if (!this.canPublish()) {
        return;
      }
      this.registry.publish({
        ...(isSdkSupported() ? {} : { unsupported: UNSUPPORTED_MESSAGE }),
        ...(this.server ? { port: this.server.port, url: this.server.url, token: this.server.token } : {}),
        // The bridge advertises exactly these, so an agent never sees a tool
        // the user switched off.
        tools: this.servedTools.map(meta => meta.name),
        appRoots: apps.map(a => a.appRootPath),
        westWorkspaces: this.services.listWestWorkspaces().map(w => w.rootUri.fsPath),
        extensionVersion: this.extensionVersion,
        catalogVersion: catalogVersion(this.servedTools),
      });
    } catch (error) {
      this.audit.warn(`could not publish the window record: ${messageOf(error)}`);
    }
  }

  private registerListeners(): void {
    this.disposables.push(
      guardTaskLaunches(this.jobs),
      watchBuildConflicts(this.jobs),
      // From activation on, so get_diagnostics knows which open files a
      // language server has yet to check again.
      watchDocumentChecks(),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.publishRecord()),
      vscode.window.onDidChangeWindowState(state => {
        if (state.focused) {
          this.registry.touch(true);
        }
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(SECTION)) {
          void this.onSettingsChanged();
        }
      }),
    );
  }

  private settingsChange: Promise<void> = Promise.resolve();

  /** Settings changes are applied one at a time, in the order they happened. */
  private onSettingsChanged(): Promise<void> {
    this.settingsChange = this.settingsChange
      .then(() => this.applySettingsChange())
      .catch(error => this.audit.warn(`could not apply the MCP settings: ${messageOf(error)}`));
    return this.settingsChange;
  }

  private async applySettingsChange(): Promise<void> {
    const previous = this.settings;
    const { settings, problems } = readSettingsChecked();
    this.settings = settings;
    this.reportSettingsProblems(problems);
    // A start already under way uses the settings it read; let it finish, so
    // the checks below see the server it produced and restart it if needed.
    if (this.starting) {
      await this.starting.catch(() => undefined);
    }
    if (previous.homeDir !== this.settings.homeDir) {
      void vscode.window.showInformationMessage('Reload the window to move the Zephyr Workbench MCP files to the new folder.');
    }
    const asking = (settings: typeof previous) =>
      TOOL_CATALOG.filter(tool => permissionOf(tool, settings.permissions) === 'ask').map(tool => tool.name);
    const before = asking(previous);
    const after = asking(this.settings);
    const dropped = before.filter(name => !after.includes(name));
    if (dropped.length > 0 || before.length !== after.length) {
      this.confirmations.clear('the permissions changed');
      if (dropped.length > 0) {
        // Worth a line of its own: an agent with file access could try this.
        this.audit.warn(`Agents no longer need approval for: ${dropped.join(', ')}.`);
      }
    }
    const served = (settings: typeof previous) => selectTools(TOOL_CATALOG, settings.permissions).map(tool => tool.name).join('\u0000');
    const toolsChanged = served(previous) !== served(this.settings);
    const portChanged = previous.port !== this.settings.port;
    if (previous.enabled !== this.settings.enabled) {
      await this.applyEnabledSetting();
    }
    // Independent of the enabled change above: both can arrive in one save,
    // and a running server keeps the tool list it started with until restarted.
    if ((toolsChanged || portChanged) && this.settings.enabled !== 'off') {
      if (this.server) {
        // Not a user start: a Stop clicked meanwhile wins.
        await this.restart('agent').catch(error => this.audit.warn(`the MCP server did not restart: ${messageOf(error)}`));
      } else {
        await this.publishRecord();
      }
    }
    if (toolsChanged) {
      this.editors?.notifyChanged();
    }
    this.refreshStatusBar();
  }

  private refreshStatusBar(): void {
    if (this.disposed) {
      return;
    }
    void vscode.commands.executeCommand('setContext', 'zephyr-workbench.mcp.running', !!this.server);
    if (!this.settings.showStatusBar || this.settings.enabled === 'off') {
      this.statusBar.hide();
      return;
    }
    const running = this.jobs.list().find(j => j.status === 'running');
    const asking = this.confirmations.pending;
    if (asking) {
      this.statusBar.text = '$(question) MCP: answer needed';
      this.statusBar.tooltip = `An AI agent is waiting for your answer before running ${asking.tool}.`;
    } else if (running) {
      this.statusBar.text = `$(sync~spin) MCP: ${running.spec.kind}`;
      this.statusBar.tooltip = `Zephyr Workbench MCP: ${running.spec.kind} job ${running.id} is running. Click to open the AI Manager.`;
    } else if (this.server) {
      this.statusBar.text = '$(plug) MCP';
      this.statusBar.tooltip = `Zephyr Workbench MCP server on 127.0.0.1:${this.server.port}, ${this.servedTools.length} tools. Click to open the AI Manager.`;
    } else if (!isSdkSupported()) {
      this.statusBar.text = '$(debug-disconnect) MCP off';
      this.statusBar.tooltip = UNSUPPORTED_MESSAGE;
    } else {
      this.statusBar.text = '$(debug-disconnect) MCP';
      this.statusBar.tooltip = this.stoppedByUser
        ? 'The Zephyr Workbench MCP server was stopped. Click to open the AI Manager.'
        : 'The Zephyr Workbench MCP server starts automatically when an agent connects. Click to open the AI Manager.';
    }
    this.statusBar.show();
  }

  /** Whether VS Code got the server from this extension, so Copilot needs no configuration. */
  get registeredWithVsCode(): boolean {
    return this.editors?.vsCodeRegistered ?? false;
  }

  /** Data the AI Manager panel renders. */
  async snapshot() {
    const served = new Set(this.servedTools.map(meta => meta.name));
    return {
      server_name: SERVER_NAME,
      enabled: this.settings.enabled,
      running: !!this.server,
      stopped_by_user: this.stoppedByUser,
      supported: isSdkSupported(),
      unsupported_reason: isSdkSupported() ? undefined : UNSUPPORTED_MESSAGE,
      window_id: this.windowId,
      port: this.server?.port,
      url: this.server?.url,
      permission_preset: this.settings.permissions.preset,
      ...(this.settings.permissions.locked ? { permissions_locked: true } : {}),
      tool_count: served.size,
      tools: TOOL_CATALOG.filter(t => !!HANDLERS[t.name]).map(t => ({
        name: t.name, title: t.title, summary: t.summary, category: t.category,
        read_only: t.annotations.readOnlyHint === true,
        destructive: t.annotations.destructiveHint === true,
        permission: permissionOf(t, this.settings.permissions),
        asks: confirmCategoriesOf(t),
      })),
      workspace_folders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
      jobs: this.jobs.list().slice(0, 10).map(j => ({
        job_id: j.id, kind: j.spec.kind, status: j.status, config_name: j.spec.configName,
        app_path: j.spec.appPath, started_at: new Date(j.startedAt).toISOString(), command: j.spec.command,
      })),
      other_windows: this.registry.otherWindows().length,
      pending_confirmation: this.confirmations.pending?.tool,
      session_approvals: this.confirmations.sessionApprovals,
      testing: !!this.testRun,
      last_test: this.lastTest,
    };
  }

  /**
   * Test connection, from the AI Manager or the palette: run every check, keep
   * the result for the AI Manager, and write the full report to the MCP output
   * channel. A test already running is joined rather than started twice.
   */
  runConnectionTest(): Promise<DoctorCheck[]> {
    if (!this.testRun) {
      this.testRun = this.diagnose()
        .then(checks => {
          this.lastTest = { at: new Date().toISOString(), checks };
          this.reportTest(checks);
          return checks;
        })
        .finally(() => {
          this.testRun = undefined;
          this.stateChanged.fire();
        });
      this.stateChanged.fire();
    }
    return this.testRun;
  }

  private reportTest(checks: DoctorCheck[]): void {
    const problems = checks.filter(check => !check.ok).length;
    const headline = problems === 0
      ? `Connection test: all ${checks.length} checks passed.`
      : `Connection test: ${problems} of ${checks.length} checks found a problem.`;
    for (const [ok, line] of [
      [problems === 0, headline] as const,
      ...checks.map(check => [check.ok, `  ${check.name}: ${check.ok ? 'OK' : 'PROBLEM'}. ${check.detail}${check.fix ? ` Fix: ${check.fix}` : ''}`] as const),
    ]) {
      if (ok) {
        this.audit.info(line);
      } else {
        this.audit.warn(line);
      }
    }
  }

  /**
   * Every check between an agent and this window, ending with the real thing:
   * the command an agent config holds is run from the workspace folder and
   * asked for get_status, exactly as an agent would.
   */
  async diagnose(): Promise<DoctorCheck[]> {
    const paths = getMcpPaths(this.settings.homeDir || undefined);
    this.installBridgeFiles();
    const checks = checkInstall({
      paths,
      extensionVersion: this.extensionVersion,
      platform: process.platform,
      nodeMajor: Number.parseInt(process.versions.node.split('.')[0], 10),
    });
    if (this.settings.enabled === 'off') {
      checks.push({
        name: 'Setting', ok: false, detail: 'zephyr-workbench.mcp.enabled is "off", so no agent can reach this window.',
        fix: 'Set it to "auto" in the settings.',
      });
      return checks;
    }
    checks.push({ name: 'Setting', ok: true, detail: `zephyr-workbench.mcp.enabled is "${this.settings.enabled}".` });

    try {
      await this.ensureStarted();
      checks.push({
        name: 'Server', ok: true,
        detail: `Listening on 127.0.0.1:${this.server?.port} with ${this.servedTools.length} tools (${this.settings.permissions.preset} permissions).`,
      });
    } catch (error) {
      checks.push({ name: 'Server', ok: false, detail: messageOf(error), fix: 'Open the MCP activity log for details.' });
      return checks;
    }

    const published = readWindowRecords(paths).some(r => r.windowId === this.windowId && r.port === this.server?.port);
    checks.push(published
      ? { name: 'Window record', ok: true, detail: `Published in ${paths.windowsDir}.` }
      : {
        name: 'Window record', ok: false, detail: `No up to date record for this window in ${paths.windowsDir}.`,
        fix: 'Restart the MCP server from the AI Manager.',
      });

    const launcher = launcherSpec(paths, process.execPath, 'auto');
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const commandLine = [launcher.command, ...launcher.args].join(' ');
    const probe = await probeBridge({ ...launcher, cwd: folder, call: { name: 'get_status', arguments: {} }, timeoutMs: 30_000 });
    if (probe.ok) {
      checks.push({
        name: 'Agent path', ok: true,
        detail: `Ran ${commandLine} from ${folder ?? 'the home folder'}: it listed ${probe.tools?.length ?? 0} tools and answered get_status in ${probe.ms} ms.`,
      });
    } else {
      const code = (probe.callResult as { error?: { code?: string; hint?: string } } | undefined)?.error;
      checks.push({
        name: 'Agent path', ok: false,
        detail: `Ran ${commandLine} from ${folder ?? 'the home folder'}: ${probe.error ?? `${code?.code ?? 'the call failed'}.`}`
          + (probe.stderr ? ` Its error output ends with: ${probe.stderr.split('\n').slice(-3).join(' ')}` : ''),
        fix: code?.hint ?? 'Open the MCP activity log, and the bridge log in the logs folder of the MCP home.',
      });
    }

    const others = this.registry.otherWindows().length;
    if (others > 0) {
      checks.push({
        name: 'Other windows', ok: true,
        detail: `${others} other VS Code window(s) also offer the server. An agent reaches the window whose folder contains its working directory, or the app_path it passes.`,
      });
    }
    return checks;
  }

  /** Forget every "Allow for This Session" approval, from the AI Manager. */
  forgetApprovals(): void {
    this.confirmations.clear('the user asked from the AI Manager');
  }

  showLog(): void {
    this.audit.show();
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stopWakePoll();
    this.jobs.failRunning('The VS Code window closed while this job was running.');
    await this.stop().catch(() => undefined);
    this.editors?.dispose();
    this.editors = undefined;
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The command behind each view. `toolchains` only redraws: no pruning, no detection. */
const VIEW_REFRESH_COMMANDS: Record<WorkbenchView, string> = {
  apps: 'zephyr-workbench-app-explorer.refresh',
  westWorkspaces: 'zephyr-workbench-west-workspace.refresh',
  toolchains: 'zephyr-workbench-sdk-explorer.refresh-view',
  dashboard: 'zephyr-workbench.workbench-dashboard.refresh',
};

/**
 * Refresh the workbench views a tool changed. Never throws: the change is
 * already made, and a view that failed to redraw must not fail the call.
 */
async function refreshViews(views: ReadonlyArray<WorkbenchView>, log: (line: string) => void): Promise<void> {
  const work: (() => unknown)[] = [...new Set(views)].map(view => () => vscode.commands.executeCommand(VIEW_REFRESH_COMMANDS[view]));
  if (views.includes('toolchains')) {
    // The create application panel lists the toolchains too.
    work.push(() => CreateZephyrAppPanel.currentPanel?.refreshToolchains());
  }
  const results = await Promise.allSettled(work.map(async run => run()));
  for (const result of results) {
    if (result.status === 'rejected') {
      log(`could not refresh a view: ${messageOf(result.reason)}`);
    }
  }
}
