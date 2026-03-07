import React, { useState, useEffect, useCallback, useReducer, useMemo } from "react";
import { createRoot } from "react-dom/client";
import type { ExtensionMessage, WebviewMessage } from "../../utils/eclairEvent";
import { MainAnalysisConfigurationState, EclairStateAction, PresetsSelectionState, default_eclair_state, eclairReducer, EclairConfig, EclairWorkspaceBuildState, EclairState } from "./state";
import { Summary } from "./components/summary";
import { ReportsSection } from "./components/reports_section";
import { ExtraConfigSection } from "./components/extra_config_section";
import { CommandSection } from "./components/command_section";
import { ReportViewerSection } from "./components/report_viewer";
import { MainAnalysisConfigurationSection } from "./components/main_configuration";
import { match } from "ts-pattern";
import { FullEclairScaConfig, EclairScaMainConfig, EclairScaPresetConfig, EclairScaConfig } from "../../utils/eclair/config";
import { Result } from "../../utils/typing_utils";
import { EditableTextField, RichHelpTooltip, SearchableDropdown, Spinner, VscodeButton } from "./components/common_components";
import { EasyMark } from "./components/easymark_render";
import { RpcClient, RpcProvider } from "./rpc";
import type { EclairRpcMethods } from "../../utils/eclairRpcTypes";
import {
  BUGSENG_ECLAIR_OVERVIEW_URL,
  ECLAIR_MANAGER_DOC_URL,
  ZEPHYR_ECLAIR_CONFIG_URL,
  ZEPHYR_ECLAIR_PREREQUISITES_URL,
  ZEPHYR_ECLAIR_RUNNING_URL,
} from "./docs";

function workspace_label(workspace: string): string {
  const parts = workspace.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : workspace;
}

export function EclairManagerPanel() {
  const [api] = useState(() => acquireVsCodeApi());
  const [state, dispatch_state] = useReducer(eclairReducer, default_eclair_state());

  const post_message = useCallback((message: WebviewMessage) => {
    api.postMessage(message);
  }, [api]);

  const [rpc] = useState(() => new RpcClient<EclairRpcMethods>(post_message, { timeoutMs: 15000 }));

  // setup message handler
  useEffect(() => {
    const handle_message = (message: MessageEvent) => handleMessage(dispatch_state, message, rpc);
    window.addEventListener("message", handle_message);
    return () => window.removeEventListener("message", handle_message);
  }, [api, rpc]);

  useEffect(() => () => rpc.dispose(), [rpc]);

  // Trigger initial status refresh on mount
  useEffect(() => {
    try {
      post_message({ command: "refresh-status" });
    } catch (e) {
      console.error("Failed to post message to VSCode extension backend:", e);
    }
  }, [post_message]);

  const current_context = state.current_context;
  const build_config = current_context?.build_config;
  const workspace = current_context?.workspace;
  const current_context_state = workspace ? state.by_workspace[workspace] : undefined;

  const workspace_items = useMemo(
    () => Object.keys(state.by_workspace).map((key) => ({
      id: key,
      name: workspace_label(key),
      description: key,
      value: key,
    })),
    [state.by_workspace],
  );
  const current_workspace_item = workspace_items.find((item) => item.value === workspace);

  const build_config_items = useMemo(
    () => {
      const build_configs = state.build_configs_by_workspace[workspace || ""] || [];
      return build_configs.map((config) => ({ id: config.name, name: config.name, description: config.board, value: config }));
    },
    [state.build_configs_by_workspace, workspace],
  );
  const current_build_config_item = build_config_items.find((item) => item.value.name === build_config);

  return (<RpcProvider client={rpc}>
    <div>
      <h1>
        ECLAIR Manager <RichHelpTooltip>
          <p>
            Bugseng <a href={BUGSENG_ECLAIR_OVERVIEW_URL}>ECLAIR</a> is a certified static analysis tool and platform for software verification for use in safety- and security-critical development.
          </p>
          <p>
            This panel offers a configuration interface for use with Zephyr projects, allowing you to select build configurations, choose analysis rulesets and presets, and generate reports for your code reviews.
          </p>
          <p>
            Read more:
          </p>
          <ul>
            <li><a href={ECLAIR_MANAGER_DOC_URL}>ECLAIR Manager docs</a></li>
            <li><a href={ZEPHYR_ECLAIR_CONFIG_URL}>Zephyr ECLAIR configuration</a></li>
            <li><a href={ZEPHYR_ECLAIR_PREREQUISITES_URL}>Prerequisites</a></li>
            <li><a href={ZEPHYR_ECLAIR_RUNNING_URL}>Running ECLAIR</a></li>
          </ul>
        </RichHelpTooltip> {state.loading && (<Spinner />)}
      </h1>
      <a className="help-link" href={ECLAIR_MANAGER_DOC_URL}>Read Docs</a>
      <p className="panel-lead">
        Static analysis for Zephyr projects with ECLAIR.<br/>
        Select a workspace and build configuration, choose rulesets or presets, and generate the reports you need for reviews and compliance.
      </p>

      <Summary
        status={state.status}
        post_message={post_message}
        dispatch_state={dispatch_state}
      />

      <fieldset style={{ width: "100%", boxSizing: "border-box" }}>
        <legend>
          Context
          <RichHelpTooltip>
            Choose the application and build configuration to analyze.
          </RichHelpTooltip>
        </legend>
        <div style={{ display: "flex", alignItems: "end", gap: "10px", flexWrap: "wrap" }}>
          <SearchableDropdown
            id="workspace-selector"
            label="Select the application to analyze:"
            style={{ width: "300px" }}
            placeholder="Select workspace"
            items={workspace_items}
            selectedItem={current_workspace_item || null}
            onSelectItem={(item) => {
              const next_workspace = item.value;
              const build_configs = state.build_configs_by_workspace[next_workspace] ?? [];
              const next_build_config = build_configs[0]?.name;
              if (!next_build_config) {
                console.warn("No build configurations available for workspace", next_workspace);
                return;
              }
              dispatch_state({ type: "select-context", workspace: next_workspace, build_config: next_build_config });
            }}
          />
          {workspace && (<SearchableDropdown
            id="build-config-selector"
            label="Select the build configuration to use:"
            style={{ width: "300px" }}
            placeholder="Select build config"
            items={build_config_items}
            selectedItem={current_build_config_item || null}
            onSelectItem={(item) => dispatch_state({ type: "select-context", workspace, build_config: item.value.name })}
          />)}
        </div>
      </fieldset>

      {current_context_state && workspace && (<EclairManagerWithConfigs
        workspace={workspace}
        build_config={build_config}
        by_workspace={state.by_workspace}
        context_state={current_context_state}
        dispatch_state={dispatch_state}
        post_message={post_message}
        state={state}
      />)}
    </div>
  </RpcProvider>);
}

