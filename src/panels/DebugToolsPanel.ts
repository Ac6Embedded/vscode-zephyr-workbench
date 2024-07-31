import * as vscode from "vscode";
import fs from "fs";
import yaml from 'yaml';
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";
import { installHostDebugTools } from "../installUtils";

const toolsMap = new Map<string, string>();
/*toolsMap.set("OpenOCD", "openocd");
toolsMap.set("STM32CubeProgrammer", "stm32cubeprogrammer");

toolsMap.set("ST-Link Driver", "stlink-driver");
toolsMap.set("J-Link Driver", "jlink-driver");
toolsMap.set("CMSIS-DAP Driver", "cmsisdap-driver");*/

export class DebugToolsPanel {
	
  public static currentPanel: DebugToolsPanel | undefined;
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

  private getToolsHTML(): string {
    let toolsHTML = '';
    const yamlFile = fs.readFileSync(vscode.Uri.joinPath(this._extensionUri, 'scripts', 'hosttools', 'debug-tools.yml').fsPath, 'utf8');
    const data = yaml.parse(yamlFile);
    for(let tool of data.debug_tools) {
      toolsHTML += `<tr id="row-${tool.tool}">
        <td><!--input type="checkbox"--></td>
        <td>${tool.name}</td>
        <td>${tool.version}</td>
        <td></td>
        <td>`;

      if(tool.os) {
        toolsHTML +=`<vscode-button appearance="icon" class="install-button" data-tool="${tool.tool}">
            <span class="codicon codicon-desktop-download"></span>
          </vscode-button>
          <vscode-button appearance="icon" class="remove-button" data-tool="${tool.tool}">
            <span class="codicon codicon-trash"></span>
          </vscode-button>`;
      }

      toolsHTML +=`<vscode-button appearance="icon" class="website-button" data-tool="${tool.tool}">
            <a href="${tool.website}">
              <span class="codicon codicon-link"></span>
            </a>
          </vscode-button>
        </td>
        <td><div class="progress-wheel" id="progress-${tool.tool}"><vscode-progress-ring></vscode-progress-ring></div></td>
      </tr>`;
    }
    return toolsHTML;
  }
  
  private async _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
    const webviewUri = getUri(webview, extensionUri, ["out", "debugtools.js"]);
    const styleUri = getUri(webview, extensionUri, ["out", "style.css"]);
    const codiconUri = getUri(webview, extensionUri, ["out", "codicon.css"]);
    
    const nonce = getNonce();
    const toolsHTML = this.getToolsHTML();
      
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
          <form>
            <table>
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

            <!--div class="grid-group-div">
              <vscode-button id="installButton">Install selected</vscode-button>
              <vscode-button id="removeButton">Remove selected</vscode-button>
            </div-->
          </form>
          <script type="module" nonce="${nonce}" src="${webviewUri}"></script>
        </body>
      </html>
    `;
  }

  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
      (message: any) => {
        const command = message.command;

        switch (command) {
          case 'debug':
            vscode.window.showInformationMessage(message.text);
            return;
          case 'install':
            vscode.commands.executeCommand("zephyr-workbench.run-install-debug-tools", this._panel, [ message.tool ]);
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
}

  
  