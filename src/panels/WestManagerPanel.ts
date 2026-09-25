import * as vscode from 'vscode';
import { ZEPHYR_DOCS_BASE_URL } from '../constants';
import { getUri } from '../utilities/getUri';
import { getNonce } from '../utilities/getNonce';
import { WestWorkspace } from '../models/WestWorkspace';
import { westBoardsCommand, westUpdateCommand } from '../commands/WestCommands';
import { getGitBranches, getGitTags } from '../utils/execUtils';
import {
  applyWorkspaceState as writeWorkspaceState, getWorkspaceDetails as readWorkspaceDetails, manifestWorkspaceOf,
  WestManagerApplyState, WestManagerWorkspaceDetails, WestManagerWorkspaceSummary,
} from '../utils/zephyr/westManifestEdit';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getWestWorkspaces(): WestWorkspace[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const workspaces: WestWorkspace[] = [];
  for (const folder of folders) {
    if (!WestWorkspace.isWestWorkspaceFolder(folder)) {
      continue;
    }

    try {
      workspaces.push(new WestWorkspace(folder.name, folder.uri));
    } catch {
      // Ignore malformed workspace entries in the manager list.
    }
  }
  return workspaces;
}

function getWorkspaceByPath(rootPath: string): WestWorkspace | undefined {
  return getWestWorkspaces().find(workspace => workspace.rootUri.fsPath === rootPath);
}

/* The details of a workspace of this window, read the same way the tool reads them. */
function getWorkspaceDetails(westWorkspace: WestWorkspace): WestManagerWorkspaceDetails {
  return readWorkspaceDetails(manifestWorkspaceOf(westWorkspace));
}

function applyWorkspaceState(state: WestManagerApplyState): WestManagerWorkspaceDetails {
  const westWorkspace = getWorkspaceByPath(state.rootPath);
  if (!westWorkspace) {
    throw new Error('West workspace not found in the current VS Code workspace.');
  }
  return writeWorkspaceState(manifestWorkspaceOf(westWorkspace), state);
}

