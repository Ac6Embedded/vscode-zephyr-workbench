// The MCP SDK is loaded lazily and only behind a Node version gate.
//
// The 2.0 packages require Node 20, while `engines.vscode ^1.88.0` allows an
// extension host on Node 18.18 (VS Code 1.88 and 1.89). A static import would
// run the SDK's top-level code on those hosts; a dynamic import inside a gate
// means the feature is simply absent there and activation is unaffected.

export const MIN_NODE_MAJOR = 20;

export function hostNodeMajor(): number {
  return Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
}

export function isSdkSupported(): boolean {
  return hostNodeMajor() >= MIN_NODE_MAJOR;
}

export const UNSUPPORTED_MESSAGE =
  'The Zephyr Workbench MCP server needs VS Code 1.90 or later (its extension host runs Node 20). '
  + 'Everything else in the extension is unaffected.';

/**
 * The SDK ships both ESM and CJS declaration files, and `typeof import(...)` in
 * a type position picks the ESM ones while the runtime `await import()` under a
 * CJS bundle picks the CJS ones. Those two declare the same private fields
 * separately, so they are not assignable to each other. Deriving the type from
 * the loader itself keeps exactly one source of truth.
 */
async function importSdk() {
  return {
    server: await import('@modelcontextprotocol/server'),
    node: await import('@modelcontextprotocol/node'),
  };
}

export type LoadedSdk = Awaited<ReturnType<typeof importSdk>>;
export type McpServerModule = LoadedSdk['server'];
export type McpNodeModule = LoadedSdk['node'];

let cached: Promise<LoadedSdk> | undefined;

/** Load the SDK once. Rejects when the host is too old to run it. */
export function loadSdk(): Promise<LoadedSdk> {
  if (!isSdkSupported()) {
    return Promise.reject(new Error(UNSUPPORTED_MESSAGE));
  }
  if (!cached) {
    cached = importSdk();
  }
  return cached;
}
