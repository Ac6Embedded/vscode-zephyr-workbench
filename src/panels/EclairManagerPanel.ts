import * as vscode from "vscode";
import path from "path";
import { getNonce } from "../utilities/getNonce";
import { getUri } from "../utilities/getUri";
import { execCommandWithEnv } from "../utils/execUtils";
import { getZephyrTerminal } from "../utils/zephyrTerminalUtils";
import { accessSync } from "fs";
import { getExtraPaths, normalizePath, setExtraPath } from "../utils/envYamlUtils";

interface IEclairConfig {
  installPath?: string;
  ruleset?: string;
  userRulesetName?: string;
  userRulesetPath?: string;
  reports?: string[];
  extraConfig?: string;
}

export class EclairManagerPanel {
  public static currentPanel: EclairManagerPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _workspaceFolder: vscode.WorkspaceFolder | undefined;
  private _settingsRoot: string | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _didInitialProbe = false;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, workspaceFolder?: vscode.WorkspaceFolder, settingsRoot?: string) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._workspaceFolder = workspaceFolder;
    this._settingsRoot = settingsRoot;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  public static render(extensionUri: vscode.Uri, workspaceFolder?: vscode.WorkspaceFolder, settingsRoot?: string) {
    if (EclairManagerPanel.currentPanel) {
      EclairManagerPanel.currentPanel._workspaceFolder = workspaceFolder;
      EclairManagerPanel.currentPanel._settingsRoot = settingsRoot;
      EclairManagerPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "zephyr-workbench.eclair-manager.panel",
      "Eclair Manager",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out")],
      }
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, "res", "icons", "light", "eclair.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "res", "icons", "dark", "eclair.svg"),
    };

    EclairManagerPanel.currentPanel = new EclairManagerPanel(panel, extensionUri, workspaceFolder, settingsRoot);
    EclairManagerPanel.currentPanel.createContent();
  }

  public dispose() {
    EclairManagerPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }

  private toInstallDir(p?: string): string | undefined {
    if (!p) return undefined;
    const trimmed = p.trim();
    if (!trimmed) return undefined;
    if (trimmed.toLowerCase().endsWith("eclair.exe")) {
      const d = path.dirname(trimmed);
      if (d === "." || d === "") return undefined;
      return d;
    }
    return trimmed;
  }

  private saveEclairPathToEnv(installPath?: string) {
    const dir = this.toInstallDir(installPath);
    if (!dir) return;
    const normalized = normalizePath(dir);
    if (!/[\\/]/.test(normalized)) return; // ignore plain executable names
    const current = getExtraPaths("EXTRA_TOOLS").map(normalizePath);
    if (current.includes(normalized)) return;
    setExtraPath("EXTRA_TOOLS", current.length, normalized);
  }

  public async createContent() {
    this._panel.webview.html = await this._getWebviewContent(this._panel.webview, this._extensionUri);
    this._setWebviewMessageListener(this._panel.webview);

    this._panel.onDidChangeViewState(async () => {
      if (this._panel.visible) {
        try {
          this._panel.webview.postMessage({ command: "toggle-spinner", show: true });
          await this.runEclair();
        } finally {
          this._panel.webview.postMessage({ command: "toggle-spinner", show: false });
        }
      }
    }, null, this._disposables);

    if (!this._didInitialProbe) {
      this._didInitialProbe = true;
      try {
        this._panel.webview.postMessage({ command: "toggle-spinner", show: true });
        await this.runEclair();
      } finally {
        this._panel.webview.postMessage({ command: "toggle-spinner", show: false });
      }
    }
  }

  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(async (m: any) => {
      switch (m.command) {
        case "request-trial":
          vscode.env.openExternal(vscode.Uri.parse("https://www.bugseng.com/eclair-request-trial/"));
          break;
        case "about-eclair":
          vscode.env.openExternal(vscode.Uri.parse("https://www.bugseng.com/eclair-static-analysis-tool/"));
          break;
        case "refresh-status": {
          try {
            this._panel.webview.postMessage({ command: "toggle-spinner", show: true });
            await this.runEclair();
          } finally {
            this._panel.webview.postMessage({ command: "toggle-spinner", show: false });
          }
          break;
        }
        case "browse-install-path": {
          const pick = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: "Select Eclair installation"
          });
          if (pick && pick[0]) {
            webview.postMessage({ command: "set-install-path", path: pick[0].fsPath });
          }
          break;
        }
        case "browse-extra-config": {
          const pick = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { "Eclair Config": ["ecl"] },
            title: "Select .ecl file"
          });
          if (pick && pick[0]) {
            webview.postMessage({ command: "set-extra-config", path: pick[0].fsPath });
          }
          break;
        }
        case "save-sca-config": {
          const cfg: IEclairConfig = m.data || {};
          await this.saveScaConfig(cfg);
          break;
        }
        case "run-command": {
          const cfg: IEclairConfig = m.data || {};
          await this.saveScaConfig(cfg); 
          const cmd = this.buildCmd(cfg);
          const cwd =
            this._settingsRoot ||
            this._workspaceFolder?.uri.fsPath ||
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

          const term = await getZephyrTerminal();

          if (cwd) {
            term.sendText(`cd "${cwd}"`);
          }
          term.show();
          term.sendText(cmd);
          break;
        }
        case "probe-eclair":
          this.runEclair();
          break;
      }
    }, undefined, this._disposables);
  }

  private buildCmd(cfg: IEclairConfig): string {
    const parts: string[] = [];
    let westCmd = "west";
    if (process.platform === "win32") {
      const westFromInstaller = path.join(
        process.env.USERPROFILE ?? "",
        ".zinstaller",
        ".venv",
        "Scripts",
        "west.exe"
      );
      try {
        accessSync(westFromInstaller);
          westCmd = `& "${westFromInstaller}"`;
      } catch {
          westCmd = "west";
      }
    }

    parts.push(westCmd, "build", "--", "-DZEPHYR_SCA_VARIANT=eclair");

    if (cfg.ruleset === "USER") {
      parts.push("-DECLAIR_RULESET_USER=ON");
      const name = (cfg.userRulesetName || "").trim();
      const p = (cfg.userRulesetPath || "").trim();
      if (name) parts.push(`-DECLAIR_USER_RULESET_NAME=\"${name}\"`);
      if (p)    parts.push(`-DECLAIR_USER_RULESET_PATH=\"${p}\"`);
    } else if (cfg.ruleset) {
      parts.push(`-D${cfg.ruleset}=ON`);
    } else {
      parts.push("-DECLAIR_RULESET_FIRST_ANALYSIS=ON");
    }

    const allReports = [
      "ECLAIR_METRICS_TAB",
      "ECLAIR_REPORTS_TAB",
      "ECLAIR_REPORTS_SARIF",
      "ECLAIR_SUMMARY_TXT",
      "ECLAIR_SUMMARY_DOC",
      "ECLAIR_SUMMARY_ODT",
      "ECLAIR_SUMMARY_HTML",
      "ECLAIR_FULL_TXT",
      "ECLAIR_FULL_DOC",
      "ECLAIR_FULL_ODT",
      "ECLAIR_FULL_HTML",
    ];
    const selected = (cfg.reports || []).includes("ALL")
      ? allReports
      : (cfg.reports || []).filter(r => r !== "ALL");

    for (const r of selected) {
      parts.push(`-D${r}=ON`);
    }

    if (cfg.extraConfig) {
      parts.push(`-DECLAIR_OPTIONS_FILE=\"${cfg.extraConfig.trim()}\"`);
    }

    return parts.join(" ");
  }

  private async saveScaConfig(cfg: IEclairConfig) {
    const folder = this._settingsRoot || this._workspaceFolder?.uri.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) return;

    if (cfg.installPath) {
      this.saveEclairPathToEnv(cfg.installPath);
    }

    const folderUri = vscode.Uri.file(folder);
    const config = vscode.workspace.getConfiguration(undefined, folderUri);
    const existing = config.get<any[]>("zephyr-workbench.build.configurations") ?? [];
    const configs: any[] = Array.isArray(existing) ? [...existing] : [];
    const activeIdx = configs.findIndex(c => c?.active === true || c?.active === "true");
    const idx = activeIdx >= 0 ? activeIdx : 0;
    if (!configs[idx]) {
      configs[idx] = { name: "primary", active: true };
    }

    const reports = cfg.reports && cfg.reports.length > 0 ? cfg.reports : ["ALL"];
    
    const scaArray: any = {
      name: "eclair",
      ruleset: cfg.ruleset || "ECLAIR_RULESET_FIRST_ANALYSIS",
      reports,
    };

    configs[idx].sca = [scaArray];

    const target = this._workspaceFolder ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
    await config.update("zephyr-workbench.build.configurations", configs, target);
  }

  private async runEclair() {
    this._panel.webview.postMessage({ command: "toggle-spinner", show: true });
    this._panel.webview.postMessage({ command: "set-path-status", text: "Checking" });
    this._panel.webview.postMessage({ command: "set-install-path-placeholder", text: "Checking" });

    const readStdout = async (proc: any) => {
      let out = "";
      await new Promise<void>((resolve) => {
        proc.stdout?.on("data", (c: Buffer) => out += c.toString());
        proc.on("close", () => resolve());
        proc.on("error", () => resolve());
      });
      return out;
    };

    let exePath: string | undefined;
    try {
      const cmd = process.platform === "win32"
        ? 'powershell -NoProfile -Command "$c=Get-Command eclair -ErrorAction SilentlyContinue; if ($c) { $c.Source }"'
        : 'which eclair';
      const proc = await execCommandWithEnv(cmd);
      const outStd = await readStdout(proc);
      const lines = outStd.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      exePath = lines[0];
    } catch {
      exePath = undefined;
    }

    let version: string | undefined;
    try {
      const proc = await execCommandWithEnv(exePath ? `"${exePath}" -version` : "eclair -version");
      const out = await readStdout(proc);
      const m1 = out.match(/ECLAIR\s+version\s+([0-9]+(?:\.[0-9]+)*)/i);
      const m2 = out.match(/\b([0-9]+(?:\.[0-9]+)*)\b/);
      version = (m1?.[1] || m2?.[1] || "").trim() || undefined;
    } catch {
      version = undefined;
    }

    const installed = !!version;
    
    if (installed && !exePath) {
      try {
        const fallbackCmd = process.platform === "win32"
          ? 'where.exe eclair'
          : 'command -v eclair';
        const proc2 = await execCommandWithEnv(fallbackCmd);
        const out2 = await readStdout(proc2);
        const lines2 = out2.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        exePath = lines2[0] || exePath;
      } catch {
        // ignore
      }
    }

    if (installed && !exePath) {
      exePath = process.platform === "win32" ? "eclair.exe" : "eclair";
    }

    const installDir = exePath ? this.toInstallDir(exePath) : undefined;
    if (installed && installDir) {
      this.saveEclairPathToEnv(installDir);
    }

    // Prefer path from env.yml (EXTRA_TOOLS) if present and exists
    const envPaths = getExtraPaths("EXTRA_TOOLS").map(normalizePath);
    let envEclair = envPaths.find(p => /eclair/i.test(path.basename(p)) || /eclair/i.test(p));
    if (envEclair && !(require('fs').existsSync(envEclair))) {
      // If the path doesn't exist, try to find a valid one in the parent directory
      const parentDir = path.dirname(envEclair);
      const candidate = path.join(parentDir, "bin");
      if (require('fs').existsSync(candidate)) {
        envEclair = candidate;
      } else {
        envEclair = undefined;
      }
    }
    const envCandidate = (envEclair && require('fs').existsSync(envEclair)) ? envEclair : envPaths.find(p => require('fs').existsSync(p));

    const displayPath = envCandidate || installDir || exePath;

    this._panel.webview.postMessage({ command: 'eclair-status', installed, version: installed ? version! : 'unknown' });
    if (displayPath) {
      this._panel.webview.postMessage({ command: 'set-install-path', path: displayPath });
      this._panel.webview.postMessage({ command: 'set-path-status', text: displayPath });
      this._panel.webview.postMessage({ command: 'set-install-path-placeholder', text: displayPath });
    } else {
      this._panel.webview.postMessage({ command: 'set-install-path', path: 'Not found' });
      this._panel.webview.postMessage({ command: 'set-path-status', text: 'Not found' });
      this._panel.webview.postMessage({ command: 'set-install-path-placeholder', text: 'Not found' });
    }
    this._panel.webview.postMessage({ command: "toggle-spinner", show: false });

  }

  private async _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
    const nonce = getNonce();
    const scriptUri = getUri(webview, extensionUri, ["out", "eclairmanager.js"]);
    const styleUri = getUri(webview, extensionUri, ["out", "style.css"]);
    const codiconUri = getUri(webview, extensionUri, ["out", "codicon.css"]);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" nonce="${nonce}" href="${styleUri}">
