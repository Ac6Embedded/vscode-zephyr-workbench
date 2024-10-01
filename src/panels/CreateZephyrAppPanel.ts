import * as vscode from "vscode";
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";
import { fileExists, getBase64, getBoard, getListSamples, getListZephyrSDKs, getSample, getSupportedBoards, getWestWorkspace, getWestWorkspaces, getZephyrSDK } from "../utils";
import path from "path";

export class CreateZephyrAppPanel {
  public static currentPanel: CreateZephyrAppPanel | undefined;
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

  public static render(extensionUri: vscode.Uri) {
    if (CreateZephyrAppPanel.currentPanel) {
      CreateZephyrAppPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
    } else {
      const panel = vscode.window.createWebviewPanel("zephyr-workbench-new-app-panel", "Create new application", vscode.ViewColumn.One, {
        // Enable javascript in the webview
        enableScripts: true,
        // Restrict the webview to only load resources from the `out` directory
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out')]
      });

      panel.iconPath = {
      	light: vscode.Uri.joinPath(extensionUri, 'res', 'icons', 'light', 'folder.svg'),
      	dark: vscode.Uri.joinPath(extensionUri, 'res', 'icons', 'dark', 'folder.svg')
      };
      
      CreateZephyrAppPanel.currentPanel = new CreateZephyrAppPanel(panel, extensionUri);
      CreateZephyrAppPanel.currentPanel.createContent();
    }
  }