function EclairManagerWithConfigs({
  workspace,
  build_config,
  by_workspace,
  context_state,
  dispatch_state,
  post_message,
  state,
}: {
  workspace: string;
  build_config?: string;
  by_workspace: Record<string, EclairWorkspaceBuildState>;
  context_state: EclairWorkspaceBuildState;
  dispatch_state: React.Dispatch<EclairStateAction>;
  post_message: (message: WebviewMessage) => void;
  state: EclairState;
}) {
  const configs = context_state.configs;
  const current: EclairConfig | undefined = configs[context_state.current_config_index];
  const [collected_config, set_collected_config] = useState<Result<FullEclairScaConfig, string>>({ err: "Not configured" });
  const [collected_config_to_save, set_collected_config_to_save] = useState<Result<FullEclairScaConfig, string>>({ err: "Not configured" });

  const config_items = useMemo(() => configs.map((config, index) => ({ id: index, name: config.name, description: "", index })), [configs]);
  const current_config_item = config_items[context_state.current_config_index];

  // Collect config for sending to backend
  useEffect(() => {
    try {
      const config = collect_config_from_state(true, context_state);
      set_collected_config({ ok: config });
    } catch (e) {
      set_collected_config({ err: e instanceof Error ? e.message : String(e) });
    }
    try {
      const config = collect_config_from_state(false, context_state);
      set_collected_config_to_save({ ok: config });
    } catch (e) {
      set_collected_config_to_save({ err: e instanceof Error ? e.message : String(e) });
    }
  }, [context_state]);

  return (<>
    <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "10px", marginBottom: "10px", flexWrap: "wrap" }}>
      Configuration:
      <SearchableDropdown
        id="configuration-selector"
        label=""
        placeholder="Select configuration"
        items={config_items}
        selectedItem={current_config_item || null}
        onSelectItem={(item) => dispatch_state({ type: "select-configuration", index: item.index })}
      />
      <VscodeButton
        appearance="primary"
        title="Create new configuration"
        onClick={() => {
          dispatch_state({
            type: "with-selected-workspace",
            action: { type: "add-new-configuration", name: `Config ${configs.length + 1}` },
          });
        }}
      >
        <span className="codicon codicon-add" />
      </VscodeButton>
      {current && (
        <VscodeButton
          appearance="secondary"
          title="Clone configuration"
          onClick={() => {
            dispatch_state({
              type: "with-selected-workspace",
              action: { type: "clone-configuration", index: context_state.current_config_index },
            });
          }}
        >
          <span className="codicon codicon-copy" />
        </VscodeButton>
      )}
      {current && (
        <VscodeButton
          appearance="secondary"
          title="Delete configuration"
          onClick={() => {
            dispatch_state({
              type: "with-selected-workspace",
              action: { type: "delete-configuration", index: context_state.current_config_index },
            });
          }}
        >
          <span className="codicon codicon-trash" />
        </VscodeButton>
      )}
      <VscodeButton
        appearance="secondary"
        title="Discard unsaved changes and reload from settings.json"
        onClick={() => post_message({ command: "reload-sca-config" })}
      >
        <span className="codicon codicon-refresh" />
      </VscodeButton>
      <VscodeButton
        appearance="primary"
        title="Save configuration"
        disabled={"err" in collected_config_to_save}
        onClick={() => {
          if ("err" in collected_config_to_save) {
            console.error("Cannot apply configuration due to error:", collected_config_to_save.err);
            return;
          }
          post_message({ command: "save-sca-config", config: collected_config_to_save.ok, workspace });
        }}
      >
        <span className="codicon codicon-save" />
      </VscodeButton>
    </div>

    {current && (<>
      <fieldset style={{ width: "100%", boxSizing: "border-box" }}>
        <legend>Configuration Details</legend>
        <EditableTextField
          name="Name"
          value={current.name}
          placeholder="Configuration name"
          style={{ margin: "0", maxWidth: "10em", flexShrink: 1 }}
          on_selected={(new_name) => {
            const trimmed = new_name.trim();
            if (!trimmed || trimmed === current.name) {
              return;
            }
            dispatch_state({
              type: "with-selected-workspace",
              action: {
                type: "with-selected-configuration",
                action: { type: "update-configuration-name", name: trimmed },
              },
            });
          }}
        />
        <EditableConfigDescription
          value={current.description_md}
          onSave={(description_md) => dispatch_state({
            type: "with-selected-workspace",
            action: {
              type: "with-selected-configuration",
              action: { type: "update-configuration-description", description_md },
            },
          })}
        />
      </fieldset>

      <MainAnalysisConfigurationSection
        config_index={context_state.current_config_index}
        workspace={workspace}
        available_presets={context_state.available_presets}
        repos={context_state.repos}
        repos_scan_state={context_state.repos_scan_state}
        current={current}
        dispatch_state={dispatch_state}
        post_message={post_message}
      />

      <ReportsSection
        reports={current.reports}
        dispatch_state={dispatch_state}
      />

      <ExtraConfigSection
        extra_config={current.extra_config}
        dispatch_state={dispatch_state}
      />
    </>)}

    <CommandSection
      post_message={post_message}
      config={collected_config}
      workspace={workspace}
      build_config={build_config}
      dispatch_state={dispatch_state}
    />

    <ReportViewerSection
      workspace={workspace}
      build_config={build_config}
      post_message={post_message}
    />
  </>);
}


