import * as vscode from "vscode";
import fs, { accessSync, existsSync } from "fs";
import path from "path";
import os from "os";
import yaml from "yaml";
import { getNonce } from "../utilities/getNonce";
import { getUri } from "../utilities/getUri";
import { execCommandWithEnv, execShellCommandWithEnv, getOutputChannel, classifyShell, getShellExe, concatCommands } from "../utils/execUtils";
import { getInternalDirRealPath, getZephyrSDK } from "../utils/utils";
import { getExtraPaths, normalizePath, setExtraPath } from "../utils/envYamlUtils";
import type { IEclairExtension } from "../ext/eclair_api";
import type { ExtensionMessage, WebviewMessage } from "../utils/eclairEvent";
import { extract_yaml_from_ecl_content, format_option_settings, parse_eclair_template_from_any } from "../utils/eclair/template_utils";
import { ALL_ECLAIR_REPORTS, EclairPresetTemplateSource, EclairRepos, FullEclairScaConfig, FullEclairScaConfigSchema, PresetSelectionState } from "../utils/eclair/config";
import { ensureRepoCheckout, deleteRepoCheckout } from "./EclairManagerPanel/repo_manage";
import { Result, unwrap_or_throw } from "../utils/typing_utils";
import { match } from "ts-pattern";
import { load_preset_from_ref } from "./EclairManagerPanel/templates";
import { ZephyrAppProject } from "../models/ZephyrAppProject";
import { z } from "zod";

const BuildConfigurationSchema = z.object({
  name: z.string(),
  board: z.string(),
  sca: z.array(z.object({
    name: z.string(),
    cfg: z.record(z.string(), z.any())
  })).optional(),
  active: z.union([z.boolean(), z.string()]).optional(),
});

type BuildConfiguration = z.infer<typeof BuildConfigurationSchema>;

