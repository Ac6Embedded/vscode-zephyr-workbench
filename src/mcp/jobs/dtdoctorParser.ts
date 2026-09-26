// The diagnoses DT Doctor adds to a build log. With ZEPHYR_SCA_VARIANT=dtdoctor
// every compile and link goes through Zephyr's dtdoctor_sca_wrapper.py, which,
// when a command fails on a __device_dts_ord_<n> symbol, prints what
// scripts/dts/dtdoctor_analyzer.py found about that devicetree node as a
// one-column tabulate grid headed "DT Doctor". vscode-free, so it is unit
// tested on captured output.

import { parseGridTables } from './gridTable';

export interface DtDoctorFinding {
  /**
   * disabled_node: the node is referenced but its status is not okay;
   * no_driver: the node is enabled but no driver was built for it.
   */
  kind: 'disabled_node' | 'no_driver' | 'other';
  /** Devicetree path, such as /soc/serial@40011000. */
  node?: string;
  /** The node's first label, when it has one. */
  label?: string;
  /** Where the status property that disables the node is set. */
  status_set_at?: { file: string; line: number };
  /** Nodes that depend on this one. */
  required_by?: string[];
  /** chosen properties that name the node. */
  chosen?: string[];
  aliases?: string[];
  /** Kconfig options DT Doctor suggests enabling, such as CONFIG_I2C=y. */
  kconfig_options?: string[];
  /** DT Doctor's own advice sentence. */
  advice?: string;
  /** The whole diagnosis as DT Doctor printed it. */
  text: string;
}

const NODE = /^(?:(.+?): )?(\/\S*)$/;

function nodeOf(finding: DtDoctorFinding, quoted: string): void {
  const match = NODE.exec(quoted);
  if (match) {
    finding.node = match[2];
    if (match[1]) {
      finding.label = match[1];
    }
  } else {
    finding.node = quoted;
  }
}

/** Quoted names in a sentence such as: It is referenced by the following aliases: 'led0', 'sw0'. */
function quotedNames(text: string): string[] {
  return [...text.matchAll(/'([^']+)'/g)].map(match => match[1]);
}

function interpret(text: string): DtDoctorFinding {
  const finding: DtDoctorFinding = { kind: 'other', text };
  const lines = text.split('\n').map(line => line.trim());
  let list: string[] | undefined;
  for (const line of lines) {
    if (!line) {
      continue;
    }
    const disabled = /^'(.+)' is disabled in (.+):(\d+)$/.exec(line);
    const enabled = /^'(.+)' is enabled but no driver appears to be available for it\.?$/.exec(line);
    if (disabled) {
      finding.kind = 'disabled_node';
      nodeOf(finding, disabled[1]);
      finding.status_set_at = { file: disabled[2], line: Number(disabled[3]) };
      list = undefined;
    } else if (enabled) {
      finding.kind = 'no_driver';
      nodeOf(finding, enabled[1]);
      list = undefined;
    } else if (/^The following nodes depend on it:?$/.test(line)) {
      list = finding.required_by = [];
    } else if (/^Try enabling these Kconfig options:?$/.test(line)) {
      list = finding.kconfig_options = [];
    } else if (list && /^-\s+\S/.test(line)) {
      list.push(line.replace(/^-\s+/, ''));
    } else if (/referenced as a "chosen" in/.test(line)) {
      finding.chosen = quotedNames(line.slice(line.indexOf(' in ') + 4));
      list = undefined;
    } else if (/referenced by the following aliases:/.test(line)) {
      finding.aliases = quotedNames(line.slice(line.indexOf(':') + 1));
      list = undefined;
    } else {
      // "Try enabling the node ..." or "Could not determine compatible ...".
      finding.advice = finding.advice ? `${finding.advice} ${line}` : line;
      list = undefined;
    }
  }
  return finding;
}

/**
 * Every DT Doctor diagnosis in `output`, once each: the wrapper runs for every
 * failing compile and link, so the same node is usually diagnosed several times.
 */
export function parseDtDoctor(output: string): DtDoctorFinding[] {
  const findings: DtDoctorFinding[] = [];
  const seen = new Set<string>();
  for (const table of parseGridTables(output)) {
    if (table.headers.length !== 1 || table.headers[0] !== 'DT Doctor') {
      continue;
    }
    for (const [cell] of table.rows) {
      const text = (cell ?? '').trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        findings.push(interpret(text));
      }
    }
  }
  return findings;
}
