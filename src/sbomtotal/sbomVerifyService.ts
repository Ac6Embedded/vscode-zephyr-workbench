import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { westSpdxGenerateCommand } from '../commands/WestCommands';
import { ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from '../constants';
import { ZephyrApplication } from '../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../models/ZephyrBuildConfig';
import { ZephyrApplicationTreeItem, ZephyrConfigTreeItem } from '../providers/ZephyrApplicationProvider';
import { getOutputChannel } from '../utils/execUtils';
import { getWestWorkspace } from '../utils/utils';
import {
  isAbortError,
  SbomReportFormat,
  SbomTotalClient,
  SbomTotalError,
  ScanResult,
} from './sbomTotalClient';
import { MergeSpdx3Stats, mergeSpdx3Set, MergeStats, mergeSpdxSet, pickFallbackFile } from './spdxSetMerger';

export type SpdxTreeNode = ZephyrApplicationTreeItem | ZephyrConfigTreeItem;

/** Runs the full SPDX pipeline (init + build + generate); provided by extension.ts. */
export type SpdxBuildRunner = (node: SpdxTreeNode, spdxVersion: '2.3' | '3.0') => Promise<boolean>;

const BASE_URL_SETTING_KEY = 'sbomTotal.baseUrl';
const FAIL_ON_SETTING_KEY = 'sbomTotal.failOn';
const INCLUDE_SDK_SETTING_KEY = 'sbomTotal.includeSdk';
const TOKEN_SECRET_KEY = 'zephyr-workbench.sbom-total.token';
const DEFAULT_BASE_URL = 'https://sbomtotal.com';
// Shipped on purpose as a revocable default: it only associates scans with the
// Ac6 account (scanning itself is public). Rotate in a patch release if abused.
const DEFAULT_SBOM_TOTAL_TOKEN = 'sct_vcv1Pw7LbUm0Sdq3TNP1HKZmpBFx2SRNSNWjR1g8HJc';
const SPDX_VERSION_SETTING_KEY = 'sbomTotal.spdxVersion';
const OUTPUT_DIR_NAME = 'sbom-total';
const SDK_DOC_NAME = 'sdk.spdx';
const SDK_DOC3_NAME = 'sdk.jsonld';

type FailOnGate = 'actionable' | 'risk' | 'never';

interface SpdxContext {
  node: SpdxTreeNode;
  project: ZephyrApplication;
  config: ZephyrBuildConfig;
  spdxDir: string;
  appName: string;
}

interface ClientBundle {
  client: SbomTotalClient;
  usingBuiltInToken: boolean;
  baseUrl: string;
}

interface ScanOutcome {
  result: ScanResult;
  hash: string;
  scannedName: string;
  fromProbe: boolean;
  mergeStats?: MergeStats;
  merge3Stats?: MergeSpdx3Stats;
  fallbackReason?: string;
  sdkResult?: ScanResult;
  reportDir: string;
  reportBaseName: string;
}

/**
 * SPDX version for this run: 'auto' (default) follows what the Zephyr tree can
 * generate, using the existing file-based capability check
 * (WestWorkspace.supportsSpdx3); '2.3'/'3.0' are explicit user pins.
 */
function resolveSpdxVersion(ctx: SpdxContext): '2.3' | '3.0' {
  const configured = getSbomTotalConfig().get<'auto' | '2.3' | '3.0'>(SPDX_VERSION_SETTING_KEY, 'auto');
  if (configured === '2.3' || configured === '3.0') {
    return configured;
  }
  try {
    return getWestWorkspace(ctx.project.westWorkspaceRootPath).supportsSpdx3 ? '3.0' : '2.3';
  } catch {
    return '2.3';
  }
}

let warnedAboutSecretStorage = false;

function getSbomTotalConfig() {
  return vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY);
}

