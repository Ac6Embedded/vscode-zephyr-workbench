import React, { useState, useEffect, useCallback, useReducer, useMemo } from "react";
import { createRoot } from "react-dom/client";
import type { ExtensionMessage, WebviewMessage } from "../../utils/eclairEvent.js";
import { MainAnalysisConfigurationState, EclairStateAction, PresetsSelectionState, default_eclair_state, default_install_path_state, eclairReducer, EclairConfig, EclairWorkspaceBuildState, EclairState } from "./state.js";
import { Summary } from "./components/summary.js";
import { ReportsSection } from "./components/reports_section.js";
import { ExtraConfigSection } from "./components/extra_config_section.js";
import { CommandSection } from "./components/command_section.js";
import { ReportViewerSection } from "./components/report_viewer.js";
import { MainAnalysisConfigurationSection } from "./components/main_configuration.js";
import { match } from "ts-pattern";
import { FullEclairScaConfig, EclairScaMainConfig, EclairScaPresetConfig, EclairScaConfig } from "../../utils/eclair/config.js";
import { Result } from "../../utils/typing_utils.js";
import { EditableTextField, RichHelpTooltip, SearchableDropdown, VscodeButton, VscodePanel } from "./components/common_components.js";
import { EasyMark } from "./components/easymark_render.js";
import { enableMapSet } from "immer";

const BODY_ID = "eclair-manager-body";

function workspace_label(workspace: string): string {
  const parts = workspace.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : workspace;
}

// VSCode API type
declare const acquireVsCodeApi: any;

export async function main() {
  enableMapSet();

  const body = document.getElementById(BODY_ID);
  if (!body) return;

  const root = createRoot(body);
  root.render(<EclairManagerPanel />);

  import_wui().catch((e) => {
    console.error("Failed to load VSCode Webview UI Toolkit:", e);
  });
}

export async function import_wui() {
  const mod = await import("@vscode/webview-ui-toolkit");
  const { provideVSCodeDesignSystem, allComponents } = mod as any;
  provideVSCodeDesignSystem().register(allComponents);
}

function EclairManagerPanel() {
  const [api] = useState(() => acquireVsCodeApi());
  const [state, dispatch_state] = useReducer(eclairReducer, default_eclair_state());

  const post_message = useCallback((message: WebviewMessage) => {
    api.postMessage(message);
  }, [api]);

  // setup message handler
  useEffect(() => {
    const handle_message = (message: MessageEvent) => handleMessage(dispatch_state, message);
    window.addEventListener("message", handle_message);
    return () => window.removeEventListener("message", handle_message);
  }, [api]);

  // Trigger initial status refresh on mount
  useEffect(() => {
    try {
      post_message({ command: "refresh-status" });
    } catch (e) {
      console.error("Failed to post message to VSCode extension backend:", e);
    }
  }, [post_message]);

  const current_context = state.current_context;
  const workspace = current_context?.workspace;
  const build_config = current_context?.build_config;
  const build_configs = workspace ? state.by_workspace_and_build_config[workspace] : undefined;
  const current_context_state = workspace && build_config ? build_configs?.[build_config] : undefined;

  const workspace_items = useMemo(
    () => Object.keys(state.by_workspace_and_build_config).map((key) => ({
      id: key,
      name: workspace_label(key),
      description: key,
      value: key,
    })),
    [state.by_workspace_and_build_config],
  );
  const current_workspace_item = workspace_items.find((item) => item.value === workspace);

  const build_config_items = useMemo(
    () => Object.keys(state.by_workspace_and_build_config[workspace || ""] ?? {}).map((name) => ({ id: name, name, description: "", value: name })),
    [state.by_workspace_and_build_config, workspace],
  );
  const current_build_config_item = build_config_items.find((item) => item.value === build_config);

  return (
    <div>
      <h1>
        ECLAIR Manager
        <RichHelpTooltip>
          <p>
            Bugseng <a href="https://www.bugseng.com/eclair-static-analysis-tool/">ECLAIR</a> is a certified static analysis tool and platform for software verification.
          </p>
          <p>
            This panel allows to configure ECLAIR SCA analysis for Zephyr projects.
          </p>
        </RichHelpTooltip>
      </h1>

      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "10px" }}>
        Workspace:
        <SearchableDropdown
          id="workspace-selector"
          label=""
          placeholder="Select workspace"
          items={workspace_items}
          selectedItem={current_workspace_item || null}
          onSelectItem={(item) => {
            const next_workspace = item.value;
            const build_configs = state.by_workspace_and_build_config[next_workspace] ?? {};
            const next_build_config = Object.keys(build_configs)[0];
            if (!next_build_config) {
              console.warn("No build configurations available for workspace", next_workspace);
              return;
            }
            dispatch_state({ type: "select-context", workspace: next_workspace, build_config: next_build_config });
          }}
        />
        Build Config:
        {workspace && (<SearchableDropdown
          id="build-config-selector"
          label=""
          placeholder="Select build config"
          items={build_config_items}
          selectedItem={current_build_config_item || null}
          onSelectItem={(item) => dispatch_state({ type: "select-context", workspace, build_config: item.value })}
        />)}
        <VscodeButton
          appearance="secondary"
          title="Discard unsaved changes and reload from settings.json"
          onClick={() => post_message({ command: "reload-sca-config" })}
        >
          Reload Configs
        </VscodeButton>
      </div>

      <Summary
        status={state.status}
        installPath={current_context_state?.install_path ?? default_install_path_state()}
        post_message={post_message}
        dispatch_state={dispatch_state}
      />

      {current_context_state && workspace && build_config && (<EclairManagerWithConfigs
        workspace={workspace}
        build_config={build_config}
        by_workspace_and_build_config={state.by_workspace_and_build_config}
        context_state={current_context_state}
        dispatch_state={dispatch_state}
        post_message={post_message}
        state={state}
      />)}
    </div>
  );
}

