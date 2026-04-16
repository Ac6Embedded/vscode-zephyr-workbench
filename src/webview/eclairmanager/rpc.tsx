/*
A simple RPC layer
*/

import React from "react";
import type { ExtensionMessage, RpcResponseMessage, WebviewMessage } from "../../utils/eclair/eclairEvent";
import type { EclairRpcMethods, RpcMethodMap } from "../../utils/eclair/eclairRpcTypes";

/**
 * A simple RPC client for communicating with the extension backend. It sends
 * requests via `postMessage` and handles responses asynchronously.
 */
export class RpcClient<M extends RpcMethodMap = RpcMethodMap> {
  private readonly postMessage: (message: WebviewMessage) => void;
  private readonly timeoutMs: number | undefined;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(postMessage: (message: WebviewMessage) => void, options?: RpcClientOptions) {
    this.postMessage = postMessage;
    this.timeoutMs = options?.timeoutMs;
  }

  call<K extends keyof M>(method: K, params: M[K]["params"], options?: RpcClientOptions): Promise<M[K]["result"]> {
    const id = newId();
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;

    type R = M[K]["result"];

    return new Promise<R>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (timeoutMs && timeoutMs > 0) {
        pending.timeoutId = window.setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`RPC timeout after ${timeoutMs}ms: ${String(method)}`));
        }, timeoutMs);
      }
      this.pending.set(id, pending);
      this.postMessage({ command: "rpc-request", id, method: String(method), params });
    });
  }

  handleMessage(message: ExtensionMessage) {
    if (message.command !== "rpc-response") {
      return;
    }
    const response = message;
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    if (pending.timeoutId) {
      window.clearTimeout(pending.timeoutId);
    }
    if (response.error) {
      const err = new Error(response.error.message);
      (err as any).code = response.error.code;
      (err as any).data = response.error.data;
      pending.reject(err);
      return;
    }
    pending.resolve(response.result);
  }

  dispose() {
    for (const [id, pending] of this.pending.entries()) {
      if (pending.timeoutId) {
        window.clearTimeout(pending.timeoutId);
      }
      pending.reject(new Error("RPC client disposed"));
      this.pending.delete(id);
    }
  }
}

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeoutId?: number;
};

export type RpcClientOptions = {
  timeoutMs?: number;
};

const RpcContext = React.createContext<RpcClient<EclairRpcMethods> | null>(null);

export function RpcProvider(props: { client: RpcClient<EclairRpcMethods>; children: React.ReactNode }) {
  return <RpcContext.Provider value={props.client}>{props.children}</RpcContext.Provider>;
}

export function useRpc(): RpcClient<EclairRpcMethods> {
  const client = React.useContext(RpcContext);
  if (!client) {
    throw new Error("RpcClient is not available");
  }
  return client;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `rpc_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}