export async function createClientFromConfig(context: vscode.ExtensionContext): Promise<ClientBundle> {
  const baseUrl = (getSbomTotalConfig().get<string>(BASE_URL_SETTING_KEY) || DEFAULT_BASE_URL).trim();

  let userToken: string | undefined;
  try {
    userToken = await context.secrets.get(TOKEN_SECRET_KEY) || undefined;
  } catch {
    if (!warnedAboutSecretStorage) {
      warnedAboutSecretStorage = true;
      vscode.window.showWarningMessage(
        'Secret storage is unavailable on this system; SBOM Total scans will use the built-in token.',
      );
    }
  }

  const token = userToken ?? DEFAULT_SBOM_TOTAL_TOKEN;
  return {
    // The built-in token is revocable server side: let the client drop it and
    // retry anonymously on 401/403 (all endpoints used are public anyway).
    client: new SbomTotalClient({ baseUrl, token, anonymousFallback: !userToken }),
    usingBuiltInToken: !userToken,
    baseUrl,
  };
}

export async function setApiToken(context: vscode.ExtensionContext): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: 'Set SBOM Total API Token',
    prompt: 'Personal API token (sct_...). Leave empty to clear it and use the built-in token.',
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) {
    return;
  }
  try {
    if (value.trim().length === 0) {
      await context.secrets.delete(TOKEN_SECRET_KEY);
      vscode.window.showInformationMessage('SBOM Total token cleared. Scans now use the built-in token.');
    } else {
      await context.secrets.store(TOKEN_SECRET_KEY, value.trim());
      vscode.window.showInformationMessage('SBOM Total token saved.');
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Could not update the SBOM Total token: ${error}`);
  }
}

function resolveSpdxContext(node: SpdxTreeNode): SpdxContext | undefined {
  const project = node.project;
  if (!project) {
    return undefined;
  }
  const config =
    node instanceof ZephyrConfigTreeItem
      ? node.buildConfig
      : project.buildConfigs.find(cfg => cfg.active) ?? project.buildConfigs[0];
  if (!config) {
    vscode.window.showErrorMessage('No build configuration available for SBOM verification.');
    return undefined;
  }
  const spdxDir = path.join(config.getBuildDir(project), 'spdx');
  return { node, project, config, spdxDir, appName: path.basename(project.appRootPath ?? 'app') };
}

function listGeneratedDocs(spdxDir: string): { spdx: string[]; jsonld: string[] } {
  const spdx: string[] = [];
  const jsonld: string[] = [];
  if (!fs.existsSync(spdxDir)) {
    return { spdx, jsonld };
  }
  for (const entry of fs.readdirSync(spdxDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name.endsWith('.spdx')) {
      spdx.push(entry.name);
    } else if (entry.name.endsWith('.jsonld')) {
      jsonld.push(entry.name);
    }
  }
  return { spdx, jsonld };
}

/**
 * Make sure `<buildDir>/spdx` contains the documents of the requested SPDX
 * version, building or regenerating as needed. When only the other version's
 * documents exist, `west spdx --init` already ran at build time, so the
 * generate step alone adds this version (no rebuild).
 */
async function ensureSpdxDocs(
  ctx: SpdxContext,
  spdxVersion: '2.3' | '3.0',
  runSpdxBuild: SpdxBuildRunner,
  progress: vscode.Progress<{ message?: string }>,
  cancel: vscode.CancellationToken,
): Promise<string[] | undefined> {
  const pick = (docs: ReturnType<typeof listGeneratedDocs>) => (spdxVersion === '3.0' ? docs.jsonld : docs.spdx);
  let docs = listGeneratedDocs(ctx.spdxDir);
  if (pick(docs).length > 0) {
    return pick(docs);
  }

  try {
    const westWorkspace = getWestWorkspace(ctx.project.westWorkspaceRootPath);
    if (spdxVersion === '3.0' && !westWorkspace.supportsSpdx3) {
      vscode.window.showErrorMessage(
        `SPDX 3 SBOM generation is not supported by this Zephyr version (detected: ${westWorkspace.version}). Set zephyr-workbench.sbomTotal.spdxVersion to 2.3.`,
      );
      return undefined;
    }
    if (docs.spdx.length === 0 && docs.jsonld.length === 0) {
      // Nothing generated yet: run the full SPDX pipeline (deletes and rebuilds).
      progress.report({ message: `building the application and generating SPDX ${spdxVersion} documents (this can take a while)...` });
      const built = await runSpdxBuild(ctx.node, spdxVersion);
      if (!built || cancel.isCancellationRequested) {
        return undefined;
      }
    } else {
      progress.report({ message: `generating SPDX ${spdxVersion} documents (no rebuild needed)...` });
      await westSpdxGenerateCommand(ctx.project, westWorkspace, ctx.config, spdxVersion);
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Could not generate SPDX ${spdxVersion} documents: ${error}`);
    return undefined;
  }

  docs = listGeneratedDocs(ctx.spdxDir);
  if (pick(docs).length === 0) {
    if (!cancel.isCancellationRequested) {
      vscode.window.showErrorMessage(
        `No SPDX ${spdxVersion} documents were generated. Check the SPDX generation output in the terminal, then try again.`,
      );
    }
    return undefined;
  }
  return pick(docs);
}

