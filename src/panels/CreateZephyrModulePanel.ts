import * as vscode from "vscode";
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";

export class CreateZephyrModulePanel {
  public static currentPanel: CreateZephyrModulePanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.html = this._getWebviewContent(this._panel.webview, extensionUri);
    this._setWebviewMessageListener(this._panel.webview);
  }

  public openFileDialog() {
    if (this._panel) {
      vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Select file:',
      }).then(uri => {
        if (uri && uri.length > 0) {
          const selectedFileUri = uri[0];
          // Send the selected file URI back to the webview
          this._panel?.webview.postMessage({ command: 'fileSelected', fileUri: selectedFileUri });
        }
      });
    }
  }

  public openFolderDialog() {
    if (this._panel) {
      vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select Zephyr root location:',
      }).then(uri => {
        if (uri && uri.length > 0) {
          const selectedFolderUri = uri[0].fsPath;
          // Send the selected file URI back to the webview
          this._panel?.webview.postMessage({ command: 'folderSelected', folderUri: selectedFolderUri , id: 'localPath'});
        }
      });
    }
  }

  public static render(extensionUri: vscode.Uri) {
    if (CreateZephyrModulePanel.currentPanel) {
      CreateZephyrModulePanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
    } else {
      const panel = vscode.window.createWebviewPanel("import-zephyr-panel", "Import Zephyr", vscode.ViewColumn.One, {
        // Enable javascript in the webview
        enableScripts: true,
        // Restrict the webview to only load resources from the `out` directory
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out')]
      });

      CreateZephyrModulePanel.currentPanel = new CreateZephyrModulePanel(panel, extensionUri);
    }
  }

  public dispose() {
    CreateZephyrModulePanel.currentPanel = undefined;

    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
    const webviewUri = getUri(webview, extensionUri, ["out", "newmodule.js"]);
    const nonce = getNonce();

    webview.postMessage({ command: 'testCmd' });
  
    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}';">
          <title>Import Zephyr</title>
        </head>
        
        <body>
          <h1>New Zephyr Extra Module project</h1>
          <form>
            <div>
              <vscode-radio-group id="srcType" orientation="vertical">
                <label slot="label">Source location:</label>
                <vscode-radio value="remote" checked>Repository</vscode-radio>
                <vscode-radio value="local">Local folder</vscode-radio>
              </vscode-radio-group>
            </div>
            <div><vscode-text-field size="50" type="url" id="remotePath" value="https://github.com/zephyrproject-rtos/zephyr">Path:</vscode-text-field></div>
            <div><vscode-text-field size="50" type="text" id="remoteBranch" value="master">Branch:</vscode-text-field></div>
            <div>
              <vscode-text-field size="50" type="url" id="localPath" placeholder="Enter Zephyr root path" disabled>Path:</vscode-text-field>
              <vscode-button id="browseButton" class="browse-input-button" disabled>Browse...</vscode-button>
            </div>
          </form>
          <vscode-button id="importButton">Import</vscode-button>
          <script type="module" nonce="${nonce}" src="${webviewUri}"></script>
          <script>
            // Listen for messages from the extension
            window.addEventListener('message', event => {
              const message = event.data;
              console.log(message);
              switch (message.command) {
                case 'fileSelected':
                  // Do something with the selected file URI
                  const fileUri = message.fileUri;
                  console.log('Selected file:', fileUri);
                  break;
                case 'folderSelected':
                  // Update the value of the text field with the selected folder URI
                  const folderTextField = document.getElementById('localPath');
                  if (folderTextField) {
                    folderTextField.setAttribute('value', message.folderUri);
                  }
                  break;
              }
            });
          </script>
        </body>
      </html>
    `;
  }

  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
      (message: any) => {
        const command = message.command;

        switch (command) {
          case 'debug':
            vscode.window.showInformationMessage(message.text);
            return;
          case 'openFileDialog':
            this.openFileDialog();
            break;
          case 'openFolderDialog':
            this.openFolderDialog();
            break;
          case 'import':
            let srcType = message.srcType;
            let remotePath = message.remotePath;
            let remoteBranch = message.remoteBranch;
            let localPath = message.localPath;
            
            break;
        }
      },
      undefined,
      this._disposables
    );
  }
}
