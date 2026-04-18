import * as vscode from "vscode";
import path from "path";
import { ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY } from "../constants";
import { normalizeZephyrToolchainVariant, ZephyrToolchainVariant } from "../models/ZephyrSDK";
import { WestWorkspace } from "../models/WestWorkspace";
import { WestWorkspaceTreeItem } from "../providers/WestWorkspaceDataProvider";
import { getOutputChannel } from "../utils/execUtils";
import { getSupportedBoards } from "../utils/zephyr/boardDiscovery";
import { fileExists, getAppTemplateDisplayPath, getArmGnuToolchainForPath, getBase64, getBoard, getListArmGnuToolchains, getListIARs, getListSamples, getListZephyrSDKs, getIarToolchainForSdk, getSample, getWestWorkspace, getWestWorkspaces, getZephyrSDK, validateProjectLocation } from "../utils/utils";
import { getNonce } from "../utilities/getNonce";
import { getUri } from "../utilities/getUri";

type CreateAppDiscoveryTarget = 'board' | 'sample';
type CreateAppDiscoveryIssueCode = 'invalid-workspace' | 'missing-workspace-content' | 'env-script' | 'invalid-venv' | 'generic';

interface CreateAppDiscoveryState {
  html: string;
  message?: string;
}

interface CreateAppDiscoveryIssue {
  code: CreateAppDiscoveryIssueCode;
  target: CreateAppDiscoveryTarget;
  userMessage: string;
  logMessage: string;
  settingsKey?: string;
}

interface CreateAppPanelErrorOptions {
  settingsKey?: string;
  workspaceToUpdate?: WestWorkspace;
}

export class CreateZephyrAppPanel {
  public static currentPanel: CreateZephyrAppPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _workspaceLoadRequestId = 0;
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
      const panel = vscode.window.createWebviewPanel("zephyr-workbench-new-app-panel", "Add Application", vscode.ViewColumn.One, {
        enableScripts: true,
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
    let workspacesHTML = '';
    for (const westWorkspace of getWestWorkspaces()) {
      workspacesHTML += `<div class="dropdown-item" data-value="${westWorkspace.rootUri}" data-label="${westWorkspace.name}">${westWorkspace.name}<span class="description">${westWorkspace.rootUri.fsPath}</span></div>`;
    }

    let sdkHTML = '';
    for (const sdk of await getListZephyrSDKs()) {
      sdkHTML += `<div class="dropdown-item" data-value="${sdk.rootUri}" data-label="${sdk.name}" data-has-llvm="${sdk.hasLlvmToolchain() ? 'true' : 'false'}">${sdk.name}<span class="description">${sdk.rootUri.fsPath}</span></div>`;
    }

    for (const iar of await getListIARs()) {
      const label = path.basename(iar.iarPath);
      sdkHTML += `<div class="dropdown-item" data-type="iar" data-value="${iar.iarPath}" data-label="${label}">IAR (${label})<span class="description">${iar.iarPath}</span></div>`;
    }

    for (const armGnuToolchain of await getListArmGnuToolchains()) {
      sdkHTML += `<div class="dropdown-item" data-type="gnuarmemb" data-value="${armGnuToolchain.toolchainPath}" data-label="${armGnuToolchain.name}">${armGnuToolchain.name}<span class="description">${armGnuToolchain.toolchainPath}</span></div>`;
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
          <title>Add Application</title>
        </head>
        <body class="create-app-panel">
          <h1>Add Application</h1>
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

                <div class="grid-group-div" id="toolchainVariantRow" style="display:none;">
                  <vscode-radio-group id="toolchainVariantGroup" orientation="horizontal">
                    <label slot="label">SDK Variant:</label>
                    <vscode-radio value="zephyr" checked>GNU GCC</vscode-radio>
                    <vscode-radio value="zephyr/llvm">LLVM CLANG</vscode-radio>
                  </vscode-radio-group>
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
                  <div id="boardStatus" class="combo-status" role="status" aria-live="polite" hidden></div>
                </div>

                <div class="grid-group-div">
                  <vscode-radio-group id="appFromGroup" orientation="horizontal">
                    <label slot="label">New or existing application?&nbsp;</label>
                    <vscode-radio value="create" checked>Create new application</vscode-radio>
                    <vscode-radio value="import">Import existing application</vscode-radio>
                  </vscode-radio-group>
                </div>

                <div class="grid-group-div create-only">
                  <div class="grid-header-div">
                    <label for="listBoards">Select template:</label>
                  </div>
                  <div id="listSamples" class="combo-dropdown grid-value-div">
                    <div class="combo-dropdown-input">
                      <input type="text" id="sampleInput" class="combo-dropdown-control" placeholder="Choose a sample or test as base..." data-value="">
                      <div aria-hidden="true" class="indicator" part="indicator">
                        <slot name="indicator">  
                          <svg class="select-indicator" part="select-indicator" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                            <path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"></path>
                          </svg>
                        </slot>
                      </div>
                    </div>
                    <div class="combo-dropdown-controls">
                      <div id="samplesDropdownSpinner" class="spinner" aria-label="Loading sample and test projects"></div>
                    </div>
                    <div id="samplesDropdown" class="dropdown-content"></div>
                  </div>
                  <div id="sampleStatus" class="combo-status" role="status" aria-live="polite" hidden></div>
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
            this._workspaceLoadRequestId = Number(message.requestId) || 0;
            await updateForm(webview, message.workspace, this._workspaceLoadRequestId, () => this._workspaceLoadRequestId);
            break;
          case 'boardChanged':
            await updateBoardImage(webview, message.boardYamlPath);
            break;
          case 'openLocationDialog': {
            const westWorkspaceRootPath = getStringValue(message.westWorkspaceRootPath);
            if (westWorkspaceRootPath.length > 0) {
              this.openLocationDialog(vscode.Uri.parse(westWorkspaceRootPath, false));
            } else {
              this.openLocationDialog(undefined);
            }
            break;
          }
          case "create":
            try {
              await handleCreateMessage(message);
            } catch (error) {
              const issue = normalizeCreateActionIssue(error);
              logCreateAppPanelError('Failed to prepare application command', issue.logMessage);
              await showCreateAppPanelError(issue.userMessage, { settingsKey: issue.settingsKey });
            }
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
        openLabel: 'Select',
      }).then(uri => {
        if (uri && uri.length > 0) {
          const selectedFolderUri = uri[0].fsPath;
          this._panel?.webview.postMessage({ command: 'folderSelected', folderUri: selectedFolderUri, id: 'projectParentPath' });
        }
      });
    }
  }
}

