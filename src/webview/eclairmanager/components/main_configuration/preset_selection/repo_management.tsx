import React, { useState } from "react";
import { EclairRepos } from "../../../../../utils/eclair/config";
import { AvailablePresetsState, EclairStateAction, RepoScanState } from "../../../state";
import { WebviewMessage } from "../../../../../utils/eclairEvent";
import { StatusBadge, StatusBadgeState, VscodeBadge, VscodeButton, VscodePanel, VscodeTextField } from "../../common_components";

const EMPTY_REPO_FORM = { name: "", origin: "", rev: "" };

/**
 * UI section for managing preset repositories.
 */
export function RepoManagementSection(props: {
  workspace: string;
  build_config: string;
  repos: EclairRepos;
  repos_scan_state: Record<string, RepoScanState>;
  available_presets: AvailablePresetsState;
  dispatch_state: React.Dispatch<EclairStateAction>;
  post_message: (message: WebviewMessage) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [form, set_form] = useState(EMPTY_REPO_FORM);
  const [editingName, set_editing_name] = useState<string | null>(null);

  const repoCount = Object.keys(props.repos).length;

  function handle_add() {
    const name = form.name.trim();
    const origin = form.origin.trim();
    const rev = form.rev.trim();
    if (!name || !origin || !rev) { return; }
    props.dispatch_state({ type: "add-repo", name, origin, rev });
    props.dispatch_state({ type: "repo-scan-started", name });
    props.post_message({ command: "scan-repo", name, origin, ref: rev, workspace: props.workspace, build_config: props.build_config });
    set_form(EMPTY_REPO_FORM);
  }

  function handle_remove(name: string) {
    props.dispatch_state({ type: "remove-repo", name });
  }

  function handle_edit_save() {
    if (!editingName) { return; }
    const origin = form.origin.trim();
    const rev = form.rev.trim();
    if (!origin || !rev) { return; }
    props.dispatch_state({ type: "update-repo", name: editingName, origin, rev });
    props.dispatch_state({ type: "repo-scan-started", name: editingName });
    props.post_message({ command: "scan-repo", name: editingName, origin, ref: rev, workspace: props.workspace, build_config: props.build_config });
    set_editing_name(null);
    set_form(EMPTY_REPO_FORM);
  }

  function handle_reload_all() {
    for (const [name, entry] of Object.entries(props.repos)) {
      props.dispatch_state({ type: "repo-scan-started", name });
      props.post_message({ command: "scan-repo", name, origin: entry.origin, ref: entry.ref, workspace: props.workspace, build_config: props.build_config });
    }
  }

  const is_adding = editingName === null;
  const repo_entries = Object.entries(props.repos);

  return (
    <div style={{ marginBottom: "12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <VscodeButton
          appearance="primary"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Hide" : "Manage"} Preset Repositories ({repoCount})
        </VscodeButton>
        {repo_entries.length > 0 && (
          <VscodeButton
            appearance="secondary"
            onClick={handle_reload_all}
            title="Re-scan all repositories for preset templates"
            disabled={repo_entries.some(([name]) => props.repos_scan_state[name]?.status === "loading")}
          >
            Reload All
          </VscodeButton>
        )}
      </div>

      {expanded && (<VscodePanel>
        {repo_entries.length > 0 && <ReposTable
          repoEntries={repo_entries}
          repos_scan_state={props.repos_scan_state}
          available_presets={props.available_presets}
          handle_reload={(name: string) => {
            const entry = props.repos[name];
            if (!entry) { return; }
            props.dispatch_state({ type: "repo-scan-started", name });
            props.post_message({ command: "scan-repo", name, origin: entry.origin, ref: entry.ref, workspace: props.workspace, build_config: props.build_config });
          }}
          handle_update={(name: string) => {
            const entry = props.repos[name];
            if (!entry) { return; }
            props.dispatch_state({ type: "repo-scan-started", name });
            props.post_message({ command: "update-repo-checkout", name, origin: entry.origin, ref: entry.ref, workspace: props.workspace, build_config: props.build_config });
          }}
          handle_edit_start={(name: string) => {
            const entry = props.repos[name];
            set_editing_name(name);
            set_form({ name, origin: entry.origin, rev: entry.ref });
          }}
          handle_remove={handle_remove}
        />}

        {repo_entries.length === 0 && (
          <p style={{ fontStyle: "italic", color: "var(--vscode-descriptionForeground)" }}>
            No repositories configured.
          </p>
        )}

        <EditForm
          form={form}
          is_adding={is_adding}
          set_form={set_form}
          handle_add={handle_add}
          handle_edit_save={handle_edit_save}
          handle_edit_cancel={() => {
            set_editing_name(null);
            set_form(EMPTY_REPO_FORM);
          }}
        />
      </VscodePanel>)}
    </div>
  );
}

function ReposTable({
  repoEntries,
  repos_scan_state,
  available_presets,
  handle_reload,
  handle_update,
  handle_edit_start,
  handle_remove,
}: {
  repoEntries: [string, { origin: string; ref: string }][];
  repos_scan_state: Record<string, RepoScanState>;
  available_presets: AvailablePresetsState;
  handle_reload: (name: string) => void;
  handle_update: (name: string) => void;
  handle_edit_start: (name: string) => void;
  handle_remove: (name: string) => void;
}) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "12px", fontSize: "0.9em" }}>
      <thead>
        <tr>
          <th style={{ textAlign: "left", padding: "4px 8px" }}>Name</th>
          <th style={{ textAlign: "left", padding: "4px 8px" }}>Origin</th>
          <th style={{ textAlign: "left", padding: "4px 8px" }}>Ref</th>
          <th style={{ textAlign: "left", padding: "4px 8px" }}>Status</th>
          <th style={{ textAlign: "left", padding: "4px 8px" }}>Actions</th>
        </tr>
      </thead>
      <tbody>
        {repoEntries.map(([name, entry]) => (
          <tr key={name} style={{ borderTop: "1px solid var(--vscode-panel-border, #444)" }}>
            <td style={{ padding: "4px 8px", fontFamily: "monospace" }}>{name}</td>
            <td style={{ padding: "4px 8px", fontFamily: "monospace", wordBreak: "break-all" }}>{entry.origin}</td>
            <td style={{ padding: "4px 8px", fontFamily: "monospace" }}>{entry.ref}</td>
            <td style={{ padding: "4px 8px" }}>
              <StatusBadge status={repo_scan_state_to_badge_status(repos_scan_state[name], available_presets.by_repo_path.get(name)?.size ?? 0)} />
            </td>
            <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>
              <VscodeButton
                appearance="secondary"
                onClick={() => handle_reload(name)}
                title="Re-scan this repository for preset templates (uses cached checkout)"
                style={{ marginRight: "4px" }}
                disabled={repos_scan_state[name]?.status === "loading"}
              >
                Reload
              </VscodeButton>
              <VscodeButton
                appearance="secondary"
                onClick={() => handle_update(name)}
                title="Delete the cached checkout and re-clone from remote to get the latest changes"
                style={{ marginRight: "4px" }}
                disabled={repos_scan_state[name]?.status === "loading"}
              >
                Update
              </VscodeButton>
              <VscodeButton
                appearance="secondary"
                onClick={() => handle_edit_start(name)}
                style={{ marginRight: "4px" }}
              >
                Edit
              </VscodeButton>
              <VscodeButton appearance="secondary" onClick={() => handle_remove(name)}>
                Remove
              </VscodeButton>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EditForm({
  form,
  is_adding,
  set_form,
  handle_add,
  handle_edit_save,
  handle_edit_cancel,
}: {
  form: { name: string; origin: string; rev: string };
  is_adding: boolean;
  set_form: React.Dispatch<React.SetStateAction<{ name: string; origin: string; rev: string }>>;
  handle_add: () => void;
  handle_edit_save: () => void;
  handle_edit_cancel: () => void;
}) {
  return (<div style={{ display: "grid", gridTemplateColumns: "1fr 2fr 1fr auto", gap: "6px", alignItems: "end" }}>
    <div>
      <VscodeTextField
        value={form.name}
        disabled={!is_adding}
        placeholder="Repository name"
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => set_form((f) => ({ ...f, name: e.target.value }))}
        style={{ width: "100%", boxSizing: "border-box" }}
      >name</VscodeTextField>
    </div>
    <div>
      <VscodeTextField
        placeholder="https://github.com/org/repo.git"
        value={form.origin}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => set_form((f) => ({ ...f, origin: e.target.value }))}
        style={{ width: "100%", boxSizing: "border-box" }}
      >Origin URL</VscodeTextField>
    </div>
    <div>
      <VscodeTextField
        placeholder="Branch, tag, or commit SHA"
        value={form.rev}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => set_form((f) => ({ ...f, rev: e.target.value }))}
        style={{ width: "100%", boxSizing: "border-box" }}
      >Ref</VscodeTextField>
    </div>
    <div style={{ display: "flex", gap: "4px" }}>
      {is_adding ? (
        <VscodeButton
          appearance="primary"
          onClick={handle_add}
          disabled={!form.name.trim() || !form.origin.trim() || !form.rev.trim()}
        >
          Add
        </VscodeButton>
      ) : (
        <>
          <VscodeButton appearance="primary" onClick={handle_edit_save} disabled={!form.origin.trim() || !form.rev.trim()}>
            Save
          </VscodeButton>
          <VscodeButton appearance="secondary" onClick={handle_edit_cancel}>
            Cancel
          </VscodeButton>
        </>
      )}
    </div>
  </div>);
}

/** Maps a RepoScanState to the generic StatusBadgeState used by StatusBadge. */
function repo_scan_state_to_badge_status(scanState: RepoScanState | undefined, totalFiles: number): StatusBadgeState {
  const s = scanState ?? { status: "idle" };
  switch (s.status) {
    case "idle": return { kind: "idle" };
    case "loading": return { kind: "loading", label: "Scanning…" };
    case "success": {
      const n = s.templateCount;
      const skipped = totalFiles - n;
      return {
        kind: "success",
        label: <VscodeBadge>{n}</VscodeBadge>,
        detail: skipped > 0 ? `(${skipped} skipped)` : undefined,
      };
    }
    case "error": return { kind: "error", message: s.message };
  }
}
