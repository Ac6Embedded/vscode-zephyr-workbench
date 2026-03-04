import { EclairPresetTemplateSource, EclairRepos, FullEclairScaConfig } from "./eclair/config";
import { EclairTemplate, EclairTemplateKind } from "./eclair/template";


// Commands sent FROM extension backend TO webview frontend
export type ExtensionMessage = {
  command: "eclair-status",
  installed: boolean,
  version: string,
} | {
  command: "set-install-path",
  path: string,
} | {
  command: "set-path-status",
  message: string | undefined,
} | {
  command: "clear-repo-presets",
  workspace: string,
  repo: string,
} | {
  command: "preset-content",
  source: EclairPresetTemplateSource,
  template: EclairTemplate | { loading: string } | { error: string },
  workspace: string,
} | {
  command: "config-loading",
  loading: boolean,
} | {
  // Restore the full saved SCA configuration into the webview
  command: "set-sca-config",
  by_workspace: Record<string, FullEclairScaConfig>,
  build_configs_by_workspace: Record<string, BuildConfigInfo[]>,
} | {
  /** Sent when the backend begins scanning a repository for preset templates. */
  command: "repo-scan-done",
  name: string,
  workspace: string,
  rev?: string,
  checkout_dir?: string,
} | {
  /** Sent when an entire repository scan fails (e.g. checkout error). */
  command: "repo-scan-failed",
  name: string,
  message: string,
  workspace: string,
} | RpcResponseMessage;

// Commands sent FROM webview frontend TO extension backend
export type WebviewMessage = {
  command: "refresh-status",
} | {
  command: "reload-sca-config",
} | {
  command: "probe-eclair",
} | {
  command: "update-path",
  newPath: string,
} | {
  command: "save-sca-config",
  config: FullEclairScaConfig,
  workspace: string,
} | {
  command: "run-command",
  config: FullEclairScaConfig,
  workspace: string,
  build_config: string,
} | {
  command: "start-report-server",
  workspace: string,
  build_config: string,
} | {
  command: "open-external",
  url: string,
} | {
  command: "load-preset",
  source: EclairPresetTemplateSource,
  repos: EclairRepos,
  workspace: string,
} | {
  /**
   * Ask the backend to check out a named repository and scan it for preset
   * templates, sending back `preset-content` messages for each discovered
   * template.  Used when a new repo is added in the UI so the preset picker
   * is populated immediately without requiring a full reload.
   */
  command: "scan-repo",
  name: string,
  origin: string,
  ref: string,
  workspace: string,
  rev?: string,
} | {
  command: "update-repo-checkout",
  name: string,
  origin: string,
  ref: string,
  workspace: string,
  rev?: string,
} | RpcRequestMessage;

export type RpcError = {
  message: string;
  code?: string;
  data?: any;
};

export type RpcRequestMessage = {
  command: "rpc-request";
  id: string;
  method: string;
  params?: any;
};

export type RpcResponseMessage = {
  command: "rpc-response";
  id: string;
  result?: any;
  error?: RpcError;
};

export type BuildConfigInfo = {
  name: string;
  board: string;
};
