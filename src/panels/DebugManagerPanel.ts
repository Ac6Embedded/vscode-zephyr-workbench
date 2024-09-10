import * as vscode from 'vscode';
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";
import { createLaunchString, createWestWrapper, getDebugRunners, getRunner } from "../debugUtils";
import { ZephyrAppProject } from "../ZephyrAppProject";
import { getWestWorkspace } from '../utils';
import { createLaunchJson } from '../ZephyrTaskProvider';

export class DebugManagerPanel {
  public static currentPanel: DebugManagerPanel | undefined;
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
    if (DebugManagerPanel.currentPanel) {
      DebugManagerPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
    } else {
      const panel = vscode.window.createWebviewPanel("debug-manager-panel", "Debug Manager", vscode.ViewColumn.One, {
        // Enable javascript in the webview
        enableScripts: true,
        // Restrict the webview to only load resources from the `out` directory
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out')]
      });

      DebugManagerPanel.currentPanel = new DebugManagerPanel(panel, extensionUri);
      DebugManagerPanel.currentPanel.createContent();
    }
  }

  public dispose() {
    DebugManagerPanel.currentPanel = undefined;
    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private async _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
    const webviewUri = getUri(webview, extensionUri, ["out", "debugmanager.js"]);
    const styleUri = getUri(webview, extensionUri, ["out", "style.css"]);
    const nonce = getNonce();

    let applicationsHTML: string = '';

    for(let workspaceFolder of vscode.workspace.workspaceFolders as vscode.WorkspaceFolder[]) {
      if(await ZephyrAppProject.isZephyrProjectWorkspaceFolder(workspaceFolder)) {
        const appProject = new ZephyrAppProject(workspaceFolder, workspaceFolder.uri.fsPath);
        applicationsHTML = applicationsHTML.concat(`<div class="dropdown-item" data-value="${appProject.sourceDir}" data-label="${appProject.folderName}">${appProject.folderName} <span class="description">${appProject.sourceDir}</span></div>`);
      }
    }


    let runnersHTML: string = '';
    for(let runner of getDebugRunners()) {
      runnersHTML = runnersHTML.concat(`<div class="dropdown-item" data-value="${runner.name}" data-label="${runner.name}">${runner.name}</div>`);
    }
  
    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
          <link rel="stylesheet" href="${styleUri}">
          <title>Debug Manager</title>
        </head>
        
        <body>
          <h1>Debug Manager</h1>
          <form>
            <!-- Select Application Project -->
            <div class="grid-group-div">
              <div class="grid-header-div">
                <label for="listApplications">Select the application to debug:</label>
              </div>
              <div id="listApplications" class="combo-dropdown grid-value-div">
                <input type="text" id="applicationInput" class="combo-dropdown-control" placeholder="Choose application..." data-value="">
                <div aria-hidden="true" class="indicator" part="indicator">
                  <slot name="indicator">  
                    <svg class="select-indicator" part="select-indicator" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                      <path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"></path>
                    </svg>
                  </slot>
                </div>
                <div id="applicationsDropdown" class="dropdown-content" style="display: none;">
                  ${applicationsHTML}
                </div>
              </div>
            </div>


            <!-- GDB 
              - path (inside sdk)
              - address
              - port
            -->
            <fieldset>
              <legend>GDB</legend> 
              <div class="grid-group-div">
                <vscode-text-field size="50" type="text" id="gdbPath" value="">GDB Path:</vscode-text-field>
                <vscode-button id="browseLocationButton" class="browse-input-button" style="vertical-align: middle">Browse...</vscode-button>
              </div>

              <div class="grid-group-div">
                <vscode-text-field size="50" type="text" id="gdbPath" value="localhost">GDB Address:</vscode-text-field>
              </div>

              <div class="grid-group-div">
                <vscode-text-field size="50" type="text" id="gdbPath" value="3333">GDB Port:</vscode-text-field>
              </div>
            </fieldset>

            <!-- Debug server
              - path if required
              - address
              - port
            -->
            <fieldset>
              <legend>Debug Server</legend> 
              <div class="grid-group-div">
                <div class="grid-header-div">
                  <label for="listRunners">Select the runner:</label>
                </div>
                <div id="listRunners" class="combo-dropdown grid-value-div">
                  <input type="text" id="runnerInput" class="combo-dropdown-control" placeholder="Choose debug runner..." data-value="">
                  <div aria-hidden="true" class="indicator" part="indicator">
                    <slot name="indicator">  
                      <svg class="select-indicator" part="select-indicator" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                        <path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"></path>
                      </svg>
                    </slot>
                  </div>
                  <div id="runnersDropdown" class="dropdown-content" style="display: none;">
                    ${runnersHTML}
                  </div>
                </div>
              </div>
            </fieldset>

            <!-- Debug button -->
            <div class="grid-group-div">
              <vscode-button id="debugButton" class="finish-input-button">Debug</vscode-button>
            <div>
          </form>
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
            let projectPath = message.project;
            let runnerName = message.runner;
            let appProject;

            for(let workspaceFolder of vscode.workspace.workspaceFolders as vscode.WorkspaceFolder[]) {
              if(await ZephyrAppProject.isZephyrProjectWorkspaceFolder(workspaceFolder)) {
                if(workspaceFolder.uri.fsPath === projectPath) {
                  appProject = new ZephyrAppProject(workspaceFolder, workspaceFolder.uri.fsPath);
                  break;
                }
              }
            }
            
            if(appProject) {
              const runner = getRunner(runnerName);
              const westWorkspace = getWestWorkspace(appProject.westWorkspacePath);

              createWestWrapper(appProject, westWorkspace);
              const value = createLaunchString();
              vscode.window.showInformationMessage(value);
            }

            break;
          default:
            break;
        }
      },
      undefined,
      this._disposables
    );
  }
}