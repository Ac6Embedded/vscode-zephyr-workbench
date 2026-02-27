import React, { JSX } from "react";
import { WebviewMessage } from "../../../utils/eclairEvent";
import { AvailablePresetsState, BUGSENG_REPO_LINK, EclairConfig, EclairStateAction, RepoScanState } from "../state";
import { Monospace, RichHelpTooltip, VscodeRadio, VscodeRadioGroup } from "./common_components";
import { RulesetSection } from "./main_configuration/ruleset_section";
import { CustomEclSection } from "./main_configuration/custom_ecl";
import { PresetSelection } from "./main_configuration/preset_selection";
import { EclairRepos, EclairScaConfigType } from "../../../utils/eclair/config";


export function MainAnalysisConfigurationSection({
  workspace,
  build_config,
  available_presets,
  repos,
  repos_scan_state,
  current,
  dispatch_state,
  post_message,
}: {
  workspace: string;
  build_config: string;
  available_presets: AvailablePresetsState;
  repos: EclairRepos;
  repos_scan_state: Record<string, RepoScanState>;
  current: EclairConfig,
  dispatch_state: React.Dispatch<EclairStateAction>;
  post_message: (message: WebviewMessage) => void;
}) {
  const rulesets: EclairScaConfigType[] = ["preset", "custom-ecl", "zephyr-ruleset"];

  return (
    <div className="section">
      <h2>Main Analysis Configuration</h2>

      <VscodeRadioGroup
        orientation="vertical"
        value={current.main_config.type}
        onChange={(e: any) => {
          const type = e.target.value as EclairScaConfigType;
          dispatch_state({
            type: "with-selected-workspace",
            action: {
              type: "with-selected-configuration",
              action: { type: "update-configuration-type", configurationType: type },
            },
          });
        }}
      >
        {rulesets.map((r) => (
          <VscodeRadio key={r} name="ruleset" value={r}>
            <strong>{r}</strong>: {RULESET_DESCRIPTION[r as keyof typeof RULESET_DESCRIPTION]}
          </VscodeRadio>
        ))}
      </VscodeRadioGroup>

      {current.main_config.type === "zephyr-ruleset" && (
        <RulesetSection
          workspace={workspace}
          build_config={build_config}
          ruleset={current.main_config.ruleset}
          dispatch_state={dispatch_state}
          post_message={post_message}
        />
      )}

      {current.main_config.type === "preset" && (
        <PresetSelection
          workspace={workspace}
          build_config={build_config}
          state={current.main_config.state}
          available_presets={available_presets}
          repos={repos}
          repos_scan_state={repos_scan_state}
          dispatch_state={dispatch_state}
          post_message={post_message}
        />
      )}

      {current.main_config.type === "custom-ecl" && (
        <CustomEclSection
          workspace={workspace}
          build_config={build_config}
          state={current.main_config.state}
          dispatch_state={dispatch_state}
          post_message={post_message}
        />
      )}
    </div>
  );
}

const ZEPHYR_ECLAIR_URL = "https://docs.zephyrproject.org/latest/develop/sca/eclair.html";
const ZEPHYR_CODING_GUIDELINES_URL = "https://docs.zephyrproject.org/latest/contribute/coding_guidelines/index.html";

const RULESET_DESCRIPTION: Record<EclairScaConfigType, JSX.Element> = {
  "preset": <>
    Use a preset configuration based on rulesets, variants and tailorings
    <RichHelpTooltip>
      <p>
        Allows to use a combination of <b>rulesets</b>, <b>variants</b>, and <b>tailorings</b> from a set of templates.
      </p>
      <p>
      The presets are ECL files with attached metadata that can be combined to create a flexible, configurable and reusable analysis configuration.
      </p>
      <p>
        Presets are stored in Git repositories that are managed in the <i>Preset Repositories</i> section below. They can also be loaded from individual ECL files using the <i>Custom ECL</i> option.
      </p>
      <p>
        See also:
      </p>
      <ul>
        <li>{BUGSENG_REPO_LINK}: the reference repository for Eclair SCA presets for Zephyr projects, maintained by BUGSENG</li>
      </ul>
    </RichHelpTooltip>
  </>,
  "custom-ecl": <>
    Provide a custom ECL (<Monospace>.ecl</Monospace>) file
    <RichHelpTooltip>
      <p>
        Allows to use a custom ECL file as the analysis configuration. The ECL file must be provided by the user and follow the expected format for Eclair SCA analysis configurations.
      </p>
      <p>
        This option is useful when you already have a valid configuration for your project that you want to reuse with this interface
      </p>
    </RichHelpTooltip>
  </>,
  "zephyr-ruleset": <>
    Use a builtin Zephyr ruleset
    <RichHelpTooltip>
      <p>
        Zephyr supports an upstream <a href={ZEPHYR_ECLAIR_URL}>integration</a> with ECLAIR.
      </p>
      <p>
        This integration offers a predefined set of configuration that are used by the Zephyr project and are kept up to date by the Zephyr maintainers.
      </p>
      <p>
        See also:
      </p>
      <ul>
        <li><a href={ZEPHYR_ECLAIR_URL}>Zephyr ECLAIR Support</a></li>
        <li><a href={ZEPHYR_CODING_GUIDELINES_URL}>Zephyr Coding Guidelines</a></li>
      </ul>
    </RichHelpTooltip>
  </>,
};
