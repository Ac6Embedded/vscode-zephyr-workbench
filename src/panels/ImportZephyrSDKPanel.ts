import * as vscode from "vscode";
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";
import { getGitTags } from "../execUtils";
import { generateSdkUrls, getSdkVersion, listToolchainArch } from "../sdkUtils";

export class ImportZephyrSDKPanel {
  public static currentPanel: ImportZephyrSDKPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  public async createContent() {
    this._panel.webview.html = await this._getWebviewContent(this._panel.webview, this._extensionUri);
    this._setWebviewMessageListener(this._panel.webview);
  }

  public openLocationDialog() {
    if (this._panel) {
      vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select',
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
      ImportZephyrSDKPanel.currentPanel.createContent();
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

  private async _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
    const webviewUri = getUri(webview, extensionUri, ["out", "importsdk.js"]);
    const styleUri = getUri(webview, extensionUri, ["out", "style.css"]);
    const nonce = getNonce();

    const versions = await getSdkVersion();

    let defaultSDKUrl = '';
    let versionHTML = '';
    let defaultVersionValue = '';
    if(versions.length > 0) {
      for(let version of versions) {
        const versionValue = version.replace(/^v/, ''); // Remove the 'v'
        versionHTML = versionHTML.concat(`<div class="dropdown-item" data-value="${versionValue}" data-label="${version}">${version}</div>`);
      }
      defaultVersionValue = versions[0].replace(/^v/, '');
    }
    

    let toolsListHTML = '';
    const nbTools = listToolchainArch.length;
    for(let tool of listToolchainArch) {
      toolsListHTML = toolsListHTML + `<div><vscode-checkbox class="toolchain-checkbox" current-value="${tool}" disabled>${tool}</vscode-checkbox></div>`;
    }
    
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
                <vscode-radio value="official" checked>Official SDK</vscode-radio>
                <vscode-radio value="remote">Remote archive</vscode-radio>
                <vscode-radio value="local">Local folder</vscode-radio>
              </vscode-radio-group>
            </div>
          </form>
          <form id="official-form">
            <div class="grid-group-div">
              <vscode-radio-group id="sdkType" orientation="horizontal">
                <label slot="label">SDK Type:</label>
                <vscode-radio value="full" checked>Full</vscode-radio>
                <vscode-radio value="minimal">Minimal</vscode-radio>
              </vscode-radio-group>
            </div>
            <div class="grid-group-div">
              <div class="grid-header-div">
                <label for="listVersion">Version: </label>
                <a href="https://github.com/zephyrproject-rtos/sdk-ng/wiki/Zephyr-SDK-Version-Compatibility-Matrix">
                  <span class="tooltip" data-tooltip="Click for more information on Zephyr SDK version compatibility">?</span>
                </a>
              </div>
              <div id="listVersion" class="combo-dropdown grid-value-div">
                <input type="text" id="versionInput" class="combo-dropdown-control" placeholder="Choose the SDK version..." data-value="${defaultVersionValue}">
                <div aria-hidden="true" class="indicator" part="indicator">
                  <slot name="indicator">  
                    <svg class="select-indicator" part="select-indicator" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                      <path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"></path>
                    </svg>
                  </slot>
                </div>
                
                <div id="versionsDropdown" class="dropdown-content">
                  ${versionHTML}
                </div>
              </div>
              <div class="grid-group-div">
                <fieldset class="no-border">
                  <div class="toolchains-container">
                    ${toolsListHTML}
                  </div>
                </fieldset>
              </div>
            </div>
          </form>
          <form>
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
        switch (command) {
          case 'debug':
            vscode.window.showInformationMessage(message.text);
            return;
          case 'openLocationDialog':
            this.openLocationDialog();
            break;
          case 'import':
            if(!checkParameters(message)) {
              break;
            }

            let srcType = message.srcType;
            const workspacePath = message.workspacePath;

            if(srcType === 'official') {
              const sdkType = message.sdkType;
              const sdkVersion = message.sdkVersion;
              const listToolchains = message.listToolchains;
              vscode.commands.executeCommand("zephyr-workbench-sdk-explorer.import-official-sdk", sdkType, sdkVersion, listToolchains, workspacePath);
            } else if(srcType === 'remote') {
              const remotePath = message.remotePath;
              vscode.commands.executeCommand("zephyr-workbench-sdk-explorer.import-remote-sdk", remotePath, workspacePath);
            } else if(srcType === 'local') {
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

function checkParameters(message: any): boolean {
  let srcType = message.srcType;
  if(message.workspacePath.length === 0) {
    vscode.window.showErrorMessage('Missing sdk destination, please enter sdk location');
    return false;
  }

  if(srcType === 'official') {
    const sdkVersion = message.sdkVersion;
    if(sdkVersion.length === 0) {
      vscode.window.showErrorMessage('No version selected, please select the SDK version');
      return false;
    }
  } else if(srcType === 'remote') {
    const remotePath = message.remotePath;
    if(remotePath.length === 0) {
      vscode.window.showErrorMessage('Missing sdk remote url, please enter sdk repository url');
      return false;
    }
  } 

  return true;
}
