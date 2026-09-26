// Zero-config registration with editors that have their own MCP API.
//
// GitHub Copilot in VS Code: `vscode.lm.registerMcpServerDefinitionProvider`,
// finalized in VS Code 1.101. Cursor: `vscode.cursor.mcp.registerServer`.
// Neither exists in the @types/vscode 1.88 typings this extension builds
// against, and `vsce` refuses newer typings than `engines.vscode`, so the
// surface is described locally and every use is feature-detected. That is more
// honest than an ambient declaration, which would tell the compiler the API
// always exists on a 1.88 host when it does not.
//
// Both are registered as a stdio definition that runs the extension's own copy
// of the bridge, pinned to this window. A stdio definition is spawned as a
// child of the extension host, so it also works in Remote-SSH and WSL windows
// and no token ever leaves the window record.

import * as path from 'path';
import * as vscode from 'vscode';
import { SERVER_NAME } from '../core/catalog';
import { BRIDGE_NAME, MCP_HOME_ENV } from '../core/paths';

interface StdioDefinition {
  label: string;
  command: string;
  args: string[];
  env: Record<string, string | number | null>;
  version?: string;
}

type StdioDefinitionCtor = new (
  label: string, command: string, args?: string[],
  env?: Record<string, string | number | null>, version?: string,
) => StdioDefinition;

interface DefinitionProvider {
  onDidChangeMcpServerDefinitions?: vscode.Event<void>;
  provideMcpServerDefinitions(token: vscode.CancellationToken): vscode.ProviderResult<StdioDefinition[]>;
  resolveMcpServerDefinition?(server: StdioDefinition, token: vscode.CancellationToken): vscode.ProviderResult<StdioDefinition>;
}

interface VsCodeMcpApi {
  lm?: {
    registerMcpServerDefinitionProvider?(id: string, provider: DefinitionProvider): vscode.Disposable;
  };
  McpStdioServerDefinition?: StdioDefinitionCtor;
}

interface CursorMcpApi {
  cursor?: {
    mcp?: {
      registerServer?(config: { name: string; server: { command: string; args: string[]; env: Record<string, string> } }): void;
      unregisterServer?(name: string): void;
    };
  };
}

/** Must match `contributes.mcpServerDefinitionProviders[].id` in package.json. */
export const PROVIDER_ID = 'zephyr-workbench.mcp';

export interface RegistrationContext {
  extensionUri: vscode.Uri;
  windowId: string;
  /** Changes whenever the visible tool list changes, so the editor refreshes. */
  version(): string;
  /** The `zephyr-workbench.mcp.homeDir` setting, empty for the default. */
  homeDir(): string;
  /** Called when the editor is about to start the server. */
  ensureStarted(): Promise<void>;
  log(line: string): void;
}

function bridgeCommand(context: RegistrationContext) {
  // The extension's own copy, not the stable one: it always matches this
  // extension's version, and the editor spawns it directly.
  const bridge = path.join(vscode.Uri.joinPath(context.extensionUri, 'out').fsPath, BRIDGE_NAME);
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' };
  const home = context.homeDir();
  if (home) {
    // Without it the bridge would look for window records in the default
    // folder and never find this window.
    env[MCP_HOME_ENV] = home;
  }
  return {
    command: process.execPath,
    args: [bridge, '--window', context.windowId],
    env,
  };
}

export function hasVsCodeMcpApi(): boolean {
  const api = vscode as unknown as VsCodeMcpApi;
  return typeof api.lm?.registerMcpServerDefinitionProvider === 'function'
    && typeof api.McpStdioServerDefinition === 'function';
}

export function hasCursorMcpApi(): boolean {
  return typeof (vscode as unknown as CursorMcpApi).cursor?.mcp?.registerServer === 'function';
}

export class EditorRegistrations implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private cursorRegistered = false;
  /** GitHub Copilot in VS Code gets the server from this extension, with no file written. */
  vsCodeRegistered = false;

  constructor(private readonly context: RegistrationContext) {}

  register(): void {
    this.registerVsCode();
    this.registerCursor();
  }

  /** Tell the editor the tool list changed so it refreshes its view of the server. */
  notifyChanged(): void {
    this.changed.fire();
  }

  private registerVsCode(): void {
    if (!hasVsCodeMcpApi()) {
      return;
    }
    const api = vscode as unknown as Required<VsCodeMcpApi>;
    const Definition = api.McpStdioServerDefinition as StdioDefinitionCtor;
    const register = api.lm.registerMcpServerDefinitionProvider as NonNullable<
      NonNullable<VsCodeMcpApi['lm']>['registerMcpServerDefinitionProvider']>;
    try {
      this.disposables.push(register(PROVIDER_ID, {
        onDidChangeMcpServerDefinitions: this.changed.event,
        // Called eagerly by the editor, so it must not start anything.
        provideMcpServerDefinitions: () => {
          const { command, args, env } = bridgeCommand(this.context);
          return [new Definition('Zephyr Workbench', command, args, env, this.context.version())];
        },
        // Called only when the editor actually starts the server: this is the
        // moment to open the listener the bridge will connect to.
        resolveMcpServerDefinition: async server => {
          await this.context.ensureStarted();
          return server;
        },
      }));
      this.vsCodeRegistered = true;
      this.context.log('registered with the VS Code MCP API for GitHub Copilot.');
    } catch (error) {
      this.context.log(`could not register with the VS Code MCP API: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private registerCursor(): void {
    if (!hasCursorMcpApi()) {
      return;
    }
    const mcp = (vscode as unknown as CursorMcpApi).cursor?.mcp;
    try {
      const { command, args, env } = bridgeCommand(this.context);
      mcp?.registerServer?.({ name: SERVER_NAME, server: { command, args, env } });
      this.cursorRegistered = true;
      this.context.log('registered with the Cursor MCP API.');
    } catch (error) {
      this.context.log(`could not register with Cursor: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  dispose(): void {
    if (this.cursorRegistered) {
      try {
        (vscode as unknown as CursorMcpApi).cursor?.mcp?.unregisterServer?.(SERVER_NAME);
      } catch {
        // The editor is shutting down anyway.
      }
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }
}
