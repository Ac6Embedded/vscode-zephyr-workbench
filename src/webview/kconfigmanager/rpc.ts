// Framework-free RPC client for the Kconfig Manager webview. Mirrors the workbench's
// Eclair RpcClient (src/webview/eclairmanager/rpc.tsx) minus the React context, and adds
// a typed method map plus a push-event listener for `kconfig-event` messages.

import type { KconfigRpcMethods, KconfigEvent } from '../../utils/kconfig/kconfigRpcTypes';

type WebviewApi = {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

type Pending = { resolve: (v: any) => void; reject: (e: any) => void; timer?: number };

let seq = 0;
function newId(): string {
  return `rpc_${++seq}_${(typeof performance !== 'undefined' ? Math.floor(performance.now()) : seq)}`;
}

export class KconfigRpc {
  private readonly pending = new Map<string, Pending>();
  private readonly eventHandlers = new Set<(e: KconfigEvent) => void>();

  constructor(private readonly api: WebviewApi, private readonly defaultTimeoutMs = 130000) {
    window.addEventListener('message', (ev) => this.onMessage(ev.data));
  }

  call<K extends keyof KconfigRpcMethods>(
    method: K,
    params?: KconfigRpcMethods[K]['params'],
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<KconfigRpcMethods[K]['result']> {
    const id = newId();
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? window.setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC ${String(method)} timed out`)); }, timeoutMs)
        : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.api.postMessage({ command: 'rpc-request', id, method, params });
    });
  }

  /** Subscribe to push events; returns an unsubscribe function. */
  onEvent(handler: (e: KconfigEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  ready() {
    this.api.postMessage({ command: 'webview-ready' });
  }

  private onMessage(msg: any) {
    if (!msg || typeof msg !== 'object') { return; }
    if (msg.command === 'rpc-response') {
      const p = this.pending.get(msg.id);
      if (!p) { return; }
      this.pending.delete(msg.id);
      if (p.timer !== undefined) { window.clearTimeout(p.timer); }
      if (msg.error) {
        const err = new Error(msg.error.message);
        (err as any).code = msg.error.code;
        p.reject(err);
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.command === 'kconfig-event') {
      for (const h of this.eventHandlers) { h(msg.event); }
    }
  }
}

declare function acquireVsCodeApi(): WebviewApi;

let cached: WebviewApi | undefined;
export function getVsCodeApi(): WebviewApi {
  if (!cached) { cached = acquireVsCodeApi(); }
  return cached;
}

export function loadPersistedState<T>(): Partial<T> {
  try { return (getVsCodeApi().getState() as Partial<T>) ?? {}; } catch { return {}; }
}

export function savePersistedState(state: unknown): void {
  try { getVsCodeApi().setState(state); } catch { /* ignore */ }
}