async function updateForm(
  webview: vscode.Webview,
  workspaceUri: string,
  requestId: number,
  getCurrentRequestId: () => number
) {
  if (!workspaceUri || workspaceUri.length === 0) {
    return;
  }

  let completed = false;
  let warningTimeout: ReturnType<typeof setTimeout> | undefined;
  const finishDiscovery = () => {
    completed = true;
    if (warningTimeout) {
      clearTimeout(warningTimeout);
      warningTimeout = undefined;
    }
  };

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

  try {
    const westWorkspace = resolveSelectedWorkspace(workspaceUri);
    const [boardsResult, samplesResult] = await Promise.allSettled([
      buildBoardsDiscoveryState(westWorkspace),
      buildSamplesDiscoveryState(westWorkspace),
    ]);

    if (!isActiveDiscoveryRequest(requestId, getCurrentRequestId)) {
      return;
    }

    const issues: CreateAppDiscoveryIssue[] = [];

    if (boardsResult.status === 'fulfilled') {
      postDiscoveryState(webview, requestId, 'board', 'ready', boardsResult.value);
    } else {
      const issue = normalizeDiscoveryIssue('board', boardsResult.reason);
      issues.push(issue);
      postDiscoveryState(webview, requestId, 'board', 'error', { message: issue.userMessage });
      logCreateAppPanelError('Failed to load boards', issue.logMessage);
    }

    if (samplesResult.status === 'fulfilled') {
      postDiscoveryState(webview, requestId, 'sample', 'ready', samplesResult.value);
    } else {
      const issue = normalizeDiscoveryIssue('sample', samplesResult.reason);
      issues.push(issue);
      postDiscoveryState(webview, requestId, 'sample', 'error', { message: issue.userMessage });
      logCreateAppPanelError('Failed to load sample or test projects', issue.logMessage);
    }

    if (issues.length > 0) {
      finishDiscovery();
      await showDiscoveryIssues(issues, westWorkspace);
    }
  } catch (error) {
    if (!isActiveDiscoveryRequest(requestId, getCurrentRequestId)) {
      return;
    }

    const boardIssue = normalizeDiscoveryIssue('board', error);
    const sampleIssue = normalizeDiscoveryIssue('sample', error);

    postDiscoveryState(webview, requestId, 'board', 'error', { message: boardIssue.userMessage });
    postDiscoveryState(webview, requestId, 'sample', 'error', { message: sampleIssue.userMessage });

    logCreateAppPanelError('Failed to resolve selected workspace', boardIssue.logMessage);
    finishDiscovery();
    await showDiscoveryIssues([boardIssue, sampleIssue]);
  } finally {
    finishDiscovery();
  }
}

