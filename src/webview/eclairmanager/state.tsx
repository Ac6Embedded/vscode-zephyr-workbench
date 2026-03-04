import React from "react";
import { BUGSENG_PRESETS_REPO_URL, EclairPresetTemplateSource, EclairRepos, EclairScaConfig, FullEclairScaConfig, PresetSelectionState } from "../../utils/eclair/config";
import { EclairTemplate, EclairTemplateKind } from "../../utils/eclair/template";
import { match } from "ts-pattern";
import { produce, WritableDraft } from "immer";
import { Monospace } from "./components/common_components";
import { BuildConfigInfo } from "../../utils/eclairEvent";

export const BUGSENG_REPO_LINK = <a href={BUGSENG_PRESETS_REPO_URL}><Monospace>BUGSENG/zephyr-workbench-eclair-presets</Monospace></a>;

export interface EclairState {
  status: StatusState;
  current_context?: {
    workspace: string;
    build_config?: string;
  };
  by_workspace: Record<string, EclairWorkspaceBuildState>;
  build_configs_by_workspace: Record<string, BuildConfigInfo[]>;
  loading: boolean;
}

export interface EclairWorkspaceBuildState {
  repos: EclairRepos;
  configs: EclairConfig[];
  current_config_index: number;
  repos_scan_state: Record<string, RepoScanState>;
  available_presets: AvailablePresetsState;
}

export interface EclairConfig {
  name: string;
  description_md: string;
  main_config: MainAnalysisConfigurationState;
  extra_config: string | undefined;
  reports: ReportsState;
}

export function default_eclair_state(): EclairState {
  return {
    status: {
      version: "Checking",
      installed: false,
      checking_path: undefined,
      install_path: "",
    },
    by_workspace: {},
    build_configs_by_workspace: {},
    loading: false,
  };
}

export interface StatusState {
  version: string;
  installed: boolean;
  checking_path: string | undefined;
  install_path: string;
}

export type MainAnalysisConfigurationState = {
  type: "preset",
  state: PresetsSelectionState,
} | {
  type: "custom-ecl",
  state: CustomEclState,
} | {
  type: "zephyr-ruleset",
  ruleset: ZephyrRulesetState,
};

export interface ZephyrRulesetState {
  selected: string;
  userRulesetName: string | undefined;
  userRulesetPath: string | undefined;
}

export function default_ruleset_state(): ZephyrRulesetState {
  return {
    selected: "ECLAIR_RULESET_FIRST_ANALYSIS",
    userRulesetName: undefined,
    userRulesetPath: undefined,
  };
}

export interface CustomEclState {
  ecl?: string;
}

export interface PresetsSelectionState {
  rulesets_state: MultiPresetSelectionState;
  variants_state: MultiPresetSelectionState;
  tailorings_state: MultiPresetSelectionState;
}

function default_presets_selection_state(): PresetsSelectionState {
  return {
    rulesets_state: { presets: [] },
    variants_state: { presets: [] },
    tailorings_state: { presets: [] },
  };
};

export interface AvailablePresetsState {
  /** Preset templates loaded from local filesystem paths. */
  by_path: Map<string, EclairTemplate | { loading: string } | { error: string }>;
  /**
   * Preset templates loaded from named repository entries.
   * Outer key: logical repo name (matches EclairScaConfig.repos key).
   * Inner key: file path relative to the repo root.
   */
  by_repo_and_path: Map<string, Map<string, EclairTemplate | { loading: string } | { error: string }>>;
}

export function get_preset_template_by_source(presets: AvailablePresetsState, source: EclairPresetTemplateSource): EclairTemplate | { loading: string } | { error: string } | undefined {
  return match(source)
    .with({ type: "system-path" }, ({ path }) => presets.by_path.get(path))
    .with({ type: "repo-path" }, ({ repo, path }) => presets.by_repo_and_path.get(repo)?.get(path))
    .exhaustive();
}

export interface MultiPresetSelectionState {
  presets: PresetSelectionState[];
}

export function preset_template_source_id(source: EclairPresetTemplateSource): string {
  // TODO consider using a canonical stringification instead or hashing
  return JSON.stringify(source);
}
export interface ReportsState {
  selected: string[];
}

