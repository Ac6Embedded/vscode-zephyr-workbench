// Publishes this window's record so the bridge can find it, and keeps it fresh.
//
// The window id is derived from the workspace folders and persisted, so it
// survives a reload. That matters because the id is exported into the
// integrated terminal: a value that changed on every reload would make VS Code
// show its "environment changed, relaunch terminal" prompt every time.

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { normalizeForCompare } from '../core/argSafety';
import { getMcpPaths, McpPaths } from '../core/paths';
import {
  ensureDirs, isPidAlive, markOwnWindowRecordClosing, pruneDeadRecords, readWindowRecords, removeOwnWindowRecord,
  REGISTRY_SCHEMA, WINDOW_ID_PATTERN, WindowRecord, writeWindowRecord,
} from '../core/registry';

const WINDOW_ID_KEY = 'zephyr-workbench.mcp.windowId';
const HANDOFF_KEY = 'zephyr-workbench.mcp.windowHandoffs';
const HEARTBEAT_MS = 30_000;
const PRUNE_MS = 10 * 60_000;

/** A window id left for the extension host that comes back after a folder change. */
interface WindowHandoff {
  windowId: string;
  /** The folders the window will have: only a window with all of them takes the id. */
  folders: string[];
  expiresAt: number;
}

function isHandoff(value: unknown): value is WindowHandoff {
  const h = value as Partial<WindowHandoff> | undefined;
  return !!h && typeof h.windowId === 'string' && WINDOW_ID_PATTERN.test(h.windowId)
    && Array.isArray(h.folders) && h.folders.every(f => typeof f === 'string')
    && typeof h.expiresAt === 'number';
}

/** Every handoff still waiting, from user-wide state: other windows leave theirs there too. */
function readHandoffs(context: vscode.ExtensionContext, now: number): WindowHandoff[] {
  const stored = context.globalState.get<unknown[]>(HANDOFF_KEY);
  return Array.isArray(stored) ? stored.filter(isHandoff).filter(h => h.expiresAt > now) : [];
}

function writeHandoffs(context: vscode.ExtensionContext, handoffs: WindowHandoff[]): Thenable<void> {
  return context.globalState.update(HANDOFF_KEY, handoffs.length > 0 ? handoffs : undefined);
}

/**
 * Keep this window's id across the extension host restart a folder change
 * causes. Adding a folder to an empty or single-folder window gives it a new
 * workspace identity (an untitled multi-root workspace), and so a new
 * workspaceState with no id in it: without a handoff the window would come
 * back under a new id and every job id an agent holds would stop resolving.
 * Await it before changing the folders, so the new host can read it.
 */
export async function rememberWindowHandoff(
  context: vscode.ExtensionContext, windowId: string, expectedFolders: string[], ttlMs = 120_000, now = Date.now(),
): Promise<void> {
  const others = readHandoffs(context, now).filter(h => h.windowId !== windowId);
  await writeHandoffs(context, [...others, { windowId, folders: expectedFolders, expiresAt: now + ttlMs }]);
}

/** Forget this window's handoff, for a folder change that turned out not to restart the host. */
export async function forgetWindowHandoff(context: vscode.ExtensionContext, windowId: string, now = Date.now()): Promise<void> {
  const handoffs = readHandoffs(context, now);
  const kept = handoffs.filter(h => h.windowId !== windowId);
  if (kept.length !== handoffs.length) {
    await writeHandoffs(context, kept);
  }
}

export interface RegistryContent {
  port?: number;
  url?: string;
  token?: string;
  tools?: string[];
  /** Set when this window can never serve; the bridge reports it instead of waking the window. */
  unsupported?: string;
  appRoots: string[];
  westWorkspaces: string[];
  extensionVersion: string;
  catalogVersion: string;
}

/**
 * Id for this window: random, then remembered per workspace so it survives a
 * reload. It used to be a hash of the folder list, which gave two windows on
 * the same folders ("Duplicate As Workspace in New Window") the same id, so
 * they overwrote each other's record and closing one deleted the other's.
 *
 * A fresh handoff left by rememberWindowHandoff wins over a stored id when
 * this window has every folder it expects: that is the same window, back
 * after a folder change restarted its extensions under a new workspace.
 */
