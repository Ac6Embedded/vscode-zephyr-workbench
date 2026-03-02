import React from "react";
import { ExtraConfigState, EclairStateAction } from "../state";
import { PickPath } from "./common_components";
import { useRpc } from "../rpc.js";

export function ExtraConfigSection(props: {
  extra_config: ExtraConfigState;
  dispatch_state: React.Dispatch<EclairStateAction>;
}) {
  const rpc = useRpc();

  return (
    <div className="section">
      <h2>Additional Configuration (.ecl)</h2>
      <PickPath
        value={props.extra_config.path}
        placeholder="path/to/config"
        on_selected={(newPath) => {
          props.dispatch_state({
            type: "with-selected-workspace",
            action: {
              type: "with-selected-configuration",
              action: { type: "update-extra-config-path", path: newPath },
            },
          });
        }}
        on_pick={async () => {
          const result = await rpc.call("open-dialog", {
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            title: "Select the additional configuration",
            defaultUri: props.extra_config.path || undefined,
          });
          if (result?.canceled || !result?.paths?.[0]) {
            return;
          }
          const picked = String(result.paths[0]);
          props.dispatch_state({
            type: "with-selected-workspace",
            action: {
              type: "with-selected-configuration",
              action: { type: "update-extra-config-path", path: picked },
            },
          });
        }}
      />
    </div>
  );
}
