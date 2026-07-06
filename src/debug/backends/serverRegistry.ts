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

export function registerManagedServer(entry: Omit<ManagedServerEntry, 'orphanTimer'>): void {
  const managed: ManagedServerEntry = { ...entry };
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

export async function disposeServerForToken(token: string | undefined): Promise<void> {
  if (!token) {
    return;
  }
  const entry = managedServers.get(token);
  if (!entry) {
    return;
  }
  managedServers.delete(token);
  if (entry.orphanTimer) {
    clearTimeout(entry.orphanTimer);
  }
  await entry.proc.dispose();
}

export async function disposeAllManagedServers(): Promise<void> {
  const entries = Array.from(managedServers.values());
  managedServers.clear();
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
