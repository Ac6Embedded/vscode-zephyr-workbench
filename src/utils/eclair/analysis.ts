// Everything an ECLAIR analysis run needs, shared by the ECLAIR Manager panel
// and the agent's analyze tool: finding ECLAIR without changing env.yml, the
// saved SCA configurations, the analysis environment and the `west build`
// command line, and the report server. Nothing here shows UI; the panel keeps
// its own messages.

import * as vscode from "vscode";
import fs, { accessSync, existsSync } from "fs";
import path from "path";
import os from "os";
import { getConfiguredWorkbenchPath, resolveConfiguredPath } from "../execUtils";
import { isGlobalSdkSettingValue } from "../utils";
import { resolveDefaultGlobalSdk } from "../zephyr/globalSdkService";
import { normalizePath } from "../env/envYamlUtils";
import { readEnvYamlObject } from "../env/envYamlFileUtils";
import { format_option_settings } from "./template_utils";
import {
  ALL_ECLAIR_REPORTS, EclairPresetTemplateSource, EclairRepos, EclairScaConfig, FullEclairScaConfig,
  FullEclairScaConfigSchema, PresetSelectionState, default_eclair_repos,
} from "./config";
import { EclairTemplate } from "./template";
import { Result, unwrap_or_throw } from "../typing_utils";
import { match } from "ts-pattern";
import type { ZephyrApplication } from "../../models/ZephyrApplication";

export const ECLAIR_MANAGER_SETTINGS_FILENAME = "zephyr-workbench.eclair.json";

// -- finding ECLAIR ----------------------------------------------------------

/** The file of an ECLAIR program in its install folder. */
export function eclairProgram(dir: string, name: "eclair" | "eclair_env" | "eclair_report"): string {
  return path.join(dir, process.platform === "win32" ? `${name}.exe` : name);
}

/** True when `p` is a folder holding the eclair executable. */
export function isEclairPath(p: string): boolean {
  const eclair_exe = eclairProgram(p, "eclair");
  return fs.existsSync(eclair_exe) && fs.statSync(eclair_exe).isFile();
}

/**
 * The eclair executable the system PATH finds, or undefined. A timeout, when
 * given, also keeps the lookup's own error output away.
 */
export function findEclairOnPath(timeoutMs?: number): string | undefined {
  try {
    const whichCmd = process.platform === "win32"
      ? 'powershell -NoProfile -Command "$c=Get-Command eclair -ErrorAction SilentlyContinue; if ($c) { $c.Source }"'
      : 'which eclair';
    const execSync = require("child_process").execSync;
    const out = execSync(whichCmd, timeoutMs === undefined
      ? { encoding: "utf8" }
      : { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] });
    const lines = out.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
    if (lines[0] && fs.existsSync(lines[0])) {
      return lines[0];
    }
  } catch { /* ignore */ }
  return undefined;
}

/**
 * The ECLAIR folder for PATH: the one env.yml records when it exists, else
 * the one the system PATH finds.
 */
export function detectEclairDir(envYmlPath: string | undefined, timeoutMs?: number): string | undefined {
  if (envYmlPath && fs.existsSync(envYmlPath)) {
    return envYmlPath;
  }
  const exe = findEclairOnPath(timeoutMs);
  return exe ? path.dirname(exe) : undefined;
}

export interface EclairProbe {
  /** The ECLAIR install folder, when ECLAIR was found. */
  dir?: string;
  /** Where it was found: env.yml (other.EXTRA_TOOLS.path) or the system PATH. */
  source?: "env_yml" | "path";
  /** eclair_env and eclair_report, which the Zephyr ECLAIR integration requires. */
  eclairEnv?: string;
  eclairReport?: string;
  /**
   * Whether env.yml already lists a tool path. When it does not, opening the
   * ECLAIR Manager records the ECLAIR folder there.
   */
  envYmlHasPath: boolean;
}

