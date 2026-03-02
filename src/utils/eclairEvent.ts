import { EclairPresetTemplateSource, EclairRepos, FullEclairScaConfig } from "./eclair/config";
import { EclairTemplate, EclairTemplateKind } from "./eclair/template";


// Commands sent FROM extension backend TO webview frontend
export type ExtensionMessage = {
  command: "toggle-spinner",
  show: boolean,
} | {
  command: "eclair-status",
  installed: boolean,
  version: string,
} | {
  command: "set-install-path",
  path: string,
} | {
  command: "set-extra-config",
  path: string,
  workspace: string,
} | {
  command: "set-path-status",
  text: string,
} | {
  command: "set-install-path-placeholder",
  text: string,
} | {
  command: "set-user-ruleset-name",
  name: string,
} | {
  command: "set-user-ruleset-path",
  path: string,
  workspace: string,
} | {
  command: "set-custom-ecl-path",
  path: string,
  workspace: string,
} | {
  command: "preset-content",
  source: EclairPresetTemplateSource,
  template: EclairTemplate | { loading: string } | { error: string },
  workspace: string,
} | {
  command: "template-path-picked",
  kind: EclairTemplateKind,
  path: string,
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
};

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
  command: "browse-path",
} | {
  command: "browse-extra-config",
  workspace: string,
} | {
  command: "browse-user-ruleset-path",
  workspace: string,
} | {
  command: "browse-custom-ecl-path",
  workspace: string,
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
  command: "about-eclair",
} | {
  command: "manage-license",
} | {
  command: "request-trial",
} | {
  command: "load-preset",
  source: EclairPresetTemplateSource,
  repos: EclairRepos,
  workspace: string,
} | {
  command: "pick-preset-path",
  kind: EclairTemplateKind,
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
  delete_rev?: string,
};

export type BuildConfigInfo = {
  name: string;
  board: string;
};
