import React from "react";
import { ReportServerState } from "../state";
import { VscodeButton } from "./common_components";
import { WebviewMessage } from "../../../utils/eclairEvent";

export function ReportViewerSection(props: {
  reportServer: ReportServerState;
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
            if (props.reportServer.running) {
              props.post_message({ command: "stop-report-server" });
            }
            props.post_message({ command: "start-report-server", workspace: props.workspace, build_config: props.build_config });
          }}
        >
          <span className="codicon codicon-preview"></span> Open Report Viewer
        </VscodeButton>
        <VscodeButton
          appearance="secondary"
          disabled={!props.reportServer.running}
          onClick={() => props.post_message({ command: "stop-report-server" })}
        >
          <span className="codicon codicon-debug-stop"></span> Stop Report Server
        </VscodeButton>
      </div>
    </div>
  );
}
