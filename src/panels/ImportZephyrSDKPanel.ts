import * as vscode from "vscode";
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";

export class ImportZephyrSDKPanel {
  public static currentPanel: ImportZephyrSDKPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.html = this._getWebviewContent(this._panel.webview, extensionUri);
    this._setWebviewMessageListener(this._panel.webview);
  }

  public openLocationDialog() {
    if (this._panel) {
      vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select the workspace location',
      }).then(uri => {
        if (uri && uri.length > 0) {
          const selectedFolderUri = uri[0].fsPath;
          // Send the selected file URI back to the webview
          this._panel?.webview.postMessage({ command: 'folderSelected', folderUri: selectedFolderUri, id: 'workspacePath'});
        }
      });
    }
  }

  public static render(extensionUri: vscode.Uri) {
    if (ImportZephyrSDKPanel.currentPanel) {
      ImportZephyrSDKPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
    } else {
      const panel = vscode.window.createWebviewPanel("add-zephyr-sdk-panel", "Add Zephyr SDK", vscode.ViewColumn.One, {
        // Enable javascript in the webview
        enableScripts: true,
        // Restrict the webview to only load resources from the `out` directory
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out')]
      });
      panel.iconPath = {
      	light: vscode.Uri.joinPath(extensionUri, 'res', 'icons', 'light', 'symbol-method.svg'),
      	dark: vscode.Uri.joinPath(extensionUri, 'res', 'icons', 'dark', 'symbol-method.svg')
      };

      ImportZephyrSDKPanel.currentPanel = new ImportZephyrSDKPanel(panel, extensionUri);
    }
  }

  public dispose() {
    ImportZephyrSDKPanel.currentPanel = undefined;

    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
    const webviewUri = getUri(webview, extensionUri, ["out", "importsdk.js"]);
    const styleUri = getUri(webview, extensionUri, ["out", "style.css"]);
    const nonce = getNonce();

    let defaultSDKUrl = '';
    
    if(process.platform === 'linux' && process.arch === 'x64') {
      defaultSDKUrl = 'https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v0.16.8/zephyr-sdk-0.16.8_linux-x86_64.tar.xz';
    } else if(process.platform === 'linux' && process.arch === 'arm64') {
      defaultSDKUrl = 'https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v0.16.8/zephyr-sdk-0.16.8_linux-aarch64.tar.xz';
    } else if(process.platform === 'win32' && process.arch === 'x64') {
      defaultSDKUrl = 'https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v0.16.8/zephyr-sdk-0.16.8_windows-x86_64.7z';
    } else if(process.platform === 'darwin' && process.arch === 'x64') {
      defaultSDKUrl = 'https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v0.16.8/zephyr-sdk-0.16.8_macos-x86_64.tar.xz';
    } else if(process.platform === 'darwin' && process.arch === 'arm64') {
      defaultSDKUrl = 'https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v0.16.8/zephyr-sdk-0.16.8_macos-aarch64.tar.xz';
    } else {
      defaultSDKUrl = '';
    }
  
    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
          <link rel="stylesheet" href="${styleUri}">
          <title>Add Zephyr SDK</title>
        </head>
        
        <body>
          <h1>Add Zephyr SDK</h1>
          <form>
            <div class="grid-group-div">
              <vscode-radio-group id="srcType" orientation="vertical">
                <label slot="label">Source location:</label>
                <vscode-radio value="remote" checked>Remote archive</vscode-radio>
                <vscode-radio value="local">Local folder</vscode-radio>
              </vscode-radio-group>
            </div>
            <div class="grid-group-div">
              <vscode-text-field size="50" type="url" id="remotePath" value="${defaultSDKUrl}">Path:</vscode-text-field>
            </div>
            <div class="grid-group-div">
              <vscode-text-field size="50" type="text" id="workspacePath" value="">Location:</vscode-text-field>
              <vscode-button id="browseLocationButton" class="browse-input-button" style="vertical-align: middle">Browse...</vscode-button>
            </div>
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
      (message: any) => {
        const command = message.command;
        let srcType;
        let remotePath;
        let remoteBranch;
        let workspacePath;

        switch (command) {
          case 'debug':
            vscode.window.showInformationMessage(message.text);
            return;
          case 'openLocationDialog':
            this.openLocationDialog();
            break;
          case 'create':
            srcType = message.srcType;
            remotePath = message.remotePath;
            workspacePath = message.workspacePath;

            if(srcType === 'remote') {
              vscode.commands.executeCommand("zephyr-workbench-sdk-explorer.import-remote-sdk", remotePath, workspacePath);
            } else {
              vscode.commands.executeCommand("zephyr-workbench-sdk-explorer.import-local-sdk", workspacePath);
            }
            break;
        }
      },
      undefined,
      this._disposables
    );
  }
}