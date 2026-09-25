// What the AI Manager shows at a glance, worked out from the panel state.
// Kept apart from the React components so it is unit tested.

import type { AgentRow, JobRow, ServerState, ToolRow, ZephyrMcpState } from './state';

/** How a status reads: its icon and colour. */
export type Tone = 'ok' | 'warn' | 'off' | 'info' | 'error';

/** A button: its label and the message it posts to the panel. */
export interface RowAction {
  label: string;
  message: Record<string, unknown>;
  primary?: boolean;
  title?: string;
  disabled?: boolean;
}

export interface AgentSummary {
  tone: Tone;
  text: string;
  /** A codicon in place of the tone's own, such as a spinner. */
  icon?: string;
  /** More on the status, as a tooltip. */
  title?: string;
  /** The one button the collapsed row shows, if any. */
  action?: RowAction;
}

/** The codicon of something in progress. */
export const SPINNER = 'loading codicon-modifier-spin';

const SCOPE_TEXT: Record<AgentRow['scope'], string> = {
  user: 'for all projects',
  project: 'for this project',
  other: 'in the agent\'s own settings',
  account: 'through your account',
};

/** What each configuration state reads as on its own line. */
export const STATE_LABEL: Record<AgentRow['state'], string> = {
  configured: 'Connected',
  outdated: 'Needs updating',
  'not-configured': 'Not connected',
  foreign: 'Edited by hand',
  'no-file': 'No file needed',
};

export const STATE_TONE: Record<AgentRow['state'], Tone> = {
  configured: 'ok',
  outdated: 'warn',
  'not-configured': 'off',
  foreign: 'warn',
  'no-file': 'info',
};

const SCOPE_LABEL: Record<AgentRow['scope'], string> = {
  user: 'All projects',
  project: 'This project',
  other: 'Elsewhere',
  account: 'Your account',
};

export function scopeLabel(scope: AgentRow['scope']): string {
  return SCOPE_LABEL[scope];
}

/** Only these rows are files the panel writes; the others are only reported. */
const writable = (row: AgentRow) => row.scope === 'user' || row.scope === 'project';

/** Whether an entry works, as far as anyone can tell: found, and not reported as failing. */
const works = (row: AgentRow) =>
  row.state === 'configured' && !row.unverified && row.health !== 'needs-auth' && row.health !== 'failed';

/** One scope's line: its status in a word or two. */
export function rowStatus(row: AgentRow): { tone: Tone; text: string; icon?: string; title?: string } {
  if (row.checking && (row.state !== 'configured' || row.unverified)) {
    return { tone: 'info', text: 'Checking', icon: SPINNER };
  }
  if (row.state === 'configured') {
    if (row.unverified) {
      return { tone: 'info', text: 'Probably connected', title: 'A connector with this name was used here, but the agent could not confirm its address.' };
    }
    if (row.health === 'needs-auth') {
      return { tone: 'warn', text: 'Needs sign-in' };
    }
    if (row.health === 'failed') {
      return { tone: 'warn', text: 'Does not answer' };
    }
    if (row.alias && writable(row)) {
      return { tone: 'ok', text: `Connected as ${row.alias}` };
    }
  }
  if (row.check_error && row.state === 'not-configured') {
    return { tone: 'off', text: 'Could not check', title: row.check_error };
  }
  return { tone: STATE_TONE[row.state], text: STATE_LABEL[row.state] };
}

/** Which server a row's buttons act on: the workbench's own (no key) or the Zephyr Project's. */
export type ServerKey = 'zephyr' | undefined;

const connect = (row: AgentRow, label: string, server: ServerKey, primary = true): RowAction => ({
  label: row.via_link && label === 'Connect' ? 'Add to VS Code' : label,
  primary,
  title: row.via_link
    ? 'VS Code shows what it will add and asks you to confirm'
    : `${label} ${SCOPE_TEXT[row.scope]}`,
  message: { command: 'connect', agentId: row.id, scope: row.scope, ...(server ? { server } : {}) },
});

/** Said of an agent whose online account could not be checked, next to "Not set up on this machine". */
const FILES_ONLY = 'Only the configuration files on this machine were read. A server added to your account with the agent does not show here.';

/**
 * One agent in one line: its status across every scope, and the single action
 * that matters most. Anything that needs attention wins over a connection that
 * works, and the user scope, which serves every project, is the default target.
 */
