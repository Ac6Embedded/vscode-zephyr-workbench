import React, { useMemo, useState } from "react";
import { WebviewMessage } from "../../../../utils/eclair/eclairEvent";
import { AvailablePresetsState, EclairStateAction, get_preset_template_by_source, MultiPresetSelectionState, PresetsSelectionState, RepoScanState } from "../../state";
import { PickPath, SearchableDropdown, SearchableItem, VscodeAlert, VscodeBadge, VscodeButton, VscodeCheckbox, VscodePanel, RichHelpTooltip, Monospace, VscodeDropdown, VscodeOption } from "../common_components";
import { EclairTemplate, EclairTemplateKind, EclairTemplateOption } from "../../../../utils/eclair/template";
import { EclairPresetTemplateSource, EclairRepos, PresetSelectionState } from "../../../../utils/eclair/config";
import { RepoManagementSection } from "./preset_selection/repo_management";
import { match } from "ts-pattern";
import { EasyMark, EasyMarkInline } from "../easymark_render";
import { useRpc } from "../../rpc";

export function PresetSelection(props: {
  workspace: string;
  state: PresetsSelectionState;
  available_presets: AvailablePresetsState;
  repos: EclairRepos;
  repos_scan_state: Record<string, RepoScanState>;
  dispatch_state: React.Dispatch<EclairStateAction>;
  post_message: (message: WebviewMessage) => void;
}) {
  return (<>
    <h3>
      Repository management
      <RichHelpTooltip>
        <p>
          Manage the Git repositories that provide preset templates. Each repository is identified by a short name, a Git origin URL, and a revision (branch, tag, or commit SHA).
        </p>
        <p>
          Preset templates from these repositories will be available for selection in the ruleset, variant and tailoring sections below.
        </p>
        <p>
          Repositories are checked out on demand and scanned for preset templates.<br/>
          You can add as many repositories as you want, and they will be automatically checked out and scanned for presets.
        </p>
      </RichHelpTooltip>
    </h3>
    <p>
      Add, remove and edit Git repositories that contain preset templates.
    </p>
    <RepoManagementSection
      workspace={props.workspace}
      repos={props.repos}
      repos_scan_state={props.repos_scan_state}
      available_presets={props.available_presets}
      dispatch_state={props.dispatch_state}
      post_message={props.post_message}
    />

    <h3>
      Ruleset selection
      <RichHelpTooltip>Use a ruleset as the baseline for checks. Variants and tailorings refine this selection.</RichHelpTooltip>
    </h3>
    <div className="panel-lead">
      Choose a base ruleset to run the analysis with.
    </div>

    <MultiPresetSelection
      kind="ruleset"
      workspace={props.workspace}
      state={props.state.rulesets_state}
      available_presets={props.available_presets}
      dispatch_state={props.dispatch_state}
      post_message={props.post_message}
    />

    <h3>
      Variants selection
      <RichHelpTooltip>Variants adjust the base ruleset by enabling or disabling groups of checks, or changing rule behavior.</RichHelpTooltip>
    </h3>
    <div className="panel-lead">
      Choose an analysis variant to run.<br/>
      Variants are modifications to the base ruleset that enable or disable certain checks, or change the behavior of some rules.<br/>
    </div>

    <MultiPresetSelection 
      kind="variant" 
      workspace={props.workspace}
      state={props.state.variants_state} 
      available_presets={props.available_presets}
      dispatch_state={props.dispatch_state}
      post_message={props.post_message}
    />

    <h3>
      Tailorings selection
      <RichHelpTooltip>Tailorings apply additional, fine-grained adjustments on top of rulesets and variants.</RichHelpTooltip>
    </h3>
    <div className="panel-lead">
      Choose a tailoring to apply to the analysis.<br/>
      Tailorings are modifications to the base ruleset that are applied on top of variants, and can be used to further customize the analysis configuration.
    </div>

    <MultiPresetSelection 
      kind="tailoring" 
      workspace={props.workspace}
      state={props.state.tailorings_state} 
      available_presets={props.available_presets}
      dispatch_state={props.dispatch_state}
      post_message={props.post_message}
    />
  </>);
}

