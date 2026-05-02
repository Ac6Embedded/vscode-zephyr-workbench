import * as vscode from 'vscode';
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";
import { pyocdLaunchJson, createLaunchConfiguration as createDefaultConfiguration, createOpenocdCfg, createWestWrapper, getDebugLaunchConfigurationName, getDebugManagerLaunchConfiguration, getDebugRunners, getDefaultDebugRunner, getLaunchConfiguration, getRunner, getServerAddressFromConfig, getWestDebugArgsForProject, setupPyOCDTarget, writeLaunchJson } from "../utils/debugTools/debugUtils";
import { ZephyrApplication } from "../models/ZephyrApplication";
import { getZephyrApplication } from '../utils/utils';
import { WestRunner } from '../debug/runners/WestRunner';
import { ZephyrBuildConfig } from '../models/ZephyrBuildConfig';
import { getGdbMode, getSetupCommands } from '../debug/gdbUtils';
import { getOpenocdSelectionInfo } from '../utils/debugTools/debugToolSelectionUtils';

export class DebugManagerPanel {
  public static currentPanel: DebugManagerPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  public project: ZephyrApplication | undefined;
  public buildConfig: ZephyrBuildConfig | undefined;
  private _loadApplicationsAsync: (wv: vscode.Webview) => void = () => {};

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  public async createContent(project?: ZephyrApplication | undefined, buildConfig?: ZephyrBuildConfig | undefined) {
    this.project = project;
    this.buildConfig = buildConfig;
    this._panel.webview.html = await this._getWebviewContent(this._panel.webview, this._extensionUri);
    this._setWebviewMessageListener(this._panel.webview);
    this._setDefaultSelection(this._panel.webview);
    // Trigger async applications discovery post-render
    
    //this._panel.webview.postMessage({ command: 'applicationsLoading' });
    //this._loadApplicationsAsync(this._panel.webview);
  }

