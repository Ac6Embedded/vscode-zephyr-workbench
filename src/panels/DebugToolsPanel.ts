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

export class DebugToolsPanel {
	
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
    // Load versions after panel is shown
    this.loadVersions();

    // when panel becomes visible again, re-generate HTML so env.yml is re-read
    this._panel.onDidChangeViewState(async () => {
      if (this._panel.visible) {
        this._panel.webview.html = await this._getWebviewContent(this._panel.webview, this._extensionUri);
        // reload versions / re-run any detection
        this.loadVersions();
        //we do NOT call _setWebviewMessageListener again (already registered)
      }
    }, null, this._disposables);
  }

  private async loadVersions() {
    const versionPromises = this.data.debug_tools.map(async (tool: any) => {
      const runner = getRunner(tool.tool);
      if (!runner) {return;}

      runner.loadArgs(undefined);
      try {
        const installedVersion = await runner.detectVersion();
        const actualVersion = tool.version;

        if (installedVersion) {
          tool.version = installedVersion;
          tool.found = "Installed";
          if (tool.os && actualVersion !== installedVersion) {
            tool.found = "New Version Available";
          }
        }

        // Update UI immediately after each finishes
        this._panel.webview.postMessage({
          command: "detect-done",
          tool: tool.tool,
          version: installedVersion || "",
        });
      } catch (err) {
        console.warn(`Version check failed for ${tool.tool}:`, err);
        this._panel.webview.postMessage({
          command: "detect-done",
          tool: tool.tool,
          version: "",
        });
      }
    });

    // Run all in parallel
    await Promise.all(versionPromises);
  }


  public static render(extensionUri: vscode.Uri) {
    if (DebugToolsPanel.currentPanel) {
      DebugToolsPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
    } else {
      const panel = vscode.window.createWebviewPanel("zephyr-workbench.install-debug-tools.panel", "Install Runners", vscode.ViewColumn.One, {
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
    for(let tool of this.data.debug_tools) {
      let toolHTML = '';
      let hasSource = false;

      // Initially set empty version and status
      tool.version = "";
      tool.found = "";

      toolHTML += `<tr id="row-${tool.tool}">`;
      // Show expand button only if no_edit is not true
      if (tool.no_edit !== true) {
        toolHTML += `<td><button type="button" class="inline-icon-button expand-button codicon codicon-chevron-right" data-tool="${tool.tool}" aria-label="Expand/Collapse"></button></td>`;
      } else {
        toolHTML += `<td></td>`; // empty cell if no_edit is true
      }
      toolHTML += `
        <td id="name-${tool.tool}">${tool.name}</td>
        <td id="version-${tool.tool}">${tool.version}</td>
        <td id="detect-${tool.tool}">${tool.found}</td>
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
                       </vscode-button>
                       <!--vscode-button appearance="icon" class="remove-button" data-tool="${tool.tool}">
                         <span class="codicon codicon-trash"></span>
                       </vscode-button-->`;
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
            <vscode-button id="add-extra-path-btn" appearance="secondary">Add new runner path</vscode-button>
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
          <h1>Install 
            <span class="title-install-runners">Runners</span>
          </h1>
          <a class="help-link" href="https://zephyr-workbench.com/docs/documentation/debug-tools">Read Docs</a>
          <form>
            <h2>Packs</h2>
            <table class="debug-tools-table">
              <tr>
                <th></th>
                <th>Pack</th>
                <th></th>
                <th></th>
                <th>
                  <span class="title-install-runners">Install</span>
                </th>
                <th></th>
              </tr>
              ${packsHTML}
            </table>
          </form>
          <form>
            <h2>
              <span class="title-install-runners">Runners</span>
            </h2>
            <table class="debug-tools-table">
              <tr>
                <th></th>
                <th>
                  <span class="title-install-runners">Name</span>
                </th>
                <th>Version</th>
                <th>Status</th>
                <th>
                  <span class="title-install-runners">Install</span>
                </th>
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
                <th>Custom tool path(s):</th>
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
          case 'add-extra-path': {
            try {
              const envYamlPath = path.join(getInternalDirRealPath(), 'env.yml');
              let doc: any;
              if (fs.existsSync(envYamlPath)) {
                const text = fs.readFileSync(envYamlPath, 'utf8');
                doc = yaml.parseDocument(text);
              } else if (this.envYamlDoc) {
                doc = this.envYamlDoc.clone ? this.envYamlDoc.clone() : yaml.parseDocument(String(this.envYamlDoc));
              } else {
                doc = yaml.parseDocument('{}');
              }

              const jsEnv: any = yaml.parse(doc.toString()) || {};
              jsEnv.other = jsEnv.other || {};
              jsEnv.other.EXTRA_RUNNERS = jsEnv.other.EXTRA_RUNNERS || {};
              jsEnv.other.EXTRA_RUNNERS.path = Array.isArray(jsEnv.other.EXTRA_RUNNERS.path) ? jsEnv.other.EXTRA_RUNNERS.path : [];
              jsEnv.other.EXTRA_RUNNERS.path.push('');

              const yamlText = yaml.stringify(jsEnv, { flow: false });
              fs.writeFileSync(envYamlPath, yamlText, 'utf8');
              this.envYamlDoc = yaml.parseDocument(yamlText);
              try { this.envData = yaml.parse(yamlText); } catch { this.envData = undefined; }

              // Regenerate UI to include the new row
              const newIdx = jsEnv.other.EXTRA_RUNNERS.path.length - 1;
              webview.postMessage({ command: 'add-extra-path-done', idx: newIdx });
              this._panel.webview.html = await this._getWebviewContent(webview, this._extensionUri);
            } catch (e) {
              vscode.window.showErrorMessage('Failed to add new extra runner path');
            }
            break;
          }
          case 'detect': {
            let runner = getRunner(message.tool);
            if(runner) {
              runner.loadArgs(undefined);
              let version = await runner.detectVersion();
              webview.postMessage({ 
                command: 'detect-done', 
                tool: message.tool,
                version: version? version:'',
              });
            }
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
                // Show error if path is empty
                vscode.window.showErrorMessage('Please provide a valid path');
                webview.postMessage({ command: 'extra-path-updated', idx, path: '', success: false, error: 'Empty path' });
                break;
              }
              if (!trimmed) {
                // Empty string: keep the entry but clear its path in env.yml
                const envYamlPath = path.join(getInternalDirRealPath(), 'env.yml');
                let doc: any;
                if (fs.existsSync(envYamlPath)) {
                  const text = fs.readFileSync(envYamlPath, 'utf8');
                  doc = yaml.parseDocument(text);
                } else if (this.envYamlDoc) {
                  doc = this.envYamlDoc.clone ? this.envYamlDoc.clone() : yaml.parseDocument(String(this.envYamlDoc));
                } else {
                  doc = yaml.parseDocument('{}');
                }

                const jsEnv: any = yaml.parse(doc.toString()) || {};
                jsEnv.other = jsEnv.other || {};
                jsEnv.other.EXTRA_RUNNERS = jsEnv.other.EXTRA_RUNNERS || {};
                jsEnv.other.EXTRA_RUNNERS.path = Array.isArray(jsEnv.other.EXTRA_RUNNERS.path) ? jsEnv.other.EXTRA_RUNNERS.path : [];
                // Expand array if needed to avoid out-of-range
                while (jsEnv.other.EXTRA_RUNNERS.path.length <= idx) {
                  jsEnv.other.EXTRA_RUNNERS.path.push('');
                }
                jsEnv.other.EXTRA_RUNNERS.path[idx] = '';

                const yamlText = yaml.stringify(jsEnv, { flow: false });
                fs.writeFileSync(envYamlPath, yamlText, 'utf8');

                // Refresh in-memory state
                this.envYamlDoc = yaml.parseDocument(yamlText);
                try { this.envData = yaml.parse(yamlText); } catch { this.envData = undefined; }

                webview.postMessage({ command: 'extra-path-updated', idx, path: '', success: true });
                break;
              }

              const envYamlPath = path.join(getInternalDirRealPath(), 'env.yml');
              let doc: any;
              if (fs.existsSync(envYamlPath)) {
                const text = fs.readFileSync(envYamlPath, 'utf8');
                doc = yaml.parseDocument(text);
              } else if (this.envYamlDoc) {
                doc = this.envYamlDoc.clone ? this.envYamlDoc.clone() : yaml.parseDocument(String(this.envYamlDoc));
              } else {
                doc = yaml.parseDocument('{}');
              }

              // Work on a plain object for easier array manipulation
              const jsEnv: any = yaml.parse(doc.toString()) || {};
              jsEnv.other = jsEnv.other || {};
              jsEnv.other.EXTRA_RUNNERS = jsEnv.other.EXTRA_RUNNERS || {};
              jsEnv.other.EXTRA_RUNNERS.path = Array.isArray(jsEnv.other.EXTRA_RUNNERS.path) ? jsEnv.other.EXTRA_RUNNERS.path : [];
              const defPath = trimmed.replace(/\\/g, '/');
              // Ensure array is large enough to accommodate new index and supports UI-inserted rows
              while (jsEnv.other.EXTRA_RUNNERS.path.length <= idx) {
                jsEnv.other.EXTRA_RUNNERS.path.push('');
              }
              jsEnv.other.EXTRA_RUNNERS.path[idx] = defPath;

              // Serialize back to YAML in block style
              const yamlText = yaml.stringify(jsEnv, { flow: false });
              fs.writeFileSync(envYamlPath, yamlText, 'utf8');

              // Refresh in-memory state
              this.envYamlDoc = yaml.parseDocument(yamlText);
              try { this.envData = yaml.parse(yamlText); } catch { this.envData = undefined; }

              webview.postMessage({ command: 'extra-path-updated', idx, path: defPath, success: true });
            } catch (e) {
              webview.postMessage({ command: 'extra-path-updated', idx: message.idx, path: '', success: false, error: 'Exception updating extra path' });
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

              const envYamlPath = path.join(getInternalDirRealPath(), 'env.yml');
              let doc: any;
              if (fs.existsSync(envYamlPath)) {
                const text = fs.readFileSync(envYamlPath, 'utf8');
                doc = yaml.parseDocument(text);
              } else if (this.envYamlDoc) {
                doc = this.envYamlDoc.clone ? this.envYamlDoc.clone() : yaml.parseDocument(String(this.envYamlDoc));
              } else {
                doc = yaml.parseDocument('{}');
              }

              const jsEnv: any = yaml.parse(doc.toString()) || {};
              const arr: any[] = jsEnv?.other?.EXTRA_RUNNERS?.path;
              if (!Array.isArray(arr) || idx >= arr.length) {
                webview.postMessage({ command: 'extra-path-removed', idx, success: false, error: 'Index out of range' });
                break;
              }
              arr.splice(idx, 1);
              // Ensure the structure remains, even if empty array
              jsEnv.other = jsEnv.other || {};
              jsEnv.other.EXTRA_RUNNERS = jsEnv.other.EXTRA_RUNNERS || {};
              jsEnv.other.EXTRA_RUNNERS.path = arr;

              const yamlText = yaml.stringify(jsEnv, { flow: false });
              fs.writeFileSync(envYamlPath, yamlText, 'utf8');

              this.envYamlDoc = yaml.parseDocument(yamlText);
              try { this.envData = yaml.parse(yamlText); } catch { this.envData = undefined; }

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
}
