import * as vscode from 'vscode';
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";
import { createLaunchConfiguration as createDefaultConfiguration, createWestWrapper, getDebugRunners, getLaunchConfiguration, getRunner, getRunRunners, getServerAddressFromConfig, writeLaunchJson, ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME } from "../utils/debugUtils";
import { ZephyrAppProject } from "../models/ZephyrAppProject";
import { getZephyrProject } from '../utils/utils';
import { WestRunner } from '../debug/runners/WestRunner';
import { ZephyrProject } from '../models/ZephyrProject';

// @unused
// This class is unused but kept for potential future use
export class RunManagerPanel {
  public static currentPanel: RunManagerPanel | undefined;
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
    if (RunManagerPanel.currentPanel) {
      RunManagerPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
    } else {
      const panel = vscode.window.createWebviewPanel("run-manager-panel", "Run Manager", vscode.ViewColumn.One, {
        // Enable javascript in the webview
        enableScripts: true,
        // Restrict the webview to only load resources from the `out` directory
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out')]
      });

      RunManagerPanel.currentPanel = new RunManagerPanel(panel, extensionUri);
      RunManagerPanel.currentPanel.createContent();
    }
  }

  public dispose() {
    RunManagerPanel.currentPanel = undefined;
    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  public openFileDialog(elementId: string) {
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
          this._panel?.webview.postMessage({ command: 'fileSelected', id: elementId, fileUri: selectedFileUri.fsPath });
        }
      });
    }
  }

  private async _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
    const webviewUri = getUri(webview, extensionUri, ["out", "runmanager.js"]);
    const styleUri = getUri(webview, extensionUri, ["out", "style.css"]);
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
    for(let runner of getRunRunners()) {
      runnersHTML = runnersHTML.concat(`<div class="dropdown-item" data-value="${runner.name}" data-label="${runner.label}">${runner.label}</div>`);
    }
  
    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
          <link rel="stylesheet" href="${styleUri}">
          <title>Run Manager</title>
        </head>
        
        <body>
          <h1>Run Manager</h1>
          <form>
            <!-- Select Application Project -->
            <div class="grid-group-div">
              <div class="grid-header-div">
                <label for="listApplications">Select the application to run:</label>
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

            <!-- Program -->
            <fieldset>
              <legend>Program</legend> 
              <div class="grid-group-div">
                <vscode-text-field size="50" type="text" id="programPath" value="">Program Path:</vscode-text-field>
                <vscode-button id="browseProgramButton" class="browse-input-button" style="vertical-align: middle">Browse...</vscode-button>
              </div>
            </fieldset>

            <!-- Run server
              - path if required
              - address
              - port
            -->
            <fieldset>
              <legend>Run Server</legend> 
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

              <div class="grid-group-div">
                <vscode-text-field size="50" type="text" id="runnerPath" value="">Runner Path:</vscode-text-field>
                <vscode-button id="browseRunnerButton" class="browse-input-button" style="vertical-align: middle">Browse...</vscode-button>
              </div>
            
              <div class="grid-group-div">
                <vscode-text-field size="50" type="text" id="runnerArgs" value="">Additional arguments:</vscode-text-field>
              </div>
            </fieldset>

            <!-- Control buttons -->
            <div class="grid-group-div">
              <vscode-button id="resetButton" class="finish-input-button">Reset Default</vscode-button>
              <vscode-button id="applyButton" class="finish-input-button">Apply</vscode-button>
              <vscode-button id="runButton" class="finish-input-button">Run</vscode-button>
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
              await updateConfiguration(appProject);
            }
            break;
          }
          case 'runnerChanged': {
            const runnerName = message.runner;
            const runner = getRunner(runnerName);
            if(runner) {
              updateRunnerConfiguration(runner);
            }
            break;
          }
          case 'browseProgram': {
            this.openFileDialog('programPath');
            break;
          }
          case 'browseRunner': {
            this.openFileDialog('runnerPath');
            break;
          }
          case 'reset': {
            await resetHandler(message);
          }
          case 'apply': {
            await applyHandler(message);
            break;
          }
          case 'debug': {
            await applyHandler(message);
            await runHandler(message);
            break;
          }
          default:
            break;
        }
      },
      undefined,
      this._disposables
    );

    async function updateConfiguration(project: ZephyrProject) {
      // Extract information from configuration
      let [launchJson, config] = await getLaunchConfiguration(project);
      const programPath = config.program;

      let newRunnersHTML = '';
      let compatibleRunners = await project.getCompatibleRunners();
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
        runnersHTML: `${newRunnersHTML}`,
        runnerName: `${runnerLabel}`,
        runnerPath: `${runnerPath}`,
        runnerArgs: `${runnerArgs}`
      });
    }

    function updateRunnerConfiguration(runner: WestRunner) {
      webview.postMessage({ 
        command: 'updateRunnerConfig', 
        runnerPath: runner.serverPath? runner.serverPath:'',
        runnerArgs: runner.userArgs? runner.userArgs:''
      });
    }

    async function resetHandler(message: any) {
      const projectPath = message.project;
      const appProject = await getZephyrProject(projectPath);
      if(appProject) {
        await resetConfiguration(appProject);
      }
    }
    
    async function resetConfiguration(project: ZephyrProject) {
      let config = await createDefaultConfiguration(project);
      const programPath = config.program;

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
        runnersHTML: `${newRunnersHTML}`,
        serverArgs: `${serverArgs}`
      });
    }
    
    async function applyHandler(message: any) {
      const projectPath = message.project;
      const buildConfigName = message.buildConfig.length > 0 ? message.buildConfig : undefined;
      const appProject = await getZephyrProject(projectPath);
      const buildConfig = appProject.getBuildConfiguration(buildConfigName);
      const programPath = message.programPath;
      const runnerName = message.runner;
      const runner = getRunner(runnerName);
      const runnerPath = message.runnerPath;
      const runnerArgs = message.runnerArgs;
    
      if(appProject && buildConfig) {
        let [launchJson, config] = await getLaunchConfiguration(appProject);
        config.program = programPath;
    
        if(runner) {
          runner.loadArgs(runnerArgs);
          runner.serverPath = runnerPath;
          config.serverStarted = runner.serverStartedPattern;
          config.debugServerArgs = runner.getWestDebugArgs(buildConfig.relativeBuildDir);
          config.setupCommands = [];
        }
        writeLaunchJson(launchJson, appProject);
      }
    }
    
    async function runHandler(message: any) {
      const projectPath = message.project;
      const appProject = await getZephyrProject(projectPath);
      vscode.commands.executeCommand('zephyr-workbench.run-manager.rune', 
        appProject.workspaceFolder,
      );
    }
  }  
}


