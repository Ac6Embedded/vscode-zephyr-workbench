import * as vscode from "vscode";
import fs, { accessSync, existsSync } from "fs";
import path from "path";
import yaml from "yaml";
import { getNonce } from "../utilities/getNonce";
import { getUri } from "../utilities/getUri";
import { execCommandWithEnv, execShellCommandWithEnv, getOutputChannel, classifyShell, getShellExe, concatCommands } from "../utils/execUtils";
import { getInternalDirRealPath } from "../utils/utils";
import { getExtraPaths, normalizePath, setExtraPath } from "../utils/envYamlUtils";

interface IEclairConfig {
  installPath?: string;
  ruleset?: string;
  userRulesetName?: string;
  userRulesetPath?: string;
  reports?: string[];
  extraConfig?: string;
}

export class EclairManagerPanel {
    /**
     * Detects the Zephyr SDK installation directory from common environment variables and paths.
     */
    private detectZephyrSdkDir(): string | undefined {
      // Try reading settings.json (user/project configuration)
      const folderUri = this._workspaceFolder?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
      const config = vscode.workspace.getConfiguration(undefined, folderUri);
      const sdkFromSettings = config.get<string>("zephyr-workbench.sdk");
      if (sdkFromSettings && fs.existsSync(sdkFromSettings)) {
        return sdkFromSettings;
      }

      // TODO: Improve the Fallback  
      const candidates = [
        process.env.ZEPHYR_SDK_INSTALL_DIR,
        path.join(process.env.USERPROFILE ?? "", ".zinstaller", "tools", "zephyr-sdk"),
      ];

      for (const c of candidates) {
        if (c && fs.existsSync(c)) return c;
      }
      return undefined;
    }
  /**
   * Save the extra config path to the active SCA (Static Code Analysis) configuration in settings.json
   * Called when the user updates the additional configuration (.ecl) path from the UI.
   */
  private async saveExtraConfigToActiveSca(newPath: string) {
    const folderUri = this._workspaceFolder?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    const config = vscode.workspace.getConfiguration(undefined, folderUri);
    const configs = config.get<any[]>("zephyr-workbench.build.configurations") ?? [];
    const activeIdx = configs.findIndex(c => c?.active === true || c?.active === "true");
    const idx = activeIdx >= 0 ? activeIdx : 0;
    if (!configs[idx]) return;
    if (!Array.isArray(configs[idx].sca) || configs[idx].sca.length === 0) {
      configs[idx].sca = [{ name: "eclair" }];
    }
    configs[idx].sca[0].extraConfig = newPath && !["Checking", "Not Found"].includes(newPath.trim()) ? newPath.trim() : undefined;
    if (configs[idx].sca[0].path) delete configs[idx].sca[0].path;
    await config.update("zephyr-workbench.build.configurations", configs, vscode.ConfigurationTarget.WorkspaceFolder);
    console.log("[EclairManagerPanel] Saved extraConfig in sca:", newPath);
  }
  public static currentPanel: EclairManagerPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _workspaceFolder: vscode.WorkspaceFolder | undefined;
  private _settingsRoot: string | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _didInitialProbe = false;
  private _envWatcher: fs.FSWatcher | undefined;
  private envData: any | undefined;
  private envYamlDoc: any | undefined;