  public async dispose() {
    CreateZephyrAppPanel.currentPanel = undefined;

    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
  
  private async _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
    const webviewUri = getUri(webview, extensionUri, ["out", "createzephyrapp.js"]);
    const styleUri = getUri(webview, extensionUri, ["out", "style.css"]);
    const codiconUri = getUri(webview, extensionUri, ["out", "codicon.css"]);
    
    const nonce = getNonce();
    let workspacesHTML: string = '';
    for(let westWorkspace of getWestWorkspaces()) {
      workspacesHTML = workspacesHTML.concat(`<div class="dropdown-item" data-value="${westWorkspace.rootUri}" data-label="${westWorkspace.name}">${westWorkspace.name}<span class="description">${westWorkspace.rootUri.fsPath}</span></div>`);
    }

    let sdkHTML: string = '';
    for(let sdk of await getListZephyrSDKs()) {
      sdkHTML = sdkHTML.concat(`<div class="dropdown-item" data-value="${sdk.rootUri}" data-label="${sdk.name}">${sdk.name}<span class="description">${sdk.rootUri.fsPath}</span></div>`);
    }
      
    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' * data: ; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
          <link nonce="${nonce}" rel="stylesheet" href="${styleUri}">
          <link nonce="${nonce}" rel="stylesheet" href="${codiconUri}">
          <title>Create Zephyr Application</title>
        </head>
        
        <body>
          <h1>Create a new Zephyr Application Project</h1>

          <table>
            <td>
              <form>
                <div class="grid-group-div">
                  <div class="grid-header-div">
                    <label for="listWorkspaces">Select West Workspace:</label>
                  </div>
                  <div id="listWorkspaces" class="combo-dropdown grid-value-div">
                    <input type="text" id="workspaceInput" class="combo-dropdown-control" placeholder="Choose your west workspace..." data-value="">
                    <div aria-hidden="true" class="indicator" part="indicator">
                      <slot name="indicator">  
                        <svg class="select-indicator" part="select-indicator" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                          <path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"></path>
                        </svg>
                      </slot>
                    </div>
                    <div id="workspaceDropdown" class="dropdown-content" style="display: none;">
                      ${workspacesHTML}
                    </div>
                  </div>
                </div>

                <div class="grid-group-div">
                  <div class="grid-header-div">
                    <label for="listSDKs">Select Zephyr SDK:</label>
                  </div>
                  <div id="listSdks" class="combo-dropdown grid-value-div">
                    <input type="text" id="sdkInput" class="combo-dropdown-control" placeholder="Choose your SDK..." data-value="">
                    <div aria-hidden="true" class="indicator" part="indicator">
                      <slot name="indicator">  
                        <svg class="select-indicator" part="select-indicator" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                          <path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"></path>
                        </svg>
                      </slot>
                    </div>
                    <div id="sdkDropdown" class="dropdown-content" style="display: none;">
                      ${sdkHTML}
                    </div>
                  </div>
                </div>

                <div class="grid-group-div">
                  <div class="grid-header-div">
                    <label for="listBoards">Select Board:</label>
                  </div>
                  <div id="listBoards" class="combo-dropdown grid-value-div">
                    <input type="text" id="boardInput" class="combo-dropdown-control" placeholder="Choose your target board..." data-value="">
                    <div aria-hidden="true" class="indicator" part="indicator">
                      <slot name="indicator">  
                        <svg class="select-indicator" part="select-indicator" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                          <path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"></path>
                        </svg>
                        <div class="spinner" id="boardDropdownSpinner" style="display:none;"></div>
                      </slot>
                    </div>
                    <div id="boardDropdown" class="dropdown-content">
                    </div>
                  </div>
                </div>

                <div class="grid-group-div">
                  <div class="grid-header-div">
                    <label for="listBoards">Select Sample project:</label>
                  </div>
                  <div id="listSamples" class="combo-dropdown grid-value-div">
                    <input type="text" id="sampleInput" class="combo-dropdown-control" placeholder="Choose a sample as base..." data-value="">
                    <div aria-hidden="true" class="indicator" part="indicator">
                      <slot name="indicator">  
                        <svg class="select-indicator" part="select-indicator" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                          <path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"></path>
                        </svg>
                        <div class="spinner" id="samplesDropdownSpinner" style="display:none;"></div>
                      </slot>
                    </div>
                    <div id="samplesDropdown" class="dropdown-content">
                    </div>
                  </div>
                </div>

                <div class="grid-group-div">
                  <div class="grid-value-div">
                    <vscode-text-field size="60" type="text" id="projectName" placeholder="Enter project name">Project Name:</vscode-text-field>
                  </div>
                </div>

                <div class="grid-group-div">
                  <div class="grid-value-div">
                    <vscode-text-field type="text" id="projectParentPath">Project Location:</vscode-text-field>
                    <vscode-button id="browseParentButton" class="browse-input-button">Browse...</vscode-button>
                  </div>
                </div>

                <div class="grid-group-div">
                  <vscode-radio-group id="pristineMode" orientation="vertical">
                    <label slot="label">Pristine Builds option:</label>
                    <vscode-radio value="auto" checked>auto (detect if build directory needs to be made pristine before build)</vscode-radio>
                    <vscode-radio value="always">always (force the build directory pristine before build)</vscode-radio>
                    <vscode-radio value="none">none</vscode-radio>
                  </vscode-radio-group>
                </div>

                <div class="grid-group-div">
                  <vscode-button id="createButton">Create</vscode-button>
                </div>
              </form>
            </td>
            <td>
              <img id="boardImg" src="" alt="No board image">
            <td>
          <table>
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
          case 'debug':
            vscode.window.showInformationMessage(message.text);
            break;
          case 'westWorkspaceChanged':
            updateForm(webview, message.workspace);
            break;
          case 'boardChanged':
            updateBoardImage(webview, message.boardYamlPath);
            break; 
          case 'openLocationDialog':
            const westWorkspacePath = message.westWorkspacePath;
            if(westWorkspacePath && westWorkspacePath.length > 0) {
              this.openLocationDialog(vscode.Uri.parse(message.westWorkspacePath, false));
            } else {
              this.openLocationDialog(undefined);
            }
            
            break;
          case 'create':
            checkCreateParameters(message);
            let westWorkspace = getWestWorkspace(vscode.Uri.parse(message.westWorkspacePath, true).fsPath);
            let sdk = getZephyrSDK(vscode.Uri.parse(message.zephyrsdkPath, true).fsPath);
            let board = getBoard(message.boardYamlPath);
            let sample = await getSample(message.samplePath);
            let projectName = message.projectName;
            let projectLoc = message.projectParentPath;
            let pristineMode = message.pristine;
            vscode.commands.executeCommand("zephyr-workbench-app-explorer.create-app", westWorkspace, sample, board, projectLoc, projectName, sdk, pristineMode);
            break;
        }
      },
      undefined,
      this._disposables
    );
  }

  public openLocationDialog(uri: vscode.Uri | undefined) {
    if (this._panel) {
      vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: uri,
        openLabel: 'Select the project parent location',
      }).then(uri => {
        if (uri && uri.length > 0) {
          const selectedFolderUri = uri[0].fsPath;
          // Send the selected file URI back to the webview
          this._panel?.webview.postMessage({ command: 'folderSelected', folderUri: selectedFolderUri, id: 'projectParentPath'});
        }
      });
    }
  }
}

