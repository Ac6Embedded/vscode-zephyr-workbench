import * as vscode from 'vscode';

import { ZW_SERVER_TOKEN_KEY } from './types';
import { ManagedServerProcess } from './serverProcess';

/**
 * Grace period for a spawned server whose debug session never starts (user
 * cancelled between resolve and launch, cortex-debug failed to start, ...).
 */
const ORPHAN_SERVER_TIMEOUT_MS = 60000;

interface ManagedServerEntry {
  token: string;
  appRootPath: string;
  buildConfigName?: string;
  port: string;
  proc: ManagedServerProcess;
  orphanTimer?: NodeJS.Timeout;
  /** True once a debug session is running against this server. */
  attached?: boolean;
}

const managedServers = new Map<string, ManagedServerEntry>();
/** When each server was registered, by token. */
const registeredAt = new Map<string, number>();

/**
 * The last output of servers that went away, newest last: when a debug
 * session fails to start, the provider disposes its server before the caller
 * can ask why.
 */
const endedServers: { appRootPath: string; registeredAt: number; tail?: string }[] = [];
const ENDED_SERVERS_KEPT = 5;

function rememberEnded(entry: ManagedServerEntry): void {
  endedServers.push({ appRootPath: entry.appRootPath, registeredAt: registeredAt.get(entry.token) ?? 0, tail: entry.proc.outputTail() });
  registeredAt.delete(entry.token);
  if (endedServers.length > ENDED_SERVERS_KEPT) {
    endedServers.shift();
  }
}

export function registerManagedServer(entry: Omit<ManagedServerEntry, 'orphanTimer'>): void {
  const managed: ManagedServerEntry = { ...entry };
  registeredAt.set(managed.token, Date.now());
  managed.orphanTimer = setTimeout(() => {
    void disposeServerForToken(managed.token);
  }, ORPHAN_SERVER_TIMEOUT_MS);
  managedServers.set(managed.token, managed);

  // Self-cleanup when the server dies on its own.
  void managed.proc.exited.then(() => {
    const current = managedServers.get(managed.token);
    if (current === managed) {
      if (current.orphanTimer) {
        clearTimeout(current.orphanTimer);
      }
      managedServers.delete(managed.token);
      rememberEnded(current);
    }
  });
}

/**
 * Find a STALE server of ours holding a port: one whose debug session never
 * attached (or already ended). Servers with a live attached session are never
 * returned — a second launch on the same port must fail with the port-in-use
 * error instead of killing the running session.
 */
export function findManagedServerByAppAndPort(appRootPath: string, port: string): ManagedServerEntry | undefined {
  for (const entry of managedServers.values()) {
    if (entry.appRootPath === appRootPath && entry.port === port && !entry.proc.hasExited() && !entry.attached) {
      return entry;
    }
  }
  return undefined;
}

/**
 * The last lines the west debug server of a session printed, by the token of
 * its cortex-debug session; or, without a token, of the newest server of an
 * application, for a session that never started. With `since` (a Date.now()
 * time), only a server registered from then on counts, including one already
 * gone, so an older server of the application is never taken for it.
 * Undefined when none is known.
 */
export function serverOutputTail(lookup: { token?: string; appRootPath?: string; since?: number }): string | undefined {
  if (lookup.token) {
    return managedServers.get(lookup.token)?.proc.outputTail();
  }
  if (lookup.appRootPath) {
    if (lookup.since !== undefined) {
      const since = lookup.since;
      const candidates = [
        ...endedServers.filter(entry => entry.appRootPath === lookup.appRootPath && entry.registeredAt >= since),
        ...[...managedServers.values()]
          .filter(entry => entry.appRootPath === lookup.appRootPath && (registeredAt.get(entry.token) ?? 0) >= since)
          .map(entry => ({ registeredAt: registeredAt.get(entry.token) ?? 0, tail: entry.proc.outputTail() })),
      ].sort((a, b) => a.registeredAt - b.registeredAt);
      return candidates.length > 0 ? candidates[candidates.length - 1].tail : undefined;
    }
    const entries = [...managedServers.values()].filter(entry => entry.appRootPath === lookup.appRootPath);
    return entries.length > 0 ? entries[entries.length - 1].proc.outputTail() : undefined;
  }
  return undefined;
}

export async function disposeServerForToken(token: string | undefined): Promise<void> {
  if (!token) {
    return;
  }
  const entry = managedServers.get(token);
  if (!entry) {
    return;
  }
  managedServers.delete(token);
  rememberEnded(entry);
  if (entry.orphanTimer) {
    clearTimeout(entry.orphanTimer);
  }
  await entry.proc.dispose();
}

export async function disposeAllManagedServers(): Promise<void> {
  const entries = Array.from(managedServers.values());
  managedServers.clear();
  registeredAt.clear();
  await Promise.all(entries.map(entry => {
    if (entry.orphanTimer) {
      clearTimeout(entry.orphanTimer);
    }
    return entry.proc.dispose().catch(() => undefined);
  }));
}

function getSessionServerToken(session: vscode.DebugSession): string | undefined {
  const token = session.configuration?.[ZW_SERVER_TOKEN_KEY];
  return typeof token === 'string' ? token : undefined;
}

/**
 * Correlate debug sessions with their spawned west debug servers by the
 * transient token stamped into the resolved configuration (never by display
 * name — names are neither unique nor stable).
 */
export function attachDebugSessionLifecycle(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession(session => {
      const token = getSessionServerToken(session);
      if (!token) {
        return;
      }
      const entry = managedServers.get(token);
      if (entry) {
        entry.attached = true;
        if (entry.orphanTimer) {
          clearTimeout(entry.orphanTimer);
          entry.orphanTimer = undefined;
        }
      }
    }),
    vscode.debug.onDidTerminateDebugSession(session => {
      void disposeServerForToken(getSessionServerToken(session));
    }),
  );
}
