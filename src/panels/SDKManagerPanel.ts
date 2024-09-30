import * as vscode from 'vscode';
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";
import { listToolchainArch } from '../sdkUtils';

export class SDKManagerPanel {
  public static currentPanel: SDKManagerPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  public force: boolean = false;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  public async createContent() {
    this._panel.webview.html = await this._getWebviewContent(this._panel.webview, this._extensionUri);
    this._setWebviewMessageListener(this._panel.webview);
  }

  public static render(extensionUri: vscode.Uri, force: boolean) {
    if (SDKManagerPanel.currentPanel) {
      SDKManagerPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
    } else {
      const panel = vscode.window.createWebviewPanel("sdk-manager-panel", "Host Tools Manager", vscode.ViewColumn.One, {
        // Enable javascript in the webview
        enableScripts: true,
        // Restrict the webview to only load resources from the `out` directory
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out')]
      });

      SDKManagerPanel.currentPanel = new SDKManagerPanel(panel, extensionUri);
      SDKManagerPanel.currentPanel.force = force;
      SDKManagerPanel.currentPanel.createContent();
    }
  }

  public dispose() {
    SDKManagerPanel.currentPanel = undefined;
    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  public openFileDialog(elementId: string) {
    if (this._panel) {
      vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Select',
      }).then(uri => {
        if (uri && uri.length > 0) {
          const selectedFileUri = uri[0];
          // Send the selected file URI back to the webview
          this._panel?.webview.postMessage({ command: 'fileSelected', id: elementId, fileUri: selectedFileUri.fsPath });
        }
      });
    }
  }

  private async _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
    const webviewUri = getUri(webview, extensionUri, ["out", "sdkmanager.js"]);
    const styleUri = getUri(webview, extensionUri, ["out", "style.css"]);
    const nonce = getNonce();

    let toolsListHTML = '';
    for(let tool of listToolchainArch) {
      toolsListHTML = toolsListHTML + `<div><vscode-checkbox class="toolchain-checkbox" current-value="${tool}" disabled>${tool}</vscode-checkbox></div>`;
    }

    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
          <link rel="stylesheet" href="${styleUri}">
          <title>Host Tools Manager</title>
        </head>
        
        <body>
          <h1>Host Tools Manager</h1>
          <form>
            <fieldset>
              <legend>Requirements:</legend>
              <div><vscode-checkbox class="host-tool-checkbox" current-value="python" current-checked="true" disabled>Python</vscode-checkbox></div>
              <div><vscode-checkbox class="host-tool-checkbox" current-value="cmake" current-checked="true" disabled>CMake</vscode-checkbox></div>
              <div><vscode-checkbox class="host-tool-checkbox" current-value="ninja" current-checked="true" disabled>Ninja</vscode-checkbox></div>
              <div><vscode-checkbox class="host-tool-checkbox" current-value="openssl" current-checked="true" disabled>OpenSSL</vscode-checkbox></div>
            </fieldset>
          </form>
          <form>
            <fieldset>
              <legend>Zephyr SDK:</legend>
              <vscode-radio-group id="sdkConfig" orientation="vertical">
                <label slot="label">Configure SDK:</label>
                <vscode-radio value="all" checked>Install all toolchains</vscode-radio>
                <vscode-radio value="skip">Skip toolchain</vscode-radio>
                <vscode-radio value="select">Select toolchains</vscode-radio>
              </vscode-radio-group>
              <fieldset class="no-border">
                <div class="toolchains-container">
                  ${toolsListHTML}
                </div>
              </fieldset>
             </fieldset>
          </form>

          <div class="grid-group-div">
            <vscode-button id="importButton" class="finish-input-button">Import</vscode-button>
          <div>
          <script type="module" nonce="${nonce}" src="${webviewUri}"></script>
        </body>
      </html>
    `;
  }

  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
      async (message: any) => {
        const command = message.command;
        switch (command) {
          case 'import': {
            this.importHandler(message);
            break;
          }
          default:
            break;
        }
      },
      undefined,
      this._disposables
    );
  }  

  private importHandler(message: any) {
    const skipSdk = (message.sdkconfig === 'skip');
    const listToolchains = message.listToolchains;
    const forceInstall = this.force;

    vscode.commands.executeCommand('zephyr-workbench.install-host-tools', forceInstall, skipSdk, listToolchains);
  }
}


