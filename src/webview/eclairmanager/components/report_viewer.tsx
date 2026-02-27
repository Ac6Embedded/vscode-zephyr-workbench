import React from "react";
import { VscodeButton } from "./common_components";
import { WebviewMessage } from "../../../utils/eclairEvent";

export function ReportViewerSection(props: {
  workspace: string;
  build_config: string;
  post_message: (message: WebviewMessage) => void;
}) {
  return (
    <div className="section">
      <h2>Report Viewer</h2>
      <div className="grid-group-div command-actions">
        <VscodeButton
          appearance="primary"
          onClick={() => {
            props.post_message({ command: "start-report-server", workspace: props.workspace, build_config: props.build_config });
          }}
        >
          <span className="codicon codicon-preview"></span> Open Report Viewer
        </VscodeButton>
      </div>
    </div>
  );
}
