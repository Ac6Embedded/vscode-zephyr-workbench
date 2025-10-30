import * as vscode from "vscode";
import fs from "fs";
import yaml from "yaml";
import path from "path";
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";
import { getInternalDirRealPath } from "../utils/utils";
import { formatYml } from "../utilities/formatYml";

export class HostToolsPanel {
  public static currentPanel: HostToolsPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

  private envData: any | undefined;
  private envYamlDoc: any | undefined;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Load env.yml
    try {
      const envYamlPath = path.join(getInternalDirRealPath(), "env.yml");
      if (fs.existsSync(envYamlPath)) {
        const text = fs.readFileSync(envYamlPath, "utf8");
        this.envData = yaml.parse(text);
        this.envYamlDoc = yaml.parseDocument(text);
      }
    } catch {
      this.envData = undefined;
      this.envYamlDoc = undefined;
    }
  }

  public async createContent() {
    this._panel.webview.html = await this._getWebviewContent(this._panel.webview, this._extensionUri);
    this._setWebviewMessageListener(this._panel.webview);

    this._panel.onDidChangeViewState(async () => {
      if (this._panel.visible) {
        this._panel.webview.html = await this._getWebviewContent(this._panel.webview, this._extensionUri);
      }
    }, null, this._disposables);
  }

  public static render(extensionUri: vscode.Uri) {
    if (HostToolsPanel.currentPanel) {
      HostToolsPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
    } else {
      const panel = vscode.window.createWebviewPanel(
        "zephyr-workbench.host-tools.panel",
        "Host Tools Manager",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out")],
        }
      );
      panel.iconPath = {
        light: vscode.Uri.joinPath(extensionUri, "res", "icons", "light", "desktop-download.svg"),
        dark: vscode.Uri.joinPath(extensionUri, "res", "icons", "dark", "desktop-download.svg"),
      };

      HostToolsPanel.currentPanel = new HostToolsPanel(panel, extensionUri);
      HostToolsPanel.currentPanel.createContent();
    }
  }

  public dispose() {
    HostToolsPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }

  private getToolVersion(toolId: string): string {
    try {
      const v = (this.envData as any)?.tools?.[toolId]?.version;
      if (v === undefined || v === null) return "";
      return String(v);
    } catch {
      return "";
    }
  }

  private getToolPathDisplay(toolId: string): string {
    try {
      const p = (this.envData as any)?.tools?.[toolId]?.path;
      if (Array.isArray(p)) {
        return p.join(";");
      }
      if (typeof p === "string") return p;
    } catch {}
    return "";
  }

  private getToolAddToPathChecked(toolId: string): boolean {
    try {
      // Checked unless do_not_use === true
      return (this.envData as any)?.tools?.[toolId]?.do_not_use !== true;
    } catch {
      return true;
    }
  }

  private async getToolsHTML(): Promise<string> {
    const tools = (this.envData?.tools && typeof this.envData.tools === "object")
      ? Object.keys(this.envData.tools)
      : [];
    let html = "";
    for (const toolId of tools) {
      const version = this.getToolVersion(toolId);
      const pathDisplay = this.getToolPathDisplay(toolId);
      const addToPathChecked = this.getToolAddToPathChecked(toolId) ? "checked" : "";

      html += `<tr id="row-${toolId}">
        <td><button type="button" class="inline-icon-button expand-button codicon codicon-chevron-right" data-tool="${toolId}" aria-label="Expand/Collapse"></button></td>
        <td id="name-${toolId}">${toolId}</td>
        <td id="version-${toolId}">${version}</td>
        <td></td>
        <td id="buttons-${toolId}"></td>
        <td></td>
      </tr>`;

      const pathHtml = `
        <div class="grid-group-div">
          <vscode-text-field id="details-path-input-${toolId}" class="details-path-field" 
            placeholder="Path(s), separate multiple with ;" value="${pathDisplay}" size="50" disabled>Path:</vscode-text-field>
          <vscode-button id="browse-path-button-${toolId}" class="browse-input-button" appearance="secondary" disabled>
            <span class="codicon codicon-folder"></span>
          </vscode-button>
        </div>`;

      html += `<tr id="details-${toolId}" class="details-row hidden">
        <td></td>
        <td><div id="details-content-${toolId}" class="details-content">${pathHtml}</div></td>
        <td>
          <vscode-button appearance="primary" class="save-path-button" data-tool="${toolId}">Edit</vscode-button>
        </td>
        <td>
          <vscode-checkbox class="add-to-path" data-tool="${toolId}" ${addToPathChecked} disabled/> Add to PATH</vscode-checkbox>
        </td>
        <td></td>
        <td></td>
      </tr>`;
    }
    return html;
  }

  private async getExtraPathTools(): Promise<string> {
    let extraHTML = "";
    const paths = this.envData?.other?.EXTRA_TOOLS?.path;
    if (Array.isArray(paths) && paths.length > 0) {
      paths.forEach((p: string, idx: number) => {
        extraHTML += `
          <tr id="extra-row-${idx}">
            <td>
              <button type="button" class="inline-icon-button expand-button codicon codicon-chevron-right" data-extra-idx="${idx}" aria-label="Expand/Collapse"></button>
            </td>
            <td>Current Path: ${p}</td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
          </tr>
          <tr id="extra-details-${idx}" class="details-row extra-details-row hidden">
            <td></td>
            <td colspan="5">
              <div id="extra-details-content-${idx}" class="details-content">
                <div class="grid-group-div extra-grid-group">
                  <vscode-text-field id="extra-path-input-${idx}" class="details-path-field" value="${p}" size="50" disabled>New Path:</vscode-text-field>
                  <vscode-button id="browse-extra-path-button-${idx}" class="browse-extra-input-button" appearance="secondary" disabled>
                    <span class="codicon codicon-folder"></span>
                  </vscode-button>
                  <vscode-button id="edit-extra-path-btn-${idx}" class="edit-extra-path-button save-path-button" appearance="primary">Edit</vscode-button>
                  <vscode-button id="remove-extra-path-btn-${idx}" class="remove-extra-path-button" appearance="secondary" disabled>Remove</vscode-button>
                </div>
              </div>
            </td>
          </tr>`;
      });
    }
    extraHTML += `
      <tr>
        <td></td>
        <td colspan="5">
          <vscode-button id="add-extra-path-btn" appearance="secondary">Add</vscode-button>
        </td>
      </tr>`;
    return extraHTML;
  }

  private async _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
    const webviewUri = getUri(webview, extensionUri, ["out", "hosttools.js"]);
    const styleUri = getUri(webview, extensionUri, ["out", "style.css"]);
    const codiconUri = getUri(webview, extensionUri, ["out", "codicon.css"]);
    const nonce = getNonce();

    const toolsHTML = await this.getToolsHTML();
    const extraToolsHTML = await this.getExtraPathTools();

    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
          <link nonce="${nonce}" rel="stylesheet" href="${styleUri}">
          <link nonce="${nonce}" rel="stylesheet" href="${codiconUri}">
          <title>Host Tools Manager</title>
        </head>
        <body>
          <h1>Host Tools Manager</h1>
          <form>
            <h2>Host Tools</h2>
            <table class="debug-tools-table">
              <tr>
                <th></th>
                <th>Name</th>
                <th>Version</th>
                <th></th>
                <th></th>
                <th></th>
              </tr>
              ${toolsHTML}
            </table>
          </form>
          <form>
            <h2>
              Extra Tools
              <span class="tooltip-extra" data-tooltip="Add custom locations to the system PATH">?</span>
            </h2>
            <table class="debug-tools-table">
              <tr>
                <th></th>
                <th>Custom tools:</th>
                <th></th>
                <th></th>
                <th></th>
                <th></th>
              </tr>
              ${extraToolsHTML}
            </table>
          </form>
          <script type="module" nonce="${nonce}" src="${webviewUri}"></script>
        </body>
      </html>`;
  }

  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
      async (message: any) => {
        const command = message.command;
        switch (command) {
          case "update-path": {
            const { tool, newPath, addToPath } = message;
            const trimmed = (newPath ?? "").toString().trim();
            if (!trimmed) {
              // Clear path for the tool
              await this.removeToolPath(tool);
              webview.postMessage({ command: "path-updated", tool, path: "", success: true });
              break;
            }
            const okPath = await this.saveToolPath(tool, trimmed);
            let okDoNotUse = true;
            if (typeof addToPath !== "undefined") {
              okDoNotUse = await this.saveDoNotUse(tool, !addToPath);
            }
            const ok = okPath && okDoNotUse;
            webview.postMessage({ command: "path-updated", tool, path: trimmed, success: ok });
            break;
          }
          case "browse-path": {
            const { tool, addToPath } = message;
            const pick = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: `Select the path for ${tool}` });
            if (pick && pick[0]) {
              const chosen = pick[0].fsPath.trim();
              if (!chosen) {
                webview.postMessage({ command: "path-updated", tool, path: "", success: false });
                break;
              }
              const okPath = await this.saveToolPath(tool, chosen);
              const okDoNotUse = typeof addToPath !== "undefined" ? await this.saveDoNotUse(tool, !addToPath) : true;
              const ok = okPath && okDoNotUse;
              webview.postMessage({ command: "path-updated", tool, path: chosen, success: ok, FromBrowse: true });
            }
            break;
          }
          case "toggle-add-to-path": {
            const { tool, addToPath } = message;
            webview.postMessage({ command: "add-to-path-updated", tool, doNotUse: !addToPath });
            break;
          }
          case "add-extra-path": {
            // Do not modify env.yml or in-memory YAML on Add; only add a local UI row
            try {
              const count = Array.isArray(this.envData?.other?.EXTRA_TOOLS?.path)
                ? this.envData.other.EXTRA_TOOLS.path.length
                : 0;
              webview.postMessage({ command: "add-extra-path-done", idx: count });
            } catch {
              webview.postMessage({ command: "add-extra-path-done", idx: 0 });
            }
            break;
          }
          case "update-extra-path": {
            try {
              const idx: number = Number(message.idx);
              const newPathRaw: string = (message.newPath ?? "").toString();
              const trimmed = newPathRaw.trim();
              if (!Number.isInteger(idx) || idx < 0) {
                webview.postMessage({ command: "extra-path-updated", idx, path: "", success: false, error: "Invalid index" });
                break;
              }
              if (!trimmed) {
                vscode.window.showErrorMessage('Please provide a valid path');
                webview.postMessage({ command: "extra-path-updated", idx, path: "", success: false, error: "Empty path" });
                break;
              }
              const envYamlPath = path.join(getInternalDirRealPath(), "env.yml");
              let doc: any;
              if (fs.existsSync(envYamlPath)) {
                const text = fs.readFileSync(envYamlPath, "utf8");
                doc = yaml.parseDocument(text);
              } else if (this.envYamlDoc) {
                doc = this.envYamlDoc.clone ? this.envYamlDoc.clone() : yaml.parseDocument(String(this.envYamlDoc));
              } else {
                doc = yaml.parseDocument("{}");
              }

              const jsEnv: any = yaml.parse(doc.toString()) || {};
              jsEnv.other = jsEnv.other || {};
              jsEnv.other.EXTRA_TOOLS = jsEnv.other.EXTRA_TOOLS || {};
              jsEnv.other.EXTRA_TOOLS.path = Array.isArray(jsEnv.other.EXTRA_TOOLS.path) ? jsEnv.other.EXTRA_TOOLS.path : [];
              const arr: string[] = jsEnv.other.EXTRA_TOOLS.path;
              // If idx is at end, append; if within range, replace; otherwise, append to avoid creating empty placeholders
              if (idx === arr.length) {
                arr.push(trimmed);
              } else if (idx >= 0 && idx < arr.length) {
                arr[idx] = trimmed;
              } else {
                arr.push(trimmed);
              }

              const yamlText = yaml.stringify(jsEnv, { flow: false });
              fs.writeFileSync(envYamlPath, yamlText, "utf8");
              this.envYamlDoc = yaml.parseDocument(yamlText);
              try { this.envData = yaml.parse(yamlText); } catch { this.envData = undefined; }

              webview.postMessage({ command: "extra-path-updated", idx, path: trimmed, success: true });
              // Rebuild UI so the summary row (Current Path: ...) reflects the saved value
              this._panel.webview.html = await this._getWebviewContent(webview, this._extensionUri);
            } catch {
              webview.postMessage({ command: "extra-path-updated", idx: message.idx, path: message.newPath, success: false });
            }
            break;
          }
          case "browse-extra-path": {
            try {
              const idx: number = Number(message.idx);
              if (!Number.isInteger(idx) || idx < 0) {
                webview.postMessage({ command: "extra-path-updated", idx, path: "", success: false, error: "Invalid index" });
                break;
              }
              const pick = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: `Select extra tool path` });
              if (!pick || !pick[0]) { break; }
              const chosen = pick[0].fsPath.trim();
              if (!chosen) {
                webview.postMessage({ command: "extra-path-updated", idx, path: "", success: false });
                break;
              }
              const envYamlPath = path.join(getInternalDirRealPath(), "env.yml");
              let doc: any;
              if (fs.existsSync(envYamlPath)) {
                const text = fs.readFileSync(envYamlPath, "utf8");
                doc = yaml.parseDocument(text);
              } else if (this.envYamlDoc) {
                doc = this.envYamlDoc.clone ? this.envYamlDoc.clone() : yaml.parseDocument(String(this.envYamlDoc));
              } else {
                doc = yaml.parseDocument("{}");
              }

              const jsEnv: any = yaml.parse(doc.toString()) || {};
              jsEnv.other = jsEnv.other || {};
              jsEnv.other.EXTRA_TOOLS = jsEnv.other.EXTRA_TOOLS || {};
              jsEnv.other.EXTRA_TOOLS.path = Array.isArray(jsEnv.other.EXTRA_TOOLS.path) ? jsEnv.other.EXTRA_TOOLS.path : [];
              const arr: string[] = jsEnv.other.EXTRA_TOOLS.path;
              const defPath = chosen.replace(/\\/g, "/");
              if (idx === arr.length) {
                arr.push(defPath);
              } else if (idx >= 0 && idx < arr.length) {
                arr[idx] = defPath;
              } else {
                arr.push(defPath);
              }

              const yamlText = yaml.stringify(jsEnv, { flow: false });
              fs.writeFileSync(envYamlPath, yamlText, "utf8");
              this.envYamlDoc = yaml.parseDocument(yamlText);
              try { this.envData = yaml.parse(yamlText); } catch { this.envData = undefined; }

              webview.postMessage({ command: "extra-path-updated", idx, path: defPath, success: true });
              // Refresh table view to update summary row title
              this._panel.webview.html = await this._getWebviewContent(webview, this._extensionUri);
            } catch {
              webview.postMessage({ command: "extra-path-updated", idx: message.idx, path: "", success: false });
            }
            break;
          }
          case "remove-extra-path": {
            try {
              const idx: number = Number(message.idx);
              if (!Number.isInteger(idx) || idx < 0) {
                webview.postMessage({ command: "extra-path-removed", idx, success: false });
                break;
              }
              const envYamlPath = path.join(getInternalDirRealPath(), "env.yml");
              let doc: any;
              if (fs.existsSync(envYamlPath)) {
                const text = fs.readFileSync(envYamlPath, "utf8");
                doc = yaml.parseDocument(text);
              } else if (this.envYamlDoc) {
                doc = this.envYamlDoc.clone ? this.envYamlDoc.clone() : yaml.parseDocument(String(this.envYamlDoc));
              } else {
                doc = yaml.parseDocument("{}");
              }

              const jsEnv: any = yaml.parse(doc.toString()) || {};
              const arr: any[] | undefined = jsEnv?.other?.EXTRA_TOOLS?.path;
              if (!Array.isArray(arr) || arr.length === 0) {
                // Nothing persisted; treat as success (UI-only row)
                webview.postMessage({ command: "extra-path-removed", idx, success: true });
                break;
              }

              // Remove selected entry; if index is out of range, remove the last one
              if (idx >= 0 && idx < arr.length) {
                arr.splice(idx, 1);
              } else {
                arr.pop();
              }

              // Clean empty containers if last item removed
              if (arr.length === 0) {
                if (jsEnv.other && jsEnv.other.EXTRA_TOOLS) {
                  delete jsEnv.other.EXTRA_TOOLS.path;
                  if (Object.keys(jsEnv.other.EXTRA_TOOLS).length === 0) {
                    delete jsEnv.other.EXTRA_TOOLS;
                  }
                }
                if (jsEnv.other && Object.keys(jsEnv.other).length === 0) {
                  delete jsEnv.other;
                }
              } else {
                jsEnv.other = jsEnv.other || {};
                jsEnv.other.EXTRA_TOOLS = jsEnv.other.EXTRA_TOOLS || {};
                jsEnv.other.EXTRA_TOOLS.path = arr;
              }

              const yamlText = yaml.stringify(jsEnv, { flow: false });
              fs.writeFileSync(envYamlPath, yamlText, "utf8");
              this.envYamlDoc = yaml.parseDocument(yamlText);
              try { this.envData = yaml.parse(yamlText); } catch { this.envData = undefined; }

              webview.postMessage({ command: "extra-path-removed", idx, success: true });
            } catch {
              webview.postMessage({ command: "extra-path-removed", idx: message.idx, success: false });
            }
            break;
          }
        }
      },
      undefined,
      this._disposables
    );
  }

  private async saveToolPath(toolId: string, newPath: string): Promise<boolean> {
    try {
      const envYamlPath = path.join(getInternalDirRealPath(), "env.yml");
      let doc: any;
      if (fs.existsSync(envYamlPath)) {
        const text = fs.readFileSync(envYamlPath, "utf8");
        doc = yaml.parseDocument(text);
      } else if (this.envYamlDoc) {
        doc = this.envYamlDoc.clone ? this.envYamlDoc.clone() : yaml.parseDocument(String(this.envYamlDoc));
      } else {
        doc = yaml.parseDocument("{}");
      }

      const normalized = newPath.replace(/\\\\/g, "/");
      // if contains ';', split into sequence
      const value: any = normalized.includes(";")
        ? normalized.split(";").map(s => s.trim()).filter(Boolean)
        : normalized;

      doc.setIn(["tools", toolId, "path"], value);
      formatYml(doc.contents);
      const yamlText = yaml.stringify(yaml.parse(doc.toString()), { flow: false });
      fs.writeFileSync(envYamlPath, yamlText, "utf8");
      this.envYamlDoc = doc;
      try { this.envData = yaml.parse(String(doc)); } catch { this.envData = undefined; }
      return true;
    } catch {
      return false;
    }
  }

  private async removeToolPath(toolId: string): Promise<boolean> {
    try {
      const envYamlPath = path.join(getInternalDirRealPath(), "env.yml");
      let doc: any;
      if (fs.existsSync(envYamlPath)) {
        const text = fs.readFileSync(envYamlPath, "utf8");
        doc = yaml.parseDocument(text);
      } else if (this.envYamlDoc) {
        doc = this.envYamlDoc.clone ? this.envYamlDoc.clone() : yaml.parseDocument(String(this.envYamlDoc));
      } else {
        doc = yaml.parseDocument("{}");
      }
      doc.deleteIn(["tools", toolId, "path"]);
      formatYml(doc.contents);
      const yamlText = yaml.stringify(yaml.parse(doc.toString()), { flow: false });
      fs.writeFileSync(envYamlPath, yamlText, "utf8");
      this.envYamlDoc = doc;
      try { this.envData = yaml.parse(String(doc)); } catch { this.envData = undefined; }
      return true;
    } catch {
      return false;
    }
  }

  private async saveDoNotUse(toolId: string, doNotUse: boolean): Promise<boolean> {
    try {
      const envYamlPath = path.join(getInternalDirRealPath(), "env.yml");
      let doc: any;
      if (fs.existsSync(envYamlPath)) {
        const text = fs.readFileSync(envYamlPath, "utf8");
        doc = yaml.parseDocument(text);
      } else if (this.envYamlDoc) {
        doc = this.envYamlDoc.clone ? this.envYamlDoc.clone() : yaml.parseDocument(String(this.envYamlDoc));
      } else {
        doc = yaml.parseDocument("{}");
      }
      doc.setIn(["tools", toolId, "do_not_use"], doNotUse);
      formatYml(doc.contents);
      const yamlText = yaml.stringify(yaml.parse(doc.toString()), { flow: false });
      fs.writeFileSync(envYamlPath, yamlText, "utf8");
      this.envYamlDoc = doc;
      try { this.envData = yaml.parse(String(doc)); } catch { this.envData = undefined; }
      return true;
    } catch {
      return false;
    }
  }
}