export class EclairManagerPanel {
  /**
   * Save the ECLAIR path in env.yml without checks, always overwrites.
   * Usage: EclairManagerPanel.saveEclairAbsolutePath("/path/to/eclair");
   */
  public static saveEclairAbsolutePath(dir: string) {
    try {
      const envYamlPath = path.join(getInternalDirRealPath(), "env.yml");
      let envObj: any = {};
      if (fs.existsSync(envYamlPath)) {
        envObj = yaml.parse(fs.readFileSync(envYamlPath, "utf8")) || {};
      }
      if (!envObj.other) envObj.other = {};
      if (!envObj.other.EXTRA_TOOLS) envObj.other.EXTRA_TOOLS = {};
      envObj.other.EXTRA_TOOLS.path = [normalizePath(dir)];
      fs.writeFileSync(envYamlPath, yaml.stringify(envObj), "utf8");
    } catch (err) {
      vscode.window.showErrorMessage("ECLAIR is not installed. Please install ECLAIR and try again.");
    }
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
  private _reportServerTerminal: vscode.Terminal | undefined;

  /**
   * Dynamically detects the ECLAIR directory for PATH (env.yml, PATH, system).
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
      "ECLAIR Manager",
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
    // Dispose report server terminal if running
    if (this._reportServerTerminal) {
      try {
        this._reportServerTerminal.dispose();
      } catch {
        /* ignore */
      }
      this._reportServerTerminal = undefined;
    }
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }

  /**
   * Utility: Given a path, returns its directory if it's an executable, or the path itself if already a directory.
   * Used to normalize the ECLAIR install path.
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
   * Starts the ECLAIR report server and opens it in the browser.
   */
  private async startReportServer(workspace: string, build_config: string): Promise<void> {
    const folderUri = this.resolveApplicationFolderUri(workspace);
    if (!folderUri) {
      vscode.window.showErrorMessage(`Workspace '${workspace}' not found.`);
      return;
    }

    const dbPath = findEclairDatabase(folderUri, build_config);

    if (!dbPath) {
      vscode.window.showErrorMessage("ECLAIR database (PROJECT.ecd) not found. Please run an analysis first.");
      return;
    }

    // Check if server is already running
    if (this._reportServerTerminal) {
      vscode.window.showInformationMessage("ECLAIR report server is already running, restarting it...");
    }

    const eclairDir = await this.detectEclairDir();
    const eclairReportCmd = eclairDir 
      ? path.join(eclairDir, process.platform === "win32" ? "eclair_report.exe" : "eclair_report")
      : "eclair_report";

    const cmd = `"${eclairReportCmd}" -db="${dbPath}" -browser -server=restart`;

    try {
      const out = getOutputChannel();
      out.appendLine(`[ECLAIR Report] Starting report server...`);
      out.appendLine(`[ECLAIR Report] Database: ${dbPath}`);
      out.appendLine(`[ECLAIR Report] Command: ${cmd}`);

      // Start background processes
      const terminal = vscode.window.createTerminal({
        name: "ECLAIR Report Server",
        hideFromUser: false
      });
      terminal.sendText(cmd);
      terminal.show();

      await this.tryActivateEclairExtension("ECLAIR Report");

      // Store terminal reference
      this._reportServerTerminal = terminal;
      const post_message = (m: ExtensionMessage) => this._panel.webview.postMessage(m);
      post_message({ command: "report-server-started" });
      vscode.window.showInformationMessage("ECLAIR report server started. Check your browser.");
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to start ECLAIR report server: ${err.message || err}`);
    }
  }

  /**
   * Stops the ECLAIR report server.
   */
  private async stopReportServer() {
    if (!this._reportServerTerminal) {
      vscode.window.showInformationMessage("ECLAIR report server is not running.");
      return;
    }

    // Dispose the terminal (this will kill the process)
    this._reportServerTerminal.dispose();
    this._reportServerTerminal = undefined;
    const post_message = (m: ExtensionMessage) => this._panel.webview.postMessage(m);
    post_message({ command: "report-server-stopped" });
    vscode.window.showInformationMessage("ECLAIR report server stopped.");
  }

  /**
   * Attempts to activate the ECLAIR VS Code extension if it's installed.
   */
  private async tryActivateEclairExtension(ctx: string): Promise<void> {
    const out = getOutputChannel();

    try {
      const eclairExt = vscode.extensions.getExtension<IEclairExtension>('bugseng.eclair');
      if (!eclairExt) {
        out.appendLine(`[${ctx}] ECLAIR extension not found.`);
        vscode.window.showInformationMessage("ECLAIR VS Code extension not found. To install it, use the VSIX file provided with ECLAIR (see manual for details).");
        return;
      }

      if (!eclairExt.isActive) {
        out.appendLine(`[${ctx}] Activating ECLAIR extension...`);
        await eclairExt.activate();
        out.appendLine(`[${ctx}] ECLAIR extension activated.`);
      }

      if (!eclairExt.exports || typeof eclairExt.exports.enable !== 'function') {
        out.appendLine(`[${ctx}] ECLAIR extension enable function not found.`);
        vscode.window.showWarningMessage("ECLAIR VS Code extension may be outdated. The enable function is not available. Please make sure the extension is up to date.");
        return;
      }

      out.appendLine(`[${ctx}] Enabling ECLAIR extension...`);
      eclairExt.exports.enable();
      out.appendLine(`[${ctx}] ECLAIR extension enabled.`);
    } catch (err: any) {
      let e = `Could not activate ECLAIR extension: ${err.message || err}`;
      out.appendLine(`[${ctx}] ${e}`);
      vscode.window.showErrorMessage(e);
    }
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
        const post_message = (m: ExtensionMessage) => this._panel.webview.postMessage(m);
        const eclairInfo = this.getEclairPathFromEnv();
        const path = (typeof eclairInfo === 'object' && typeof eclairInfo.path === 'string') ? eclairInfo.path : '';
        const pathToShow = (!path || path === "") ? "Not Found" : path;
        post_message({ command: "set-install-path", path: pathToShow });
        post_message({ command: "set-path-status", text: pathToShow });
        post_message({ command: "set-install-path-placeholder", text: pathToShow });
      }
    });
  }

  /**
   * Returns the ECLAIR path from env.yml (EXTRA_TOOLS), if present.
   * Used to display the current ECLAIR path in the UI and for auto-detection logic.
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
   * Persists the ECLAIR install path to env.yml (EXTRA_TOOLS).
   * Called when the user sets or updates the ECLAIR path from the UI.
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
    const post_message = (m: ExtensionMessage) => this._panel.webview.postMessage(m);
    post_message({ command: 'set-path-status', text: normalized });
    post_message({ command: 'set-install-path-placeholder', text: normalized });
  }

  /**
   * Minimal: Save the detected ECLAIR path ONCE if EXTRA_TOOLS.path is not an array
   * with at least one value. This will never append or touch the file if the
   * path array already exists and has entries.
   */
  private saveEclairPathOnceIfMissing(detectedDir: string) {
    try {
      const envYamlPath = path.join(getInternalDirRealPath(), "env.yml");
      let envObj: any = {};
      if (fs.existsSync(envYamlPath)) {
        envObj = yaml.parse(fs.readFileSync(envYamlPath, "utf8")) || {};
      }
      if (!envObj.other) envObj.other = {};
      if (!envObj.other.EXTRA_TOOLS) envObj.other.EXTRA_TOOLS = {};
      const current = envObj.other.EXTRA_TOOLS.path;
      // If it's already a non-empty array with a valid first entry, do nothing
      if (Array.isArray(current) && current.length > 0 && current[0] && String(current[0]).trim() !== "") {
        return;
      }
      // If it's a string or an empty array, overwrite
      envObj.other.EXTRA_TOOLS.path = [normalizePath(detectedDir)];
      fs.writeFileSync(envYamlPath, yaml.stringify(envObj), "utf8");
    } catch (err) {
    }
  }

  /**
   * Initializes the webview content and sets up message listeners.
   * Also triggers initial probe and loads config fields into the UI.
   */
  public async createContent() {
    this._panel.webview.html = await this._getWebviewContent(this._panel.webview, this._extensionUri);
    this._setWebviewMessageListener(this._panel.webview);

    // Save the ECLAIR path in env.yml as soon as you open the panel, if it's installed and there's no path.
    try {
      // Detect ECLAIR in system PATH
      let exePath: string | undefined = undefined;
      if (process.platform === "win32") {
        const whichCmd = 'powershell -NoProfile -Command "$c=Get-Command eclair -ErrorAction SilentlyContinue; if ($c) { $c.Source }"';
        const execSync = require("child_process").execSync;
        const out = execSync(whichCmd, { encoding: "utf8" });
        const lines = out.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
        if (lines[0] && fs.existsSync(lines[0])) exePath = lines[0];
      } else {
        const execSync = require("child_process").execSync;
        const out = execSync("which eclair", { encoding: "utf8" });
        const lines = out.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
        if (lines[0] && fs.existsSync(lines[0])) exePath = lines[0];
      }
      if (exePath) {
        // Check if we already have a valid path in env.yml
        const arr = getExtraPaths("EXTRA_TOOLS");
        const alreadyHas = Array.isArray(arr) && arr.length > 0 && arr[0] && String(arr[0]).trim() !== "";
        if (!alreadyHas) {
          EclairManagerPanel.saveEclairAbsolutePath(path.dirname(exePath));
        }
      }
    } catch (err) {
      vscode.window.showErrorMessage("ECLAIR is not installed. Please install ECLAIR and try again.");
    }

    const post_message = (m: ExtensionMessage) => this._panel.webview.postMessage(m);

    this._panel.onDidChangeViewState(async () => {
      if (this._panel.visible) {
        try {
          post_message({ command: "toggle-spinner", show: true });
          await this.runEclair();
        } finally {
          post_message({ command: "toggle-spinner", show: false });
        }
        // Restore saved SCA config whenever the panel becomes visible again
        await this.loadScaConfig();
      }
    }, null, this._disposables);

    if (!this._didInitialProbe) {
      this._didInitialProbe = true;
      try {
        post_message({ command: "toggle-spinner", show: true });
        await this.runEclair();
      } finally {
        post_message({ command: "toggle-spinner", show: false });
      }
    }
    
    // Initialize report server button states
    if (this._reportServerTerminal) {
      post_message({ command: "report-server-started" });
    } else {
      post_message({ command: "report-server-stopped" });
    }
  }

  /**
   * Handles messages from the webview (frontend), such as path updates, config saves, etc.
   * This is the main bridge between UI actions and backend logic.
   */
  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
      this._on_webview_message.bind(this),
      undefined,
      this._disposables,
    );
  }

  async _on_webview_message(m: WebviewMessage) {
    function open_link(url: string) {
      vscode.env.openExternal(vscode.Uri.parse(url));
    }

    match(m)
      .with({ command: "update-path" }, ({ newPath }) => {
        this.saveEclairPathToEnv(newPath);
        const eclairInfo = this.getEclairPathFromEnv();
        const path = eclairInfo.path || "";
        // TODO post_message({ command: "path-updated", tool, path, success: true });
      })
      .with({ command: "browse-path" }, async () => {
        const pick = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          title: "Select the ECLAIR installation",
        });
        if (!pick || !pick[0]) {
          return;
        }

        const chosen = pick[0].fsPath.trim();
        this.saveEclairPathToEnv(chosen);
        const eclairInfo = this.getEclairPathFromEnv();
        const path = eclairInfo?.path || "";
        // TODO post_message({ command: "path-updated", tool, path, success: true, FromBrowse: true });
      })
      .with({ command: "manage-license" }, () => open_link("http://localhost:1947"))
      .with({ command: "request-trial" }, () => open_link("https://www.bugseng.com/eclair-request-trial/"))
      .with({ command: "about-eclair" }, () => open_link("https://www.bugseng.com/eclair-static-analysis-tool/"))
      .with({ command: "refresh-status" }, async () => this.refresh_status())
      .with({ command: "reload-sca-config" }, async () => this.loadScaConfig())
      .with({ command: "browse-extra-config" }, async ({ workspace, build_config }) => {
        const folderUri = this.resolveApplicationFolderUri(workspace);
        const pick = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          defaultUri: folderUri,
          title: "Select the additional configuration",
          filters: {
            "ECL file": ["ecl", "eclair", "cmake"],
            "All files": ["*"]
          }
        });
        if (pick?.[0]) {
          const chosen = pick[0].fsPath;
          this.post_message({ command: "set-extra-config", path: chosen, workspace, build_config });
        }
      })
      .with({ command: "save-sca-config" }, async ({ config: cfg, workspace, build_config }) => {
        if (!workspace || !build_config) {
          vscode.window.showErrorMessage("Cannot save ECLAIR config: workspace/build configuration not provided.");
          return;
        }
        await this.saveScaConfig(cfg, workspace, build_config);
      })
      .with({ command: "run-command" }, async ({ config: cfg, workspace, build_config }) => {
        if (!workspace || !build_config) {
          vscode.window.showErrorMessage("Cannot run ECLAIR analysis: workspace/build configuration not provided.");
          return;
        }

        await this.saveScaConfig(cfg, workspace, build_config);

        try {
          const folderUri = this.resolveApplicationFolderUri(workspace);
          if (!folderUri) {
            throw new Error(`Workspace '${workspace}' not found.`);
          }

          const {
            app_dir,
            board,
            build_dir,
            west_top_dir,
          } = this._prepare_for_analysis(folderUri, build_config);

          const merged_env = await this._get_analysis_env(folderUri, build_dir);

          const current_index = cfg.current_config_index ?? 0;
          if (!cfg.configs[current_index]) {
            throw new Error("Could not find configuration at index " + current_index);
          }

          const config = cfg.configs[current_index];

          let cmd = await match(config.main_config)
            .with({ type: "preset" }, async (c) => {
              const {
                user_ruleset_name: fake_ruleset_name,
                user_ruleset_path: fake_ruleset_path,
              } = create_fake_user_ruleset();

              let eclair_options = unwrap_or_throw(await handle_sources(
                [c.ruleset, ...c.variants, ...c.tailorings],
                cfg.repos ?? {},
                // TODO on_progress:
                (progress) => {},
              ));

              return build_analysis_command(
                "USER",
                fake_ruleset_name,
                fake_ruleset_path,
                eclair_options,
                config.extra_config,
                config.reports,
                app_dir,
                build_dir,
                board,
              );
            })
            .with({ type: "custom-ecl" }, (c) => {
              const {
                user_ruleset_name: fake_ruleset_name,
                user_ruleset_path: fake_ruleset_path,
              } = create_fake_user_ruleset();

              return build_analysis_command(
                c.ecl_path,
                fake_ruleset_name,
                fake_ruleset_path,
                [`-eval_file=${c.ecl_path.replace(/\\/g, "/")}`],
                config.extra_config,
                config.reports,
                app_dir,
                build_dir,
                board,
              );
            })
            .with({ type: "zephyr-ruleset" }, (c) => {
              return build_analysis_command(
                c.ruleset,
                c.userRulesetName,
                c.userRulesetPath,
                [],
                config.extra_config,
                config.reports,
                app_dir,
                build_dir,
                board,
              );
            })
            .exhaustive();

            const out = getOutputChannel();
            out.appendLine(`[ECLAIR cwd: ${west_top_dir}`);
            out.appendLine(`[ECLAIR cmd: ${cmd}`);
            out.appendLine(`[ECLAIR ZEPHYR_SDK_INSTALL_DIR=${merged_env.ZEPHYR_SDK_INSTALL_DIR}`);
            out.appendLine(`[ECLAIR ZEPHYR_TOOLCHAIN_VARIANT=${merged_env.ZEPHYR_TOOLCHAIN_VARIANT}`);
            out.appendLine(`[ECLAIR CMAKE_PREFIX_PATH=${merged_env.CMAKE_PREFIX_PATH}`);

            await execShellCommandWithEnv("ECLAIR Analysis", cmd, {
              cwd: west_top_dir,
              env: merged_env,
            });
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to run ECLAIR analysis: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      })
      .with({ command: "probe-eclair" }, () => this.runEclair())
      .with({ command: "browse-user-ruleset-path" }, async ({ workspace, build_config }) => {
        const pick = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          title: "Select Ruleset path"
        });
        if (pick && pick[0]) {
          const chosen = pick[0].fsPath.trim();
          this.post_message({ command: "set-user-ruleset-path", path: chosen, workspace, build_config });
          // save path select from the browse dialog
          const folderUri = this.resolveApplicationFolderUri(workspace);
          if (!folderUri) return;
          const config = vscode.workspace.getConfiguration(undefined, folderUri);
          const configs = config.get<any[]>("zephyr-workbench.build.configurations") ?? [];
          if (!build_config) return;
          const idx = find_build_config_index(configs, build_config);
          if (idx === undefined || !configs[idx]) return;
          const scaEntries = configs[idx].sca;
          if (!Array.isArray(scaEntries) || scaEntries.length === 0) return;
          const eclairEntry = scaEntries.find((c: any) => c?.name === "eclair");
          if (!eclairEntry?.cfg || !Array.isArray(eclairEntry.cfg.configs)) return;
          const current_index = typeof eclairEntry.cfg.current_config_index === "number" ? eclairEntry.cfg.current_config_index : 0;
          const target_config = eclairEntry.cfg.configs[current_index];
          if (!target_config || target_config.main_config?.type !== "zephyr-ruleset") return;
          target_config.main_config.userRulesetPath = deepTokenizePaths(chosen, folderUri);
          await config.update("zephyr-workbench.build.configurations", configs, vscode.ConfigurationTarget.WorkspaceFolder);
        }
      })
      .with({ command: "browse-custom-ecl-path" }, async ({ workspace, build_config }) => {
        const folderUri = this.resolveApplicationFolderUri(workspace);
        const pick = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          defaultUri: folderUri,
          title: "Select custom ECL configuration file",
          filters: {
            "ECL file": ["ecl"],
            "All files": ["*"]
          }
        });
        if (pick && pick[0]) {
          const chosen = pick[0].fsPath.trim();
          this.post_message({ command: "set-custom-ecl-path", path: chosen, workspace, build_config });
        }
      })
      .with({ command: "start-report-server" }, async ({ workspace, build_config }) => {
        if (!workspace || !build_config) {
          vscode.window.showErrorMessage("Cannot start report server: workspace/build configuration not provided.");
          return;
        }
        await this.startReportServer(workspace, build_config);
      })
      .with({ command: "stop-report-server" }, async () => this.stopReportServer())
      .with({ command: "load-preset" }, async ({ source, repos, workspace, build_config }) => {
        let r = await load_preset_from_ref(
          source,
          repos,
          (message) => this.post_message({ command: "preset-content", source, template: { loading: message }, workspace, build_config }),
        );

        if ("err" in r) {
          this.post_message({ command: "preset-content", source, template: { error: r.err }, workspace, build_config });
        } else {
          this.post_message({ command: "preset-content", source, template: r.ok[0], workspace, build_config });
        }
      })
      .with({ command: "scan-repo" }, ({ name, origin, ref, workspace, build_config }) => {
        // Immediately check out the repo and scan all .ecl files, sending
        // back preset-content messages so the webview picker is updated.
        scanAllRepoPresets(name, origin, ref, workspace, build_config, this.post_message.bind(this));
      })
      .with({ command: "update-repo-checkout" }, async ({ name, origin, ref, workspace, build_config }) => {
        const out = getOutputChannel();
        out.appendLine(`[EclairManagerPanel] Deleting cached checkout for '${name}' to force update...`);
        try {
          await deleteRepoCheckout(origin, ref);
        } catch (err: any) {
          out.appendLine(`[EclairManagerPanel] Failed to delete checkout for '${name}': ${err}`);
          this.post_message({ command: "repo-scan-failed", name, message: err?.message || String(err), workspace, build_config });
          return;
        }
        scanAllRepoPresets(name, origin, ref, workspace, build_config, this.post_message.bind(this));
      })
      .with({ command: "pick-preset-path" }, async ({ kind }) => {
        const pick = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          title: "Select preset file",
          filters: {
            "ECL presets": ["ecl"],
            "All files": ["*"]
          }
        });
        if (pick && pick[0]) {
          const chosen = pick[0].fsPath.trim();
          this.post_message({ command: "template-path-picked", kind, path: chosen });
        }
      })
      .exhaustive();
  }

  /**
   * Reads the saved SCA configuration from settings.json and sends it back to
   * the webview so the UI can restore its full state.  This is called both on
   * initial panel creation and whenever the panel becomes visible again.
   */
  private async loadScaConfig() {
    const post_message = (m: ExtensionMessage) => this._panel.webview.postMessage(m);
    const out = getOutputChannel();
    try {
      const configs_r = await load_all_sca_configs();
      if ("err" in configs_r) {
        throw new Error(configs_r.err);
      }
      const configs = configs_r.ok;
      post_message({ command: "set-sca-config", by_workspace_and_build_config: configs });
      await preload_presets_from_configs(configs, post_message);
      out.appendLine("[EclairManagerPanel] Loaded SCA configs:");
      out.appendLine(JSON.stringify(configs, null, 2));

      const scan_requests: Array<{ workspace: string; build_config: string; repos: Record<string, { origin: string; ref: string }> }> = [];
      for (const [workspace, build_configs] of Object.entries(configs)) {
        for (const [build_config, cfg] of Object.entries(build_configs)) {
          if (!cfg?.repos || Object.keys(cfg.repos).length === 0) continue;
          const reposForScan: Record<string, { origin: string; ref: string }> = {};
          for (const [name, entry] of Object.entries(cfg.repos)) {
            reposForScan[name] = { origin: entry.origin, ref: entry.ref };
          }
          scan_requests.push({ workspace, build_config, repos: reposForScan });
        }
      }
      if (scan_requests.length > 0) {
        out.appendLine("[EclairManagerPanel] Scanning configured repos for presets...");
        void Promise.allSettled(
          scan_requests.map((req) => this.scanRepoPresets(req.repos, req.workspace, req.build_config))
        );
      }
    } catch (err) {
      out.appendLine(`[EclairManagerPanel] Error loading SCA config: ${err}`);
      console.error("[EclairManagerPanel] loadScaConfig error:", err);
    }
  }

  /**
   * For each repo in the saved SCA config's `repos` map, ensures it is
   * checked out and then scans all `.ecl` files in the working tree.  Each
   * file that parses as an ECLAIR preset template is posted to the webview
   * as a `preset-content` message so the UI can list it as an available
   * preset.
   *
   * Called automatically at the end of `loadScaConfig` so the frontend always
   * has an up-to-date view of what the configured repos provide.
   */
  private async scanRepoPresets(repos: Record<string, { origin: string; ref: string }>, workspace: string, build_config: string) {
    const post_message = (m: ExtensionMessage) => this._panel.webview.postMessage(m);
    // Fire off all repos concurrently — each one is independent.
    await Promise.allSettled(
      Object.entries(repos).map(([name, entry]) =>
        scanAllRepoPresets(name, entry.origin, entry.ref, workspace, build_config, post_message)
      )
    );
  }

  private async saveScaConfig(cfg: FullEclairScaConfig, workspace: string, build_config: string) {
    const folderUri = this.resolveApplicationFolderUri(workspace);
    if (!folderUri) {
      vscode.window.showErrorMessage(`Workspace '${workspace}' not found.`);
      return;
    }

    // If an installPath was provided in the UI, persist it to env.yml
    if (cfg.install_path) {
      this.saveEclairPathToEnv(cfg.install_path);
    }

    const config = vscode.workspace.getConfiguration(undefined, folderUri);
    const existing = config.get<any[]>("zephyr-workbench.build.configurations") ?? [];
    const configs: any[] = Array.isArray(existing) ? [...existing] : [];
    let idx = find_build_config_index(configs, build_config);
    if (idx === undefined) {
      configs.push({ name: build_config || "primary", active: true });
      idx = configs.length - 1;
    } else if (!configs[idx]) {
      configs[idx] = { name: build_config || "primary", active: true };
    }

    const scaArray: { [key: string]: any } = {
      name: "eclair",
      // TODO: deepTokenizePaths is a blunt recursive replacement, replace with targeted field handling.
      cfg: deepTokenizePaths(cfg, folderUri),
    };

    // TODO maybe useless now
    // Defensive cleanup
    Object.keys(scaArray).forEach(k => {
      if (!scaArray[k]) delete scaArray[k];
    });

    configs[idx].sca = [scaArray];

    await config.update("zephyr-workbench.build.configurations", configs, vscode.ConfigurationTarget.WorkspaceFolder);
  }

  /**
   * Probes the system for ECLAIR installation, gets version, and updates the UI accordingly.
   * If ECLAIR is found and not present in env.yml, adds it automatically.
   */
  private async runEclair() {
    this.loadEnvYaml();
    const post_message = (m: ExtensionMessage) => this._panel.webview.postMessage(m);
    post_message({ command: "toggle-spinner", show: true });
    post_message({ command: "set-path-status", text: "Checking" });
    post_message({ command: "set-install-path-placeholder", text: "Checking" });

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


    let eclairInfo = this.getEclairPathFromEnv();
    // ECLAIR is detected but not present in env.yml, add it automatically (minimal approach)
    if (
      installed &&
      exePath &&
      (!eclairInfo.path || eclairInfo.path.trim() === "")
    ) {
      const detectedDir = normalizePath(path.dirname(exePath));
      this.saveEclairPathOnceIfMissing(detectedDir);
      this.loadEnvYaml();
      eclairInfo = this.getEclairPathFromEnv();
    }

    const eclairPath = (typeof eclairInfo === 'object' && typeof eclairInfo.path === 'string') ? eclairInfo.path : '';
    post_message({ command: 'set-install-path', path: eclairPath });
    post_message({ command: 'set-path-status', text: eclairPath });
    post_message({ command: 'set-install-path-placeholder', text: eclairPath });

    post_message({ command: 'eclair-status', installed, version: installed ? version! : 'unknown' });
    post_message({ command: "toggle-spinner", show: false });

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
<meta name="viewport" content="width=device-width,initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}'; connect-src ${webview.cspSource};">
<link rel="stylesheet" nonce="${nonce}" href="${styleUri}">
<link rel="stylesheet" nonce="${nonce}" href="${codiconUri}">
<title>ECLAIR Manager</title>
</head>
<body id="eclair-manager-body">
<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }

  async refresh_status() {
    try {
      this.post_message({ command: "toggle-spinner", show: true });
      await this.runEclair();
      const eclairInfo = this.getEclairPathFromEnv();
      const path = eclairInfo?.path || "";
      this.post_message({ command: "set-install-path", path });
      this.post_message({ command: "set-path-status", text: path });
      this.post_message({ command: "set-install-path-placeholder", text: path });
    } finally {
      this.post_message({ command: "toggle-spinner", show: false });
    }
    // Webview is now mounted and ready — restore the full saved SCA config
    await this.loadScaConfig();
  }

  post_message(m: ExtensionMessage) {
    this._panel.webview.postMessage(m);
  }

  private resolveApplicationFolderUri(workspace?: string): vscode.Uri | undefined {
    if (workspace && vscode.workspace.workspaceFolders) {
      const byName = vscode.workspace.workspaceFolders.find((f) => f.name === workspace);
      if (byName) {
        return byName.uri;
      }
      const byBasename = vscode.workspace.workspaceFolders.find((f) => path.basename(f.uri.fsPath) === workspace);
      if (byBasename) {
        return byBasename.uri;
      }
    }

    if (this._workspaceFolder) {
      return this._workspaceFolder.uri;
    }

    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  get_repos(): EclairRepos {
    // Look up origin & ref from the stored config — the webview only knows
    // the logical name and the relative file path.
    const folderUri = this.resolveApplicationFolderUri();
    const wsCfg = folderUri ? vscode.workspace.getConfiguration(undefined, folderUri) : undefined;
    const wsCfgs = wsCfg?.get<any[]>("zephyr-workbench.build.configurations") ?? [];
    const activeIdx2 = wsCfgs.findIndex((c: any) => c?.active === true || c?.active === "true");
    const cfgIdx = activeIdx2 >= 0 ? activeIdx2 : 0;
    const scaCfgRaw = wsCfgs[cfgIdx]?.sca?.[0]?.cfg;
    const repos = (scaCfgRaw?.repos ?? {}) as Record<string, { origin: string; ref: string }>;

    return repos;
  }

  _prepare_for_analysis(folderUri: vscode.Uri, build_config: string) {
    // Determine application directory
    const app_dir = folderUri?.fsPath;

    if (!app_dir) {
      throw new Error("Unable to determine application directory for west build.");
    }

    // Determine folder URI for configuration
    const config = vscode.workspace.getConfiguration(undefined, folderUri);
    const configs = config.get<any[]>("zephyr-workbench.build.configurations") ?? [];
    const idx = find_build_config_index(configs, build_config);
    if (idx === undefined) {
      throw new Error(`Build configuration '${build_config}' not found.`);
    }

    // Resolve BOARD from configuration (configurations[].board > zephyr-workbench.board > env)
    const board =
      (configs?.[idx]?.board?.toString()?.trim() || "") ||
      (config.get<string>("zephyr-workbench.board")?.trim() || "") ||
      (process.env.BOARD?.trim() || "");

    if (!board) {
      throw new Error("BOARD not set. Please set it before running ECLAIR analysis.");
    }

    const build_dir = get_build_dir(configs, idx, app_dir);

    const west_top_dir = getWestWorkspacePath(folderUri);
    if (!west_top_dir) {
      throw new Error("West workspace not found.");
    }

    return {
      app_dir,
      board,
      build_dir,
      west_top_dir
    };
  }

  async _get_analysis_env(
    folderUri: vscode.Uri,
    build_dir: string,
  ): Promise<Record<string, string>> {
    // Determine extra paths for environment
    const extra_paths: string[] = [];
    const sdk = process.env.ZEPHYR_SDK_INSTALL_DIR;
    if (sdk) {
      extra_paths.push(path.join(sdk, "arm-zephyr-eabi", "bin"));
      extra_paths.push(path.join(sdk, "cmake", "bin"));
      extra_paths.push(path.join(sdk, "ninja"));
    }
    const westFromInstaller = path.join(
      process.env.USERPROFILE ?? "",
      ".zinstaller",
      ".venv",
      "Scripts"
    );
    if (existsSync(westFromInstaller)) {
      extra_paths.push(westFromInstaller);
    }
    // Add ECLAIR dir
    const eclairDir = await this.detectEclairDir();
    if (eclairDir && existsSync(eclairDir)) {
      extra_paths.push(eclairDir);
    }

    // Ensure all env values are strings (not undefined)
    const merged_env: { [key: string]: string } = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") merged_env[k] = v;
      else merged_env[k] = "";
    }

    // Disable ccache for SCA/ECLAIR (breaks wrapper script)
    merged_env.CCACHE_DISABLE = "1";
    merged_env.PATH =
      (extra_paths.length ? extra_paths.join(path.delimiter) + path.delimiter : "") +
      (process.env.PATH || "");

    // Inject Zephyr SDK and essential variables into the environment
    // Detect SDK (can be hardcoded for your test case)
    let zephyr_sdk_dir = detectZephyrSdkDir(folderUri);
    // If not found, try buildDir (in case SDK is in the project)
    if (!zephyr_sdk_dir && build_dir) {
      const guess = path.join(path.dirname(build_dir), "zephyr-sdk-0.17.4");
      if (fs.existsSync(guess)) zephyr_sdk_dir = guess;
    }
    if (zephyr_sdk_dir) {
      merged_env.ZEPHYR_SDK_INSTALL_DIR = zephyr_sdk_dir;
      merged_env.ZEPHYR_TOOLCHAIN_VARIANT = "zephyr";
      merged_env.CMAKE_PREFIX_PATH = [
        zephyr_sdk_dir,
        path.join(zephyr_sdk_dir, "cmake"),
        process.env.CMAKE_PREFIX_PATH
      ].filter(Boolean).join(path.delimiter);
      merged_env.PATH = [
        path.join(zephyr_sdk_dir, "arm-zephyr-eabi", "bin"),
        path.join(zephyr_sdk_dir, "cmake", "bin"),
        merged_env.PATH
      ].join(path.delimiter);
    }

    return merged_env;
  }
}

/**
 * Recurses through `dir` and collects all files whose name ends with `.ecl`.
 */
async function findEclFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await findEclFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ecl")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Checks out the repository identified by `name`/`origin`@`ref`, then walks
 * every `.ecl` file in the working tree and attempts to parse each as an
 * ECLAIR preset template.  For every file a `preset-content` message is
 * posted — either with the parsed template on success or an error/skip on
 * failure.  Files that contain no YAML front-matter are silently skipped.
 *
 * This is the batch counterpart of `load_preset_from_repo` and is called
 * automatically from `EclairManagerPanel.scanRepoPresets`.
 */
async function scanAllRepoPresets(
  name: string,
  origin: string,
  ref: string,
  workspace: string,
  build_config: string,
  post_message: (m: ExtensionMessage) => void,
): Promise<void> {
  let checkoutDir: string;
  const out = getOutputChannel();
  try {
    out.appendLine(`[EclairManagerPanel] Scanning repo '${name}' for presets...`);
    checkoutDir = await ensureRepoCheckout(name, origin, ref);
    out.appendLine(`[EclairManagerPanel] Checked out repo '${name}' to '${checkoutDir}'.`);
  } catch (err: any) {
    out.appendLine(`[EclairManagerPanel] Failed to checkout repo '${name}': ${err}`);
    post_message({
      command: "repo-scan-failed",
      name,
      message: err?.message || String(err),
      workspace,
      build_config,
    });
    return;
  }

  const eclFiles = await findEclFiles(checkoutDir);

  // Fire off all files concurrently within the repo.
  await Promise.allSettled(
    eclFiles.map(async (absPath) => {
      const relPath = path.relative(checkoutDir, absPath).replace(/\\/g, "/");
      const source: EclairPresetTemplateSource = { type: "repo-path", repo: name, path: relPath };

      let content: string;
      try {
        content = await fs.promises.readFile(absPath, { encoding: "utf8" });
      } catch (err: any) {
        post_message({ command: "preset-content", source, template: { error: `Could not read file: ${err?.message || err}` }, workspace, build_config });
        return;
      }

      const yaml_content = extract_yaml_from_ecl_content(content);
      if (yaml_content === undefined) {
        // Not a template file — silently skip.
        return;
      }

      let data: any;
      try {
        data = yaml.parse(yaml_content);
      } catch (err: any) {
        post_message({ command: "preset-content", source, template: { error: `Failed to parse preset: ${err?.message || err}` }, workspace, build_config });
        return;
      }

      try {
        const template = parse_eclair_template_from_any(data);
        post_message({ command: "preset-content", source, template, workspace, build_config });
      } catch (err: any) {
        post_message({ command: "preset-content", source, template: { error: `Invalid preset content: ${err?.message || err}` }, workspace, build_config });
      }
    })
  );

  // All files have been processed — notify the webview so it can update the status badge.
  post_message({ command: "repo-scan-done", name, workspace, build_config });
}

function build_analysis_command(
    ruleset: string,
    user_ruleset_name: string | undefined,
    user_ruleset_path: string | undefined,
    eclair_options: string[],
    extra_config: string | undefined,
    reports: string[] | undefined,
    app_dir: string,
    build_dir: string,
    board: string,
  ): string {

    const cmake_args: string[] = [
      "-DZEPHYR_SCA_VARIANT=eclair",
      ...cmake_compiler_launcher_options(),
      ...cmake_ruleset_selection_options(ruleset, user_ruleset_name, user_ruleset_path),
      ...cmake_extra_config_options(eclair_options, extra_config?.trim()),
      ...cmake_reports_options(reports),
    ];

    const west = get_west_cmd();

    return [
      west,
      "build",
      "--pristine",
      `-s "${app_dir}"`,
      `-d "${build_dir}"`,
      `--board=${board}`,
      "--",
      ...cmake_args
    ].filter(Boolean).join(" ");
  }

function cmake_compiler_launcher_options() {
  if (process.platform === "win32") {
    // Windows needs empty values to unset the launchers
    return [
      "-DCMAKE_C_COMPILER_LAUNCHER=",
      "-DCMAKE_CXX_COMPILER_LAUNCHER="
    ];
  } else {
    // Linux and macOS can use -U to unset the launchers
    return [
      "-UCMAKE_C_COMPILER_LAUNCHER",
      "-UCMAKE_CXX_COMPILER_LAUNCHER"
    ];
  }
}

function cmake_ruleset_selection_options(
  ruleset: string,
  user_ruleset_name: string | undefined,
  user_ruleset_path: string | undefined,
) {
  let cmake_args: string[] = [];

  if (ruleset === "USER") {
    cmake_args.push("-DECLAIR_RULESET_USER=ON");
    const name = (user_ruleset_name || "").trim();
    const p = (user_ruleset_path || "").trim();
    if (name) cmake_args.push(`-DECLAIR_USER_RULESET_NAME=\"${name}\"`);
    if (p) cmake_args.push(`-DECLAIR_USER_RULESET_PATH=\"${p}\"`);
    cmake_args.push("-DECLAIR_RULESET_FIRST_ANALYSIS=OFF");
  } else if (ruleset) {
    cmake_args.push(`-D${ruleset}=ON`);
    if (ruleset !== "ECLAIR_RULESET_FIRST_ANALYSIS") {
      cmake_args.push("-DECLAIR_RULESET_FIRST_ANALYSIS=OFF");
    }
  } else {
    cmake_args.push("-DECLAIR_RULESET_FIRST_ANALYSIS=ON");
  }

  return cmake_args;
}

function cmake_extra_config_options(
  eclair_options: string[],
  extra_config: string | undefined,
) {
  // .ecl file needs a wrapper that uses -eval_file
  const wrapperPath = path.join(os.tmpdir(), "eclair_wrapper.cmake");

  let content = "";

  for (const opt of eclair_options) {
    const escaped_opt = opt.replace(/"/g, '\\"');
    content += `list(APPEND ECLAIR_ENV_ADDITIONAL_OPTIONS "${escaped_opt}")\n`;
  }

  if (
    extra_config &&
    extra_config !== "Checking" &&
    extra_config !== "Not Found" &&
    fs.existsSync(extra_config) &&
    !fs.statSync(extra_config).isDirectory()
  ) {
    const ext = path.extname(extra_config).toLowerCase();
    const file_path = extra_config.replace(/\\/g, "/");

    if (ext !== ".ecl" && ext !== ".eclair") {
      throw new Error(`Unsupported file extension: ${ext}`);
    }

    content += `list(APPEND ECLAIR_ENV_ADDITIONAL_OPTIONS "-eval_file=${file_path}")\n`;
  }

  fs.writeFileSync(wrapperPath, content, { encoding: "utf8" });
  const final_path = wrapperPath.replace(/\\/g, "/");

  return [`-DECLAIR_OPTIONS_FILE=${final_path}`];
}

function cmake_reports_options(reports: string[] | undefined) {
  const selected = (reports || []).includes("ALL")
      ? ALL_ECLAIR_REPORTS
      : (reports || []).filter(r => r !== "ALL");

  return selected.map(r => `-D${r}=ON`);
}

function get_west_cmd() {
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
      return `& "${westFromInstaller}"`;
    } catch {
      return "west";
    }
  }

  return "west";
}

function create_fake_user_ruleset() {
  const fake_path = path.join(os.tmpdir(), "dummy_user_ruleset");
  const fake_name = "dummy";
  const fake_ecl = path.join(fake_path, `analysis_${fake_name}.ecl`);

  if (fs.existsSync(fake_path)) {
    fs.rmSync(fake_path, { recursive: true });
  }

  fs.mkdirSync(fake_path, { recursive: true });
  fs.writeFileSync(fake_ecl, "", { encoding: "utf8" });

  return {
    user_ruleset_name: fake_name,
    user_ruleset_path: fake_path,
  };
}

async function handle_sources(
  sel: PresetSelectionState[],
  repos: EclairRepos,
  on_progress: (message: string) => void,
): Promise<Result<string[], string>> {
  let all_commands: string[] = [];
  for (const s of sel) {
    let r = await handle_source(s, repos, on_progress);
    if ("err" in r) {
      return { err: `Failed to load preset: ${r.err}` };
    }
    all_commands = all_commands.concat(r.ok);
  }
  return { ok: all_commands };
}

async function handle_source(
  sel: PresetSelectionState,
  repos: EclairRepos,
  on_progress: (message: string) => void,
): Promise<Result<string[], string>> {
  let r = await load_preset_from_ref(sel.source, repos, on_progress);
  if ("err" in r) {
    return { err: `Failed to load preset: ${r.err}` };
  }
  const [preset, path] = r.ok;
  let eclair_commands = format_option_settings(preset, sel.edited_flags).map(s => s.statement);
  eclair_commands.push("-eval_file=\"" + path.replace(/\\/g, "/") + "\"");
  return { ok: eclair_commands };
}

async function load_applications(): Promise<ZephyrAppProject[]> {
  if (!vscode.workspace.workspaceFolders) {
    return [];
  }

  let applications: ZephyrAppProject[] = [];
  for (const workspace_folder of vscode.workspace.workspaceFolders) {
    try {
      if (!await ZephyrAppProject.isZephyrProjectWorkspaceFolder(workspace_folder)) {
        continue;
      }

      const app_project = new ZephyrAppProject(workspace_folder, workspace_folder.uri.fsPath);
      applications.push(app_project);
    } catch {
      // TODO consider returning Result<...>[] instead
    }
  }

  return applications;
}

/**
 * Resolves the most appropriate application (workspace folder) to use for the ECLAIR analysis based on the following priority:
 * @param applications The list of available applications
 * @param current_workspace_folder The current workspace folder associated with the panel (if any) (e.g. the one that was active when the panel was created)
 * @returns 
 */
function resolve_application(
  applications: ZephyrAppProject[],
  current_workspace_folder: vscode.WorkspaceFolder | undefined,
): number | undefined {
  const hasTopLevelCMakeLists = (uri: vscode.Uri | undefined) => {
    if (!uri) return false;
    try {
      return fs.existsSync(path.join(uri.fsPath, "CMakeLists.txt"));
    } catch {
      return false;
    }
  };

  const find_app_by_uri = (uri: vscode.Uri | undefined) => {
    if (!uri) return undefined;
    for (const [i, app] of applications.entries()) {
      if (app.workspaceFolder.uri.toString() === uri.toString()) {
        return i;
      }
    }
    return undefined;
  };

  // 1) Prefer the folder that created the panel, if it looks like an app
  if (current_workspace_folder) {
    const idx = find_app_by_uri(current_workspace_folder.uri);
    if (idx !== undefined) {
      return idx;
    }
  }

  // 2) Prefer active editor's workspace folder, if it looks like an app
  const active_editor = vscode.window.activeTextEditor;
  if (active_editor) {
    const wf = vscode.workspace.getWorkspaceFolder(active_editor.document.uri);
    if (wf && hasTopLevelCMakeLists(wf.uri)) {
      const idx = find_app_by_uri(wf.uri);
      if (idx !== undefined) {
        return idx;
      }
    }
  }

  // 4) Fall back first folder
  return applications.length > 0 ? 0 : undefined;
}

/**
 * Recursively walks `obj` and replaces every string that starts with the
 * workspace folder path with `${workspaceFolder}/...`.
 * TODO: this is a blunt recursive string replacement — a more precise
 * approach would target known path fields explicitly.
 */
function deepTokenizePaths(obj: any, folderUri: vscode.Uri): any {
  if (!folderUri) return obj;
  const wsPath = folderUri.fsPath.replace(/\\/g, "/");
  const walk = (val: any): any => {
    if (typeof val === "string") {
      const n = val.replace(/\\/g, "/");
      if (n === wsPath || n.startsWith(wsPath + "/")) {
        return "${workspaceFolder}" + n.slice(wsPath.length);
      }
      return val;
    }
    if (Array.isArray(val)) return val.map(walk);
    if (val && typeof val === "object") {
      const out: any = {};
      for (const k of Object.keys(val)) out[k] = walk(val[k]);
      return out;
    }
    return val;
  };
  return walk(obj);
}

// TODO: deepResolvePaths is a blunt recursive replacement, replace with targeted field handling.
/**
 * Recursively walks `obj` and expands `${workspaceFolder}` in every string
 * to the actual workspace folder path.
 */
function deepResolvePaths(obj: any, folderUri: vscode.Uri): any {
  const fsPath = folderUri.fsPath;
  const walk = (val: any): any => {
    if (typeof val === "string") {
      return val.replace(/\$\{workspaceFolder\}/g, fsPath);
    }
    if (Array.isArray(val)) return val.map(walk);
    if (val && typeof val === "object") {
      const out: any = {};
      for (const k of Object.keys(val)) out[k] = walk(val[k]);
      return out;
    }
    return val;
  };
  return walk(obj);
}

/**
 * Expands `${workspaceFolder}` in a single string.
 * Used when sending stored paths back to the webview.
 */
function resolveVsCodeVariables(p: string, folderUri: vscode.Uri): string {
  if (!p || !p.includes("${workspaceFolder}")) return p;
  return p.replace(/\$\{workspaceFolder\}/g, folderUri.fsPath);
}

// Gets the west workspace path from settings.json configuration.
function getWestWorkspacePath(folderUri: vscode.Uri): string | undefined {
  const config = vscode.workspace.getConfiguration(undefined, folderUri);
  const westWorkspace = config.get<string>("zephyr-workbench.westWorkspace");
  
  if (westWorkspace && fs.existsSync(westWorkspace)) {
    // Verify it has .west folder
    if (fs.existsSync(path.join(westWorkspace, ".west"))) {
      return westWorkspace;
    }
  }
  
  return undefined;
}

/**
 * Detects the Zephyr SDK installation directory from common environment variables and paths.
 */
function detectZephyrSdkDir(folderUri: vscode.Uri): string | undefined {
  // Try reading settings.json (user/project configuration)
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
 * Finds the ECLAIR PROJECT.ecd database file in the build directory.
 * Searches in build/sca/eclair/PROJECT.ecd path.
 */
function findEclairDatabase(folderUri: vscode.Uri, build_config_name?: string): string | undefined {
  const appDir = folderUri.fsPath;
  const config = vscode.workspace.getConfiguration(undefined, folderUri);
  const configs = config.get<any[]>("zephyr-workbench.build.configurations") ?? [];
  const idx = build_config_name ? find_build_config_index(configs, build_config_name) : get_build_config_index(configs);
  if (idx === undefined) {
    return undefined;
  }

  const buildDir = get_build_dir(configs, idx, appDir);
  const ecdPath = path.join(buildDir, "sca", "eclair", "PROJECT.ecd");

  if (fs.existsSync(ecdPath)) {
    return ecdPath;
  }

  return undefined;
}

function get_build_dir(configs: any, idx: number, appDir: string): string {
  return (
    configs[idx]?.build?.dir ||
      configs[idx]?.buildDir ||
      path.join(appDir, "build", configs[idx]?.name || "primary")
  );
}

function get_build_config_index(configs: any[], build_config_name?: string): number {
  if (build_config_name) {
    const idx = configs.findIndex(c => c?.name === build_config_name);
    if (idx >= 0) {
      return idx;
    }
  }
  const activeIdx = configs.findIndex(c => c?.active === true || c?.active === "true");
  return activeIdx >= 0 ? activeIdx : 0;
}

function find_build_config_index(configs: any[], build_config_name: string): number | undefined {
  const idx = configs.findIndex(c => c?.name === build_config_name);
  return idx >= 0 ? idx : undefined;
}

async function load_sca_config(): Promise<Result<FullEclairScaConfig, string>> {
  try {
    const apps = await load_applications();
    if (apps.length === 0) {
      return { err: "No Zephyr applications found in workspace." };
    }

    const idx = resolve_application(apps, undefined);
    if (idx === undefined) {
      return { err: "Unable to resolve a Zephyr application." };
    }

    const app = apps[idx];
    const build_configs_r = load_project_build_configs(app);
    if ("err" in build_configs_r) {
      return { err: build_configs_r.err };
    }
    const build_configs = build_configs_r.ok;
    const active_idx = build_configs.findIndex(c => c?.active === true || c?.active === "true");
    const cfg_idx = active_idx >= 0 ? active_idx : 0;
    const selected_name = build_configs[cfg_idx]?.name;

    const sca_configs_r = await load_app_sca_configs(app);
    if ("err" in sca_configs_r) {
      return { err: sca_configs_r.err };
    }
    const sca_configs = sca_configs_r.ok;
    const sca_config = (selected_name && sca_configs[selected_name])
      ? sca_configs[selected_name]
      : sca_configs[Object.keys(sca_configs)[0]];
    if (!sca_config) {
      return { err: "No ECLAIR SCA config found for selected build configuration." };
    }

    return { ok: sca_config };
  } catch (err: any) {
    const msg = err?.message || String(err);
    return { err: `Failed to load SCA config: ${msg}` };
  }
}

async function load_all_sca_configs(): Promise<Result<Record<string, Record<string, FullEclairScaConfig>>, string>> {
  try {
    const apps = await load_applications();

    const by_workspace: Record<string, Record<string, FullEclairScaConfig>> = {};
    for (const app of apps) {
      const sca_configs_r = await load_app_sca_configs(app);
      if ("err" in sca_configs_r) {
        // TODO consider aggregating errors
        continue;
      }
      const sca_configs = sca_configs_r.ok;
      const workspace = app.folderName; // TODO this very weak key... multiple folders could have the same name
      by_workspace[workspace] = sca_configs;
    }

    return { ok: by_workspace };
  } catch (err: any) {
    const msg = err?.message || String(err);
    return { err: `Failed to load SCA configs for all apps: ${msg}` };
  }
}

function preset_source_key(source: EclairPresetTemplateSource, repos: EclairRepos): string {
  if (source.type === "repo-path") {
    const repo = repos[source.repo];
    return JSON.stringify({
      source,
      repo: repo ? { origin: repo.origin, ref: repo.ref } : undefined,
    });
  }
  return JSON.stringify(source);
}

async function preload_presets_from_configs(
  by_workspace_and_build_config: Record<string, Record<string, FullEclairScaConfig>>,
  post_message: (m: ExtensionMessage) => void,
): Promise<void> {
  for (const [workspace, build_configs] of Object.entries(by_workspace_and_build_config)) {
    for (const [build_config, cfg] of Object.entries(build_configs)) {
      if (!cfg) continue;
      const seen = new Set<string>();
      const repos = cfg.repos ?? {};
      for (const config of cfg.configs) {
        if (config.main_config.type !== "preset") {
          continue;
        }
        const { ruleset, variants, tailorings } = config.main_config;
        const allPresets = [ruleset, ...variants, ...tailorings];
        for (const p of allPresets) {
          const key = preset_source_key(p.source, repos);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          await load_preset_from_ref(
            p.source,
            repos,
            (message) => post_message({ command: "preset-content", source: p.source, template: { loading: message }, workspace, build_config }),
          ).then(r => {
            if ("err" in r) {
              post_message({ command: "preset-content", source: p.source, template: { error: r.err }, workspace, build_config });
            } else {
              post_message({ command: "preset-content", source: p.source, template: r.ok[0], workspace, build_config });
            }
          });
        }
      }
    }
  }
}

async function load_app_sca_configs(app: ZephyrAppProject): Promise<Result<Record<string, FullEclairScaConfig>, string>> {
  try {
    const build_configs_r = load_project_build_configs(app);
    if ("err" in build_configs_r) {
      throw new Error(build_configs_r.err);
    }
    const build_configs = build_configs_r.ok;

    const sca_configs: Record<string, FullEclairScaConfig> = {};
    for (const build_config of build_configs) {
      const sca = build_config.sca;
      const eclair_cfg_raw = sca?.find((c: any) => c.name === "eclair")?.cfg;
      if (!eclair_cfg_raw) {
        sca_configs[build_config.name] = { configs: [] };
        continue;
      }
      const eclair_resolved_cfg = deepResolvePaths(eclair_cfg_raw, app.workspaceFolder.uri);
      const parsed = FullEclairScaConfigSchema.safeParse(eclair_resolved_cfg);
      if (!parsed.success) {
        // TODO not to console but to the output channel, and ideally also surface in the UI so users know their config is not being loaded
        console.warn(`Saved SCA config for app '${app.folderName}' failed validation and will be reset:`, parsed.error);
        sca_configs[build_config.name] = { configs: [] };
        continue;
      }
      sca_configs[build_config.name] = parsed.data;
    }

    return { ok: sca_configs };
  } catch (err: any) {
    const msg = err?.message || String(err);
    return { err: `Failed to load SCA config for app '${app.folderName}': ${msg}` };
  }
}

function load_project_build_configs(app: ZephyrAppProject): Result<BuildConfiguration[], string> {
  try {
    const folder_uri = app.workspaceFolder.uri;
    const folder_config = vscode.workspace.getConfiguration(undefined, folder_uri);
    const raw_configs = folder_config.get<any[]>("zephyr-workbench.build.configurations") ?? [];
    const configs: BuildConfiguration[] = [];
    for (const c of raw_configs) {
      const parsed = BuildConfigurationSchema.safeParse(c);
      if (parsed.success) {
        configs.push(parsed.data);
      } else {
        const idx = raw_configs.indexOf(c);
        // TODO not to console but to the output channel, and ideally also surface in the UI so users know their config is not being loaded
        console.warn(`Configuration at index ${idx} failed validation and will be skipped:`, parsed.error);
      }
    }
    return { ok: configs };
  } catch (err: any) {
    const msg = err?.message || String(err);
    return { err: `Failed to load SCA config for app '${app.folderName}': ${msg}` };
  }
}