<link rel="stylesheet" nonce="${nonce}" href="${codiconUri}">
<title>Eclair Manager</title>
</head>
<body>
<h1>Eclair Manager</h1>

<div class="summary">
  <div class="summary-title"><strong>Eclair</strong></div>
  <div>
    <strong>Version:</strong> <span id="eclair-version">Checking</span>
    &nbsp;|&nbsp;
    <strong>Status:</strong> <span id="eclair-status-icon" class="codicon"></span> <span id="eclair-status-text">Checking</span>
    <span id="em-spinner" class="codicon codicon-loading codicon-modifier-spin hidden" title="Detecting Eclair"></span>
  </div>
  <div class="summary-actions">
    <div class="actions-title"><strong>Actions</strong></div>
    <vscode-button id="btn-refresh-status" appearance="primary">Refresh Status</vscode-button>
    <vscode-button id="about-eclair" appearance="primary">About Eclair</vscode-button>
    <vscode-button id="request-trial" appearance="primary">Request Trial License</vscode-button>
  </div>
  <div class="grid-group-div">
    <vscode-text-field id="install-path" placeholder="Path to installation (optional)" size="50" disabled>Path:</vscode-text-field>
  </div>
  
</div>

<div class="section">
  <h2>Rulesets</h2>
  <vscode-radio-group id="ruleset-group" orientation="vertical" value="ECLAIR_RULESET_FIRST_ANALYSIS" class="ruleset-group">
    ${[
        "ECLAIR_RULESET_FIRST_ANALYSIS",
        "ECLAIR_RULESET_STU",
        "ECLAIR_RULESET_STU_HEAVY",
        "ECLAIR_RULESET_WP",
        "ECLAIR_RULESET_STD_LIB",
        "ECLAIR_RULESET_ZEPHYR_GUIDELINES",
        "USER"
      ].map(r => `<vscode-radio id="rs-${r}" name="ruleset" value="${r}">${r === "USER" ? "user defined" : r}</vscode-radio>`).join("")}
  </vscode-radio-group>
  <div id="user-ruleset-fields" class="grid-group-div hidden">
    <vscode-text-field id="user-ruleset-name" placeholder="User ruleset name" size="40">Name:</vscode-text-field>
    <vscode-text-field id="user-ruleset-path" placeholder="Path to ruleset" size="50">Path:</vscode-text-field>
  </div>
