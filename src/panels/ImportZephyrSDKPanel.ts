import * as vscode from "vscode";
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";
import { getSdkVersion, listToolchainArch } from "../sdkUtils";
import { getListZephyrSDKs } from "../utils";

export class ImportZephyrSDKPanel {
  public static currentPanel: ImportZephyrSDKPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  /*────────────────────────────── PUBLIC API ──────────────────────────────*/
  public async createContent() {
    this._panel.webview.html = await this._getWebviewContent(
      this._panel.webview,
      this._extensionUri,
    );
    this._setWebviewMessageListener(this._panel.webview);
  }

  /** common folder‑picker (Location / SDK browse) */
  public openLocationDialog(targetId = "workspacePath") {
    vscode.window
      .showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Select",
      })
      .then((uri) => {
        if (uri?.length) {
          this._panel.webview.postMessage({
            command: "folderSelected",
            folderUri: uri[0].fsPath,
            id: targetId,
          });
        }
      });
  }

  public static render(extensionUri: vscode.Uri) {
    if (ImportZephyrSDKPanel.currentPanel) {
      ImportZephyrSDKPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "add-zephyr-sdk-panel",
      "Add Toolchain",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out")],
      },
    );

    panel.iconPath = {
      light: vscode.Uri.joinPath(
        extensionUri,
        "res",
        "icons",
        "light",
        "symbol-method.svg",
      ),
      dark: vscode.Uri.joinPath(
        extensionUri,
        "res",
        "icons",
        "dark",
        "symbol-method.svg",
      ),
    };

    ImportZephyrSDKPanel.currentPanel = new ImportZephyrSDKPanel(
      panel,
      extensionUri,
    );
    ImportZephyrSDKPanel.currentPanel.createContent();
  }

  public dispose() {
    ImportZephyrSDKPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) this._disposables.pop()?.dispose();
  }

  /*──────────────────────── PRIVATE: HTML ────────────────────────────────*/
  private async _getWebviewContent(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
  ) {
    /* dynamic URIs & nonce */
    const webviewUri = getUri(webview, extensionUri, ["out", "importsdk.js"]);
    const styleUri = getUri(webview, extensionUri, ["out", "style.css"]);
    const nonce = getNonce();

    /* ── SDK versions for the dropdown ─────────────────────────────── */
    const versions = await getSdkVersion();
    let versionItems = "", defaultVersion = "";
    if (versions.length) {
      defaultVersion = versions[0].replace(/^v/, "");
      for (const v of versions) {
        const clean = v.replace(/^v/, "");
        versionItems += `<div class="dropdown-item"
                             data-value="${clean}"
                             data-label="${v}">${v}</div>`;
      }
    }

    /* ── toolchain list for “minimal” installs ─────────────────────── */
    let toolsListHTML = "";
    for (const t of listToolchainArch) {
      toolsListHTML += `<div>
          <vscode-checkbox class="toolchain-checkbox"
                           current-value="${t}" disabled>${t}</vscode-checkbox>
        </div>`;
    }

    /* default SDK URL matching current platform */
    let defaultSDKUrl = "";
    if (process.platform === "linux" && process.arch === "x64") {
      defaultSDKUrl =
        "https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v0.16.8/zephyr-sdk-0.16.8_linux-x86_64.tar.xz";
    } else if (process.platform === "linux" && process.arch === "arm64") {
      defaultSDKUrl =
        "https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v0.16.8/zephyr-sdk-0.16.8_linux-aarch64.tar.xz";
    } else if (process.platform === "win32" && process.arch === "x64") {
      defaultSDKUrl =
        "https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v0.16.8/zephyr-sdk-0.16.8_windows-x86_64.7z";
    } else if (process.platform === "darwin" && process.arch === "x64") {
      defaultSDKUrl =
        "https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v0.16.8/zephyr-sdk-0.16.8_macos-x86_64.tar.xz";
    } else if (process.platform === "darwin" && process.arch === "arm64") {
      defaultSDKUrl =
        "https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v0.16.8/zephyr-sdk-0.16.8_macos-aarch64.tar.xz";
    }

    /* ── Zephyr SDK list for the IAR dropdown ──────────────────────── */
    let sdkHTML = "";
    for (const sdk of await getListZephyrSDKs()) {
      sdkHTML += `
        <div class="dropdown-item"
             data-value="${sdk.rootUri.fsPath}"
             data-label="${sdk.name}">
          ${sdk.name}
          <span class="description">${sdk.version}</span>
        </div>`;
    }

    /* ── full HTML ─────────────────────────────────────────────────── */
    return /*html*/ `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'" />
  <link rel="stylesheet" href="${styleUri}" />
  <style>.sub-option-group{margin-left:24px}</style>
  <title>Add Toolchain</title>
</head>

<body>
  <h1>Add Toolchain</h1>
  <a class="help-link"
     href="https://zephyr-workbench.com/docs/documentation/sdk">Read Docs</a>

  <!-- ── CATEGORY + SOURCE LOCATION ───────────────────────────────── -->
  <form>
    <div class="grid-group-div">
      <vscode-radio-group id="sourceCategory" orientation="vertical">
        <label slot="label">Toolchain family:</label>
        <vscode-radio value="zephyr" checked>Zephyr SDK</vscode-radio>
        <vscode-radio value="iar">IAR ARM Toolchain</vscode-radio>
      </vscode-radio-group>
    </div>

    <!-- Zephyr sub-options -->
    <div id="zephyrOptions" class="sub-option-group">
      <vscode-radio-group id="srcTypeZephyr" orientation="vertical">
        <label slot="label">Source:</label>
        <vscode-radio value="official" checked>Official</vscode-radio>
        <vscode-radio value="remote">Remote</vscode-radio>
        <vscode-radio value="local">Local</vscode-radio>
      </vscode-radio-group>
    </div>

<!-- IAR sub-options - always “Local” -->
<div id="iarOptions" class="sub-option-group iar-row" style="display:none">
  <!-- right-hand download link -->
  <a  class="iar-download-link"
      href="https://github.com/iarsystems/zephyr-iar/releases"
      title="Open the IAR Zephyr Toolchain releases page"
      target="_blank" rel="noopener">
    Download binaries&nbsp;
  </a>
  <vscode-radio-group id="srcTypeIar" orientation="vertical">
    <label slot="label">Source:</label>
    <vscode-radio value="iar-local" checked>Local</vscode-radio>
  </vscode-radio-group>
</div>
  </form>

  <!-- ── OFFICIAL SDK FORM ────────────────────────────────────────── -->
  <form id="official-form">
    <div class="grid-group-div">
      <vscode-radio-group id="sdkType" orientation="horizontal">
        <label slot="label">SDK Type:</label>
        <vscode-radio value="full" checked>Full</vscode-radio>
        <vscode-radio value="minimal">Minimal</vscode-radio>
      </vscode-radio-group>
    </div>

    <div class="grid-group-div">
      <div class="grid-header-div">
        <label for="listVersion">Version:</label>
        <a href="https://github.com/zephyrproject-rtos/sdk-ng/wiki/Zephyr-SDK-Version-Compatibility-Matrix">
          <span class="tooltip"
                data-tooltip="Click for more information on Zephyr SDK version compatibility">?</span>
        </a>
      </div>

      <div id="listVersion" class="combo-dropdown grid-value-div">
        <input  id="versionInput"
                class="combo-dropdown-control"
                placeholder="Choose the SDK version…"
                data-value="${defaultVersion}" />
        <div aria-hidden="true" class="indicator" part="indicator">
          <svg class="select-indicator" width="16" height="16"
               viewBox="0 0 16 16" fill="currentColor">
            <path fill-rule="evenodd" clip-rule="evenodd"
              d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"/>
          </svg>
        </div>

        <div id="versionsDropdown" class="dropdown-content">
          ${versionItems}
        </div>
      </div>
    </div>

    <div class="grid-group-div">
      <fieldset class="no-border">
        <div class="toolchains-container">
          ${toolsListHTML}
        </div>
      </fieldset>
    </div>
  </form>

  <!-- ── IAR LOCAL FORM (path + SDK dropdown) ─────────────────────── -->
  <form id="iar-form" style="display:none">
    <!-- new Zephyr SDK dropdown -->
    <div class="grid-group-div">
      <div class="grid-header-div">
        <label for="listSDKs">Select Zephyr SDK:</label>
      </div>

      <div id="listSdks" class="combo-dropdown grid-value-div">
        <input  type="text"
                id="sdkInput"
                class="combo-dropdown-control"
                placeholder="Choose your SDK…"
                data-value="">
        <div aria-hidden="true" class="indicator" part="indicator">
          <slot name="indicator">
            <svg class="select-indicator" width="16" height="16"
                 viewBox="0 0 16 16" fill="currentColor">
              <path fill-rule="evenodd" clip-rule="evenodd"
                    d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"/>
            </svg>
          </slot>
        </div>

        <div id="sdkDropdown" class="dropdown-content" style="display:none;">
          ${sdkHTML}
        </div>
      </div>
    </div>

    <div class="grid-group-div">
      <vscode-text-field id="iarToken" size="50" type="password">
        Token:
      </vscode-text-field>
    </div>
  </form>

  <!-- ── REMOTE / LOCAL SHARED FIELDS ─────────────────────────────── -->
  <form>
    <div class="grid-group-div">
      <vscode-text-field  id="remotePath" size="50" type="url"
                          value="${defaultSDKUrl}">
        Path:
      </vscode-text-field>
    </div>

    <div class="grid-group-div">
      <vscode-text-field id="workspacePath" size="50">Location:</vscode-text-field>
      <vscode-button id="browseLocationButton"
                     class="browse-input-button">Browse…</vscode-button>
    </div>
  </form>

  <!-- ── IMPORT BUTTON ─────────────────────────────────────────────── -->
  <div class="grid-group-div">
    <vscode-button id="importButton"
                   class="finish-input-button">Import</vscode-button>
  </div>

  <script type="module" nonce="${nonce}" src="${webviewUri}"></script>
</body>
</html>
`;
  }

  /*────────────────── PRIVATE: Webview → Extension ──────────────────*/
  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
      (msg) => {
        switch (msg.command) {
          case "openLocationDialog":
            this.openLocationDialog(msg.id);
            return;

          case "import":
            if (!checkParameters(msg)) return;

            const { srcType, workspacePath } = msg;

            switch (srcType) {
              case "official":
                vscode.commands.executeCommand(
                  "zephyr-workbench-sdk-explorer.import-official-sdk",
                  msg.sdkType,
                  msg.sdkVersion,
                  msg.listToolchains,
                  workspacePath,
                );
                break;

              case "remote":
                vscode.commands.executeCommand(
                  "zephyr-workbench-sdk-explorer.import-remote-sdk",
                  msg.remotePath,
                  workspacePath,
                );
                break;

              case "local":
                vscode.commands.executeCommand(
                  "zephyr-workbench-sdk-explorer.import-local-sdk",
                  workspacePath,
                );
                break;

              case "iar":
                vscode.commands.executeCommand(
                  "zephyr-workbench-sdk-explorer.import-iar-sdk",
                  msg.iarZephyrSdkPath,
                  msg.iarToken,
                  workspacePath,
                );
                break;
            }
        }
      },
      undefined,
      this._disposables,
    );
  }
}

/*────────────────────────── helpers ──────────────────────────*/
function checkParameters(msg: any): boolean {
  const { srcType, workspacePath } = msg;

  if (!workspacePath) {
    vscode.window.showErrorMessage(
      "Missing SDK destination, please enter SDK location.",
    );
    return false;
  }

  if (srcType === "official" && !msg.sdkVersion) {
    vscode.window.showErrorMessage(
      "No version selected, please select the SDK version.",
    );
    return false;
  }

  if (srcType === "remote" && !msg.remotePath) {
    vscode.window.showErrorMessage(
      "Missing SDK remote URL, please enter SDK repository URL.",
    );
    return false;
  }

  if (srcType === "iar") {
    if (!msg.iarZephyrSdkPath) {
      vscode.window.showErrorMessage(
        "Missing SDK path, please pick it with Select SDK.",
      );
      return false;
    }
    if (!msg.iarToken) {
      vscode.window.showErrorMessage("Missing Token, please enter it.");
      return false;
    }
  }

  return true;
}