function MultiPresetSelection(props: {
  kind: EclairTemplateKind;
  workspace: string;
  state: MultiPresetSelectionState;
  available_presets: AvailablePresetsState;
  dispatch_state: React.Dispatch<EclairStateAction>;
  post_message: (message: WebviewMessage) => void;
}) {
  const [showPicker, setShowPicker] = useState<boolean>(false);
  const presets = props.state.presets;

  return (<>
    {presets.length > 0 && (
      <div style={{ marginTop: "10px" }}>
        {presets.map((preset, index) => {
          const source = preset.source;
          const template = get_preset_template_by_source(props.available_presets, source);

          const on_remove = () => {
            props.dispatch_state({
              type: "with-selected-workspace",
              action: {
                type: "with-selected-configuration",
                action: { type: "remove-selected-preset", kind: props.kind, index },
              },
            });
          };

          return (
            <fieldset key={index} style={{ width: "100%", boxSizing: "border-box" }}>
              {template && ("title" in template) && (<legend>{template.title}</legend>)}
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
                <strong>Preset {index + 1}:</strong>
                <EclairPresetTemplateSourceDisplay source={source} />
                <VscodeButton appearance="secondary" onClick={on_remove} title="Remove preset">Remove</VscodeButton>
              </div>

              {template === undefined ? (
                <VscodeAlert type="error">Preset not found in available presets.</VscodeAlert>
              ) : "loading" in template ? (
                <VscodeAlert type="info">{template.loading}…</VscodeAlert>
              ) : "error" in template ? (
                <VscodeAlert type="error">Error loading preset: {template.error}</VscodeAlert>
              ) : (<>
                <PresetSettings
                  template={template}
                  preset={preset}
                  dispatch_state={props.dispatch_state}
                />
                {template.kind !== props.kind && (
                  <VscodeAlert type="warning">
                    This preset is of kind "<strong><Monospace>{template.kind}</Monospace></strong>", but is being used as a "<strong><Monospace>{props.kind}</Monospace></strong>". This might lead to unexpected results.
                  </VscodeAlert>
                )}
              </>)}
            </fieldset>
          );
        })}
      </div>
    )}

    <div style={{ marginTop: '10px' }}>
      <VscodeButton 
        appearance="primary" 
        onClick={() => setShowPicker(!showPicker)}
      >
        {showPicker ? "Hide Preset Selection" : `Add ${presets.length > 0 ? "Another" : ""} Preset`}
      </VscodeButton>
    </div>

    {showPicker && (
      <PresetPicker
        kind={props.kind}
        workspace={props.workspace}
        available_presets={props.available_presets}
        already_selected_sources={presets.map(p => p.source)}
        dispatch_state={props.dispatch_state}
        post_message={props.post_message}
        onPresetSelected={() => setShowPicker(false)}
      />
    )}
  </>);
}

// Best effort to keep the file picker anchored to the last folder the user chose,
// regardless of workspace/kind, since presets are often stored in a shared directory.
let last_selected_path = "";