  /**
   * Dynamically detects the Eclair directory for PATH (env.yml, PATH, system).
   * Never uses installPath from the UI for execution.
   */
  private async detectEclairDir(): Promise<string | undefined> {
    // Try env.yml (EXTRA_TOOLS)
    const eclairInfo = this.getEclairPathFromEnv();
    if (eclairInfo && eclairInfo.path && fs.existsSync(eclairInfo.path)) {
      return eclairInfo.path;
    }
    // Try system PATH
    try {
      const whichCmd = process.platform === "win32"
        ? 'powershell -NoProfile -Command "$c=Get-Command eclair -ErrorAction SilentlyContinue; if ($c) { $c.Source }"'
        : 'which eclair';
      const execSync = require("child_process").execSync;
      const out = execSync(whichCmd, { encoding: "utf8" });
      const lines = out.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
      if (lines[0] && fs.existsSync(lines[0])) {
        return path.dirname(lines[0]);
      }
    } catch { /* ignore */ }
    
    return undefined;
  }

  

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, workspaceFolder?: vscode.WorkspaceFolder, settingsRoot?: string) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._workspaceFolder = workspaceFolder;
    this._settingsRoot = settingsRoot;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Load env.yml and watch for external edits so the path field stays in sync
    this.loadEnvYaml();
    this.startEnvWatcher();
  }

  public static render(extensionUri: vscode.Uri, workspaceFolder?: vscode.WorkspaceFolder, settingsRoot?: string) {
    if (EclairManagerPanel.currentPanel) {
      EclairManagerPanel.currentPanel._workspaceFolder = workspaceFolder;
      EclairManagerPanel.currentPanel._settingsRoot = settingsRoot;
      EclairManagerPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "zephyr-workbench.eclair-manager.panel",
      "Eclair Manager",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out")],
      }
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, "res", "icons", "light", "eclair.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "res", "icons", "dark", "eclair.svg"),
    };

    EclairManagerPanel.currentPanel = new EclairManagerPanel(panel, extensionUri, workspaceFolder, settingsRoot);
    EclairManagerPanel.currentPanel.createContent();
  }

  public dispose() {
    EclairManagerPanel.currentPanel = undefined;
    if (this._envWatcher) {
      try { this._envWatcher.close(); } catch { /* ignore */ }
    }
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }

  /**
   * Utility: Given a path, returns its directory if it's an executable, or the path itself if already a directory.
   * Used to normalize the Eclair install path.
   */
  private toInstallDir(p?: string): string | undefined {
    if (!p) return undefined;
    const trimmed = p.trim();
    if (!trimmed) return undefined;
    if (trimmed.toLowerCase().endsWith("eclair.exe")) {
      const d = path.dirname(trimmed);
      if (d === "." || d === "") return undefined;
      return d;
    }
    return trimmed;
  }

  /**
   * Loads the env.yml file into memory (this.envData and this.envYamlDoc).
   * Used to keep the UI and backend in sync with external changes.
   */
  private loadEnvYaml() {
    try {
      const envYamlPath = path.join(getInternalDirRealPath(), "env.yml");
      if (fs.existsSync(envYamlPath)) {
        const envYaml = fs.readFileSync(envYamlPath, "utf8");
        this.envData = yaml.parse(envYaml);
        this.envYamlDoc = yaml.parseDocument(envYaml);
      }
    } catch {
      this.envData = undefined;
      this.envYamlDoc = undefined;
    }
  }

  /**
   * Starts a file watcher on env.yml to reload it if changed externally.
   * Keeps the UI fields in sync with manual edits or other tools.
   */
  private startEnvWatcher() {
    if (this._envWatcher) return;
    const envYamlPath = path.join(getInternalDirRealPath(), "env.yml");
    if (!fs.existsSync(envYamlPath)) return;

    this._envWatcher = fs.watch(envYamlPath, async () => {
      this.loadEnvYaml();
      if (this._panel.visible) {
        const eclairInfo = this.getEclairPathFromEnv();
        const path = (typeof eclairInfo === 'object' && typeof eclairInfo.path === 'string') ? eclairInfo.path : '';
        const pathToShow = (!path || path === "") ? "Not Found" : path;
        this._panel.webview.postMessage({ command: "set-install-path", path: pathToShow });
        this._panel.webview.postMessage({ command: "set-path-status", text: pathToShow });
        this._panel.webview.postMessage({ command: "set-install-path-placeholder", text: pathToShow });
      }
    });
  }

  /**
   * Returns the Eclair path from env.yml (EXTRA_TOOLS), if present.
   * Used to display the current Eclair path in the UI and for auto-detection logic.
   */
  private getEclairPathFromEnv(): { path: string | undefined, index: number } {
    try {
      const arr = (this.envData as any)?.other?.EXTRA_TOOLS?.path;
      if (Array.isArray(arr) && arr.length > 0) {
        const idx = arr.length - 1;
        return { path: normalizePath(arr[idx]), index: idx };
      }
    } catch {
      // ignore
    }
    // Fallback: read directly from env.yml helpers in case in-memory parse failed
    const arr = getExtraPaths("EXTRA_TOOLS");
    if (arr.length > 0) {
      const idx = arr.length - 1;
      return { path: normalizePath(arr[idx]), index: idx };
    }
    return { path: undefined, index: -1 };
  }

  /**
   * Persists the Eclair install path to env.yml (EXTRA_TOOLS).
   * Called when the user sets or updates the Eclair path from the UI.
   */
  private saveEclairPathToEnv(installPath?: string) {
    const dir = this.toInstallDir(installPath);
    if (!dir) return;
    const normalized = normalizePath(dir);
    // Allows you to save any value
    if (!normalized) return;
    // get current paths
    const arr = getExtraPaths("EXTRA_TOOLS");
    // find index where eclair is detected or matches current UI
    let idx = this.getEclairPathFromEnv().index;
    if (idx < 0) idx = 0;
    // use setExtraPath helper to update env.yml
    require("../utils/envYamlUtils").setExtraPath("EXTRA_TOOLS", idx, normalized);
    // reload in-memory state
    this.loadEnvYaml();
    this.startEnvWatcher();
    // persist in UI immediately with the saved value
    this._panel.webview.postMessage({ command: 'set-install-path', path: normalized });
    this._panel.webview.postMessage({ command: 'set-path-status', text: normalized });
    this._panel.webview.postMessage({ command: 'set-install-path-placeholder', text: normalized });
  }

  /**
   * Initializes the webview content and sets up message listeners.
   * Also triggers initial probe and loads config fields into the UI.
   */
  public async createContent() {
    this._panel.webview.html = await this._getWebviewContent(this._panel.webview, this._extensionUri);
    this._setWebviewMessageListener(this._panel.webview);

    // Read .ecl config path from active sca object and send to webview
    try {
      const folderUri = this._workspaceFolder?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
      const config = vscode.workspace.getConfiguration(undefined, folderUri);
      const configs = config.get<any[]>("zephyr-workbench.build.configurations") ?? [];
      const activeIdx = configs.findIndex(c => c?.active === true || c?.active === "true");
      const idx = activeIdx >= 0 ? activeIdx : 0;
      let extraConfigPath = "";
      if (configs[idx] && Array.isArray(configs[idx].sca) && configs[idx].sca.length > 0) {
        const raw = configs[idx]?.sca?.[0]?.extraConfig;
        extraConfigPath = raw && !["Checking", "Not Found"].includes(raw) ? raw : "";
      }
      this._panel.webview.postMessage({ command: "set-extra-config", path: extraConfigPath });
    } catch {
      this._panel.webview.postMessage({ command: "set-extra-config", path: "" });
    }

    this._panel.onDidChangeViewState(async () => {
      if (this._panel.visible) {
        try {
          this._panel.webview.postMessage({ command: "toggle-spinner", show: true });
          await this.runEclair();
        } finally {
          this._panel.webview.postMessage({ command: "toggle-spinner", show: false });
        }
        try {
          const folderUri = this._workspaceFolder?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
          const config = vscode.workspace.getConfiguration(undefined, folderUri);
          const configs = config.get<any[]>("zephyr-workbench.build.configurations") ?? [];
          const activeIdx = configs.findIndex(c => c?.active === true || c?.active === "true");
          const idx = activeIdx >= 0 ? activeIdx : 0;
          let extraConfigPath = "";
          if (configs[idx] && Array.isArray(configs[idx].sca) && configs[idx].sca.length > 0) {
            const raw = configs[idx]?.sca?.[0]?.extraConfig;
            extraConfigPath = raw && !["Checking", "Not Found"].includes(raw) ? raw : "";
          }
          this._panel.webview.postMessage({ command: "set-extra-config", path: extraConfigPath });
        } catch {
          this._panel.webview.postMessage({ command: "set-extra-config", path: "" });
        }
        try {
          const folderUri = this._workspaceFolder?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
          const config = vscode.workspace.getConfiguration(undefined, folderUri);
          const configs = config.get<any[]>("zephyr-workbench.build.configurations") ?? [];
          const activeIdx = configs.findIndex(c => c?.active === true || c?.active === "true");
          const idx = activeIdx >= 0 ? activeIdx : 0;
          let userRulesetName = "";
          let userRulesetPath = "";
          if (configs[idx] && Array.isArray(configs[idx].sca) && configs[idx].sca.length > 0) {
            userRulesetName = configs[idx].sca[0].userRulesetName || "";
            userRulesetPath = configs[idx].sca[0].userRulesetPath || "";
          }
          this._panel.webview.postMessage({ command: "set-user-ruleset-name", name: userRulesetName });
          this._panel.webview.postMessage({ command: "set-user-ruleset-path", path: userRulesetPath });
        } catch {
          this._panel.webview.postMessage({ command: "set-user-ruleset-name", name: "" });
          this._panel.webview.postMessage({ command: "set-user-ruleset-path", path: "" });
        }
      }
    }, null, this._disposables);

    if (!this._didInitialProbe) {
      this._didInitialProbe = true;
      try {
        this._panel.webview.postMessage({ command: "toggle-spinner", show: true });
        await this.runEclair();
      } finally {
        this._panel.webview.postMessage({ command: "toggle-spinner", show: false });
      }
    }
  }

  /**
   * Handles messages from the webview (frontend), such as path updates, config saves, etc.
   * This is the main bridge between UI actions and backend logic.
   */
  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(async (m: any) => {
      switch (m.command) {
        case "update-path": {
          const { tool, newPath } = m;
          if (tool === "eclair") {
            this.saveEclairPathToEnv(newPath);
            const eclairInfo = this.getEclairPathFromEnv();
            const path = eclairInfo?.path || "";
            webview.postMessage({ command: "path-updated", tool, path, success: true });
          }
          break;
        }
        case "browse-path": {
          const { tool } = m;
          if (tool === "eclair") {
            const pick = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: "Select Eclair installation" });
            if (pick && pick[0]) {
              const chosen = pick[0].fsPath.trim();
              this.saveEclairPathToEnv(chosen);
              const eclairInfo = this.getEclairPathFromEnv();
              const path = eclairInfo?.path || "";
              webview.postMessage({ command: "path-updated", tool, path, success: true, FromBrowse: true });
            }
          }
          break;
        }
        case "toggle-add-to-path": {
          const { tool, addToPath } = m;
          if (tool === "eclair") {
            webview.postMessage({ command: "add-to-path-updated", tool, doNotUse: !addToPath });
          }
          break;
        }
        case "manage-license":
          vscode.env.openExternal(vscode.Uri.parse("http://localhost:1947"));
          break;
        case "request-trial":
          vscode.env.openExternal(vscode.Uri.parse("https://www.bugseng.com/eclair-request-trial/"));
          break;
        case "about-eclair":
          vscode.env.openExternal(vscode.Uri.parse("https://www.bugseng.com/eclair-static-analysis-tool/"));
          break;
        case "refresh-status": {
          try {
            this._panel.webview.postMessage({ command: "toggle-spinner", show: true });
            await this.runEclair();
            const eclairInfo = this.getEclairPathFromEnv();
            const path = eclairInfo?.path || "";
            this._panel.webview.postMessage({ command: "set-install-path", path });
            this._panel.webview.postMessage({ command: "set-path-status", text: path });
            this._panel.webview.postMessage({ command: "set-install-path-placeholder", text: path });
          } finally {
            this._panel.webview.postMessage({ command: "toggle-spinner", show: false });
          }
          break;
        }
        case "browse-install-path": {
          const pick = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: "Select Eclair installation"
          });
          if (pick && pick[0]) {
            webview.postMessage({ command: "set-install-path", path: pick[0].fsPath });
          }
          break;
        }
        case "browse-extra-config": {
          const pick = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            title: "Select ECLAIR options file (.ecl / .cmake)",
            filters: {
              "ECLAIR config": ["ecl", "cmake"],
              "All files": ["*"]
            }
          });
          break;
        }
        case "update-extra-config": {
          const newPath = (m?.newPath || "").toString().trim();
          if (!newPath) break;
          webview.postMessage({ command: "set-extra-config", path: newPath });
          await this.saveExtraConfigToActiveSca(newPath);
          break;
        }

        case "save-sca-config": {
          const cfg: IEclairConfig = m.data || {};
          await this.saveScaConfig(cfg);
          if (cfg.extraConfig) {
            await this.saveExtraConfigToActiveSca(cfg.extraConfig);
          }
          break;
        }
        case "run-command": {
          const cfg: IEclairConfig = m.data || {};
          await this.saveScaConfig(cfg);

          // Determine application directory
          const appDir =
            this._workspaceFolder?.uri.fsPath ||
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

          if (!appDir) {
            vscode.window.showErrorMessage("Unable to determine application directory for west build.");
            break;
          }

          // Determine folder URI for configuration
          const folderUri = this._workspaceFolder?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
          const config = vscode.workspace.getConfiguration(undefined, folderUri);
          const configs = config.get<any[]>("zephyr-workbench.build.configurations") ?? [];
          const activeIdx = configs.findIndex(c => c?.active === true || c?.active === "true");
          const idx = activeIdx >= 0 ? activeIdx : 0;

          const buildDir =
            configs[idx]?.build?.dir ||
            configs[idx]?.buildDir ||
            path.join(appDir, "build");

          // Build complete command
          const cmakeArgs = this.buildCmd(cfg)
            .replace(/^.*?--\s*/, ""); 

          const westCmd = process.platform === "win32"
            ? "west"
            : "west";

          const cmd = [
            westCmd,
            "build",
            `-s "${appDir}"`,
            `-d "${buildDir}"`,
            "--",
            cmakeArgs
          ].join(" ");


          // Determine extra paths for environment
          const extraPaths: string[] = [];
          const sdk = process.env.ZEPHYR_SDK_INSTALL_DIR;
          if (sdk) {
            extraPaths.push(path.join(sdk, "arm-zephyr-eabi", "bin"));
            extraPaths.push(path.join(sdk, "cmake", "bin"));
            extraPaths.push(path.join(sdk, "ninja"));
          }
          const westFromInstaller = path.join(
            process.env.USERPROFILE ?? "",
            ".zinstaller",
            ".venv",
            "Scripts"
          );
          if (existsSync(westFromInstaller)) {
            extraPaths.push(westFromInstaller);
          }
          // Add Eclair dir
          const eclairDir = await this.detectEclairDir();
          if (eclairDir && existsSync(eclairDir)) {
            extraPaths.push(eclairDir);
          }

          // Ensure all env values are strings (not undefined)
          const mergedEnv: { [key: string]: string } = {};
          for (const [k, v] of Object.entries(process.env)) {
            if (typeof v === "string") mergedEnv[k] = v;
            else mergedEnv[k] = "";
          }
          mergedEnv.PATH =
            (extraPaths.length ? extraPaths.join(path.delimiter) + path.delimiter : "") +
            (process.env.PATH || "");

          // Inject Zephyr SDK and essential variables into the environment
          // Detect SDK (can be hardcoded for your test case)
          let zephyrSdk = this.detectZephyrSdkDir();
          // If not found, try buildDir (in case SDK is in the project)
          if (!zephyrSdk && buildDir) {
            const guess = path.join(path.dirname(buildDir), "zephyr-sdk-0.17.4");
            if (fs.existsSync(guess)) zephyrSdk = guess;
          }
          if (zephyrSdk) {
            mergedEnv.ZEPHYR_SDK_INSTALL_DIR = zephyrSdk;
            mergedEnv.ZEPHYR_TOOLCHAIN_VARIANT = "zephyr";
            mergedEnv.CMAKE_PREFIX_PATH = [
              zephyrSdk,
              path.join(zephyrSdk, "cmake"),
              process.env.CMAKE_PREFIX_PATH 
            ].filter(Boolean).join(path.delimiter);
            mergedEnv.PATH = [
              path.join(zephyrSdk, "arm-zephyr-eabi", "bin"),
              path.join(zephyrSdk, "cmake", "bin"),
              mergedEnv.PATH
            ].join(path.delimiter);
          }

          const out = getOutputChannel();
          out.appendLine(`[Eclair] cmd: ${cmd}`);
          out.appendLine(`[Eclair] ZEPHYR_SDK_INSTALL_DIR=${mergedEnv.ZEPHYR_SDK_INSTALL_DIR}`);
          out.appendLine(`[Eclair] ZEPHYR_TOOLCHAIN_VARIANT=${mergedEnv.ZEPHYR_TOOLCHAIN_VARIANT}`);
          out.appendLine(`[Eclair] CMAKE_PREFIX_PATH=${mergedEnv.CMAKE_PREFIX_PATH}`);

          try {
            await execShellCommandWithEnv("Eclair Analysis", cmd, {
              cwd: appDir,   
              env: mergedEnv,
            });
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to run Eclair: ${err}`);
          }
          break;
        }

        case "probe-eclair":
          this.runEclair();
          break;
        case "browse-user-ruleset-path": {
          const pick = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: "Select Ruleset path"
          });
          if (pick && pick[0]) {
            const chosen = pick[0].fsPath.trim();
            webview.postMessage({ command: "set-user-ruleset-path", path: chosen });
            // save path select from the browse dialog
            const folderUri = this._workspaceFolder?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
            const config = vscode.workspace.getConfiguration(undefined, folderUri);
            const configs = config.get<any[]>("zephyr-workbench.build.configurations") ?? [];
            const activeIdx = configs.findIndex(c => c?.active === true || c?.active === "true");
            const idx = activeIdx >= 0 ? activeIdx : 0;
            if (configs[idx] && Array.isArray(configs[idx].sca) && configs[idx].sca.length > 0) {
              configs[idx].sca[0].userRulesetPath = chosen;
              await config.update("zephyr-workbench.build.configurations", configs, vscode.ConfigurationTarget.Workspace);
            }
          }
          break;
        }
      }
    }, undefined, this._disposables);
  }

  private buildCmd(cfg: IEclairConfig): string {
    const parts: string[] = [];
    let westCmd = "west";
    if (process.platform === "win32") {
      const westFromInstaller = path.join(
        process.env.USERPROFILE ?? "",
        ".zinstaller",
        ".venv",
        "Scripts",
        "west.exe"
      );
      try {
        accessSync(westFromInstaller);
        westCmd = `& "${westFromInstaller}"`;
      } catch {
        westCmd = "west";
      }
    }

    parts.push(westCmd, "build", "--", "-DZEPHYR_SCA_VARIANT=eclair");

    if (cfg.ruleset === "USER") {
      parts.push("-DECLAIR_RULESET_USER=ON");
      const name = (cfg.userRulesetName || "").trim();
      const p = (cfg.userRulesetPath || "").trim();
      if (name) parts.push(`-DECLAIR_USER_RULESET_NAME=\"${name}\"`);
      if (p) parts.push(`-DECLAIR_USER_RULESET_PATH=\"${p}\"`);
    } else if (cfg.ruleset) {
      parts.push(`-D${cfg.ruleset}=ON`);
    } else {
      parts.push("-DECLAIR_RULESET_FIRST_ANALYSIS=ON");
    }

    const allReports = [
      "ECLAIR_METRICS_TAB",
      "ECLAIR_REPORTS_TAB",
      "ECLAIR_REPORTS_SARIF",
      "ECLAIR_SUMMARY_TXT",
      "ECLAIR_SUMMARY_DOC",
      "ECLAIR_SUMMARY_ODT",
      "ECLAIR_SUMMARY_HTML",
      "ECLAIR_FULL_TXT",
      "ECLAIR_FULL_DOC",
      "ECLAIR_FULL_ODT",
      "ECLAIR_FULL_HTML",
    ];
    const selected = (cfg.reports || []).includes("ALL")
      ? allReports
      : (cfg.reports || []).filter(r => r !== "ALL");

    for (const r of selected) {
      parts.push(`-D${r}=ON`);
    }

    if (cfg.extraConfig) {
      const p = cfg.extraConfig.trim();

      if (
        !p ||
        p === "Checking" ||
        p === "Not Found" ||
        !fs.existsSync(p) ||
        fs.statSync(p).isDirectory()
      ) {
      } else {
        parts.push(`-DECLAIR_OPTIONS_FILE=\"${p}\"`);
      }
    }

    return parts.join(" ");
  }

  private async saveScaConfig(cfg: IEclairConfig) {
    // Prefer explicit workspace folder that created this panel (application context).
    // If not available, prefer the workspace folder of the active editor (so we save in the project's settings),
    // then fall back to settingsRoot or first workspace folder.
    let folderUri = this._workspaceFolder?.uri;
    if (!folderUri) {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        const wf = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
        if (wf) folderUri = wf.uri;
      }
    }
    if (!folderUri && this._settingsRoot) folderUri = vscode.Uri.file(this._settingsRoot);
    if (!folderUri && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) folderUri = vscode.workspace.workspaceFolders[0].uri;
    if (!folderUri) return;

    // If an installPath was provided in the UI, persist it to env.yml
    if (cfg.installPath) {
      this.saveEclairPathToEnv(cfg.installPath);
    }

    const config = vscode.workspace.getConfiguration(undefined, folderUri);
    const existing = config.get<any[]>("zephyr-workbench.build.configurations") ?? [];
    const configs: any[] = Array.isArray(existing) ? [...existing] : [];
    const activeIdx = configs.findIndex(c => c?.active === true || c?.active === "true");
    const idx = activeIdx >= 0 ? activeIdx : 0;
    if (!configs[idx]) {
      configs[idx] = { name: "primary", active: true };
    }

    const reports = cfg.reports && cfg.reports.length > 0 ? cfg.reports : ["ALL"];

    // Save userRulesetName and userRulesetPath explicitly in sca object
    const prevSca = configs[idx] && Array.isArray(configs[idx].sca) && configs[idx].sca.length > 0 ? configs[idx].sca[0] : {};
    const sanitizedExtra =
      cfg.extraConfig &&
      !["Checking", "Not Found"].includes(cfg.extraConfig.trim())
        ? cfg.extraConfig.trim()
        : undefined;

    const scaArray: any = {
      name: "eclair",
      ruleset: cfg.ruleset || "ECLAIR_RULESET_FIRST_ANALYSIS",
      reports,
      extraConfig: sanitizedExtra,
      userRulesetName: cfg.userRulesetName?.trim() || prevSca?.userRulesetName,
      userRulesetPath: cfg.userRulesetPath?.trim() || prevSca?.userRulesetPath,
    };

    // Defensive cleanup
    Object.keys(scaArray).forEach(k => {
      if (!scaArray[k]) delete scaArray[k];
    });

    configs[idx].sca = [scaArray];

    // Determine target scope for update based on folderUri
    const resolvedWf = vscode.workspace.getWorkspaceFolder(folderUri);
    const target = resolvedWf ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
    await config.update("zephyr-workbench.build.configurations", configs, target);
  }

  /**
   * Probes the system for Eclair installation, gets version, and updates the UI accordingly.
   * If Eclair is found and not present in env.yml, adds it automatically.
   */
  private async runEclair() {
    this.loadEnvYaml();
    this._panel.webview.postMessage({ command: "toggle-spinner", show: true });
    this._panel.webview.postMessage({ command: "set-path-status", text: "Checking" });
    this._panel.webview.postMessage({ command: "set-install-path-placeholder", text: "Checking" });

    const readStdout = async (proc: any) => {
      let out = "";
      await new Promise<void>((resolve) => {
        proc.stdout?.on("data", (c: Buffer) => out += c.toString());
        proc.on("close", () => resolve());
        proc.on("error", () => resolve());
      });
      return out;
    };

    let exePath: string | undefined;
    try {
      const cmd = process.platform === "win32"
        ? 'powershell -NoProfile -Command "$c=Get-Command eclair -ErrorAction SilentlyContinue; if ($c) { $c.Source }"'
        : 'which eclair';
      const proc = await execCommandWithEnv(cmd);
      const outStd = await readStdout(proc);
      const lines = outStd.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      exePath = lines[0];
    } catch {
      exePath = undefined;
    }

    let version: string | undefined;
    try {
      const proc = await execCommandWithEnv(exePath ? `"${exePath}" -version` : "eclair -version");
      const out = await readStdout(proc);
      const m1 = out.match(/ECLAIR\s+version\s+([0-9]+(?:\.[0-9]+)*)/i);
      const m2 = out.match(/\b([0-9]+(?:\.[0-9]+)*)\b/);
      version = (m1?.[1] || m2?.[1] || "").trim() || undefined;
    } catch {
      version = undefined;
    }

    const installed = !!version;

    const eclairInfo = this.getEclairPathFromEnv();
    // If Eclair is detected but not present in env.yml, add it automatically
    if (
      installed &&
      exePath &&
      (!eclairInfo.path || eclairInfo.path.trim() === "")
    ) {
      const detectedDir = path.dirname(exePath);
      // Save detected path to env.yml
      this.saveEclairPathToEnv(detectedDir);
      console.log(
        "[EclairManager] Auto-detected Eclair path and saved to env.yml:",
        detectedDir
      );
    }

    const eclairPath = (typeof eclairInfo === 'object' && typeof eclairInfo.path === 'string') ? eclairInfo.path : '';
    this._panel.webview.postMessage({ command: 'set-install-path', path: eclairPath });
    this._panel.webview.postMessage({ command: 'set-path-status', text: eclairPath });
    this._panel.webview.postMessage({ command: 'set-install-path-placeholder', text: eclairPath });

    this._panel.webview.postMessage({ command: 'eclair-status', installed, version: installed ? version! : 'unknown' });
    this._panel.webview.postMessage({ command: "toggle-spinner", show: false });

  }

  private async _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
    const nonce = getNonce();
    const scriptUri = getUri(webview, extensionUri, ["out", "eclairmanager.js"]);
    const styleUri = getUri(webview, extensionUri, ["out", "style.css"]);
    const codiconUri = getUri(webview, extensionUri, ["out", "codicon.css"]);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" nonce="${nonce}" href="${styleUri}">
