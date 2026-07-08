import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getNonce } from '../utilities/getNonce';
import { getUri } from '../utilities/getUri';
import { executeTaskWithExitCode } from '../utils/execUtils';
import { buildDirectTask } from '../providers/ZephyrTaskProvider';
import { ZephyrApplication } from '../models/ZephyrApplication';
import type { ZephyrBuildConfig } from '../models/ZephyrBuildConfig';
import type { RpcHandlerMap } from '../utils/eclair/eclairRpcTypes';
import {
  extractKconfigLaunchSpec,
  isExtractError,
  preflight,
  type KconfigLaunchSpec,
} from '../utils/kconfig/kconfigEnvExtractor';
import { KconfigServerClient } from '../utils/kconfig/kconfigServerClient';
import type {
  KconfigRpcMethods,
  KcTarget,
  KcDriftEntry,
} from '../utils/kconfig/kconfigRpcTypes';
import type { KcExtensionMessage, KcWebviewMessage, RpcRequestMessage } from '../utils/kconfig/kconfigEvent';
import { writePrjConfManagedRegion } from '../utils/kconfig/prjConfWriter';
import {
  checkFragmentStaleness,
  findBuildInfoYml,
  findLaterFragmentOverrides,
  readKconfigFragments,
  type KconfigFragmentInfo,
} from '../utils/kconfig/fragmentStaleness';
import { saveConfigEnv } from '../utils/env/zephyrEnvUtils';

const CONFIGURE_TASK_LABEL = 'Configure (CMake only)';
const BUILD_TASK_LABEL = 'West Build';
const SERVER_SCRIPT = ['scripts', 'kconfig', 'kconfig_server.py'];

let sharedOutput: vscode.OutputChannel | undefined;
function kconfigOutput(): vscode.OutputChannel {
  if (!sharedOutput) {
    sharedOutput = vscode.window.createOutputChannel('Zephyr Workbench: Kconfig');
  }
  return sharedOutput;
}

/**
 * One editor-tab webview panel (and one Python server process) per build configuration,
 * bound to the app/config it was opened for. Right-clicking a different target opens its
 * own panel; there is no in-panel reselection (mirrors the Debug Manager).
 */
export class KconfigManagerPanel {
  private static panels = new Map<string, KconfigManagerPanel>();

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _app: ZephyrApplication;
  private readonly _buildConfig: ZephyrBuildConfig;
  private readonly _buildDir: string;
  private _disposables: vscode.Disposable[] = [];
  private _client: KconfigServerClient | undefined;
  private _spec: KconfigLaunchSpec | undefined;
  private _watchers: vscode.FileSystemWatcher[] = [];
  private _suppressWatchUntil = 0;
  private _dirty = false;
  private _booted = false;
  private _bootStarted = false;
  private _lastPhase: KcExtensionMessage | undefined;
  private _pendingExport: { target: 'prj' | 'fragment'; targetPath: string } | undefined;
  private _restartCount = 0;
  private _lastRestart = 0;
  private _disposed = false;

  private readonly _rpcHandlers: RpcHandlerMap<KconfigRpcMethods> = {
    'kconfig/getTarget': () => this._getTarget(),
    'kconfig/getTree': () => this._requireClient().call('get_tree'),
    'kconfig/setValue': (p) => this._requireClient().call('set_value', { id: p.id, value: p.value }),
    'kconfig/unsetValue': (p) => this._requireClient().call('unset_value', { id: p.id }),
    'kconfig/undo': () => this._requireClient().call('undo'),
    'kconfig/redo': () => this._requireClient().call('redo'),
    'kconfig/revert': (p) => this._requireClient().call('revert', { name: p.name }),
    'kconfig/getChanges': () => this._requireClient().call('get_changes'),
    'kconfig/getInfo': (p) => this._requireClient().call('info', { id: p.id }),
    'kconfig/save': (p) => this._save(p),
    'kconfig/loadConfig': (p) => this._loadConfig(p),
    'kconfig/getDriftCount': () => this._getDriftCount(),
    'kconfig/persistPrjConf': (p) => this._startDriftExport(p),
    'kconfig/persistPrjConfWrite': (p) => this._writeDriftExport(p),
    'kconfig/openLocation': (p) => this._openLocation(p),
    'kconfig/buildNow': () => this._buildNow(),
    'kconfig/restart': () => this._restart(),
  };

