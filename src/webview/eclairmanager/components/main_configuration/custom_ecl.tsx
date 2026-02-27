import React from "react";
import { WebviewMessage } from "../../../../utils/eclairEvent";
import { CustomEclState, EclairStateAction } from "../../state";
import { PickPath } from "../common_components";

export function CustomEclSection({
  state,
  dispatch_state,
  post_message,
  workspace,
  build_config,
}: {
  state: CustomEclState;
  dispatch_state: React.Dispatch<EclairStateAction>;
  post_message: (message: WebviewMessage) => void;
  workspace: string;
  build_config: string;
}) {
  return (<>
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <PickPath
        value={state.ecl || ""}
        name="ECL file"
        placeholder="path/to/analysis_config.ecl"
        on_selected={(value) => dispatch_state({
          type: "with-selected-workspace",
          action: {
            type: "with-selected-configuration",
            action: { type: "update-custom-ecl-path", path: value },
          },
        })}
        on_pick={() => post_message({ command: "browse-custom-ecl-path", workspace, build_config })}
      />
    </div>
  </>);
}