<link rel="stylesheet" nonce="${nonce}" href="${codiconUri}">
<title>Eclair Manager</title>
</head>
<body>
<h1>Eclair Manager</h1>

<div class="summary">
  <div class="summary-title"><strong>Eclair</strong></div>
  <div>
    <strong>Version:</strong> <span id="eclair-version">Checking</span>
    &nbsp;|&nbsp;
    <strong>Status:</strong> <span id="eclair-status-icon" class="codicon"></span> <span id="eclair-status-text">Checking</span>
    <span id="em-spinner" class="codicon codicon-loading codicon-modifier-spin hidden" title="Detecting Eclair"></span>
  </div>
  <div class="summary-actions">
    <div class="actions-title"><strong>Actions</strong></div>
    <vscode-button id="btn-refresh-status" appearance="primary">Refresh Status</vscode-button>
    <vscode-button id="about-eclair" appearance="primary">About ECLAIR</vscode-button>
    <vscode-button id="manage-license" appearance="primary">Manage ECLAIR License</vscode-button>
    <vscode-button id="request-trial" appearance="primary">Request Trial License</vscode-button>
  </div>
  <div class="grid-group-div">
    <vscode-text-field id="details-path-input-eclair" class="details-path-field" placeholder="Enter the tool's path if not in the global PATH" size="50" disabled>Path:</vscode-text-field>
    <vscode-button id="browse-path-button-eclair" class="browse-input-button" appearance="secondary" disabled><span class="codicon codicon-folder"></span></vscode-button>
    <vscode-button id="edit-path-eclair" class="save-path-button" data-tool="eclair" appearance="primary">Edit</vscode-button>
  </div>
  
