// One descriptor per supported agent: where its config lives, what shape the
// entry takes, and how to place it. Adding an agent is adding a descriptor.
//
// Four config shapes cover every client, which is most of this feature:
//   mcpServers  Claude Code, Cursor, Antigravity, Copilot CLI
//   servers     VS Code
//   mcp         opencode
//   [mcp_servers.<name>]  Codex, in TOML
// Two traps are easy to miss: Antigravity needs `serverUrl` rather than `url`
// for a remote server, and opencode takes `command` as an ARRAY.

import * as os from 'os';
import * as path from 'path';
import { SERVER_NAME } from '../core/catalog';
import { claudeConfigDir } from './claudeCli';
import { LauncherSpec } from './launcher';

export type AgentId =
  | 'claude-code' | 'codex' | 'vscode-copilot' | 'cursor'
  | 'antigravity' | 'opencode' | 'copilot-cli';

export type AgentScope = 'user' | 'project';

export interface AgentDescriptor {
  id: AgentId;
  label: string;
  /** Format of the config file. */
  format: 'json' | 'toml';
  /** Key path the server entry is written under, for JSON agents. */
  containerPath?: string[];
  /** Config file for a scope, or undefined when the agent has none. */
  file(scope: AgentScope, workspaceFolder?: string): string | undefined;
  /** The server entry for a stdio launcher. */
  entry(launcher: LauncherSpec): unknown;
  /** The server entry for a remote server on the streamable HTTP transport, in the file of `scope`. */
  remoteEntry?(url: string, scope: AgentScope): unknown;
  /**
   * How this agent's project file names the user's home folder in a command,
   * so one committed file works for every developer. Each is documented by
   * the agent: `${HOME}` (Claude Code, Copilot CLI), `${userHome}`
   * (VS Code, Cursor), `{env:HOME}` (opencode). Codex expands nothing.
   */
  homeVariable?: string;
  /** Extra guidance shown in the panel next to this agent. */
  note?: string;
  /** How the user signs in to the remote server `name` when it asks, as the Zephyr Project's does. */
  signIn?(name: string): string;
  /** Paths that prove the agent is installed. */
  detect(): string[];
}

const home = () => os.homedir();
const inHome = (...segments: string[]) => path.join(home(), ...segments);

/** Codex keeps everything in $CODEX_HOME, which defaults to ~/.codex. */
function codexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? configured : inHome('.codex');
}

/** opencode follows the XDG base directory rule on every platform. */
function xdgConfigHome(): string {
  const configured = process.env.XDG_CONFIG_HOME?.trim();
  return configured ? configured : inHome('.config');
}

function claudeUserFile(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? path.join(configured, '.claude.json') : inHome('.claude.json');
}

/** Generous per-call timeouts, because a pristine Zephyr build takes minutes. */
const TOOL_TIMEOUT_SEC = 1800;
const TOOL_TIMEOUT_MS = TOOL_TIMEOUT_SEC * 1000;