  public static render(extensionUri: vscode.Uri, project?: ZephyrApplication | undefined, buildConfig?: ZephyrBuildConfig | undefined) {
    if (DebugManagerPanel.currentPanel) {
      DebugManagerPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
      // Update content
      DebugManagerPanel.currentPanel.project = project;
      // Update build config
      DebugManagerPanel.currentPanel.buildConfig = buildConfig;
      // Update selection field
      DebugManagerPanel.currentPanel._setDefaultSelection(DebugManagerPanel.currentPanel._panel.webview);
      const projectPath = project ? project.appRootPath : '';
      // Notify webview about project change
      if (projectPath.length > 0) {
        DebugManagerPanel.currentPanel._panel.webview.postMessage({ command: 'projectChanged', project: projectPath });
        if (buildConfig?.name) {
          // Notify webview about build config change
          DebugManagerPanel.currentPanel._panel.webview.postMessage({ command: 'buildConfigChanged', project: projectPath, buildConfig: buildConfig.name });
        }
      }
    } else {
      const panel = vscode.window.createWebviewPanel("debug-manager-panel", "Debug Manager", vscode.ViewColumn.One, {
        // Enable javascript in the webview
        enableScripts: true,
        // Keep the webview context when hidden to avoid losing state while switching tabs
        retainContextWhenHidden: true,
        // Restrict the webview to only load resources from the `out` directory
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out')]
      });

      // Set the icon for the panel in Debug Manager
      panel.iconPath = {
        light: vscode.Uri.joinPath(extensionUri,  'res','icons','light','bug.svg'),
        dark: vscode.Uri.joinPath(extensionUri, 'res','icons', 'dark', 'bug.svg')
      };
      
      DebugManagerPanel.currentPanel = new DebugManagerPanel(panel, extensionUri);
      DebugManagerPanel.currentPanel.createContent(project, buildConfig);
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

  public openFileDialog(
    elementId: string,
    filters: any = { 'All': ['*'] },
    options?: { canSelectFiles?: boolean; canSelectFolders?: boolean }
  ) {
    if (this._panel) {
      void (async () => {
        try {
          const uri = await vscode.window.showOpenDialog({
            canSelectFiles: options?.canSelectFiles ?? true,
            canSelectFolders: options?.canSelectFolders ?? false,
            canSelectMany: false,
            openLabel: 'Select',
            filters: filters,
          });
          if (uri && uri.length > 0) {
            const selectedFileUri = uri[0];
            // Send the selected file URI back to the webview
            this._panel?.webview.postMessage({ command: 'fileSelected', id: elementId, fileUri: selectedFileUri.fsPath });
          }
        } finally {
          this._panel?.webview.postMessage({ command: 'fileDialogClosed', id: elementId });
        }
      })();
    }
  }

  private async _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
    const webviewUri = getUri(webview, extensionUri, ["out", "debugmanager.js"]);
    const styleUri = getUri(webview, extensionUri, ["out", "style.css"]);
    const codiconUri = getUri(webview, extensionUri, ["out", "codicon.css"]);
    const nonce = getNonce();

    // Defer fetching applications until after the panel renders
    let applicationsHTML: string = '';

    // Init runners
    let runnersHTML: string = '';
    for(let runner of getDebugRunners()) {
      runnersHTML = runnersHTML.concat(`<div class="dropdown-item" data-value="${runner.name}" data-label="${runner.label}">${runner.label}</div>`);
    }
  
    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
          <link nonce="${nonce}" rel="stylesheet" href="${styleUri}">
          <link nonce="${nonce}" rel="stylesheet" href="${codiconUri}">
          <title>Debug Manager</title>
        </head>
        
        <body>
          <h1>Debug Manager</h1>
          <a class="help-link" href="https://zephyr-workbench.com/docs/documentation/debug-session">Read Docs</a>
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
                    <div class="spinner" id="applicationsDropdownSpinner" style="display:none;"></div>
                  </slot>
                </div>
                <div id="applicationsDropdown" class="dropdown-content" style="display: none;">
                  ${applicationsHTML}
                </div>
              </div>
            </div>

            <!-- Select Build Configuration -->
            <div class="grid-group-div">
              <div class="grid-header-div">
                <label for="listBuildConfigs">Select the build configuration:</label>
              </div>
              <div id="listBuildConfigs" class="combo-dropdown grid-value-div">
                <input type="text" id="buildConfigInput" class="combo-dropdown-control" placeholder="Choose configuration..." data-value="">
                <div aria-hidden="true" class="indicator" part="indicator">
                  <slot name="indicator">  
                    <svg class="select-indicator" part="select-indicator" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                      <path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"></path>
                    </svg>
                    <div class="spinner" id="buildConfigDropdownSpinner" style="display:none;"></div>
                  </slot>
                </div>
                <div id="buildConfigDropdown" class="dropdown-content" style="display: none;">
                </div>
              </div>
            </div>

            <!-- Program -->
            <fieldset>
              <legend>Program</legend> 
              <div class="grid-group-div">
                <vscode-text-field class="browse-field" size="50" type="text" id="programPath" value="">Program Path:</vscode-text-field>
                <vscode-button id="browseProgramButton" class="browse-input-button" style="vertical-align: middle">Browse...</vscode-button>
                <span class="browse-spinner-inline"><span id="programPathSpinner" class="spinner" aria-label="Loading program path" style="display:none;"></span></span>
              </div>
              <div class="grid-group-div">
                <vscode-text-field class="browse-field" size="50" type="text" id="svdPath" value="" placeholder="(Optional)" >SVD File:</vscode-text-field>
                <vscode-button id="browseSvdButton" class="browse-input-button" style="vertical-align: middle">Browse...</vscode-button>
              </div>
            </fieldset>

            <!-- GDB 
              - path (inside sdk)
              - address
              - port
            -->
            <fieldset>
              <legend>GDB</legend> 
              <div class="grid-group-div">
                <vscode-text-field class="browse-field" size="50" type="text" id="gdbPath" value="">GDB Path:</vscode-text-field>
                <vscode-button id="browseGdbButton" class="browse-input-button" style="vertical-align: middle">Browse...</vscode-button>
                <span class="browse-spinner-inline"><span id="gdbPathSpinner" class="spinner" aria-label="Loading GDB path" style="display:none;"></span></span>
              </div>

              <div class="grid-group-div">
                <vscode-text-field size="50" type="text" id="gdbAddress" value="">GDB Address:</vscode-text-field>
              </div>

              <div class="grid-group-div">
                <vscode-text-field size="50" type="text" id="gdbPort" value="">GDB Port:</vscode-text-field>
              </div>

              <div class="grid-group-div">
                <vscode-radio-group id="gdbMode" orientation="horizontal">            
                  <vscode-radio value="program" checked>Program</vscode-radio>
                  <vscode-radio value="attach">Attach</vscode-radio>
                </vscode-radio-group>
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
                  <label for="listRunners">Select the runner:&nbsp;&nbsp;<span class="tooltip" data-tooltip="Select the compatible debug server program">?</span></label>
                </div>
                <div id="listRunners" class="combo-dropdown grid-value-div">
                  <input type="text" id="runnerInput" class="combo-dropdown-control" placeholder="Choose debug runner..." data-value="" readonly>
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
                <vscode-button appearance="icon" id="installRunnerButton" class="runner-install" style="vertical-align: top">
                  <span class="codicon codicon-desktop-download no-icon-tooltip" data-tooltip="Install debug runners"></span>
                </vscode-button>
              </div>

              <div id="runnerPathRow" class="grid-group-div">
                <vscode-text-field class="browse-field" size="50" type="text" id="runnerPath" value="">Runner Path:&nbsp;&nbsp;<span class="tooltip" data-tooltip="Enter to debug server's location if not found automatically in PATH">?</span></vscode-text-field>
                <vscode-button id="browseRunnerButton" class="browse-input-button" style="vertical-align: middle">Browse...</vscode-button>
                <span class="browse-spinner-inline"><span id="runnerPathSpinner" class="spinner" aria-label="Loading runner path" style="display:none;"></span></span>
              </div>

              <div id="runnerDetectRow" class="grid-group-div" style="display: none;">
                <div style="display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 8px;">
                  <span id="runnerDetect"></span>
                  <vscode-button id="runnerDetectInstallButton" class="browse-input-button" style="display: none;" hidden>Install Runners</vscode-button>
                </div>
              </div>

              <div id="runnerDefaultInfoRow" class="grid-group-div" style="display: none;">
                <div>
                  <div style="display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 8px;">
                    <span id="runnerDefaultInfo" style="color: var(--vscode-descriptionForeground); font-size: calc(var(--type-ramp-base-font-size) - 2px);"></span>
                    <vscode-button id="changeRunnerDefaultButton" class="browse-input-button" style="vertical-align: middle">Change</vscode-button>
                  </div>
                  <div>
                    <span id="runnerDefaultPathInfo" style="color: var(--vscode-descriptionForeground); font-size: calc(var(--type-ramp-base-font-size) - 2px);"></span>
                  </div>
                </div>
              </div>
            
              <div class="grid-group-div">
                <vscode-text-field size="50" type="text" id="runnerArgs" value="" placeholder="(Optional)">Additional arguments:&nbsp;&nbsp;<span class="tooltip" data-tooltip="Additional options to provide to debug server">?</span></vscode-text-field>
              </div>
            </fieldset>

            <!-- Control buttons -->
            <div class="grid-group-div debug-manager-buttons">
              <vscode-button id="resetButton" appearance="secondary" class="finish-input-button">Reset Default</vscode-button>
              <vscode-button id="applyButton" appearance="secondary" class="finish-input-button">Apply</vscode-button>
              <vscode-button id="debugButton" appearance="primary" class="finish-input-button">Debug</vscode-button>
              <span id="resetSpinner" class="spinner" style="display:none; margin-left:80px;"></span>
            <div>
          </form>
          <script type="module" nonce="${nonce}" src="${webviewUri}"></script>
        </body>
      </html>
    `;
  }

  private _setDefaultSelection(webview: vscode.Webview) {
    webview.postMessage({ 
      command: 'updateLaunchConfig', 
      projectPath: this.project ? this.project.appRootPath : '',
      configName: this.buildConfig ? this.buildConfig.name : '',
    });
  }

  private _setWebviewMessageListener(webview: vscode.Webview) {
    let currentOpenocdInfoText: { defaultInfo: string; pathInfo: string } = { defaultInfo: '', pathInfo: '' };

    const buildOpenocdInfoText = (project: ZephyrApplication | undefined, openocdPath?: string): { defaultInfo: string; pathInfo: string } => {
      if (!project) {
        return { defaultInfo: '', pathInfo: '' };
      }
      const openocdInfo = getOpenocdSelectionInfo(project, this._extensionUri);
      if (!openocdInfo.info) {
        return { defaultInfo: '', pathInfo: '' };
      }
      return {
        defaultInfo: openocdInfo.info,
        pathInfo: openocdPath && openocdPath.trim().length > 0 ? `Detected Path: ${openocdPath.trim()}` : '',
      };
    };

    const getRunnerInfo = (runnerName: string | undefined): { defaultInfo: string; pathInfo: string } => {
      return runnerName === 'openocd' ? currentOpenocdInfoText : { defaultInfo: '', pathInfo: '' };
    };

    const getRunnerDetectionName = (runnerName: string | undefined, runnerLabel?: string): string => {
      if (runnerName === 'stlink_gdbserver') {
        return 'STM32CubeCLT';
      }
      return runnerLabel ?? runnerName ?? '';
    };

    function getRunnersHtml(compatibleRunners: string[]): string {
      let runnersHtml = '';
      for (const runner of getDebugRunners()) {
        const runnerLabel = compatibleRunners.includes(runner.name)
          ? `${runner.label} (compatible)`
          : runner.label;
        runnersHtml = runnersHtml.concat(`<div class="dropdown-item" data-value="${runner.name}" data-label="${runner.label}">${runnerLabel}</div>`);
      }
      return runnersHtml;
    }

    async function getRunnerWebviewState(
      project: ZephyrApplication | undefined,
      runnerName: string | undefined,
      debugServerArgs?: string,
    ): Promise<{ runnerLabel: string; runnerValue: string; runnerPath: string; runnerArgs: string; runnerDefaultInfo: string; runnerDefaultPathInfo: string; }> {
      const runnerInfo = getRunnerInfo(runnerName);
      const runnerValue = runnerName ?? '';
      const runner = runnerName ? getRunner(runnerName) : undefined;

      if (!runner) {
        return {
          runnerLabel: '',
          runnerValue,
          runnerPath: '',
          runnerArgs: '',
          runnerDefaultInfo: runnerInfo.defaultInfo,
          runnerDefaultPathInfo: runnerInfo.pathInfo,
        };
      }

      if (debugServerArgs) {
        runner.loadArgs(debugServerArgs);
      }
      // Always run auto-detection: when creating a fresh launch.json the saved
      // debugServerArgs is empty, but runners like stlink still need to resolve
      // their path (e.g. from the STM32CubeCLT bundle). `loadInternalArgs` is a
      // no-op for runners that don't define auto-detection.
      try {
        await runner.loadInternalArgs();
      } catch {
        // Keep the configuration responsive even if runner probing fails.
      }

      return {
        runnerLabel: runner.label ?? '',
        runnerValue,
        runnerPath: runner.serverPath ?? '',
        runnerArgs: runner.userArgs ?? '',
        runnerDefaultInfo: runnerInfo.defaultInfo,
        runnerDefaultPathInfo: runnerInfo.pathInfo,
      };
    }

    function postRunnerDetectState(
      runnerDetect: boolean,
      runnerName: string | undefined,
      runnerPath: string | undefined,
      runnerDefaultInfo: string,
      runnerDefaultPathInfo: string,
    ) {
      webview.postMessage({
        command: 'updateRunnerDetect',
        runnerDetect: runnerDetect ? 'true' : 'false',
        runnerName: `${getRunnerDetectionName(runnerName)}`,
        runnerPath: `${runnerPath ?? ''}`,
        runnerDefaultInfo: `${runnerDefaultInfo}`,
        runnerDefaultPathInfo: `${runnerDefaultPathInfo}`,
      });
    };

    webview.onDidReceiveMessage(
      async (message: any) => {
        const command = message.command;
        try {
          switch (command) {
            case 'webviewReady': {
              // Send initial selection and load applications
              this._setDefaultSelection(webview);
              webview.postMessage({ command: 'applicationsLoading' });
              await loadApplications(webview);
              break;
            }
            case 'projectChanged': {
              const projectPath = message.project;
              const appProject = await getZephyrApplication(projectPath);

              if(appProject) {
                this.project = appProject;
                this.buildConfig = undefined;
                currentOpenocdInfoText = { defaultInfo: '', pathInfo: '' };
                // Do NOT post a "clear" updateConfig here. On panel open,
                // `_setDefaultSelection` fires both `projectChanged` and
                // `buildConfigChanged` back-to-back, and their async handlers
                // race — a clear from this handler can arrive *after* the
                // fill from `buildConfigChanged`, wiping freshly-loaded data.
                // The subsequent `buildConfigChanged` is responsible for
                // overwriting form fields with the new configuration.
                if(appProject.buildConfigs.length > 0) {
                  updateBuildConfigs(appProject);
                }
              }
              break;
            }
            case 'buildConfigChanged': {
              const projectPath = message.project;
              const buildConfigName = message.buildConfig.length > 0 ? message.buildConfig : undefined;
              const appProject = await getZephyrApplication(projectPath);
              const buildConfig = appProject.getBuildConfiguration(buildConfigName);

              if(appProject && buildConfig) {
                this.project = appProject;
                this.buildConfig = buildConfig;
                await vscode.window.withProgress({
                  location: vscode.ProgressLocation.Notification,
                  title: 'Debug Manager',
                  cancellable: false,
                }, async (progress) => {
                  progress.report({ message: 'Preparing build configuration' });
                  await updateConfiguration(appProject, buildConfig);
                });
              } else {
                webview.postMessage({ command: 'updateConfigError' });
              }
              break;
            }
            case 'runnerChanged': {
              const runnerName = message.runner;
              const runnerPath = message.runnerPath;
              const runner = getRunner(runnerName);
              const runnerInfo = getRunnerInfo(runnerName);
              if(runner) {
                if(runnerPath && runnerPath.length > 0) {
                  runner.serverPath = runnerPath;
                }
                // let runner auto-discover its executable 
                await runner.loadInternalArgs();
                await updateRunnerDetect(runner, runnerInfo.defaultInfo, runnerInfo.pathInfo);
              } else {
                postRunnerDetectState(false, runnerName, runnerPath, runnerInfo.defaultInfo, runnerInfo.pathInfo);
              }
              break;
            }
            case 'runnerPathChanged': {
              const runnerName = message.runner;
              const runner = getRunner(runnerName);
              const runnerInfo = getRunnerInfo(runnerName);
              if(runner) {
                runner.serverPath = message.runnerPath;
                await updateRunnerDetect(runner, runnerInfo.defaultInfo, runnerInfo.pathInfo);
              } else {
                postRunnerDetectState(false, runnerName, message.runnerPath, runnerInfo.defaultInfo, runnerInfo.pathInfo);
              }
              break;
            }
            case 'browseProgram': {
              this.openFileDialog('programPath', { 'Binary File': ['bin'],  'Elf File': ['elf'], 'Hex File': ['hex'], 'All': ['*']});
              break;
            }
            case 'browseSvd': {
              this.openFileDialog('svdPath', { 'SVD File': ['svd'], 'All': ['*'] });
              break;
            }
            case 'browseGdb': {
              this.openFileDialog('gdbPath');
              break;
            }
            case 'browseRunner': {
              this.openFileDialog('runnerPath', { 'Executable': ['exe'], 'All': ['*'] });
              break;
            }
            case 'install': {
              vscode.commands.executeCommand('zephyr-workbench.install-runners');
              break;
            }
            case 'refreshApplications': {
              webview.postMessage({ command: 'applicationsLoading' });
              await loadApplications(webview);
              break;
            }
            case 'reset': {
              await resetHandler(message);
              break;
            }
            case 'apply': {
              await applyHandler(message);
              break;
            }
            case 'debug': {
              (async () => {
                try {
                  const applied = await applyHandler(message);
                  if (applied) {
                    await debugHandler(message);
                  }
                } catch (error) {
                  console.error('Cannot start debug', error);
                }
              })();
              break;
            }
            default:
              break;
          }
        } catch (error) {
          console.error(`Debug Manager command failed: ${command}`, error);
          if (command === 'buildConfigChanged') {
            webview.postMessage({ command: 'updateConfigError' });
          } else if (command === 'runnerChanged' || command === 'runnerPathChanged') {
            const runnerInfo = getRunnerInfo(message.runner);
            postRunnerDetectState(false, message.runner, message.runnerPath, runnerInfo.defaultInfo, runnerInfo.pathInfo);
          }
        }
      },
      undefined,
      this._disposables
    );

    // Helper to load applications asynchronously and update the webview
    async function loadApplications(webview: vscode.Webview) {
      let applicationsHTML = '';
      if(vscode.workspace.workspaceFolders) {
        const applications = await ZephyrApplication.getApplications(vscode.workspace.workspaceFolders);
        for (const appProject of applications) {
          try {
            applicationsHTML = applicationsHTML.concat(`<div class="dropdown-item" data-value="${appProject.appRootPath}" data-label="${appProject.appName}">${appProject.appName} <span class="description">${appProject.appRootPath}</span></div>`);
          } catch {}
        }
      }
      webview.postMessage({ command: 'updateApplications', applicationsHTML: `${applicationsHTML}` });
    }
  
    // Expose as bound method wrapper
    this._loadApplicationsAsync = (wv: vscode.Webview) => { loadApplications(wv); };
    function updateBuildConfigs(project: ZephyrApplication) {
      let newBuildConfigsHTML = '';
      for(let config of project.buildConfigs) {
        newBuildConfigsHTML = newBuildConfigsHTML.concat(`<div class="dropdown-item" data-value="${config.name}" data-label="${config.name}">${config.name}<span class="description">(${config.boardIdentifier})</span></div>`);
      }
      webview.postMessage({ 
        command: 'updateBuildConfigs', 
        buildConfigsHTML: `${newBuildConfigsHTML}`,
        selectFirst: project.buildConfigs.length === 1 ? 'true' : 'false',
      });
    }

    async function updateConfiguration(project: ZephyrApplication, buildConfig?: ZephyrBuildConfig) {
      try {
        // Extract information from configuration
        let config;
        let compatibleRunners: string[] = [];
        let defaultDebugRunner: string | undefined;
        let generatedOpenocdPath: string | undefined;
        if(buildConfig) {
          [/* launchJson */, config, compatibleRunners, defaultDebugRunner, generatedOpenocdPath] = await getDebugManagerLaunchConfiguration(project, buildConfig);
        }
        currentOpenocdInfoText = buildOpenocdInfoText(project, generatedOpenocdPath);

        const programPath = config.program;
        const svdPath = config.svdPath;
        const gdbPath = config.miDebuggerPath;
        const serverAddress = getServerAddressFromConfig(config);
        let gdbAddress = 'localhost';
        let gdbPort = '3333';
        let gdbMode = getGdbMode(config.setupCommands);
        if(serverAddress) {
          if (serverAddress.includes(':')) {
            [gdbAddress, gdbPort] = serverAddress.split(':');
          } else {
            gdbAddress = serverAddress;
            gdbPort = '3333';
          }
        }

        const newRunnersHTML = getRunnersHtml(compatibleRunners);
        const runnerName = WestRunner.extractRunner(config.debugServerArgs) ?? (buildConfig ? defaultDebugRunner : undefined);
        const { runnerLabel, runnerValue, runnerPath, runnerArgs, runnerDefaultInfo, runnerDefaultPathInfo } = await getRunnerWebviewState(
          project,
          runnerName,
          config.debugServerArgs,
        );

        webview.postMessage({ 
          command: 'updateConfig', 
          programPath: `${programPath}`,
          svdPath: `${svdPath}`,
          gdbPath: `${gdbPath}`,
          gdbAddress: `${gdbAddress}`,
          gdbPort: `${gdbPort}`,
          gdbMode: `${gdbMode}`,
          runnersHTML: `${newRunnersHTML}`,
          runnerName: `${runnerLabel}`,
          runnerValue: `${runnerValue}`,
          runnerPath: `${runnerPath}`,
          runnerArgs: `${runnerArgs}`,
          runnerDefaultInfo: `${runnerDefaultInfo}`,
          runnerDefaultPathInfo: `${runnerDefaultPathInfo}`,
        });
      } catch (error) {
        console.error('Debug Manager: cannot update configuration', error);
        webview.postMessage({ command: 'updateConfigError' });
      }
    }

    async function updateRunnerDetect(runner: WestRunner, runnerDefaultInfo: string = '', runnerDefaultPathInfo: string = '') {
      let found = false;
      try {
        found = await runner.detect();
      } catch (error) {
        console.error('Debug Manager: cannot detect runner', error);
      }
      // Only probe the version when the runner is actually present, so we don't
      // block the UI waiting on a probe that we know will fail.
      let runnerVersion: string | undefined;
      if (found) {
        try {
          runnerVersion = await runner.detectVersion();
        } catch (error) {
          console.error('Debug Manager: cannot detect runner version', error);
        }
      }
      webview.postMessage({
        command: 'updateRunnerDetect',
        runnerDetect: found?'true':'false',
        runnerName: getRunnerDetectionName(runner.name, runner.label),
        runnerPath: runner.serverPath? runner.serverPath:'',
        runnerVersion: runnerVersion ?? '',
        runnerDefaultInfo: `${runnerDefaultInfo}`,
        runnerDefaultPathInfo: `${runnerDefaultPathInfo}`,
      });
    }

    async function resetHandler(message: any) {
      // Notify reset started
      webview.postMessage({ command: 'resetStarted' });

      try{
        // Perform reset default configuration
        const projectPath = message.project;
        const buildConfigName = message.buildConfig.length > 0 ? message.buildConfig : undefined;

        const appProject = await getZephyrApplication(projectPath);
        const buildConfig = appProject.getBuildConfiguration(buildConfigName);
        if(appProject) {
          await resetConfiguration(appProject, buildConfig);
        }
      }
      finally{
        // Notify reset finished
        webview.postMessage({ command: 'resetFinished' });
      }
    }

    async function resetConfiguration(project: ZephyrApplication, buildConfig?: ZephyrBuildConfig) {
      let config;
      let compatibleRunners: string[] = [];
      let defaultDebugRunner: string | undefined;
      let generatedOpenocdPath: string | undefined;
      if(buildConfig) {
        config  = await createDefaultConfiguration(project, buildConfig.name);
        [, , compatibleRunners, defaultDebugRunner, generatedOpenocdPath] = await getDebugManagerLaunchConfiguration(project, buildConfig);
      }
      currentOpenocdInfoText = buildOpenocdInfoText(project, generatedOpenocdPath);
     
      const programPath = config.program;
      const gdbPath = config.miDebuggerPath;
      const serverAddress = getServerAddressFromConfig(config);
      let gdbAddress = 'localhost';
      let gdbPort = '3333';
      let gdbMode = 'program';
      if(serverAddress) {
        if (serverAddress.includes(':')) {
          [gdbAddress, gdbPort] = serverAddress.split(':');
        } else {
          gdbAddress = serverAddress;
          gdbPort = '3333';
        }
      }
    
      const newRunnersHTML = getRunnersHtml(compatibleRunners);
      const runnerName = buildConfig ? (defaultDebugRunner ?? getDefaultDebugRunner(project, buildConfig)) : undefined;
      const { runnerLabel, runnerValue, runnerPath, runnerDefaultInfo, runnerDefaultPathInfo } = await getRunnerWebviewState(project, runnerName);
      
      webview.postMessage({ 
        command: 'updateConfig', 
        programPath: `${programPath}`,
        gdbPath: `${gdbPath}`,
        gdbAddress: `${gdbAddress}`,
        gdbPort: `${gdbPort}`,
        gdbMode: `${gdbMode}`,
        runnersHTML: `${newRunnersHTML}`,
        runnerName: `${runnerLabel}`,
        runnerValue: `${runnerValue}`,
        runnerPath: `${runnerPath}`,
        runnerArgs: '',
        runnerDefaultInfo: `${runnerDefaultInfo}`,
        runnerDefaultPathInfo: `${runnerDefaultPathInfo}`,
      });
    }

    function escapeRegExp(value: string): string {
      return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function runnerPathArg(debugServerArgs: string, runnerName: string, runnerPath?: string): string {
      const path = runnerPath?.trim();
      const runner = runnerName?.trim().toLowerCase();
      const args = debugServerArgs?.trim() ?? '';

      if (!path || !runner) {
        return args;
      }

      // ST-LINK GDB Server is launched indirectly (via west / the CubeCLT bundle)
      // and does not accept an executable-path flag on the command line. The path
      // is only used internally for detection, so we must not inject it into
      // `debugServerArgs` — doing so would put an invalid flag in launch.json.
      if (runner === 'stlink_gdbserver') {
        return args;
      }

      const flag = `--${runner}`;
      const quotedPath = path.includes(' ') ? `"${path}"` : path;
      const flagPattern = new RegExp(`(${escapeRegExp(flag)})(?:\\s+|=)(?:"[^"]*"|\\S+)`, 'gi');

      // Replace existing flag value
      if (flagPattern.test(args)) {
        return args.replace(flagPattern, `$1 ${quotedPath}`);
      }

      // Insert after --runner <name> if it matches
      const runnerPattern = new RegExp(`(--runner(?:\\s+|=)(?:"${runner}"|${runner}))`, 'i');
      if (runnerPattern.test(args)) {
        return args.replace(runnerPattern, `$1 ${flag} ${quotedPath}`);
      }

      // Otherwise append
      return args ? `${args} ${flag} ${quotedPath}` : `${flag} ${quotedPath}`;
    }
    
    async function applyHandler(message: any): Promise<boolean> {
      const projectPath = message.project;
      const buildConfigName = message.buildConfig.length > 0 ? message.buildConfig : undefined;
      const appProject = await getZephyrApplication(projectPath);
      const buildConfig = appProject.getBuildConfiguration(buildConfigName);
      const programPath = message.programPath;
      const svdPath = message.svdPath;
      const gdbPath = message.gdbPath;
      const gdbAddress = message.gdbAddress;
      const gdbPort = message.gdbPort;
      const gdbMode = message.gdbMode;
      const runnerName = message.runner;
      const runner = getRunner(runnerName);
      const runnerPath = message.runnerPath;
      const runnerArgs = message.runnerArgs;

      if (!runner) {
        vscode.window.showErrorMessage('Debug manager: No debug runner selected!');
        return false;
      }
    
      if(appProject && buildConfig) {
        let [launchJson, config] = await getLaunchConfiguration(appProject, buildConfigName);
        config.program = programPath;
        config.svdPath = svdPath? svdPath:'';
        config.miDebuggerPath = gdbPath;
    
        if(runner) {
          runner.loadArgs(runnerArgs);
          runner.serverPath = runnerPath;
          runner.serverAddress = gdbAddress;
          runner.serverPort = gdbPort;
          config.serverStarted = runner.serverStartedPattern;
          config.debugServerArgs = getWestDebugArgsForProject(runner, appProject, buildConfig);
          config.debugServerArgs = runnerPathArg(config.debugServerArgs, runner.name, runnerPath);
          config.setupCommands = [];
          for(const arg of getSetupCommands(programPath, runner.serverAddress, runner.serverPort, gdbMode)) {
            config.setupCommands.push(arg);
          }
          // pyOCD requires specialized GDB configuration with specific setup commands
          if (runner.name === 'pyocd' && runner.serverAddress && runner.serverPort) {
            const configIndex = launchJson.configurations.indexOf(config);
            config = pyocdLaunchJson(config, runner.serverAddress, runner.serverPort);
            if (configIndex >= 0) {
              launchJson.configurations[configIndex] = config;
            }
          }
        }
        createWestWrapper(appProject, buildConfigName);
        
        switch(runner?.name) {
          case 'openocd': 
            createOpenocdCfg(appProject);
            break;
          case 'pyocd':
            await vscode.window.withProgress({
              location: vscode.ProgressLocation.Notification,
              title: "Please wait... installing target support on pyOCD",
              cancellable: false,
            }, async () => {
              await setupPyOCDTarget(appProject, buildConfigName);
            });
            break;
        }

        writeLaunchJson(launchJson, appProject);
        return true;
      }

      return false;
    }
    
    async function debugHandler(message: any): Promise<void> {
      const projectPath = message.project;
      const buildConfigName = message.buildConfig.length > 0 ? message.buildConfig : undefined;
      const runnerName = message.runner;
      const runner = getRunner(runnerName);
      if(runner) {
        const appProject = await getZephyrApplication(projectPath);
        if(buildConfigName) {
          vscode.commands.executeCommand('zephyr-workbench.debug-manager.debug', 
            appProject,
            getDebugLaunchConfigurationName(appProject, buildConfigName));
        }
      } else {
        vscode.window.showErrorMessage('Debug manager: No debug runner selected!');
      }      
    }
  }  
}
