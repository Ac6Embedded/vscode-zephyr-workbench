import * as vscode from "vscode";
import fs from "fs";
import yaml from 'yaml';
import path from "path";
import { execSync } from "child_process";
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";
import { getRunner } from "../debugUtils";
import { getInternalDirRealPath } from "../utils";

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
    for(let tool of this.data.debug_tools) {
        let runner = getRunner(tool.tool);
        if(runner) {
            runner.loadArgs(undefined);
            let installedVersion = await runner.detectVersion();
            let actualVersion = tool.version;

            if(installedVersion) {
                tool.version = installedVersion;
                tool.found = "Installed";
                if(tool.os && (actualVersion !== installedVersion)) {
                    tool.found = "New Version Available";
                }
            }

            // Update the webview with the new version info
            this._panel.webview.postMessage({ 
                command: 'detect-done', 
                tool: tool.tool,
                version: installedVersion || '',
            });
        }
    }
  }

  public static render(extensionUri: vscode.Uri) {
    if (DebugToolsPanel.currentPanel) {
      DebugToolsPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
    } else {
      const panel = vscode.window.createWebviewPanel("zephyr-workbench.install-debug-tools.panel", "Install Debug Tools", vscode.ViewColumn.One, {
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
        let tool = this.data.debug_tools.find((tool: { tool: string; }) => tool.tool === packTool);
        if(this.isToolCompatible(tool)) {
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
  
  private async _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
    const webviewUri = getUri(webview, extensionUri, ["out", "debugtools.js"]);
    const styleUri = getUri(webview, extensionUri, ["out", "style.css"]);
    const codiconUri = getUri(webview, extensionUri, ["out", "codicon.css"]);
    
    const nonce = getNonce();
    const packsHTML = await this.getPacksHTML();
    const toolsHTML = await this.getToolsHTML();
      
    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
          <link nonce="${nonce}" rel="stylesheet" href="${styleUri}">
          <link nonce="${nonce}" rel="stylesheet" href="${codiconUri}">
          <title>Install Debug Tools</title>
        </head>
        
        <body>
          <h1>Install Debug Tools</h1>
          <a class="help-link" href="https://zephyr-workbench.com/docs/documentation/debug-tools">Read Docs</a>
          <form>
            <h2>Packs</h2>
            <table class="debug-tools-table">
              <tr>
                <th></th>
                <th>Pack</th>
                <th></th>
                <th></th>
                <th>Actions</th>
                <th></th>
              </tr>
              ${packsHTML}
            </table>
          </form>
          <form>
            <h2>Debug tools</h2>
            <table class="debug-tools-table">
              <tr>
                <th></th>
                <th>Application Name</th>
                <th>Version</th>
                <th>Status</th>
                <th>Actions</th>
                <th></th>
              </tr>
              ${toolsHTML}
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
            let selectedPack = this.data.packs.find((pack: { pack: string; }) => pack.pack === message.pack);
            let tools: any[] = [];
            selectedPack.tools.forEach((packTool: string) => {
              let tool = this.data.debug_tools.find((tool: { tool: string; }) => tool.tool === packTool);
              if(this.isToolCompatible(tool)) {
                tools.push(tool);
              }
            });
            vscode.commands.executeCommand("zephyr-workbench.run-install-debug-tools", this._panel, tools);
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
            const { tool } = message;
            const pick = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: `Select folder for ${tool}` });
            if (pick && pick[0]) {
              const chosen = pick[0].fsPath;
              const ok = await this.saveRunnerPath(tool, chosen);
              webview.postMessage({ command: 'path-updated', tool, path: chosen, success: ok });
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

      // Persist
      fs.mkdirSync(path.dirname(envYamlPath), { recursive: true });
      fs.writeFileSync(envYamlPath, String(doc));

      // Update in-memory representations
      this.envYamlDoc = doc;
      try { this.envData = yaml.parse(String(doc)); } catch { this.envData = undefined; }

      return true;
    } catch (e) {
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

      // Persist
      fs.mkdirSync(path.dirname(envYamlPath), { recursive: true });
      fs.writeFileSync(envYamlPath, String(doc));

      // Update in-memory representations
      this.envYamlDoc = doc;
      try { this.envData = yaml.parse(String(doc)); } catch { this.envData = undefined; }

      return true;
    } catch {
      return false;
    }
  }
}