function PresetPicker(props: {
  kind: EclairTemplateKind;
  workspace: string;
  available_presets: AvailablePresetsState;
  already_selected_sources?: EclairPresetTemplateSource[];
  dispatch_state: React.Dispatch<EclairStateAction>;
  post_message: (message: WebviewMessage) => void;
  onPresetSelected?: () => void;
}) {
  const rpc = useRpc();
  type Item = SearchableItem & { source: EclairPresetTemplateSource };
  const [selectedPreset, setSelectedPreset] = React.useState<Item | null>(null);
  const [edit_path, set_edit_path] = React.useState<string>("");

  const available_preset_items: Item[] = useMemo(() => {
    let items: Item[] = [];
    for (const [path, preset] of props.available_presets.by_path) {
      if ("loading" in preset || "error" in preset) {
        continue;
      }
      if (preset.kind !== props.kind) {
        continue;
      }
      if (props.already_selected_sources?.some(s => sources_are_equal(s, { type: "system-path", path }))) {
        continue;
      }
      items.push({
        id: path,
        name: preset.title,
        description: {
          content: (<>
            <EasyMark text={preset.description.split("\n\n")[0]}/>
            Path: {path}
          </>),
          searchable: `Path: ${path} ${typeof preset.description === "string" ? preset.description : ""}`,
        },
        source: { type: "system-path", path },
      });
    }
    for (const [repo, by_path] of props.available_presets.by_repo_and_path) {
      for (const [path, preset] of by_path) {
        if ("loading" in preset || "error" in preset) {
          continue;
        }
        if (preset.kind !== props.kind) {
          continue;
        }
        if (props.already_selected_sources?.some(s => sources_are_equal(s, { type: "repo-path", repo, path }))) {
          continue;
        }
        items.push({
          id: `${repo}:${path}`,
          name: preset.title,
          description: {
            content: (<>
              <EasyMark text={preset.description.split("\n\n")[0]}/>
              Repo: {repo}, Path: {path}
            </>),
            searchable: `Repo: ${repo}, Path: ${path} ${typeof preset.description === "string" ? preset.description : ""}`,
          },
          source: { type: "repo-path", repo, path },
        });
      }
    }
    return items;
  }, [props.available_presets, props.already_selected_sources, props.kind]);

  return (<div style={{ 
    marginTop: '10px', 
    padding: '12px', 
    border: '1px solid var(--vscode-panel-border)', 
    borderRadius: '4px',
    backgroundColor: 'var(--vscode-editor-background)'
  }}>
    <div style={{ marginBottom: '10px', fontSize: '0.9em', color: 'var(--vscode-descriptionForeground)' }}>
      You can either select one of the available presets below, or provide a custom preset by specifying the path to a <Monospace>.ecl</Monospace> file.
    </div>

    <SearchableDropdown
      id={`preset-search-${props.kind}`}
      label="Select from available presets:"
      placeholder="Search or select a preset..."
      items={available_preset_items}
      selectedItem={selectedPreset}
      onSelectItem={(preset: Item) => {
        setSelectedPreset(preset);
        props.dispatch_state({
          type: "with-selected-workspace",
          action: {
            type: "with-selected-configuration",
            action: { type: "set-or-add-preset", kind: props.kind, source: preset.source },
          },
        });
        props.onPresetSelected?.();
      }}
    />

    <div style={{ marginTop: '10px' }}>
      Or provide a custom preset by specifying the path to a <Monospace>.ecl</Monospace> file:
    </div>
    <PickPath
      value={edit_path}
      placeholder="Path to analysis_<RULESET>.ecl"
      on_selected={(path) => {
        set_edit_path(path);
        props.dispatch_state({
          type: "with-selected-workspace",
          action: {
            type: "with-selected-configuration",
            action: { type: "set-or-add-preset", kind: props.kind, source: { type: "system-path", path } },
          },
        });
        props.post_message({
          command: "load-preset",
          source: { type: "system-path", path },
          repos: {},
          workspace: props.workspace,
        });
        props.onPresetSelected?.();
      }}
      on_pick={async () => {
        const result = await rpc.call("open-dialog", {
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          title: "Select a preset file",
          defaultUri: edit_path || last_selected_path || undefined,
        });
        if (result?.canceled || !result?.paths?.[0]) {
          return;
        }
        const path = String(result.paths[0]);
        last_selected_path = path;
        set_edit_path(path);
        props.dispatch_state({
          type: "with-selected-workspace",
          action: {
            type: "with-selected-configuration",
            action: { type: "set-or-add-preset", kind: props.kind, source: { type: "system-path", path } },
          },
        });
        props.post_message({
          command: "load-preset",
          source: { type: "system-path", path },
          repos: {},
          workspace: props.workspace,
        });
        props.onPresetSelected?.();
      }}
    />
  </div>);
}