async function updateBoardImage(webview: vscode.Webview, boardYamlPath: string) {
  try {
    if (boardYamlPath && boardYamlPath.length > 0) {
      const board = getBoard(boardYamlPath);
      if (fileExists(board.imagePath)) {
        const base64img = getBase64(board.imagePath);
        webview.postMessage({ command: 'updateBoardImage', imgPath: `data:image/jpeg;base64,${base64img}` });
      } else {
        webview.postMessage({ command: 'updateBoardImage', imgPath: 'noImg' });
      }
      return;
    }
  } catch (error) {
    logCreateAppPanelError('Failed to load board image', getErrorDetails(error));
  }

  webview.postMessage({ command: 'updateBoardImage', imgPath: 'noImg' });
}

async function handleCreateMessage(message: any) {
  const projectLoc = message.projectParentPath;
  const isCreate = message.appFrom === "create";
  const toolchainVariant = getRequestedToolchainVariant(message.toolchainVariant);
  const westWorkspaceRootPath = getStringValue(message.westWorkspaceRootPath);
  const zephyrSdkPath = getStringValue(message.zephyrSdkPath);

  if (isCreate) {
    if (!checkCreateParameters(message)) {
      return;
    }

    const westWorkspace = getWestWorkspace(
      vscode.Uri.parse(westWorkspaceRootPath, true).fsPath
    );
    const board = getBoard(message.boardYamlPath, message.boardIdentifier);
    const sample = await getSample(message.samplePath);
    const toolchain =
      getArmGnuToolchainForPath(zephyrSdkPath)
      ?? getIarToolchainForSdk(zephyrSdkPath)
      ?? getZephyrSDK(vscode.Uri.parse(zephyrSdkPath, true).fsPath);

    vscode.commands.executeCommand(
      "zephyr-workbench-app-explorer.create-app",
      westWorkspace,
      sample,
      board,
      projectLoc,
      message.projectName,
      toolchain,
      message.pristine,
      message.venv,
      message.debugPreset,
      toolchainVariant,
    );
    return;
  }

  const err = await validateProjectLocation(projectLoc);
  if (err) {
    vscode.window.showErrorMessage(err);
    return;
  }

  const hasBoard = !!message.boardYamlPath?.length;
  const hasSdk = zephyrSdkPath.length > 0;
  const hasWorkspace = westWorkspaceRootPath.length > 0;

  if (!hasBoard && !hasSdk && !hasWorkspace) {
    vscode.commands.executeCommand(
      "zephyr-workbench-app-explorer.import-local",
      projectLoc,
      message.venv
    );
    vscode.window.showInformationMessage("Importing project using existing project configuration.");
    CreateZephyrAppPanel.currentPanel?.dispose();
    return;
  }

  const missing: string[] = [];
  if (!hasWorkspace) {
    missing.push("workspace");
  }
  if (!hasBoard) {
    missing.push("board");
  }
  if (!hasSdk) {
    missing.push("toolchain");
  }

  if (missing.length && missing.length < 3) {
    vscode.window.showInformationMessage(
      `${missing.join(", ")} not provided, using existing project configuration.`
    );
  }

  const westWorkspace = hasWorkspace
    ? getWestWorkspace(vscode.Uri.parse(westWorkspaceRootPath, true).fsPath)
    : undefined;
  const board = hasBoard ? getBoard(message.boardYamlPath, message.boardIdentifier) : undefined;
  const toolchain = hasSdk
    ? (
        getArmGnuToolchainForPath(zephyrSdkPath)
        ?? getIarToolchainForSdk(zephyrSdkPath)
        ?? getZephyrSDK(vscode.Uri.parse(zephyrSdkPath, true).fsPath)
      )
    : undefined;

  await vscode.commands.executeCommand(
    "zephyr-workbench-app-explorer.import-app",
    projectLoc,
    westWorkspace,
    board,
    toolchain,
    message.venv,
    toolchainVariant,
  );
  CreateZephyrAppPanel.currentPanel?.dispose();
}

