import * as vscode from "vscode";
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";
import { execCommandWithEnv, getGitTags, getGitBranches } from "../execUtils";
import { listHals } from "../manifestUtils";

export class CreateWestWorkspacePanel {
  public static currentPanel: CreateWestWorkspacePanel | undefined;
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
        openLabel: 'Select',
      }).then(uri => {
        if (uri && uri.length > 0) {
          const selectedFileUri = uri[0];
          // Send the selected file URI back to the webview
          this._panel?.webview.postMessage({ command: 'fileSelected', fileUri: selectedFileUri });
        }
      });
    }
  }

  public openManifestDialog() {
    if (this._panel) {
      vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Select',
        filters: {
          'Manifest files': ['yml'],
          'All files': ['*']
        }
      }).then(uri => {
        if (uri && uri.length > 0) {
          const selectedFileUri = uri[0].fsPath;
          // Send the selected file URI back to the webview
          this._panel?.webview.postMessage({ command: 'manifestSelected', fileUri: selectedFileUri, id: 'manifestPath' });
        }
      });
    }
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
    if (CreateWestWorkspacePanel.currentPanel) {
      CreateWestWorkspacePanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
    } else {
      const panel = vscode.window.createWebviewPanel("create-west-workspace-panel", "Create west workspace", vscode.ViewColumn.One, {
        // Enable javascript in the webview
        enableScripts: true,
        // Restrict the webview to only load resources from the `out` directory
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out')]
      });

      panel.iconPath = {
      	light: vscode.Uri.joinPath(extensionUri, 'res', 'icons', 'zephyr.svg'),
      	dark: vscode.Uri.joinPath(extensionUri, 'res', 'icons', 'zephyr.svg')
      };

      CreateWestWorkspacePanel.currentPanel = new CreateWestWorkspacePanel(panel, extensionUri);
    }
  }

  public dispose() {
    CreateWestWorkspacePanel.currentPanel = undefined;

    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
  const webviewUri = getUri(webview, extensionUri, ["out", "createwestworkspace.js"]);
  const styleUri = getUri(webview, extensionUri, ["out", "style.css"]);
  const codiconUri = getUri(webview, extensionUri, ["out", "codicon.css"]);
  const nonce = getNonce();
    
    let templatesHTML = '';
    for(let hal of listHals) {
      templatesHTML = templatesHTML.concat(`<div class="dropdown-item" data-value="${hal.name}" data-label="${hal.label}">${hal.label}</div>`);
    }
  
    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
          <link rel="stylesheet" href="${styleUri}">
          <link rel="stylesheet" href="${codiconUri}">
          <title>Create west workspace</title>
        </head>
        
        <body>
          <h1>Create west workspace</h1>
          <a class="help-link" href="https://zephyr-workbench.com/docs/documentation/west-workspace">Read Docs</a>
          <form>
            <div class="grid-group-div">
              <vscode-radio-group id="srcType" orientation="vertical">
                <label slot="label">Source location:</label>
                <vscode-radio value="template" checked>Minimal from template</vscode-radio>
                <vscode-radio value="remote">Repository</vscode-radio>
                <vscode-radio value="local">Local folder</vscode-radio>
                <vscode-radio value="manifest">Local manifest</vscode-radio>
              </vscode-radio-group>
            </div>
          </form>
          <form>
            <div class="grid-group-div">
              <vscode-text-field size="50" type="url" id="remotePath" value="https://github.com/zephyrproject-rtos">Path:</vscode-text-field>
            </div>

            <div class="grid-group-div" id="templatesGroup">
              <div class="grid-header-div">
                <label for="listTemplates">Template:</label>
              </div>
              <div id="listTemplates" class="combo-dropdown grid-value-div">
                <input type="text" id="templateInput" class="combo-dropdown-control" placeholder="Choose a template..." data-value="">
                <div aria-hidden="true" class="indicator" part="indicator">
                  <slot name="indicator">  
                    <svg class="select-indicator" part="select-indicator" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                      <path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"></path>
                    </svg>
                  </slot>
                </div>
                <div id="templatesDropdown" class="dropdown-content">
                  ${templatesHTML}
                </div>
              </div>
            </div>

            <div class="grid-group-div" id="branchGroup">
              <div class="grid-header-div">
                <label for="listBranch">Revision:</label>
              </div>
              <div id="listBranch" class="combo-dropdown grid-value-div">
                <input type="text" id="branchInput" class="combo-dropdown-control" placeholder="Choose the working revision..." data-value="">
                <div aria-hidden="true" class="indicator" part="indicator">
                  <slot name="indicator">  
                    <svg class="select-indicator" part="select-indicator" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                      <path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"></path>
                    </svg>
                  </slot>
                </div>
                <button id="branchRefreshButton" class="inline-icon-button codicon codicon-refresh" title="Refresh tags" aria-label="Refresh tags" type="button"></button>
                <div id="branchLoadingSpinner" class="spinner" aria-label="Loading revisions"></div>
                <div id="branchDropdown" class="dropdown-content">
                </div>
              </div>
            </div>

            <div class="grid-group-div" id="manifestGroup">
              <vscode-text-field class="browse-field" size="50" type="text" id="manifestPath" placeholder="(Optional)">Manifest:</vscode-text-field>
              <vscode-button id="browseManifestButton" class="browse-input-button" style="vertical-align: middle">Browse...</vscode-button>
            </div>

            <div class="grid-group-div" id="locationGroup">
              <vscode-text-field class="browse-field" size="50" type="text" id="workspacePath" value="">Location:</vscode-text-field>
              <vscode-button id="browseLocationButton" class="browse-input-button" style="vertical-align: middle">Browse...</vscode-button>
            </div>

            <div class="grid-group-div">
              <vscode-button id="importButton" class="finish-input-button">Import</vscode-button>
            <div>
          </form>
          <script type="module" nonce="${nonce}" src="${webviewUri}"></script>
        </body>
      </html>
    `;
  }

  private updateBranches(webview: vscode.Webview, remotePath: string, srcType: string, clear?: boolean) {
    let zephyrRepoUrl = remotePath;
    
    if(srcType === 'template' && !remotePath.endsWith('/zephyr') && !remotePath.endsWith('/zephyr/')) {
      zephyrRepoUrl = remotePath.concat('');
    }
    
    Promise.all([
      getGitTags(zephyrRepoUrl),
      getGitBranches(zephyrRepoUrl)
    ])
      .then(([tags, branches]) => {
        console.log('Got tags:', tags.length, 'branches:', branches.length);
        let newBranchHTML = '';
        
        // Add tags section 
        if(tags && tags.length > 0) {
          newBranchHTML += '<div class="dropdown-header">TAGS</div>';
          for(let tag of tags) {
            newBranchHTML += `<div class="dropdown-item" data-value="${tag}" data-label="${tag}">${tag}</div>`;
          }
        }
        
        // Add branches section 
        if(branches && branches.length > 0) {
          newBranchHTML += '<div class="dropdown-header">BRANCHES</div>';
          for(let branch of branches) {
            newBranchHTML += `<div class="dropdown-item" data-value="${branch}" data-label="${branch}">${branch}</div>`;
          }
        }
        
        // If clear is true, don't set a default value
        const branchValue = clear ? '' : (tags && tags.length > 0 ? tags[0] : (branches && branches.length > 0 ? branches[0] : ''));
        webview.postMessage({ command: 'updateBranchDropdown', branchHTML: newBranchHTML, branch: branchValue });
      })
      .catch(error => {
        console.error('Error fetching tags/branches:', error);
        webview.postMessage({ command: 'updateBranchDropdown', branchHTML: '<div class="dropdown-header" style="color: var(--vscode-errorForeground);">Error: Repository not found or not accessible</div>', branch: '' });
      });
  }

  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
      (message: any) => {
        const command = message.command;
        let srcType;
        let remotePath;
        let remoteBranch;
        let workspacePath;
        let manifestPath;
        let templateHal;

        switch (command) {
          case 'debug':
            vscode.window.showInformationMessage(message.text);
            return;
          case 'openFileDialog':
            this.openFileDialog();
            break;
          case 'openLocationDialog':
            this.openLocationDialog();
            break;
          case 'openManifestDialog':
            this.openManifestDialog();
            break;
          case 'remotePathChanged':
            this.updateBranches(webview, message.remotePath, message.srcType, !!message.clear);
            break;
          case 'create':
            srcType = message.srcType;
            remotePath = message.remotePath;
            remoteBranch = message.remoteBranch;
            workspacePath = message.workspacePath;
            manifestPath = message.manifestPath;
            templateHal = message.templateHal;

            if(srcType === 'remote') {
              vscode.commands.executeCommand("west.init", remotePath, remoteBranch, workspacePath, manifestPath);
            } else if(srcType === 'local') {
              vscode.commands.executeCommand("zephyr-workbench-west-workspace.import-local", workspacePath);
            } else if(srcType === 'manifest') {
              vscode.commands.executeCommand("west.init", '', '', workspacePath, manifestPath);
            } else if(srcType === 'template') {
              vscode.commands.executeCommand("zephyr-workbench-west-workspace.import-from-template", remotePath, remoteBranch, workspacePath, templateHal);
            } 
            break;
        }
      },
      undefined,
      this._disposables
    );
  }
  
}
