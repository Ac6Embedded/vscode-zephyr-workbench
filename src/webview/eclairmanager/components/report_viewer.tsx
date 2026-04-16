import React from "react";
import { RichHelpTooltip, VscodeButton } from "./common_components";
import { WebviewMessage } from "../../../utils/eclair/eclairEvent";

export function ReportViewerSection(props: {
  workspace: string;
  build_config?: string;
  post_message: (message: WebviewMessage) => void;
}) {
  return (
    <div className="section">
      <h2>
        Report Viewer
        <RichHelpTooltip>Opens the report viewer for the current build configuration, so you can review findings in a browser.</RichHelpTooltip>
      </h2>
      <div className="panel-lead">
        Launch the built-in viewer to inspect the generated ECLAIR reports.
      </div>
      <div className="grid-group-div command-actions">
        <VscodeButton
          appearance="primary"
          disabled={!props.build_config}
          onClick={() => {
            if (!props.build_config) {
              console.error("Cannot open report viewer: build configuration is missing");
              return;
            }
            props.post_message({ command: "start-report-server", workspace: props.workspace, build_config: props.build_config });
          }}
        >
          <span className="codicon codicon-preview"></span> Open Report Viewer
        </VscodeButton>
      </div>
    </div>
  );
}
