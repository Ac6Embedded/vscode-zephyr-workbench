import * as vscode from "vscode";
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";
import {
  fetchHostToolsCheckedVersions,
  probeHostToolsPartsPresence,
  probePythonInterpreter,
  readHostToolsTargetVersions,
} from "../utils/hostToolsStatusUtils";
import { getZinstallerVersionStampPath, HostToolsPythonOptions, sanitizeRequirementsRef } from "../utils/installUtils";
import { getGitBranches, getGitTags } from "../utils/execUtils";
import { fileExists } from "../utils/utils";
import { getZephyrTerminal } from "../utils/zephyr/zephyrTerminalUtils";

/** Upstream repo whose tags/branches provide the venv requirements versions. */
const ZEPHYR_REPO_URL = 'https://github.com/zephyrproject-rtos/zephyr';

/**
 * Advanced host-tools installation view.
 *
 * Lets the user install or repair individual parts of the host tools
 * (unchecked parts are skipped by the installer) and choose the Python
 * source: Zinstaller portable (downloaded), system (detected from PATH) or a
 * custom interpreter. Python is always required because the global venv needs
 * an interpreter, so it is a mandatory source selector instead of a checklist
 * row. The base tools (yq, wget, 7-Zip) and the environment files are always
 * processed by any run.
 */

interface AdvancedPart {
  id: string;
  label: string;
  /** Key in the -OnlyCheck version map (detected version). */
  versionKey?: string;
  /** Key in tools.yml (target version that would be installed). */
  targetKey?: string;
}

/**
 * Checklist rows: only the skippable tools. python (mandatory source
 * selector) and the global venv (always installed with every bulk run) are
 * intentionally NOT listed as options.
 */
const ADVANCED_PARTS: AdvancedPart[] = [
  { id: 'cmake', label: 'CMake', versionKey: 'cmake', targetKey: 'cmake' },
  { id: 'ninja', label: 'Ninja', versionKey: 'ninja', targetKey: 'ninja' },
  { id: 'gperf', label: 'gperf', versionKey: 'gperf', targetKey: 'gperf' },
  { id: 'dtc', label: 'Device Tree Compiler', versionKey: 'dtc', targetKey: 'dtc' },
  { id: 'git', label: 'Git', versionKey: 'git', targetKey: 'git' },
  { id: 'wget', label: 'wget', versionKey: 'wget', targetKey: 'wget' },
];

interface PythonSelection {
  mode?: string;
  path?: string;
  requirementsRef?: string;
}

export class AdvancedHostToolsPanel {
  public static currentPanel: AdvancedHostToolsPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private installRunning = false;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  public static render(extensionUri: vscode.Uri) {
    if (AdvancedHostToolsPanel.currentPanel) {
      AdvancedHostToolsPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "zephyr-workbench.advanced-host-tools.panel",
      "Advanced Host Tools Installation",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out")],
      }
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, "res", "icons", "light", "symbol-property-light.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "res", "icons", "dark", "symbol-property-dark.svg"),
    };

