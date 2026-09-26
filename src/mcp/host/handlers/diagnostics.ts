// Structured errors and warnings, from the places they can come from: the last
// agent build of a configuration, the VS Code Problems panel, which also covers
// builds the user started by hand and language-server findings, and the SARIF
// report of the last ECLAIR analysis. open_files lets the language servers
// check files the agent just wrote before their problems are read.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { eclairOutputDir } from '../../../utils/eclair/analysis';
import { getDomainBuildDir, readDomainsForBuildDir } from '../../../utils/zephyr/domainsYamlUtils';
import { assertInside, isInside } from '../../core/argSafety';
import { McpToolError } from '../../core/errors';
import { matcherFor } from '../../core/match';
import { countByRule, filterFindings, readSarif, SarifError } from '../../core/sarifReader';
import { ToolContext, ToolHandler } from '../../core/toolSpec';
import { awaitingReport } from '../documentChecks';
import { HostDeps } from './deps';

type Ctx = ToolContext<HostDeps>;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

const SOURCES = ['last_build', 'problems_panel', 'both', 'sca'];
const SEVERITIES = ['error', 'warning', 'all'];
/** Arguments that only filter or page ECLAIR findings. */
const SCA_ONLY = ['rule', 'path_prefix', 'offset'];

/** Files open_files may open in one call. */
const MAX_OPEN_FILES = 10;
/** How long open_files waits for the language servers to report on the files. */
const OPEN_WAIT_MS = 3000;
/** Quiet time after the last diagnostics change on the files before reading them. */
const SETTLE_MS = 400;
/** Characters of the ECLAIR overall summary returned. */
const MAX_SUMMARY_CHARS = 2000;
/** Rules listed with their counts for the matching ECLAIR findings. */
const MAX_RULES = 20;

const DTS_LSP_EXTENSION = 'KyleMicallefBonnici.dts-lsp';

type Severity = 'error' | 'warning' | 'info' | 'hint';

/** VS Code's severity as a word. Read on each call, so this module loads without a full vscode API. */
function severityOf(diagnostic: vscode.Diagnostic): Severity {
  switch (diagnostic.severity) {
    case vscode.DiagnosticSeverity.Error: return 'error';
    case vscode.DiagnosticSeverity.Warning: return 'warning';
    case vscode.DiagnosticSeverity.Hint: return 'hint';
    default: return 'info';
  }
}

function problemItem(uri: vscode.Uri, diagnostic: vscode.Diagnostic, severity: Severity): Record<string, unknown> {
  return {
    severity,
    file: uri.fsPath,
    // VS Code positions are zero based; compilers and editors show one based.
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.character + 1,
    message: diagnostic.message,
    ...(diagnostic.source ? { source: diagnostic.source } : {}),
    ...(diagnostic.code !== undefined
      ? { code: typeof diagnostic.code === 'object' ? String(diagnostic.code.value) : String(diagnostic.code) }
      : {}),
  };
}

function invalid(message: string, hint?: string): McpToolError {
  return new McpToolError('INVALID_ARGUMENT', message, { hint });
}

/** Refuse misplaced and malformed arguments before anything is resolved. */
function checkArguments(args: Record<string, unknown>): { source: string; severity: string; openFiles: string[] } {
  const source = str(args.source) ?? 'both';
  if (!SOURCES.includes(source)) {
    throw invalid(`source must be one of ${SOURCES.join(', ')}.`);
  }
  const severity = str(args.severity) ?? 'all';
  if (!SEVERITIES.includes(severity)) {
    throw invalid(`severity must be one of ${SEVERITIES.join(', ')}.`);
  }
  if (source !== 'sca') {
    for (const key of SCA_ONLY) {
      if (args[key] !== undefined) {
        throw invalid(`${key} only applies to source "sca".`, 'Pass source "sca" to filter ECLAIR findings, or leave it out.');
      }
    }
  }
  for (const key of ['rule', 'path_prefix']) {
    if (args[key] !== undefined && typeof args[key] !== 'string') {
      throw invalid(`${key} must be a string.`);
    }
  }
  const raw = args.open_files;
  if (raw !== undefined && (!Array.isArray(raw) || raw.some(entry => typeof entry !== 'string'))) {
    throw invalid('open_files must be a list of absolute file paths.');
  }
  const openFiles = [...new Set((raw as string[] | undefined) ?? [])];
  if (openFiles.length > MAX_OPEN_FILES) {
    throw invalid(`open_files takes at most ${MAX_OPEN_FILES} files; ${openFiles.length} were given.`);
  }
  for (const file of openFiles) {
    if (!path.isAbsolute(file)) {
      throw invalid(`open_files entries must be absolute; "${file}" is not.`);
    }
  }
  return { source, severity, openFiles };
}

