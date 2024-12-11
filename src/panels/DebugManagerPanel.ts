import * as vscode from 'vscode';
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";
import { createLaunchConfiguration as createDefaultConfiguration, createOpenocdCfg, createWestWrapper, getDebugRunners, getLaunchConfiguration, getRunner, getServerAddressFromConfig, setupPyOCDTarget, writeLaunchJson, ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME } from "../debugUtils";
import { ZephyrAppProject } from "../ZephyrAppProject";
import { getZephyrProject } from '../utils';
import { WestRunner } from '../debug/runners/WestRunner';
import { ZephyrProject } from '../ZephyrProject';
import { ZephyrProjectBuildConfiguration } from '../ZephyrProjectBuildConfiguration';

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

  public openFileDialog(elementId: string, filters: any = { 'All': ['*'] }) {
    if (this._panel) {
      vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Select',
        filters: filters,
      }).then(uri => {
        if (uri && uri.length > 0) {
          const selectedFileUri = uri[0];
          // Send the selected file URI back to the webview
          this._panel?.webview.postMessage({ command: 'fileSelected', id: elementId, fileUri: selectedFileUri.fsPath });
        }
      });
    }
  }

  private async _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
    const webviewUri = getUri(webview, extensionUri, ["out", "debugmanager.js"]);
    const styleUri = getUri(webview, extensionUri, ["out", "style.css"]);
    const codiconUri = getUri(webview, extensionUri, ["out", "codicon.css"]);
    const nonce = getNonce();

    let applicationsHTML: string = '';

    if(vscode.workspace.workspaceFolders) {
      for(let workspaceFolder of vscode.workspace.workspaceFolders) {
        if(await ZephyrAppProject.isZephyrProjectWorkspaceFolder(workspaceFolder)) {
          const appProject = new ZephyrAppProject(workspaceFolder, workspaceFolder.uri.fsPath);
          applicationsHTML = applicationsHTML.concat(`<div class="dropdown-item" data-value="${appProject.sourceDir}" data-label="${appProject.folderName}">${appProject.folderName} <span class="description">${appProject.sourceDir}</span></div>`);
        }
      }
    }

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
                <vscode-text-field size="50" type="text" id="programPath" value="">Program Path:</vscode-text-field>
                <vscode-button id="browseProgramButton" class="browse-input-button" style="vertical-align: middle">Browse...</vscode-button>
              </div>
              <div class="grid-group-div">
                <vscode-text-field size="50" type="text" id="svdPath" value="" placeholder="(Optional)" >SVD File:</vscode-text-field>
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
                <vscode-text-field size="50" type="text" id="gdbPath" value="">GDB Path:</vscode-text-field>
                <vscode-button id="browseGdbButton" class="browse-input-button" style="vertical-align: middle">Browse...</vscode-button>
              </div>

              <div class="grid-group-div">
                <vscode-text-field size="50" type="text" id="gdbAddress" value="">GDB Address:</vscode-text-field>
              </div>

              <div class="grid-group-div">
                <vscode-text-field size="50" type="text" id="gdbPort" value="">GDB Port:</vscode-text-field>
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

              <div class="grid-group-div">
                <vscode-text-field size="50" type="text" id="runnerPath" value="">Runner Path:&nbsp;&nbsp;<span class="tooltip" data-tooltip="Enter to debug server's location if not found automatically in PATH">?</span>&nbsp;&nbsp;&nbsp;<span id="runnerDetect"></span></vscode-text-field>
                <vscode-button id="browseRunnerButton" class="browse-input-button" style="vertical-align: middle">Browse...</vscode-button>
              </div>
            
              <div class="grid-group-div">
                <vscode-text-field size="50" type="text" id="runnerArgs" value="" placeholder="(Optional)">Additional arguments:&nbsp;&nbsp;<span class="tooltip" data-tooltip="Additional options to provide to debug server">?</span></vscode-text-field>
              </div>
            </fieldset>

            <!-- Control buttons -->
            <div class="grid-group-div">
              <vscode-button id="resetButton" appearance="secondary" class="finish-input-button">Reset Default</vscode-button>
              <vscode-button id="applyButton" appearance="secondary" class="finish-input-button">Apply</vscode-button>
              <vscode-button id="debugButton" appearance="primary" class="finish-input-button">Debug</vscode-button>
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
          case 'projectChanged': {
            const projectPath = message.project;
            const appProject = await getZephyrProject(projectPath);

            if(appProject) {
              if(appProject.configs.length > 0) {
                updateBuildConfigs(appProject);
              } else {
                // For legacy project, update configuration
                updateBuildConfigs(appProject);
                await updateConfiguration(appProject);
              }
            }
            break;
          }
          case 'buildConfigChanged': {
            const projectPath = message.project;
            const buildConfigName = message.buildConfig.length > 0 ? message.buildConfig : undefined;
            const appProject = await getZephyrProject(projectPath);
            const buildConfig = appProject.getBuildConfiguration(buildConfigName);

            if(appProject && buildConfig) {
              await updateConfiguration(appProject, buildConfig);
            }
            break;
          }
          case 'runnerChanged': {
            const runnerName = message.runner;
            const runnerPath = message.runnerPath;
            const runner = getRunner(runnerName);
            if(runner) {
              if(runnerPath && runnerPath.length > 0) {
                runner.serverPath = runnerPath;
              }
              // FIXME: Does not take has the runnerPath value before detection
              //await updateRunnerConfiguration(runner);
              await updateRunnerDetect(runner);
            }
            break;
          }
          case 'runnerPathChanged': {
            const runnerName = message.runner;
            const runner = getRunner(runnerName);
            if(runner) {
              runner.serverPath = message.runnerPath;
              await updateRunnerDetect(runner);
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
            this.openFileDialog('runnerPath');
            break;
          }
          case 'install': {
            vscode.commands.executeCommand('zephyr-workbench.install-debug-tools');
          }
          case 'reset': {
            await resetHandler(message);
          }
          case 'apply': {
            await applyHandler(message);
            break;
          }
          case 'debug': {
            (async () => {
              try {
                await applyHandler(message);
                await debugHandler(message);
              } catch (error) {
                console.error('Cannot start debug', error);
              }
            })();
            break;
          }
          default:
            break;
        }
      },
      undefined,
      this._disposables
    );

    function updateBuildConfigs(project: ZephyrProject) {
      let newBuildConfigsHTML = '';
      for(let config of project.configs) {
        newBuildConfigsHTML = newBuildConfigsHTML.concat(`<div class="dropdown-item" data-value="${config.name}" data-label="${config.name}">${config.name}</div>`);
      }
      webview.postMessage({ 
        command: 'updateBuildConfigs', 
        buildConfigsHTML: `${newBuildConfigsHTML}`,
      });
    }

    async function updateConfiguration(project: ZephyrProject, buildConfig?: ZephyrProjectBuildConfiguration) {
      // Extract information from configuration
      let launchJson, config;
      let compatibleRunners;
      if(buildConfig) {
        [launchJson, config] = await getLaunchConfiguration(project, buildConfig.name);
        compatibleRunners = await buildConfig.getCompatibleRunners(project);
      } else {
        // For legacy compatibility
        [launchJson, config] = await getLaunchConfiguration(project);
        compatibleRunners = await project.getCompatibleRunners();
      }

      const programPath = config.program;
      const svdPath = config.svdPath;
      const gdbPath = config.miDebuggerPath;
      const serverAddress = getServerAddressFromConfig(config);
      let gdbAddress = 'localhost';
      let gdbPort = '3333';
      if(serverAddress) {
        if (serverAddress.includes(':')) {
          [gdbAddress, gdbPort] = serverAddress.split(':');
        } else {
          gdbAddress = serverAddress;
          gdbPort = '3333';
        }
      }

      let newRunnersHTML = '';
      for(let runner of getDebugRunners()) {
        if(compatibleRunners.includes(runner.name)) {
          newRunnersHTML = newRunnersHTML.concat(`<div class="dropdown-item" data-value="${runner.name}" data-label="${runner.label}">${runner.label} (compatible)</div>`);
        } else {
          newRunnersHTML = newRunnersHTML.concat(`<div class="dropdown-item" data-value="${runner.name}" data-label="${runner.label}">${runner.label}</div>`);
        }
      }
      const runnerName = WestRunner.extractRunner(config.debugServerArgs);
      let runnerLabel = "";
      let runnerPath = "";
      let runnerArgs = "";

      if(runnerName) {
        const runner = getRunner(runnerName);
        if(runner) {
          runner.loadArgs(config.debugServerArgs);
          await runner.loadInternalArgs();
          if(runner.label) {
            runnerLabel = runner.label;
          }
          if(runner.serverPath) {
            runnerPath = runner.serverPath;
          }
          if(runner.userArgs) {
            runnerArgs = runner.userArgs;
          }
        }
      }

      webview.postMessage({ 
        command: 'updateConfig', 
        programPath: `${programPath}`,
        svdPath: `${svdPath}`,
        gdbPath: `${gdbPath}`,
        gdbAddress: `${gdbAddress}`,
        gdbPort: `${gdbPort}`,
        runnersHTML: `${newRunnersHTML}`,
        runnerName: `${runnerLabel}`,
        runnerPath: `${runnerPath}`,
        runnerArgs: `${runnerArgs}`
      });
    }

    async function updateRunnerConfiguration(runner: WestRunner) {
      webview.postMessage({ 
        command: 'updateRunnerConfig', 
        runnerPath: runner.serverPath? runner.serverPath:'',
        runnerArgs: runner.userArgs? runner.userArgs:'',
      });
    }

    async function updateRunnerDetect(runner: WestRunner) {
      let found = await runner.detect();
      webview.postMessage({ 
        command: 'updateRunnerDetect', 
        runnerDetect: found?'true':'false'
      });
    }

    async function resetHandler(message: any) {
      const projectPath = message.project;
      const buildConfigName = message.buildConfig.length > 0 ? message.buildConfig : undefined;

      const appProject = await getZephyrProject(projectPath);
      const buildConfig = appProject.getBuildConfiguration(buildConfigName);
      if(appProject) {
        await resetConfiguration(appProject, buildConfig);
      }
    }
    
    async function resetConfiguration(project: ZephyrProject, buildConfig?: ZephyrProjectBuildConfiguration) {
      let config;
      if(buildConfig) {
        config  = await createDefaultConfiguration(project, buildConfig.name);
      } else {
        // For legacy compatibility
        config  = await createDefaultConfiguration(project);
      }
     
      const programPath = config.program;
      const gdbPath = config.miDebuggerPath;
      const serverAddress = getServerAddressFromConfig(config);
      let gdbAddress = 'localhost';
      let gdbPort = '3333';
      if(serverAddress) {
        if (serverAddress.includes(':')) {
          [gdbAddress, gdbPort] = serverAddress.split(':');
        } else {
          gdbAddress = serverAddress;
          gdbPort = '3333';
        }
      }
    
      let newRunnersHTML = '';
      let compatibleRunners = await project.getCompatibleRunners();
      for(let runner of getDebugRunners()) {
        if(compatibleRunners.includes(runner.name)) {
          newRunnersHTML = newRunnersHTML.concat(`<div class="dropdown-item" data-value="${runner.name}" data-label="${runner.label}">${runner.label} (compatible)</div>`);
        } else {
          newRunnersHTML = newRunnersHTML.concat(`<div class="dropdown-item" data-value="${runner.name}" data-label="${runner.label}">${runner.label}</div>`);
        }
      }
      const serverArgs = config.debugServerArgs;
      
      webview.postMessage({ 
        command: 'updateConfig', 
        programPath: `${programPath}`,
        gdbPath: `${gdbPath}`,
        gdbAddress: `${gdbAddress}`,
        gdbPort: `${gdbPort}`,
        runnersHTML: `${newRunnersHTML}`,
        serverArgs: `${serverArgs}`
      });
    }
    
    async function applyHandler(message: any): Promise<void> {
      const projectPath = message.project;
      const buildConfigName = message.buildConfig.length > 0 ? message.buildConfig : undefined;
      const appProject = await getZephyrProject(projectPath);
      const buildConfig = appProject.getBuildConfiguration(buildConfigName);
      const programPath = message.programPath;
      const svdPath = message.svdPath;
      const gdbPath = message.gdbPath;
      const gdbAddress = message.gdbAddress;
      const gdbPort = message.gdbPort;
      const runnerName = message.runner;
      const runner = getRunner(runnerName);
      const runnerPath = message.runnerPath;
      const runnerArgs = message.runnerArgs;
    
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
          config.debugServerArgs = runner.getWestDebugArgs(buildConfig.relativeBuildDir);
          config.setupCommands = [];
          for(const arg of runner.getSetupCommands(programPath)) {
            config.setupCommands.push(arg);
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
      }
    }
    
    async function debugHandler(message: any): Promise<void> {
      const projectPath = message.project;
      const buildConfigName = message.buildConfig.length > 0 ? message.buildConfig : undefined;
      const runnerName = message.runner;
      const runner = getRunner(runnerName);
      if(runner) {
        const appProject = await getZephyrProject(projectPath);
        if(buildConfigName) {
          vscode.commands.executeCommand('zephyr-workbench.debug-manager.debug', 
            appProject.workspaceFolder,
            `${ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME} [${buildConfigName}]`);
        } else {
          // For legacy compatibility
          vscode.commands.executeCommand('zephyr-workbench.debug-manager.debug', 
            appProject.workspaceFolder,
            ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME);
        }
      } else {
        vscode.window.showErrorMessage('Debug manager: No debug runner selected!');
      }      
    }
  }  
}