async function updateForm(webview: vscode.Webview, workspaceUri: string) {
  if(workspaceUri && workspaceUri.length > 0) {
    let westWorkspace = getWestWorkspace(vscode.Uri.parse(workspaceUri, true).fsPath);
    const boards = await getSupportedBoards(westWorkspace);
    boards.sort((a, b) => {
      if (a.name < b.name) {
        return -1;
      }
      if (a.name > b.name) {
        return 1;
      }
      return 0;
    });

    let newBoardsHTML = '';
    for(let board of boards) {
      newBoardsHTML += `<div class="dropdown-item" data-value="${board.yamlFileUri.fsPath}" data-label="${board.name}">${board.name}<span class="description">(${board.identifier})</span></div>`;
    }
    webview.postMessage({ command: 'updateBoardDropdown', boardHTML: newBoardsHTML });

    const samples = await getListSamples(westWorkspace);
    const helloWorldPath = path.join('samples','hello_world');
    samples.sort((a, b) => {
      if(a.rootDir.fsPath.endsWith(helloWorldPath)) {
        return -99;
      }
      if(b.rootDir.fsPath.endsWith(helloWorldPath)) {
        return 99;
      }
      if (a.name < b.name) {
        return -1;
      }
      if (a.name > b.name) {
        return 1;
      }
      return 0;
    });

    let newSamplesHTML = '';
    for(let sample of samples) {
      newSamplesHTML += `<div class="dropdown-item" data-value="${sample.rootDir.fsPath}" data-label="${sample.name}">${sample.name}<span class="description">${sample.rootDir.fsPath}</span></div>`;
    }
    webview.postMessage({ command: 'updateSamplesDropdown', samplesHTML: newSamplesHTML });
  }
}

async function updateBoardImage(webview: vscode.Webview, boardYamlPath: string) {
  if((boardYamlPath && boardYamlPath.length > 0)) {
    const board = getBoard(boardYamlPath);
    if(fileExists(board.imagePath)) {
      const base64img = getBase64(board.imagePath);
      webview.postMessage({ command: 'updateBoardImage', imgPath: `data:image/jpeg;base64,${base64img}` });
    } else {
      webview.postMessage({ command: 'updateBoardImage', imgPath: 'noImg' });
    }
  } 
}

function checkCreateParameters(message: any) {
  if(message.westWorkspacePath.length === 0) {
    vscode.window.showErrorMessage('Missing west workspace, please select a west workspace');
    return;
  }

  if(message.zephyrsdkPath.length === 0) {
    vscode.window.showErrorMessage('Missing Zephyr SDK, a SDK is required to provide toolchain to your project');
    return;
  }

  if(message.projectName.length === 0) {
    vscode.window.showErrorMessage('The project name is empty or invalid');
    return;
  }

  if(message.boardYamlPath.length === 0) {
    vscode.window.showErrorMessage('Missing target board');
    return;
  }
  
  if(message.samplePath === 0) {
    vscode.window.showErrorMessage('Missing selected sample, it serves as base for your project');
    return;
  }
}