export class WestManagerPanel {
  public static currentPanel: WestManagerPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _selectedWorkspacePath = '';

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, westWorkspace?: WestWorkspace) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._selectedWorkspacePath = westWorkspace?.rootUri.fsPath ?? '';
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.html = this._getWebviewContent(this._panel.webview, extensionUri);
    this._setWebviewMessageListener(this._panel.webview);
  }

  public static render(extensionUri: vscode.Uri, westWorkspace?: WestWorkspace) {
    if (WestManagerPanel.currentPanel) {
      WestManagerPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
      if (westWorkspace) {
        WestManagerPanel.currentPanel._selectedWorkspacePath = westWorkspace.rootUri.fsPath;
        WestManagerPanel.currentPanel.postInitialState();
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel('west-manager-panel', 'West Manager', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out')]
    });

    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'res', 'icons', 'light', 'west_icon_light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'res', 'icons', 'dark', 'west_icon_dark.svg'),
    };

    WestManagerPanel.currentPanel = new WestManagerPanel(panel, extensionUri, westWorkspace);
  }

  public dispose() {
    WestManagerPanel.currentPanel = undefined;
    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private getInitialState(): { workspaces: WestManagerWorkspaceSummary[]; selectedRootPath: string; details?: WestManagerWorkspaceDetails; error?: string } {
    const workspaces = getWestWorkspaces();
    const summaries = workspaces.map(workspace => ({
      name: workspace.name,
      rootPath: workspace.rootUri.fsPath,
      version: workspace.version,
    }));

    const selectedWorkspace = workspaces.find(workspace => workspace.rootUri.fsPath === this._selectedWorkspacePath) ?? workspaces[0];
    this._selectedWorkspacePath = selectedWorkspace?.rootUri.fsPath ?? '';

    if (!selectedWorkspace) {
      return {
        workspaces: summaries,
        selectedRootPath: '',
        error: 'No west workspace is open in VS Code.',
      };
    }

    try {
      return {
        workspaces: summaries,
        selectedRootPath: selectedWorkspace.rootUri.fsPath,
        details: getWorkspaceDetails(selectedWorkspace),
      };
    } catch (error) {
      return {
        workspaces: summaries,
        selectedRootPath: selectedWorkspace.rootUri.fsPath,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private postInitialState(): void {
    const state = this.getInitialState();
    this._panel.webview.postMessage({
      command: 'managerState',
      state,
    });
    if (state.details) {
      this.postRevisionOptions(state.details);
    }
  }

  private _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
    const webviewUri = getUri(webview, extensionUri, ['out', 'westmanager.js']);
    const styleUri = getUri(webview, extensionUri, ['out', 'style.css']);
    const codiconUri = getUri(webview, extensionUri, ['out', 'codicon.css']);
    const nonce = getNonce();
    const initialState = JSON.stringify(this.getInitialState()).replace(/</g, '\\u003c');

    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
          <link rel="stylesheet" href="${styleUri}">
          <link rel="stylesheet" href="${codiconUri}">
          <title>West Manager</title>
        </head>
        <body>
          <h1>West Manager</h1>
          <a class="help-link" href="${ZEPHYR_DOCS_BASE_URL}/west-manager">Read Docs</a>
          <form class="west-manager-panel">
            <div class="grid-group-div west-manager-workspace-field">
              <div class="grid-header-div">
                <label for="workspaceSelect">Workspace:</label>
              </div>
              <select id="workspaceSelect" class="workspace-select"></select>
            </div>

            <div id="workspaceEmpty" class="combo-status error"></div>

            <div id="workspaceDetails" class="west-manager-layout">
              <section class="west-manager-main">
                <div class="grid-group-div">
                  <div class="grid-header-div">
                    <label for="revisionInput">Zephyr revision:&nbsp;&nbsp;<span class="tooltip" data-tooltip="Revision written to the zephyr project in the workspace manifest from .west/config. Suggestions are loaded from the Zephyr git repository resolved from the manifest.">?</span></label>
                  </div>
                  <div id="revisionCombo" class="combo-dropdown grid-value-div">
                    <div class="combo-dropdown-input">
                      <input type="text" id="revisionInput" class="combo-dropdown-control" placeholder="Choose or type a revision..." data-value="">
                      <div aria-hidden="true" class="indicator" part="indicator">
                        <slot name="indicator">
                          <svg class="select-indicator" part="select-indicator" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                            <path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"></path>
                          </svg>
                        </slot>
                      </div>
                    </div>
                    <div class="combo-dropdown-controls">
                      <button id="revisionRefreshButton" class="inline-icon-button codicon codicon-refresh" title="Refresh revisions" aria-label="Refresh revisions" type="button"></button>
                      <div id="revisionLoadingSpinner" class="spinner" aria-label="Loading revisions"></div>
                    </div>
                    <div id="revisionDropdown" class="dropdown-content"></div>
                  </div>
                </div>

                <div class="grid-group-div">
                  <div class="grid-header-div">
                    <vscode-checkbox id="importAllCheckbox">Import all modules (full)&nbsp;&nbsp;<span class="tooltip" data-tooltip="Full workspace: the zephyr project imports every module (import: true). Uncheck to manage a specific set through the manifest name-allowlist.">?</span></vscode-checkbox>
                  </div>
                  <div class="grid-header-div">
                    <label>Manifest projects:&nbsp;&nbsp;<span class="tooltip" data-tooltip="Projects are read from the local zephyr/west.yml and zephyr/submanifests/*.yaml when present. Checked projects are written to the manifest name-allowlist. Use Import all modules for a full workspace.">?</span></label>
                  </div>
                  <div id="importAllHint" class="projects-empty" style="display:none;">All modules are imported. Uncheck &quot;Import all modules&quot; to pick individual modules.</div>
                  <div class="project-toolbar">
                    <vscode-text-field id="projectFilter" type="text" placeholder="Filter projects"></vscode-text-field>
                    <button id="selectAllProjectsButton" type="button" class="inline-icon-button codicon codicon-check-all" title="Select all projects" aria-label="Select all projects"></button>
                    <button id="clearProjectsButton" type="button" class="inline-icon-button codicon codicon-clear-all" title="Clear projects" aria-label="Clear projects"></button>
                  </div>
                  <div id="projectsList" class="west-manager-projects-list"></div>
                </div>

                <div class="grid-group-div">
                  <vscode-checkbox id="rustEnabledCheckbox">Enable Rust&nbsp;&nbsp;<span class="tooltip" data-tooltip="Checked when +zephyr-lang-rust is in manifest.project-filter (.west/config). Apply activates the optional zephyr-lang-rust module and keeps it in the manifest projects allowlist; run Update afterwards to fetch it into modules/lang/rust.">?</span></vscode-checkbox>
                </div>
              </section>

              <aside class="west-manager-side">
                <div class="details-content">
                  <div class="details-line"><strong>Version:</strong> <span id="versionText"></span></div>
                  <div class="details-line"><strong>Zephyr base:</strong> <span id="zephyrBaseText"></span></div>
                  <div class="details-line"><strong>Git repo:</strong> <span id="zephyrRepoUrlText"></span></div>
                  <div class="details-line"><strong>Manifest:</strong> <span id="manifestPathText"></span></div>
                  <div class="details-line"><strong>Project source:</strong> <span id="zephyrWestPathText"></span></div>
                  <div class="details-line"><strong>Submanifests:</strong> <span id="submanifestsText"></span></div>
                </div>
              </aside>
            </div>

            <div class="command-actions">
              <vscode-button id="applyButton">Apply</vscode-button>
              <vscode-button id="updateButton">Update</vscode-button>
              <vscode-button id="applyUpdateButton">Apply + Update</vscode-button>
              <vscode-button id="refreshButton" appearance="secondary">Refresh</vscode-button>
            </div>
            <div id="managerStatus" class="combo-status"></div>
          </form>
          <script nonce="${nonce}">
            window.zephyrWestManagerInitialState = ${initialState};
          </script>
          <script type="module" nonce="${nonce}" src="${webviewUri}"></script>
        </body>
      </html>
    `;
  }

  private async updateWorkspace(rootPath: string): Promise<void> {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Updating west workspace',
      cancellable: true,
    }, async (progress, token) => {
      progress.report({ increment: 5, message: 'Updating projects...' });
      await westUpdateCommand(rootPath, progress, token);
      if (token.isCancellationRequested) {
        throw new Error('West workspace update cancelled.', { cause: 'cancelled' });
      }
      progress.report({ increment: 15, message: 'Loading boards...' });
      await westBoardsCommand(rootPath);
      progress.report({ increment: 80, message: 'Update complete' });
    });
  }

  private async postRevisionOptions(details: WestManagerWorkspaceDetails): Promise<void> {
    if (!details.supported) {
      return;
    }
    if (!details.zephyrRepoUrl) {
      this._panel.webview.postMessage({
        command: 'revisionOptionsError',
        message: 'Cannot resolve the Zephyr git repository URL from the workspace manifest.',
      });
      return;
    }

    try {
      const [tags, branches] = await Promise.all([
        getGitTags(details.zephyrRepoUrl),
        getGitBranches(details.zephyrRepoUrl),
      ]);

      let revisionHTML = '';
      if (tags.length > 0) {
        revisionHTML += '<div class="dropdown-header">TAGS</div>';
        for (const tag of tags) {
          const escapedTag = escapeHtml(tag);
          revisionHTML += `<div class="dropdown-item" data-value="${escapedTag}" data-label="${escapedTag}">${escapedTag}</div>`;
        }
      }

      if (branches.length > 0) {
        revisionHTML += '<div class="dropdown-header">BRANCHES</div>';
        for (const branch of branches) {
          const escapedBranch = escapeHtml(branch);
          revisionHTML += `<div class="dropdown-item" data-value="${escapedBranch}" data-label="${escapedBranch}">${escapedBranch}</div>`;
        }
      }

      this._panel.webview.postMessage({
        command: 'revisionOptions',
        revisionHTML,
        revision: details.zephyrRevision,
      });
    } catch (error) {
      this._panel.webview.postMessage({
        command: 'revisionOptionsError',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private postWorkspaceDetails(rootPath: string, status?: string): void {
    const westWorkspace = getWorkspaceByPath(rootPath);
    if (!westWorkspace) {
      this._panel.webview.postMessage({ command: 'workspaceError', message: 'West workspace not found.' });
      return;
    }

    try {
      this._selectedWorkspacePath = rootPath;
      const details = getWorkspaceDetails(westWorkspace);
      this._panel.webview.postMessage({
        command: 'workspaceDetails',
        details,
        status,
      });
      this.postRevisionOptions(details);
    } catch (error) {
      this._panel.webview.postMessage({
        command: 'workspaceError',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private _setWebviewMessageListener(webview: vscode.Webview): void {
    webview.onDidReceiveMessage(async (message: any) => {
      try {
        switch (message.command) {
          case 'webviewReady':
            this.postInitialState();
            break;
          case 'loadWorkspace':
            this.postWorkspaceDetails(message.rootPath);
            break;
          case 'apply': {
            const details = applyWorkspaceState(message.state as WestManagerApplyState);
            this._selectedWorkspacePath = details.rootPath;
            webview.postMessage({ command: 'workspaceDetails', details, status: 'Manifest updated.' });
            this.postRevisionOptions(details);
            break;
          }
          case 'update':
            await this.updateWorkspace(message.rootPath);
            this.postWorkspaceDetails(message.rootPath, 'Workspace updated.');
            vscode.commands.executeCommand('zephyr-workbench-west-workspace.refresh');
            break;
          case 'applyAndUpdate': {
            const details = applyWorkspaceState(message.state as WestManagerApplyState);
            this._selectedWorkspacePath = details.rootPath;
            webview.postMessage({ command: 'workspaceDetails', details, status: 'Manifest updated. Updating workspace...' });
            await this.updateWorkspace(details.rootPath);
            this.postWorkspaceDetails(details.rootPath, 'Manifest applied and workspace updated.');
            vscode.commands.executeCommand('zephyr-workbench-west-workspace.refresh');
            break;
          }
          case 'refresh':
            this.postInitialState();
            break;
          case 'refreshRevisions': {
            const westWorkspace = getWorkspaceByPath(message.rootPath);
            if (!westWorkspace) {
              webview.postMessage({ command: 'revisionOptionsError', message: 'West workspace not found.' });
              break;
            }
            await this.postRevisionOptions(getWorkspaceDetails(westWorkspace));
            break;
          }
        }
      } catch (error) {
        const cause = error instanceof Error ? (error as any).cause : undefined;
        webview.postMessage({
          command: 'operationError',
          message: cause === 'cancelled'
            ? 'West workspace update cancelled.'
            : error instanceof Error ? error.message : String(error),
        });
      }
    }, null, this._disposables);
  }
}
