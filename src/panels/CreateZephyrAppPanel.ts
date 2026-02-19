import * as vscode from "vscode";
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";
import { fileExists, getBase64, getBoard, getListSamples, getListZephyrSDKs, getListIARs, getIarToolchainForSdk, getSample, getSupportedBoards, getWestWorkspace, getWestWorkspaces, getZephyrSDK, validateProjectLocation } from "../utils/utils";
import { ZephyrSDK, IARToolchain } from '../models/ZephyrSDK';
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
        light: vscode.Uri.joinPath(extensionUri, 'res', 'icons', 'light', 'application_icon_light.svg'),
        dark: vscode.Uri.joinPath(extensionUri, 'res', 'icons', 'dark', 'application_icon_dark.svg')
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
    for (let westWorkspace of getWestWorkspaces()) {
      workspacesHTML = workspacesHTML.concat(`<div class="dropdown-item" data-value="${westWorkspace.rootUri}" data-label="${westWorkspace.name}">${westWorkspace.name}<span class="description">${westWorkspace.rootUri.fsPath}</span></div>`);
    }

    let sdkHTML: string = '';
    for (let sdk of await getListZephyrSDKs()) {
      sdkHTML = sdkHTML.concat(`<div class="dropdown-item" data-value="${sdk.rootUri}" data-label="${sdk.name}">${sdk.name}<span class="description">${sdk.rootUri.fsPath}</span></div>`);
    }

    for (const iar of await getListIARs()) {
      const label = path.basename(iar.iarPath);           // e.g. "arm-9.20.1"
      sdkHTML += `<div class="dropdown-item"
                       data-type="iar"
                       data-value="${iar.iarPath}"
                       data-label="${label}">
                    IAR (${label})
                    <span class="description">${iar.iarPath}</span>
                  </div>`;
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
        
        <body class="create-app-panel">
          <h1>Create a new Zephyr Application Project</h1>
          <a class="help-link" href="https://zephyr-workbench.com/docs/documentation/application">Read Docs</a>
          <form>
            <div class="app-form-layout">
              <div class="app-form-main">
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
                      <label for="listSDKs">Select Toolchain:</label>
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
                      <div class="combo-dropdown-input">
                        <input type="text" id="boardInput" class="combo-dropdown-control" placeholder="Choose your target board..." data-value="">
                        <div aria-hidden="true" class="indicator" part="indicator">
                          <slot name="indicator">  
                            <svg class="select-indicator" part="select-indicator" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                              <path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"></path>
                            </svg>
                          </slot>
                        </div>
                      </div>
                      <div class="combo-dropdown-controls">
                        <div id="boardDropdownSpinner" class="spinner" aria-label="Loading boards"></div>
                      </div>
                      <div id="boardDropdown" class="dropdown-content"></div>
                    </div>
                  </div>

                  <div class="grid-group-div">
                    <vscode-radio-group id="appTypeGroup" orientation="horizontal">
                      <label slot="label">Application type:&nbsp;</label>
                      <vscode-radio value="create" checked>Create new application</vscode-radio>
                      <vscode-radio value="import">Import existing application</vscode-radio>
                    </vscode-radio-group>
                  </div>

                  <div class="grid-group-div create-only">
                    <div class="grid-header-div">
                      <label for="listBoards">Select Sample project:</label>
                    </div>
                    <div id="listSamples" class="combo-dropdown grid-value-div">
                      <div class="combo-dropdown-input">
                        <input type="text" id="sampleInput" class="combo-dropdown-control" placeholder="Choose a sample as base..." data-value="">
                        <div aria-hidden="true" class="indicator" part="indicator">
                          <slot name="indicator">  
                            <svg class="select-indicator" part="select-indicator" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                              <path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"></path>
                            </svg>
                          </slot>
                        </div>
                      </div>
                      <div class="combo-dropdown-controls">
                        <div id="samplesDropdownSpinner" class="spinner" aria-label="Loading samples"></div>
                      </div>
                      <div id="samplesDropdown" class="dropdown-content"></div>
                    </div>
                  </div>

                  <div class="grid-group-div create-only">
                    <div class="grid-value-div">
                      <vscode-text-field size="60" type="text" id="projectName" placeholder="Enter project name">Project Name:</vscode-text-field>
                    </div>
                  </div>

                  <div class="grid-group-div">
                    <div class="grid-value-div">
                      <vscode-text-field class="browse-field" type="text" id="projectParentPath">Project Location:</vscode-text-field>
                      <vscode-button id="browseParentButton" class="browse-input-button">Browse...</vscode-button>
                    </div>
                  </div>

                  <div class="grid-group-div create-only">
                    <vscode-checkbox id="debugPresetCheckbox" checked>
                      Debug preset
                      <span class="tooltip stable-tooltip debug-preset-tooltip"
                            data-tooltip="Enable debug options in prj.conf:\n
                                          CONFIG_DEBUG_OPTIMIZATIONS=y\n
                                          CONFIG_DEBUG_THREAD_INFO=y\n
                                          CONFIG_STACK_USAGE=y\n
                                          CONFIG_BUILD_OUTPUT_HEX=y\n
                                          CONFIG_BUILD_OUTPUT_META=y\n
                                          CONFIG_OUTPUT_SYMBOLS=y\n
                                          CONFIG_OUTPUT_STAT=y\n
                                          CONFIG_OUTPUT_DISASSEMBLY=y\n
                                          CONFIG_OUTPUT_PRINT_MEMORY_USAGE=y">?</span>
                    </vscode-checkbox>
                  </div>

                  <div class="grid-group-div">
                    <details class="advanced-options">
                      <summary>
                        <button type="button" class="inline-icon-button expand-button codicon codicon-chevron-right advanced-arrow" aria-hidden="true" tabindex="-1"></button>
                        <span>Advanced options</span>
                      </summary>
                      <div class="advanced-options-content">
                        <div class="grid-group-div">
                          <vscode-radio-group id="pristineMode" orientation="horizontal">
                            <label slot="label">Pristine Builds option:&nbsp;&nbsp;
                              <span class="tooltip stable-tooltip" 
                                    data-tooltip="Indicate if the build folder must be clean before each build:\n
                                                - (auto): detect if build directory needs to be made pristine before build\n
                                                - (always): force the build directory pristine before build">?</span>
                            </label>
                            <vscode-radio value="auto" checked>auto</vscode-radio>
                            <vscode-radio value="always">always</vscode-radio>
                            <vscode-radio value="never">never</vscode-radio>
                          </vscode-radio-group>
                        </div>

                        <div class="grid-group-div">
                          <vscode-radio-group id="venvMode" orientation="horizontal">
                            <label slot="label">Python virtual environment:&nbsp;&nbsp;
                              <span class="tooltip stable-tooltip" data-tooltip="Use global if you are not sure">?</span>
                            </label>
                            <vscode-radio value="global" checked>global</vscode-radio>
                            <vscode-radio value="local">local</vscode-radio>
                          </vscode-radio-group>
                        </div>
                      </div>
                    </details>
                  </div>
              </div>
              <div class="app-form-side">
                <div class="board-image-container">
                  <img id="boardImg" src="" alt="No board image">
                </div>
              </div>
            </div>
            <div class="grid-group-div">
              <vscode-button id="createButton">Create</vscode-button>
            </div>
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
            if (westWorkspacePath && westWorkspacePath.length > 0) {
              this.openLocationDialog(vscode.Uri.parse(message.westWorkspacePath, false));
            } else {
              this.openLocationDialog(undefined);
            }

            break;

          case "create": {
            /* always present */
            const projectLoc = message.projectParentPath;
            const isCreate = message.appType === "create";

            if (isCreate) {
              if (!checkCreateParameters(message)) { return; }

              const westWorkspace = getWestWorkspace(
                vscode.Uri.parse(message.westWorkspacePath, true).fsPath);
              const board = getBoard(message.boardYamlPath);
              const sample = await getSample(message.samplePath);
              const toolchain =
                getIarToolchainForSdk(message.zephyrSdkPath) ??
                getZephyrSDK(vscode.Uri.parse(message.zephyrSdkPath, true).fsPath);

              vscode.commands.executeCommand(
                "zephyr-workbench-app-explorer.create-app",
                westWorkspace, sample, board, projectLoc,
                message.projectName, toolchain, message.pristine, message.venv, message.debugPreset);

            } else {
              const err = await validateProjectLocation(projectLoc);
              if (err) { vscode.window.showErrorMessage(err); return; }

              const hasBoard = !!message.boardYamlPath?.length;
              const hasSdk = !!message.zephyrSdkPath?.length;
              const hasWorkspace = !!message.westWorkspacePath?.length;

              if (!hasBoard && !hasSdk && !hasWorkspace) {
                /* local import – nothing else provided */
                vscode.commands.executeCommand(
                  "zephyr-workbench-app-explorer.import-local",
                  projectLoc, message.venv);
                vscode.window.showInformationMessage("Importing project using existing project configuration.");
                CreateZephyrAppPanel.currentPanel?.dispose();
              }
              const missing: string[] = [];
              if (!hasWorkspace) {missing.push("workspace");}
              if (!hasBoard) {missing.push("board");}
              if (!hasSdk) {missing.push("toolchain");}

              if (missing.length && missing.length < 3) {
                vscode.window.showInformationMessage(
                  `${missing.join(", ")} not provided, using existing project configuration.`);
              }

              /* resolve only what was provided */
              const westWorkspace = hasWorkspace
                ? getWestWorkspace(vscode.Uri.parse(message.westWorkspacePath, true).fsPath)
                : undefined;
              const board = hasBoard ? getBoard(message.boardYamlPath) : undefined;
              const toolchain = hasSdk
                ? (getIarToolchainForSdk(message.zephyrSdkPath) ??
                  getZephyrSDK(vscode.Uri.parse(message.zephyrSdkPath, true).fsPath))
                : undefined;

              await vscode.commands.executeCommand(
                "zephyr-workbench-app-explorer.import-app",
                projectLoc, westWorkspace, board, toolchain, message.venv);
              CreateZephyrAppPanel.currentPanel?.dispose();
              break;
            }
          }
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
        openLabel: 'Select',
      }).then(uri => {
        if (uri && uri.length > 0) {
          const selectedFolderUri = uri[0].fsPath;
          // Send the selected file URI back to the webview
          this._panel?.webview.postMessage({ command: 'folderSelected', folderUri: selectedFolderUri, id: 'projectParentPath' });
        }
      });
    }
  }
}