interface ScanInput {
  bytes: Buffer;
  name: string;
  mergeStats?: MergeStats;
  merge3Stats?: MergeSpdx3Stats;
  fallbackReason?: string;
}

/**
 * Merge the SPDX 3.0 JSON-LD set into one document for upload. The upload name
 * uses a .json suffix (accepted by the service) so server-side SPDX 3 support
 * can pick it up by content the day it lands.
 */
function buildSpdx3ScanInput(ctx: SpdxContext, jsonldFiles: string[]): ScanInput | undefined {
  const candidates = jsonldFiles.filter(name => name !== SDK_DOC3_NAME);
  if (candidates.length === 0) {
    return undefined;
  }
  const inputDocs = candidates.map(name => ({
    fileName: name,
    content: fs.readFileSync(path.join(ctx.spdxDir, name)).toString('utf-8'),
  }));
  const merged = mergeSpdx3Set(inputDocs);
  if (!merged.ok) {
    getOutputChannel().appendLine(`[sbom-total] SPDX 3.0 merge failed, falling back to SPDX 2.3: ${merged.reason}`);
    return undefined;
  }
  const mergedName = `merged-${sanitizeFileName(ctx.appName)}-${sanitizeFileName(ctx.config.name)}.spdx3.json`;
  const mergedPath = path.join(ctx.spdxDir, OUTPUT_DIR_NAME, mergedName);
  try {
    fs.mkdirSync(path.dirname(mergedPath), { recursive: true });
    fs.writeFileSync(mergedPath, merged.content);
  } catch {
    // The merged artifact on disk is a convenience; scanning proceeds regardless.
  }
  return { bytes: Buffer.from(merged.content, 'utf-8'), name: mergedName, merge3Stats: merged.stats };
}

/**
 * Merge the generated set into one lean document, or fall back to the best
 * single file. sdk.spdx is never part of the firmware merge: when enabled it
 * is scanned separately as build-environment information.
 */
