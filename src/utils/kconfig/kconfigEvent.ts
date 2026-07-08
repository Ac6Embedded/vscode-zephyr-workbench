// postMessage envelope between the Kconfig Manager panel and its webview.
// The rpc-request/rpc-response shape matches the workbench's Eclair layer so the
// webview can reuse the same generic RpcClient.

import type { KconfigEvent } from './kconfigRpcTypes';

export type RpcRequestMessage = {
  command: 'rpc-request';
  id: string;
  method: string;
  params?: any;
};

export type RpcResponseMessage = {
  command: 'rpc-response';
  id: string;
  result?: any;
  error?: { message: string; code?: string; data?: any };
};

/** extension host -> webview */
export type KcExtensionMessage =
  | RpcResponseMessage
  | { command: 'kconfig-event'; event: KconfigEvent };

/** webview -> extension host */
export type KcWebviewMessage =
  | RpcRequestMessage
  | { command: 'webview-ready' };