export function resolveWindowId(
  context: vscode.ExtensionContext,
  folders: readonly string[] = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
  now = Date.now(),
): string {
  const current = new Set(folders.map(folder => normalizeForCompare(folder)));
  const handoffs = readHandoffs(context, now);
  // A window left with no folder expects an empty window, not any window at all.
  const handoff = handoffs.find(h => h.folders.length === 0
    ? current.size === 0
    : h.folders.every(folder => current.has(normalizeForCompare(folder))));
  if (handoff) {
    void writeHandoffs(context, handoffs.filter(h => h !== handoff));
    void context.workspaceState.update(WINDOW_ID_KEY, handoff.windowId);
    return handoff.windowId;
  }
  const stored = context.workspaceState.get<string>(WINDOW_ID_KEY);
  if (stored && WINDOW_ID_PATTERN.test(stored)) {
    return stored;
  }
  const id = randomBytes(6).toString('hex');
  void context.workspaceState.update(WINDOW_ID_KEY, id);
  return id;
}

export class RegistryWriter implements vscode.Disposable {
  readonly paths: McpPaths;
  private heartbeat: NodeJS.Timeout | undefined;
  private pruneTimer: NodeJS.Timeout | undefined;
  private content: RegistryContent | undefined;
  private startedAt = new Date().toISOString();
  private focusedAt = new Date().toISOString();
  private disposed = false;

  constructor(
    readonly windowId: string,
    homeDirOverride: string | undefined,
    private readonly log: (line: string) => void,
  ) {
    this.paths = getMcpPaths(homeDirOverride);
  }

  /** Publish or refresh the record. Called with no port while dormant. */
  publish(content: RegistryContent): void {
    if (this.disposed) {
      return;
    }
    this.content = content;
    ensureDirs(this.paths);
    writeWindowRecord(this.paths, this.buildRecord(content));
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => this.touch(), HEARTBEAT_MS);
      this.pruneTimer = setInterval(() => this.prune(), PRUNE_MS);
      this.prune();
    }
  }

  /**
   * Take the record down while the window stays open, for when the user turns
   * the integration off. `publish` puts it back.
   */
  withdraw(): void {
    this.content = undefined;
    this.stopTimers();
    removeOwnWindowRecord(this.paths, this.windowId, process.pid);
  }

  /** Rewrite the record with fresh timestamps and folder lists. */
  touch(focused?: boolean): void {
    if (!this.content || this.disposed) {
      return;
    }
    if (focused) {
      this.focusedAt = new Date().toISOString();
    }
    try {
      writeWindowRecord(this.paths, this.buildRecord(this.content));
    } catch (error) {
      this.log(`could not refresh the window record: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** True when a bridge asked a dormant window to start listening. */
  consumeWakeRequest(): boolean {
    const marker = this.paths.wakeMarker(this.windowId);
    try {
      if (fs.existsSync(marker)) {
        fs.unlinkSync(marker);
        return true;
      }
    } catch {
      // A wake marker we cannot read is the same as none.
    }
    return false;
  }

  /** Other windows that are really there: not closing, and not a local process that died. */
  otherWindows(): WindowRecord[] {
    return readWindowRecords(this.paths)
      .filter(r => r.windowId !== this.windowId && r.closingAt === undefined && isPidAlive(r) !== false);
  }

  private prune(): void {
    try {
      const removed = pruneDeadRecords(this.paths, Date.now());
      if (removed.length > 0) {
        this.log(`removed ${removed.length} stale window record(s)`);
      }
    } catch {
      // Pruning is best effort by design.
    }
  }

  private buildRecord(content: RegistryContent): WindowRecord {
    return {
      schema: REGISTRY_SCHEMA,
      windowId: this.windowId,
      pid: process.pid,
      platform: process.platform,
      hostname: os.hostname(),
      ...(content.port ? { port: content.port, url: content.url, token: content.token } : {}),
      ...(content.tools ? { tools: content.tools } : {}),
      ...(content.unsupported ? { unsupported: content.unsupported } : {}),
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
      workspaceFile: vscode.workspace.workspaceFile?.fsPath ?? null,
      appRoots: content.appRoots,
      westWorkspaces: content.westWorkspaces,
      ide: {
        name: vscode.env.appName,
        version: vscode.version,
        uriScheme: vscode.env.uriScheme,
        remoteName: vscode.env.remoteName ?? null,
      },
      nodeExecPath: process.execPath,
      extensionVersion: content.extensionVersion,
      catalogVersion: content.catalogVersion,
      startedAt: this.startedAt,
      focusedAt: this.focusedAt,
      heartbeatAt: new Date().toISOString(),
    };
  }

  private stopTimers(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimers();
    // A reload looks exactly like a close from here, so leave a closing
    // record: bridges wait for this window instead of picking another.
    markOwnWindowRecordClosing(this.paths, this.windowId, process.pid);
  }
}
