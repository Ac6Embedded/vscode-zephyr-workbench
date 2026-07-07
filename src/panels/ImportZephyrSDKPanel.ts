import * as vscode from "vscode";
import fs from "fs";
import os from "os";
import path from "path";
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";
import { getMinimalToolchainsForVersion, getSdkVersion } from "../utils/zephyr/sdkUtils";
import { fetchArmGnuDownloadCatalog, filterArmGnuCatalogForHost, getArmGnuHostTarget } from "../utils/zephyr/armGnuToolchainUtils";
import { getRustupStatus } from "../utils/zephyr/rustupUtils";
import { fetchLlvmVersions, fetchRustVersions, fetchZephyrRustTargetDetails, RUST_STABLE_CHANNEL } from "../utils/zephyr/rustToolchainUtils";
import { getAllZephyrSdkInstallations, getRegisteredArmGnuToolchainInstallations } from "../utils/utils";

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

  public createContent() {
    this._setWebviewMessageListener(this._panel.webview);
    this._panel.webview.html = this._getWebviewContent(
      this._panel.webview,
      this._extensionUri,
    );
  }

  private async postRustupStatus(webview: vscode.Webview) {
    try {
      const status = await getRustupStatus();
      webview.postMessage({ command: "rustupStatus", rustup: status });
    } catch (error) {
      webview.postMessage({
        command: "rustupStatus",
        rustup: { error: getErrorMessage(error) },
      });
    }
  }

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
    while (this._disposables.length) { this._disposables.pop()?.dispose(); }
  }

  private _getWebviewContent(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
  ) {
    const webviewUri = getUri(webview, extensionUri, ["out", "importsdk.js"]);
    const styleUri = getUri(webview, extensionUri, ["out", "style.css"]);
    const nonce = getNonce();

    let defaultSDKUrl = "";
    if (process.platform === "linux" && process.arch === "x64") {
      defaultSDKUrl =
        "https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v0.17.4/zephyr-sdk-0.17.4_linux-x86_64.tar.xz";
    } else if (process.platform === "linux" && process.arch === "arm64") {
      defaultSDKUrl =
        "https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v0.17.4/zephyr-sdk-0.17.4_linux-aarch64.tar.xz";
    } else if (process.platform === "win32" && process.arch === "x64") {
      defaultSDKUrl =
        "https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v0.17.4/zephyr-sdk-0.17.4_windows-x86_64.7z";
    } else if (process.platform === "darwin" && process.arch === "x64") {
      defaultSDKUrl =
        "https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v0.17.4/zephyr-sdk-0.17.4_macos-x86_64.tar.xz";
    } else if (process.platform === "darwin" && process.arch === "arm64") {
      defaultSDKUrl =
        "https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v0.17.4/zephyr-sdk-0.17.4_macos-aarch64.tar.xz";
    }

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

  <form>
    <div class="grid-group-div">
      <vscode-radio-group id="sourceCategory" orientation="vertical">
        <label slot="label">Toolchain family:</label>
        <vscode-radio value="zephyr" checked>Zephyr SDK</vscode-radio>
        <vscode-radio value="arm-gnu">ARM GNU Toolchain</vscode-radio>
        <vscode-radio value="iar">IAR ARM Toolchain</vscode-radio>
        <vscode-radio value="rust">Rust Toolchain</vscode-radio>
      </vscode-radio-group>
    </div>

    <div id="zephyrOptions" class="sub-option-group">
      <vscode-radio-group id="srcTypeZephyr" orientation="vertical">
        <label slot="label">Source:</label>
        <vscode-radio value="official" checked>Official</vscode-radio>
        <vscode-radio value="remote">Remote</vscode-radio>
        <vscode-radio value="local">Local</vscode-radio>
      </vscode-radio-group>
    </div>

    <div id="armGnuOptions" class="sub-option-group" style="display:none">
      <vscode-radio-group id="srcTypeArmGnu" orientation="vertical">
        <label slot="label">Source:</label>
        <vscode-radio value="arm-gnu" checked>Official</vscode-radio>
        <vscode-radio value="arm-gnu-local">Local</vscode-radio>
      </vscode-radio-group>
    </div>

    <div id="iarOptions" class="sub-option-group iar-row" style="display:none">
      <a class="iar-download-link"
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

  <form id="official-form">
    <div class="grid-group-div">
      <vscode-radio-group id="installDest" orientation="vertical">
        <label slot="label">Destination:</label>
        <vscode-radio value="location" checked>Custom location</vscode-radio>
        <vscode-radio value="global">Global (auto-discovered)</vscode-radio>
      </vscode-radio-group>
    </div>

    <div class="grid-group-div" id="globalBaseRow" style="display:none">
      <div class="grid-header-div">
        <label for="globalBaseSelect">Install location:</label>
      </div>
      <vscode-dropdown id="globalBaseSelect" class="grid-value-div">
        ${getRecommendedGlobalInstallBases().map((base, index) =>
          `<vscode-option value="${base}"${index === 0 ? ' selected' : ''}>${base}</vscode-option>`).join('')}
      </vscode-dropdown>
    </div>

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
        <a href="https://docs.google.com/spreadsheets/d/1wzGJLRuR6urTgnDFUqKk7pEB8O6vWu6Sxziw_KROxMA">
          <span class="tooltip"
                data-tooltip="Compatibility matrix.&#10;Click here...">?</span>
        </a>
      </div>

      <div class="combo-with-spinner">
        <div id="listVersion" class="combo-dropdown grid-value-div">
          <input id="versionInput"
                 class="combo-dropdown-control"
                 placeholder="Choose the SDK version..."
                 data-value="" />
          <div aria-hidden="true" class="indicator" part="indicator">
            <svg class="select-indicator" width="16" height="16"
                 viewBox="0 0 16 16" fill="currentColor">
              <path fill-rule="evenodd" clip-rule="evenodd"
                d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"/>
            </svg>
          </div>

          <div id="versionsDropdown" class="dropdown-content">
            <div class="dropdown-placeholder">Loading SDK versions...</div>
          </div>
        </div>
        <div id="toolchainSpinner" class="spinner version-spinner" aria-label="Loading toolchains" style="display:none"></div>
      </div>
    </div>

    <div class="grid-group-div" id="toolchainSection">
      <fieldset class="no-border">
        <div id="llvmToolchainRow" style="display:none;">
          <vscode-checkbox id="llvmToolchain" value="llvm">
            Include LLVM/Clang toolchain
          </vscode-checkbox>
        </div>
        <div class="toolchains-container" id="toolchainsContainer">
          <div class="toolchain-placeholder">
            Select "Minimal" to fetch toolchains for your platform.
          </div>
        </div>
      </fieldset>
    </div>
  </form>

  <form id="arm-gnu-form" style="display:none">
    <div class="grid-group-div">
      <div class="grid-header-div">
        <label for="armGnuVersionInput">Version:</label>
      </div>

      <div class="combo-with-spinner">
        <div id="listArmGnuVersions" class="combo-dropdown grid-value-div">
          <input type="text"
                 id="armGnuVersionInput"
                 class="combo-dropdown-control"
                 placeholder="Looking online for Arm GNU releases..."
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

          <div id="armGnuVersionsDropdown" class="dropdown-content" style="display:none;">
            <div class="dropdown-placeholder">Looking online for Arm GNU releases...</div>
          </div>
        </div>
        <div id="armGnuSpinner" class="spinner version-spinner" aria-label="Loading Arm GNU releases" style="display:none"></div>
      </div>
    </div>

    <div class="grid-group-div">
      <vscode-radio-group id="armGnuTargetGroup" orientation="vertical">
        <label slot="label">Target:</label>
        <vscode-radio value="arm-none-eabi" checked>AArch32 bare-metal (arm-none-eabi)</vscode-radio>
        <vscode-radio value="aarch64-none-elf">AArch64 bare-metal (aarch64-none-elf)</vscode-radio>
      </vscode-radio-group>
    </div>

    <div class="grid-group-div">
      <vscode-text-field id="armGnuFolderName" size="50">
        Install subfolder:
      </vscode-text-field>
    </div>
  </form>

  <form id="iar-form" style="display:none">
    <div class="grid-group-div">
      <div class="grid-header-div">
        <label for="listSDKs">Select Zephyr SDK:</label>
      </div>

      <div id="listSdks" class="combo-dropdown grid-value-div">
        <input type="text"
               id="sdkInput"
               class="combo-dropdown-control"
               placeholder="Choose your SDK..."
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
          <div class="dropdown-placeholder">Loading SDKs...</div>
        </div>
      </div>
    </div>

    <div class="grid-group-div">
      <vscode-text-field id="iarToken" size="50" type="password">
        IAR LMS BEARER TOKEN:
      </vscode-text-field>
    </div>
  </form>

  <form id="rust-form" style="display:none">
    <div class="grid-group-div">
      <vscode-radio-group id="srcTypeRust" orientation="horizontal">
        <label slot="label">Install method:</label>
        <vscode-radio value="rust-standalone" checked>Standalone</vscode-radio>
        <vscode-radio value="rust-rustup">Rustup</vscode-radio>
      </vscode-radio-group>
    </div>

    <div id="rustupSection" style="display:none">
      <div class="grid-group-div">
        <fieldset class="no-border">
          <label>rustup is installed self-contained in .zinstaller/tools/rustup/ (your PATH is not modified):</label>
          <p id="rustupStatusLine">Checking rustup installation...</p>
          <p id="rustupUpdateLine" style="display:none;color:var(--vscode-editorWarning-foreground);"></p>
          <p id="rustupLocationLine"></p>
          <p id="rustupPrereqLine">Checking prerequisites...</p>
        </fieldset>
      </div>

      <div class="grid-group-div" id="rustupInstallRow" style="display:none">
        <vscode-button id="installRustupButton">Download and install rustup</vscode-button>
      </div>

      <div class="grid-group-div" id="rustupActionsRow" style="display:none">
        <vscode-button id="installPrereqButton">Install C++ Build Tools</vscode-button>
      </div>
    </div>

    <div class="grid-group-div">
      <div class="grid-header-div">
        <label for="rustVersionInput">Version:</label>
      </div>

      <div class="combo-with-spinner">
        <div id="listRustVersions" class="combo-dropdown grid-value-div">
          <input type="text"
                 id="rustVersionInput"
                 class="combo-dropdown-control"
                 placeholder="Looking online for Rust releases..."
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

          <div id="rustVersionsDropdown" class="dropdown-content" style="display:none;">
            <div class="dropdown-placeholder">Looking online for Rust releases...</div>
          </div>
        </div>
        <div id="rustSpinner" class="spinner version-spinner" aria-label="Loading Rust releases" style="display:none"></div>
      </div>
    </div>

    <div class="grid-group-div">
      <vscode-radio-group id="rustType" orientation="horizontal">
        <label slot="label">Type:</label>
        <vscode-radio value="full" checked>Full</vscode-radio>
        <vscode-radio value="minimal">Minimal</vscode-radio>
      </vscode-radio-group>
    </div>

    <div class="grid-group-div" id="rustTargetsSection" style="display:none">
      <fieldset class="no-border">
        <label>Embedded targets:</label>
        <div class="toolchains-container" id="rustTargetsContainer">
          <div class="toolchain-placeholder">Loading Zephyr Rust targets...</div>
        </div>
      </fieldset>
    </div>
${process.platform === 'win32' ? `
    <div class="grid-group-div" id="rustMingwRow">
      <vscode-checkbox id="rustMingwCheckbox" checked>
        Install MinGW-w64 GCC host tools (gcc, dlltool, ...) into the toolchain and add them to PATH
      </vscode-checkbox>
    </div>` : ''}

    <div class="grid-group-div">
      <div class="grid-header-div">
        <label for="rustCToolchainInput">Link C toolchain:</label>
      </div>

      <div id="listRustCToolchains" class="combo-dropdown grid-value-div">
        <input type="text"
               id="rustCToolchainInput"
               class="combo-dropdown-control"
               placeholder="Choose the C toolchain..."
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

        <div id="rustCToolchainDropdown" class="dropdown-content" style="display:none;">
          <div class="dropdown-placeholder">Loading toolchains...</div>
        </div>
      </div>
    </div>

    <div class="grid-group-div" id="llvmVersionRow">
      <div class="grid-header-div">
        <label for="llvmVersionInput">Host LLVM (libclang for bindgen):</label>
      </div>

      <div class="combo-with-spinner">
        <div id="listLlvmVersions" class="combo-dropdown grid-value-div">
          <input type="text"
                 id="llvmVersionInput"
                 class="combo-dropdown-control"
                 placeholder="Looking online for LLVM releases..."
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

          <div id="llvmVersionsDropdown" class="dropdown-content" style="display:none;">
            <div class="dropdown-placeholder">Looking online for LLVM releases...</div>
          </div>
        </div>
        <div id="llvmSpinner" class="spinner version-spinner" aria-label="Loading LLVM releases" style="display:none"></div>
      </div>
    </div>

    <div class="grid-group-div" id="rustFolderRow">
      <vscode-text-field id="rustFolderName" size="50">
        Install subfolder:
      </vscode-text-field>
    </div>

  </form>

  <form id="commonLocationForm">
    <div class="grid-group-div">
      <vscode-text-field id="remotePath" size="50" type="url"
                         value="${defaultSDKUrl}">
        Path:
      </vscode-text-field>
    </div>

    <div class="grid-group-div">
      <vscode-text-field id="workspacePath" size="50">Location:</vscode-text-field>
      <vscode-button id="browseLocationButton"
                     class="browse-input-button">Browse...</vscode-button>
    </div>
  </form>

  <div class="grid-group-div" id="importButtonRow">
    <vscode-button id="importButton"
                   class="finish-input-button">Import</vscode-button>
  </div>

  <script type="module" nonce="${nonce}" src="${webviewUri}"></script>
</body>
</html>
`;
  }

  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
      async (msg) => {
        switch (msg.command) {
          case "openLocationDialog":
            this.openLocationDialog(msg.id);
            return;

          case "import":
            if (!(await checkParameters(msg))) {
              return;
            }

            const { srcType, workspacePath } = msg;

            switch (srcType) {
              case "official":
                if (msg.installDest === "global") {
                  vscode.commands.executeCommand(
                    "zephyr-workbench-sdk-explorer.install-global-sdk",
                    msg.sdkType,
                    msg.sdkVersion,
                    msg.listToolchains,
                    !!msg.includeLlvm,
                    msg.globalInstallBase,
                  );
                } else {
                  vscode.commands.executeCommand(
                    "zephyr-workbench-sdk-explorer.import-official-sdk",
                    msg.sdkType,
                    msg.sdkVersion,
                    msg.listToolchains,
                    workspacePath,
                    !!msg.includeLlvm,
                  );
                }
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

              case "arm-gnu":
                vscode.commands.executeCommand(
                  "zephyr-workbench-sdk-explorer.import-arm-gnu-toolchain",
                  msg.armGnuVersion,
                  msg.armGnuTarget,
                  msg.armGnuUrl,
                  msg.armGnuFolderName,
                  workspacePath,
                );
                break;

              case "arm-gnu-local":
                vscode.commands.executeCommand(
                  "zephyr-workbench-sdk-explorer.import-local-arm-gnu-toolchain",
                  workspacePath,
                );
                break;

              case "rust-standalone":
                vscode.commands.executeCommand(
                  "zephyr-workbench-sdk-explorer.import-standalone-rust-toolchain",
                  msg.rustVersion,
                  msg.rustTargets,
                  msg.rustFolderName,
                  workspacePath,
                  msg.rustCToolchainType,
                  msg.rustCToolchainPath,
                  msg.llvmVersion,
                  msg.rustInstallMingw,
                );
                break;

              case "rust-rustup":
                vscode.commands.executeCommand(
                  "zephyr-workbench-sdk-explorer.import-rust-toolchain",
                  msg.rustVersion,
                  msg.rustTargets,
                  msg.rustCToolchainType,
                  msg.rustCToolchainPath,
                  msg.llvmVersion,
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
            return;

          case "fetchMinimalToolchains": {
            const version = msg.version as string | undefined;
            if (!version) {
              webview.postMessage({
                command: "toolchainError",
                version,
                message: "Missing version when fetching toolchains.",
              });
              return;
            }
            try {
              const toolchains = await getMinimalToolchainsForVersion(version);
              webview.postMessage({
                command: "toolchainList",
                version,
                toolchains,
              });
            } catch (error: any) {
              webview.postMessage({
                command: "toolchainError",
                version,
                message: error?.message ?? String(error),
              });
            }
            return;
          }

          case "fetchImportSdkData": {
            const [versionsResult, sdkResult, armGnuResult, rustupResult, rustResult, armGnuRegisteredResult, llvmResult] = await Promise.allSettled([
              getSdkVersion(),
              getAllZephyrSdkInstallations(),
              getArmGnuImportData(),
              getRustupStatus(),
              getRustImportData(),
              getRegisteredArmGnuToolchainInstallations(),
              fetchLlvmVersions(),
            ]);

            webview.postMessage({
              command: "importSdkData",
              versions: versionsResult.status === "fulfilled" ? versionsResult.value : [],
              versionError: versionsResult.status === "rejected"
                ? getErrorMessage(versionsResult.reason)
                : undefined,
              sdks: sdkResult.status === "fulfilled"
                ? sdkResult.value.map((sdk) => ({
                    path: sdk.rootUri.fsPath,
                    name: sdk.name,
                    version: sdk.version,
                  }))
                : [],
              sdkError: sdkResult.status === "rejected"
                ? getErrorMessage(sdkResult.reason)
                : undefined,
              armGnu: armGnuResult.status === "fulfilled"
                ? armGnuResult.value
                : {
                    releases: [],
                    assets: [],
                    error: getErrorMessage(armGnuResult.reason),
                  },
              rustup: rustupResult.status === "fulfilled"
                ? rustupResult.value
                : { error: getErrorMessage(rustupResult.reason) },
              rust: rustResult.status === "fulfilled"
                ? rustResult.value
                : {
                    versions: [],
                    targets: [],
                    error: getErrorMessage(rustResult.reason),
                  },
              armGnuRegistered: armGnuRegisteredResult.status === "fulfilled"
                ? armGnuRegisteredResult.value.map((toolchain) => ({
                    name: toolchain.name,
                    path: toolchain.toolchainPath,
                  }))
                : [],
              llvm: llvmResult.status === "fulfilled"
                ? { versions: llvmResult.value.suggested, allVersions: llvmResult.value.all }
                : { versions: [], allVersions: [], error: getErrorMessage(llvmResult.reason) },
            });
            return;
          }

          case "fetchRustupStatus": {
            await this.postRustupStatus(webview);
            return;
          }

          case "installRustup": {
            try {
              await vscode.commands.executeCommand("zephyr-workbench-sdk-explorer.install-rustup");
            } catch (error) {
              vscode.window.showErrorMessage(getErrorMessage(error));
            }
            await this.postRustupStatus(webview);
            return;
          }

          case "installRustPrereq": {
            try {
              await vscode.commands.executeCommand("zephyr-workbench-sdk-explorer.install-rust-prerequisites");
            } catch (error) {
              vscode.window.showErrorMessage(getErrorMessage(error));
            }
            await this.postRustupStatus(webview);
            return;
          }

        }
      },
      undefined,
      this._disposables,
    );
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

/**
 * Install bases the Zephyr build system discovers automatically, per OS.
 * The user's home directory comes first and is the default on every platform.
 */
export function getRecommendedGlobalInstallBases(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const bases = [home];
    if (process.env.ProgramFiles) {
      bases.push(process.env.ProgramFiles);
    }
    return bases;
  }
  return [
    home,
    path.join(home, '.local'),
    path.join(home, '.local', 'opt'),
    path.join(home, 'bin'),
    '/opt',
    '/usr/local',
  ];
}

// True when the user can create files under targetPath (checking the nearest
// existing ancestor when the directory itself does not exist yet).
function isWritableLocation(targetPath: string): boolean {
  let probe = path.resolve(targetPath);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) {
      return false;
    }
    probe = parent;
  }
  try {
    fs.accessSync(probe, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function getRustImportData() {
  // fetchZephyrRustTargetDetails never throws (falls back to a static list);
  // only a version fetch failure rejects.
  const [versions, targetDetails] = await Promise.all([
    fetchRustVersions(),
    fetchZephyrRustTargetDetails(),
  ]);

  return {
    versions: [RUST_STABLE_CHANNEL, ...versions],
    targets: targetDetails.map(detail => detail.target),
    targetDescriptions: Object.fromEntries(
      targetDetails.map(detail => [detail.target, detail.description]),
    ),
  };
}

async function getArmGnuImportData() {
  const host = getArmGnuHostTarget();
  if (!host) {
    throw new Error("Arm GNU Toolchain import is not supported on this platform.");
  }

  const catalog = filterArmGnuCatalogForHost(
    await fetchArmGnuDownloadCatalog(),
    host.id,
  );

  return {
    releases: catalog.releases,
    assets: catalog.assets,
  };
}

export async function checkParameters(msg: any): Promise<boolean> {
  const { srcType, workspacePath } = msg;

  if (srcType === "rust-standalone" || srcType === "rust-rustup") {
    if (!msg.rustVersion) {
      vscode.window.showErrorMessage(
        "Missing Rust version, please choose a version.",
      );
      return false;
    }
    if (!Array.isArray(msg.rustTargets) || msg.rustTargets.length === 0) {
      vscode.window.showErrorMessage(
        "Select at least one embedded Rust target.",
      );
      return false;
    }
    if (!msg.rustCToolchainType || !msg.rustCToolchainPath) {
      vscode.window.showErrorMessage(
        "Missing linked C toolchain, please select a Zephyr SDK or ARM GNU toolchain.",
      );
      return false;
    }
    if (!msg.llvmVersion) {
      vscode.window.showErrorMessage(
        "Missing LLVM version, please choose the LLVM release to download.",
      );
      return false;
    }

    if (srcType === "rust-standalone") {
      if (!workspacePath) {
        vscode.window.showErrorMessage(
          "Missing destination, please enter the toolchain location.",
        );
        return false;
      }
      if (!msg.rustFolderName) {
        vscode.window.showErrorMessage(
          "Missing install subfolder, please enter a folder name for the toolchain.",
        );
        return false;
      }
    }
    return true;
  }

  // Global installs pick among the auto-discovered locations instead of the
  // free-form Location field; the chosen base must be writable by the user.
  const isGlobalOfficialInstall = srcType === "official" && msg.installDest === "global";
  if (isGlobalOfficialInstall) {
    const base = typeof msg.globalInstallBase === "string" ? msg.globalInstallBase.trim() : "";
    if (!base) {
      vscode.window.showErrorMessage(
        "Missing install location, please choose where to install the SDK.",
      );
      return false;
    }
    if (!isWritableLocation(base)) {
      vscode.window.showErrorMessage(
        `You do not have permission to write to ${base}. Choose another install location.`,
      );
      return false;
    }
  }
  if (!workspacePath && !isGlobalOfficialInstall) {
    if (srcType === "arm-gnu-local") {
      vscode.window.showErrorMessage(
        "Missing Arm GNU toolchain location, please select its install folder.",
      );
      return false;
    }

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

  if (srcType === "arm-gnu") {
    if (!msg.armGnuVersion || !msg.armGnuTarget || !msg.armGnuUrl || !msg.armGnuFolderName) {
      vscode.window.showErrorMessage(
        "Missing Arm GNU selection, please choose a version, bare-metal target, and install subfolder.",
      );
      return false;
    }
  }

  if (srcType === "iar") {
    if (!msg.iarZephyrSdkPath) {
      vscode.window.showErrorMessage(
        "Missing SDK path, please pick it with Select SDK.",
      );
      return false;
    }
    if (!msg.iarToken) {
      const response = await vscode.window.showWarningMessage(
        "No IAR LMS BEARER TOKEN was supplied.\n\n" +
        "Zephyr Workbench will use the IAR toolchain under its perpetual licence.\n\n" +
        "Do you want to proceed?",
        { modal: true },
        "Continue",
      );
      if (response !== "Continue") {
        return false;
      }
    }
  }

  return true;
}
