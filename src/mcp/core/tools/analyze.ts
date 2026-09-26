// analyze: the analysis builds of a configuration.

import { z } from 'zod';
import { ToolMeta } from '../toolSpec';
import { appPath, configName, waitSec } from './shared';

export const ANALYZE: ToolMeta = {
  name: 'analyze',
  title: 'Analyze a build configuration',
  summary: 'Runs an analysis in a VS Code terminal: DT Doctor, the Kconfig hardening check, an SPDX SBOM or ECLAIR.',
  description: [
    'Runs an analysis of one build configuration in a visible VS Code task terminal, the same ones the Zephyr Workbench applications view offers: dt_doctor (the devicetree static analysis build), hardenconfig (the Kconfig security hardening check), spdx (an SPDX 2.3 or 3.0 software bill of materials) and eclair (the ECLAIR static analysis, when ECLAIR is installed).',
    'Use it for devicetree problems build_app does not explain, before shipping to review hardening, to produce an SBOM, or to run a MISRA and coding guideline analysis; read ECLAIR findings afterwards with get_diagnostics source sca.',
    'analysis picks the run, app_path and config_name the build, spdx_version and include_sdk shape the SBOM, and sca_config (a saved ECLAIR configuration) or ruleset with reports shape the ECLAIR run; dt_doctor and eclair leave their analysis switched on in the build folder until a pristine build.',
    'Returns a job: when status is "running" poll job with the job_id; a finished job carries the diagnostics of the run and, under result, the findings, the hardening table, the SBOM documents or the ECLAIR summary and report paths.',
  ].join(' '),
  inputSchema: z.object({
    analysis: z.enum(['dt_doctor', 'hardenconfig', 'spdx', 'eclair']).describe(
      'dt_doctor: devicetree static analysis build; hardenconfig: Kconfig hardening report; spdx: software bill of materials; eclair: ECLAIR static analysis.'),
    app_path: appPath,
    config_name: configName,
    spdx_version: z.enum(['auto', '2.3', '3.0']).optional().describe(
      'spdx only: the SPDX version, auto (the default) picks 3.0 when the Zephyr version supports it.'),
    include_sdk: z.boolean().optional().describe(
      'spdx only: also describe the Zephyr SDK in the SBOM. Defaults to the workbench setting.'),
    sca_config: z.string().optional().describe(
      'eclair only: name of an ECLAIR configuration saved for the application in the ECLAIR Manager. An unknown name is an error that lists the saved ones.'),
    ruleset: z.enum(['ECLAIR_RULESET_FIRST_ANALYSIS', 'ECLAIR_RULESET_STU', 'ECLAIR_RULESET_STU_HEAVY', 'ECLAIR_RULESET_WP', 'ECLAIR_RULESET_STD_LIB', 'ECLAIR_RULESET_ZEPHYR_GUIDELINES']).optional().describe(
      'eclair only, instead of sca_config: the ECLAIR ruleset to run.'),
    reports: z.array(z.string()).max(20).optional().describe(
      'eclair only, with ruleset: extra report formats to produce. SARIF is always produced so get_diagnostics can read the findings.'),
    wait_sec: waitSec,
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  category: 'action',
  toolsets: ['core'],
};