export const AGENTS: readonly AgentDescriptor[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    format: 'json',
    homeVariable: '${HOME}',
    containerPath: ['mcpServers'],
    // The user file is rewritten constantly by Claude Code itself, so the panel
    // prefers the CLI for user scope and only edits the project file directly.
    // CLAUDE_CONFIG_DIR moves the user file along with everything else.
    file: (scope, folder) => (scope === 'project' && folder ? path.join(folder, '.mcp.json') : claudeUserFile()),
    entry: launcher => ({
      type: 'stdio',
      command: launcher.command,
      args: launcher.args,
      ...(Object.keys(launcher.env).length ? { env: launcher.env } : {}),
    }),
    remoteEntry: url => ({ type: 'http', url }),
    note: 'The CLI and the VS Code extension share this configuration. A project entry needs workspace trust.',
    signIn: name => `To sign in, run /mcp in Claude Code and pick ${name}, or run claude mcp login ${name} in a terminal.`,
    detect: () => [
      claudeUserFile(),
      inHome('.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
      path.join(claudeConfigDir(), 'local', 'claude'),
    ],
  },
  {
    id: 'codex',
    label: 'OpenAI Codex',
    format: 'toml',
    // User scope only: a project row would point at the same user file.
    file: scope => (scope === 'user' ? path.join(codexHome(), 'config.toml') : undefined),
    entry: launcher => ({
      command: launcher.command,
      args: launcher.args,
      ...(Object.keys(launcher.env).length ? { env: launcher.env } : {}),
      startup_timeout_sec: 20,
      tool_timeout_sec: TOOL_TIMEOUT_SEC,
    }),
    remoteEntry: url => ({ url }),
    signIn: name => `To sign in, run codex mcp login ${name} in a terminal.`,
    note: 'The CLI, the IDE extension and the desktop app share this file, and it usually holds your own settings, so the entry is written as a marked block.',
    detect: () => [path.join(codexHome(), 'config.toml'), '/Applications/ChatGPT.app/Contents/Resources/codex'],
  },
  {
    id: 'vscode-copilot',
    label: 'GitHub Copilot in VS Code',
    format: 'json',
    homeVariable: '${userHome}',
    containerPath: ['servers'],
    file: (scope, folder) => (scope === 'project' && folder ? path.join(folder, '.vscode', 'mcp.json') : undefined),
    entry: launcher => ({
      type: 'stdio',
      command: launcher.command,
      args: launcher.args,
      ...(Object.keys(launcher.env).length ? { env: launcher.env } : {}),
    }),
    remoteEntry: url => ({ type: 'http', url }),
    signIn: () => 'VS Code asks you to allow the sign-in the first time it starts the server, and lists it in its MCP Servers view.',
    note: 'On VS Code 1.101 and later the extension registers the server directly, so no file is needed.',
    detect: () => [],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    format: 'json',
    homeVariable: '${userHome}',
    containerPath: ['mcpServers'],
    file: (scope, folder) => (scope === 'project' && folder
      ? path.join(folder, '.cursor', 'mcp.json')
      : inHome('.cursor', 'mcp.json')),
    entry: launcher => ({
      type: 'stdio',
      command: launcher.command,
      args: launcher.args,
      ...(Object.keys(launcher.env).length ? { env: launcher.env } : {}),
    }),
    remoteEntry: url => ({ url }),
    signIn: name => `Cursor asks you to sign in when it first connects to ${name}. Cursor Settings, MCP, shows whether it is waiting for that.`,
    detect: () => [inHome('.cursor'), '/Applications/Cursor.app'],
  },
  {
    // Google's successor of Gemini CLI. It kept Gemini's home folder, ~/.gemini,
    // and reads MCP servers from one file there, which its CLI and IDE share.
    id: 'antigravity',
    label: 'Antigravity',
    format: 'json',
    containerPath: ['mcpServers'],
    // User scope only: Antigravity documents .agents/mcp_config.json for a
    // project, but its CLI is reported to ignore project MCP servers.
    file: scope => (scope === 'user' ? inHome('.gemini', 'config', 'mcp_config.json') : undefined),
    entry: launcher => ({
      command: launcher.command,
      args: launcher.args,
      ...(Object.keys(launcher.env).length ? { env: launcher.env } : {}),
    }),
    remoteEntry: url => ({ serverUrl: url }),
    signIn: name => `Type /mcp in Antigravity CLI to see whether it reached ${name}. Antigravity does not follow the MCP sign-in flow yet, so a server that asks for one may not connect.`,
    note: 'The Antigravity CLI and IDE share this file. Antigravity generates its own copies from it, so do not edit those.',
    detect: () => [
      inHome('.gemini', 'config', 'mcp_config.json'),
      inHome('.gemini', 'antigravity-cli'),
      inHome('.gemini', 'antigravity-ide'),
      inHome('.antigravitycli'),
    ],
  },
  {
    id: 'opencode',
    label: 'opencode',
    format: 'json',
    homeVariable: '{env:HOME}',
    containerPath: ['mcp'],
    file: (scope, folder) => (scope === 'project' && folder
      ? path.join(folder, 'opencode.json')
      : path.join(xdgConfigHome(), 'opencode', 'opencode.json')),
    entry: launcher => ({
      type: 'local',
      // opencode takes the whole command line as an array, not command plus args.
      command: [launcher.command, ...launcher.args],
      ...(Object.keys(launcher.env).length ? { environment: launcher.env } : {}),
      enabled: true,
      // In opencode this same value also caps every tool call.
      timeout: TOOL_TIMEOUT_MS,
    }),
    remoteEntry: url => ({ type: 'remote', url, enabled: true }),
    signIn: name => `opencode asks you to sign in the first time it uses the server, or run opencode mcp auth ${name} in a terminal.`,
    detect: () => [path.join(xdgConfigHome(), 'opencode')],
  },
  {
    id: 'copilot-cli',
    label: 'GitHub Copilot CLI',
    format: 'json',
    homeVariable: '${HOME}',
    containerPath: ['mcpServers'],
    file: (scope, folder) => (scope === 'project' && folder
      ? path.join(folder, '.mcp.json')
      : inHome('.copilot', 'mcp-config.json')),
    entry: launcher => ({
      type: 'stdio',
      command: launcher.command,
      args: launcher.args,
      ...(Object.keys(launcher.env).length ? { env: launcher.env } : {}),
    }),
    // The same shapes as Claude Code on purpose: both read a project .mcp.json,
    // and two shapes in one file would make each look outdated to the other.
    // Its reference requires `tools` in its own file. A project .mcp.json is
    // shared with Claude Code, so there the entry keeps Claude's exact shape,
    // as the Copilot CLI examples for .mcp.json do.
    remoteEntry: (url, scope) => (scope === 'user' ? { type: 'http', url, tools: ['*'] } : { type: 'http', url }),
    signIn: name => `To sign in, run /mcp auth ${name} in Copilot CLI.`,
    note: 'Copilot CLI does not read .vscode/mcp.json. At project scope it shares .mcp.json with Claude Code.',
    detect: () => [inHome('.copilot')],
  },
] as const;

export function findAgent(id: string): AgentDescriptor | undefined {
  return AGENTS.find(agent => agent.id === id);
}

/** The TOML body for the Codex managed block of the server `name`. */
export function codexBlockBody(entry: Record<string, unknown>, name: string = SERVER_NAME): string {
  const lines = [`[mcp_servers.${name}]`];
  const scalar = (value: unknown): string => {
    if (typeof value === 'string') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map(scalar).join(', ')}]`;
    }
    return String(value);
  };
  const nested: [string, Record<string, unknown>][] = [];
  for (const [key, value] of Object.entries(entry)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      nested.push([key, value as Record<string, unknown>]);
      continue;
    }
    lines.push(`${key} = ${scalar(value)}`);
  }
  for (const [key, table] of nested) {
    lines.push('', `[mcp_servers.${name}.${key}]`);
    for (const [name, value] of Object.entries(table)) {
      lines.push(`${name} = ${scalar(value)}`);
    }
  }
  return lines.join('\n');
}
