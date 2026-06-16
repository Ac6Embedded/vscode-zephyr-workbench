import * as vscode from "vscode";
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";

/**
 * Advanced host-tools installation view.
 *
 * Opened from the "Advanced" entry (left menu shortcut + the "host tools missing"
 * prompt) when host tools are not installed. The actual advanced-install content
 * is implemented in a later phase; for now this renders a placeholder so the
 * navigation/wiring is in place.
 */
export class AdvancedHostToolsPanel {
  public static currentPanel: AdvancedHostToolsPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.html = this._getWebviewContent(this._panel.webview, extensionUri);
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
  }

  public dispose() {
    AdvancedHostToolsPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) { d.dispose(); }
    }
  }

  private _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const styleUri = getUri(webview, extensionUri, ["out", "style.css"]);
    const codiconUri = getUri(webview, extensionUri, ["out", "codicon.css"]);
    const nonce = getNonce();

    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource};">
          <link nonce="${nonce}" rel="stylesheet" href="${styleUri}">
          <link nonce="${nonce}" rel="stylesheet" href="${codiconUri}">
          <title>Advanced Host Tools Installation</title>
        </head>
        <body>
          <h1>Advanced Host Tools Installation</h1>
          <p class="panel-lead">Advanced installation options will be available here.</p>
        </body>
      </html>`;
  }
}