/** Find ECLAIR the way the ECLAIR Manager does, reading env.yml and never writing it. */
export function probeEclair(timeoutMs = 5000): EclairProbe {
  const env = readEnvYamlObject();
  const listed: unknown = env?.other?.EXTRA_TOOLS?.path;
  const paths = Array.isArray(listed) ? listed.map(entry => String(entry)) : [];
  const envYmlHasPath = paths.length > 0 && paths[0].trim() !== "";
  const recorded = paths.find(entry => entry.trim() !== "" && isEclairPath(entry));
  let dir: string | undefined;
  let source: EclairProbe["source"];
  if (recorded) {
    dir = normalizePath(recorded);
    source = "env_yml";
  } else {
    const exe = findEclairOnPath(timeoutMs);
    if (exe) {
      dir = path.dirname(exe);
      source = "path";
    }
  }
  const program = (name: "eclair_env" | "eclair_report") => {
    const file = dir ? eclairProgram(dir, name) : undefined;
    return file && fs.existsSync(file) ? file : undefined;
  };
  return { dir, source, eclairEnv: program("eclair_env"), eclairReport: program("eclair_report"), envYmlHasPath };
}

// -- saved configurations ------------------------------------------------------

export function eclairManagerSettingsUri(folderUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(folderUri, ".vscode", ECLAIR_MANAGER_SETTINGS_FILENAME);
}