/** Tracks the scan/load status of a single preset repository. */
export type RepoScanState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; checkoutDir?: string }
  | { status: "error"; message: string };


export type EclairStateAction =
  // Bulk actions
  | { type: "reset-to-defaults" }
  | { type: "load-sca-config"; by_workspace: Record<string, FullEclairScaConfig>, build_configs_by_workspace: Record<string, BuildConfigInfo[]> }
  | { type: "select-context"; workspace: string; build_config: string }
  // Toggle actions
  | { type: "select-configuration"; index: number }
  | { type: "with-selected-workspace"; workspace?: string; build_config?: string; action:
    | { type: "add-new-configuration"; name: string }
    | { type: "clone-configuration"; index: number }
    | { type: "delete-configuration"; index: number }
    | { type: "with-selected-configuration"; action:
       | { type: "update-configuration-name"; name: string }
       | { type: "update-configuration-description"; description_md: string }
       | { type: "update-configuration-type"; configurationType: MainAnalysisConfigurationState["type"] }
       | { type: "update-ruleset-selection"; ruleset: string }
       | { type: "update-user-ruleset-name"; name: string }
       | { type: "update-user-ruleset-path"; path: string }
       | { type: "update-custom-ecl-path"; path: string }
       | { type: "toggle-report"; report: string; checked: boolean }
       | { type: "update-extra-config-path"; path: string | undefined }
       | { type: "set-preset-option"; source: EclairPresetTemplateSource; option_id: string; value: boolean | string }
       | { type: "clear-preset-option"; source: EclairPresetTemplateSource; option_id: string }
       | { type: "remove-selected-preset"; kind: EclairTemplateKind; index: number }
       | { type: "set-or-add-preset"; kind: EclairTemplateKind; source: EclairPresetTemplateSource; }
    }
  }
  // Update actions
  | { type: "update-install-path"; path: string }
  | { type: "set-path-status"; message: string | undefined }
  // Message-based actions
  | { type: "set-eclair-status"; installed: boolean; version: string }
  | { type: "preset-content"; source: EclairPresetTemplateSource; template: EclairTemplate | { loading: string } | { error: string }; workspace?: string; build_config?: string }
  // Repo management actions
  | { type: "add-repo"; name: string; origin: string; ref: string; rev?: string }
  | { type: "remove-repo"; name: string }
  | { type: "update-repo"; name: string; origin: string; ref: string; rev?: string }
  // Repo scan status actions
  | { type: "repo-scan-started"; name: string; workspace?: string; build_config?: string }
  | { type: "repo-scan-done"; name: string; workspace?: string; build_config?: string; rev?: string; checkout_dir?: string }
  | { type: "repo-scan-failed"; name: string; message: string; workspace?: string; build_config?: string }
  | { type: "clear-repo-presets"; repo: string; workspace?: string; build_config?: string }
  | { type: "update-state", updater: (state: WritableDraft<EclairState>) => EclairState | undefined | void };

function build_configs(cfg: FullEclairScaConfig): EclairConfig[] {
  const build_config = (config: EclairScaConfig) => {
    const main_config: MainAnalysisConfigurationState = match(config.main_config)
      .with({ type: "zephyr-ruleset" }, (c) => ({
        type: "zephyr-ruleset" as const,
        ruleset: {
          selected: c.ruleset,
          userRulesetName: c.userRulesetName,
          userRulesetPath: c.userRulesetPath,
        },
      }))
      .with({ type: "custom-ecl" }, (c) => ({
        type: "custom-ecl" as const,
        state: { ecl: c.ecl_path },
      }))
      .with({ type: "preset" }, (c) => {
        const to_preset = (p: PresetSelectionState) => ({ source: p.source, edited_flags: p.edited_flags ? { ...p.edited_flags } : undefined });
        return {
          type: "preset" as const,
          state: {
            rulesets_state: { presets: c.rulesets.map(to_preset) },
            variants_state: { presets: c.variants.map(to_preset) },
            tailorings_state: { presets: c.tailorings.map(to_preset) },
          },
        };
      })
      .exhaustive();

    return {
      name: config.name,
      description_md: config.description_md ?? "",
      main_config,
      extra_config: config.extra_config ? config.extra_config : undefined,
      reports: { selected: config.reports && config.reports.length > 0 ? [...config.reports] : ["ALL"] },
    };
  };
  return cfg.configs.map(build_config);
}

