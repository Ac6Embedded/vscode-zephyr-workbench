// Reads a SARIF 2.1 log, the format ECLAIR writes its findings in
// (build/<config>/sca/eclair/reports.sarif), into flat findings an agent can
// filter and page through. Only the parts every producer fills are read:
// runs[].results[] with their rule, level, message and first physical
// location. vscode-free, so it is unit tested on fixtures.

import * as path from 'path';
import { fileURLToPath } from 'url';
import { isInside } from './argSafety';

export type SarifSeverity = 'error' | 'warning' | 'info';

export interface SarifFinding {
  rule: string;
  severity: SarifSeverity;
  /** The SARIF level as written, or the SARIF default when absent. */
  level: string;
  message: string;
  /** Absolute when the log says where the file is, else the path as written. */
  file?: string;
  line?: number;
  column?: number;
}

export interface SarifLog {
  /** The tool that wrote each run, such as ECLAIR. */
  tools: string[];
  findings: SarifFinding[];
  /** Short descriptions of the rules the log defines, by rule id. */
  rules: Record<string, string>;
}

/** Why a SARIF file could not be read. */
export class SarifError extends Error {}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const positive = (value: unknown): number | undefined =>
  (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined);

const SEVERITY: Record<string, SarifSeverity> = { error: 'error', warning: 'warning', note: 'info', none: 'info' };

/** A file:// URI or a plain path, as a path on this machine. */
function uriToPath(uri: string): string | undefined {
  if (/^file:/i.test(uri)) {
    try {
      return fileURLToPath(uri);
    } catch {
      return undefined;
    }
  }
  // Another scheme is not a file on this machine.
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(uri)) {
    return undefined;
  }
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}

/** The folder a uriBaseId stands for, following its own base a few levels at most. */
function baseOf(run: Json, id: string | undefined, depth = 0): string | undefined {
  if (!id || depth > 4) {
    return undefined;
  }
  const bases = isObject(run.originalUriBaseIds) ? run.originalUriBaseIds : {};
  const entry = bases[id];
  if (!isObject(entry)) {
    return undefined;
  }
  const uri = text(entry.uri);
  const own = uri ? uriToPath(uri) : undefined;
  if (own && path.isAbsolute(own)) {
    return own;
  }
  const parent = baseOf(run, text(entry.uriBaseId), depth + 1);
  return parent && own !== undefined ? path.join(parent, own) : parent;
}

function locationOf(run: Json, result: Json): Pick<SarifFinding, 'file' | 'line' | 'column'> {
  const locations = Array.isArray(result.locations) ? result.locations : [];
  const physical = locations.map(location => (isObject(location) ? location.physicalLocation : undefined)).find(isObject);
  if (!physical) {
    return {};
  }
  const artifact = isObject(physical.artifactLocation) ? physical.artifactLocation : {};
  const region = isObject(physical.region) ? physical.region : {};
  const uri = text(artifact.uri);
  let file = uri ? uriToPath(uri) : undefined;
  if (file !== undefined && !path.isAbsolute(file)) {
    const base = baseOf(run, text(artifact.uriBaseId));
    if (base) {
      file = path.join(base, file);
    }
  }
  return {
    ...(file !== undefined ? { file } : {}),
    ...(positive(region.startLine) ? { line: positive(region.startLine) } : {}),
    ...(positive(region.startColumn) ? { column: positive(region.startColumn) } : {}),
  };
}

/** The message text, filling a messageStrings template of the rule when the result only names one. */
function messageOf(result: Json, rule: Json | undefined): string {
  const message = isObject(result.message) ? result.message : {};
  const direct = text(message.text) ?? text(message.markdown);
  if (direct !== undefined) {
    return direct;
  }
  const id = text(message.id);
  const strings = rule && isObject(rule.messageStrings) ? rule.messageStrings : {};
  const template = id && isObject(strings[id]) ? text(strings[id].text) : undefined;
  if (template === undefined) {
    return '';
  }
  const args = Array.isArray(message.arguments) ? message.arguments.map(arg => String(arg)) : [];
  return template.replace(/\{(\d+)\}/g, (all, index: string) => args[Number(index)] ?? all);
}