</div>

<div class="section">
  <h2>Rulesets</h2>
  <vscode-radio-group id="ruleset-group" orientation="vertical" value="ECLAIR_RULESET_FIRST_ANALYSIS" class="ruleset-group">
    ${[
        "ECLAIR_RULESET_FIRST_ANALYSIS",
        "ECLAIR_RULESET_STU",
        "ECLAIR_RULESET_STU_HEAVY",
        "ECLAIR_RULESET_WP",
        "ECLAIR_RULESET_STD_LIB",
        "ECLAIR_RULESET_ZEPHYR_GUIDELINES",
        "USER"
      ].map(r => `<vscode-radio id="rs-${r}" name="ruleset" value="${r}">${r === "USER" ? "user defined" : r}</vscode-radio>`).join("")}
  </vscode-radio-group>
  <div id="user-ruleset-fields" class="grid-group-div hidden">
    <vscode-text-field id="user-ruleset-name" class="details-path-field" placeholder="Ruleset name (e.g. MYRULESET)" size="30" disabled>Ruleset Name:</vscode-text-field>
    <vscode-button id="edit-user-ruleset-name" class="save-path-button" appearance="primary">Edit</vscode-button>
    <vscode-text-field id="user-ruleset-path" class="details-path-field" placeholder="Path to analysis_<RULESET>.ecl (optional)" size="38" disabled>Ruleset Path:</vscode-text-field>
    <vscode-button id="browse-user-ruleset-path" class="browse-extra-input-button" appearance="secondary" disabled><span class="codicon codicon-folder"></span></vscode-button>
    <vscode-button id="edit-user-ruleset-path" class="save-path-button" appearance="primary">Edit</vscode-button>
  </div>