async function updateForm(webview: vscode.Webview, workspaceUri: string) {
  if (workspaceUri && workspaceUri.length > 0) {
    // Start timing discovery (Windows only) and warn if it exceeds 30 seconds
    let completed = false;
    let warningTimeout: ReturnType<typeof setTimeout> | undefined;
    if (process.platform === 'win32') {
      warningTimeout = setTimeout(() => {
        if (!completed) {
          vscode.window
            .showWarningMessage(
              'Searching boards is taking so long, this either due to a slow disk or you must add antivirus exclusion to your workspace',
              'Read more'
            )
            .then(choice => {
              if (choice === 'Read more') {
                vscode.env.openExternal(vscode.Uri.parse('https://z-workbench.com/docs/documentation/known-issues#slow-builds---exclude-workspace-from-antivirus'));
              }
            });
        }
      }, 30000);
    }

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
    for (let board of boards) {
      newBoardsHTML += `<div class="dropdown-item" data-value="${board.yamlFileUri.fsPath}" data-label="${board.name}">${board.name}<span class="description">(${board.identifier})</span></div>`;
    }
    webview.postMessage({ command: 'updateBoardDropdown', boardHTML: newBoardsHTML });

    const samples = await getListSamples(westWorkspace);
    const helloWorldPath = path.join('samples', 'hello_world');
    samples.sort((a, b) => {
      if (a.rootDir.fsPath.endsWith(helloWorldPath)) {
        return -99;
      }
      if (b.rootDir.fsPath.endsWith(helloWorldPath)) {
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
    for (let sample of samples) {
      newSamplesHTML += `<div class="dropdown-item" data-value="${sample.rootDir.fsPath}" data-label="${sample.name}">${sample.name}<span class="description">${sample.rootDir.fsPath}</span></div>`;
    }
    webview.postMessage({ command: 'updateSamplesDropdown', samplesHTML: newSamplesHTML });

    // Discovery completed; clear the warning timer
    completed = true;
    if (warningTimeout) { clearTimeout(warningTimeout); }
  }
}

async function updateBoardImage(webview: vscode.Webview, boardYamlPath: string) {
  if ((boardYamlPath && boardYamlPath.length > 0)) {
    const board = getBoard(boardYamlPath);
    if (fileExists(board.imagePath)) {
      const base64img = getBase64(board.imagePath);
      webview.postMessage({ command: 'updateBoardImage', imgPath: `data:image/jpeg;base64,${base64img}` });
    } else {
      webview.postMessage({ command: 'updateBoardImage', imgPath: 'noImg' });
    }
  }
}

function checkCreateParameters(message: any) {
  if (message.westWorkspacePath.length === 0) {
    vscode.window.showErrorMessage('Missing west workspace, please select a west workspace');
    return false;
  }

  if (message.zephyrSdkPath.length === 0) {
    vscode.window.showErrorMessage('Missing Zephyr SDK, a SDK is required to provide toolchain to your project');
    return false;
  }

  if (message.projectName.length === 0) {
    vscode.window.showErrorMessage('The project name is empty or invalid');
    return false;
  }

  if (message.projectName.indexOf(' ') >= 0) {
    vscode.window.showErrorMessage('The project name cannot contain spaces');
    return false;
  }

  if (message.boardYamlPath.length === 0) {
    vscode.window.showErrorMessage('Missing target board');
    return false;
  }

  if (message.samplePath === 0) {
    vscode.window.showErrorMessage('Missing selected sample, it serves as base for your project');
    return false;
  }

  return true;
}