function getRequestedToolchainVariant(rawVariant: unknown): ZephyrToolchainVariant {
  return normalizeZephyrToolchainVariant(typeof rawVariant === 'string' ? rawVariant : undefined);
}

function resolveSelectedWorkspace(workspaceUri: string): WestWorkspace {
  const workspacePath = vscode.Uri.parse(workspaceUri, true).fsPath;
  return getWestWorkspace(workspacePath);
}

async function buildBoardsDiscoveryState(westWorkspace: WestWorkspace): Promise<CreateAppDiscoveryState> {
  await ensureWorkspaceDirectoryExists(
    westWorkspace.boardsDirUri,
    'boards',
    'The workspace boards folder could not be found. This workspace may not have been imported correctly. Try running west update or reimporting the workspace.'
  );

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

  let html = '';
  for (const board of boards) {
    html += `<div class="dropdown-item" data-value="${board.yamlFileUri.fsPath}" data-board-identifier="${board.identifier}" data-label="${board.name}">${board.name}<span class="description">(${board.identifier})</span></div>`;
  }

  return {
    html,
    message: html.length === 0 ? 'No boards were found for this workspace.' : undefined,
  };
}

async function buildSamplesDiscoveryState(westWorkspace: WestWorkspace): Promise<CreateAppDiscoveryState> {
  await ensureWorkspaceDirectoryExists(
    westWorkspace.samplesDirUri,
    'samples',
    'The workspace samples folder could not be found. This workspace may not have been imported correctly. Try running west update or reimporting the workspace.'
  );

  const appTemplates = await getListSamples(westWorkspace);
  const helloWorldPath = path.join('samples', 'hello_world');
  const sortTemplates = (a: typeof appTemplates[number], b: typeof appTemplates[number]) => {
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
  };
  const samples = appTemplates
    .filter(template => template.kind === 'sample')
    .sort(sortTemplates);
  const tests = appTemplates
    .filter(template => template.kind === 'test')
    .sort(sortTemplates);

  let html = '';
  if (samples.length > 0) {
    html += '<div class="dropdown-header">SAMPLES</div>';
    for (const sample of samples) {
      html += `<div class="dropdown-item" data-value="${sample.rootDir.fsPath}" data-label="${sample.name}">${sample.name}<span class="description">${getAppTemplateDisplayPath(sample.rootDir.fsPath, westWorkspace)}</span></div>`;
    }
  }

  if (tests.length > 0) {
    html += '<div class="dropdown-header">TESTS</div>';
    for (const sample of tests) {
      html += `<div class="dropdown-item" data-value="${sample.rootDir.fsPath}" data-label="${sample.name}">${sample.name}<span class="description">${getAppTemplateDisplayPath(sample.rootDir.fsPath, westWorkspace)}</span></div>`;
    }
  }

  return {
    html,
    message: html.length === 0 ? 'No sample or test projects were found for this workspace.' : undefined,
  };
}

function postDiscoveryState(
  webview: vscode.Webview,
  requestId: number,
  target: CreateAppDiscoveryTarget,
  status: 'ready' | 'error',
  payload: Partial<CreateAppDiscoveryState> = {}
) {
  webview.postMessage({
    command: 'setDiscoveryState',
    requestId,
    target,
    status,
    ...payload,
  });
}

function isActiveDiscoveryRequest(requestId: number, getCurrentRequestId: () => number): boolean {
  return requestId === getCurrentRequestId();
}