function ruleDescription(rule: Json): string | undefined {
  for (const key of ['shortDescription', 'fullDescription']) {
    const value = rule[key];
    if (isObject(value) && text(value.text)) {
      return text(value.text);
    }
  }
  return text(rule.name);
}

/** Parse the text of a SARIF 2.1 log. Throws SarifError when it is not one. */
export function readSarif(content: string): SarifLog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new SarifError(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(parsed) || !Array.isArray(parsed.runs)) {
    throw new SarifError('not a SARIF log: there is no runs array');
  }
  const log: SarifLog = { tools: [], findings: [], rules: {} };
  for (const run of parsed.runs) {
    if (!isObject(run)) {
      continue;
    }
    const driver = isObject(run.tool) && isObject(run.tool.driver) ? run.tool.driver : {};
    const toolName = text(driver.name);
    if (toolName && !log.tools.includes(toolName)) {
      log.tools.push(toolName);
    }
    const rules = (Array.isArray(driver.rules) ? driver.rules : []).filter(isObject);
    for (const rule of rules) {
      const id = text(rule.id);
      const description = ruleDescription(rule);
      if (id && description && !(id in log.rules)) {
        log.rules[id] = description;
      }
    }
    for (const result of Array.isArray(run.results) ? run.results : []) {
      if (!isObject(result)) {
        continue;
      }
      const index = typeof result.ruleIndex === 'number' ? result.ruleIndex : -1;
      const byIndex = index >= 0 ? rules[index] : undefined;
      const ruleRef = isObject(result.rule) ? result.rule : undefined;
      const ruleId = text(result.ruleId) ?? text(ruleRef?.id) ?? text(byIndex?.id) ?? '';
      const rule = byIndex ?? rules.find(candidate => candidate.id === ruleId);
      // SARIF: a result with no level is a warning, unless its kind says it is not a failure.
      const kind = text(result.kind);
      const level = text(result.level) ?? (kind && kind !== 'fail' ? 'none' : 'warning');
      log.findings.push({
        rule: ruleId,
        severity: SEVERITY[level] ?? 'warning',
        level,
        message: messageOf(result, rule),
        ...locationOf(run, result),
      });
    }
  }
  return log;
}

export interface SarifFilter {
  /** Keeps findings whose rule id this predicate accepts. */
  rule?: (ruleId: string) => boolean;
  /** An absolute folder (findings in files under it) or a fragment of the path. */
  pathPrefix?: string;
  severity?: 'error' | 'warning' | 'all';
}

/** The findings that pass every filter given. */
export function filterFindings(findings: readonly SarifFinding[], filter: SarifFilter): SarifFinding[] {
  const prefix = filter.pathPrefix;
  const absolute = !!prefix && path.isAbsolute(prefix);
  const fragment = prefix?.replace(/\\/g, '/').toLowerCase();
  return findings.filter(finding => {
    if (filter.rule && !filter.rule(finding.rule)) {
      return false;
    }
    if (filter.severity && filter.severity !== 'all' && finding.severity !== filter.severity) {
      return false;
    }
    if (prefix) {
      if (!finding.file) {
        return false;
      }
      if (absolute ? !isInside(finding.file, prefix) : !finding.file.replace(/\\/g, '/').toLowerCase().includes(fragment as string)) {
        return false;
      }
    }
    return true;
  });
}

/** Findings per rule, most frequent first. */
export function countByRule(findings: readonly SarifFinding[]): { rule: string; count: number; errors: number; warnings: number }[] {
  const counts = new Map<string, { rule: string; count: number; errors: number; warnings: number }>();
  for (const finding of findings) {
    const entry = counts.get(finding.rule) ?? { rule: finding.rule, count: 0, errors: 0, warnings: 0 };
    entry.count++;
    if (finding.severity === 'error') { entry.errors++; }
    if (finding.severity === 'warning') { entry.warnings++; }
    counts.set(finding.rule, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
}
