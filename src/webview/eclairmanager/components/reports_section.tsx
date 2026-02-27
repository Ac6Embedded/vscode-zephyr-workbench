import React from "react";
import { ReportsState, EclairStateAction } from "../state";
import { VscodeCheckbox } from "./common_components";

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
      <h2>Reports</h2>
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