function normalizeDiscoveryIssue(target: CreateAppDiscoveryTarget, error: unknown): CreateAppDiscoveryIssue {
  const details = getErrorDetails(error);
  const normalized = details.toLowerCase();

  if (
    normalized.includes('not a valid west workspace')
    || normalized.includes('cannot parse the west workspace')
    || normalized.includes('not a west workspace')
  ) {
    return {
      code: 'invalid-workspace',
      target,
      userMessage: target === 'board'
        ? 'Boards are unavailable until a valid west workspace is selected.'
        : 'Sample and test projects are unavailable until a valid west workspace is selected.',
      logMessage: details,
    };
  }

  if (normalized.includes('missing zephyr env script')) {
    return {
      code: 'env-script',
      target,
      userMessage: target === 'board'
        ? 'Boards could not be loaded because the Zephyr environment setting needs attention.'
        : 'Sample and test projects could not be loaded because the Zephyr environment setting needs attention.',
      logMessage: details,
      settingsKey: buildWorkbenchSettingKey(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY),
    };
  }

  if (normalized.includes('invalid venv path')) {
    return {
      code: 'invalid-venv',
      target,
      userMessage: target === 'board'
        ? 'Boards could not be loaded because the Python environment setting needs attention.'
        : 'Sample and test projects could not be loaded because the Python environment setting needs attention.',
      logMessage: details,
      settingsKey: buildWorkbenchSettingKey(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY),
    };
  }

  if (
    normalized.includes('workspace boards folder could not be found')
    || normalized.includes('workspace samples folder could not be found')
  ) {
    return {
      code: 'missing-workspace-content',
      target,
      userMessage: target === 'board'
        ? 'Boards could not be loaded because this workspace looks incomplete. Try running west update or reimporting the workspace.'
        : 'Sample and test projects could not be loaded because this workspace looks incomplete. Try running west update or reimporting the workspace.',
      logMessage: details,
    };
  }

  return {
    code: 'generic',
    target,
    userMessage: target === 'board'
      ? 'Boards could not be loaded for this workspace.'
      : 'Sample and test projects could not be loaded for this workspace.',
    logMessage: details,
  };
}

function normalizeCreateActionIssue(error: unknown) {
  const details = getErrorDetails(error);
  const normalized = details.toLowerCase();

  if (
    normalized.includes('not a valid west workspace')
    || normalized.includes('cannot parse the west workspace')
    || normalized.includes('not a west workspace')
  ) {
    return {
      userMessage: 'The selected west workspace is no longer valid. Please choose it again.',
      logMessage: details,
    };
  }

  if (normalized.includes('cannot parse the sample or test folder')) {
    return {
      userMessage: 'The selected sample or test project is no longer available. Please choose another one.',
      logMessage: details,
    };
  }

  if (normalized.includes('missing zephyr env script')) {
    return {
      userMessage: 'The application could not be prepared because the Zephyr environment setting needs attention.',
      logMessage: details,
      settingsKey: buildWorkbenchSettingKey(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY),
    };
  }

  if (normalized.includes('invalid venv path')) {
    return {
      userMessage: 'The application could not be prepared because the Python environment setting needs attention.',
      logMessage: details,
      settingsKey: buildWorkbenchSettingKey(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY),
    };
  }

  return {
    userMessage: 'The application could not be prepared. Please review the selected workspace, toolchain, board, and base app.',
    logMessage: details,
  };
}

async function showDiscoveryIssues(
  issues: CreateAppDiscoveryIssue[],
  workspaceToUpdate?: WestWorkspace
) {
  const commonSettingsKey = getCommonSettingsKey(issues);
  const message = buildDiscoveryIssuesMessage(issues);
  await showCreateAppPanelError(message, {
    settingsKey: commonSettingsKey,
    workspaceToUpdate: issues.some(issue => issue.code === 'missing-workspace-content')
      ? workspaceToUpdate
      : undefined,
  });
}

function buildDiscoveryIssuesMessage(issues: CreateAppDiscoveryIssue[]): string {
  if (issues.length === 0) {
    return 'Boards and sample or test projects could not be loaded for this workspace.';
  }

  if (issues.length === 1) {
    return issues[0].userMessage;
  }

  const firstCode = issues[0].code;
  const sameCode = issues.every(issue => issue.code === firstCode);
  if (sameCode) {
    switch (firstCode) {
      case 'invalid-workspace':
        return 'The selected workspace is not a valid west workspace. Please choose a different workspace and try again.';
      case 'missing-workspace-content':
        return 'This workspace looks incomplete. The boards or samples folder is missing. Try running west update or reimporting the workspace.';
      case 'env-script':
        return 'Boards and sample or test projects could not be loaded because the Zephyr environment setting needs attention.';
      case 'invalid-venv':
        return 'Boards and sample or test projects could not be loaded because the Python environment setting needs attention.';
      default:
        break;
    }
  }

  return 'Boards and sample or test projects could not be loaded for this workspace.';
}

