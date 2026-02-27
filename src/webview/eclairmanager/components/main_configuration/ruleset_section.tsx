import React, { useEffect, useState } from "react";
import { ZephyrRulesetState, EclairStateAction } from "../../state";
import { PickPath, VscodeButton, VscodeRadio, VscodeRadioGroup, VscodeTextField } from "../common_components";
import { WebviewMessage } from "../../../../utils/eclairEvent";

export function RulesetSection(props: {
  config_key: number;
  workspace: string;
  build_config: string;
  ruleset: ZephyrRulesetState;
  dispatch_state: React.Dispatch<EclairStateAction>;
  post_message: (message: WebviewMessage) => void;
}) {
  const rulesets = [
    "ECLAIR_RULESET_FIRST_ANALYSIS",
    "ECLAIR_RULESET_STU",
    "ECLAIR_RULESET_STU_HEAVY",
    "ECLAIR_RULESET_WP",
    "ECLAIR_RULESET_STD_LIB",
    "ECLAIR_RULESET_ZEPHYR_GUIDELINES",
    "USER",
  ];

  const showUserFields = props.ruleset.selected === "USER";
  const [nameEditing, setNameEditing] = useState(false);

  useEffect(() => {
    setNameEditing(false);
  }, [props.config_key]);

  useEffect(() => {
    if (!showUserFields) {
      setNameEditing(false);
    }
  }, [showUserFields]);

  return (
    <div className="section">
      <h2>Rulesets</h2>
      <VscodeRadioGroup
        orientation="vertical"
        value={props.ruleset.selected}
        onChange={(e: any) => props.dispatch_state({
          type: "with-selected-workspace",
          action: {
            type: "with-selected-configuration",
            action: { type: "update-ruleset-selection", ruleset: e.target.value },
          },
        })}
      >
        {rulesets.map((r) => (
          <VscodeRadio key={r} name="ruleset" value={r}>
            {r === "USER" ? "user defined" : r}
          </VscodeRadio>
        ))}
      </VscodeRadioGroup>
      <div className={`grid-group-div ${showUserFields ? "" : "hidden"}`}>
        <VscodeTextField
          className="details-path-field"
          placeholder="Ruleset name (e.g. MYRULESET)"
          size="30"
          value={props.ruleset.userRulesetName}
          disabled={!nameEditing}
          onChange={(e: any) => props.dispatch_state({
            type: "with-selected-workspace",
            action: {
              type: "with-selected-configuration",
              action: { type: "update-user-ruleset-name", name: e.target.value },
            },
          })}
          onKeyDown={(e: any) => {
            if (e.key === "Enter" && nameEditing) {
              setNameEditing(false);
            }
          }}
        >
          Ruleset Name:
        </VscodeTextField>
        <VscodeButton appearance="primary" onClick={() => setNameEditing((v) => !v)}>
          {nameEditing ? "Done" : "Edit"}
        </VscodeButton>
        <PickPath
          value={props.ruleset.userRulesetPath || ""}
          name="Ruleset file"
          placeholder="path/to/analysis_config.ecl"
          on_selected={(value) => props.dispatch_state({
            type: "with-selected-workspace",
            action: {
              type: "with-selected-configuration",
              action: { type: "update-user-ruleset-path", path: value },
            },
          })}
          on_pick={() => props.post_message({ command: "browse-user-ruleset-path", workspace: props.workspace, build_config: props.build_config })}
        />
      </div>
    </div>
  );
}