export async function readEclairManagerSettings(folderUri: vscode.Uri): Promise<any | undefined> {
  const settingsUri = eclairManagerSettingsUri(folderUri);
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

// TODO: deepResolvePaths is a blunt recursive replacement, replace with targeted field handling.
/**
 * Recursively walks `obj` and expands `${workspaceFolder}` in every string
 * to the actual workspace folder path.
 */
export function deepResolvePaths(obj: any, folderUri: vscode.Uri): any {
  const fsPath = folderUri.fsPath;
  const walk = (val: any): any => {
    if (typeof val === "string") {
      return resolveConfiguredPath(val, folderUri) ?? val.replace(/\$\{workspaceFolder\}/g, fsPath);
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
 * The ECLAIR configurations saved for an application, with paths resolved.
 * A file that does not validate gives the defaults; `log` says why.
 */
export async function loadAppEclairScaConfig(
  app: ZephyrApplication,
  log: (line: string) => void,
): Promise<Result<FullEclairScaConfig, string>> {
  try {
    const folder_uri = app.appWorkspaceFolder.uri;
    let raw_cfg = await readEclairManagerSettings(folder_uri);
    if (!raw_cfg) {
      return { ok: { configs: [], repos: default_eclair_repos() } };
    }
    const resolved_cfg = deepResolvePaths(raw_cfg, app.appWorkspaceFolder.uri);
    const parsed = FullEclairScaConfigSchema.safeParse(resolved_cfg);
    if (!parsed.success) {
      // TODO not to console but to the output channel, and ideally also surface in the UI so users know their config is not being loaded
      log(`Saved ECLAIR SCA config for app '${app.appName}' failed validation and will be reset: ${parsed.error}`);
      return { ok: { configs: [], repos: default_eclair_repos() } };
    }
    const data = parsed.data;
    if (data.repos === undefined) {
      data.repos = default_eclair_repos();
    }
    return { ok: data };
  } catch (err: any) {
    const msg = err?.message || String(err);
    return { err: `Failed to load ECLAIR SCA config for app '${app.appName}': ${msg}` };
  }
}

// -- the build to analyse ------------------------------------------------------

/** The build an analysis runs for. */
export interface EclairTarget {
  /** The application source folder, `west build -s`. */
  appDir: string;
  /** `west build -d`. */
  buildDir: string;
  board: string;
  /** The west workspace, the working directory of the run. */
  westTopDir: string;
}

// Gets the west workspace path from settings.json configuration.
function getWestWorkspacePath(folderUri: vscode.Uri): string | undefined {
  const westWorkspace = getConfiguredWorkbenchPath('westWorkspace', folderUri);

  if (westWorkspace && fs.existsSync(westWorkspace)) {
    // Verify it has .west folder
    if (fs.existsSync(path.join(westWorkspace, ".west"))) {
      return westWorkspace;
    }
  }

  return undefined;
}

export function get_build_dir(configs: any, idx: number, appDir: string): string {
  return (
    configs[idx]?.build?.dir ||
      configs[idx]?.buildDir ||
      path.join(appDir, "build", configs[idx]?.name || "primary")
  );
}

export function get_build_config_index(configs: any[], build_config_name?: string): number {
  if (build_config_name) {
    const idx = configs.findIndex(c => c?.name === build_config_name);
    if (idx >= 0) {
      return idx;
    }
  }
  const activeIdx = configs.findIndex(c => c?.active === true || c?.active === "true");
  return activeIdx >= 0 ? activeIdx : 0;
}

export function find_build_config_index(configs: any[], build_config_name: string): number | undefined {
  const idx = configs.findIndex(c => c?.name === build_config_name);
  return idx >= 0 ? idx : undefined;
}

/** The build of a configuration as the settings of the folder `folderUri` describe it. */
export function prepareAnalysisFromSettings(folderUri: vscode.Uri, build_config: string) {
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

/**
 * The Zephyr SDK folder for the analysis environment, from an sdk setting
 * value, with the usual fallbacks.
 */
export function resolveEclairSdkDir(sdkFromSettings: string | undefined): string | undefined {
  // The 'global' sentinel is not a path: resolve it to the detected global SDK
  // (ECLAIR needs a concrete directory for its analysis environment).
  if (isGlobalSdkSettingValue(sdkFromSettings)) {
    return resolveDefaultGlobalSdk()?.rootUri.fsPath;
  }
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

/** Detects the Zephyr SDK installation directory from the sdk setting of a folder and common paths. */
export function detectZephyrSdkDir(folderUri: vscode.Uri): string | undefined {
  return resolveEclairSdkDir(getConfiguredWorkbenchPath('sdk', folderUri));
}

export interface EclairEnvInput {
  /** The folder the ECLAIR project is rooted at, ZEPHYR_WORKBENCH_PROJECT_ROOT_DIR. */
  projectRootDir: string;
  /** The SCA configuration name, part of the ECLAIR project name. */
  scaConfigName: string;
  buildDir: string;
  eclairDir?: string;
  sdkDir?: string;
}

/** The environment of an analysis run: this process's, with ECLAIR, the SDK and ccache off. */
export function buildEclairAnalysisEnv(input: EclairEnvInput): Record<string, string> {
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
  const eclairDir = input.eclairDir;
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
  let zephyr_sdk_dir = input.sdkDir;
  // If not found, try buildDir (in case SDK is in the project)
  if (!zephyr_sdk_dir && input.buildDir) {
    const guess = path.join(path.dirname(input.buildDir), "zephyr-sdk-0.17.4");
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

  merged_env.ZEPHYR_WORKBENCH_ECLAIR_PROJECT_NAME = `${path.basename(input.projectRootDir)} (${input.scaConfigName})`;
  merged_env.ZEPHYR_WORKBENCH_PROJECT_ROOT_DIR = input.projectRootDir;

  return merged_env;
}

// -- the command line ----------------------------------------------------------

/** How a run finds its preset templates. */
export interface EclairPresetSources {
  repos: EclairRepos;
  /** The revision of each repository to read presets from. */
  resolveRepoRevs(repos: EclairRepos): Promise<Record<string, string>>;
  loadPreset(source: EclairPresetTemplateSource, repoRevs: Record<string, string>): Promise<Result<[EclairTemplate, string], string>>;
}

/** A file an analysis command names, to write before the command runs. */
export interface EclairRunFile {
  path: string;
  content: string;
}

/**
 * The `west build` command line of an analysis with the SCA configuration
 * `config`. Writes the user ruleset and the CMake options file it names into
 * `tmpDir`, the system temporary folder when omitted.
 */
export async function eclairAnalysisCommand(
  config: EclairScaConfig,
  target: Pick<EclairTarget, "appDir" | "buildDir" | "board">,
  presets: EclairPresetSources,
  tmpDir?: string,
): Promise<string> {
  const { command, files } = await eclairAnalysisPlan(config, target, presets, tmpDir);
  writeEclairRunFiles(files);
  return command;
}

/**
 * The command line eclairAnalysisCommand returns, and the files it names in
 * `tmpDir` with their content, without writing them.
 */
export async function eclairAnalysisPlan(
  config: EclairScaConfig,
  target: Pick<EclairTarget, "appDir" | "buildDir" | "board">,
  presets: EclairPresetSources,
  tmpDir?: string,
): Promise<{ command: string; files: EclairRunFile[] }> {
  const files: EclairRunFile[] = [];
  const common_ecl_options = [
    `-project_name=getenv("ZEPHYR_WORKBENCH_ECLAIR_PROJECT_NAME")`,
    `-project_root=getenv("ZEPHYR_WORKBENCH_PROJECT_ROOT_DIR")`,
  ];
  const rulesetDir = tmpDir ? path.join(tmpDir, "dummy_user_ruleset") : undefined;

  const command = await match(config.main_config)
    .with({ type: "preset" }, async (c) => {
      const repo_revs = await presets.resolveRepoRevs(presets.repos);

      let presets_eclair_options = unwrap_or_throw(await handle_sources(
        [...c.rulesets, ...c.variants, ...c.tailorings],
        (source) => presets.loadPreset(source, repo_revs)
      ));

      const eclair_options = [
        ...common_ecl_options,
        ...presets_eclair_options,
      ];

      const { user_ruleset_name, user_ruleset_path } = create_user_ruleset(eclair_options, files, rulesetDir);

      return build_analysis_command(
        "USER",
        user_ruleset_name,
        user_ruleset_path,
        [],
        config.extra_config,
        config.reports,
        target.appDir,
        target.buildDir,
        target.board,
        tmpDir,
        files,
      );
    })
    .with({ type: "custom-ecl" }, async (c) => {
      const eclair_options = common_ecl_options;
      const { user_ruleset_name, user_ruleset_path } = create_user_ruleset(eclair_options, files, rulesetDir);

      return build_analysis_command(
        c.ecl_path,
        user_ruleset_name,
        user_ruleset_path,
        [`-eval_file=${c.ecl_path.replace(/\\/g, "/")}`],
        config.extra_config,
        config.reports,
        target.appDir,
        target.buildDir,
        target.board,
        tmpDir,
        files,
      );
    })
    .with({ type: "zephyr-ruleset" }, async (c) => {
      return build_analysis_command(
        c.ruleset,
        c.userRulesetName,
        c.userRulesetPath,
        [],
        config.extra_config,
        config.reports,
        target.appDir,
        target.buildDir,
        target.board,
        tmpDir,
        files,
      );
    })
    .exhaustive();
  return { command, files };
}

/** Write the files of an analysis, replacing whatever is in their way. */
export function writeEclairRunFiles(files: readonly EclairRunFile[]): void {
  for (const file of files) {
    const dir = path.dirname(file.path);
    if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) {
      fs.rmSync(dir);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(file.path, { force: true, recursive: true });
    fs.writeFileSync(file.path, file.content, { encoding: "utf8" });
  }
}

export interface EclairRunPlan {
  command: string;
  env: Record<string, string>;
  /** The working directory, the west workspace. */
  cwd: string;
  /** The files `command` names, which writeEclairRunFiles writes before it runs. */
  files: EclairRunFile[];
}

/**
 * The command, environment and working directory of an analysis of `target`,
 * and the files the command names in `tmpDir`. Writes nothing, so the caller
 * writes the files only once nothing can stop the run any more.
 */
export async function prepareEclairRun(input: {
  config: EclairScaConfig;
  target: EclairTarget;
  projectRootDir: string;
  eclairDir?: string;
  sdkDir?: string;
  presets: EclairPresetSources;
  tmpDir?: string;
}): Promise<EclairRunPlan> {
  const env = buildEclairAnalysisEnv({
    projectRootDir: input.projectRootDir,
    scaConfigName: input.config.name,
    buildDir: input.target.buildDir,
    eclairDir: input.eclairDir,
    sdkDir: input.sdkDir,
  });
  const { command, files } = await eclairAnalysisPlan(input.config, input.target, input.presets, input.tmpDir);
  return { command, env, cwd: input.target.westTopDir, files };
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
    tmpDir: string | undefined,
    files: EclairRunFile[],
  ): string {

    const cmake_args: string[] = [
      "-DZEPHYR_SCA_VARIANT=eclair",
      ...cmake_compiler_launcher_options(),
      ...cmake_ruleset_selection_options(ruleset, user_ruleset_name, user_ruleset_path),
      ...cmake_extra_config_options(eclair_env_additional_options, extra_config?.trim(), tmpDir, files),
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
  tmpDir: string | undefined,
  files: EclairRunFile[],
) {
  // .ecl file needs a wrapper that uses -eval_file
  const wrapperPath = path.join(tmpDir ?? os.tmpdir(), "eclair_wrapper.cmake");

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

  files.push({ path: wrapperPath, content });
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
  files: EclairRunFile[],
  dir?: string,
  name?: string,
): { user_ruleset_name: string; user_ruleset_path: string } {
  const ruleset_path = dir || path.join(os.tmpdir(), "dummy_user_ruleset");
  const ruleset_name = name || "dummy";
  const ecl = path.join(ruleset_path, `analysis_${ruleset_name}.ecl`);

  files.push({ path: ecl, content: eclair_options.map(opt => `${opt}`).join("\n") });

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

// -- results and the report server ---------------------------------------------

/** The ECLAIR output folder of a build. */
export function eclairOutputDir(buildDir: string): string {
  return path.join(buildDir, "sca", "eclair");
}

/** The ECLAIR database (PROJECT.ecd) of a build, when an analysis wrote one. */
export function findEclairDatabaseIn(buildDir: string): string | undefined {
  const ecdPath = path.join(eclairOutputDir(buildDir), "PROJECT.ecd");
  return fs.existsSync(ecdPath) ? ecdPath : undefined;
}

/** The command that serves the reports of `dbPath` and opens them in the browser. */
export function eclairReportServerCommand(eclairDir: string | undefined, dbPath: string): string {
  const eclairReportCmd = eclairDir
    ? eclairProgram(eclairDir, "eclair_report")
    : "eclair_report";
  return `"${eclairReportCmd}" -db="${dbPath}" -browser -server=restart`;
}

/** Start `cmd` in a terminal of its own, shown to the user. */
export function openEclairReportServerTerminal(cmd: string): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name: "ECLAIR Report Server",
    hideFromUser: false
  });
  terminal.sendText(cmd);
  terminal.show();
  return terminal;
}

// Minimal copy of the external ECLAIR extension API we use.
interface IEclairExtension {
  enable(): void;
  disable(): void;
}

/**
 * Activate and enable the ECLAIR VS Code extension, when it is installed, so
 * it shows the served reports. `log` gets each step; an activation error is
 * thrown for the caller to report.
 */
export async function enableEclairExtension(log: (line: string) => void): Promise<"missing" | "outdated" | "enabled"> {
  const eclairExt = vscode.extensions.getExtension<IEclairExtension>('bugseng.eclair');
  if (!eclairExt) {
    log("ECLAIR extension not found.");
    return "missing";
  }

  if (!eclairExt.isActive) {
    log("Activating ECLAIR extension...");
    await eclairExt.activate();
    log("ECLAIR extension activated.");
  }

  if (!eclairExt.exports || typeof eclairExt.exports.enable !== 'function') {
    log("ECLAIR extension enable function not found.");
    return "outdated";
  }

  log("Enabling ECLAIR extension...");
  eclairExt.exports.enable();
  log("ECLAIR extension enabled.");
  return "enabled";
}