export function summarizeAgent(rows: readonly AgentRow[], server?: ServerKey): AgentSummary {
  const outdated = rows.find(row => row.state === 'outdated');
  if (outdated) {
    return { tone: 'warn', text: `Needs updating ${SCOPE_TEXT[outdated.scope]}`, action: connect(outdated, 'Repair', server) };
  }
  const foreign = rows.find(row => row.state === 'foreign');
  if (foreign) {
    return {
      tone: 'warn',
      text: 'Edited by hand',
      ...(foreign.file ? { action: { label: 'Open file', message: { command: 'openFile', file: foreign.file } } } : {}),
    };
  }
  const working = rows.filter(works);
  if (working.length > 0) {
    return { tone: 'ok', text: working.length > 1 ? 'Connected' : `Connected ${SCOPE_TEXT[working[0].scope]}` };
  }
  const configured = rows.filter(row => row.state === 'configured');
  if (configured.some(row => row.health === 'needs-auth')) {
    return { tone: 'warn', text: 'Added, needs sign-in' };
  }
  if (configured.some(row => row.health === 'failed')) {
    return { tone: 'warn', text: 'Added, does not answer' };
  }
  const unverified = configured.find(row => row.unverified && !row.checking);
  if (unverified) {
    return { tone: 'info', text: `Probably connected ${SCOPE_TEXT[unverified.scope]}`, title: rowStatus(unverified).title };
  }
  if (rows.some(row => row.checking)) {
    return { tone: 'info', text: 'Checking your account', icon: SPINNER };
  }
  if (rows.some(row => row.state === 'no-file')) {
    return { tone: 'info', text: 'No setup needed' };
  }
  const target = rows.find(row => row.scope === 'user') ?? rows.find(writable);
  // A remote server can also be added to an agent account, which only an agent that was asked rules out.
  const accountChecked = rows.some(row => row.scope === 'account' && !row.check_error);
  const status = server === 'zephyr' && !accountChecked
    ? { tone: 'off' as const, text: 'Not set up on this machine', title: FILES_ONLY }
    : { tone: 'off' as const, text: 'Not connected' };
  return target ? { ...status, action: connect(target, 'Connect', server) } : status;
}

/**
 * How to sign in, while it may still be needed: once an entry on this machine
 * exists and the agent has not reported it as connected. Before that it is too
 * early, and a server of the agent's account signs in through the account.
 */
export function signInHint(rows: readonly AgentRow[]): string | undefined {
  const hint = rows.find(row => row.sign_in)?.sign_in;
  const pending = rows.some(row =>
    row.scope !== 'account' && row.state === 'configured' && !row.unverified && row.health !== 'connected');
  return pending ? hint : undefined;
}

/**
 * The action on one scope's line in the expanded row. `quiet` when the agent
 * already reaches the server, or is being asked whether it does, so another
 * Connect is on offer but not pressed on the user.
 */
export function scopeAction(row: AgentRow, server?: ServerKey, quiet = false): RowAction | undefined {
  if (row.scope === 'account') {
    return row.checking ? undefined : {
      label: 'Check again', title: 'Ask the agent again which servers it reaches', message: { command: 'checkAccount' },
    };
  }
  if (!writable(row)) {
    return undefined;
  }
  switch (row.state) {
    case 'no-file':
      return undefined;
    case 'configured':
      // What VS Code added through its own link, it also removes, from its MCP view.
      // An entry under another name was not written here, so it is not removed from here either.
      return row.via_link || row.alias ? undefined : {
        label: 'Remove', title: `Remove the entry ${SCOPE_TEXT[row.scope]}`,
        message: { command: 'disconnect', agentId: row.id, scope: row.scope, ...(server ? { server } : {}) },
      };
    case 'outdated':
      return connect(row, 'Repair', server);
    case 'foreign':
      // Connecting explains why it cannot write over a hand-edited entry.
      return connect(row, 'Connect', server, false);
    default:
      return connect(row, 'Connect', server, !quiet);
  }
}

/**
 * The agents, one entry per agent with its scope rows, split into the ones
 * worth showing (found on this machine, already set up in some way, needing no
 * setup at all, or added by VS Code itself, which this panel runs in) and the
 * rest, which are tucked away.
 */
export function groupAgents(agents: readonly AgentRow[]): { main: AgentRow[][]; other: AgentRow[][] } {
  const byId = new Map<string, AgentRow[]>();
  for (const agent of agents) {
    byId.set(agent.id, [...(byId.get(agent.id) ?? []), agent]);
  }
  const main: AgentRow[][] = [];
  const other: AgentRow[][] = [];
  for (const rows of byId.values()) {
    const relevant = rows.some(row => row.detected || row.via_link || row.state !== 'not-configured');
    (relevant ? main : other).push(rows);
  }
  return { main, other };
}

/**
 * A path as short as it stays clear: relative to the project for a project
 * file, from ~ for a file in the home folder, whole otherwise.
 */
export function displayPath(file: string, home?: string, workspaceFolder?: string): string {
  const windows = /^[A-Za-z]:\\/.test(file) || file.includes('\\');
  const fold = (value: string) => (windows ? value.toLowerCase() : value);
  const under = (root: string | undefined): string | undefined => {
    if (!root) {
      return undefined;
    }
    const trimmed = root.replace(/[\\/]+$/, '');
    const prefix = fold(`${trimmed}${windows ? '\\' : '/'}`);
    return fold(file).startsWith(prefix) ? file.slice(prefix.length) : undefined;
  };
  const inProject = under(workspaceFolder);
  if (inProject) {
    return inProject;
  }
  const inHome = under(home);
  if (inHome) {
    return `~${windows ? '\\' : '/'}${inHome}`;
  }
  return file;
}