function EclairPresetTemplateSourceDisplay({
  source,
}: {
  source: EclairPresetTemplateSource;
}) {
  if (source.type === "system-path") {
    return <span>Path: <Monospace>{source.path}</Monospace></span>;
  } else {
    return (
      <span>
        Repo "{source.repo}": <Monospace>{source.path}</Monospace>
      </span>
    );
  }
}

function PresetSettings({
  template,
  preset,
  dispatch_state,
}: {
  template: EclairTemplate,
  preset: PresetSelectionState,
  dispatch_state: React.Dispatch<EclairStateAction>,
}) {
  return (<div style={{ marginTop: "8px" }}>
    <div style={{ color: "var(--vscode-descriptionForeground)" }}><EasyMark text={template.description} /></div>

    {template.options.length > 0 && (
      <details style={{ marginTop: "8px" }}>
        <summary style={{ cursor: "pointer", userSelect: "none" }}>
          Options
        </summary>
        <div style={{ 
          marginTop: "8px", 
          maxHeight: "20em", 
          overflowY: "auto", 
          overflowX: "hidden",
          border: "1px solid var(--vscode-panel-border)", 
          padding: "8px", 
          borderRadius: "4px",
          backgroundColor: "var(--vscode-input-background)"
        }}>
          {template.options.map((option, idx) => (
            <TemplateOptionTree
              key={option.id || idx}
              option={option}
              level={0}
              editedFlags={preset.edited_flags ?? {}}
              onSetFlag={(option_id, value) => dispatch_state({
                type: "with-selected-workspace",
                action: {
                  type: "with-selected-configuration",
                  action: {
                    type: "set-preset-option",
                    source: preset.source,
                    option_id,
                    value,
                  },
                },
              })}
              onClearFlag={(option_id) => dispatch_state({
                type: "with-selected-workspace",
                action: {
                  type: "with-selected-configuration",
                  action: {
                    type: "clear-preset-option",
                    source: preset.source,
                    option_id,
                  },
                },
              })}
            />
          ))}
        </div>
      </details>
    )}
  </div>);
}

function collectFlagIds(option: EclairTemplateOption): string[] {
  if (option.variant.kind === "flag") {
    return [option.id];
  } else if (option.variant.kind === "group") {
    return option.variant.children.flatMap(collectFlagIds);
  }
  return [];
}

