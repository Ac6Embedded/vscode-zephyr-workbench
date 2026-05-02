import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import yaml from 'yaml';
import { getUri } from '../utilities/getUri';
import { getNonce } from '../utilities/getNonce';
import { WestWorkspace } from '../models/WestWorkspace';
import { westBoardsCommand, westUpdateCommand } from '../commands/WestCommands';
import { getGitBranches, getGitTags } from '../utils/execUtils';

type WestManifestProject = Record<string, any> & {
  name?: string;
  revision?: string;
  import?: unknown;
  remote?: string;
  url?: string;
};

type WestManifestData = Record<string, any> & {
  manifest?: {
    remotes?: Record<string, any>[];
    projects?: WestManifestProject[];
  };
};

interface WestManagerWorkspaceSummary {
  name: string;
  rootPath: string;
  version: string;
}

interface WestManagerWorkspaceDetails extends WestManagerWorkspaceSummary {
  configPath: string;
  manifestPath: string;
  zephyrBase: string;
  zephyrWestPath: string;
  submanifestPaths: string[];
  zephyrRepoUrl: string;
  zephyrRevision: string;
  importAll: boolean;
  availableProjects: string[];
  selectedProjects: string[];
}

interface WestManagerApplyState {
  rootPath: string;
  zephyrRevision: string;
  selectedProjects: string[];
}