function handleMessage(
  dispatch: React.Dispatch<EclairStateAction>,
  event: MessageEvent,
  rpc: RpcClient
) {
  const msg: ExtensionMessage = event.data;

  match(msg)
    .with({ command: "rpc-response" }, (message) => rpc.handleMessage(message))
    .with({ command: "eclair-status" }, ({ installed, version }) => dispatch({
      type: "set-eclair-status",
      installed: !!installed,
      version: installed ? String(version || "").trim() || "Unknown" : "Unknown",
    }))
    .with({ command: "set-install-path" }, ({ path }) => dispatch({ type: "set-install-path", path: String(path ?? "") }))
    .with({ command: "set-path-status" }, ({ message }) => dispatch({ type: "set-path-status", message }))
    .with({ command: "clear-repo-presets" }, ({ repo, workspace }) => dispatch({
      type: "clear-repo-presets",
      repo,
      ...(workspace ? { workspace } : {}),
    }))
    .with({ command: "preset-content" }, ({ source, template, workspace }) => dispatch({
      type: "preset-content",
      source,
      template,
      ...(workspace ? { workspace } : {}),
    }))
    .with({ command: "config-loading" }, ({ loading }) => dispatch({ type: "update-state", updater: (draft) => {
      draft.loading = loading;
    }}))
    .with({ command: "set-sca-config" }, ({ by_workspace, build_configs_by_workspace }) => dispatch({ type: "load-sca-config", by_workspace, build_configs_by_workspace }))
    .with({ command: "repo-scan-done" }, ({ name, workspace, rev, checkout_dir }) => dispatch({
      type: "repo-scan-done",
      name,
      rev,
      checkout_dir,
      ...(workspace ? { workspace } : {}),
    }))
    .with({ command: "repo-scan-failed" }, ({ name, message, workspace }) => dispatch({
      type: "repo-scan-failed",
      name,
      message: String(message ?? ""),
      ...(workspace ? { workspace } : {}),
    }))
    .exhaustive();
}