function are_repos_equal(a: EclairRepos, b: EclairRepos | undefined): boolean {
  if (!b) {
    return false;
  }
  const a_keys = Object.keys(a);
  const b_keys = Object.keys(b);
  if (a_keys.length !== b_keys.length) {
    return false;
  }
  return a_keys.every((name) => {
    const entry_a = a[name];
    const entry_b = b[name];
    return !!entry_b
      && entry_a.origin === entry_b.origin
      && entry_a.ref === entry_b.ref
      && (entry_a.rev ?? "") === (entry_b.rev ?? "");
  });
}

function build_workspace_build_state(cfg: FullEclairScaConfig, prev?: EclairWorkspaceBuildState): EclairWorkspaceBuildState {
  const repos = cfg.repos ?? {};
  const configs = build_configs(cfg);
  const raw_index = cfg.current_config_index ?? prev?.current_config_index ?? 0;
  const current_config_index = configs.length > 0 ? Math.min(Math.max(raw_index, 0), configs.length - 1) : 0;
  const repos_scan_state: Record<string, RepoScanState> = {};
  for (const name of Object.keys(repos)) {
    const existing_entry = prev?.repos?.[name];
    const incoming = repos[name];
    if (existing_entry && existing_entry.origin === incoming.origin && existing_entry.ref === incoming.ref) {
      repos_scan_state[name] = prev?.repos_scan_state?.[name] ?? { status: "idle" };
    } else {
      repos_scan_state[name] = { status: "idle" };
    }
  }
  const available_presets = prev?.available_presets || { by_path: new Map(), by_repo_and_path: new Map() };

  return {
    repos,
    configs,
    current_config_index,
    repos_scan_state,
    available_presets,
  };
}

function get_selected_context(
  draft: WritableDraft<EclairState>,
  workspace?: string,
): { workspace: string; state: WritableDraft<EclairWorkspaceBuildState> } | undefined {
  const has_override = workspace !== undefined;
  const target_workspace = has_override ? workspace : draft.current_context?.workspace;

  if (!target_workspace) {
    console.error("No workspace selected");
    return;
  }

  const state = draft.by_workspace[target_workspace];
  if (!state) {
    console.error("Cannot find workspace", target_workspace);
    return;
  }
  return { workspace: target_workspace, state };
}

function clone_preset_selection(preset: PresetSelectionState): PresetSelectionState {
  return {
    source: { ...preset.source },
    edited_flags: { ...preset.edited_flags },
  };
}

function clone_multi_preset_state(state: MultiPresetSelectionState): MultiPresetSelectionState {
  return {
    presets: state.presets.map(clone_preset_selection),
  };
}

function clone_main_config(config: MainAnalysisConfigurationState): MainAnalysisConfigurationState {
  return match(config)
    .with({ type: "preset" }, ({ state }) => ({
      type: "preset" as const,
      state: {
        rulesets_state: clone_multi_preset_state(state.rulesets_state),
        variants_state: clone_multi_preset_state(state.variants_state),
        tailorings_state: clone_multi_preset_state(state.tailorings_state),
      },
    }))
    .with({ type: "custom-ecl" }, ({ state }) => ({
      type: "custom-ecl" as const,
      state: { ecl: state.ecl },
    }))
    .with({ type: "zephyr-ruleset" }, ({ ruleset }) => ({
      type: "zephyr-ruleset" as const,
      ruleset: {
        selected: ruleset.selected,
        userRulesetName: ruleset.userRulesetName,
        userRulesetPath: ruleset.userRulesetPath,
      },
    }))
    .exhaustive();
}

function clone_config(config: EclairConfig): EclairConfig {
  return {
    name: config.name,
    description_md: config.description_md,
    main_config: clone_main_config(config.main_config),
    extra_config: config.extra_config,
    reports: { selected: [...config.reports.selected] },
  };
}