// -- open_files -------------------------------------------------------------------

/** The real path of a file the application holds, refusing one outside it or not a file. */
function checkOpenFile(file: string, appRoot: string): string {
  assertInside(file, [appRoot], 'open_files');
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    throw invalid(`open_files: "${file}" does not exist.`);
  }
  // A link inside the application must not lead a language server to a file outside it.
  let realRoot = appRoot;
  try {
    realRoot = fs.realpathSync(appRoot);
  } catch {
    // Compared as given.
  }
  assertInside(real, [realRoot], 'open_files');
  if (!fs.statSync(real).isFile()) {
    throw invalid(`open_files: "${file}" is not a file.`);
  }
  return file;
}

/** Text as a document holds it: no byte order mark, and one kind of line break. */
function normalizedText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** VS Code 1.100 and later tell which encoding a document was read with, and decode with it. */
interface EncodingApi {
  decode?(content: Uint8Array, options: { encoding: string }): Thenable<string>;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * The document's file on disk as normalized text, decoded with the encoding
 * VS Code read the document with, so a file in another encoding than UTF-8
 * compares equal to its document. Undefined when that cannot be told: the file
 * is gone or binary, or an older VS Code does not tell the encoding and the
 * bytes and the files settings leave it open.
 */
async function diskText(document: vscode.TextDocument): Promise<string | undefined> {
  try {
    const bytes = fs.readFileSync(document.uri.fsPath);
    const encoding = (document as { encoding?: unknown }).encoding;
    const workspace = vscode.workspace as typeof vscode.workspace & EncodingApi;
    if (typeof encoding === 'string' && typeof workspace.decode === 'function') {
      return normalizedText(await workspace.decode(bytes, { encoding }));
    }
    // Older VS Code reads a file as UTF-8 unless the files settings pick
    // another encoding or have it guessed. A NUL byte means UTF-16 or a binary
    // file, and bytes that are not UTF-8 were read with another encoding.
    if (bytes.includes(0)) {
      return undefined;
    }
    const text = strictUtf8.decode(bytes);
    if (bytes.every(byte => byte < 0x80)) {
      // Plain ASCII reads the same whichever encoding VS Code picked.
      return normalizedText(text);
    }
    const settings = vscode.workspace.getConfiguration('files', document);
    const configured = settings.get<string>('encoding') ?? 'utf8';
    return (configured === 'utf8' || configured === 'utf8bom') && settings.get<boolean>('autoGuessEncoding') !== true
      ? normalizedText(text)
      : undefined;
  } catch {
    return undefined;
  }
}

/** True when the document holds what its file on disk holds, or when that cannot be told. */
async function matchesDisk(document: vscode.TextDocument): Promise<boolean> {
  const disk = await diskText(document);
  return disk === undefined || normalizedText(document.getText()) === disk;
}

/** Per file, why its problems may not be those of the file on disk. */
const UNSAVED_NOTE = 'This file is open in an editor with unsaved changes, so these problems are for the text in the editor, not the file on disk.';
const NOT_RELOADED_NOTE = 'VS Code had not reloaded this file from disk yet, so these problems may be for its previous content. Call get_diagnostics again in a moment.';
const NOT_CHECKED_NOTE = 'No language server or build had reported on this file since its content last changed, so these problems may be for its previous content. Call get_diagnostics again in a moment, or call build_app.';

/** A file open_files waits for. */
interface FileWait {
  /** The text on disk, while VS Code has yet to reload the document with it: reports until then are on the old text. */
  reloadTo?: string;
  /** Runs from the file's last report; when it fires, the file has settled. */
  quiet?: NodeJS.Timeout;
}

/**
 * Open the files without showing an editor, which starts the language servers
 * that check them, and wait until the diagnostics of each file settle: a quiet
 * moment after that file's last report. Each file settles on its own, so one
 * file's reports never end the wait for another, and the whole wait stops at
 * OPEN_WAIT_MS, which a file no language server checks always reaches. A file
 * already open is waited for only when its problems may be those of an older
 * text: its file changed on disk and VS Code has yet to reload it, as when the
 * agent just rewrote it, or its text changed since a language server last
 * reported on it, as when VS Code reloaded it just before the call. Such a
 * file counts once VS Code holds the text on disk and its language server
 * reports on it. Returns the files that could not be opened, and a note for
 * those whose problems may not match the file on disk.
 */
async function openAndSettle(files: string[], signal: AbortSignal): Promise<{ failures: Map<string, string>; notes: Map<string, string> }> {
  const failures = new Map<string, string>();
  const notes = new Map<string, string>();
  const uris = files.map(file => vscode.Uri.file(file));
  const alreadyOpen = new Map((vscode.workspace.textDocuments ?? []).map(doc => [doc.uri.toString(), doc]));
  // Read first, so nothing is awaited between looking at a document below and
  // listening for its changes.
  const onDisk = new Map<string, string | undefined>();
  for (const uri of uris) {
    const open = alreadyOpen.get(uri.toString());
    if (open && !open.isDirty) {
      onDisk.set(uri.toString(), await diskText(open));
    }
  }
  const waiting = new Map<string, FileWait>();

  let finish: () => void = () => undefined;
  const settled = new Promise<void>(resolve => { finish = resolve; });
  const done = (key: string) => {
    clearTimeout(waiting.get(key)?.quiet);
    waiting.delete(key);
    if (waiting.size === 0) {
      finish();
    }
  };
  const diagnosticsListener = vscode.languages.onDidChangeDiagnostics(event => {
    for (const uri of event.uris) {
      const key = uri.toString();
      const wait = waiting.get(key);
      if (wait && wait.reloadTo === undefined) {
        clearTimeout(wait.quiet);
        wait.quiet = setTimeout(() => done(key), SETTLE_MS);
      }
    }
  });
  const reloadListener = vscode.workspace.onDidChangeTextDocument(event => {
    const key = event.document.uri.toString();
    const wait = waiting.get(key);
    if (!wait || event.contentChanges.length === 0) {
      return;
    }
    // The reports so far were on the text before this change.
    clearTimeout(wait.quiet);
    wait.quiet = undefined;
    if (wait.reloadTo !== undefined && normalizedText(event.document.getText()) === wait.reloadTo) {
      wait.reloadTo = undefined;
    }
  });
  for (const uri of uris) {
    const key = uri.toString();
    const open = alreadyOpen.get(key);
    const disk = onDisk.get(key);
    if (!open) {
      waiting.set(key, {});
    } else if (open.isDirty) {
      // Its problems are those of the editor's text, which no wait changes.
    } else if (disk !== undefined && normalizedText(open.getText()) !== disk) {
      // VS Code reloads a document without unsaved changes when its file changes.
      waiting.set(key, { reloadTo: disk });
    } else if (awaitingReport(open)) {
      waiting.set(key, {});
    }
  }
  const cap = setTimeout(finish, OPEN_WAIT_MS);
  const onAbort = () => finish();
  signal.addEventListener('abort', onAbort, { once: true });
  const documents = new Map<string, vscode.TextDocument>();
  try {
    for (const uri of uris) {
      try {
        documents.set(uri.fsPath, await vscode.workspace.openTextDocument(uri));
      } catch (error) {
        failures.set(uri.fsPath, error instanceof Error ? error.message : String(error));
        done(uri.toString());
      }
    }
    if (waiting.size > 0) {
      await settled;
    }
  } finally {
    waiting.forEach(wait => clearTimeout(wait.quiet));
    clearTimeout(cap);
    signal.removeEventListener('abort', onAbort);
    diagnosticsListener.dispose();
    reloadListener.dispose();
  }
  for (const [file, document] of documents) {
    if (!(await matchesDisk(document))) {
      notes.set(file, document.isDirty ? UNSAVED_NOTE : NOT_RELOADED_NOTE);
    } else if (awaitingReport(document)) {
      notes.set(file, NOT_CHECKED_NOTE);
    }
  }
  return { failures, notes };
}

// -- source sca -------------------------------------------------------------------

/** The SARIF report of the last ECLAIR analysis: in the build folder, or the default image's for sysbuild. */
function findSarif(buildDir: string): string | undefined {
  const candidates = [path.join(eclairOutputDir(buildDir), 'reports.sarif')];
  const domains = readDomainsForBuildDir(buildDir);
  const imageDir = domains ? getDomainBuildDir(domains, domains.defaultDomain) : undefined;
  if (imageDir) {
    candidates.push(path.join(eclairOutputDir(imageDir), 'reports.sarif'));
  }
  return candidates.find(candidate => fs.existsSync(candidate));
}

function readScaFindings(args: Record<string, unknown>, buildDir: string, severity: string, limit: number): Record<string, unknown> {
  const sarifPath = findSarif(buildDir);
  if (!sarifPath) {
    throw new McpToolError('NOT_BUILT', `No ECLAIR report in "${eclairOutputDir(buildDir)}": this configuration has no ECLAIR analysis yet.`, {
      hint: 'Call analyze with analysis "eclair" first, then retry.',
    });
  }
  let log;
  try {
    log = readSarif(fs.readFileSync(sarifPath, 'utf8'));
  } catch (error) {
    throw new McpToolError('INTERNAL', `The ECLAIR report ${sarifPath} cannot be read: ${error instanceof SarifError || error instanceof Error ? error.message : String(error)}`, {
      hint: 'Call analyze with analysis "eclair" again to write a fresh report.',
    });
  }
  const offset = num(args.offset) ?? 0;
  const matching = filterFindings(log.findings, {
    rule: matcherFor(str(args.rule)),
    pathPrefix: str(args.path_prefix),
    severity: severity as 'error' | 'warning' | 'all',
  });
  const page = matching.slice(offset, offset + limit);
  const rules = Object.fromEntries([...new Set(page.map(finding => finding.rule))]
    .filter(rule => log.rules[rule])
    .map(rule => [rule, log.rules[rule]]));
  let summary: string | undefined;
  try {
    const text = fs.readFileSync(path.join(path.dirname(sarifPath), 'summary_overall.txt'), 'utf8').trim();
    summary = text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS)}\n...` : text;
  } catch {
    summary = undefined;
  }
  const count = (wanted: string) => log.findings.filter(finding => finding.severity === wanted).length;
  const byRule = countByRule(matching);
  return {
    sarif_path: sarifPath,
    ...(log.tools.length ? { tools: log.tools } : {}),
    written_at: fs.statSync(sarifPath).mtime.toISOString(),
    counts: { total: log.findings.length, errors: count('error'), warnings: count('warning'), notes: count('info') },
    matching: matching.length,
    by_rule: byRule.slice(0, MAX_RULES),
    ...(byRule.length > MAX_RULES ? { rules_total: byRule.length } : {}),
    items: page,
    ...(Object.keys(rules).length ? { rules } : {}),
    next_offset: offset + page.length < matching.length ? offset + page.length : undefined,
    ...(summary ? { summary } : {}),
  };
}

// -- the tool -----------------------------------------------------------------------

export const getDiagnostics: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const { services, jobs } = ctx.deps;
  const { source, severity: wanted, openFiles } = checkArguments(args);
  const { app, config, buildDir } = await services.resolveTarget(str(args.app_path), str(args.config_name));
  const limit = num(args.limit) ?? 50;
  const keep = (severity: string) => wanted === 'all' || severity === wanted;

  const result: Record<string, unknown> = { app_path: app.appRootPath, config_name: config.name };

  if (openFiles.length > 0) {
    const files = openFiles.map(file => checkOpenFile(file, app.appRootPath));
    const { failures, notes } = await openAndSettle(files, ctx.signal);
    result.opened = files.map(file => {
      const uri = vscode.Uri.file(file);
      const failure = failures.get(uri.fsPath);
      if (failure) {
        return { file, opened: false, error: failure };
      }
      const note = notes.get(uri.fsPath);
      const all = vscode.languages.getDiagnostics(uri).map(diagnostic => ({ diagnostic, severity: severityOf(diagnostic) }));
      const items = all.filter(entry => keep(entry.severity)).map(entry => problemItem(uri, entry.diagnostic, entry.severity));
      return {
        file,
        opened: true,
        counts: {
          errors: all.filter(entry => entry.severity === 'error').length,
          warnings: all.filter(entry => entry.severity === 'warning').length,
        },
        items: items.slice(0, limit),
        truncated: items.length > limit,
        ...(note ? { note } : {}),
      };
    });
    const devicetree = files.some(file => /\.(dts|dtsi|overlay)$/i.test(file));
    if (devicetree && !vscode.extensions.getExtension(DTS_LSP_EXTENSION)) {
      result.opened_note = `The devicetree language server (the DTS LSP extension, ${DTS_LSP_EXTENSION}) is not installed, so devicetree files get no language server check. Call build_app to have the build check them.`;
    }
  }

  if (source === 'last_build' || source === 'both') {
    // A build_app build only: an analysis such as hardenconfig runs in the same
    // folder without compiling, and must not hide the errors of the build before it.
    const last = jobs.list().find(job => job.spec.kind === 'build' && job.spec.buildDir === buildDir
      && job.spec.requestKey.startsWith('build:'));
    if (last) {
      // Parsed without the compact cap, so the severity filter and limit
      // apply to every diagnostic, not to the first twenty.
      const view = jobs.view(last, { tailLines: 0, maxDiagnostics: Number.POSITIVE_INFINITY });
      const items = (view.diagnostics?.items ?? []).filter(item => keep(item.severity));
      result.last_build = {
        job_id: last.id,
        status: last.status,
        ended_at: view.ended_at,
        counts: { errors: view.diagnostics?.errors ?? 0, warnings: view.diagnostics?.warnings ?? 0 },
        items: items.slice(0, limit),
        truncated: items.length > limit || view.diagnostics?.truncated === true,
      };
    } else {
      result.last_build = {
        note: 'No agent build of this configuration since this VS Code window started. Call build_app, or read problems_panel.',
      };
    }
  }

  if (source === 'problems_panel' || source === 'both') {
    const items: Record<string, unknown>[] = [];
    let errors = 0;
    let warnings = 0;
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      // Only this application's files: the Problems panel holds the whole window.
      if (uri.scheme !== 'file' || !isInside(uri.fsPath, app.appRootPath)) {
        continue;
      }
      for (const diagnostic of diagnostics) {
        const severity = severityOf(diagnostic);
        if (severity === 'error') { errors++; }
        if (severity === 'warning') { warnings++; }
        if (!keep(severity)) {
          continue;
        }
        items.push(problemItem(uri, diagnostic, severity));
      }
    }
    const rank: Record<string, number> = { error: 0, warning: 1, info: 2, hint: 3 };
    items.sort((a, b) => rank[a.severity as string] - rank[b.severity as string]);
    result.problems_panel = { counts: { errors, warnings }, items: items.slice(0, limit), truncated: items.length > limit };
  }

  if (source === 'sca') {
    result.sca = readScaFindings(args, buildDir, wanted, limit);
  }

  return result;
};