function EclairManagerWithConfigs({
  workspace,
  build_config,
  by_workspace_and_build_config,
  context_state,
  dispatch_state,
  post_message,
  state,
}: {
  workspace: string;
  build_config: string;
  by_workspace_and_build_config: Record<string, Record<string, EclairWorkspaceBuildState>>;
  context_state: EclairWorkspaceBuildState;
  dispatch_state: React.Dispatch<EclairStateAction>;
  post_message: (message: WebviewMessage) => void;
  state: EclairState;
}) {
  const configs = context_state.configs;
  const current: EclairConfig | undefined = configs[context_state.current_config_index];
  const [collected_config, set_collected_config] = useState<Result<FullEclairScaConfig, string>>({ err: "Not configured" });

  const config_items = useMemo(() => configs.map((config, index) => ({ id: index, name: config.name, description: "", index })), [configs]);
  const current_config_item = config_items[context_state.current_config_index];

  // Collect config for sending to backend
  // Note: this does not depend on the full state but only on the relevant parts
  // TODO refactor the state to group the relevant parts together and avoid passing
  // so many individual dependencies to this function (because this requires
  // keeping the reps and the args in sync here).
  useEffect(() => {
    try {
      let config = collect_config_from_state(context_state);
      set_collected_config({ ok: config });
    } catch (e) {
      set_collected_config({ err: e instanceof Error ? e.message : String(e) });
    }
  }, [context_state]);

  return (<>
    <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "10px" }}>
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
        onClick={() => {
          dispatch_state({
            type: "with-selected-workspace",
            action: { type: "add-new-configuration", name: `Config ${configs.length + 1}` },
          });
        }}
      >
        New
      </VscodeButton>
      {current && (
        <VscodeButton
          appearance="secondary"
          onClick={() => {
            dispatch_state({
              type: "with-selected-workspace",
              action: { type: "delete-configuration", index: context_state.current_config_index },
            });
          }}
        >
          <span className="codicon codicon-trash" />
        </VscodeButton>
      )/* TODO maybe an export/import button */}
    </div>

    {current && (<>
      <VscodePanel style={{ marginBottom: "12px" }}>
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
      </VscodePanel>

      <MainAnalysisConfigurationSection
        config_index={context_state.current_config_index}
        workspace={workspace}
        build_config={build_config}
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
        workspace={workspace}
        build_config={build_config}
        extra_config={current.extra_config}
        dispatch_state={dispatch_state}
        post_message={post_message}
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
      reportServer={state.report_server}
      workspace={workspace}
      build_config={build_config}
      post_message={post_message}
    />
  </>);
}

window.addEventListener("load", main);