function TemplateOptionTree({
  option,
  level = 0,
  editedFlags,
  onSetFlag,
  onClearFlag,
}: {
  option: EclairTemplateOption;
  level?: number;
  editedFlags: Record<string, boolean | string>;
  onSetFlag: (option_id: string, value: boolean | string) => void;
  onClearFlag: (option_id: string) => void;
}) {
  const [expanded, setExpanded] = useState<boolean>(true);

  const indentStyle: React.CSSProperties = {
    marginLeft: `${level * 10}px`,
    marginTop: "4px",
    marginBottom: "4px",
  };

  const modified_star = (<span style={{ marginLeft: "3px", marginRight: "3px" }}>
    *
  </span>);

  const OptionTitle = ({ modified }: { modified: boolean }) => {
    if (option.title && option.title !== option.id) {
      return (<>
        <span style={{ marginRight: "8px" }}>
          {option.id}{modified && modified_star}:
        </span>
        <span style={{ color: "var(--vscode-descriptionForeground)" }}>
          <EasyMarkInline text={option.title} />
        </span>
        {option.description && (<RichHelpTooltip><EasyMark text={option.description} /></RichHelpTooltip>)}
      </>);
    } else {
      return (<>
        <span>{option.id}</span>
        {modified && modified_star}
      </>);
    }
  };

  return match(option.variant)
    .with({ kind: "flag" }, (variant) => {
      const defaultValue = variant.default ?? false;
      const editedValue: boolean | undefined = typeof(editedFlags[option.id]) === "boolean" ? editedFlags[option.id] as boolean : undefined;
      const isEdited = editedValue !== undefined;
      const checked = isEdited ? editedValue : defaultValue;

      return (
        <div style={indentStyle}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <VscodeCheckbox
              checked={checked}
              onChange={(e: any) => onSetFlag(option.id, !!e.target.checked)}
            >
              <OptionTitle modified={isEdited} />
            </VscodeCheckbox>
            {isEdited && (
              <span
                className="no-icon-tooltip"
                data-tooltip="Reset to default"
                style={{ position: "relative", display: "inline-flex", marginLeft: "6px" }}
              >
                <VscodeButton
                  appearance="icon"
                  aria-label="Reset to default"
                  onClick={() => onClearFlag(option.id)}
                ><span className="codicon codicon-discard" /></VscodeButton>
              </span>
            )}
          </div>
        </div>
      );
    })
    .with({ kind: "group" }, (variant) => {
      const allFlagIds = variant.children.flatMap(collectFlagIds);
      const any_modified = allFlagIds.some((id) => editedFlags[id] !== undefined);

      return (
        <div style={indentStyle}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              cursor: "pointer",
              userSelect: "none",
              fontWeight: level === 0 ? "bold" : "normal",
            }}
            onClick={() => setExpanded(!expanded)}
          >
            <span style={{ marginRight: "6px", fontSize: "0.8em" }}>
              {expanded ? "▼" : "▶"}
            </span>
            <OptionTitle modified={any_modified} />
            <VscodeBadge style={{ marginLeft: "8px" }}>{allFlagIds.length}</VscodeBadge>
            <div
              style={{ marginLeft: "12px", display: "flex", gap: "4px" }}
              onClick={(e) => e.stopPropagation()}
            >
              <VscodeButton
                appearance="icon"
                title="Enable all"
                onClick={() => allFlagIds.forEach((id) => onSetFlag(id, true))}
              ><span className="codicon codicon-plus" /></VscodeButton>
              <VscodeButton
                type="button"
                appearance="icon"
                title="Disable all"
                onClick={() => allFlagIds.forEach((id) => onSetFlag(id, false))}
              ><span className="codicon codicon-chrome-close" /></VscodeButton>
              <VscodeButton
                appearance="icon"
                title="Reset all to default"
                onClick={() => allFlagIds.forEach((id) => onClearFlag(id))}
              ><span className="codicon codicon-discard" /></VscodeButton>
            </div>
          </div>
          {expanded && variant.children.map((childOption, idx) => (
            <TemplateOptionTree
              key={childOption.id || idx}
              option={childOption}
              level={level + 1}
              editedFlags={editedFlags}
              onSetFlag={onSetFlag}
              onClearFlag={onClearFlag}
            />
          ))}
        </div>
      );
    })
    .with({ kind: "select" }, (variant) => {
      const default_value = variant.default;
      const edited_value: string | undefined = typeof(editedFlags[option.id]) === "string" ? editedFlags[option.id] as string : undefined;
      const is_edited = edited_value !== undefined;
      const value = is_edited ? edited_value : default_value;

      return (
        <div style={indentStyle}>
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <label htmlFor={`option-select-${option.id}`}><OptionTitle modified={is_edited} /></label>
            <VscodeDropdown
              id={`option-select-${option.id}`}
              onChange={(e: any) => onSetFlag(option.id, e.target.value)} value={value}
              style={{ width: "100px" }}
            >
              {variant.values.map((v) => (<VscodeOption key={v.value} value={v.value} selected={v.value === value}>
                {v.value} - {v.description}
              </VscodeOption>))}
            </VscodeDropdown>
          </div>
        </div>
      );
    })
    .exhaustive();
}

export function sources_are_equal(s1: EclairPresetTemplateSource, s2: EclairPresetTemplateSource): boolean {
  if (s1.type !== s2.type) {
    return false;
  }

  return match(s1)
    .with({ type: "system-path" }, (s1) => {
      const s2_casted = s2 as Extract<EclairPresetTemplateSource, { type: "system-path" }>;
      return s1.path === s2_casted.path;
    })
    .with({ type: "repo-path" }, (s1) => {
      const s2_casted = s2 as Extract<EclairPresetTemplateSource, { type: "repo-path" }>;
      return s1.repo === s2_casted.repo && s1.path === s2_casted.path;
    })
    .exhaustive();
}