</div>

<div class="section">
  <h2>Reports</h2>
  <div class="checkbox-grid">
    ${[
        "ALL",
        "ECLAIR_METRICS_TAB",
        "ECLAIR_REPORTS_TAB",
        "ECLAIR_REPORTS_SARIF",
        "ECLAIR_SUMMARY_TXT",
        "ECLAIR_SUMMARY_DOC",
        "ECLAIR_SUMMARY_ODT",
        "ECLAIR_SUMMARY_HTML",
        "ECLAIR_FULL_TXT",
        "ECLAIR_FULL_DOC",
        "ECLAIR_FULL_ODT",
        "ECLAIR_FULL_HTML"
      ].map(r => `<label><vscode-checkbox class="report-chk" value="${r}" ${r === "ALL" ? "checked" : ""}>${r}</vscode-checkbox></label>`).join("")}
  </div>
</div>

<div class="section">
  <h2>Additional Configuration (.ecl)</h2>
  <div class="grid-group-div">
    <vscode-text-field id="extra-config" placeholder="path/to/config" size="50" disabled>Path:</vscode-text-field>
    <vscode-button id="browse-config" class="browse-extra-input-button" appearance="secondary" disabled><span class="codicon codicon-folder"></span></vscode-button>
    <vscode-button id="edit-config" class="save-path-button" appearance="primary">Edit</vscode-button>
  </div>
</div>

<div class="section">
  <div class="grid-group-div command-actions">
    <vscode-button id="generate-cmd" appearance="secondary">Apply configuration</vscode-button>
    <vscode-button id="run-cmd" appearance="primary">Run Analysis</vscode-button>
  </div>
</div>

<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