  public static async render(
    extensionUri: vscode.Uri,
    project?: ZephyrApplication,
    buildConfig?: ZephyrBuildConfig,
  ): Promise<void> {
    if (!project) {
      vscode.window.showErrorMessage('Kconfig Manager: no application selected.');
      return;
    }
    const cfg = buildConfig ?? (await KconfigManagerPanel.pickBuildConfig(project));
    if (!cfg) { return; }

    const buildDir = cfg.getBuildDir(project);
    const existing = KconfigManagerPanel.panels.get(buildDir);
    if (existing) {
      existing._panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'zephyr-workbench.kconfig-manager.panel',
      `Kconfig: ${project.appName} [${cfg.name}]`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out')],
      },
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'res', 'icons', 'light', 'kconfig-icon.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'res', 'icons', 'dark', 'kconfig-icon.svg'),
    };

    const instance = new KconfigManagerPanel(panel, extensionUri, project, cfg, buildDir);
    KconfigManagerPanel.panels.set(buildDir, instance);
    // boot() is kicked off when the webview reports 'webview-ready', so no phase event
    // is ever posted before the webview has attached its message listener.
  }

  private static async pickBuildConfig(project: ZephyrApplication): Promise<ZephyrBuildConfig | undefined> {
    const configs = project.buildConfigs ?? [];
    if (configs.length === 0) {
      vscode.window.showErrorMessage(`Kconfig Manager: ${project.appName} has no build configuration.`);
      return undefined;
    }
    if (configs.length === 1) { return configs[0]; }
    const active = configs.find((c) => c.active);
    if (active) { return active; }
    const pick = await vscode.window.showQuickPick(
      configs.map((c) => ({ label: c.name, description: c.boardIdentifier, cfg: c })),
      { title: 'Kconfig Manager: choose a build configuration' },
    );
    return pick?.cfg;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    app: ZephyrApplication,
    buildConfig: ZephyrBuildConfig,
    buildDir: string,
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._app = app;
    this._buildConfig = buildConfig;
    this._buildDir = buildDir;

    this._panel.webview.html = this._getWebviewContent(this._panel.webview, extensionUri);
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg: KcWebviewMessage) => this._onMessage(msg),
      undefined,
      this._disposables,
    );
  }

  // -- boot / configure / server lifecycle ---------------------------------

  private async boot(): Promise<void> {
    try {
      this._post({ command: 'kconfig-event', event: { kind: 'phase', phase: 'starting' } });

      let pf = preflight(this._buildDir, this._app.appName);
      if (!pf.ready) {
        // Configure the project the same way `west build -t menuconfig` would first.
        this._post({
          command: 'kconfig-event',
          event: { kind: 'phase', phase: 'configuring', message: 'This build is not configured yet. Running the CMake configure stage.' },
        });
        const ok = await this._runConfigure();
        if (!ok) {
          this._post({
            command: 'kconfig-event',
            event: { kind: 'phase', phase: 'error', message: 'CMake configure failed. See the task output, then Retry.' },
          });
          return;
        }
        pf = preflight(this._buildDir, this._app.appName);
        if (!pf.ready) {
          this._post({
            command: 'kconfig-event',
            event: { kind: 'phase', phase: 'error', message: 'The configure step did not produce the expected build files. Build the project once, then retry.' },
          });
          return;
        }
      }

      await this._startServer();
      this._setupWatchers();
      this._booted = true;
      this._post({ command: 'kconfig-event', event: { kind: 'phase', phase: 'ready' } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      kconfigOutput().appendLine(`[boot] ${msg}`);
      this._post({ command: 'kconfig-event', event: { kind: 'phase', phase: 'error', message: msg } });
    }
  }

  private async _runConfigure(): Promise<boolean> {
    const task = buildDirectTask(this._app.appWorkspaceFolder, CONFIGURE_TASK_LABEL, this._buildConfig.name, {}, this._app);
    if (!task) {
      kconfigOutput().appendLine('[configure] could not build the Configure task');
      return false;
    }
    const code = await executeTaskWithExitCode(task);
    kconfigOutput().appendLine(`[configure] exit code ${code}`);
    return code === 0;
  }

  private async _startServer(): Promise<void> {
    const spec = extractKconfigLaunchSpec(this._buildDir, this._app.appName);
    if (isExtractError(spec)) {
      throw new Error(`Could not reproduce the Kconfig environment: ${spec.error}`);
    }
    // build.ninja carries the authoritative interpreter; fall back to the app venv.
    if (!spec.python) {
      const venvPython = this._venvPython();
      if (!venvPython) {
        throw new Error('No Python interpreter found (build.ninja and app venv both unavailable).');
      }
      spec.python = venvPython;
    }
    this._spec = spec;
    kconfigOutput().appendLine(
      `[server] python: ${spec.python} (env source: ${spec.source}, config: ${spec.configPath})`,
    );

    const client = new KconfigServerClient({
      spec,
      serverScriptPath: vscode.Uri.joinPath(this._extensionUri, ...SERVER_SCRIPT).fsPath,
      log: (line) => kconfigOutput().appendLine(line),
      onDirty: (dirty) => this._onDirty(dirty),
      onWarnings: (warnings) => this._post({ command: 'kconfig-event', event: { kind: 'warnings', warnings } }),
      onExit: (code, expected) => { if (!expected) { this._onCrash(code); } },
    });
    this._client = client;
    await client.start();
    await client.call('init', {}, 120000);
  }

  private _venvPython(): string | undefined {
    const venv = this._app.venvPath;
    if (!venv) { return undefined; }
    const candidate = process.platform === 'win32'
      ? path.join(venv, 'Scripts', 'python.exe')
      : path.join(venv, 'bin', 'python');
    return fs.existsSync(candidate) ? candidate : undefined;
  }

  private async _restart(): Promise<{ ok: boolean }> {
    const now = Date.now();
    if (now - this._lastRestart < 10000) { this._restartCount++; } else { this._restartCount = 0; }
    this._lastRestart = now;
    if (this._restartCount > 3) {
      this._post({ command: 'kconfig-event', event: { kind: 'phase', phase: 'error', message: 'Kconfig server keeps crashing; check the output channel.' } });
      return { ok: false };
    }
    if (this._client) { await this._client.dispose().catch(() => {}); this._client = undefined; }
    await this.boot();
    return { ok: this._booted };
  }

  private _onCrash(code: number | null) {
    kconfigOutput().appendLine(`[server] crashed (code ${code})`);
    this._post({
      command: 'kconfig-event',
      event: { kind: 'phase', phase: 'crashed', message: `Kconfig server stopped (code ${code}). Recent output:\n${(this._client?.recentStderr ?? []).slice(-8).join('\n')}` },
    });
  }

  // -- external-change watchers --------------------------------------------

  private _setupWatchers() {
    if (!this._spec) { return; }
    const watch = (file: string, onChange: () => void) => {
      const dir = path.dirname(file);
      const base = path.basename(file);
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, base));
      const handler = () => {
        if (Date.now() < this._suppressWatchUntil) { return; }
        onChange();
      };
      w.onDidChange(handler, undefined, this._disposables);
      w.onDidCreate(handler, undefined, this._disposables);
      this._watchers.push(w);
      this._disposables.push(w);
    };

    let debounce: NodeJS.Timeout | undefined;
    watch(this._spec.configPath, () => {
      if (debounce) { clearTimeout(debounce); }
      debounce = setTimeout(() => this._onExternalConfigChange(), 500);
    });
    watch(this._spec.edtPickle, () => {
      // Devicetree changed -> the whole env may differ; a full restart is safest.
      this._post({ command: 'kconfig-event', event: { kind: 'reloading' } });
      void this._restart();
    });
  }

  private async _onExternalConfigChange() {
    // If the user has local edits, let them decide; otherwise reload silently.
    const state = await this._client?.call('get_state').catch(() => undefined);
    const hasLocalEdits = this._dirty;
    this._post({ command: 'kconfig-event', event: { kind: 'externalChange', hasLocalEdits } });
    if (!hasLocalEdits) {
      await this._softReload();
    }
    void state;
  }

  private async _softReload() {
    if (!this._client) { return; }
    this._post({ command: 'kconfig-event', event: { kind: 'reloading' } });
    await this._client.call('init', {}, 120000);
    const init = await this._client.call('get_tree');
    this._post({ command: 'kconfig-event', event: { kind: 'reloaded', init } });
  }

  // -- RPC method implementations ------------------------------------------

  private _getTarget(): KcTarget {
    return {
      appName: this._app.appName,
      configName: this._buildConfig.name,
      board: this._buildConfig.boardIdentifier,
      appRootPath: this._app.appRootPath,
      configPath: this._spec?.configPath ?? '',
      envSource: this._spec?.source ?? 'ninja',
    };
  }

  private async _save(p: KconfigRpcMethods['kconfig/save']['params']) {
    const client = this._requireClient();
    if (p.kind === 'config') {
      this._suppressWatchUntil = Date.now() + 2500;
      const res = await client.call('write_config', {});
      // Offer a rebuild so generated headers pick up the change.
      void vscode.window
        .showInformationMessage('Configuration saved. Rebuild to apply it.', 'Build now')
        .then((choice) => { if (choice === 'Build now') { void this._buildNow(); } });
      return { ok: true, message: res.message, dirty: false };
    }

    // Save As / Save minimal: prompt for a destination.
    const isMin = p.kind === 'minimal';
    const defaultName = isMin ? 'defconfig' : `${this._buildConfig.name}.config`;
    const uri = await vscode.window.showSaveDialog({
      title: isMin ? 'Save minimal configuration' : 'Save configuration as',
      defaultUri: vscode.Uri.file(path.join(this._app.appRootPath, defaultName)),
    });
    if (!uri) { return { ok: false, canceled: true, dirty: this._dirty }; }
    const method = isMin ? 'write_min_config' : 'write_config';
    const res = await client.call(method, { path: uri.fsPath });
    vscode.window.showInformationMessage(
      isMin ? `Minimal configuration saved to ${uri.fsPath}.` : `Configuration saved to ${uri.fsPath}.`,
    );
    return { ok: true, path: uri.fsPath, message: res.message, dirty: this._dirty };
  }

  private async _loadConfig(p: KconfigRpcMethods['kconfig/loadConfig']['params']) {
    const client = this._requireClient();
    let target = p.path;
    if (!target) {
      const uri = await vscode.window.showOpenDialog({
        title: 'Open configuration',
        canSelectMany: false,
        defaultUri: vscode.Uri.file(this._app.appRootPath),
      });
      if (!uri || uri.length === 0) { return { ok: false, canceled: true }; }
      target = uri[0].fsPath;
    }
    const res = await client.call('load_config', { path: target, replace: p.replace !== false });
    vscode.window.showInformationMessage(`Loaded configuration from ${target}.`);
    return { ok: true, message: res.message, generation: res.generation, changes: res.changes, dirty: res.dirty, needsSave: res.needsSave };
  }

  // -- drift export (make temporary .config values permanent) ---------------

  private _driftCountBusy = false;

  /**
   * Lightweight badge query: how many temporary values exist right now. Same
   * computation as the export (the server restores its state exactly), minus dialogs.
   * Coalesced: the server is sequential, so badge refreshes must never pile up in its
   * queue ahead of user actions like Save.
   */
  private async _getDriftCount(): Promise<{ count: number; stale: boolean }> {
    if (this._driftCountBusy) { return { count: -1, stale: false }; }
    this._driftCountBusy = true;
    try {
      const client = this._requireClient();
      const innerBuildDir = this._spec?.buildDir ?? this._buildDir;
      const buildInfoPath = findBuildInfoYml(innerBuildDir);
      const fragments = buildInfoPath ? readKconfigFragments(buildInfoPath) : undefined;
      if (!fragments) { return { count: 0, stale: false }; }
      const res = await client.call('get_drift', { fragments: fragments.files });
      if (!res.ok) { return { count: 0, stale: false }; }
      const staleness = checkFragmentStaleness(innerBuildDir, fragments.files);
      return { count: (res.drift ?? []).length, stale: staleness.stale };
    } catch {
      return { count: 0, stale: false };
    } finally {
      this._driftCountBusy = false;
    }
  }

  /**
   * Kick the export flow: resolve the fragment list the build was generated from,
   * compute the drift (current state vs fragment-merged baseline) in the server, and
   * hand the result to the webview's confirmation overlay. NEVER reconfigures: a CMake
   * re-merge would regenerate .config and destroy the very values being exported.
   */
  private async _startDriftExport(p: KconfigRpcMethods['kconfig/persistPrjConf']['params']) {
    const client = this._requireClient();

    // Resolve the export destination first (the fragment target needs a file pick).
    let targetPath: string;
    if (p.target === 'fragment') {
      const uri = await vscode.window.showSaveDialog({
        title: 'Export to an extra config fragment',
        defaultUri: vscode.Uri.file(path.join(this._app.appRootPath, 'extra.conf')),
        filters: { 'Kconfig fragment': ['conf'] },
      });
      if (!uri) { return { started: false }; }
      targetPath = uri.fsPath;
    } else {
      targetPath = this._app.prjConfUri.fsPath;
    }

    const innerBuildDir = this._spec?.buildDir ?? this._buildDir;
    const buildInfoPath = findBuildInfoYml(innerBuildDir);
    const fragments = buildInfoPath ? readKconfigFragments(buildInfoPath) : undefined;
    if (!fragments) {
      this._post({
        command: 'kconfig-event',
        event: { kind: 'driftError', message: 'build_info.yml has no Kconfig fragment list; build the project once and retry.' },
      });
      return { started: false };
    }

    const staleness = checkFragmentStaleness(innerBuildDir, fragments.files);

    const res = await client.call('get_drift', { fragments: fragments.files });
    if (!res.ok) {
      if (res.changes) {
        // The state check failed; forward the residue delta so the webview resyncs.
        this._post({ command: 'kconfig-event', event: { kind: 'delta', delta: { generation: res.generation, changes: res.changes, dirty: res.dirty } } });
      }
      this._post({ command: 'kconfig-event', event: { kind: 'driftError', message: res.error ?? 'Export computation failed' } });
      return { started: false };
    }

    // Values assigned by fragments that merge AFTER the target override the export.
    const drift: KcDriftEntry[] = res.drift;
    const afterIdx = this._fragmentsMergedAfter(fragments, p.target, targetPath);
    const overrides = findLaterFragmentOverrides(afterIdx, drift.map((d) => d.name));
    for (const d of drift) {
      const by = overrides.get(d.name);
      if (by) { d.overriddenBy = by; }
    }

    this._pendingExport = { target: p.target, targetPath };
    this._post({
      command: 'kconfig-event',
      event: {
        kind: 'driftReady',
        target: p.target,
        targetPath,
        drift,
        missingFragments: res.missingFragments ?? [],
        stale: staleness.stale,
        staleReason: staleness.reason,
      },
    });
    return { started: true };
  }

  /** Fragments that merge after the export target (their assignments win). */
  private _fragmentsMergedAfter(info: KconfigFragmentInfo, target: 'prj' | 'fragment', targetPath: string): string[] {
    const files = info.files;
    let anchor = -1;
    if (target === 'prj') {
      const prj = this._app.prjConfUri.fsPath;
      anchor = files.findIndex((f) => path.resolve(f) === path.resolve(prj));
      if (anchor < 0 && info.userFiles.length > 0) {
        anchor = files.findIndex((f) => path.resolve(f) === path.resolve(info.userFiles[0]));
      }
    } else {
      anchor = files.findIndex((f) => path.resolve(f) === path.resolve(targetPath));
      if (anchor < 0) {
        // New fragment: it would merge at the EXTRA_CONF_FILE position; only the
        // generated CLI options file and build-dir *.conf glob come after.
        const lastExtra = info.extraUserFiles.length
          ? files.findIndex((f) => path.resolve(f) === path.resolve(info.extraUserFiles[info.extraUserFiles.length - 1]))
          : -1;
        anchor = lastExtra >= 0 ? lastExtra : files.length - 1;
      }
    }
    return anchor >= 0 ? files.slice(anchor + 1) : [];
  }

  private async _writeDriftExport(p: KconfigRpcMethods['kconfig/persistPrjConfWrite']['params']) {
    const pending = this._pendingExport;
    if (!pending) {
      return { ok: false, written: 0, path: '', outsideConflicts: [] };
    }
    this._pendingExport = undefined;
    const lines = p.lines.filter(Boolean);
    const result = writePrjConfManagedRegion(pending.targetPath, lines);
    const fileLabel = pending.target === 'prj' ? 'prj.conf' : path.basename(pending.targetPath);

    if (result.outsideConflicts.length) {
      vscode.window.showWarningMessage(
        `${fileLabel} already assigns ${result.outsideConflicts.length} of these symbols outside the managed region: ${result.outsideConflicts.join(', ')}. Those lines were left untouched and may override the managed values.`,
      );
    }

    const openAction = pending.target === 'prj' ? 'Open prj.conf' : 'Open file';
    const actions: string[] = [openAction];
    const needsRegistration = pending.target === 'fragment' && !this._isInExtraConfFiles(pending.targetPath);
    if (needsRegistration) { actions.push('Add to build config'); }
    void vscode.window
      .showInformationMessage(`Wrote ${result.written} option(s) to ${fileLabel}.`, ...actions)
      .then((choice) => {
        if (choice === openAction) {
          void vscode.window.showTextDocument(vscode.Uri.file(pending.targetPath));
        } else if (choice === 'Add to build config') {
          void this._addToExtraConfFiles(pending.targetPath);
        }
      });

    return { ok: true, written: result.written, path: pending.targetPath, outsideConflicts: result.outsideConflicts };
  }

  private _isInExtraConfFiles(file: string): boolean {
    const list = this._buildConfig.envVars?.['EXTRA_CONF_FILE'];
    if (!Array.isArray(list)) { return false; }
    return list.some((entry: string) => typeof entry === 'string' && path.resolve(entry) === path.resolve(file));
  }

  private async _addToExtraConfFiles(file: string): Promise<void> {
    try {
      const current = Array.isArray(this._buildConfig.envVars?.['EXTRA_CONF_FILE'])
        ? [...this._buildConfig.envVars['EXTRA_CONF_FILE']]
        : [];
      if (!current.includes(file)) { current.push(file); }
      await saveConfigEnv(this._app.appWorkspaceFolder, this._buildConfig.name, 'EXTRA_CONF_FILE', current);
      this._buildConfig.envVars['EXTRA_CONF_FILE'] = current;
      vscode.window.showInformationMessage(
        `Added ${path.basename(file)} to EXTRA_CONF_FILE of build config "${this._buildConfig.name}". The next build will apply it.`,
      );
    } catch (e) {
      vscode.window.showErrorMessage(`Could not update the build config: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async _openLocation(p: { file: string; line: number }): Promise<void> {
    let file = p.file;
    if (!path.isAbsolute(file) && this._spec) {
      const candidate = path.join(this._spec.zephyrBase, file);
      if (fs.existsSync(candidate)) { file = candidate; }
    }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const line = Math.max(0, (p.line ?? 1) - 1);
      const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false });
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    } catch (e) {
      vscode.window.showWarningMessage(`Could not open ${file}: ${String(e)}`);
    }
  }

  private async _buildNow(): Promise<{ started: boolean }> {
    const task = buildDirectTask(this._app.appWorkspaceFolder, BUILD_TASK_LABEL, this._buildConfig.name, {}, this._app);
    if (!task) { return { started: false }; }
    await vscode.tasks.executeTask(task);
    return { started: true };
  }

  // -- message plumbing -----------------------------------------------------

  private _onMessage(msg: KcWebviewMessage) {
    if (msg.command === 'rpc-request') {
      void this._handleRpcRequest(msg);
      return;
    }
    if (msg.command === 'webview-ready') {
      if (!this._bootStarted) {
        this._bootStarted = true;
        void this.boot();
      } else if (this._lastPhase) {
        // Webview reloaded (e.g. after being hidden): replay the current phase.
        this._post(this._lastPhase);
      }
    }
  }

  private async _handleRpcRequest(req: RpcRequestMessage) {
    const handler = this._rpcHandlers[req.method as keyof KconfigRpcMethods];
    if (!handler) {
      this._post({ command: 'rpc-response', id: req.id, error: { message: `Unknown RPC method '${req.method}'` } });
      return;
    }
    try {
      const result = await (handler as (params: any) => any)(req.params);
      this._post({ command: 'rpc-response', id: req.id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string })?.code;
      this._post({ command: 'rpc-response', id: req.id, error: { message, code } });
    }
  }

  private _onDirty(dirty: boolean) {
    if (dirty === this._dirty) { return; }
    this._dirty = dirty;
    if (this._disposed) { return; }
    try {
      this._panel.title = `${dirty ? '● ' : ''}Kconfig: ${this._app.appName} [${this._buildConfig.name}]`;
    } catch { /* panel already disposed */ }
    this._post({ command: 'kconfig-event', event: { kind: 'dirty', dirty } });
  }

  private _requireClient(): KconfigServerClient {
    if (!this._client || this._client.state !== 'ready') {
      throw new Error('Kconfig server is not ready');
    }
    return this._client;
  }

  private _post(msg: KcExtensionMessage) {
    if (this._disposed) { return; }
    // Remember the latest phase so a webview that (re)attaches late can be resynced.
    if (msg.command === 'kconfig-event' && msg.event.kind === 'phase') {
      this._lastPhase = msg;
    }
    try {
      void this._panel.webview.postMessage(msg);
    } catch { /* webview already disposed */ }
  }

  public dispose() {
    this._disposed = true;
    KconfigManagerPanel.panels.delete(this._buildDir);
    const client = this._client;
    this._client = undefined;
    // Detach the panel-bound callbacks: the panel/webview are gone and touching them
    // from a response envelope would throw (which used to swallow the very response a
    // save-on-close was waiting for).
    client?.setHandlers({ log: (line) => kconfigOutput().appendLine(line) });
    while (this._disposables.length) {
      const d = this._disposables.pop();
      try { d?.dispose(); } catch { /* ignore */ }
    }
    if (!client) { return; }
    // A webview tab close cannot be vetoed (dispose fires after the panel is gone),
    // but the server is still alive here: offer to save unsaved changes before it exits.
    if (this._dirty && client.state === 'ready') {
      void this._promptSaveOnClose(client);
    } else {
      void client.dispose();
    }
  }

  private async _promptSaveOnClose(client: KconfigServerClient): Promise<void> {
    let keepAlive = false;
    try {
      const choice = await vscode.window.showWarningMessage(
        `The Kconfig Manager for ${this._app.appName} [${this._buildConfig.name}] was closed with unsaved changes.`,
        { modal: true, detail: 'Save them to the build configuration (.config)? Cancel reopens the panel with your changes intact.' },
        'Save',
        "Don't Save",
      );
      if (choice === 'Save') {
        await client.call('write_config', {});
        void vscode.window
          .showInformationMessage('Configuration saved. Rebuild to apply it.', 'Build now')
          .then((c) => { if (c === 'Build now') { void this._buildNow(); } });
      } else if (choice === undefined) {
        // Cancel (or Esc): the tab itself cannot be kept open, but the backend still
        // holds every unsaved edit, so reopen a panel adopting the live backend.
        keepAlive = true;
        KconfigManagerPanel.adopt(this._extensionUri, this._app, this._buildConfig, this._buildDir, client, this._spec);
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Could not save the configuration: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (!keepAlive) { void client.dispose(); }
    }
  }

  /** Recreate a panel around an already-running server client (Cancel-on-close path). */
  private static adopt(
    extensionUri: vscode.Uri,
    app: ZephyrApplication,
    buildConfig: ZephyrBuildConfig,
    buildDir: string,
    client: KconfigServerClient,
    spec: KconfigLaunchSpec | undefined,
  ): void {
    const panel = vscode.window.createWebviewPanel(
      'zephyr-workbench.kconfig-manager.panel',
      `Kconfig: ${app.appName} [${buildConfig.name}]`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out')],
      },
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'res', 'icons', 'light', 'kconfig-icon.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'res', 'icons', 'dark', 'kconfig-icon.svg'),
    };

    const instance = new KconfigManagerPanel(panel, extensionUri, app, buildConfig, buildDir);
    KconfigManagerPanel.panels.set(buildDir, instance);
    instance._client = client;
    instance._spec = spec;
    instance._booted = true;
    instance._bootStarted = true;
    // The webview's ready handshake replays the last phase; make it 'ready' so the
    // adopted webview immediately loads the tree from the live server.
    instance._lastPhase = { command: 'kconfig-event', event: { kind: 'phase', phase: 'ready' } };
    client.setHandlers({
      log: (line) => kconfigOutput().appendLine(line),
      onDirty: (dirty) => instance._onDirty(dirty),
      onWarnings: (warnings) => instance._post({ command: 'kconfig-event', event: { kind: 'warnings', warnings } }),
      onExit: (code, expected) => { if (!expected) { instance._onCrash(code); } },
    });
    instance._setupWatchers();
    instance._onDirty(true);
  }

  private _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = getNonce();
    const scriptUri = getUri(webview, extensionUri, ['out', 'kconfigmanager.js']);
    const styleUri = getUri(webview, extensionUri, ['out', 'kconfigmanager.css']);
    const codiconUri = getUri(webview, extensionUri, ['out', 'codicon.css']);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" nonce="${nonce}" href="${codiconUri}">
<link rel="stylesheet" nonce="${nonce}" href="${styleUri}">
<title>Kconfig Manager</title>
</head>
<body>
<div id="kconfig-manager-root"></div>
<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
