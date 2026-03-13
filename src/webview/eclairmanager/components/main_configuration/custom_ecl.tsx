import React from "react";
import { CustomEclState, EclairStateAction } from "../../state";
import { PickPath } from "../common_components";
import { useRpc } from "../../rpc";

export function CustomEclSection({
  state,
  dispatch_state,
}: {
  state: CustomEclState;
  dispatch_state: React.Dispatch<EclairStateAction>;
}) {
  const rpc = useRpc();

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
        on_pick={async () => {
          const result = await rpc.call("open-dialog", {
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            title: "Select the ECL configuration",
            defaultUri: state.ecl || undefined,
          });
          if (result?.canceled || !result?.paths?.[0]) {
            return;
          }
          const picked = String(result.paths[0]);
          dispatch_state({
            type: "with-selected-workspace",
            action: {
              type: "with-selected-configuration",
              action: { type: "update-custom-ecl-path", path: picked },
            },
          });
        }}
      />
    </div>
  </>);
}