function buildScanInput(ctx: SpdxContext, spdxFiles: string[]): ScanInput | undefined {
  const candidates = spdxFiles.filter(name => name !== SDK_DOC_NAME);
  if (candidates.length === 0) {
    return undefined;
  }

  const readDoc = (name: string) => fs.readFileSync(path.join(ctx.spdxDir, name));
  if (candidates.length === 1) {
    return { bytes: readDoc(candidates[0]), name: candidates[0] };
  }

  const inputDocs = candidates.map(name => ({
    fileName: name,
    content: readDoc(name).toString('utf-8'),
  }));
  const documentName = `${ctx.appName}-${ctx.config.name}-sbom`;
  const merged = mergeSpdxSet(inputDocs, { documentName });

  if (merged.ok) {
    const mergedName = `merged-${sanitizeFileName(ctx.appName)}-${sanitizeFileName(ctx.config.name)}.spdx`;
    const mergedPath = path.join(ctx.spdxDir, OUTPUT_DIR_NAME, mergedName);
    try {
      fs.mkdirSync(path.dirname(mergedPath), { recursive: true });
      fs.writeFileSync(mergedPath, merged.content);
    } catch {
      // The merged artifact on disk is a convenience; scanning proceeds regardless.
    }
    return { bytes: Buffer.from(merged.content, 'utf-8'), name: mergedName, mergeStats: merged.stats };
  }

  const fallback = pickFallbackFile(candidates);
  if (!fallback) {
    return undefined;
  }
  return { bytes: readDoc(fallback), name: fallback, fallbackReason: merged.reason };
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '-');
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Probe the service by content hash first (free, not rate limited), then upload
 * only when the result is not already stored. A revoked built-in token is
 * handled inside the client (anonymous fallback).
 */
async function scanBytes(
  bundle: ClientBundle,
  bytes: Buffer,
  name: string,
  options: { force?: boolean; signal?: AbortSignal },
): Promise<{ result: ScanResult; hash: string; fromProbe: boolean }> {
  const contentHash = sha256(bytes);

  if (!options.force) {
    const stored = await bundle.client.getScanByContent(contentHash, options.signal);
    if (stored) {
      return { result: stored, hash: stored.hash ?? contentHash, fromProbe: true };
    }
  }

  const result = await bundle.client.scanSbom(bytes, name, options);
  return { result, hash: result.hash ?? contentHash, fromProbe: false };
}

async function scanSdkSeparately(
  ctx: SpdxContext,
  bundle: ClientBundle,
  sdkFileName: string,
  uploadName: string,
  options: { force?: boolean; signal?: AbortSignal },
): Promise<ScanResult | undefined> {
  try {
    const sdkBytes = fs.readFileSync(path.join(ctx.spdxDir, sdkFileName));
    return (await scanBytes(bundle, sdkBytes, uploadName, options)).result;
  } catch (error) {
    if (!isAbortError(error)) {
      getOutputChannel().appendLine(`[sbom-total] SDK scan failed: ${error instanceof Error ? error.message : error}`);
    }
    return undefined;
  }
}

/**
 * Generate the opt-in SDK document on an existing build (generate-only step;
 * the includeSdk setting makes westSpdxGenerateCommand pass --include-sdk).
 */