function getCommonSettingsKey(issues: CreateAppDiscoveryIssue[]): string | undefined {
  if (issues.length === 0) {
    return undefined;
  }

  const firstSettingsKey = issues[0].settingsKey;
  if (!firstSettingsKey) {
    return undefined;
  }

  return issues.every(issue => issue.settingsKey === firstSettingsKey)
    ? firstSettingsKey
    : undefined;
}

async function showCreateAppPanelError(message: string, options: CreateAppPanelErrorOptions = {}) {
  const openLogItem = 'Open Log';
  const openSettingsItem = 'Open Settings';
  const updateWorkspaceItem = 'Update Workspace';
  const actions: string[] = [];

  if (options.workspaceToUpdate) {
    actions.push(updateWorkspaceItem);
  }
  if (options.settingsKey) {
    actions.push(openSettingsItem);
  }
  actions.push(openLogItem);

  const choice = await vscode.window.showErrorMessage(message, ...actions);

  if (choice === updateWorkspaceItem && options.workspaceToUpdate) {
    await updateWorkspaceFromCreateAppPanel(options.workspaceToUpdate);
  } else if (choice === openSettingsItem && options.settingsKey) {
    await vscode.commands.executeCommand('workbench.action.openSettings', options.settingsKey);
  } else if (choice === openLogItem) {
    getOutputChannel().show(true);
  }
}

async function updateWorkspaceFromCreateAppPanel(westWorkspace: WestWorkspace) {
  try {
    const treeItem = new WestWorkspaceTreeItem(westWorkspace, vscode.TreeItemCollapsibleState.Collapsed);
    await vscode.commands.executeCommand('zephyr-workbench-west-workspace.update', treeItem);
  } catch (error) {
    const details = getErrorDetails(error);
    logCreateAppPanelError('Failed to update workspace from Add Application panel', details);
    await vscode.window.showErrorMessage(
      'The workspace could not be updated. Please review the log and try again.',
      'Open Log'
    ).then(choice => {
      if (choice === 'Open Log') {
        getOutputChannel().show(true);
      }
    });
  }
}

async function ensureWorkspaceDirectoryExists(
  directoryUri: vscode.Uri,
  folderLabel: 'boards' | 'samples',
  missingMessage: string
) {
  try {
    const stat = await vscode.workspace.fs.stat(directoryUri);
    if ((stat.type & vscode.FileType.Directory) !== vscode.FileType.Directory) {
      throw new Error(missingMessage);
    }
  } catch (error) {
    const code = (error as vscode.FileSystemError | undefined)?.code;
    if (code === 'FileNotFound') {
      throw new Error(missingMessage);
    }
    if (error instanceof Error && error.message === missingMessage) {
      throw error;
    }
    throw new Error(`The workspace ${folderLabel} folder could not be checked. This workspace may not have been imported correctly. Try running west update or reimporting the workspace.`);
  }
}

function buildWorkbenchSettingKey(settingKey: string): string {
  return `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${settingKey}`;
}

function logCreateAppPanelError(context: string, details: string) {
  getOutputChannel().appendLine(`[CreateZephyrAppPanel] ${context}: ${details}`);
}

function getErrorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function getStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isMissingValue(value: unknown): boolean {
  return getStringValue(value).length === 0;
}

function checkCreateParameters(message: any) {
  if (isMissingValue(message.westWorkspaceRootPath)) {
    vscode.window.showErrorMessage('Missing west workspace, please select a west workspace');
    return false;
  }

  if (isMissingValue(message.zephyrSdkPath)) {
    vscode.window.showErrorMessage('Missing Zephyr SDK, a SDK is required to provide toolchain to your project');
    return false;
  }

  if (isMissingValue(message.projectName)) {
    vscode.window.showErrorMessage('The project name is empty or invalid');
    return false;
  }

  if (getStringValue(message.projectName).indexOf(' ') >= 0) {
    vscode.window.showErrorMessage('The project name cannot contain spaces');
    return false;
  }

  if (isMissingValue(message.boardYamlPath)) {
    vscode.window.showErrorMessage('Missing target board');
    return false;
  }

  if (isMissingValue(message.samplePath)) {
    vscode.window.showErrorMessage('Missing selected sample or test app, it serves as base for your project');
    return false;
  }

  return true;
}