function handleMessage(
  dispatch: React.Dispatch<EclairStateAction>,
  event: MessageEvent
) {
  const msg: ExtensionMessage = event.data;

  match(msg)
    .with({ command: "toggle-spinner" }, ({ show }) => dispatch({ type: "toggle-spinner", show: !!show }))
    .with({ command: "eclair-status" }, ({ installed, version }) => dispatch({
      type: "set-eclair-status",
      installed: !!installed,
      version: installed ? String(version || "").trim() || "Unknown" : "Unknown",
    }))
    .with({ command: "set-install-path" }, ({ path }) => dispatch({ type: "set-install-path", path: String(path ?? "") }))
    .with({ command: "set-install-path-placeholder" }, ({ text }) => dispatch({ type: "set-install-path-placeholder", text: String(text ?? "") }))
    .with({ command: "set-extra-config" }, ({ path, workspace, build_config }) => dispatch({
      type: "with-selected-workspace",
      ...(workspace && build_config ? { workspace, build_config } : {}),
      action: {
        type: "with-selected-configuration",
        action: { type: "set-extra-config", path: String(path ?? "") },
      },
    }))
    .with({ command: "set-path-status" }, ({ text }) => dispatch({ type: "set-path-status", text: String(text ?? "") }))
    .with({ command: "set-user-ruleset-name" }, ({ name }) => dispatch({
      type: "with-selected-workspace",
      action: {
        type: "with-selected-configuration",
        action: { type: "set-user-ruleset-name", name: String(name ?? "") },
      },
    }))
    .with({ command: "set-user-ruleset-path" }, ({ path, workspace, build_config }) => dispatch({
      type: "with-selected-workspace",
      ...(workspace && build_config ? { workspace, build_config } : {}),
      action: {
        type: "with-selected-configuration",
        action: { type: "set-user-ruleset-path", path: String(path ?? "") },
      },
    }))
    .with({ command: "set-custom-ecl-path" }, ({ path, workspace, build_config }) => dispatch({
      type: "with-selected-workspace",
      ...(workspace && build_config ? { workspace, build_config } : {}),
      action: {
        type: "with-selected-configuration",
        action: { type: "set-custom-ecl-path", path: String(path ?? "") },
      },
    }))
    .with({ command: "report-server-started" }, () => dispatch({ type: "report-server-started" }))
    .with({ command: "report-server-stopped" }, () => dispatch({ type: "report-server-stopped" }))
    .with({ command: "preset-content" }, ({ source, template, workspace, build_config }) => dispatch({
      type: "preset-content",
      source,
      template,
      ...(workspace && build_config ? { workspace, build_config } : {}),
    }))
    .with({ command: "template-path-picked" }, ({ kind, path }) => dispatch({
      type: "with-selected-workspace",
      action: {
        type: "with-selected-configuration",
        action: { type: "set-preset-path", kind, path },
      },
    }))
    .with({ command: "set-sca-config" }, ({ by_workspace_and_build_config }) => dispatch({ type: "load-sca-config", by_workspace_and_build_config }))
    .with({ command: "repo-scan-done" }, ({ name, workspace, build_config }) => dispatch({
      type: "repo-scan-done",
      name,
      ...(workspace && build_config ? { workspace, build_config } : {}),
    }))
    .with({ command: "repo-scan-failed" }, ({ name, message, workspace, build_config }) => dispatch({
      type: "repo-scan-failed",
      name,
      message: String(message ?? ""),
      ...(workspace && build_config ? { workspace, build_config } : {}),
    }))
    .exhaustive();
}

function collect_config_from_state(context_state: EclairWorkspaceBuildState): FullEclairScaConfig {
  const configs: EclairScaConfig[] = context_state.configs.map(config => ({
    name: config.name,
    description_md: config.description_md,
    main_config: collect_eclair_analysis_config(config.main_config),
    extra_config: config.extra_config.path,
    reports: config.reports.selected,
  }));

  return {
    install_path: context_state.install_path.path,
    configs,
    current_config_index: context_state.current_config_index,
    repos: context_state.repos,
  };
}

function collect_eclair_analysis_config(config: MainAnalysisConfigurationState): EclairScaMainConfig {
  return match(config)
    .with({ type: "preset" }, (cfg) => {
      const state = cfg.state;
      const config = collect_eclair_sca_preset_config(state);
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

function collect_eclair_sca_preset_config(state: PresetsSelectionState): EclairScaPresetConfig {
  if (state.ruleset_state.preset === undefined) {
    throw new Error("No preset ruleset selected");
  }

  return {
    ruleset: state.ruleset_state.preset,
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