function collect_config_from_state(strict: boolean, context_state: EclairWorkspaceBuildState): FullEclairScaConfig {
  const configs: EclairScaConfig[] = context_state.configs.map(config => ({
    name: config.name,
    description_md: config.description_md,
    main_config: collect_eclair_analysis_config(strict, config.main_config),
    extra_config: config.extra_config ? config.extra_config : undefined,
    reports: config.reports.selected,
  }));

  return {
    configs,
    current_config_index: context_state.current_config_index,
    repos: context_state.repos,
  };
}

function collect_eclair_analysis_config(strict: boolean, config: MainAnalysisConfigurationState): EclairScaMainConfig {
  return match(config)
    .with({ type: "preset" }, (cfg) => {
      const state = cfg.state;
      const config = collect_eclair_sca_preset_config(strict, state);
      return { type: "preset", ...config } as EclairScaMainConfig;
    })
    .with({ type: "custom-ecl" }, (cfg) => {
      const state = cfg.state;
      if (state.ecl === undefined) {
        throw new Error("Custom ECL path is not set");
      }
      return { type: "custom-ecl", ecl_path: state.ecl } as EclairScaMainConfig;
    })
    .with({ type: "zephyr-ruleset" }, (cfg) => {
      const ruleset = cfg.ruleset;
      return {
        type: "zephyr-ruleset",
        ruleset: ruleset.selected,
        userRulesetName: ruleset.userRulesetName,
        userRulesetPath: ruleset.userRulesetPath,
      } as EclairScaMainConfig;
    })
    .exhaustive();
}

function collect_eclair_sca_preset_config(strict: boolean, state: PresetsSelectionState): EclairScaPresetConfig {
  if (strict && state.rulesets_state.presets.length <= 0) {
    throw new Error("No preset ruleset selected");
  }

  return {
    rulesets: state.rulesets_state.presets,
    variants: state.variants_state.presets,
    tailorings: state.tailorings_state.presets,
  };
}



function EditableConfigDescription(props: { value: string; onSave: (description_md: string) => void }) {
  const [editing, set_editing] = useState<boolean>(false);
  const [draft, set_draft] = useState<string>(props.value);

  // Reset local UI state when switching configurations.
  useEffect(() => {
    set_editing(false);
    set_draft(props.value);
  }, [props.value]);

  return (<>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
      <h2 style={{ margin: 0, fontSize: "1.1em" }}>Notes</h2>
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        <VscodeButton
          appearance="icon"
          title={editing ? "Save notes" : "Edit notes"}
          aria-label={editing ? "Save notes" : "Edit notes"}
          onClick={() => {
            if (editing) {
              props.onSave(draft);
              set_editing(false);
            } else {
              set_draft(props.value);
              set_editing(true);
            }
          }}
        >
          <span className={`codicon ${editing ? "codicon-check" : "codicon-edit"}`} aria-hidden="true" />
        </VscodeButton>
        {editing && (
          <VscodeButton
            appearance="icon"
            title="Cancel"
            aria-label="Cancel"
            onClick={() => {
              set_draft(props.value);
              set_editing(false);
            }}
          >
            <span className="codicon codicon-x" aria-hidden="true" />
          </VscodeButton>
        )}
      </div>
    </div>

    {!editing ? (
      props.value.trim() ? (
        <div style={{ marginTop: "8px" }}>
          <EasyMark text={props.value} />
        </div>
      ) : (
        <div style={{ marginTop: "8px", color: "var(--vscode-descriptionForeground)" }}>
          No notes.
        </div>
      )
    ) : (
      <div style={{ marginTop: "8px" }}>
        {React.createElement("vscode-text-area", {
          value: draft,
          rows: 8,
          resize: "vertical",
          placeholder: "Write notes in Markdown",
          style: { width: "100%" },
          onInput: (e: any) => set_draft(e.target.value),
          onChange: (e: any) => set_draft(e.target.value),
          onKeyDown: (e: any) => {
            if (e.key === "Escape") {
              set_draft(props.value);
              set_editing(false);
            }
          },
        })}
      </div>
    )}
  </>);
}