</div>

<div class="section">
  <h2>Reports</h2>
  <div class="checkbox-grid">
    ${[
        "ALL",
        "ECLAIR_METRICS_TAB",
        "ECLAIR_REPORTS_TAB",
        "ECLAIR_REPORTS_SARIF",
        "ECLAIR_SUMMARY_TXT",
        "ECLAIR_SUMMARY_DOC",
        "ECLAIR_SUMMARY_ODT",
        "ECLAIR_SUMMARY_HTML",
        "ECLAIR_FULL_TXT",
        "ECLAIR_FULL_DOC",
        "ECLAIR_FULL_ODT",
        "ECLAIR_FULL_HTML"
      ].map(r => `<label><vscode-checkbox class="report-chk" value="${r}" ${r === "ALL" ? "checked" : ""}>${r}</vscode-checkbox></label>`).join("")}
  </div>
</div>

<div class="section">
  <h2>Additional Configuration (.ecl)</h2>
  <div class="grid-group-div">
    <vscode-text-field id="extra-config" placeholder="path/to/config.ecl" size="50" disabled>Path:</vscode-text-field>
    <vscode-button id="browse-config" class="browse-extra-input-button" appearance="secondary" disabled><span class="codicon codicon-folder"></span></vscode-button>
    <vscode-button id="edit-config" class="save-path-button" appearance="primary">Edit</vscode-button>
  </div>
</div>

<div class="section">
  <div class="grid-group-div command-actions">
    <vscode-button id="generate-cmd" appearance="secondary">Apply configuration</vscode-button>
    <vscode-button id="run-cmd" appearance="primary">Run Analysis</vscode-button>
  </div>
</div>

<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
