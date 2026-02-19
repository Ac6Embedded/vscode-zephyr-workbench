import * as vscode from "vscode";
import fs from "fs";
import yaml from 'yaml';
import path from "path";
import { execSync } from "child_process";
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";
import { getRunner } from "../utils/debugUtils";
import { getInternalDirRealPath } from "../utils/utils";
import { formatYml } from "../utilities/formatYml";
import { setExtraPath as setEnvExtraPath, removeExtraPath as removeEnvExtraPath } from "../utils/envYamlUtils";
import { Aliases, Tools } from "../interface/interfaceDebugTools";

export class DebugToolsPanel {

  private _envWatcher: fs.FSWatcher | undefined;
	
  public static currentPanel: DebugToolsPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private data: any;
  private envData: any | undefined;
  // store parsed YAML Document to preserve comments/structure when updating
  private envYamlDoc: any | undefined;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    const yamlFile = fs.readFileSync(vscode.Uri.joinPath(this._extensionUri, 'scripts', 'runners', 'debug-tools.yml').fsPath, 'utf8');
    this.data = yaml.parse(yamlFile);

    // Load env.yml to retrieve installed paths for runners (if present)
    try {
      const envYamlPath = path.join(getInternalDirRealPath(), 'env.yml');
      if (fs.existsSync(envYamlPath)) {
        const envYaml = fs.readFileSync(envYamlPath, 'utf8');
        this.envData = yaml.parse(envYaml);
        // Preserve the parsed Document so we can update only specific nodes later
        this.envYamlDoc = yaml.parseDocument(envYaml);
        // Add watcher to auto-reload when env.yml was changed externally (installed from extension or manually edited)
        this._envWatcher = fs.watch(envYamlPath, async () => {
          this.reloadEnvYaml();
          this._panel.webview.html = await this._getWebviewContent(this._panel.webview, this._extensionUri);
        });
      }
    } catch (e) {
      // Ignore if not found or invalid; details will show fallback
      this.envData = undefined;
      this.envYamlDoc = undefined;
    }
  }

  public async createContent() {
    this._panel.webview.html = await this._getWebviewContent(this._panel.webview, this._extensionUri);
    this._setWebviewMessageListener(this._panel.webview);

    // when panel becomes visible again, re-generate HTML so env.yml is re-read
    this._panel.onDidChangeViewState(async () => {
      if (this._panel.visible) {
        this._panel.webview.html = await this._getWebviewContent(this._panel.webview, this._extensionUri);
        //we do NOT call _setWebviewMessageListener again (already registered)
      }
    }, null, this._disposables);
  }

  private async loadVersions() {
    const versionPromises = this.data.debug_tools.map(async (tool: any) => {
      if (tool.alias) {
        const alias = tool.alias;
        const installed = this.isOpenocdVariantInstalled(tool.tool);
        const status = installed ? 'Installed' : 'Not installed';
        this._panel.webview.postMessage({
          command: "detect-done",
          tool: tool.tool,
          version: "",
          status,
        });

        if (this.getDefaultToolForAlias(alias) === tool.tool) {
          if (installed) {
            await this.ensureOpenocdAliasEntry(alias, tool.tool);
          }
          this._panel.webview.postMessage({
            command: "detect-done",
            tool: alias,
            version: installed ? (tool.version || "") : "",
            status,
          });
        }
        return;
      }

      // For alias groups (e.g. OpenOCD variants), detect only the configured default tool.
      if (tool.alias) {
        const defaultTool = this.getDefaultToolForAlias(tool.alias);
        if (defaultTool && tool.tool !== defaultTool) {
          this._panel.webview.postMessage({
            command: "detect-done",
            tool: tool.tool,
            version: tool.version || "",
            status: "Not installed",
          });
          return;
        }
      }

      // Use alias if present, otherwise use tool
      const runnerAlias = tool.alias || tool.tool;

      const runner = getRunner(runnerAlias);
      
      if (!runner) {
        // Unknown runner -> consider not installed
        this._panel.webview.postMessage({
          command: "detect-done",
          tool: tool.tool,
          version: tool.version || "",
          status: "Not installed",
        });
        return;
      }

      runner.loadArgs(undefined);
      try {
        const installedVersion = await runner.detectVersion();
        const actualVersion = tool.version;
        const hasDifferentVersion = this.hasNewVersionByEnv(tool.tool, actualVersion);
        const status = installedVersion
          ? (hasDifferentVersion ? "New Version Available" : "Installed")
          : "Not installed";
        let reportedVersion = installedVersion || actualVersion || "";

        if (status === "Not installed") {
          reportedVersion = "";
        }

        if (installedVersion) {
          tool.found = hasDifferentVersion ? "New Version Available" : "Installed";
        }

        // Update UI immediately after each finishes
        this._panel.webview.postMessage({
          command: "detect-done",
          tool: tool.tool,
          version: reportedVersion,
          status,
        });
        if (tool.alias && this.getDefaultToolForAlias(tool.alias) === tool.tool) {
          this._panel.webview.postMessage({
            command: "detect-done",
            tool: tool.alias,
            version: reportedVersion,
            status,
          });
        }
      } catch (err) {
        console.warn(`Version check failed for ${tool.tool}:`, err);
        this._panel.webview.postMessage({
          command: "detect-done",
          tool: tool.tool,
          version: tool.version || "",
          status: "Not installed",
        });
        if (tool.alias && this.getDefaultToolForAlias(tool.alias) === tool.tool) {
          this._panel.webview.postMessage({
            command: "detect-done",
            tool: tool.alias,
            version: tool.version || "",
            status: "Not installed",
          });
        }
      }
    });

    // Run all in parallel
    await Promise.all(versionPromises);
  }


  public static render(extensionUri: vscode.Uri) {
    if (DebugToolsPanel.currentPanel) {
      DebugToolsPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
    } else {
      const panel = vscode.window.createWebviewPanel("zephyr-workbench.install-runners.panel", "Install Runners", vscode.ViewColumn.One, {
        // Enable javascript in the webview
        enableScripts: true,
        // Restrict the webview to only load resources from the `out` directory
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out')]
      }); 
      panel.iconPath = {
      	light: vscode.Uri.joinPath(extensionUri, 'res', 'icons', 'light', 'desktop-download.svg'),
      	dark: vscode.Uri.joinPath(extensionUri, 'res', 'icons', 'dark', 'desktop-download.svg')
      };

      DebugToolsPanel.currentPanel = new DebugToolsPanel(panel, extensionUri);
      DebugToolsPanel.currentPanel.createContent();
    }
  }

  public dispose() {
    DebugToolsPanel.currentPanel = undefined;

    if (this._envWatcher) {
      this._envWatcher.close();
      this._envWatcher = undefined;
    }

    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private async getPacksHTML(): Promise<string> {
    let packsHTML = '';
    for(let pack of this.data.packs) {
      let listToolsName: string[] = [];
      pack.tools.forEach((packTool: string) => {
        const tool = this.data.debug_tools.find((t: { tool: string; }) => t.tool === packTool);
        if (!tool) { return; }
        // Include compatible tools and link-only ones (with website but no downloadable source)
        const compatible = this.isToolCompatible(tool);
        const linkOnly = !!tool.website && !compatible;
        if (compatible || linkOnly) {
          listToolsName.push(tool.name);
        }
      });
      
      if(listToolsName.length > 0) {
        packsHTML += `<tr id="row-${pack.pack}">
          <td></td>
          <td id="name-${pack.pack}">${pack.name} <span class="description">(${listToolsName.join(', ')})</span></td>
          <td></td>
          <td></td>
          <td id="buttons-${pack.pack}">`;

        packsHTML +=` <vscode-button appearance="icon" class="install-pack-button" data-pack="${pack.pack}" data-tools="${pack.tools.join(';')}">
                        <span class="codicon codicon-desktop-download"></span>
                      </vscode-button>
                      <!--vscode-button appearance="icon" class="remove-button" data-pack="${pack.pack}">
                        <span class="codicon codicon-trash"></span>
                      </vscode-button-->`;

        packsHTML +=`</td>
          <td><div class="progress-wheel" id="progress-${pack.pack}"><vscode-progress-ring></vscode-progress-ring></div></td>
        </tr>`;
      }
    }
    return packsHTML;
  }

  private async getToolsHTML(): Promise<string> {
    let toolsHTML = '';
    
    const hasAlias = new Map<string, any[]>(); // for OpenOCD variants. This is a dictionary
    const noAlias: any = []; // for the other runners as J-link and others. This is an array

    // We get the datas for those who have alias or not (OpenOCD variants and the other runners)
    for (const tools of this.data.debug_tools) {
      if(!tools.alias){
        // if does not have alias, we just push this data to noAlias array (it means that they are not OpenOCDs)
        noAlias.push(tools);
        continue;
      }
      if (!hasAlias.has(tools.alias)) {
        // if hasAlias Map does not have this alias yet, we create an empty array for this
        hasAlias.set(tools.alias, []);
      }
      hasAlias.get(tools.alias)!.push(tools); // we send the data to the alias array
    }
    
    // Convert hasAlias (which is a dictionary) to array of [alias, tools] for iteration, e.g: [openocd, [openocd-stm32, openocd-zephyr]]
    const aliases = Array.from(hasAlias.entries());
    
    // Load information about tools with alias, e.g : [alias = openocd, tools = [openocd-stm32, openocd-zephyr]]  
    for (const [alias, tools] of aliases) {
      
      // "info" try to acess the object Aliases and try to find the same alias to Aliases and Tool, e.g: a.alias === alias
      const info = this.data.aliases?.find((a:Aliases) => a.alias === alias) || {};
      const parentToolName = info.name || '-';

      // Get default tool from env.yml, fallback to debug-tools.yml default
      const defaultDebugToolsYml = this.data.aliases?.find((a:Aliases) => a.alias === alias)?.default;
      const defaultEnvYml = this.envData?.runners?.[alias]?.default || defaultDebugToolsYml || tools[0].tool;

      // try to find parent info from Aliases (OpenOCD), then we check the default tools to use your version and status (found) to display at the parent row
      const parentTool = this.data.debug_tools.find((t: any) => t.tool === defaultEnvYml);
      
      // Parent row, show version and status from default tool choosen
      toolsHTML += `<tr id="row-${alias}">
        <td><button type="button" class="inline-icon-button expand-button codicon codicon-chevron-right" data-tool="${alias}" aria-label="Expand/Collapse"></button></td>
        <td id="name-${alias}">${parentToolName}</td>
        <td id="version-${alias}">${parentTool?.version || ''}</td>
        <td id="detect-${alias}">${parentTool?.found || ''}</td>
        <td></td>
        <td><div class="progress-wheel" id="progress-${alias}"><vscode-progress-ring></vscode-progress-ring></div></td>
      </tr>`;
      
      // Details row for path/edit (like other tools)
      const pathValue = this.getRunnerPath(alias) ?? '';
      const addToPathChecked = (this.envData?.runners?.[alias]?.do_not_use !== true) ? 'checked' : '';
      toolsHTML += `<tr id="details-${alias}" class="details-row hidden">
        <td></td>
        <td><div id="details-content-${alias}" class="details-content">
          <div class="grid-group-div">
            <vscode-text-field id="details-path-input-${alias}" class="details-path-field" 
              placeholder="Enter the tool's path if not in the global PATH" value="${pathValue}" size="50" disabled>Path:</vscode-text-field>
            <vscode-button id="browse-path-button-${alias}" class="browse-input-button" appearance="secondary" disabled>
              <span class="codicon codicon-folder"></span>
            </vscode-button>
          </div></div></td>
        <td><vscode-button appearance="primary" class="save-path-button" data-tool="${alias}">Edit</vscode-button></td>
        <td><vscode-checkbox class="add-to-path" data-tool="${alias}" ${addToPathChecked} disabled> Add to PATH</vscode-checkbox></td>
        <td></td><td></td>
      </tr>`;
      
      // Child rows (variants for OpenOCD) 
      for (let tool of tools) {
        const childToolName = tool.name;
        const isDefault = tool.tool === defaultEnvYml;
        const childVersion = alias ? '' : (tool.version || '');
        
        toolsHTML += `<tr id="row-${tool.tool}" class="details-row hidden alias-variant-row">
          <td></td>
          <td style="padding-left:20px">
            <span class="alias-variant-name">${childToolName}</span>
            <vscode-checkbox class="set-default-checkbox" data-tool="${tool.tool}" data-alias="${alias}" ${isDefault ? 'checked' : ''}> Set default</vscode-checkbox>
          </td>
          <td id="version-${tool.tool}">${childVersion}</td>
          <td id="detect-${tool.tool}">${tool.found || ''}</td>
          <td id="buttons-${tool.tool}">`;
        
        // Add install/website buttons to OpenOCDs child rows 
        let hasSource = false;
        if (tool.os) {
          switch(process.platform) {
            case 'linux':
              hasSource = tool.os.linux ? true : false;
              break;
            case 'win32':
              hasSource = tool.os.windows ? true : false;
              break;
            case 'darwin':
              hasSource = tool.os.darwin ? true : false;
              break;
          }
          if (hasSource) {
            toolsHTML += `<vscode-button appearance="icon" class="install-button" data-tool="${tool.tool}">
              <span class="codicon codicon-desktop-download"></span>
            </vscode-button>`;
          }
        }
        
        if (tool.website) {
          toolsHTML += `<vscode-button appearance="icon" class="website-button" data-tool="${tool.tool}">
            <a href="${tool.website}"><span class="codicon codicon-link"></span></a>
          </vscode-button>`;
        }
        
        toolsHTML += `</td>
          <td><div class="progress-wheel" id="progress-${tool.tool}"><vscode-progress-ring></vscode-progress-ring></div></td>
        </tr>`;
      }
    }
    
    // Render the other tools (J-link for example)
    for(let tool of noAlias) {
      let toolHTML = '';
      let hasSource = false;

      // Keep YAML version for comparisons; render empty cells initially.
      const initialVersion = '';
      const initialStatus = '';

      toolHTML += `<tr id="row-${tool.tool}">`;
      // Show expand button only if no_edit is not true
      if (tool.no_edit !== true) {
        toolHTML += `<td><button type="button" class="inline-icon-button expand-button codicon codicon-chevron-right" data-tool="${tool.tool}" aria-label="Expand/Collapse"></button></td>`;
      } else {
        toolHTML += `<td></td>`; // empty cell if no_edit is true
      }

      toolHTML += `<td id="name-${tool.tool}">${tool.name}</td>
        <td id="version-${tool.tool}">${initialVersion}</td>
        <td id="detect-${tool.tool}">${initialStatus}</td>
        <td id="buttons-${tool.tool}">`;

      if(tool.os) {
        switch(process.platform) {
          case 'linux':
            hasSource = tool.os.linux ? true : false;
            break;
          case 'win32':
            hasSource = tool.os.windows ? true : false;
            break;
          case 'darwin':
            hasSource = tool.os.darwin ? true : false;
            break;
        }
        if(hasSource) {
          toolHTML +=`<vscode-button appearance="icon" class="install-button" data-tool="${tool.tool}">
                         <span class="codicon codicon-desktop-download"></span>
                       </vscode-button>`;
        }
      }

      if(tool.website) {
        toolHTML +=`<vscode-button appearance="icon" class="website-button" data-tool="${tool.tool}">
                      <a href="${tool.website}">
                        <span class="codicon codicon-link"></span>
                      </a>
                    </vscode-button>`;
      }
      
      toolHTML +=`  </td>
        <td>`;
        if(this.isToolCompatible(tool)) {
          toolHTML +=`<div class="progress-wheel" id="progress-${tool.tool}"><vscode-progress-ring></vscode-progress-ring></div>`;
        }
        `</td>
      </tr>`;

      // Hidden details. It can be opened just below the main row
      const pathValue = this.getRunnerPath(tool.tool) ?? '';
        const pathHtml = `
          <div class="grid-group-div">
            <vscode-text-field id="details-path-input-${tool.tool}" class="details-path-field" 
              placeholder="Enter the tool's path if not in the global PATH" value="${pathValue}" size="50" disabled>Path:</vscode-text-field>
            <vscode-button id="browse-path-button-${tool.tool}" class="browse-input-button" appearance="secondary" disabled>
              <span class="codicon codicon-folder"></span>
            </vscode-button>
          </div>`;
        // Checkbox default: checked unless env.yml explicitly sets do_not_use=true
        const addToPathChecked = (this.envData?.runners?.[tool.tool]?.do_not_use !== true) ? 'checked' : '';
        //Checkbox default: always disabled 
        const addToPathState = 'disabled'; 
        // Keep the button label as "Edit" by default and do not disable it
        const saveBtnLabel = 'Edit';
        const saveBtnState = '';

          toolHTML += `<tr id="details-${tool.tool}" class="details-row hidden">
            <td></td>
            <td><div id="details-content-${tool.tool}" class="details-content">${pathHtml}</div></td>
          <td>
            <vscode-button appearance="primary" class="save-path-button" data-tool="${tool.tool}" ${saveBtnState}>${saveBtnLabel}</vscode-button>
          </td>
          <td>
              <vscode-checkbox class="add-to-path" data-tool="${tool.tool}" ${addToPathChecked} ${addToPathState}/> Add to PATH</vscode-checkbox>
          </td>
          <td></td>
          <td></td>
        </tr>`;

      if(tool.website || hasSource) {
        toolsHTML += toolHTML;
      }
    }
    return toolsHTML;
  }

  private async getExtraPathRunner(): Promise<string> {
    let extraToolsHTML = '';
    const paths = this.envData?.other?.EXTRA_RUNNERS?.path;
    if (Array.isArray(paths) && paths.length > 0) {
      paths.forEach((path: string, idx: number) => {
        extraToolsHTML += `
          <tr id="extra-row-${idx}">
            <td>
              <button type="button" class="inline-icon-button expand-button codicon codicon-chevron-right" data-extra-idx="${idx}" aria-label="Expand/Collapse"></button>
            </td>
            <td>Current Path: ${path}</td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
          </tr>
          <tr id="extra-details-${idx}" class="details-row extra-details-row hidden">
            <td></td>
               <td colspan="5">
                 <div id="extra-details-content-${idx}" class="details-content">
                   <div class="grid-group-div extra-grid-group">
                     <vscode-text-field id="extra-path-input-${idx}" class="details-path-field" value="${path}" size="50" disabled>New Path:</vscode-text-field>
                     <vscode-button id="browse-extra-path-button-${idx}" class="browse-extra-input-button" appearance="secondary" disabled>
                       <span class="codicon codicon-folder"></span>
                     </vscode-button>
                     <vscode-button id="edit-extra-path-btn-${idx}" class="edit-extra-path-button save-path-button" appearance="primary">Edit</vscode-button>
                     <vscode-button id="remove-extra-path-btn-${idx}" class="remove-extra-path-button" appearance="secondary" disabled>Remove</vscode-button>
                   </div>
                 </div>
               </td>
          </tr>
        `;
      });
    }
    // Add button to append a new extra runner path at the end
      extraToolsHTML += `
        <tr>
          <td></td>
          <td colspan="5">
            <vscode-button id="add-extra-path-btn" appearance="secondary">Add</vscode-button>
          </td>
        </tr>
      `;
    return extraToolsHTML;
  }
  
  private async _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
    const webviewUri = getUri(webview, extensionUri, ["out", "debugtools.js"]);
    const styleUri = getUri(webview, extensionUri, ["out", "style.css"]);
    const codiconUri = getUri(webview, extensionUri, ["out", "codicon.css"]);
    
    const nonce = getNonce();
    const packsHTML = await this.getPacksHTML();
    const toolsHTML = await this.getToolsHTML();
    const extraToolsHTML = await this.getExtraPathRunner();
      
    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
          <link nonce="${nonce}" rel="stylesheet" href="${styleUri}">
          <link nonce="${nonce}" rel="stylesheet" href="${codiconUri}">
          <title>Install Runners</title>
        </head>
        
        <body>
          <h1>Install Runners</h1>
          <a class="help-link" href="https://zephyr-workbench.com/docs/documentation/debug-tools">Read Docs</a>
          <form>
            <h2>Packs</h2>
            <table class="debug-tools-table">
              <tr>
                <th></th>
                <th>Pack</th>
                <th></th>
                <th></th>
                <th>Install</th>
                <th></th>
              </tr>
              ${packsHTML}
            </table>
          </form>
          <form>
            <h2> Runners</h2>
            <table class="debug-tools-table">
              <tr>
                <th></th>
                <th>Name</th>
                <th>Version</th>
                <th id="status-header"><span>Status</span>
                  <vscode-button appearance="icon" id="refresh-status-btn" class="header-icon-button" title="Refresh installation status">
                    <span class="codicon codicon-refresh"></span>
                  </vscode-button>
                </th>
                <th>Install</th>
                <th></th>
              </tr>
              ${toolsHTML}
            </table>
          </form>
          <form>
            <h2>
              Extra Runners
                <span class="tooltip-extra" data-tooltip="Add custom locations to the system PATH">?</span>
            </h2>
            <table class="debug-tools-table">
              <tr>
                <th></th>
                <th>Custom runners:</th>
                <th></th>
                <th></th>
                <th></th>
                <th></th>
              </tr>
              ${extraToolsHTML}
            </table>
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
          case 'webview-ready': {
            await this.loadVersions();
            break;
          }
          case 'refresh-all': {
            // Re-run detection for all tools; UI already cleared by webview
            await this.loadVersions();
            break;
          }
          case 'add-extra-path': {
            // Do not modify env.yml on Add. Insert a local row only; persist on Done/Enter.
            try {
              const count = Array.isArray(this.envData?.other?.EXTRA_RUNNERS?.path)
                ? this.envData.other.EXTRA_RUNNERS.path.length
                : 0;
              webview.postMessage({ command: 'add-extra-path-done', idx: count });
            } catch (e) {
              webview.postMessage({ command: 'add-extra-path-done', idx: 0 });
            }
            break;
          }
          case 'detect': {
            const tool = this.data.debug_tools.find((t: { tool: string; }) => t.tool === message.tool);
            if (!tool) {
              webview.postMessage({
                command: 'detect-done',
                tool: message.tool,
                version: '',
                status: 'Not installed',
              });
              break;
            }

            if (tool.alias) {
              const alias = tool.alias;
              const status = this.isOpenocdVariantInstalled(tool.tool) ? 'Installed' : 'Not installed';
              webview.postMessage({
                command: 'detect-done',
                tool: message.tool,
                version: '',
                status,
              });
              if (this.getDefaultToolForAlias(alias) === tool.tool) {
                webview.postMessage({
                  command: 'detect-done',
                  tool: alias,
                  version: status === 'Installed' ? (tool.version || '') : '',
                  status,
                });
              }
              break;
            }

            if (tool.alias) {
              const defaultTool = this.getDefaultToolForAlias(tool.alias);
              if (defaultTool && tool.tool !== defaultTool) {
                webview.postMessage({
                  command: 'detect-done',
                  tool: message.tool,
                  version: tool.version || '',
                  status: 'Not installed',
                });
                break;
              }
            }

            const runnerAlias = tool?.alias || message.tool;

            let runner = getRunner(runnerAlias);
            if(runner) {
              runner.loadArgs(undefined);
              let version = await runner.detectVersion();
              const expectedVersion = tool?.version || '';
              const hasDifferentVersion = this.hasNewVersionByEnv(message.tool, expectedVersion);
              const status = version
                ? (hasDifferentVersion ? 'New Version Available' : 'Installed')
                : 'Not installed';
              let reportedVersion = version || expectedVersion || '';
              if (status === 'Not installed') {
                reportedVersion = '';
              }
              webview.postMessage({ 
                command: 'detect-done', 
                tool: message.tool,
                version: reportedVersion,
                status,
              });
              if (tool.alias && this.getDefaultToolForAlias(tool.alias) === tool.tool) {
                webview.postMessage({
                  command: 'detect-done',
                  tool: tool.alias,
                  version: reportedVersion,
                  status,
                });
              }
            } else {
              webview.postMessage({
                command: 'detect-done',
                tool: message.tool,
                version: tool.version || '',
                status: 'Not installed',
              });
              if (tool.alias && this.getDefaultToolForAlias(tool.alias) === tool.tool) {
                webview.postMessage({
                  command: 'detect-done',
                  tool: tool.alias,
                  version: tool.version || '',
                  status: 'Not installed',
                });
              }
            }
            break;
          }
          case 'debug':
            vscode.window.showInformationMessage(message.text);
            return;
          case 'install-pack':
            {
              const selectedPack = this.data.packs.find((pack: { pack: string; }) => pack.pack === message.pack);
              const tools: any[] = [];
              const linkOnlyWebsites: string[] = [];

              selectedPack.tools.forEach((packTool: string) => {
                const tool = this.data.debug_tools.find((t: { tool: string; }) => t.tool === packTool);
                if (!tool) { return; }
                const compatible = this.isToolCompatible(tool);
                const hasWebsite = !!tool.website;
                if (compatible) {
                  tools.push(tool);
                } else if (hasWebsite) {
                  linkOnlyWebsites.push(String(tool.website));
                }
              });

              for (const url of linkOnlyWebsites) {
                try { await vscode.env.openExternal(vscode.Uri.parse(url)); } catch {}
              }

              if (tools.length > 0) {
                vscode.commands.executeCommand("zephyr-workbench.run-install-debug-tools", this._panel, tools);
              }
            }
            break;
          case 'install':
            let selectedTool = this.data.debug_tools.find((tool: { tool: string; }) => tool.tool === message.tool);
            vscode.commands.executeCommand("zephyr-workbench.run-install-debug-tools", this._panel, [ selectedTool ]);
            break;
          case 'set-default': {
            const { tool, alias } = message;
            try {
              const envYamlPath = path.join(getInternalDirRealPath(), 'env.yml');
              let doc: any;
              if (fs.existsSync(envYamlPath)) {
                const text = fs.readFileSync(envYamlPath, 'utf8');
                doc = yaml.parseDocument(text);
              } else {
                doc = yaml.parseDocument('{}');
              }
              
              // For OpenOCD alias, keep only runners.openocd and remove variant keys
              if (alias) {
                const aliasVariants = this.data.debug_tools
                  .filter((t: any) => t.alias === alias)
                  .map((t: any) => t.tool);
                for (const variantId of aliasVariants) {
                  doc.deleteIn(['runners', variantId]);
                }
              }

              // Keep alias path/version aligned with the selected default variant
              const selectedTool = this.data.debug_tools.find((t: any) => t.tool === tool);
              let selectedPath = this.getRunnerPath(tool);
              if (!selectedPath && selectedTool?.install_dir) {
                selectedPath = path.join(getInternalDirRealPath(), 'tools', selectedTool.install_dir, 'bin').replace(/\\/g, '/');
              }
              if (tool === 'openocd-custom'){
                doc.setIn(['runners', alias, 'path'], '');
              } else if (selectedPath) {
                doc.setIn(['runners', alias, 'path'], selectedPath);
              }
              if (selectedTool?.version) {
                doc.setIn(['runners', alias, 'version'], selectedTool.version);
              }
              const defaultFromDebugTools = this.data.aliases?.find((a: Aliases) => a.alias === alias)?.default;
              if (tool !== defaultFromDebugTools) {
                doc.setIn(['runners', alias, 'default'], tool);
              } else {
                doc.deleteIn(['runners', alias, 'default']);
              }

              formatYml(doc.contents);
              const yamlText = yaml.stringify(yaml.parse(doc.toString()), { flow: false });
              fs.writeFileSync(envYamlPath, yamlText, 'utf8');
              this.reloadEnvYaml();
              vscode.window.showInformationMessage(`Set ${tool} as default for ${alias}`);
              webview.postMessage({ command: 'exec-install-finished' });
            } catch (e) {
              vscode.window.showErrorMessage(`Failed to set default`);
            }
            break;
          }
          case 'update-path': {
            // Persist new path to env.yml and send back confirmation
            const { tool, newPath, addToPath } = message;
            const trimmedPath = (newPath ?? '').trim();

            // Only save if path is not empty
            if (!trimmedPath) {

              // Remove path from env.yml when it was previously set and then gets cleared
              await this.removeRunnerPath(tool);

              // Do not save anything, just return success false
              webview.postMessage({ command: 'path-updated', tool, path: '', success: false });
              break;
            }

            // Save path
            const savedPath = await this.saveRunnerPath(tool, trimmedPath);

            // Save do_not_use together (if addToPath is present in message)
            let savedDoNotUse = true;
            if (typeof addToPath !== 'undefined') {
              savedDoNotUse = await this.saveDoNotUse(tool, !addToPath);
            }
            const success = savedPath && savedDoNotUse;
            webview.postMessage({ command: 'path-updated', tool, path: trimmedPath, success });
            if (success) {
              // Re-detect installation/version right after saving the path
              const runner = getRunner(tool);
              if (runner) {
                runner.loadArgs(undefined);
                const version = await runner.detectVersion();
                webview.postMessage({ command: 'detect-done', tool, version: version ? version : '' });
              }
              // Trigger a full refresh of all runners after edit completes
              webview.postMessage({ command: 'exec-install-finished' });
            } else {
              vscode.window.showErrorMessage(`Failed to update path for ${tool}`);
            }
            break;
          }
          case 'browse-path': {
            const { tool, addToPath } = message;
            const pick = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: `Select the path for ${tool}` });
            if (pick && pick[0]) {
              const chosen = pick[0].fsPath.trim();
              if (!chosen) {
                webview.postMessage({ command: 'path-updated', tool, path: '', success: false });
                break;
              }
              const okPath = await this.saveRunnerPath(tool, chosen);
              const okDoNotUse = typeof addToPath !== 'undefined' ? await this.saveDoNotUse(tool, !addToPath) : true;
              const ok = okPath && okDoNotUse;
              webview.postMessage({ command: 'path-updated', tool, path: chosen, success: ok, FromBrowse: true });
              if (ok) {
                // Re-detect installation/version with the newly saved path
                const runner = getRunner(tool);
                if (runner) {
                  runner.loadArgs(undefined);
                  const version = await runner.detectVersion();
                  webview.postMessage({ command: 'detect-done', tool, version: version ? version : '' });
                }
                // Trigger a full refresh of all runners after edit completes
                webview.postMessage({ command: 'exec-install-finished' });
              }
            }
            break;
          }
          case 'toggle-add-to-path': {
            // Do NOT save do_not_use here, only update frontend state
            const { tool, addToPath } = message;
            webview.postMessage({ command: 'add-to-path-updated', tool, doNotUse: !addToPath });
            break;
          }
          case 'remove':
            vscode.window.showErrorMessage(`Remove ${message.tool} is not implemented yet`);
            break;
          case 'update-extra-path': {
            try {
              const idx: number = Number(message.idx);
              const newPathRaw: string = (message.newPath ?? '').toString();
              const trimmed = newPathRaw.trim();
              if (!Number.isInteger(idx) || idx < 0) {
                webview.postMessage({ command: 'extra-path-updated', idx, path: '', success: false, error: 'Invalid index' });
                break;
              }
              if (!trimmed) {
                vscode.window.showErrorMessage('Please provide a valid path');
                webview.postMessage({ command: 'extra-path-updated', idx, path: '', success: false, error: 'Empty path' });
                break;
              }
              const updated = setEnvExtraPath('EXTRA_RUNNERS', idx, trimmed);
              this.envData = updated;
              webview.postMessage({ command: 'extra-path-updated', idx, path: trimmed.replace(/\\/g, '/'), success: true });
              // Rebuild UI to update summary row with saved path
              this._panel.webview.html = await this._getWebviewContent(webview, this._extensionUri);
            } catch (e) {
              webview.postMessage({ command: 'extra-path-updated', idx: message.idx, path: '', success: false, error: 'Exception updating extra path' });
            }
            break;
          }
          case 'browse-extra-path': {
            try {
              const idx: number = Number(message.idx);
              if (!Number.isInteger(idx) || idx < 0) {
                webview.postMessage({ command: 'extra-path-updated', idx, path: '', success: false, error: 'Invalid index' });
                break;
              }
              const pick = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: 'Select extra runner path' });
              if (!pick || !pick[0]) { break; }
              const chosen = pick[0].fsPath.trim();
              if (!chosen) {
                webview.postMessage({ command: 'extra-path-updated', idx, path: '', success: false });
                break;
              }
              // Persist via shared helper
              this.envData = setEnvExtraPath('EXTRA_RUNNERS', idx, chosen);
              webview.postMessage({ command: 'extra-path-updated', idx, path: chosen.replace(/\\/g, '/'), success: true });
              // Refresh UI so summary row updates
              this._panel.webview.html = await this._getWebviewContent(webview, this._extensionUri);
            } catch (e) {
              webview.postMessage({ command: 'extra-path-updated', idx: message.idx, path: '', success: false, error: 'Browse failed' });
            }
            break;
          }
          case 'remove-extra-path': {
            try {
              const idx: number = Number(message.idx);
              if (!Number.isInteger(idx) || idx < 0) {
                webview.postMessage({ command: 'extra-path-removed', idx, success: false, error: 'Invalid index' });
                break;
              }
              this.envData = removeEnvExtraPath('EXTRA_RUNNERS', idx);
              webview.postMessage({ command: 'extra-path-removed', idx, success: true });
            } catch (e) {
              webview.postMessage({ command: 'extra-path-removed', idx: message.idx, success: false, error: 'Exception removing extra path' });
            }
            break;
          }
        }
      },
      undefined,
      this._disposables
    );
  }

  private isToolCompatible(tool: any): boolean {
    if(tool.os) {
      switch(process.platform) {
        case 'linux':
          return tool.os.linux ? true : false;
        case 'win32':
          return tool.os.windows ? true : false;
        case 'darwin':
          return tool.os.darwin ? true : false;
      }
    }
    return false;
  }

  private hasNewVersionByEnv(toolId: string, expectedVersion: unknown): boolean {
    try {
      const normalize = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/^v/, '');
      const envVersion = (this.envData as any)?.runners?.[toolId]?.version;
      const expectedNorm = normalize(expectedVersion);
      const envNorm = normalize(envVersion);
      return expectedNorm.length > 0 && envNorm.length > 0 && expectedNorm !== envNorm;
    } catch {
      return false;
    }
  }

  private getDefaultToolForAlias(alias: string): string | undefined {
    const defaultDebugToolsYml = this.data.aliases?.find((a: Aliases) => a.alias === alias)?.default;
    const firstAliasTool = this.data.debug_tools.find((t: any) => t.alias === alias)?.tool;
    return this.envData?.runners?.[alias]?.default || defaultDebugToolsYml || firstAliasTool;
  }

  // Ensure env.yml has runners.openocd aligned with the installed default variant.
  private async ensureOpenocdAliasEntry(alias: string, defaultToolId: string): Promise<void> {
    try {
      const selectedTool = this.data.debug_tools.find((t: any) => t.tool === defaultToolId);
      if (!selectedTool?.install_dir) { return; }

      const aliasPath = path.join(getInternalDirRealPath(), 'tools', selectedTool.install_dir, 'bin').replace(/\\/g, '/');
      const aliasVersion = selectedTool.version || '';
      const current = this.envData?.runners?.[alias];
      const defaultFromDebugTools = this.data.aliases?.find((a: Aliases) => a.alias === alias)?.default;
      const expectedDefault = defaultToolId !== defaultFromDebugTools ? defaultToolId : undefined;
      const same =
        current?.default === expectedDefault &&
        current?.path === aliasPath &&
        current?.version === aliasVersion;
      if (same) { return; }

      const envYamlPath = path.join(getInternalDirRealPath(), 'env.yml');
      let doc: any;
      if (fs.existsSync(envYamlPath)) {
        doc = yaml.parseDocument(fs.readFileSync(envYamlPath, 'utf8'));
      } else if (this.envYamlDoc) {
        doc = this.envYamlDoc.clone ? this.envYamlDoc.clone() : yaml.parseDocument(String(this.envYamlDoc));
      } else {
        doc = yaml.parseDocument('{}');
      }

      doc.setIn(['runners', alias, 'path'], aliasPath);
      doc.setIn(['runners', alias, 'version'], aliasVersion);
      if (typeof doc.getIn(['runners', alias, 'do_not_use']) === 'undefined') {
        doc.setIn(['runners', alias, 'do_not_use'], false);
      }
      if (defaultToolId !== defaultFromDebugTools) {
        doc.setIn(['runners', alias, 'default'], defaultToolId);
      } else {
        doc.deleteIn(['runners', alias, 'default']);
      }

      formatYml(doc.contents);
      const yamlText = yaml.stringify(yaml.parse(doc.toString()), { flow: false });
      fs.writeFileSync(envYamlPath, yamlText, 'utf8');

      this.envYamlDoc = doc;
      try { this.envData = yaml.parse(String(doc)); } catch { this.envData = undefined; }
    } catch {
      // best effort only
    }
  }

  // OpenOCD variants are considered installed when their folder exists:
  // <internal>/.zinstaller/tools/openocds/<tool-id>
  private isOpenocdVariantInstalled(toolId: string): boolean {
    try {
      const tool = this.data.debug_tools.find((t: any) => t.tool === toolId);
      if (!tool?.install_dir) { return false; }
      const variantDir = path.join(getInternalDirRealPath(), 'tools', tool.install_dir);
      return fs.existsSync(variantDir) && fs.statSync(variantDir).isDirectory();
    } catch {
      return false;
    }
  }

  private getRunnerPath(toolId: string): string | undefined {
    // Get path from env.yml 
    try {
      const p: string | undefined = (this.envData as any)?.runners?.[toolId]?.path;
      if (p && typeof p === 'string' && p.length > 0) { return p; }
    } catch { console.log('Error reading runner path from env.yml'); }

    return undefined;
  }

  private async saveRunnerPath(toolId: string, newPath: string): Promise<boolean> {
    try {
      const envYamlPath = path.join(getInternalDirRealPath(), 'env.yml');
      
      // Normalizes to always use a slash "/" in the definitive path
      const defPath = newPath.replace(/\\/g, '/');

      // Load existing Document if present, otherwise start from empty document
      let doc: any;
      if (fs.existsSync(envYamlPath)) {
        const text = fs.readFileSync(envYamlPath, 'utf8');
        doc = yaml.parseDocument(text);
      } else if (this.envYamlDoc) {
        // use in-memory doc if we have it
        doc = this.envYamlDoc.clone ? this.envYamlDoc.clone() : yaml.parseDocument(String(this.envYamlDoc));
      } else {
        doc = yaml.parseDocument('{}');
      }

      // Ensure the runners mapping exists and set the specific path key
      // use setIn to update nested path while preserving other content/comments
      doc.setIn(['runners', toolId, 'path'], defPath);

      // Ensures block style in root and children
      formatYml(doc.contents);

      // Serializes by forcing multi-line format
      const yamlText = yaml.stringify(yaml.parse(doc.toString()), { flow: false });

      fs.writeFileSync(envYamlPath, yamlText, 'utf8');

      // Update in-memory representations
      this.envYamlDoc = doc;
      try { this.envData = yaml.parse(String(doc)); } catch { this.envData = undefined; }

      return true;
    } catch (e) {
      return false;
    }
  }

  private async removeRunnerPath(toolId: string): Promise<boolean> {
    try {
      const envYamlPath = path.join(getInternalDirRealPath(), 'env.yml');

      // Load existing Document if present, otherwise start from empty document
      let doc: any;
      if (fs.existsSync(envYamlPath)) {
        const text = fs.readFileSync(envYamlPath, 'utf8');
        doc = yaml.parseDocument(text);
      } else if (this.envYamlDoc) {
        doc = this.envYamlDoc.clone ? this.envYamlDoc.clone() : yaml.parseDocument(String(this.envYamlDoc));
      } else {
        doc = yaml.parseDocument('{}');
      }

      // Remove the runner path if it exists
      doc.deleteIn(['runners', toolId]);

      // Ensures block style in root and children
      formatYml(doc.contents);

      // Serializes by forcing multi-line format
      const yamlText = yaml.stringify(yaml.parse(doc.toString()), { flow: false });

      fs.writeFileSync(envYamlPath, yamlText, 'utf8');

      // Update in-memory representations
      this.envYamlDoc = doc;
      try { this.envData = yaml.parse(String(doc)); } catch { this.envData = undefined; }

      return true;
    } catch {
      return false;
    }
  }

  private async saveDoNotUse(toolId: string, doNotUse: boolean): Promise<boolean> {
    try {
      const envYamlPath = path.join(getInternalDirRealPath(), 'env.yml');

      // Load existing Document if present, otherwise start from empty document
      let doc: any;
      if (fs.existsSync(envYamlPath)) {
        const text = fs.readFileSync(envYamlPath, 'utf8');
        doc = yaml.parseDocument(text);
      } else if (this.envYamlDoc) {
        doc = this.envYamlDoc.clone ? this.envYamlDoc.clone() : yaml.parseDocument(String(this.envYamlDoc));
      } else {
        doc = yaml.parseDocument('{}');
      }

      // Set do_not_use under the specific runner, using setIn to preserve others
      doc.setIn(['runners', toolId, 'do_not_use'], doNotUse);

      // Ensures block style in root and children
      formatYml(doc.contents);

      // Serializes by forcing multi-line format
      const yamlText = yaml.stringify(yaml.parse(doc.toString()), { flow: false });

      fs.writeFileSync(envYamlPath, yamlText, 'utf8');

      // Update in-memory representations
      this.envYamlDoc = doc;
      try { this.envData = yaml.parse(String(doc)); } catch { this.envData = undefined; }

      return true;
    } catch {
      return false;
    }
  }
  
  private reloadEnvYaml(): void {
    try {
      const envYamlPath = path.join(getInternalDirRealPath(), 'env.yml');
      if (!fs.existsSync(envYamlPath)) {
        this.envData = undefined;
        this.envYamlDoc = undefined;
        return;
      }
      const envYaml = fs.readFileSync(envYamlPath, 'utf8');
      this.envData = yaml.parse(envYaml);
      this.envYamlDoc = yaml.parseDocument(envYaml);
    } catch {
      this.envData = undefined;
      this.envYamlDoc = undefined;
    }
  }
}