function make_unique_clone_name(configs: EclairConfig[], original_name: string): string {
  const names = new Set(configs.map((config) => config.name));
  const base = original_name.trim() || "Config";
  const preferred = `${base} (Copy)`;
  if (!names.has(preferred)) {
    return preferred;
  }
  let index = 2;
  while (names.has(`${preferred} ${index}`)) {
    index += 1;
  }
  return `${preferred} ${index}`;
}

export function eclairReducer(state: EclairState, action: EclairStateAction): EclairState {
  return produce(state, draft => match(action)
    .with({ type: "reset-to-defaults" }, () => {
      const selected = get_selected_context(draft);
      if (!selected) {
        return default_eclair_state();
      }
      draft.by_workspace[selected.workspace] = build_workspace_build_state({
        configs: [],
      });
    })
    .with({ type: "load-sca-config" }, ({ by_workspace, build_configs_by_workspace }) => {
      const next: Record<string, EclairWorkspaceBuildState> = {};
      for (const [workspace, cfg] of Object.entries(by_workspace)) {
        const prev = state.by_workspace[workspace];
        next[workspace] = build_workspace_build_state(cfg, prev);
      }
      draft.by_workspace = next;
      draft.build_configs_by_workspace = build_configs_by_workspace;

      const current = draft.current_context;
      if (!current || !next[current.workspace]) {
        const first_workspace = Object.keys(next)[0];
        draft.current_context = first_workspace
          ? { workspace: first_workspace }
          : undefined;
      }
    })
    .with({ type: "select-context" }, ({ workspace, build_config }) => {
      if (!draft.by_workspace[workspace]) {
        console.error("Cannot select context: unknown workspace", workspace);
        return;
      }
      draft.current_context = { workspace, build_config };
    })
    .with({ type: "select-configuration" }, ({ index }) => {
      const selected = get_selected_context(draft);
      if (!selected) {
        return;
      }
      if (index < 0 || index >= selected.state.configs.length) {
        console.error("Cannot select configuration: index out of range", index);
        return;
      }
      selected.state.current_config_index = index;
    })
    .with({ type: "with-selected-workspace" }, ({ action, workspace, build_config }) => {
      const selected = get_selected_context(draft, workspace);
      if (!selected) {
        return;
      }
      const configs = selected.state.configs;
      match(action)
        .with({ type: "add-new-configuration" }, ({ name }) => {
          configs.push({
            name,
            description_md: "",
            main_config: { type: "zephyr-ruleset" as const, ruleset: default_ruleset_state() },
            extra_config: undefined,
            reports: { selected: ["ALL"] },
          });
          selected.state.current_config_index = configs.length - 1;
        })
        .with({ type: "clone-configuration" }, ({ index }) => {
          if (index < 0 || index >= configs.length) {
            console.error("Cannot clone configuration: index out of range", index);
            return;
          }
          const original = configs[index];
          const cloned = clone_config(original);
          cloned.name = make_unique_clone_name(configs, original.name);
          const insert_index = index + 1;
          configs.splice(insert_index, 0, cloned);
          selected.state.current_config_index = insert_index;
        })
        .with({ type: "delete-configuration" }, ({ index }) => {
          if (index < 0 || index >= configs.length) {
            console.error("Cannot delete configuration: index out of range", index);
            return;
          }

          configs.splice(index, 1);

          if (configs.length === 0) {
            selected.state.current_config_index = 0;
            return;
          }

          if (selected.state.current_config_index === index) {
            selected.state.current_config_index = Math.min(index, configs.length - 1);
          } else if (selected.state.current_config_index > index) {
            selected.state.current_config_index = selected.state.current_config_index - 1;
          }
        })
        .with({ type: "with-selected-configuration" }, ({ action }) => {
          const current = configs[selected.state.current_config_index];
          if (!current) {
            console.error("Cannot perform configuration-specific action: no current config");
            return;
          }
          match(action)
            .with({ type: "update-configuration-name" }, ({ name }) => {
              current.name = name;
            })
            .with({ type: "update-configuration-description" }, ({ description_md }) => {
              current.description_md = description_md;
            })
            .with({ type: "update-configuration-type" }, ({ configurationType }) => {
              if (current.main_config.type === configurationType) {
                return;
              }
              current.main_config = match(configurationType)
                .with("preset", () => ({ type: "preset" as const, state: default_presets_selection_state() }))
                .with("custom-ecl", () => ({ type: "custom-ecl" as const, state: {} }))
                .with("zephyr-ruleset", () => ({ type: "zephyr-ruleset" as const, ruleset: default_ruleset_state() }))
                .exhaustive();
            })
            .with({ type: "update-ruleset-selection" }, ({ ruleset: newRuleset }) => {
              if (current.main_config.type !== "zephyr-ruleset") {
                console.error("Cannot update ruleset selection: configuration is not zephyr-ruleset type");
                return;
              }
              current.main_config.ruleset.selected = newRuleset;
            })
            .with({ type: "update-user-ruleset-name" }, ({ name }) => {
              if (current.main_config.type !== "zephyr-ruleset") {
                console.error("Cannot update user ruleset name: configuration is not zephyr-ruleset type");
                return;
              }
              current.main_config.ruleset.userRulesetName = name;
            })
            .with({ type: "update-user-ruleset-path" }, ({ path }) => {
              if (current.main_config.type !== "zephyr-ruleset") {
                console.error("Cannot update user ruleset path: configuration is not zephyr-ruleset type");
                return;
              }
              current.main_config.ruleset.userRulesetPath = path;
            })
            .with({ type: "update-custom-ecl-path" }, ({ path }) => {
              if (current.main_config.type !== "custom-ecl") {
                console.error("Cannot update custom ECL path: configuration is not custom-ecl type");
                return;
              }
              current.main_config.state.ecl = path;
            })
            .with({ type: "toggle-report" }, ({ report, checked }) => {
              if (report === "ALL") {
                current.reports.selected = checked ? ["ALL"] : [];
              } else {
                current.reports.selected = current.reports.selected.filter(r => r !== "ALL");
                if (checked) {
                  current.reports.selected.push(report);
                } else {
                  current.reports.selected = current.reports.selected.filter(r => r !== report);
                }
              }
            })
            .with({ type: "update-extra-config-path" }, ({ path }) => {
              current.extra_config = path;
            })
            .with({ type: "set-preset-option" }, ({ source, option_id, value }) => {
              if (current.main_config.type !== "preset") {
                return;
              }
              const sourceId = preset_template_source_id(source);
              const update_preset = (preset: WritableDraft<PresetSelectionState>) => {
                if (preset_template_source_id(preset.source) !== sourceId) {
                  return;
                }
                if (!preset.edited_flags) {
                  preset.edited_flags = {};
                }
                preset.edited_flags[option_id] = value;
              };
              const s = current.main_config.state;
              s.rulesets_state.presets.forEach(update_preset);
              s.variants_state.presets.forEach(update_preset);
              s.tailorings_state.presets.forEach(update_preset);
            })
            .with({ type: "clear-preset-option" }, ({ source, option_id }) => {
              if (current.main_config.type !== "preset") {
                return;
              }
              const sourceId = preset_template_source_id(source);
              const update_preset = (preset: WritableDraft<PresetSelectionState>) => {
                if (preset_template_source_id(preset.source) !== sourceId) {
                  return;
                }
                if (preset.edited_flags) {
                  delete preset.edited_flags[option_id];
                }
                if (preset.edited_flags && Object.keys(preset.edited_flags).length === 0) {
                  delete preset.edited_flags;
                }
              };
              const s = current.main_config.state;
              s.rulesets_state.presets.forEach(update_preset);
              s.variants_state.presets.forEach(update_preset);
              s.tailorings_state.presets.forEach(update_preset);
            })
            .with({ type: "remove-selected-preset" }, ({ kind, index }) => {
              if (current.main_config.type !== "preset") {
                return;
              }
              const s = current.main_config.state;
              match(kind)
                .with("ruleset", () => s.rulesets_state.presets.splice(index, 1))
                .with("variant", () => s.variants_state.presets.splice(index, 1))
                .with("tailoring", () => s.tailorings_state.presets.splice(index, 1))
                .exhaustive();
            })
            .with({ type: "set-or-add-preset" }, ({ kind, source }) => {
              if (current.main_config.type !== "preset") {
                return;
              }
              const s = current.main_config.state;
              const new_preset = { source };
              match(kind)
                .with("ruleset", () => { s.rulesets_state.presets.push(new_preset); })
                .with("variant", () => { s.variants_state.presets.push(new_preset); })
                .with("tailoring", () => { s.tailorings_state.presets.push(new_preset); })
                .exhaustive();
            })
            .exhaustive();
        })
        .exhaustive();
    })
    .with({ type: "update-install-path" }, ({ path }) => {
      draft.status.install_path = path;
    })
    .with({ type: "set-path-status" }, ({ message }) => {
      draft.status.checking_path = message;
    })
    .with({ type: "set-eclair-status" }, ({ installed, version }) => {
      draft.status.installed = installed;
      draft.status.version = installed ? version.trim() || "Unknown" : "Unknown";
    })
    .with({ type: "preset-content" }, ({ source, template, workspace, build_config }) => {
      const selected = get_selected_context(draft, workspace);
      if (!selected) {
        return;
      }
      match(source)
        .with({ type: "system-path" }, ({ path }) => {
          selected.state.available_presets.by_path.set(path, template);
        })
        .with({ type: "repo-path" }, ({ repo, path }) => {
          let byPath = selected.state.available_presets.by_repo_and_path.get(repo);
          if (!byPath) {
            byPath = new Map();
            selected.state.available_presets.by_repo_and_path.set(repo, byPath);
          }
          byPath.set(path, template);
        })
        .exhaustive();
    })
    .with({ type: "add-repo" }, ({ name, origin, ref, rev }) => {
      const selected = get_selected_context(draft);
      if (!selected) {
        return;
      }
      selected.state.repos[name] = { origin, ref, ...(rev ? { rev } : {}) };
      // Reset scan state when a repo is added or its configuration changes.
      selected.state.repos_scan_state[name] = { status: "idle" };
    })
    .with({ type: "update-repo" }, ({ name, origin, ref, rev }) => {
      const selected = get_selected_context(draft);
      if (!selected) {
        return;
      }
      selected.state.repos[name] = { origin, ref, ...(rev ? { rev } : {}) };
      // Reset scan state when a repo's configuration changes.
      selected.state.repos_scan_state[name] = { status: "idle" };
    })
    .with({ type: "remove-repo" }, ({ name }) => {
      const selected = get_selected_context(draft);
      if (!selected) {
        return;
      }
      delete selected.state.repos[name];
      delete selected.state.repos_scan_state[name];
      // Also clear all preset-content entries for this repo.
      selected.state.available_presets.by_repo_and_path.delete(name);
    })
    .with({ type: "repo-scan-started" }, ({ name, workspace, build_config }) => {
      const selected = get_selected_context(draft, workspace);
      if (!selected) {
        return;
      }
      selected.state.repos_scan_state[name] = { status: "loading" };
    })
    .with({ type: "repo-scan-done" }, ({ name, workspace, build_config, rev, checkout_dir }) => {
      const selected = get_selected_context(draft, workspace );
      if (!selected) {
        return;
      }
      // Count successfully loaded templates for this repo.
      selected.state.repos_scan_state[name] = { status: "success", checkoutDir: checkout_dir };
      if (rev) {
        const entry = selected.state.repos[name];
        entry.rev = rev;
      }
    })
    .with({ type: "repo-scan-failed" }, ({ name, message, workspace, build_config }) => {
      const selected = get_selected_context(draft, workspace);
      if (!selected) {
        return;
      }
      selected.state.repos_scan_state[name] = { status: "error", message };
    })
    .with({ type: "clear-repo-presets" }, ({ repo, workspace }) => {
      const selected = get_selected_context(draft, workspace );
      if (!selected) { 
        return;
      }
      selected.state.available_presets.by_repo_and_path.delete(repo);
    })
    .with({ type: "update-state" }, ({ updater }) => updater(draft))
    .exhaustive());
}
