import * as vscode from "vscode";
import fs, { accessSync, existsSync } from "fs";
import path from "path";
import os from "os";
import { getNonce } from "../utilities/getNonce";
import { getUri } from "../utilities/getUri";
import { execCommandWithEnv, execShellCommandWithEnv, getOutputChannel } from "../utils/execUtils";
import { getExtraPaths, normalizePath } from "../utils/env/envYamlUtils";
import { readEnvYamlObject, writeEnvYamlObject } from "../utils/env/envYamlFileUtils";
import type { IEclairExtension } from "../ext/eclair_api";
import type { BuildConfigInfo, ExtensionMessage, RpcRequestMessage, WebviewMessage } from "../utils/eclair/eclairEvent";
import type { EclairRpcMethods, OpenDialog, RpcHandlerMap } from "../utils/eclair/eclairRpcTypes";
import { format_option_settings } from "../utils/eclair/template_utils";
import { ALL_ECLAIR_REPORTS, EclairPresetTemplateSource, EclairRepos, EclairScaConfig, FullEclairScaConfig, FullEclairScaConfigSchema, PresetSelectionState, default_eclair_repos } from "../utils/eclair/config";
import { PresetRepositories, resolve_ref_to_rev } from "./EclairManagerPanel/repo_manage";
import { Result, unwrap_or_throw } from "../utils/typing_utils";
import { match } from "ts-pattern";
import { ZephyrAppProject } from "../models/ZephyrAppProject";
import { z } from "zod";
import { EclairTemplate } from "../utils/eclair/template";
import { EclairManagerEnv } from "./EclairManagerPanel/env";

