import * as vscode from "vscode";
import path from "path";
import { getNonce } from "../utilities/getNonce";
import { getUri } from "../utilities/getUri";
import { execCommandWithEnv } from "../utils/execUtils";

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
  private _disposables: vscode.Disposable[] = [];
  private _didInitialProbe = false;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  public static render(extensionUri: vscode.Uri) {
    if (EclairManagerPanel.currentPanel) {
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

    EclairManagerPanel.currentPanel = new EclairManagerPanel(panel, extensionUri);
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
        case "check-license":
          vscode.env.openExternal(vscode.Uri.parse("https://www.bugseng.com/eclair-request-trial/"));
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
        case "generate-command": {
          const cfg: IEclairConfig = m.data || {};
          const cmd = this.buildCmd(cfg);
          webview.postMessage({ command: "show-command", cmd });
          break;
        }
        case "run-command": {
          const cfg: IEclairConfig = m.data || {};
          const cmd = this.buildCmd(cfg);
          const term = vscode.window.createTerminal("Eclair");
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
    let bin = "eclair";
    if (cfg.installPath) {
      const resolved = cfg.installPath.trim();
      if (resolved) {
        const candidate = path.join(resolved, "eclair");
        bin = process.platform === "win32" ? candidate + ".exe" : candidate;
      }
    }
    parts.push(`"${bin}"`);

    if (cfg.ruleset === "USER") {
      const name = (cfg.userRulesetName || "").trim();
      const p = (cfg.userRulesetPath || "").trim();
      if (p) parts.push(`--ruleset "${p}"`);
      if (name) parts.push(`--user-ruleset-name "${name}"`);
    } else if (cfg.ruleset) {
      parts.push(`--ruleset ${cfg.ruleset}`);
    }

    const reports = cfg.reports || [];
    if (reports.includes("ALL")) {
      parts.push(`--reports ALL`);
    } else if (reports.length > 0) {
      parts.push(`--reports ${reports.join(",")}`);
    }

    if (cfg.extraConfig) {
      parts.push(`--config "${cfg.extraConfig.trim()}"`);
    }

    return parts.join(" ");
  }

  private async runEclair() {
    this._panel.webview.postMessage({ command: "toggle-spinner", show: true });
    this._panel.webview.postMessage({ command: "set-install-path", path: "checking" });

    let exePath: string | undefined;
    try {
      let cmd = process.platform === "win32"
        ? 'powershell -NoProfile -Command "(Get-Command eclair).Source"'
        : 'which eclair';
      const proc = await execCommandWithEnv(cmd);
      let out = "";
      await new Promise<void>((resolve) => {
        proc.stdout?.on("data", c => out += c.toString());
        proc.stderr?.on("data", c => out += c.toString());
        proc.on("close", () => resolve());
        proc.on("error", () => resolve());
      });
      const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      exePath = lines[0];
    } catch {
      exePath = undefined;
    }

    let version: string | undefined;
    try {
      const proc = await execCommandWithEnv("eclair -version");
      let out = "";
      await new Promise<void>((resolve) => {
        proc.stdout?.on("data", c => out += c.toString());
        proc.stderr?.on("data", c => out += c.toString());
        proc.on("close", () => resolve());
        proc.on("error", () => resolve());
      });
      const m1 = out.match(/ECLAIR\s+version\s+([0-9]+(?:\.[0-9]+)*)/i);
      const m2 = out.match(/\b([0-9]+(?:\.[0-9]+)*)\b/);
      version = (m1?.[1] || m2?.[1] || "").trim();
    } catch {
      version = undefined;
    }

    this._panel.webview.postMessage({ command: 'eclair-status', installed: !!version, version: version || '' });
    if (exePath) {
      this._panel.webview.postMessage({ command: 'set-install-path', path: exePath });
    }
    else{
      this._panel.webview.postMessage({ command: 'set-install-path', path: "Path not found" });
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
    <vscode-button id="btn-refresh-status" appearance="primary">Refresh status</vscode-button>
    <vscode-button id="check-license" appearance="primary">Check License</vscode-button>
  </div>
  <div class="grid-group-div">
    <vscode-text-field id="install-path" placeholder="Path to installation (optional)" size="50">PATH:</vscode-text-field>
    <vscode-button id="browse-install" appearance="secondary"><span class="codicon codicon-folder"></span></vscode-button>
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
  <div class="report-group">
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
      ].map(r => `<div class="report-item"><vscode-checkbox class="report-chk" value="${r}" ${r === "ALL" ? "checked" : ""}>${r}</vscode-checkbox></div>`).join("")}
  </div>
</div>

<div class="section">
  <h2>Additional Configuration (.ecl)</h2>
  <div class="grid-group-div">
    <vscode-text-field id="extra-config" placeholder="path/to/config.ecl" size="50">CONFIG:</vscode-text-field>
    <vscode-button id="browse-config" appearance="secondary"><span class="codicon codicon-folder"></span></vscode-button>
  </div>
</div>

<div class="section">
  <h2>Command</h2>
  <div class="grid-group-div">
    <vscode-button id="generate-cmd" appearance="primary">Generate</vscode-button>
    <vscode-button id="run-cmd" appearance="secondary">Run</vscode-button>
  </div>
  <div id="cmd-output" class="details-line"></div>
</div>

<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
