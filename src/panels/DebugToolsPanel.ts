import * as vscode from "vscode";
import fs from "fs";
import yaml from 'yaml';
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";
import { getRunner } from "../debugUtils";

export class DebugToolsPanel {
	
  public static currentPanel: DebugToolsPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private data: any;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    const yamlFile = fs.readFileSync(vscode.Uri.joinPath(this._extensionUri, 'scripts', 'hosttools', 'debug-tools.yml').fsPath, 'utf8');
    this.data = yaml.parse(yamlFile);
  }

  public async createContent() {
    this._panel.webview.html = await this._getWebviewContent(this._panel.webview, this._extensionUri);
    this._setWebviewMessageListener(this._panel.webview);
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
    return packsHTML;
  }

  private async getToolsHTML(): Promise<string> {
    let toolsHTML = '';
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
        } else {
          tool.version = "";
          tool.found = "Not installed";
        }

        
      } else {
        tool.found = "";
      }

      toolsHTML += `<tr id="row-${tool.tool}">
        <td><!--input type="checkbox"--></td>
        <td id="name-${tool.tool}">${tool.name}</td>
        <td id="version-${tool.tool}">${tool.version}</td>
        <td id="detect-${tool.tool}">${tool.found}</td>
        <td id="buttons-${tool.tool}">`;

      if(tool.os) {
        let hasSource = false;
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
          toolsHTML +=`<vscode-button appearance="icon" class="install-button" data-tool="${tool.tool}">
                         <span class="codicon codicon-desktop-download"></span>
                       </vscode-button>
                       <!--vscode-button appearance="icon" class="remove-button" data-tool="${tool.tool}">
                         <span class="codicon codicon-trash"></span>
                       </vscode-button-->`;
        }
       
      }

      if(tool.website) {
        toolsHTML +=`<vscode-button appearance="icon" class="website-button" data-tool="${tool.tool}">
                      <a href="${tool.website}">
                        <span class="codicon codicon-link"></span>
                      </a>
                    </vscode-button>`;
      }
      
      toolsHTML +=`  </td>
        <td>`;
        if(this.isToolCompatible(tool)) {
          toolsHTML +=`<div class="progress-wheel" id="progress-${tool.tool}"><vscode-progress-ring></vscode-progress-ring></div>`;
        }
        `</td>
      </tr>`;
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
}
  