/** The server in a few words, for the header. */
export function serverSummary(server: ServerState): { tone: Tone; text: string } {
  if (!server.supported) {
    return { tone: 'error', text: 'Not available in this version of VS Code' };
  }
  if (server.running) {
    return { tone: 'ok', text: 'Server running' };
  }
  if (server.enabled === 'off') {
    return { tone: 'off', text: 'Server turned off in the settings' };
  }
  if (server.stopped_by_user) {
    return { tone: 'off', text: 'Server stopped' };
  }
  // The default: no socket is open until an agent asks for the server.
  return { tone: 'off', text: 'Server idle, starts when an agent connects' };
}

export function toolsSummary(server: ServerState): string {
  return `${server.tool_count} ${server.tool_count === 1 ? 'tool' : 'tools'}, ${server.toolset} toolset`;
}

/** The toolset presets, described as the setting describes them. */
export const TOOLSETS: [string, string][] = [
  ['read-only', 'Only tools that cannot change anything.'],
  ['core', 'The tools needed for the everyday build and inspect loop.'],
  ['full', 'Every tool the server provides.'],
];

/** The confirmation categories, in the order the setting lists them. */
export const CONFIRM_LABELS: [string, string][] = [
  ['hardware', 'Flash or debug a connected board'],
  ['delete', 'Remove or delete build folders, configurations, applications, workspaces or toolchains'],
  ['workspace', 'Create, import or update applications and west workspaces'],
  ['install', 'Install SDKs, toolchains, Python environments or blobs'],
  ['settings', 'Change build configurations, Kconfig options or application, workspace and toolchain settings'],
];

export interface ConfirmRow {
  category: string;
  label: string;
  /** The enabled tools that ask before this kind of action. */
  tools: string[];
}

/**
 * The confirmation categories with the enabled tools each one covers. One that
 * no enabled tool uses comes last, since ticking it changes nothing yet.
 */
export function confirmRows(tools: readonly ToolRow[]): ConfirmRow[] {
  const enabled = tools.filter(tool => !tool.disabled);
  const rows = CONFIRM_LABELS.map(([category, label]) => ({
    category, label, tools: enabled.filter(tool => tool.asks.includes(category)).map(tool => tool.name),
  }));
  return [...rows.filter(row => row.tools.length > 0), ...rows.filter(row => row.tools.length === 0)];
}

/** Headings for the tool categories of the catalog. */
export const TOOL_GROUP_LABEL: Record<string, string> = {
  query: 'Status and search',
  artifact: 'Build results',
  config: 'Settings',
  action: 'Actions',
  editor: 'Editor',
  job: 'Jobs',
};

export function toolKind(tool: ToolRow): string {
  return tool.read_only ? 'read only' : tool.destructive ? 'deletes' : 'writes';
}

const JOB_KIND: Record<string, string> = {
  build: 'Build',
  task: 'Task',
  west: 'West',
  install: 'Install',
  clean: 'Delete',
  flash: 'Flash',
  run: 'Run',
};

export const JOB_TONE: Record<string, Tone> = {
  succeeded: 'ok',
  failed: 'error',
  cancelled: 'off',
  running: 'info',
  queued: 'info',
};

/**
 * A job in a few words: what ran, on which application and configuration. A
 * job with no application, such as an install, says what it did in its own
 * words, unless that is a shell command line.
 */
export function jobTitle(job: JobRow): string {
  const kind = JOB_KIND[job.kind] ?? job.kind;
  const app = job.app_path?.split(/[\\/]/).filter(Boolean).pop();
  const target = app && job.config_name ? `${app} (${job.config_name})` : app ?? job.config_name;
  if (target) {
    return `${kind} ${target}`;
  }
  const command = job.command?.trim();
  if (command && command.length <= 120 && !/[;&|]|^\.\s/.test(command)) {
    return command.charAt(0).toUpperCase() + command.slice(1);
  }
  return kind;
}

/** A local time of day, such as 14:32. */
export function formatTime(iso?: string): string {
  if (!iso) {
    return '';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The configuration the Zephyr documentation gives for any other MCP client:
 * the address directly, or through the mcp-remote bridge for a client that
 * only starts local servers.
 */
export function zephyrClientConfig(zephyr: Pick<ZephyrMcpState, 'name' | 'url'>, form: 'url' | 'mcp-remote'): string {
  const entry = form === 'url'
    ? { url: zephyr.url }
    : { command: 'npx', args: ['-y', 'mcp-remote', zephyr.url] };
  return JSON.stringify({ mcpServers: { [zephyr.name]: entry } }, null, 2);
}