function uniqueProjectNames(projects: string[]): string[] {
  const names: string[] = [];
  for (const projectName of projects) {
    if (projectName && !names.includes(projectName)) {
      names.push(projectName);
    }
  }
  return names;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function findZephyrProject(projects: WestManifestProject[] | undefined): WestManifestProject | undefined {
  return projects?.find(project =>
    project.name === 'zephyr' ||
    project['repo-path'] === 'zephyr' ||
    project.path === 'zephyr'
  );
}

function joinRemoteRepoUrl(urlBase: string, repoPath: string): string {
  const normalizedBase = urlBase.trim().replace(/\/+$/, '');
  const normalizedRepoPath = repoPath.trim().replace(/^\/+/, '');
  if (!normalizedRepoPath) {
    return normalizedBase;
  }
  return `${normalizedBase}/${normalizedRepoPath}`;
}

function getZephyrRepoUrl(manifest: WestManifestData, zephyrProject: WestManifestProject | undefined): string {
  if (!zephyrProject) {
    return '';
  }

  if (typeof zephyrProject.url === 'string' && zephyrProject.url.trim().length > 0) {
    return zephyrProject.url.trim();
  }

  const remoteName = typeof zephyrProject.remote === 'string' ? zephyrProject.remote : '';
  const remote = manifest.manifest?.remotes?.find(candidate => candidate.name === remoteName);
  const urlBase = typeof remote?.['url-base'] === 'string'
    ? remote['url-base']
    : typeof remote?.url === 'string'
      ? remote.url
      : '';
  if (!urlBase) {
    return '';
  }

  const repoPath = typeof zephyrProject['repo-path'] === 'string'
    ? zephyrProject['repo-path']
    : typeof zephyrProject.name === 'string'
      ? zephyrProject.name
      : 'zephyr';
  return joinRemoteRepoUrl(urlBase, repoPath);
}

function getProjectSourcePaths(zephyrBasePath: string): string[] {
  const sourcePaths: string[] = [];
  const zephyrWestPath = path.join(zephyrBasePath, 'west.yml');
  if (fs.existsSync(zephyrWestPath)) {
    sourcePaths.push(zephyrWestPath);
  }

  const submanifestDir = path.join(zephyrBasePath, 'submanifests');
  if (fs.existsSync(submanifestDir) && fs.statSync(submanifestDir).isDirectory()) {
    const submanifestPaths = fs.readdirSync(submanifestDir)
      .filter(fileName => fileName.endsWith('.yaml') || fileName.endsWith('.yml'))
      .sort((left, right) => left.localeCompare(right))
      .map(fileName => path.join(submanifestDir, fileName));
    sourcePaths.push(...submanifestPaths);
  }

  return sourcePaths;
}

function getManifestProjectNames(manifestPath: string): string[] {
  const manifest = yaml.parse(fs.readFileSync(manifestPath, 'utf8')) as WestManifestData;
  return (manifest.manifest?.projects ?? [])
    .map(project => typeof project?.name === 'string' ? project.name : '')
    .filter(name => name.length > 0);
}

function getAvailableProjects(projectSourcePaths: string[]): string[] {
  const projectNames: string[] = [];
  for (const sourcePath of projectSourcePaths) {
    projectNames.push(...getManifestProjectNames(sourcePath));
  }
  return uniqueProjectNames(projectNames);
}

function getSelectedProjects(zephyrProject: WestManifestProject | undefined, availableProjects: string[]): { importAll: boolean; selectedProjects: string[] } {
  const importBlock = zephyrProject?.import;
  if (importBlock === true || importBlock === undefined) {
    return { importAll: true, selectedProjects: availableProjects };
  }

  if (!importBlock || typeof importBlock !== 'object' || Array.isArray(importBlock)) {
    return { importAll: false, selectedProjects: [] };
  }

  const allowlist = (importBlock as Record<string, unknown>)['name-allowlist'];
  if (!Array.isArray(allowlist)) {
    return { importAll: true, selectedProjects: availableProjects };
  }

  return {
    importAll: false,
    selectedProjects: uniqueProjectNames(allowlist
      .filter((projectName): projectName is string => typeof projectName === 'string' && projectName.length > 0)),
  };
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

function getWorkspaceDetails(westWorkspace: WestWorkspace): WestManagerWorkspaceDetails {
  const manifestPath = westWorkspace.manifestUri.fsPath;
  const zephyrWestPath = path.join(westWorkspace.kernelUri.fsPath, 'west.yml');
  const projectSourcePaths = getProjectSourcePaths(westWorkspace.kernelUri.fsPath);
  const submanifestPaths = projectSourcePaths.filter(sourcePath => sourcePath !== zephyrWestPath);
  const manifest = yaml.parse(fs.readFileSync(manifestPath, 'utf8')) as WestManifestData;
  const zephyrProject = findZephyrProject(manifest.manifest?.projects);
  const zephyrRepoUrl = getZephyrRepoUrl(manifest, zephyrProject);
  const availableProjects = getAvailableProjects(projectSourcePaths);
  const selection = getSelectedProjects(zephyrProject, availableProjects);

  return {
    name: westWorkspace.name,
    rootPath: westWorkspace.rootUri.fsPath,
    version: westWorkspace.version,
    configPath: westWorkspace.westConfUri.fsPath,
    manifestPath,
    zephyrBase: westWorkspace.zephyrBase,
    zephyrWestPath,
    submanifestPaths,
    zephyrRepoUrl,
    zephyrRevision: zephyrProject?.revision ?? '',
    importAll: selection.importAll,
    availableProjects,
    selectedProjects: selection.selectedProjects,
  };
}

function readWorkspaceManifest(rootPath: string): { westWorkspace: WestWorkspace; manifest: WestManifestData } {
  const westWorkspace = getWorkspaceByPath(rootPath);
  if (!westWorkspace) {
    throw new Error('West workspace not found in the current VS Code workspace.');
  }

  const manifest = yaml.parse(fs.readFileSync(westWorkspace.manifestUri.fsPath, 'utf8')) as WestManifestData;
  if (!manifest.manifest) {
    manifest.manifest = {};
  }
  if (!Array.isArray(manifest.manifest.projects)) {
    manifest.manifest.projects = [];
  }

  return { westWorkspace, manifest };
}

function applyWorkspaceState(state: WestManagerApplyState): WestManagerWorkspaceDetails {
  const { westWorkspace, manifest } = readWorkspaceManifest(state.rootPath);
  const zephyrProject = findZephyrProject(manifest.manifest?.projects);
  if (!zephyrProject) {
    throw new Error('The workspace manifest does not contain a zephyr project entry.');
  }

  const revision = state.zephyrRevision.trim();
  if (revision.length > 0) {
    zephyrProject.revision = revision;
  }

  const availableProjects = getAvailableProjects(getProjectSourcePaths(westWorkspace.kernelUri.fsPath));
  const selectedProjects = uniqueProjectNames(state.selectedProjects);
  if (availableProjects.length > 0) {
    const selectedAllProjects = availableProjects.every(projectName => selectedProjects.includes(projectName));
    let importBlock = zephyrProject.import;
    if (selectedAllProjects) {
      if (importBlock && typeof importBlock === 'object' && !Array.isArray(importBlock)) {
        delete (importBlock as Record<string, unknown>)['name-allowlist'];
      } else {
        zephyrProject.import = true;
      }
    } else {
      if (!importBlock || importBlock === true || typeof importBlock !== 'object' || Array.isArray(importBlock)) {
        importBlock = {};
        zephyrProject.import = importBlock;
      }
      (importBlock as Record<string, unknown>)['name-allowlist'] = selectedProjects;
    }
  }

  fs.writeFileSync(westWorkspace.manifestUri.fsPath, yaml.stringify(manifest), 'utf8');
  return getWorkspaceDetails(westWorkspace);
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
      light: vscode.Uri.joinPath(extensionUri, 'res', 'icons', 'zephyr.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'res', 'icons', 'zephyr.svg')
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
                  <label>Manifest projects:&nbsp;&nbsp;<span class="tooltip" data-tooltip="Projects are read from the local zephyr/west.yml and zephyr/submanifests/*.yaml when present. Checked projects are written to the manifest name-allowlist; checking all projects imports all.">?</span></label>
                  <div class="project-toolbar">
                    <vscode-text-field id="projectFilter" type="text" placeholder="Filter projects"></vscode-text-field>
                    <button id="selectAllProjectsButton" type="button" class="inline-icon-button codicon codicon-check-all" title="Select all projects" aria-label="Select all projects"></button>
                    <button id="clearProjectsButton" type="button" class="inline-icon-button codicon codicon-clear-all" title="Clear projects" aria-label="Clear projects"></button>
                  </div>
                  <div id="projectsList" class="west-manager-projects-list"></div>
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