    AdvancedHostToolsPanel.currentPanel = new AdvancedHostToolsPanel(panel, extensionUri);
    AdvancedHostToolsPanel.currentPanel.createContent();
  }

  public createContent() {
    this._panel.webview.html = this._getWebviewContent(this._panel.webview, this._extensionUri);
    this._setWebviewMessageListener(this._panel.webview);

    // Re-probe statuses when the panel becomes visible again, unless an
    // install is currently running (its completion refreshes anyway).
    this._panel.onDidChangeViewState(async () => {
      if (this._panel.visible && !this.installRunning) {
        await this.refreshStatus();
      }
    }, null, this._disposables);
  }

  public dispose() {
    AdvancedHostToolsPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) { d.dispose(); }
    }
  }

  private post(message: any): void {
    try { this._panel.webview.postMessage(message); } catch { }
  }

  /**
   * Probe the part artifacts (zinstaller-truthful presence) and the
   * -OnlyCheck versions, then publish the combined status to the webview.
   * Public so the install commands can refresh an open panel.
   */
  public async refreshStatus(): Promise<void> {
    if (this.installRunning) { return; }
    this.post({ command: 'toggle-spinner', show: true });
    try {
      const presence = probeHostToolsPartsPresence();
      const versions = await fetchHostToolsCheckedVersions(this._extensionUri);
      // "Other actions" (full reinstall, venv rebuild) only make sense once
      // something is installed.
      const anyInstalled = Object.values(presence).some(v => v === true)
        || fileExists(getZinstallerVersionStampPath());
      this.post({
        command: 'status-updated',
        parts: this.buildPartsStatus(presence, versions),
        anyInstalled,
        venvPresent: presence['venv'] === true,
        pythonPortablePresent: presence['python'] === true,
        pythonPortableVersion: this.displayVersion(versions['python']),
      });
    } finally {
      this.post({ command: 'toggle-spinner', show: false });
    }
  }

  private displayVersion(raw: string | undefined): string {
    if (!raw) { return ''; }
    if (raw.toUpperCase() === 'NOT INSTALLED') { return ''; }
    return raw;
  }

  private buildPartsStatus(presence: Record<string, boolean>, versions: Record<string, string>) {
    return ADVANCED_PARTS.map(p => {
      const present = presence[p.id] === true;
      // The -OnlyCheck run resolves the zinstaller copy first (env sourced);
      // when the artifact is absent it falls back to a system-wide tool, so
      // the detected version then describes what the SYSTEM provides.
      const detectedVersion = p.versionKey ? this.displayVersion(versions[p.versionKey]) : '';
      const systemDetected = !present && detectedVersion.length > 0;
      return { part: p.id, label: p.label, present, detectedVersion, systemDetected };
    });
  }

  private buildPythonOpts(python: PythonSelection | undefined): HostToolsPythonOptions | undefined {
    const mode = String(python?.mode ?? 'portable');
    const requirementsRef = sanitizeRequirementsRef(python?.requirementsRef);
    const opts: HostToolsPythonOptions = {};
    if (requirementsRef.length > 0) {
      opts.requirementsRef = requirementsRef;
    }
    if (mode === 'system') {
      opts.useSystemPython = true;
      return opts;
    }
    if (mode === 'custom') {
      const p = String(python?.path ?? '').trim();
      if (p.length === 0) {
        // Invalid custom selection: callers treat undefined as "refuse to run".
        return undefined;
      }
      opts.pythonExePath = p;
      return opts;
    }
    return Object.keys(opts).length > 0 ? opts : undefined;
  }

  /**
   * Augment the user's tool selection with the always-installed parts:
   * - 'venv' on bulk runs (the global venv is never an option; skipping every
   *   tool still installs it). Per-part repairs skip it so a single-tool fix
   *   stays fast; the Rebuild button covers explicit venv rebuilds.
   * - 'python' always for the system/custom sources (the python step is a
   *   cheap probe there) and for the portable source when the portable
   *   python is not installed yet. A present portable python is NOT
   *   re-selected, so runs do not re-download WinPython; the venv step's
   *   presence probe covers the dependency.
   */
  private computeSelection(parts: string[], mode: string, includeVenv: boolean): string[] {
    const selection = parts.filter(p => ADVANCED_PARTS.some(ap => ap.id === p));
    if (includeVenv) {
      selection.push('venv');
    }
    const portablePresent = probeHostToolsPartsPresence()['python'] === true;
    const needPython = mode !== 'portable' || !portablePresent;
    if (needPython) {
      selection.push('python');
    }
    return selection;
  }

  private async runSelectCommand(selection: string[], pythonOpts: HostToolsPythonOptions | undefined): Promise<boolean> {
    const ok = await vscode.commands.executeCommand<boolean>(
      'zephyr-workbench.install-host-tools.select', selection, pythonOpts);
    return ok === true;
  }

  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
      async (message: any) => {
        const command = message.command;
        switch (command) {
          case 'webview-ready':
          case 'refresh-status': {
            await this.refreshStatus();
            break;
          }
          case 'probe-python': {
            const mode = message.mode === 'custom' ? 'custom' : 'system';
            const result = await probePythonInterpreter(mode, message.path);
            this.post({ command: 'python-probe-result', mode, ...result });
            break;
          }
          case 'fetch-requirements-refs': {
            await this.handleFetchRequirementsRefs();
            break;
          }
          case 'browse-python-path': {
            const pick = await vscode.window.showOpenDialog({
              canSelectFiles: true,
              canSelectFolders: false,
              canSelectMany: false,
              title: 'Select the Python executable',
              filters: process.platform === 'win32' ? { 'Python executable': ['exe'] } : undefined,
            });
            if (pick && pick[0]) {
              this.post({ command: 'python-path-selected', path: pick[0].fsPath });
            }
            break;
          }
          case 'install-selected': {
            await this.handleInstallSelected(message);
            break;
          }
          case 'install-part': {
            await this.handleInstallPart(message);
            break;
          }
          case 'reinstall-all': {
            await this.handleReinstallAll(message);
            break;
          }
          case 'rebuild-venv': {
            await this.handleRebuildVenv(message);
            break;
          }
          case 'open-terminal': {
            try { (await getZephyrTerminal()).show(); } catch { }
            break;
          }
        }
      },
      undefined,
      this._disposables
    );
  }

  /**
   * List the zephyr repo tags and branches (same mechanism as the Create West
   * Workspace revision picker) and publish them as a prebuilt dropdown.
   * Default: the newest version tag ("latest"), falling back to main.
   */
  private async handleFetchRequirementsRefs(): Promise<void> {
    try {
      const [tags, branches] = await Promise.all([
        getGitTags(ZEPHYR_REPO_URL),
        getGitBranches(ZEPHYR_REPO_URL),
      ]);
      let refsHTML = '';
      if (tags && tags.length > 0) {
        refsHTML += '<div class="dropdown-header">TAGS</div>';
        for (const tag of tags) {
          refsHTML += `<div class="dropdown-item" data-value="${tag}" data-label="${tag}">${tag}</div>`;
        }
      }
      if (branches && branches.length > 0) {
        refsHTML += '<div class="dropdown-header">BRANCHES</div>';
        for (const branch of branches) {
          refsHTML += `<div class="dropdown-item" data-value="${branch}" data-label="${branch}">${branch}</div>`;
        }
      }
      // Default to main: the everything-latest requirements. Releases are in
      // the list for users who want to pin a version.
      this.post({ command: 'requirements-refs-updated', refsHTML, defaultRef: 'main' });
    } catch {
      this.post({
        command: 'requirements-refs-updated',
        refsHTML: '<div class="dropdown-header">Could not fetch Zephyr versions (offline?). Type a ref manually.</div>',
        defaultRef: 'main',
      });
    }
  }

  private async handleInstallSelected(message: any): Promise<void> {
    if (this.installRunning) { return; }
    const rawParts: string[] = Array.isArray(message.parts) ? message.parts.map((p: any) => String(p)) : [];
    const python: PythonSelection = message.python ?? {};
    const mode = String(python.mode ?? 'portable');
    const pythonOpts = this.buildPythonOpts(python);
    if (mode === 'custom' && !pythonOpts) {
      this.post({ command: 'install-finished', ok: false, kind: 'selected', message: 'Provide a valid custom Python path first' });
      return;
    }

    // Bulk runs always install the global venv (it is never an option).
    const selection = this.computeSelection(rawParts, mode, true);

    this.installRunning = true;
    this.post({ command: 'toggle-spinner', show: true });
    try {
      const ok = await this.runSelectCommand(selection, pythonOpts);
      // Result detail comes from re-probing the artifacts, never from parsing
      // the installer output (the terminal summary is the detailed report).
      const after = probeHostToolsPartsPresence();
      const artifactParts = [...rawParts, 'venv'].filter(p => p in after);
      const installed = artifactParts.filter(p => after[p] === true);
      const failed = artifactParts.filter(p => after[p] !== true);
      this.post({ command: 'install-finished', ok, kind: 'selected', installed, failed });
    } catch {
      this.post({ command: 'install-finished', ok: false, kind: 'selected' });
    } finally {
      this.installRunning = false;
      this.post({ command: 'toggle-spinner', show: false });
      await this.refreshStatus();
    }
  }

  private async handleInstallPart(message: any): Promise<void> {
    if (this.installRunning) {
      this.post({ command: 'install-part-finished', part: String(message.part ?? ''), ok: false });
      return;
    }
    const part = String(message.part ?? '');
    const python: PythonSelection = message.python ?? {};
    const mode = String(python.mode ?? 'portable');
    const pythonOpts = this.buildPythonOpts(python);
    if (!ADVANCED_PARTS.some(p => p.id === part) || (mode === 'custom' && !pythonOpts)) {
      this.post({ command: 'install-part-finished', part, ok: false });
      return;
    }

    this.installRunning = true;
    try {
      const selection = this.computeSelection([part], mode, false);
      const ok = await this.runSelectCommand(selection, pythonOpts);
      const after = probeHostToolsPartsPresence();
      const partOk = ok && after[part] === true;
      this.post({ command: 'install-part-finished', part, ok: partOk });
    } catch {
      this.post({ command: 'install-part-finished', part, ok: false });
    } finally {
      this.installRunning = false;
      await this.refreshStatus();
    }
  }

  private async handleReinstallAll(message: any): Promise<void> {
    if (this.installRunning) { return; }
    const python: PythonSelection = message.python ?? {};
    const mode = String(python.mode ?? 'portable');
    const pythonOpts = this.buildPythonOpts(python);
    if (mode === 'custom' && !pythonOpts) {
      this.post({ command: 'install-finished', ok: false, kind: 'reinstall-all', message: 'Provide a valid custom Python path first' });
      return;
    }

    this.installRunning = true;
    this.post({ command: 'toggle-spinner', show: true });
    try {
      // The webview already confirmed via its in-view overlay. This is the
      // normal full-install flow (including the OpenOCD runner follow-up).
      await vscode.commands.executeCommand('zephyr-workbench.install-host-tools', true, "", pythonOpts);
      // The command does not relay a boolean; the completion stamp is only
      // written by a fully successful install, so it is the success signal.
      const ok = fileExists(getZinstallerVersionStampPath());
      this.post({ command: 'install-finished', ok, kind: 'reinstall-all' });
    } catch {
      this.post({ command: 'install-finished', ok: false, kind: 'reinstall-all' });
    } finally {
      this.installRunning = false;
      this.post({ command: 'toggle-spinner', show: false });
      await this.refreshStatus();
    }
  }

  private async handleRebuildVenv(message: any): Promise<void> {
    if (this.installRunning) { return; }
    const requirementsRef = sanitizeRequirementsRef(message?.python?.requirementsRef);
    this.installRunning = true;
    this.post({ command: 'toggle-spinner', show: true });
    try {
      await vscode.commands.executeCommand('zephyr-workbench.reinstall-venv', true, requirementsRef);
      const after = probeHostToolsPartsPresence();
      this.post({ command: 'venv-rebuild-finished', ok: after['venv'] === true });
    } catch {
      this.post({ command: 'venv-rebuild-finished', ok: false });
    } finally {
      this.installRunning = false;
      this.post({ command: 'toggle-spinner', show: false });
      await this.refreshStatus();
    }
  }

  private getPartsRowsHTML(targetVersions: Record<string, string>): string {
    let html = "";
    for (const p of ADVANCED_PARTS) {
      // Target version is static per session (tools.yml ships with the
      // extension), so it is rendered directly into the row.
      const target = p.targetKey ? (targetVersions[p.targetKey] ?? '') : '';
      html += `<tr id="row-${p.id}">
        <td><input type="checkbox" class="part-checkbox" id="check-${p.id}" data-part="${p.id}"></td>
        <td id="name-${p.id}">${p.label}</td>
        <td id="status-${p.id}"></td>
        <td id="detected-${p.id}"></td>
        <td id="available-${p.id}">${target || '-'}</td>
        <td class="part-action-cell">
          <vscode-button appearance="secondary" class="install-part-button" data-part="${p.id}">Install</vscode-button>
          <div class="progress-wheel" id="progress-${p.id}"><vscode-progress-ring></vscode-progress-ring></div>
        </td>
      </tr>`;
    }
    return html;
  }

  private _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const webviewUri = getUri(webview, extensionUri, ["out", "advancedhosttools.js"]);
    const styleUri = getUri(webview, extensionUri, ["out", "style.css"]);
    const codiconUri = getUri(webview, extensionUri, ["out", "codicon.css"]);
    const nonce = getNonce();
    const targetVersions = readHostToolsTargetVersions(extensionUri);
    const portablePythonTarget = targetVersions['python_portable'] ?? '';
    const portableLabel = portablePythonTarget
      ? `Zinstaller (portable Python ${portablePythonTarget}, downloaded automatically)`
      : 'Zinstaller (portable Python, downloaded automatically)';

    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
          <link nonce="${nonce}" rel="stylesheet" href="${styleUri}">
          <link nonce="${nonce}" rel="stylesheet" href="${codiconUri}">
          <title>Advanced Host Tools Installation</title>
        </head>
        <body>
          <h1>Advanced Host Tools Installation</h1>
          <p class="panel-lead">Install or repair individual parts of the Zephyr host tools. Unchecked tools are skipped. Python and the global virtual environment are always installed; the base tools (yq, 7-Zip) are fetched automatically when a download is needed, and the environment files are always refreshed. Downloads use PowerShell by default; an installed wget is preferred when available. If a download fails or its checksum mismatches, it is automatically retried from the Ac6 mirror.</p>

          <form>
            <h2>Python and virtual environment
              <span id="python-spinner" class="codicon codicon-loading codicon-modifier-spin hidden" title="Probing python"></span>
            </h2>
            <p class="panel-note">Always installed, even when every tool is skipped: the selected Python is used by the tools and to create the global virtual environment.</p>
            <div id="python-source">
              <label class="set-default-radio">
                <input type="radio" class="set-default-radio-input python-source-radio" name="python-source" data-mode="portable" checked>
                <span>${portableLabel}</span>
              </label>
              <label class="set-default-radio">
                <input type="radio" class="set-default-radio-input python-source-radio" name="python-source" data-mode="system">
                <span>System (detected from PATH)</span>
              </label>
              <label class="set-default-radio">
                <input type="radio" class="set-default-radio-input python-source-radio" name="python-source" data-mode="custom">
                <span>Custom</span>
              </label>
            </div>
            <div class="grid-group-div hidden" id="custom-python-row">
              <vscode-text-field id="custom-python-path" size="50" placeholder="Path to python.exe or its folder">Python path:</vscode-text-field>
              <vscode-button id="browse-python-button" appearance="secondary">
                <span class="codicon codicon-folder"></span>
              </vscode-button>
            </div>
            <div id="python-detection" class="python-detection"></div>
            <div id="venv-status" class="python-detection"></div>
            <div class="grid-group-div" id="requirements-ref-group">
              <label for="requirementsRefInput" class="requirements-label">Zephyr requirements version:</label>
              <div id="requirementsCombo" class="combo-dropdown">
                <div class="combo-dropdown-input">
                  <input type="text" id="requirementsRefInput" class="combo-dropdown-control" placeholder="Loading Zephyr versions..." data-value="">
                  <div aria-hidden="true" class="indicator" part="indicator">
                    <slot name="indicator">
                      <svg class="select-indicator" part="select-indicator" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                        <path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"></path>
                      </svg>
                    </slot>
                  </div>
                </div>
                <div class="combo-dropdown-controls">
                  <button id="requirementsRefreshButton" class="inline-icon-button codicon codicon-refresh" title="Refresh Zephyr versions" aria-label="Refresh Zephyr versions" type="button"></button>
                </div>
                <div id="requirementsRefDropdown" class="dropdown-content"></div>
              </div>
            </div>
            <p class="panel-note">The virtual environment installs the pip requirements of this Zephyr version (tags and branches fetched from GitHub; latest release selected by default).</p>
          </form>

          <form>
            <h2>Tools
              <span id="aht-spinner" class="codicon codicon-loading codicon-modifier-spin hidden" title="Checking status"></span>
              <button id="btn-refresh-status" type="button" class="inline-icon-button codicon codicon-refresh" title="Refresh status" aria-label="Refresh status"></button>
            </h2>
            <table class="debug-tools-table advanced-host-tools-table">
              <tr>
                <th></th>
                <th>Name</th>
                <th>Status</th>
                <th>Detected</th>
                <th>Available</th>
                <th></th>
              </tr>
              ${this.getPartsRowsHTML(targetVersions)}
            </table>
            <div class="grid-group-div aht-actions">
              <vscode-button id="btn-select-missing" appearance="secondary">Select missing</vscode-button>
              <vscode-button id="btn-select-all" appearance="secondary">Select all</vscode-button>
              <vscode-button id="btn-unselect-all" appearance="secondary">Unselect all</vscode-button>
              <vscode-button id="btn-install-selected" appearance="primary">Install selected</vscode-button>
            </div>
            <div id="result-line" class="result-line hidden">
              <span id="result-text"></span>
              <a id="open-terminal-link" href="#">Open terminal output</a>
            </div>
          </form>

          <form id="other-actions-section" class="hidden">
            <h2>Other actions</h2>
            <div class="grid-group-div aht-actions">
              <vscode-button id="btn-reinstall-all" appearance="secondary">Reinstall everything</vscode-button>
              <vscode-button id="btn-rebuild-venv" appearance="secondary">Rebuild virtual environment</vscode-button>
            </div>
          </form>

          <div id="confirm-overlay" class="confirm-overlay hidden" role="presentation">
            <div class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-message">
              <div id="confirm-message" class="confirm-message">This removes the installed host tools, the global virtual environment and reinstalls everything with the selected Python source. Continue?</div>
              <div class="confirm-actions">
                <vscode-button id="confirm-cancel" appearance="secondary">Cancel</vscode-button>
                <vscode-button id="confirm-ok" appearance="primary">Reinstall</vscode-button>
              </div>
            </div>
          </div>
          <script type="module" nonce="${nonce}" src="${webviewUri}"></script>
        </body>
      </html>`;
  }
}
