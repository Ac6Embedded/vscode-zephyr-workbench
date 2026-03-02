import React from "react";
import { StatusState, InstallPathState, EclairStateAction } from "../state";
import { VscodeButton, PickPath } from "./common_components";
import { WebviewMessage } from "../../../utils/eclairEvent";
import { useRpc } from "../rpc.js";

export function Summary(props: {
  status: StatusState;
  installPath: InstallPathState;
  post_message: (message: WebviewMessage) => void;
  dispatch_state: React.Dispatch<EclairStateAction>;
}) {
  const statusIcon = props.status.installed ? "codicon-check success-icon" : "codicon-warning warning-icon";
  const statusText = props.status.installed ? "Installed" : "Not installed";

  const post_message = props.post_message;
  const rpc = useRpc();

  return (
    <div className="summary">
      <div className="summary-title"><strong>ECLAIR</strong></div>
      <div>
        <strong>Version:</strong> <span>{props.status.version}</span>
        &nbsp;|&nbsp;
        <strong>Status:</strong>{" "}
        <span className={`codicon ${statusIcon}`}></span> <span>{statusText}</span>
        <span
          className={`codicon codicon-loading codicon-modifier-spin ${props.status.showSpinner ? "" : "hidden"}`}
          title="Detecting ECLAIR"
        ></span>
      </div>
      <div className="summary-actions">
        <div className="actions-title"><strong>Actions</strong></div>
        <VscodeButton appearance="primary" onClick={() => post_message({ command: "probe-eclair" })}>
          Refresh Status
        </VscodeButton>
        <VscodeButton appearance="primary" onClick={() => post_message({ command: "about-eclair" })}>
          About ECLAIR
        </VscodeButton>
        <VscodeButton appearance="primary" onClick={() => post_message({ command: "manage-license" })}>
          Manage ECLAIR License
        </VscodeButton>
        <VscodeButton appearance="primary" onClick={() => post_message({ command: "request-trial" })}>
          Request Trial License
        </VscodeButton>
      </div>
      <PickPath
        value={props.installPath.path}
        placeholder={props.installPath.placeholder}
        on_selected={(newPath) => {
          props.dispatch_state({ type: "update-install-path", path: newPath });
          props.post_message({
            command: "update-path",
            newPath: newPath.trim(),
          });
        }}
        on_pick={async () => {
          const result = await rpc.call("open-dialog", {
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: "Select the ECLAIR installation",
            defaultUri: props.installPath.path || undefined,
          });
          if (result?.canceled || !result?.paths?.[0]) {
            return;
          }
          const picked = String(result.paths[0]);
          props.dispatch_state({ type: "update-install-path", path: picked });
          props.post_message({
            command: "update-path",
            newPath: picked.trim(),
          });
        }}
      />
    </div>
  );
}