async function generateSdkDoc(ctx: SpdxContext, spdxVersion: '2.3' | '3.0', progress: vscode.Progress<{ message?: string }>): Promise<void> {
  progress.report({ message: 'generating the SDK SPDX document (no rebuild needed)...' });
  try {
    const westWorkspace = getWestWorkspace(ctx.project.westWorkspaceRootPath);
    await westSpdxGenerateCommand(ctx.project, westWorkspace, ctx.config, spdxVersion);
  } catch (error) {
    getOutputChannel().appendLine(`[sbom-total] SDK document generation failed: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Verify with exactly ONE SPDX version, chosen by the sbomTotal.spdxVersion
 * setting. There is deliberately no automatic fallback between versions: the
 * flow generates and scans either 3.0 or 2.3, never both.
 */
async function runScanPipeline(
  context: vscode.ExtensionContext,
  ctx: SpdxContext,
  runSpdxBuild: SpdxBuildRunner,
  progress: vscode.Progress<{ message?: string }>,
  cancel: vscode.CancellationToken,
  force: boolean,
): Promise<ScanOutcome | undefined> {
  const abort = new AbortController();
  cancel.onCancellationRequested(() => abort.abort());

  const spdxVersion = resolveSpdxVersion(ctx);
  const includeSdk = getSbomTotalConfig().get<boolean>(INCLUDE_SDK_SETTING_KEY, false);
  const bundle = await createClientFromConfig(context);
  const reportDir = path.join(ctx.spdxDir, OUTPUT_DIR_NAME);
  const reportBaseName = `${sanitizeFileName(ctx.appName)}-${sanitizeFileName(ctx.config.name)}`;
  const sdkDocName = spdxVersion === '3.0' ? SDK_DOC3_NAME : SDK_DOC_NAME;

  let files = await ensureSpdxDocs(ctx, spdxVersion, runSpdxBuild, progress, cancel);
  if (!files || cancel.isCancellationRequested) {
    return undefined;
  }

  if (includeSdk && !files.includes(sdkDocName)) {
    await generateSdkDoc(ctx, spdxVersion, progress);
    const docs = listGeneratedDocs(ctx.spdxDir);
    files = spdxVersion === '3.0' ? docs.jsonld : docs.spdx;
    if (files.length === 0 || cancel.isCancellationRequested) {
      return undefined;
    }
  }

  progress.report({ message: `merging the SPDX ${spdxVersion} document set...` });
  const input = spdxVersion === '3.0' ? buildSpdx3ScanInput(ctx, files) : buildScanInput(ctx, files);
  if (!input) {
    vscode.window.showErrorMessage(
      `The SPDX ${spdxVersion} documents could not be prepared for scanning. See the Ac6 Zephyr Workbench output for details.`,
    );
    return undefined;
  }

  progress.report({ message: `scanning ${input.name} (the scan can take up to a few minutes)...` });
  const scan = await scanBytes(bundle, input.bytes, input.name, { force, signal: abort.signal });

  let sdkResult: ScanResult | undefined;
  if (includeSdk && files.includes(sdkDocName) && !cancel.isCancellationRequested) {
    progress.report({ message: 'scanning the SDK document (build environment)...' });
    const sdkUploadName = spdxVersion === '3.0' ? 'sdk.spdx3.json' : SDK_DOC_NAME;
    sdkResult = await scanSdkSeparately(ctx, bundle, sdkDocName, sdkUploadName, { force, signal: abort.signal });
  }
  if (cancel.isCancellationRequested) {
    return undefined;
  }

  return {
    result: scan.result,
    hash: scan.hash,
    scannedName: input.name,
    fromProbe: scan.fromProbe,
    mergeStats: input.mergeStats,
    merge3Stats: input.merge3Stats,
    fallbackReason: input.fallbackReason,
    sdkResult,
    reportDir,
    reportBaseName,
  };
}

function getGate(result: ScanResult): { failOn: FailOnGate; failed: boolean } {
  const failOn = getSbomTotalConfig().get<FailOnGate>(FAIL_ON_SETTING_KEY, 'actionable');
  const actionable = result.triage?.actionable ?? 0;
  const failed =
    (failOn === 'actionable' && actionable > 0) ||
    (failOn === 'risk' && result.verdict === 'risk');
  return { failOn, failed };
}

function timestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function downloadAndOpenReport(
  bundle: ClientBundle,
  outcome: ScanOutcome,
  format: SbomReportFormat,
  signal?: AbortSignal,
): Promise<void> {
  const destPath = path.join(outcome.reportDir, `report-${outcome.reportBaseName}-${timestamp()}.${format}`);
  await bundle.client.downloadReport(outcome.hash, format, destPath, signal);
  if (format === 'md') {
    const document = await vscode.workspace.openTextDocument(destPath);
    await vscode.window.showTextDocument(document);
  } else {
    await vscode.env.openExternal(vscode.Uri.file(destPath));
  }
}

function logOutcome(bundle: ClientBundle, outcome: ScanOutcome, gate: { failOn: FailOnGate; failed: boolean }): void {
  const channel = getOutputChannel();
  const { result } = outcome;
  channel.appendLine('');
  channel.appendLine(`[sbom-total] Verification of ${outcome.scannedName}`);
  if (outcome.mergeStats) {
    const stats = outcome.mergeStats;
    channel.appendLine(
      `[sbom-total]   merged ${stats.documents} documents: ${stats.packagesKept} packages kept, ` +
      `${stats.filesDropped} file entries dropped, ${stats.relationshipsKept} relationships kept ` +
      `(${stats.relationshipsDropped} dropped, cross-document references: ${stats.crossDocRefsResolved} resolved, ` +
      `${stats.crossDocRefsDropped} dropped), ${stats.licensesKept} custom licenses`,
    );
  }
  if (outcome.merge3Stats) {
    const stats = outcome.merge3Stats;
    channel.appendLine(
      `[sbom-total]   merged ${stats.documents} SPDX 3.0 documents: ${stats.elementsKept} elements kept, ` +
      `${stats.duplicatesDropped} duplicates dropped`,
    );
  }
  if (outcome.fallbackReason) {
    channel.appendLine(`[sbom-total]   merge not possible (${outcome.fallbackReason}); scanned a single document instead`);
  }
  channel.appendLine(`[sbom-total]   verdict: ${result.verdict}   score: ${result.score ?? 'n/a'}   ${outcome.fromProbe || result.cached ? '(cached result)' : '(fresh scan)'}`);
  if (result.triage) {
    channel.appendLine(
      `[sbom-total]   triage: ${result.triage.actionable} actionable / ${result.triage.review} review / ` +
      `${result.triage.noise} suppressed (total ${result.triage.total})`,
    );
  }
  if (result.ntia) {
    const ntia = Object.entries(result.ntia).map(([key, ok]) => `${key}=${ok ? 'yes' : 'no'}`).join(', ');
    channel.appendLine(`[sbom-total]   NTIA minimum elements: ${ntia}`);
  }
  if (result.maturity?.label) {
    channel.appendLine(`[sbom-total]   maturity: level ${result.maturity.level ?? '?'} (${result.maturity.label})`);
  }
  for (const gap of result.gaps ?? []) {
    channel.appendLine(`[sbom-total]   gap: ${gap}`);
  }
  if (outcome.sdkResult) {
    channel.appendLine(
      `[sbom-total]   sdk.spdx (build environment, informational): verdict ${outcome.sdkResult.verdict}, ` +
      `score ${outcome.sdkResult.score ?? 'n/a'}`,
    );
  }
  channel.appendLine(`[sbom-total]   hash: ${outcome.hash}`);
  channel.appendLine(`[sbom-total]   details: ${bundle.client.permalinkUrl(outcome.hash)}`);
  channel.appendLine(`[sbom-total]   RESULT: ${gate.failed ? 'FAIL' : 'PASS'} (gate: fail on ${gate.failOn})`);
}

async function presentOutcome(
  bundle: ClientBundle,
  outcome: ScanOutcome,
  forceRescan?: () => Promise<void>,
): Promise<void> {
  const gate = getGate(outcome.result);
  logOutcome(bundle, outcome, gate);

  const { result } = outcome;
  const cached = outcome.fromProbe || result.cached === true;
  const actionable = result.triage?.actionable ?? 0;
  const review = result.triage?.review ?? 0;
  const scoreText = result.score !== undefined ? `, score ${result.score}` : '';
  const message =
    `SBOM Total: verdict ${result.verdict} for ${outcome.scannedName} ` +
    `(${actionable} actionable, ${review} to review${scoreText})${cached ? ' (cached result)' : ''}`;

  const buttons = ['Open in Browser', 'Open PDF Report', 'Details'];
  if (cached && forceRescan) {
    buttons.push('Rescan (force)');
  }

  const show = (text: string, ...items: string[]): Thenable<string | undefined> =>
    gate.failed
      ? vscode.window.showErrorMessage(text, ...items)
      : result.verdict === 'clean'
        ? vscode.window.showInformationMessage(text, ...items)
        : vscode.window.showWarningMessage(text, ...items);

  const choice = await show(message, ...buttons);
  try {
    switch (choice) {
      case 'Open PDF Report':
        await downloadAndOpenReport(bundle, outcome, 'pdf');
        break;
      case 'Open in Browser':
        await vscode.env.openExternal(vscode.Uri.parse(bundle.client.permalinkUrl(outcome.hash)));
        break;
      case 'Details':
        getOutputChannel().show(true);
        break;
      case 'Rescan (force)':
        await forceRescan?.();
        break;
    }
  } catch (error) {
    showScanError(error);
  }
}

function showScanError(error: unknown): void {
  if (isAbortError(error)) {
    vscode.window.showInformationMessage(
      'SBOM verification cancelled. A scan already submitted may still finish on the server; rerunning later reuses the cached result.',
    );
    return;
  }
  if (error instanceof SbomTotalError) {
    if (error.detail) {
      getOutputChannel().appendLine(`[sbom-total] ${error.kind}${error.status ? ` (HTTP ${error.status})` : ''}: ${error.detail}`);
    }
    vscode.window.showErrorMessage(error.message);
    return;
  }
  vscode.window.showErrorMessage(`SBOM verification failed: ${error instanceof Error ? error.message : error}`);
}

/**
 * Version-aware error handling: when an SPDX 3.0 upload is rejected by the
 * service, offer to pin the setting to 2.3 and retry. The switch is always
 * the user's explicit click, never automatic.
 *
 * TODO(sbom-total): SBOM Total does not accept SPDX 3.0 yet (verified
 * 2026-07-10: 415 for .jsonld uploads, 422 for JSON-LD content under .json).
 * Requested from the service developer: allow .jsonld in the upload
 * allow-list, detect SPDX 3 by content (@context containing spdx.org/rdf/3.
 * plus a @graph array) and map software_Package elements. Once deployed,
 * re-verify the 3.0 path end-to-end (auto mode already selects 3.0 on capable
 * Zephyr trees) and drop the pin-to-2.3 guidance below.
 */
async function handleScanError(ctx: SpdxContext, error: unknown, retry: () => Promise<void>): Promise<void> {
  if (
    error instanceof SbomTotalError &&
    (error.kind === 'unparseable' || error.kind === 'unsupported-type') &&
    resolveSpdxVersion(ctx) === '3.0'
  ) {
    if (error.detail) {
      getOutputChannel().appendLine(`[sbom-total] ${error.kind}${error.status ? ` (HTTP ${error.status})` : ''}: ${error.detail}`);
    }
    const switchAction = 'Use SPDX 2.3 and retry';
    const choice = await vscode.window.showErrorMessage(
      'The service rejected the SPDX 3.0 SBOM; it probably does not support SPDX 3.0 yet. Switch the scan format setting (zephyr-workbench.sbomTotal.spdxVersion) to 2.3?',
      switchAction,
    );
    if (choice === switchAction) {
      await getSbomTotalConfig().update(SPDX_VERSION_SETTING_KEY, '2.3', vscode.ConfigurationTarget.Global);
      await retry();
    }
    return;
  }
  showScanError(error);
}

async function runVerifyFlow(
  context: vscode.ExtensionContext,
  ctx: SpdxContext,
  runSpdxBuild: SpdxBuildRunner,
  force: boolean,
): Promise<void> {
  try {
    const outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'SBOM Total: Verifying SBOM',
        cancellable: true,
      },
      (progress, cancel) => runScanPipeline(context, ctx, runSpdxBuild, progress, cancel, force),
    );
    if (!outcome) {
      return;
    }
    const bundle = await createClientFromConfig(context);
    await presentOutcome(bundle, outcome, () => runVerifyFlow(context, ctx, runSpdxBuild, true));
  } catch (error) {
    await handleScanError(ctx, error, () => runVerifyFlow(context, ctx, runSpdxBuild, force));
  }
}

/** Default verification flow: build if needed, merge the set, scan once. */
export async function verifySbomSet(
  context: vscode.ExtensionContext,
  node: SpdxTreeNode,
  runSpdxBuild: SpdxBuildRunner,
): Promise<void> {
  const ctx = resolveSpdxContext(node);
  if (!ctx) {
    return;
  }
  await runVerifyFlow(context, ctx, runSpdxBuild, false);
}

/** Verify one user-picked SPDX file, without merging. */
export async function verifySbomFile(context: vscode.ExtensionContext, node: SpdxTreeNode): Promise<void> {
  const ctx = resolveSpdxContext(node);
  if (!ctx) {
    return;
  }
  const picked = await vscode.window.showOpenDialog({
    defaultUri: fs.existsSync(ctx.spdxDir) ? vscode.Uri.file(ctx.spdxDir) : undefined,
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: 'Select',
    filters: {
      'SPDX files': ['spdx', 'json', 'jsonld'],
      'All files': ['*'],
    },
  });
  if (!picked || !picked[0]) {
    return;
  }
  await scanSingleFile(context, ctx, picked[0], false);
}

async function scanSingleFile(
  context: vscode.ExtensionContext,
  ctx: SpdxContext,
  fileUri: vscode.Uri,
  force: boolean,
): Promise<void> {
  try {
    const bytes = fs.readFileSync(fileUri.fsPath);
    // .jsonld is not in the service's extension allow-list; upload SPDX 3.0
    // documents under a .json name and let the service decide by content.
    const name = path.basename(fileUri.fsPath).replace(/\.jsonld$/, '.spdx3.json');
    const outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `SBOM Total: Verifying ${name}`,
        cancellable: true,
      },
      async (progress, cancel): Promise<ScanOutcome | undefined> => {
        const abort = new AbortController();
        cancel.onCancellationRequested(() => abort.abort());
        const bundle = await createClientFromConfig(context);
        progress.report({ message: 'scanning (the scan can take up to a few minutes)...' });
        const scan = await scanBytes(bundle, bytes, name, { force, signal: abort.signal });
        return {
          result: scan.result,
          hash: scan.hash,
          scannedName: name,
          fromProbe: scan.fromProbe,
          reportDir: path.join(ctx.spdxDir, OUTPUT_DIR_NAME),
          reportBaseName: sanitizeFileName(name.replace(/\.(spdx|spdx3\.json)$/, '')),
        };
      },
    );
    if (!outcome) {
      return;
    }
    const bundle = await createClientFromConfig(context);
    await presentOutcome(bundle, outcome, () => scanSingleFile(context, ctx, fileUri, true));
  } catch (error) {
    showScanError(error);
  }
}

/**
 * Create a report in the requested format. Reuses the verify pipeline: when the
 * scan result is already stored server side this is just a download.
 */
export async function createReport(
  context: vscode.ExtensionContext,
  node: SpdxTreeNode,
  format: SbomReportFormat,
  runSpdxBuild: SpdxBuildRunner,
): Promise<void> {
  const ctx = resolveSpdxContext(node);
  if (!ctx) {
    return;
  }
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `SBOM Total: Creating ${format.toUpperCase()} report`,
        cancellable: true,
      },
      async (progress, cancel) => {
        const abort = new AbortController();
        cancel.onCancellationRequested(() => abort.abort());
        const outcome = await runScanPipeline(context, ctx, runSpdxBuild, progress, cancel, false);
        if (!outcome || cancel.isCancellationRequested) {
          return;
        }
        progress.report({ message: 'downloading the report...' });
        const bundle = await createClientFromConfig(context);
        getOutputChannel().appendLine(
          `[sbom-total] ${format.toUpperCase()} report for ${outcome.scannedName} (verdict ${outcome.result.verdict}): ${bundle.client.permalinkUrl(outcome.hash)}`,
        );
        await downloadAndOpenReport(bundle, outcome, format, abort.signal);
      },
    );
  } catch (error) {
    await handleScanError(ctx, error, () => createReport(context, node, format, runSpdxBuild));
  }
}
