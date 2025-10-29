/*
Simple DTS-LSP integration for Zephyr Workbench

Goals
- Dynamically create/update DTS contexts for .overlay and workspace .dts files
- Use build_info.yml for application overlays to derive include paths, bindings, dtsFile, overlays
- Use workspace (west) information for Zephyr tree .dts files
- To make dtsi work, we should keep the parent .dts context (so not closing the .dts)

Notes
- We avoid .dtsi files
- We only call setDefaultSettings to set allowAdhocContexts=false
- We only set third-party API methods: requestContext and setActiveContextByName
- We track created contexts to avoid duplicates and enable removal on file delete or changes

TODO/Improvements
- Better error handling/logging
- Detecting DTS_ROOT for workspace contexts from modules
  Example: hal_stm32 uses DTS from modules/hal/stm32/dts
  Current approach: hard-coded vendor list
  Best practice: How to do it ?
  * Parse west.yml and extract dts_root from zephyr/module.yml
  * This should be done only when parsing the workspaces at startup or creating a new one, cache the results
*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import yaml from 'yaml';

import { WestWorkspace } from '../models/WestWorkspace';
import { ZephyrAppProject } from '../models/ZephyrAppProject';
import { ZephyrProject } from '../models/ZephyrProject';
import { ZephyrProjectBuildConfiguration } from '../models/ZephyrProjectBuildConfiguration';
import { getWestWorkspaces } from './utils';

// Minimal copies of the external types we need
// We keep them narrow to avoid adding new dependencies
interface IntegrationSettingsMinimal {
  allowAdhocContexts?: boolean;
  defaultShowFormattingErrorAsDiagnostics?: boolean;
}

interface DtsContextMinimal {
  ctxName: string;
  cwd?: string; // we keep optional; will omit if empty
  includePaths: string[];
  zephyrBindings: string[];
  bindingType: 'Zephyr';
  deviceOrgTreeBindings: string[];
  deviceOrgBindingsMetaSchema: string[];
  dtsFile?: string;
  overlays?: string[];
  lockRenameEdits: string[];
  compileCommands?: string;
  showFormattingErrorAsDiagnostics?: boolean;
}

interface IDeviceTreeAPIMinimal {
  setDefaultSettings(settings: IntegrationSettingsMinimal): Promise<void>;
  requestContext(ctx: DtsContextMinimal): Promise<any>;
  setActiveContextByName(name: string): Promise<boolean>;
}

let dtsApi: IDeviceTreeAPIMinimal | undefined;
// Track created contexts so we can cleanup/update on file changes
const activeContextsByFile: Map<string, string> = new Map(); // filePath -> ctxName
const fileWatchers: Map<string, vscode.FileSystemWatcher> = new Map(); // filePath -> watcher
const buildInfoWatchers: Map<string, vscode.FileSystemWatcher> = new Map(); // buildInfoPath -> watcher
const pendingContextTimers: Map<string, NodeJS.Timeout> = new Map(); // debounce timers per file
const contextSignatures: Map<string, string> = new Map(); // filePath -> last context signature
const ctxIdByName: Map<string, string> = new Map(); // ctxName -> server context id
let lastActiveCtxName: string | undefined; // local guard to avoid redundant setActive

// Common Zephyr include subdirectories (non-recursive)
const ZEPHYR_DTS_SUBDIRS = [
  '',
  'arc',
  'arm',
  'arm64',
  'common',
  'nios2',
  'posix',
  'riscv',
  'sparc',
  'x86',
  'xtensa',
  'vendor',
];

export async function initDtsIntegration(context: vscode.ExtensionContext) {
  // Try to get the DTS-LSP extension API
  const ext = vscode.extensions.getExtension<IDeviceTreeAPIMinimal>('KyleMicallefBonnici.dts-lsp');
  if (!ext) {
    // Not installed; nothing to do
    return;
  }
  if (!ext.isActive) {
    await ext.activate();
  }
  dtsApi = ext.exports as unknown as IDeviceTreeAPIMinimal;

  if (!dtsApi) {
    return;
  }

  // Only set these knobs: do not allow adhoc contexts and disable formatting errors diagnostics by default
  await dtsApi.setDefaultSettings({ allowAdhocContexts: false, defaultShowFormattingErrorAsDiagnostics: false });
  // Best-effort: also set default on contexts we create, if the API honors it via defaults

  // React to file openings and editor focus changes
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => maybeUpdateDtsContext(doc)),
    vscode.window.onDidChangeActiveTextEditor(e => {
      if (e?.document) { maybeUpdateDtsContext(e.document); }
    }),
    vscode.workspace.onDidCloseTextDocument(doc => removeContextForFile(doc.uri.fsPath))
  );

  // Also try for the currently active editor on activation
  if (vscode.window.activeTextEditor) {
    maybeUpdateDtsContext(vscode.window.activeTextEditor.document);
  }
}

function isOverlayFile(doc: vscode.TextDocument): boolean {
  return doc.languageId === 'plaintext' // language may vary; rely on path
    ? doc.uri.fsPath.endsWith('.overlay')
    : doc.uri.fsPath.endsWith('.overlay');
}

function isDtsFile(doc: vscode.TextDocument): boolean {
  // Explicitly ignore .dtsi
  if (doc.uri.fsPath.endsWith('.dtsi')) { return false; }
  return doc.uri.fsPath.endsWith('.dts');
}

async function maybeUpdateDtsContext(doc: vscode.TextDocument) {
  if (!dtsApi) { return; }

  const filePath = doc.uri.fsPath;

  // Only .overlay and .dts, never .dtsi
  const overlay = isOverlayFile(doc);
  const dts = isDtsFile(doc);
  if (!overlay && !dts) { return; }

  // If .overlay -> Application context using build_info.yml
  if (overlay) {
    await handleApplicationOverlay(filePath);
    return;
  }

  // If .dts -> Workspace context using Zephyr tree
  if (dts) {
    await handleWorkspaceDts(filePath);
    return;
  }
}

async function handleApplicationOverlay(filePath: string) {
  if (!dtsApi) { return; }

  // Find the workspace folder that owns this file
  const wsFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
  if (!wsFolder) { return; }

  // Check this is an application (prj.conf at root). If not, skip.
  if (!ZephyrAppProject.isApplicationFolder(wsFolder)) {
    return; // Not an application folder
  }

  // Make a project instance; configs will be parsed from settings
  const project = new ZephyrAppProject(wsFolder, wsFolder.uri.fsPath);
  const buildConfig = pickActiveOrFirstConfig(project);
  if (!buildConfig) { return; }

  // Parse build_info.yml in the build directory
  const buildDir = buildConfig.getBuildDir(project);
  const infoPath = path.join(buildDir, 'build_info.yml');
  if (!fs.existsSync(infoPath)) {
    // Graceful: nothing to provide yet
    return;
  }

  let raw: any;
  try {
    raw = yaml.parse(fs.readFileSync(infoPath, 'utf-8'));
  } catch {
    return;
  }

  const cmake = raw?.cmake;
  const devicetree = cmake?.devicetree;
  if (!devicetree) { return; }

  // Extract mandatory fields
  const bindingsDirs: string[] = Array.isArray(devicetree['bindings-dirs']) ? devicetree['bindings-dirs'] : [];
  const files: string[] = Array.isArray(devicetree['files']) ? devicetree['files'] : [];
  const userFiles: string[] = Array.isArray(devicetree['user-files']) ? devicetree['user-files'] : [];
  const includeDirs: string[] = Array.isArray(devicetree['include-dirs']) ? devicetree['include-dirs'] : [];

  // dtsFile is the first .dts entry. overlays are the non-.dts entries.
  let dtsFile = '';
  const overlaysSet = new Set<string>();
  for (const f of files) {
    if (f.endsWith('.dts') && !dtsFile) {
      dtsFile = f;
    } else {
      overlaysSet.add(f);
    }
  }
  // Be tolerant and merge user-files as overlays too (helps real world cases)
  for (const f of userFiles) { overlaysSet.add(f); }

  const overlays = Array.from(overlaysSet);

  const compileCommandsPath = path.join(buildDir, 'compile_commands.json');

  // Build a unique context name based on the file path
  const ctxName = `zw:${filePath}`;

  // Normalize and validate paths for the LSP (prefer forward slashes)
  const nInclude = (includeDirs ?? []).filter(dirExists).map(pathNormalizeFs);
  const nBindings = (bindingsDirs ?? []).filter(dirExists).map(pathNormalizeFs);
  const nDtsFile = dtsFile ? pathNormalizeFs(dtsFile) : '';
  const nOverlays = (overlays ?? []).map(pathNormalizeFs);
  const nCompile = fs.existsSync(compileCommandsPath) ? pathNormalizeFs(compileCommandsPath) : '';

  // Create and activate the context
  let ctx: DtsContextMinimal = {
    ctxName,
    cwd: pathNormalizeFs(buildDir),
    includePaths: nInclude,
    zephyrBindings: nBindings,
    bindingType: 'Zephyr',
    deviceOrgTreeBindings: [],
    deviceOrgBindingsMetaSchema: [],
    dtsFile: nDtsFile || '',
    overlays: nOverlays ?? [],
    lockRenameEdits: [],
    compileCommands: nCompile,
    showFormattingErrorAsDiagnostics: false,
  };

  console.log('[ZW][DTS] Application context payload:', JSON.stringify(ctx, null, 2));

  // Build a stable signature so we skip recreating if nothing changed
  const appSig = buildContextSignature({
    mode: 'app',
    cwd: ctx.cwd || '',
    includePaths: ctx.includePaths,
    zephyrBindings: ctx.zephyrBindings,
    dtsFile: ctx.dtsFile || '',
    overlays: ctx.overlays || [],
    compileCommands: ctx.compileCommands || ''
  });

  scheduleContextApply(filePath, async () => {
    if (contextAlreadyExists(ctxName)) {
      console.log('[ZW][DTS] Application context exists, skipping recreate:', ctxName);
      trackContextAndWatchersForOverlay(filePath, ctxName, buildDir);
      if (dtsApi && lastActiveCtxName !== ctxName) {
        await dtsApi.setActiveContextByName(ctxName);
        lastActiveCtxName = ctxName;
      }
      const prev = contextSignatures.get(filePath);
      if (prev && prev === appSig) {
        console.log('[ZW][DTS] Skip recreate: signature unchanged (app):', filePath);
        return;
      }
      return;
    }
    try {
      if (dtsApi) {
        const created: any = await dtsApi.requestContext(ctx);
        if (created && created.id) { ctxIdByName.set(ctxName, created.id); }
      }
      if (dtsApi && lastActiveCtxName !== ctxName) {
        await dtsApi.setActiveContextByName(ctxName);
        lastActiveCtxName = ctxName;
      }
      console.log('[ZW][DTS] Application context created:', ctxName);
      trackContextAndWatchersForOverlay(filePath, ctxName, buildDir);
      contextSignatures.set(filePath, appSig);
    } catch (e: any) {
      console.log('[ZW][DTS] Application context creation failed:', e?.message ?? e);
    }
  });
}

async function handleWorkspaceDts(filePath: string) {
  if (!dtsApi) { return; }

  // Find which west workspace contains this path (case-insensitive on Windows)
  const westWorkspaces = getWestWorkspaces();
  const normFile = normalizeFsPath(filePath);
  const west = westWorkspaces.find(w => normFile.startsWith(normalizeFsPath(w.rootUri.fsPath)));
  if (!west) { return; }

  // Prepare include paths: zephyr/include(+/zephyr) + zephyr/dts + subdirs (non-recursive)
  const zephyrBase = west.kernelUri.fsPath;
  let includePaths: string[] = [];
  includePaths.push(path.join(zephyrBase, 'include'));
  includePaths.push(path.join(zephyrBase, 'include', 'zephyr'));
  includePaths.push(path.join(zephyrBase, 'dts'));
  for (const sub of ZEPHYR_DTS_SUBDIRS) {
    if (sub.length === 0) { continue; } // avoid duplicating zephyr/dts
    includePaths.push(path.join(zephyrBase, 'dts', sub));
  }
  // TODO: improve vendor modules detection (temporary hard-coded vendor DTS roots)
  // Append common vendor HAL roots (DTS trees are expected under each).
  // modules is a sibling of the zephyr folder (same parent as zephyrBase)
  // Basically include modules/hal/<vendor>/dts for known vendors that have dts_root in their module.yml

  const modulesBase = path.join(zephyrBase, '..', 'modules');
  // Vendor roots to append under modules/hal
  const vendorHalRoots = [
    'adi',
    'atmel',
    'microchip',
    'nuvoton',
    'gigadevice',
    'stm32',
    'nxp',
    'espressif',
  ];
  for (const v of vendorHalRoots) {
    includePaths.push(path.join(modulesBase, 'hal', v, 'dts'));
  }

  // Also add vendor bindings if present under modules/hal/<vendor>/dts/bindings
  let vendorBindings: string[] = [];
  for (const v of vendorHalRoots) {
    const vb = path.join(modulesBase, 'hal', v, 'dts', 'bindings');
    if (dirExists(vb)) {
      vendorBindings.push(pathNormalizeFs(vb));
    }
  }

  // Add optional user roots from workspace env (best effort)
  for (const key of ['ARCH_ROOT', 'SOC_ROOT', 'BOARD_ROOT', 'DTS_ROOT'] as const) {
    const vals = west.envVars[key];
    if (Array.isArray(vals)) {
      for (const v of vals) { includePaths.push(v); }
    }
  }

  // Filter only existing directories to satisfy dts-lsp checks
  includePaths = includePaths.filter(p => dirExists(p)).map(pathNormalizeFs);
  const bindingsCandidate = path.join(zephyrBase, 'dts', 'bindings');
  const bindings = [
    ...(dirExists(bindingsCandidate) ? [pathNormalizeFs(bindingsCandidate)] : []),
    ...vendorBindings,
  ];

  console.log('[ZW][DTS] Workspace context for', filePath);
  console.log('[ZW][DTS] includePaths:', includePaths);
  console.log('[ZW][DTS] zephyrBindings:', bindings);

  const ctxName = `zw:${filePath}`;
  let ctx: DtsContextMinimal = {
    ctxName,
    cwd: '',
    includePaths: includePaths ?? [],
    zephyrBindings: bindings ?? [],
    bindingType: 'Zephyr',
    deviceOrgTreeBindings: [],
    deviceOrgBindingsMetaSchema: [],
    dtsFile: pathNormalizeFs(filePath), // workspace: use opened file as main DTS
    overlays: [],
    lockRenameEdits: [],
    compileCommands: '',
    showFormattingErrorAsDiagnostics: false,
  };

  console.log('[ZW][DTS] Workspace context payload:', JSON.stringify(ctx, null, 2));

  const wsSig = buildContextSignature({
    mode: 'ws',
    cwd: ctx.cwd || '',
    includePaths: ctx.includePaths,
    zephyrBindings: ctx.zephyrBindings,
    dtsFile: ctx.dtsFile || '',
    overlays: ctx.overlays || [],
    compileCommands: ctx.compileCommands || ''
  });

  scheduleContextApply(filePath, async () => {
    if (contextAlreadyExists(ctxName)) {
      console.log('[ZW][DTS] Workspace context exists, skipping recreate:', ctxName);
      trackContextAndWatcherForDts(filePath, ctxName);
      if (dtsApi && lastActiveCtxName !== ctxName) {
        await dtsApi.setActiveContextByName(ctxName);
        lastActiveCtxName = ctxName;
      }
      const prev = contextSignatures.get(filePath);
      if (prev && prev === wsSig) {
        console.log('[ZW][DTS] Skip recreate: signature unchanged (ws):', filePath);
        return;
      }
      return;
    }
    try {
      if (bindings.length === 0) {
        console.log('[ZW][DTS] Abort: zephyrBindings dir missing ->', bindingsCandidate);
        return;
      }
      if (includePaths.length === 0) {
        console.log('[ZW][DTS] Abort: no valid includePaths');
        return;
      }
      if (dtsApi) {
        const created: any = await dtsApi.requestContext(ctx);
        if (created && created.id) { ctxIdByName.set(ctxName, created.id); }
      }
      if (dtsApi && lastActiveCtxName !== ctxName) {
        await dtsApi.setActiveContextByName(ctxName);
        lastActiveCtxName = ctxName;
      }
      console.log('[ZW][DTS] Workspace context created:', ctxName);
      trackContextAndWatcherForDts(filePath, ctxName);
      contextSignatures.set(filePath, wsSig);
    } catch (e: any) {
      console.log('[ZW][DTS] Workspace context creation failed:', e?.message ?? e);
    }
  });
}

function pickActiveOrFirstConfig(project: ZephyrProject): ZephyrProjectBuildConfiguration | undefined {
  if (!project.configs || project.configs.length === 0) { return undefined; }
  const active = project.configs.find(c => c.active === true);
  return active ?? project.configs[0];
}

function dirExists(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function normalizeFsPath(p: string): string {
  let n = p.replace(/\\/g, '/');
  if (process.platform === 'win32') { n = n.toLowerCase(); }
  return n;
}

// Remove keys that are empty strings or undefined for optional fields
// Note: We keep empty fields present in payload per server expectations

// Normalize path to absolute forward-slash form for the LSP
function pathNormalizeFs(p: string): string {
  try {
    const abs = path.isAbsolute(p) ? p : path.resolve(p);
    return abs.replace(/\\/g, '/');
  } catch {
    return p.replace(/\\/g, '/');
  }
}

// Watchers and cleanup
function trackContextAndWatcherForDts(filePath: string, ctxName: string) {
  activeContextsByFile.set(filePath, ctxName);
  // Create per-file watcher for change/delete
  if (!fileWatchers.has(filePath)) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(filePath), path.basename(filePath)));
    watcher.onDidChange(() => {
      console.log('[ZW][DTS] DTS changed -> recreate context', filePath);
      handleWorkspaceDts(filePath);
    });
    watcher.onDidDelete(() => {
      console.log('[ZW][DTS] DTS deleted -> remove context', filePath);
      removeContextForFile(filePath);
    });
    fileWatchers.set(filePath, watcher);
  }
}

function trackContextAndWatchersForOverlay(overlayPath: string, ctxName: string, buildDir: string) {
  activeContextsByFile.set(overlayPath, ctxName);
  // Watch overlay file changes
  if (!fileWatchers.has(overlayPath)) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(overlayPath), path.basename(overlayPath)));
    watcher.onDidChange(() => {
      console.log('[ZW][DTS] Overlay changed -> recreate context', overlayPath);
      handleApplicationOverlay(overlayPath);
    });
    watcher.onDidDelete(() => {
      console.log('[ZW][DTS] Overlay deleted -> remove context', overlayPath);
      removeContextForFile(overlayPath);
    });
    fileWatchers.set(overlayPath, watcher);
  }

  // Watch build_info.yml for this overlay's build
  const buildInfo = path.join(buildDir, 'build_info.yml');
  if (!buildInfoWatchers.has(buildInfo)) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(buildInfo), path.basename(buildInfo)));
    watcher.onDidChange(() => {
      console.log('[ZW][DTS] build_info.yml changed -> recreate context for', overlayPath);
      removeContextForFile(overlayPath);
      handleApplicationOverlay(overlayPath);
    });
    watcher.onDidDelete(() => {
      console.log('[ZW][DTS] build_info.yml deleted -> remove context for', overlayPath);
      removeContextForFile(overlayPath);
    });
    buildInfoWatchers.set(buildInfo, watcher);
  }
}

async function removeContextForFile(filePath: string) {
  const ctxName = activeContextsByFile.get(filePath);
  if (!ctxName || !dtsApi) {
    disposeWatcherFor(filePath);
    return;
  }
  try {
    // List contexts before removal for diagnostics
    const before = (await (dtsApi as any).getContexts?.()) ?? [];
    console.log('[ZW][DTS] Contexts BEFORE remove:', before.map((c: any) => ({ id: c.id, names: c.ctxNames })));

    // Prefer stored id from creation
    let id = ctxIdByName.get(ctxName) || '';
    if (!id) {
      // Fallback: resolve by name
      const normTarget = normalizeServerCtxName(ctxName);
      const hit = before.find((c: any) => Array.isArray(c.ctxNames) && c.ctxNames.map(normalizeServerCtxName).includes(normTarget));
      id = hit?.id ?? '';
    }

    if ((dtsApi as any).removeContext && id) {
      await (dtsApi as any).removeContext(id, ctxName);
      console.log('[ZW][DTS] removeContext called for:', { id, ctxName });
      ctxIdByName.delete(ctxName);
    } else {
      console.log('[ZW][DTS] removeContext not called (missing API or id):', { hasApi: !!(dtsApi as any).removeContext, id });
    }

    const after = (await (dtsApi as any).getContexts?.()) ?? [];
    console.log('[ZW][DTS] Contexts AFTER remove:', after.map((c: any) => ({ id: c.id, names: c.ctxNames })));
  } catch (e: any) {
    console.log('[ZW][DTS] Context remove failed:', e?.message ?? e);
  } finally {
    activeContextsByFile.delete(filePath);
    disposeWatcherFor(filePath);
  }
}

function disposeWatcherFor(filePath: string) {
  const fw = fileWatchers.get(filePath);
  if (fw) { fw.dispose(); fileWatchers.delete(filePath); }
}

// Debounce scheduling for context create/update to reduce client races
function scheduleContextApply(filePath: string, fn: () => void | Promise<void>, delayMs = 1) {
  const prev = pendingContextTimers.get(filePath);
  if (prev) { clearTimeout(prev); }
  const t = setTimeout(() => {
    pendingContextTimers.delete(filePath);
    Promise.resolve(fn()).catch(e => console.log('[ZW][DTS] scheduleContextApply error:', e?.message ?? e));
  }, delayMs);
  pendingContextTimers.set(filePath, t);
}

function normalizeServerCtxName(name: string): string {
  // server lowercases and uses backslashes on Windows; strip zw: if present
  return normalizeServerPath(name);
}

function normalizeServerPath(p: string): string {
  const s = p.replace(/^zw:/i, '');
  let n = s.replace(/\//g, '\\');
  if (process.platform === 'win32') { n = n.toLowerCase(); }
  return n;
}

// Check if a context with the given name already exists on the server
function contextAlreadyExists(ctxName: string): boolean {
  // Purely local check to avoid getContexts race; if unknown, we will create and cache id
  return ctxIdByName.has(ctxName);
}

// Removed server-side active checks to avoid racing client newActiveContext handler

// Deterministic signature for a context’s meaningful inputs
function buildContextSignature(input: {
  mode: 'app' | 'ws';
  cwd: string;
  includePaths: string[];
  zephyrBindings: string[];
  dtsFile: string;
  overlays: string[];
  compileCommands: string;
}): string {
  const sort = (arr: string[]) => [...(arr || [])].sort((a, b) => a.localeCompare(b));
  const payload = {
    m: input.mode,
    c: input.cwd || '',
    i: sort(input.includePaths),
    z: sort(input.zephyrBindings),
    d: input.dtsFile || '',
    o: sort(input.overlays),
    cc: input.compileCommands || ''
  };
  return JSON.stringify(payload);
}
