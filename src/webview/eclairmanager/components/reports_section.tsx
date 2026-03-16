import React from "react";
import { ReportsState, EclairStateAction } from "../state";
import { RichHelpTooltip, VscodeCheckbox } from "./common_components";
import { ZEPHYR_ECLAIR_REPORTS_URL } from "../docs";

export function ReportsSection(props: {
  reports: ReportsState;
  dispatch_state: React.Dispatch<EclairStateAction>;
}) {
  const reports = [
    "ALL",
    "ECLAIR_METRICS_TAB",
    "ECLAIR_REPORTS_TAB",
    "ECLAIR_REPORTS_SARIF",
    "ECLAIR_SUMMARY_TXT",
    "ECLAIR_SUMMARY_DOC",
    "ECLAIR_SUMMARY_ODT",
    "ECLAIR_SUMMARY_HTML",
    "ECLAIR_FULL_TXT",
    "ECLAIR_FULL_DOC",
    "ECLAIR_FULL_ODT",
    "ECLAIR_FULL_HTML",
  ];

  return (
    <div className="section">
      <h2>
        Reports
        <RichHelpTooltip>
          <p>
            Select which ECLAIR reports to generate for the analysis run. Output formats include summary and full reports, as well as metrics and SARIF.
          </p>
          <p>
            See also <a href={ZEPHYR_ECLAIR_REPORTS_URL}>Generate additional report formats</a> from the Zephyr documentation.
          </p>
        </RichHelpTooltip>
      </h2>
      <div className="panel-lead">
        Pick the report outputs that should be generated after analysis completes.
      </div>
      <div className="checkbox-grid">
        {reports.map((r) => (
          <label key={r}>
            <VscodeCheckbox
              className="report-chk"
              value={r}
              checked={props.reports.selected.includes(r)}
              onChange={(e: any) => props.dispatch_state({
                type: "with-selected-workspace",
                action: {
                  type: "with-selected-configuration",
                  action: { type: "toggle-report", report: r, checked: e.target.checked },
                },
              })}
            >
              {r}
            </VscodeCheckbox>
          </label>
        ))}
      </div>
    </div>
  );
}
