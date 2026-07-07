import * as vscode from "vscode";
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";
import {
  PyOCDExecOptions,
  cleanPyOCDPacks,
  dryRunInstallPyOCDPacks,
  findPyOCDPacks,
  getInstalledPyOCDPacks,
  hasPyOCDPackIndex,
  getPyOCDOutputChannel,
  getPyOCDTargetsJson,
  getPyOCDVersion,
  installPyOCDTarget,
  updatePyOCDPack,
} from "../utils/execUtils";
import { getDebugSessionVenvPath, setupPyOCDTarget } from "../utils/debugTools/debugUtils";
import { ZephyrApplication } from "../models/ZephyrApplication";
import { ZephyrBuildConfig } from "../models/ZephyrBuildConfig";

// Versions with documented Zephyr/VS Code debug regressions, worth a banner.
const KNOWN_BAD_PYOCD_VERSIONS: Record<string, string> = {
  '0.36.0': "pyOCD 0.36.0 has a known issue debugging Zephyr from VS Code (pyocd/pyOCD#1706). Installing a newer version is recommended.",
};


export class PyOCDManagerPanel {

  public static currentPanel: PyOCDManagerPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private project: ZephyrApplication | undefined;
  private buildConfig: ZephyrBuildConfig | undefined;
  private _activeOp: { name: string; cts: vscode.CancellationTokenSource } | undefined;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri,
    project?: ZephyrApplication, buildConfig?: ZephyrBuildConfig) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this.project = project;
    this.buildConfig = buildConfig;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  public static render(extensionUri: vscode.Uri, project?: ZephyrApplication, buildConfig?: ZephyrBuildConfig) {
    if (PyOCDManagerPanel.currentPanel) {
      const panel = PyOCDManagerPanel.currentPanel;
      // Adopt the new build context (e.g. reopened from Debug Manager with a
      // different app) so the Current-build card follows the caller.
      if (project) {
        panel.project = project;
        panel.buildConfig = buildConfig;
      }
      // Always refresh on reopen: venvs/pyocd installs may have changed since
      // the panel was last shown.
      panel.refreshAll();
      panel._panel.reveal(vscode.ViewColumn.One);
    } else {
      const panel = vscode.window.createWebviewPanel("zephyr-workbench.pyocd-manager.panel", "pyOCD Manager", vscode.ViewColumn.One, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out')]
      });
      panel.iconPath = {
        light: vscode.Uri.joinPath(extensionUri, 'res', 'icons', 'light', 'desktop-download.svg'),
        dark: vscode.Uri.joinPath(extensionUri, 'res', 'icons', 'dark', 'desktop-download.svg')
      };

      PyOCDManagerPanel.currentPanel = new PyOCDManagerPanel(panel, extensionUri, project, buildConfig);
      PyOCDManagerPanel.currentPanel.createContent();
    }
  }

  public createContent() {
    this._panel.webview.html = this._getWebviewContent(this._panel.webview, this._extensionUri);
    this._setWebviewMessageListener(this._panel.webview);
    // The webview DOM survives tab switches (retainContextWhenHidden); re-post
    // the data when the panel becomes visible so venvs or pyocd installs made
    // meanwhile (Install Runners, west workspace creation) show up.
    this._panel.onDidChangeViewState(() => {
      if (this._panel.visible) {
        this.refreshAll();
      }
    }, null, this._disposables);
  }

  private refreshAll() {
    this.sendVersionInfo();
    this.sendIndexStatus();
    this.sendInstalledPacks();
    this.sendTargets();
    this.sendBoardTargetInfo();
  }

  private _disposed = false;

  public dispose() {
    PyOCDManagerPanel.currentPanel = undefined;
    this._disposed = true;
    this._activeOp?.cts.cancel();
    this._panel.dispose();
    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private post(message: any) {
    // An operation cancelled by closing the panel still runs its finally
    // blocks; posting to the disposed webview would throw.
    if (this._disposed) {
      return;
    }
    try {
      this._panel.webview.postMessage(message);
    } catch {
      // disposed between the check and the call
    }
  }

  /**
   * Run one pyocd operation with a shared cancellation source, mirroring
   * cmsis-pack-manager download ticks into both the notification progress bar
   * and the webview Activity section. One operation at a time.
   */
  private async runPyOCDOp(op: string, title: string,
    fn: (opts: PyOCDExecOptions) => Promise<void>): Promise<boolean> {
    if (this._activeOp) {
      vscode.window.showWarningMessage(`pyOCD: '${this._activeOp.name}' is still running, wait for it to finish or cancel it.`);
      return false;
    }
    const cts = new vscode.CancellationTokenSource();
    this._activeOp = { name: op, cts };
    this.post({ command: 'op-started', op, label: title });
    let success = false;
    let message: string | undefined;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `pyOCD: ${title}`, cancellable: true },
        async (progress, notifToken) => {
          notifToken.onCancellationRequested(() => cts.cancel());
          let lastPercent = 0;
          await fn({
            token: cts.token,
            onProgress: (current, total) => {
              this.post({ command: 'op-progress', op, current, total: total ?? null });
              if (total && total > 0) {
                const percent = Math.min(100, (current / total) * 100);
                progress.report({ increment: percent - lastPercent, message: `(${current}/${total})` });
                lastPercent = percent;
              } else {
                progress.report({ message: `(${current}/?)` });
              }
            },
          });
        });
      success = true;
    } catch (e) {
      if (e instanceof vscode.CancellationError) {
        message = 'Cancelled';
      } else {
        message = e instanceof Error ? e.message : `${e}`;
        const showLog = 'Show Log';
        vscode.window.showErrorMessage(`pyOCD: ${title} failed: ${message}`, showLog).then(choice => {
          if (choice === showLog) {
            getPyOCDOutputChannel().show();
          }
        });
      }
    } finally {
      this._activeOp = undefined;
      cts.dispose();
      this.post({ command: 'op-finished', op, success, message });
    }
    return success;
  }

  private async sendVersionInfo() {
    const version = await getPyOCDVersion();
    this.post({
      command: 'version-info',
      version: version ?? null,
      knownIssue: version ? KNOWN_BAD_PYOCD_VERSIONS[version] ?? null : null,
    });
  }

  private async sendBoardTargetInfo() {
    if (!this.project || !this.buildConfig) {
      this.post({ command: 'board-target-info', hasContext: false });
      return;
    }
    const projectName = this.project.appName;
    const configName = this.buildConfig.name;
    let target: string | undefined;
    try {
      target = this.buildConfig.getPyOCDTarget(this.project);
    } catch {
      target = undefined;
    }
    if (!target) {
      this.post({
        command: 'board-target-info', hasContext: true, projectName, configName,
        target: null,
      });
      return;
    }
    let installed = false;
    try {
      // The debug session runs in the project's venv, so the card always
      // checks there (independent of the dropdown selection).
      const projectVenv = getDebugSessionVenvPath(this.project);
      installed = (await getPyOCDTargetsJson(false, projectVenv)).some(t => t.name.toLowerCase() === target!.trim().toLowerCase());
    } catch {
      // pyocd unavailable — the version card already reports it
    }
    this.post({
      command: 'board-target-info', hasContext: true, projectName, configName,
      target, installed, resolving: !installed,
    });
    if (!installed) {
      // Resolve which pack(s) provide the target so the user sees exactly what
      // a click would download. Streams through the Activity section: with a
      // missing pack index this triggers the (slow, cancellable) index fetch.
      const projectVenv = getDebugSessionVenvPath(this.project);
      const resolved = await this.runPyOCDOp('resolve-board-pack', `resolving CMSIS-Pack for '${target}'`, async (opts) => {
        const packs = await dryRunInstallPyOCDPacks(target!, { ...opts, venvPath: projectVenv });
        this.post({
          command: 'board-target-info', hasContext: true, projectName, configName,
          target, installed, packs,
        });
      });
      if (!resolved) {
        // Guard-blocked, failed, or cancelled: never leave the card stuck on
        // "Resolving...".
        this.post({
          command: 'board-target-info', hasContext: true, projectName, configName,
          target, installed, resolveFailed: true,
        });
      }
    }
  }

  private async sendInstalledPacks() {
    try {
      const packs = await getInstalledPyOCDPacks();
      this.post({ command: 'installed-packs', packs });
    } catch (e) {
      this.post({ command: 'installed-packs', packs: [], error: e instanceof Error ? e.message : `${e}` });
    }
  }

  // Surface "you never downloaded the pack index" proactively: without it,
  // pack search finds nothing and target installs cannot resolve a pack.
  private async sendIndexStatus() {
    const present = await hasPyOCDPackIndex();
    this.post({ command: 'index-status', present: present ?? null });
  }

  private async sendTargets(filter?: { name?: string; vendor?: string; source?: string }) {
    try {
      let targets = await getPyOCDTargetsJson();
      const name = filter?.name?.trim().toLowerCase();
      const vendor = filter?.vendor?.trim().toLowerCase();
      const source = filter?.source?.trim().toLowerCase();
      if (name) {
        targets = targets.filter(t =>
          t.name.toLowerCase().includes(name) || (t.partNumber ?? '').toLowerCase().includes(name));
      }
      if (vendor) {
        targets = targets.filter(t => (t.vendor ?? '').toLowerCase().includes(vendor));
      }
      if (source && source !== 'all') {
        targets = targets.filter(t => (t.source ?? '').toLowerCase() === source);
      }
      // The full filtered list is sent; the webview paginates it locally.
      this.post({
        command: 'targets-result',
        targets,
        total: targets.length,
      });
    } catch (e) {
      this.post({ command: 'targets-result', targets: [], total: 0, error: e instanceof Error ? e.message : `${e}` });
    }
  }

  private async refreshAfterPackChange() {
    await Promise.all([this.sendInstalledPacks(), this.sendTargets(), this.sendIndexStatus()]);
    await this.sendBoardTargetInfo();
  }

  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
      async (message: any) => {
        switch (message.command) {
          case 'webview-ready':
            this.refreshAll();
            break;
          case 'refresh-version':
            await this.sendVersionInfo();
            break;
          case 'refresh-packs':
            await this.sendInstalledPacks();
            break;
          case 'update-pack-index':
            if (await this.runPyOCDOp('update-index', 'updating CMSIS-Pack index', async (opts) => {
              await updatePyOCDPack(opts);
            })) {
              await this.refreshAfterPackChange();
            }
            break;
          case 'clean-packs': {
            const confirmItem = 'Delete all packs';
            const choice = await vscode.window.showWarningMessage(
              'Delete the pyOCD pack index and every installed CMSIS-Pack? Pack-provided targets will disappear until their packs are reinstalled.',
              { modal: true }, confirmItem);
            if (choice === confirmItem) {
              if (await this.runPyOCDOp('clean-packs', 'deleting pack index and installed packs', async (opts) => {
                await cleanPyOCDPacks(opts);
              })) {
                await this.refreshAfterPackChange();
              }
            }
            break;
          }
          case 'find-packs': {
            const pattern = `${message.pattern ?? ''}`.trim();
            if (!pattern) {
              break;
            }
            await this.runPyOCDOp('find-packs', `searching packs for '${pattern}'`, async (opts) => {
              const packs = await findPyOCDPacks(pattern, opts);
              this.post({ command: 'find-packs-result', packs });
            });
            break;
          }
          case 'install-pack': {
            const pattern = `${message.pattern ?? ''}`.trim();
            if (!pattern) {
              break;
            }
            if (await this.runPyOCDOp('install-pack', `installing pack for '${pattern}'`, async (opts) => {
              await installPyOCDTarget(pattern, opts);
            })) {
              await this.refreshAfterPackChange();
            }
            break;
          }
          case 'install-board-target': {
            if (!this.project || !this.buildConfig) {
              break;
            }
            // Serialize with the other pack operations. setupPyOCDTarget owns
            // its own cancellable progress notification, so the panel's Cancel
            // button is hidden for this op (cancellable: false).
            if (this._activeOp) {
              vscode.window.showWarningMessage(`pyOCD: '${this._activeOp.name}' is still running, wait for it to finish or cancel it.`);
              break;
            }
            const cts = new vscode.CancellationTokenSource();
            this._activeOp = { name: 'board-target', cts };
            this.post({ command: 'op-started', op: 'board-target', label: 'installing target support (cancel from the notification)', cancellable: false });
            let ok = false;
            try {
              ok = await setupPyOCDTarget(this.project, this.buildConfig.name);
            } finally {
              this._activeOp = undefined;
              cts.dispose();
              this.post({ command: 'op-finished', op: 'board-target', success: ok });
            }
            await this.refreshAfterPackChange();
            break;
          }
          case 'load-targets':
            await this.sendTargets({ name: message.name, vendor: message.vendor, source: message.source });
            break;
          case 'open-output':
            getPyOCDOutputChannel().show();
            break;
          case 'install-runners':
            vscode.commands.executeCommand('zephyr-workbench.install-runners');
            break;
          case 'cancel':
            this._activeOp?.cts.cancel();
            break;
        }
      },
      undefined,
      this._disposables
    );
  }

  private _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
    const webviewUri = getUri(webview, extensionUri, ["out", "pyocdmanager.js"]);
    const styleUri = getUri(webview, extensionUri, ["out", "style.css"]);
    const codiconUri = getUri(webview, extensionUri, ["out", "codicon.css"]);
    const nonce = getNonce();

    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
          <link nonce="${nonce}" rel="stylesheet" href="${styleUri}">
          <link nonce="${nonce}" rel="stylesheet" href="${codiconUri}">
          <title>pyOCD Manager</title>
        </head>

        <body>
          <h1>pyOCD Manager</h1>
          <a class="help-link" href="https://pyocd.io/docs/target_support.html">Read Docs</a>

          <form id="version-section">
            <h2>pyOCD</h2>
            <div class="pyocd-row">
              <span id="pyocd-version-text">Checking pyOCD version...</span>
              <vscode-button appearance="icon" id="refresh-version-btn" title="Re-check pyOCD version">
                <span class="codicon codicon-refresh"></span>
              </vscode-button>
              <vscode-button appearance="secondary" id="open-output-btn">Open Output Log</vscode-button>
            </div>
            <div id="pyocd-version-warning" class="pyocd-warning hidden"></div>
            <div id="pyocd-missing" class="pyocd-warning hidden">
              pyOCD was not found in the Zephyr Workbench environment. Install it from the Install Runners panel.
              <vscode-button id="open-install-runners-btn" appearance="primary">Open Install Runners</vscode-button>
            </div>
          </form>

          <form id="board-section" class="hidden">
            <h2>Current build</h2>
            <div class="pyocd-row">
              <span>Project: <b id="board-project"></b></span>
              <span>Configuration: <b id="board-config"></b></span>
            </div>
            <div id="board-target-known">
              <div class="pyocd-row">
                <span>Required target: <code id="board-target"></code></span>
                <span id="board-target-status"></span>
              </div>
              <div id="board-packs" class="pyocd-note hidden"></div>
              <vscode-button id="install-board-target-btn" appearance="primary" class="hidden">Install target support</vscode-button>
            </div>
            <div id="board-target-unknown" class="pyocd-note hidden">
              No pyOCD <code>--target=</code> found for this build. Build the configuration first, or the board does not define pyOCD runner args.
            </div>
          </form>

          <form id="packs-section">
            <h2>CMSIS-Packs</h2>
            <div id="index-warning" class="pyocd-warning hidden">
              The CMSIS-Pack index has not been downloaded yet. Click "Update index" to fetch it: it is required for pack search and automatic target installs.
            </div>
            <div class="pyocd-row">
              <h3 class="pyocd-inline-title">Installed packs</h3>
              <vscode-button appearance="icon" id="refresh-packs-btn" title="Refresh installed packs">
                <span class="codicon codicon-refresh"></span>
              </vscode-button>
              <vscode-button appearance="secondary" id="update-index-btn">Update index</vscode-button>
              <vscode-button appearance="secondary" id="clean-packs-btn">Clean all packs</vscode-button>
            </div>
            <table class="debug-tools-table pyocd-table" id="installed-packs-table">
              <tr><th>Pack</th><th>Version</th></tr>
            </table>
            <h3>Find packs</h3>
            <div class="pyocd-row">
              <vscode-text-field id="find-input" placeholder="MCU part number, e.g. stm32l4 or efr32mg24" size="30"></vscode-text-field>
              <vscode-button id="find-btn">Search</vscode-button>
            </div>
            <table class="debug-tools-table pyocd-table hidden" id="find-results-table">
              <tr><th>Part</th><th>Vendor</th><th>Pack</th><th>Version</th><th></th></tr>
            </table>
            <div id="find-results-empty" class="pyocd-note hidden">No matching device found in the pack index. If the index is empty or outdated, click "Update index" and search again.</div>
          </form>

          <form id="targets-section">
            <h2 class="pyocd-collapsible-header" id="targets-header" title="Show/hide the target list">
              <span class="codicon codicon-chevron-right" id="targets-chevron"></span>
              Target support
            </h2>
            <div id="targets-body" class="hidden">
              <div class="pyocd-row">
                <vscode-text-field id="target-filter-name" placeholder="Filter by name/part" size="20"></vscode-text-field>
                <vscode-text-field id="target-filter-vendor" placeholder="Vendor" size="14"></vscode-text-field>
                <vscode-dropdown id="target-filter-source">
                  <vscode-option value="all">All sources</vscode-option>
                  <vscode-option value="builtin">builtin</vscode-option>
                  <vscode-option value="pack">pack</vscode-option>
                </vscode-dropdown>
              </div>
              <div id="targets-count" class="pyocd-note"></div>
              <table class="debug-tools-table pyocd-table" id="targets-table">
                <tr><th>Name</th><th>Vendor</th><th>Part number</th><th>Source</th></tr>
              </table>
              <div class="pyocd-row hidden" id="targets-pagination">
                <vscode-button appearance="icon" id="targets-prev-btn" title="Previous page">
                  <span class="codicon codicon-chevron-left"></span>
                </vscode-button>
                <span id="targets-page-info" class="pyocd-note"></span>
                <vscode-button appearance="icon" id="targets-next-btn" title="Next page">
                  <span class="codicon codicon-chevron-right"></span>
                </vscode-button>
              </div>
            </div>
          </form>

          <form id="activity-section">
            <h2>Activity</h2>
            <div id="activity-idle" class="pyocd-note">Idle</div>
            <div id="activity-run" class="hidden">
              <div class="pyocd-row">
                <span id="activity-label"></span>
                <vscode-button appearance="secondary" id="cancel-btn">Cancel</vscode-button>
              </div>
              <div class="pyocd-progress-track"><div class="pyocd-progress-fill" id="activity-fill"></div></div>
              <div id="activity-detail" class="pyocd-note"></div>
            </div>
            <div id="activity-last" class="pyocd-note hidden"></div>
          </form>

          <script type="module" nonce="${nonce}" src="${webviewUri}"></script>
        </body>
      </html>
    `;
  }
}