const ECLAIR_MANAGER_SETTINGS_FILENAME = "zephyr-workbench.eclair.json";

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
      const envObj: any = readEnvYamlObject();
      if (!envObj.other) {
        envObj.other = {};
      }
      if (!envObj.other.EXTRA_TOOLS) {
        envObj.other.EXTRA_TOOLS = {};
      }
      envObj.other.EXTRA_TOOLS.path = [normalizePath(dir)];
      writeEnvYamlObject(envObj);
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
  private _env: EclairManagerEnv;
  private envYamlDoc: any | undefined;
  private _reportServerTerminal: vscode.Terminal | undefined;
  private _presetRepos: PresetRepositories;
  private _rpcHandlers: RpcHandlerMap<EclairRpcMethods> = {
    "open-dialog": this._rpcOpenDialog.bind(this),
  };
  private _loading_sca_config = false;

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
    this._env = new EclairManagerEnv();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._presetRepos = new PresetRepositories(
      this.post_message.bind(this),
      (line) => getOutputChannel().appendLine(line),
    );

    this._env.load();

    const on_changed_ctx = { last_eclair_path: "" };
    this._env.on_changed((r) => {
      if (!this._panel.visible) {
        return;
      }

      if ("err" in r) {
        // env was not correctly loaded, ignore
        return;
      }

      const post_message = (m: ExtensionMessage) => this._panel.webview.postMessage(m);
      const { path } = this.getEclairPathFromEnv();
      if (on_changed_ctx.last_eclair_path !== path) {
        on_changed_ctx.last_eclair_path = path || "";
        post_message({ command: "set-install-path", path: path || "" });
        this.probe_eclair();
      }
    });
    let start_result = this._env.start_env_watcher();
    if ("err" in start_result) {
      vscode.window.showErrorMessage(`[EclairManager] Failed to start env watcher: ${start_result.err}`);
    }
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
    this._env.dispose();
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
      if (d) {
        d.dispose();
      }
    }
  }

  /**
   * Utility: Given a path, returns its directory if it's an executable, or the path itself if already a directory.
   * Used to normalize the ECLAIR install path.
   */
  private toInstallDir(p?: string): string | undefined {
    if (!p) {
      return undefined;
    }
    const trimmed = p.trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.toLowerCase().endsWith("eclair.exe")) {
      const d = path.dirname(trimmed);
      if (d === "." || d === "") {
        return undefined;
      }
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
      vscode.window.showInformationMessage("ECLAIR report server started. Check your browser.");
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to start ECLAIR report server: ${err.message || err}`);
    }
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
   * Returns the ECLAIR path from env.yml (EXTRA_TOOLS), if present.
   * Used to display the current ECLAIR path in the UI and for auto-detection logic.
   */
  private getEclairPathFromEnv(): { path: string | undefined, index: number } {
    try {
      const arr = this._env.data?.other?.EXTRA_TOOLS?.path || [];
      if (arr.length > 0) {
        for (let i = 0; i < arr.length; i++) {
          const p = arr[i];
          if (is_eclair_path(p)) {
            return { path: normalizePath(p), index: i };
          }
        }
      }
    } catch {
      // ignore
    }

    // TODO consider blending the above logic with getExtraPaths for DRY
    return { path: undefined, index: -1 };
  }

  /**
   * Persists the ECLAIR install path to env.yml (EXTRA_TOOLS).
   * Called when the user sets or updates the ECLAIR path from the UI.
   */
  private saveEclairPathToEnv(installPath?: string) {
    const dir = this.toInstallDir(installPath);
    const normalized = dir ? normalizePath(dir) : undefined;

    let { index: idx } = this.getEclairPathFromEnv();
    this._env.save_extra_path(normalized, idx);
  }

  /**
   * Minimal: Save the detected ECLAIR path ONCE if EXTRA_TOOLS.path is not an array
   * with at least one value. This will never append or touch the file if the
   * path array already exists and has entries.
   */
  private saveEclairPathOnceIfMissing(detectedDir: string) {
    try {
      const envObj: any = readEnvYamlObject();
      if (!envObj.other) {
        envObj.other = {};
      }
      if (!envObj.other.EXTRA_TOOLS) {
        envObj.other.EXTRA_TOOLS = {};
      }
      const current = envObj.other.EXTRA_TOOLS.path;
      // If it's already a non-empty array with a valid first entry, do nothing
      if (Array.isArray(current) && current.length > 0 && current[0] && String(current[0]).trim() !== "") {
        return;
      }
      // If it's a string or an empty array, overwrite
      envObj.other.EXTRA_TOOLS.path = [normalizePath(detectedDir)];
      writeEnvYamlObject(envObj);
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
        if (lines[0] && fs.existsSync(lines[0])) {
          exePath = lines[0];
        }
      } else {
        const execSync = require("child_process").execSync;
        const out = execSync("which eclair", { encoding: "utf8" });
        const lines = out.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
        if (lines[0] && fs.existsSync(lines[0])) {
          exePath = lines[0];
        }
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
          post_message({ command: "set-path-status", message: "Probing ECLAIR..." });
          await this.probe_eclair();
        } finally {
          post_message({ command: "set-path-status", message: undefined });
        }
        // Restore saved SCA config whenever the panel becomes visible again
        await this.loadScaConfig();
      }
    }, null, this._disposables);

    if (!this._didInitialProbe) {
      this._didInitialProbe = true;
      try {
        post_message({ command: "set-path-status", message: "Probing ECLAIR..." });
        await this.probe_eclair();
      } finally {
        post_message({ command: "set-path-status", message: undefined });
      }
    }

    await this.loadScaConfig();
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
      })
      .with({ command: "open-external" }, ({ url }) => open_link(url))
      .with({ command: "refresh-status" }, async () => this.refresh_status())
      .with({ command: "rpc-request" }, async (req) => this._handleRpcRequest(req))
      .with({ command: "reload-sca-config" }, async () => this.loadScaConfig())
      .with({ command: "save-sca-config" }, async ({ config: cfg, workspace }) => {
        if (!workspace) {
          vscode.window.showErrorMessage("Cannot save ECLAIR config: workspace not provided.");
          return;
        }
        await this.saveScaConfig(cfg, workspace);
      })
      .with({ command: "run-command" }, async ({ config: cfg, workspace, build_config }) => {
        if (!workspace || !build_config) {
          vscode.window.showErrorMessage("Cannot run ECLAIR analysis: workspace/build configuration not provided.");
          return;
        }

        await this.saveScaConfig(cfg, workspace);

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

          const current_index = cfg.current_config_index ?? 0;
          if (!cfg.configs[current_index]) {
            throw new Error("Could not find configuration at index " + current_index);
          }

          const config = cfg.configs[current_index];

          const merged_env = await this._get_analysis_env(folderUri, build_dir, config);

          const common_ecl_options = [
            `-project_name=getenv("ZEPHYR_WORKBENCH_ECLAIR_PROJECT_NAME")`,
            `-project_root=getenv("ZEPHYR_WORKBENCH_PROJECT_ROOT_DIR")`,
          ];

          let cmd = await match(config.main_config)
            .with({ type: "preset" }, async (c) => {
              const repo_revs = await resolve_repo_revs(cfg.repos ?? {});

              let presets_eclair_options = unwrap_or_throw(await handle_sources(
                [...c.rulesets, ...c.variants, ...c.tailorings],
                (source) => this._presetRepos.load_preset_no_checkout(workspace, source, cfg.repos ?? {}, repo_revs)
              ));

              const eclair_options = [
                ...common_ecl_options,
                ...presets_eclair_options,
              ];

              const { user_ruleset_name, user_ruleset_path } = create_user_ruleset(eclair_options);

              return build_analysis_command(
                "USER",
                user_ruleset_name,
                user_ruleset_path,
                [],
                config.extra_config,
                config.reports,
                app_dir,
                build_dir,
                board,
              );
            })
            .with({ type: "custom-ecl" }, (c) => {
              const eclair_options = common_ecl_options;
              const { user_ruleset_name, user_ruleset_path } = create_user_ruleset(eclair_options);

              return build_analysis_command(
                c.ecl_path,
                user_ruleset_name,
                user_ruleset_path,
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
      .with({ command: "probe-eclair" }, () => this.probe_eclair())
      .with({ command: "start-report-server" }, async ({ workspace, build_config }) => {
        if (!workspace || !build_config) {
          vscode.window.showErrorMessage("Cannot start report server: workspace/build configuration not provided.");
          return;
        }
        await this.startReportServer(workspace, build_config);
      })
      .with({ command: "load-preset" }, async ({ source, repos, workspace }) => {
        const repo_revs = await resolve_repo_revs(repos);
        this._presetRepos.load_preset_no_checkout(workspace, source, repos, repo_revs);
      })
      .with({ command: "scan-repo" }, ({ name, origin, ref, rev, workspace }) => {
        // Immediately check out the repo and scan all .ecl files, sending
        // back preset-content messages so the webview picker is updated.
        this._presetRepos.scan_repo_presets(name, origin, ref, rev, workspace);
      })
      .with({ command: "update-repo-checkout" }, async ({ name, origin, ref, rev, workspace }) => {
        await this._presetRepos.update_repo_checkout(name, origin, ref, rev, workspace);
      })
      .exhaustive();
  }

  /**
   * Reads the saved SCA configuration from settings.json and sends it back to
   * the webview so the UI can restore its full state.  This is called both on
   * initial panel creation and whenever the panel becomes visible again.
   */
  private async loadScaConfig() {
    if (this._loading_sca_config) {
      return;
    }

    const post_message = (m: ExtensionMessage) => this._panel.webview.postMessage(m);
    post_message({ command: "config-loading", loading: true });

    this._loading_sca_config = true;

    try {
      await this.loadScaConfig_impl(post_message);
    } catch (err) {
      getOutputChannel().appendLine(`[EclairManagerPanel] Error in loadScaConfig: ${err instanceof Error ? err.message : String(err)}`);
    }

    post_message({ command: "config-loading", loading: false });
    this._loading_sca_config = false;
  }

  private async loadScaConfig_impl(post_message: (m: ExtensionMessage) => void) {
    const out = getOutputChannel();
    try {
      const configs_r = await load_all_sca_configs();
      if ("err" in configs_r) {
        throw new Error(configs_r.err);
      }
      const configs_m = configs_r.ok;
      const configs: Record<string, FullEclairScaConfig> = {};
      const build_configs_by_workspace: Record<string, BuildConfigInfo[]> = {};
      for (const [workspace, [cfg, build_configs]] of Object.entries(configs_m)) {
        configs[workspace] = cfg;
        if (build_configs.length > 0) {
          build_configs_by_workspace[workspace] = build_configs;
        }
      }
      post_message({ command: "set-sca-config", by_workspace: configs, build_configs_by_workspace });
      await preload_presets_from_configs(this._presetRepos, configs, post_message);
      out.appendLine(`[EclairManagerPanel] Loaded ${Object.keys(configs).length} SCA configs`);
    } catch (err) {
      out.appendLine(`[EclairManagerPanel] Error loading SCA config: ${err}`);
      console.error("[EclairManagerPanel] loadScaConfig error:", err);
    }
  }

  private async saveScaConfig(cfg: FullEclairScaConfig, workspace: string) {
    const folderUri = this.resolveApplicationFolderUri(workspace);
    if (!folderUri) {
      vscode.window.showErrorMessage(`Workspace '${workspace}' not found.`);
      return;
    }

    const settingsUri = getEclairManagerSettingsUri(folderUri);
    const settingsDirUri = vscode.Uri.joinPath(folderUri, ".vscode");
    const payload = deep_tokenize_paths(cfg, folderUri);
    await vscode.workspace.fs.createDirectory(settingsDirUri);
    const payload_utf8 = new TextEncoder().encode(JSON.stringify(payload, null, 2));
    await vscode.workspace.fs.writeFile(
      settingsUri,
      payload_utf8,
    );
  }

  /**
   * Probes the system for ECLAIR installation, gets version, and updates the UI accordingly.
   * If ECLAIR is found and not present in env.yml, adds it automatically.
   */
  private async probe_eclair() {
    // Force reload of env.yml. We use a watcher but just in case the watcher
    // misses it
    this._env.load();

    const ch = getOutputChannel();
    ch.appendLine("[ECLAIR Probe] Probing for ECLAIR installation...");

    const post_message = (m: ExtensionMessage) => this._panel.webview.postMessage(m);
    post_message({ command: "set-path-status", message: "Probing ECLAIR..." });

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
      ch.appendLine(`[ECLAIR Probe] Running command: ${cmd}`);
      const proc = await execCommandWithEnv(cmd);
      const outStd = await readStdout(proc);
      ch.appendLine(`[ECLAIR Probe] Command output: ${outStd}`);
      const lines = outStd.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      exePath = lines[0];
    } catch (err) {
      ch.appendLine(`[ECLAIR Probe] Error running command: ${err}`);
      exePath = undefined;
    }

    let version: string | undefined;
    try {
      const proc = await execCommandWithEnv(exePath ? `"${exePath}" -version` : "eclair -version");
      const out = await readStdout(proc);
      ch.appendLine(`[ECLAIR Probe] Version command output: ${out}`);
      const m1 = out.match(/ECLAIR\s+version\s+([0-9]+(?:\.[0-9]+)*)/i);
      const m2 = out.match(/\b([0-9]+(?:\.[0-9]+)*)\b/);
      version = (m1?.[1] || m2?.[1] || "").trim() || undefined;
    } catch (err) {
      ch.appendLine(`[ECLAIR Probe] Error getting version: ${err}`);
      version = undefined;
    }

    const installed = !!version;

    ch.appendLine(`[ECLAIR Probe] Installed: ${installed}`);

    // TODO enhance
    let eclairInfo = this.getEclairPathFromEnv();
    // ECLAIR is detected but not present in env.yml, add it automatically (minimal approach)
    if (
      installed &&
      exePath &&
      (!eclairInfo.path || eclairInfo.path.trim() === "")
    ) {
      ch.appendLine(`[ECLAIR Probe] ECLAIR detected at '${exePath}' but not set in env.yml, adding it now...`);
      const detectedDir = normalizePath(path.dirname(exePath));
      this.saveEclairPathOnceIfMissing(detectedDir);
      eclairInfo = this.getEclairPathFromEnv();
    }

    const eclairPath = (typeof eclairInfo === 'object' && typeof eclairInfo.path === 'string') ? eclairInfo.path : '';
    post_message({ command: 'set-install-path', path: eclairPath });
    post_message({ command: 'set-path-status', message: undefined });
    post_message({ command: 'eclair-status', installed, version: installed ? version! : 'unknown' });
    ch.appendLine(`[ECLAIR Probe] Final ECLAIR path: ${eclairPath}`);
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
<body>
<div id="eclair-manager-content"></div>
<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }

  async refresh_status() {
    try {
      await this.probe_eclair();
    } finally {
      this.post_message({ command: "set-path-status", message: undefined });
    }
    await this.loadScaConfig();
  }

  post_message(m: ExtensionMessage) {
    this._panel.webview.postMessage(m);
  }

  private async _handleRpcRequest(req: RpcRequestMessage) {
    const handler = this._rpcHandlers[req.method as keyof EclairRpcMethods];
    if (!handler) {
      this.post_message({
        command: "rpc-response",
        id: req.id,
        error: { message: `Unknown RPC method '${req.method}'` },
      });
      return;
    }
    try {
      const result = await handler(req.params);
      this.post_message({ command: "rpc-response", id: req.id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post_message({ command: "rpc-response", id: req.id, error: { message } });
    }
  }

  private async _rpcOpenDialog(params: OpenDialog["params"]): Promise<OpenDialog["result"]> {
    const options: vscode.OpenDialogOptions = {
      canSelectFiles: !!params?.canSelectFiles,
      canSelectFolders: !!params?.canSelectFolders,
      canSelectMany: !!params?.canSelectMany,
      title: typeof params?.title === "string" ? params.title : undefined,
    };

    if (!options.canSelectFiles && !options.canSelectFolders) {
      throw new Error("open-dialog requires canSelectFiles and/or canSelectFolders");
    }

    const defaultUri = this._parseUriParam(params?.defaultUri);
    if (defaultUri) {
      options.defaultUri = defaultUri;
    }

    const pick = await vscode.window.showOpenDialog(options);
    if (!pick || pick.length === 0) {
      return { canceled: true, paths: [] };
    }
    return { canceled: false, paths: pick.map((p) => p.fsPath) };
  }

  private _parseUriParam(value: any): vscode.Uri | undefined {
    if (typeof value !== "string" || value.trim() === "") {
      return undefined;
    }
    if (value.startsWith("file://")) {
      try {
        return vscode.Uri.parse(value);
      } catch {
        return undefined;
      }
    }
    return vscode.Uri.file(value);
  }

  private resolveApplicationFolderUri(workspace?: string): vscode.Uri | undefined {
    if (workspace && vscode.workspace.workspaceFolders) {
      const byUri = vscode.workspace.workspaceFolders.find((f) => f.uri.toString() === workspace);
      if (byUri) {
        return byUri.uri;
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

    // Resolve BOARD from the selected build configuration.
    const board = configs?.[idx]?.board?.toString()?.trim() || "";

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
    config: EclairScaConfig,
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
      if (typeof v === "string") {
        merged_env[k] = v;
      } else {
        merged_env[k] = "";
      }
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
      if (fs.existsSync(guess)) {
        zephyr_sdk_dir = guess;
      }
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

    merged_env.ZEPHYR_WORKBENCH_ECLAIR_PROJECT_NAME = `${path.basename(folderUri.fsPath)} (${config.name})`;
    merged_env.ZEPHYR_WORKBENCH_PROJECT_ROOT_DIR = folderUri.fsPath;

    return merged_env;
  }
}

function build_analysis_command(
    ruleset: string,
    user_ruleset_name: string | undefined,
    user_ruleset_path: string | undefined,
    eclair_env_additional_options: string[],
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
      ...cmake_extra_config_options(eclair_env_additional_options, extra_config?.trim()),
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
    if (name) {
      cmake_args.push(`-DECLAIR_USER_RULESET_NAME=\"${name}\"`);
    }
    if (p) {
      cmake_args.push(`-DECLAIR_USER_RULESET_PATH=\"${p}\"`);
    }
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
  eclair_env_additional_options: string[],
  extra_config: string | undefined,
) {
  // .ecl file needs a wrapper that uses -eval_file
  const wrapperPath = path.join(os.tmpdir(), "eclair_wrapper.cmake");

  let content = "";

  for (const opt of eclair_env_additional_options) {
    const escaped_opt = opt.replace(/"/g, '\\"');
    content += `list(APPEND ECLAIR_ENV_ADDITIONAL_OPTIONS "${escaped_opt}")\n`;
  }

  // TODO this is a bit hacky and may be outdated logic
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

function create_user_ruleset(
  eclair_options: string[],
  dir?: string,
  name?: string,
): { user_ruleset_name: string; user_ruleset_path: string } {
  const ruleset_path = dir || path.join(os.tmpdir(), "dummy_user_ruleset");
  const ruleset_name = name || "dummy";
  const ecl = path.join(ruleset_path, `analysis_${ruleset_name}.ecl`);

  if (fs.existsSync(ruleset_path)) {
    if (!fs.statSync(ruleset_path).isDirectory()) {
      fs.rmSync(ruleset_path);
      fs.mkdirSync(ruleset_path, { recursive: true });
    }
  } else {
    fs.mkdirSync(ruleset_path, { recursive: true });
  }

  fs.rmSync(ecl, { force: true, recursive: true });
  fs.writeFileSync(ecl, eclair_options.map(opt => `${opt}`).join("\n"), { encoding: "utf8" });

  return {
    user_ruleset_name: ruleset_name,
    user_ruleset_path: ruleset_path,
  };
}

async function handle_sources(
  sel: PresetSelectionState[],
  load_template: (s: EclairPresetTemplateSource) => Promise<Result<[EclairTemplate, string], string>>,
): Promise<Result<string[], string>> {
  let all_commands: string[] = [];
  for (const s of sel) {
    let r = await handle_source(s, load_template);
    if ("err" in r) {
      return { err: `Failed to load preset: ${r.err}` };
    }
    all_commands = all_commands.concat(r.ok);
  }
  return { ok: all_commands };
}

async function handle_source(
  sel: PresetSelectionState,
  load_template: (s: EclairPresetTemplateSource) => Promise<Result<[EclairTemplate, string], string>>,
): Promise<Result<string[], string>> {
  let r = await load_template(sel.source);
  if ("err" in r) {
    return { err: `Failed to load preset: ${r.err}` };
  }
  const [preset, path] = r.ok;
  let eclair_commands = format_option_settings(preset, sel.edited_flags || {}).map(s => s.statement);
  eclair_commands.push("-eval_file=\"" + path.replace(/\\/g, "/") + "\"");
  return { ok: eclair_commands };
}

async function load_applications(): Promise<ZephyrAppProject[]> {
  if (!vscode.workspace.workspaceFolders) {
    return [];
  }

  let applications: ZephyrAppProject[] = [];
  const project_folders = await ZephyrAppProject.getZephyrProjectWorkspaceFolders(vscode.workspace.workspaceFolders);
  for (const workspace_folder of project_folders) {
    try {
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
    if (!uri) {
      return false;
    }
    try {
      return fs.existsSync(path.join(uri.fsPath, "CMakeLists.txt"));
    } catch {
      return false;
    }
  };

  const find_app_by_uri = (uri: vscode.Uri | undefined) => {
    if (!uri) {
      return undefined;
    }
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
 * TODO: this is a blunt recursive string replacement, a more precise
 * approach would target known path fields explicitly.
 */
function deep_tokenize_paths(obj: any, folderUri: vscode.Uri): any {
  if (!folderUri) {
    return obj;
  }
  const wsPath = folderUri.fsPath.replace(/\\/g, "/");
  const walk = (val: any): any => {
    if (typeof val === "string") {
      const n = val.replace(/\\/g, "/");
      //if (n === wsPath || n.startsWith(wsPath + "/")) {
      //  return "${workspaceFolder}" + n.slice(wsPath.length);
      //}
      if (path.isAbsolute(n)) {
        const relative = path.relative(wsPath, n);
        return "${workspaceFolder}/" + relative.replace(/\\/g, "/");
      }
      return val;
    }
    if (Array.isArray(val)) {
      return val.map(walk);
    }
    if (val && typeof val === "object") {
      const out: any = {};
      for (const k of Object.keys(val)) {
        out[k] = walk(val[k]);
      }
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
function deep_resolve_paths(obj: any, folderUri: vscode.Uri): any {
  const fsPath = folderUri.fsPath;
  const walk = (val: any): any => {
    if (typeof val === "string") {
      return val.replace(/\$\{workspaceFolder\}/g, fsPath);
    }
    if (Array.isArray(val)) {
      return val.map(walk);
    }
    if (val && typeof val === "object") {
      const out: any = {};
      for (const k of Object.keys(val)) {
        out[k] = walk(val[k]);
      }
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
  if (!p || !p.includes("${workspaceFolder}")) {
    return p;
  }
  return p.replace(/\$\{workspaceFolder\}/g, folderUri.fsPath);
}

// Gets the west workspace path from settings.json configuration.
function getWestWorkspacePath(folderUri: vscode.Uri): string | undefined {
  const config = vscode.workspace.getConfiguration(undefined, folderUri);
  const westWorkspace = deep_resolve_paths(config.get<string>("zephyr-workbench.westWorkspace"), folderUri);
  
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
    if (c && fs.existsSync(c)) {
      return c;
    }
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

async function load_all_sca_configs(): Promise<Result<Record<string, [FullEclairScaConfig, BuildConfigInfo[]]>, string>> {
  try {
    const apps = await load_applications();

    const by_workspace: Record<string, [FullEclairScaConfig, BuildConfigInfo[]]> = {};
    for (const app of apps) {
      const sca_configs_r = await load_app_eclair_sca_config(app);
      if ("err" in sca_configs_r) {
        // TODO consider aggregating errors
        continue;
      }
      const sca_configs = sca_configs_r.ok;
      const workspace = app.workspaceFolder.uri.toString();
      const build_configs_r = load_project_build_configs(app);
      const build_configs = "err" in build_configs_r ? [] : build_configs_r.ok;
      const build_configs_info = build_configs.map(c => ({ name: c.name, board: c.board }));
      by_workspace[workspace] = [sca_configs, build_configs_info];
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
      repo: repo ? { origin: repo.origin, ref: repo.ref, rev: repo.rev } : undefined,
    });
  }
  return JSON.stringify(source);
}

function getEclairManagerSettingsUri(folderUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(folderUri, ".vscode", ECLAIR_MANAGER_SETTINGS_FILENAME);
}

async function readEclairManagerSettings(folderUri: vscode.Uri): Promise<any | undefined> {
  const settingsUri = getEclairManagerSettingsUri(folderUri);
  try {
    const raw = await vscode.workspace.fs.readFile(settingsUri);
    const text = Buffer.from(raw).toString("utf8");
    if (!text.trim()) {
      return {};
    }
    return JSON.parse(text);
  } catch (err: any) {
    if (err instanceof vscode.FileSystemError && err.code === "FileNotFound") {
      return undefined;
    }
    throw err;
  }
}

async function preload_presets_from_configs(
  _presetRepos: PresetRepositories,
  by_workspace: Record<string, FullEclairScaConfig>,
  post_message: (m: ExtensionMessage) => void,
): Promise<void> {
  // preload all presets from all repos
  for (const [workspace, cfg] of Object.entries(by_workspace)) {
    const repos = cfg.repos ?? {};
    for (const [repo_name, repo] of Object.entries(repos)) {
      await _presetRepos.scan_repo_presets(repo_name, repo.origin, repo.ref, repo.rev, workspace);
    }
  }

  // preload all system paths presets
  for (const [workspace, cfg] of Object.entries(by_workspace)) {
    for (const config of cfg.configs) {
      if (config.main_config.type !== "preset") {
        continue;
      }

      const { rulesets, variants, tailorings } = config.main_config;
      const all_presets = [...rulesets, ...variants, ...tailorings]
        .filter(p => p.source.type === "system-path");

      const repo_revs = await resolve_repo_revs(cfg.repos ?? {});

      for (const p of all_presets) {
        const _ = await _presetRepos.load_preset_no_checkout(workspace, p.source, {}, repo_revs);
      }
    }
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

async function load_app_eclair_sca_config(app: ZephyrAppProject): Promise<Result<FullEclairScaConfig, string>> {
  try {
    const folder_uri = app.workspaceFolder.uri;
    let raw_cfg = await readEclairManagerSettings(folder_uri);
    if (!raw_cfg) {
      return { ok: { configs: [], repos: default_eclair_repos() } };
    }
    const resolved_cfg = deep_resolve_paths(raw_cfg, app.workspaceFolder.uri);
    const parsed = FullEclairScaConfigSchema.safeParse(resolved_cfg);
    if (!parsed.success) {
      // TODO not to console but to the output channel, and ideally also surface in the UI so users know their config is not being loaded
      const out = getOutputChannel();
      out.appendLine(`Saved ECLAIR SCA config for app '${app.folderName}' failed validation and will be reset: ${parsed.error}`);
      return { ok: { configs: [], repos: default_eclair_repos() } };
    }
    const data = parsed.data;
    if (data.repos === undefined) {
      data.repos = default_eclair_repos();
    }
    return { ok: data };
  } catch (err: any) {
    const msg = err?.message || String(err);
    return { err: `Failed to load ECLAIR SCA config for app '${app.folderName}': ${msg}` };
  }
}


export function is_eclair_path(p: string) {
  const eclair_exe = process.platform === "win32" ? path.join(p, "eclair.exe") : path.join(p, "eclair");
  return fs.existsSync(eclair_exe) && fs.statSync(eclair_exe).isFile();
}

export async function resolve_repo_revs(repos: Record<string, { origin: string; ref: string; rev?: string }>): Promise<Record<string, string>> {
  const out = getOutputChannel();
  const repo_revs: Record<string, string> = {};
  for (const [repo, entry] of Object.entries(repos)) {
    const rev = entry.rev;
    if (rev) {
      repo_revs[repo] = rev;
      continue;
    }
    const resolved = await resolve_ref_to_rev(entry.origin, entry.ref);
    if (!resolved) {
      out.appendLine(`Failed to resolve ref '${entry.ref}' for repo '${repo}' at origin '${entry.origin}'. Please check your configuration.`);
      continue;
    }
    repo_revs[repo] = resolved;
  }
  return repo_revs;
}
