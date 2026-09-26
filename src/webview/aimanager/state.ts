// The shape the panel posts in, and the messages the webview posts back.

export interface ToolRow {
  name: string;
  title: string;
  /** What the tool does, in a sentence or two, for its tooltip. */
  summary?: string;
  category: string;
  read_only: boolean;
  destructive: boolean;
  disabled: boolean;
  /** Confirmation categories this tool can ask about. */
  asks: string[];
}

export interface JobRow {
  job_id: string;
  kind: string;
  status: string;
  config_name?: string;
  app_path?: string;
  started_at?: string;
  /** The command line, already redacted. */
  command?: string;
}

export interface ServerState {
  running: boolean;
  /** The zephyr-workbench.mcp.enabled setting: auto, on or off. */
  enabled?: string;
  /** Stopped from VS Code, so an agent cannot start it again. */
  stopped_by_user?: boolean;
  supported: boolean;
  unsupported_reason?: string;
  window_id: string;
  port?: number;
  url?: string;
  toolset: string;
  tool_count: number;
  tools: ToolRow[];
  workspace_folders: string[];
  jobs: JobRow[];
  other_windows: number;
  confirm_actions: string[];
  /** The tool waiting for the user's answer in a dialog, if any. */
  pending_confirmation?: string;
  session_approvals: number;
  /** A connection test is running. */
  testing?: boolean;
  /** The last connection test of this window. */
  last_test?: ConnectionTest;
}

/** The result of Test connection: every check an agent's connection depends on. */
export interface ConnectionTest {
  at: string;
  checks: { name: string; ok: boolean; detail: string; fix?: string }[];
}

export interface AgentRow {
  id: string;
  label: string;
  detected: boolean;
  /** `other` is an entry the agent reports that no file read here holds; `account` its online account. */
  scope: 'user' | 'project' | 'other' | 'account';
  file?: string;
  /** Whether the file is on disk yet. */
  exists?: boolean;
  /** VS Code adds the server itself, through its install link, rather than a file written here. */
  via_link?: boolean;
  /** The agent got the server from this extension directly, with no file: Copilot in VS Code. */
  automatic?: boolean;
  state: 'configured' | 'outdated' | 'not-configured' | 'foreign' | 'no-file';
  note?: string;
  /** How to sign in to a server that asks for it, with this agent. */
  sign_in?: string;
  /** The entry reaches the server under another name, such as one added by hand or an account connector. */
  alias?: string;
  /** What the agent itself reported about the server, when it could be asked. */
  health?: 'connected' | 'needs-auth' | 'failed' | 'unknown';
  /** The agent is being asked right now. */
  checking?: boolean;
  /** Only a name suggests it: the agent could not confirm it. */
  unverified?: boolean;
  /** Why the agent could not be asked. */
  check_error?: string;
  /** Where the entry lives when it is not a file. */
  source?: string;
}

/** The three pages of the AI Manager. */
export type AiManagerView = 'workbench' | 'zephyr' | 'skills';

/** The Zephyr Project's MCP server, and where each agent stands with it. */
export interface ZephyrMcpState {
  name: string;
  url: string;
  agents: AgentRow[];
}

export interface AiManagerState {
  view: AiManagerView;
  /** The page of the Zephyr Workbench MCP view. */
  tab: 'connections' | 'tools';
  server: ServerState;
  launcher: { command: string; args: string[]; env: Record<string, string> };
  bridge: { path: string; installed: boolean; launcher_path?: string; home: string };
  workspace_folder?: string;
  agents: AgentRow[];
  zephyr: ZephyrMcpState;
  platform: string;
  home: string;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

let cached: VsCodeApi | undefined;
export function vscodeApi(): VsCodeApi {
  cached ??= acquireVsCodeApi();
  return cached;
}

export function post(message: Record<string, unknown>): void {
  vscodeApi().postMessage(message);
}
