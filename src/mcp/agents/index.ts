// Reads, writes and removes an MCP server entry in each agent's config: the
// Zephyr Workbench server itself, or a remote server such as the Zephyr
// Project's.
//
// Rules that apply to every agent: preview before write, merge rather than
// overwrite, refuse a file that cannot be understood, keep a backup when
// replacing, be idempotent, and never follow a link planted in a project.

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SERVER_NAME } from '../core/catalog';
import { FILE_MODE, getMcpPaths } from '../core/paths';
import { AgentDescriptor, AgentId, AgentScope, AGENTS, codexBlockBody, findAgent } from './descriptors';
import { ConfigParseError, parseJsonc, readJsonPath, removeJsonPath, setJsonPath } from './jsonMerge';
import { claudeAddUser, ClaudeCli, claudeRemoveUser, findClaudeCli } from './claudeCli';
import { LauncherSpec } from './launcher';
import { inspectServer, parseToml, removeServer, upsertServer } from './tomlBlock';

export type WiringState = 'configured' | 'outdated' | 'not-configured' | 'foreign' | 'no-file';

export interface AgentStatus {
  id: AgentId;
  label: string;
  detected: boolean;
  scope: AgentScope;
  file?: string;
  state: WiringState;
  /** The name of an entry that reaches the server under another name, set up by hand. */
  alias?: string;
  note?: string;
  /** What is currently in the file, for the panel to show. */
  current?: unknown;
}

export interface WritePlan {
  id: AgentId;
  label: string;
  scope: AgentScope;
  /** The key of the entry. Absent in plans made before a second server existed: the workbench's. */
  server?: string;
  /** `file` edits the file below; `cli` runs `commands` instead. */
  method: 'file' | 'cli';
  /** Argument vectors to run, for a `cli` plan. Shown in the preview. */
  commands?: { cli: string; args: string[] }[];
  /** How to run the Claude CLI, for a `cli` plan. */
  claude?: ClaudeCli;
  file: string;
  /** The file content after the change, for the preview. */
  next: string;
  previous: string;
  created: boolean;
  /** No change needed, or none possible (see `warning`). */
  unchanged: boolean;
  warning?: string;
  /** Something to tell the user in the preview that does not block the write. */
  notice?: string;
  /** Where the previous file is copied before it changes. */
  backupDir: string;
}

export interface PlanOptions {
  /** Where the Claude Code extension is installed, to find its bundled CLI. */
  claudeExtensionPath?: string;
  /** Where backups go. Defaults to `backups` in the MCP home. */
  backupDir?: string;
}

/** A project file that must not be written, because following it would leave the project. */
export class UnsafeTargetError extends Error {
  constructor(readonly file: string, detail: string) {
    super(`${file} was not changed: ${detail}`);
    this.name = 'UnsafeTargetError';
  }
}

function readFileOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function sameEntry(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function detectAgent(agent: AgentDescriptor): boolean {
  return agent.detect().some(candidate => fs.existsSync(candidate));
}

/**
 * A cloned repository is untrusted input. A `.mcp.json` or `.cursor` that is
 * a symbolic link could point anywhere, such as a shell profile, and writing
 * through it would edit that file instead. Every existing path segment below
 * the workspace folder must be a real file or directory.
 */
export function assertSafeProjectTarget(file: string, workspaceFolder: string): void {
  const relative = path.relative(workspaceFolder, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new UnsafeTargetError(file, 'it is outside the workspace folder.');
  }
  let current = workspaceFolder;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return; // Nothing exists from here on, so nothing can be a link.
    }
    if (stat.isSymbolicLink()) {
      throw new UnsafeTargetError(file, `${current} is a symbolic link. Replace it with a real file or folder first.`);
    }
  }
}

/**
 * The file to actually write. A user file may be a link on purpose (dotfile
 * managers do that), so it is resolved and the real file is edited, which
 * keeps the link intact. A project file must not be a link at all.
 */
function writeTarget(file: string, scope: AgentScope, workspaceFolder?: string): string {
  if (scope === 'project' && workspaceFolder) {
    assertSafeProjectTarget(file, workspaceFolder);
    return file;
  }
  try {
    return fs.realpathSync(file);
  } catch {
    // A link whose final target does not exist yet is still a link to keep:
    // follow the whole chain, resolving each hop the way the system does
    // (against the link's real folder), and write at the end of it.
    let current = file;
    for (let hop = 0; hop < 40; hop++) {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(current);
      } catch {
        return current;
      }
      if (!stat.isSymbolicLink()) {
        return current;
      }
      let folder = path.dirname(current);
      try {
        folder = fs.realpathSync(folder);
      } catch {
        // Keep the folder as written.
      }
      current = path.resolve(folder, fs.readlinkSync(current));
    }
    return file;
  }
}

/** Refuse a JSON file whose shape a merge would damage. */
function assertEditableJson(text: string, file: string, containerPath: string[]): void {
  const parsed = parseJsonc<unknown>(text, file);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigParseError(file, 'the top level is not an object');
  }
  let current: unknown = parsed;
  for (const key of containerPath) {
    const next = (current as Record<string, unknown>)[key];
    if (next === undefined) {
      return;
    }
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      throw new ConfigParseError(file, `"${containerPath.join('.')}" is not an object`);
    }
    current = next;
  }
}

/**
 * The launcher as a project file should name it. A project file is usually
 * committed and shared, and the launcher lives in each developer's home
 * folder, so on macOS and Linux the path is written through the agent's own
 * home variable. On Windows the launcher is the editor itself, whose path is
 * per install, so the file stays personal there.
 */
export function projectLauncher(
  agent: AgentDescriptor, launcher: LauncherSpec, platform: NodeJS.Platform = process.platform, home = os.homedir(),
): { launcher: LauncherSpec; portable: boolean } {
  if (platform === 'win32' || !agent.homeVariable || launcher.args.length > 0 || Object.keys(launcher.env).length > 0) {
    return { launcher, portable: false };
  }
  const relative = path.relative(home, launcher.command);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { launcher, portable: false };
  }
  return {
    launcher: { ...launcher, command: `${agent.homeVariable}/${relative.split(path.sep).join('/')}` },
    portable: true,
  };
}

const effectiveLauncher = (agent: AgentDescriptor, scope: AgentScope, launcher: LauncherSpec) =>
  (scope === 'project' ? projectLauncher(agent, launcher) : { launcher, portable: false });

/** Which server an entry is for: its key in every config, and its entry for each agent. */
export interface ServerTarget {
  name: string;
  /**
   * The entry this agent should hold in this scope, with a word for the
   * preview. Undefined when the agent cannot take this server there.
   */
  entry(agent: AgentDescriptor, scope: AgentScope): { entry: unknown; notice?: string } | undefined;
  /** Whether an entry under any name reaches this server, such as one added by hand. */
  matches?(entry: unknown): boolean;
}

/** An address compared the way a server sees it: scheme and host in any case, no trailing slash. */
function normalizedUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Whether `value` reaches the server at `url`: an entry whose address is it
 * (`url`, `httpUrl`, `serverUrl`), a local bridge such as mcp-remote whose
 * command line carries it, or a plain string that names it.
 */
export function reachesUrl(value: unknown, url: string): boolean {
  const wanted = normalizedUrl(url);
  if (!wanted) {
    return false;
  }
  const strings: string[] = [];
  const collect = (item: unknown) => {
    if (typeof item === 'string') {
      strings.push(item);
    } else if (Array.isArray(item)) {
      item.forEach(collect);
    }
  };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entry = value as Record<string, unknown>;
    for (const key of ['url', 'httpUrl', 'serverUrl', 'command', 'args']) {
      collect(entry[key]);
    }
  } else {
    collect(value);
  }
  return strings.some(text => (text.match(/https?:\/\/[^\s"',]+/g) ?? []).some(found => normalizedUrl(found) === wanted));
}

/** The Zephyr Workbench server, started through the launcher. */
export function workbenchTarget(launcher: LauncherSpec): ServerTarget {
  return {
    name: SERVER_NAME,
    entry: (agent, scope) => {
      const effective = effectiveLauncher(agent, scope, launcher);
      // Say plainly who a project entry works for, since it is usually committed.
      const notice = scope !== 'project'
        ? undefined
        : effective.portable
          ? 'The entry finds the launcher through each user\'s home folder, so it works for everyone on macOS and Linux who has Zephyr Workbench. Windows users should connect for their user account.'
          : 'This entry holds a path in your home folder, so it works for you only. Keep the file out of version control, or connect for your user account instead.';
      return { entry: agent.entry(effective.launcher), ...(notice ? { notice } : {}) };
    },
  };
}

/** A server reached over the network, such as the Zephyr Project's. The same entry suits every user. */
export function remoteTarget(name: string, url: string): ServerTarget {
  return {
    name,
    entry: (agent, scope) => (agent.remoteEntry ? { entry: agent.remoteEntry(url, scope) } : undefined),
    matches: entry => reachesUrl(entry, url),
  };
}

/** The name of another entry in `servers` that reaches the target, if one does. */
function aliasIn(servers: unknown, target: ServerTarget): string | undefined {
  if (!target.matches || !servers || typeof servers !== 'object' || Array.isArray(servers)) {
    return undefined;
  }
  return Object.entries(servers as Record<string, unknown>)
    .find(([name, entry]) => name !== target.name && target.matches?.(entry))?.[0];
}

/** What the panel shows per agent for the workbench server, without changing anything. */
export function inspectAgent(
  agent: AgentDescriptor, scope: AgentScope, launcher: LauncherSpec, workspaceFolder?: string,
): AgentStatus {
  return inspectEntry(agent, scope, workbenchTarget(launcher), workspaceFolder);
}

/** What the panel shows per agent for any server, without changing anything. */
export function inspectEntry(
  agent: AgentDescriptor, scope: AgentScope, target: ServerTarget, workspaceFolder?: string,
): AgentStatus {
  const file = agent.file(scope, workspaceFolder);
  const wanted = target.entry(agent, scope);
  const base: AgentStatus = {
    id: agent.id,
    label: agent.label,
    detected: detectAgent(agent),
    scope,
    file,
    state: 'not-configured',
    note: agent.note,
  };
  if (!file || !wanted) {
    return { ...base, state: 'no-file' };
  }
  const text = readFileOrEmpty(file);
  if (text.length === 0) {
    return base;
  }
  if (agent.format === 'toml') {
    const body = codexBlockBody(wanted.entry as Record<string, unknown>, target.name);
    const result = inspectServer(text, target.name, body, file);
    if (result.state === 'not-configured') {
      let alias: string | undefined;
      try {
        alias = aliasIn(parseToml(text, file).mcp_servers, target);
      } catch {
        alias = undefined;
      }
      return alias ? { ...base, state: 'configured', alias } : base;
    }
    return { ...base, state: result.state, ...(result.note ? { note: result.note } : {}) };
  }
  try {
    const parsed = parseJsonc(text, file);
    const current = readJsonPath(parsed, [...(agent.containerPath ?? []), target.name]);
    if (current === undefined) {
      // Set up by hand under another name, it still reaches the server.
      const alias = aliasIn(readJsonPath(parsed, agent.containerPath ?? []), target);
      return alias ? { ...base, state: 'configured', alias } : base;
    }
    return {
      ...base,
      current,
      state: sameEntry(current, wanted.entry) ? 'configured' : 'outdated',
    };
  } catch (error) {
    return { ...base, state: 'foreign', note: messageOf(error) };
  }
}

/** Build the change for the workbench server without applying it, so the panel can preview a diff. */
export async function planWrite(
  agent: AgentDescriptor, scope: AgentScope, launcher: LauncherSpec, workspaceFolder?: string,
  options: PlanOptions = {},
): Promise<WritePlan> {
  return planEntryWrite(agent, scope, workbenchTarget(launcher), workspaceFolder, options);
}

/** Build the change for any server without applying it, so the panel can preview a diff. */
export async function planEntryWrite(
  agent: AgentDescriptor, scope: AgentScope, target: ServerTarget, workspaceFolder?: string,
  options: PlanOptions = {},
): Promise<WritePlan> {
  const file = agent.file(scope, workspaceFolder);
  const wanted = target.entry(agent, scope);
  if (!file || !wanted) {
    throw new Error(`${agent.label} has no configuration file for ${scope} scope.`);
  }
  const backupDir = options.backupDir ?? getMcpPaths().backupsDir;
  const previous = readFileOrEmpty(file);
  const common = { id: agent.id, label: agent.label, scope, server: target.name, file, previous, backupDir };
  const refuse = (warning: string): WritePlan =>
    ({ ...common, method: 'file', next: previous, created: false, unchanged: true, warning });

  if (agent.id === 'claude-code' && scope === 'user') {
    // ~/.claude.json is rewritten constantly by Claude Code itself, so a direct
    // edit could be lost. Its own CLI is the safe writer.
    const claude = findClaudeCli(options.claudeExtensionPath);
    if (!claude) {
      return {
        ...refuse('The Claude CLI was not found, so the user configuration cannot be written safely. '
          + 'Install Claude Code, or connect Claude Code for this project instead.'),
        method: 'cli',
      };
    }
    const status = inspectEntry(agent, scope, target, workspaceFolder);
    return {
      ...common, method: 'cli', next: previous, created: false,
      unchanged: status.state === 'configured',
      claude,
      commands: [
        { cli: claude.display, args: ['mcp', 'remove', '-s', 'user', target.name] },
        { cli: claude.display, args: ['mcp', 'add-json', '-s', 'user', target.name, JSON.stringify(wanted.entry)] },
      ],
    };
  }

  try {
    writeTarget(file, scope, workspaceFolder);
  } catch (error) {
    return refuse(messageOf(error));
  }

  const created = previous.length === 0;
  const entry = wanted.entry as Record<string, unknown>;
  const notice = wanted.notice;

  if (agent.format === 'toml') {
    try {
      const next = upsertServer(previous, target.name, codexBlockBody(entry, target.name), file);
      return { ...common, method: 'file', next, created, unchanged: next === previous, notice };
    } catch (error) {
      return refuse(messageOf(error));
    }
  }

  const containerPath = agent.containerPath ?? [];
  try {
    assertEditableJson(previous, file, containerPath);
  } catch (error) {
    return refuse(`${messageOf(error)}. Fix the file by hand, then try again.`);
  }
  const next = setJsonPath(previous.length === 0 ? '{}\n' : previous, [...containerPath, target.name], entry);
  // The merge edits text, so confirm it produced exactly the entry intended.
  if (!sameEntry(readJsonPath(parseJsonc(next, file), [...containerPath, target.name]), entry)) {
    return refuse(`The merged ${path.basename(file)} did not contain the expected entry, so it was not written.`);
  }
  return { ...common, method: 'file', next, created, unchanged: next === previous, notice };
}

/** Apply either kind of plan. */
export async function applyPlan(plan: WritePlan, workspaceFolder?: string): Promise<{ backup?: string; output?: string }> {
  if (plan.method === 'cli') {
    if (plan.unchanged || !plan.claude || !plan.commands) {
      return {};
    }
    const add = plan.commands[plan.commands.length - 1];
    const name = plan.server ?? SERVER_NAME;
    // Read what is there now, so a failed add can put it back.
    let previousEntry: unknown;
    try {
      previousEntry = readJsonPath(parseJsonc(readFileOrEmpty(plan.file), plan.file), ['mcpServers', name]);
    } catch {
      previousEntry = undefined;
    }
    const result = await claudeAddUser(plan.claude, name, JSON.parse(add.args[add.args.length - 1]), previousEntry);
    if (!result.ok) {
      throw new Error(`The Claude CLI could not add the server: ${result.output || 'no output'}`);
    }
    return { output: result.output };
  }
  return applyWrite(plan, workspaceFolder);
}

function backupName(plan: { id: string; scope: AgentScope; file: string }): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${plan.id}-${plan.scope}-${path.basename(plan.file)}-${stamp}.bak`;
}

/**
 * Replace a file in one step: a reader never sees half a file, and a rename
 * replaces a link rather than writing through it. The file keeps its mode.
 */
function writeAtomically(target: string, content: string): void {
  let mode = FILE_MODE;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    // New file.
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // A random name created exclusively: a predictable one could be planted in
  // a project as a link, and writing through it would land outside.
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.zw-${randomBytes(8).toString('hex')}.tmp`);
  fs.writeFileSync(temporary, content, { mode, flag: 'wx' });
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Backups go to the MCP home, never beside the file: a copy next to a project
 * file would end up in the repository.
 */
function keepBackup(plan: { id: string; scope: AgentScope; file: string; backupDir: string }, previous: string): string {
  fs.mkdirSync(plan.backupDir, { recursive: true, mode: 0o700 });
  const backup = path.join(plan.backupDir, backupName(plan));
  fs.writeFileSync(backup, previous, { mode: FILE_MODE });
  return backup;
}

/** Apply a file plan, keeping a backup whenever an existing file changes. */
export function applyWrite(plan: WritePlan, workspaceFolder?: string): { backup?: string } {
  if (plan.unchanged) {
    return {};
  }
  // Checked again: the file may have been replaced since the preview.
  const target = writeTarget(plan.file, plan.scope, workspaceFolder ?? projectRootOf(plan));
  if (readFileOrEmpty(target) !== plan.previous) {
    throw new Error(`${plan.file} changed since the preview. Open the AI Manager again to review the new content.`);
  }
  const backup = plan.previous.length > 0 ? keepBackup(plan, plan.previous) : undefined;
  writeAtomically(target, plan.next);
  return { ...(backup ? { backup } : {}) };
}

/**
 * The project folder a project-scope file belongs to, from the descriptor's
 * own layout, so a plan applied later is checked against the same root.
 */
function projectRootOf(plan: WritePlan): string | undefined {
  if (plan.scope !== 'project') {
    return undefined;
  }
  const agent = findAgent(plan.id);
  let folder = path.dirname(plan.file);
  for (let depth = 0; depth < 3 && agent; depth++) {
    if (agent.file('project', folder) === plan.file) {
      return folder;
    }
    folder = path.dirname(folder);
  }
  return undefined;
}

/** Remove exactly the workbench entry, and nothing else. */
export async function removeEntry(
  agent: AgentDescriptor, scope: AgentScope, workspaceFolder?: string, options: PlanOptions = {},
): Promise<{ file?: string; changed: boolean; backup?: string }> {
  return removeServerEntry(agent, scope, SERVER_NAME, workspaceFolder, options);
}

/** Remove exactly the entry named `name`, and nothing else. */
export async function removeServerEntry(
  agent: AgentDescriptor, scope: AgentScope, name: string, workspaceFolder?: string, options: PlanOptions = {},
): Promise<{ file?: string; changed: boolean; backup?: string }> {
  const file = agent.file(scope, workspaceFolder);
  if (agent.id === 'claude-code' && scope === 'user') {
    const claude = findClaudeCli(options.claudeExtensionPath);
    if (!claude) {
      throw new Error('The Claude CLI was not found, so the user configuration cannot be changed safely.');
    }
    const result = await claudeRemoveUser(claude, name);
    if (!result.ok && !result.notFound) {
      throw new Error(`The Claude CLI could not remove the server: ${result.output || 'no output'}`);
    }
    return { file, changed: result.ok };
  }
  if (!file || !fs.existsSync(file)) {
    return { file, changed: false };
  }
  const target = writeTarget(file, scope, workspaceFolder);
  const previous = readFileOrEmpty(target);
  let next: string;
  if (agent.format === 'toml') {
    next = removeServer(previous, name, file);
  } else {
    const containerPath = agent.containerPath ?? [];
    assertEditableJson(previous, file, containerPath);
    next = removeJsonPath(previous, [...containerPath, name]);
  }
  if (next === previous) {
    return { file, changed: false };
  }
  const backup = keepBackup({
    id: agent.id, scope, file, backupDir: options.backupDir ?? getMcpPaths().backupsDir,
  }, previous);
  writeAtomically(target, next);
  return { file, changed: true, backup };
}

/**
 * A snippet to paste into an agent's config by hand: the exact entry the
 * writer would merge, nested under the agent's own key. Without an agent, the
 * generic `mcpServers` shape most other clients accept.
 */
export function configSnippet(agent: AgentDescriptor | undefined, launcher: LauncherSpec): string {
  if (!agent) {
    const entry = {
      command: launcher.command,
      args: launcher.args,
      ...(Object.keys(launcher.env).length ? { env: launcher.env } : {}),
    };
    return `${JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2)}\n`;
  }
  const entry = agent.entry(launcher);
  if (agent.format === 'toml') {
    return `${codexBlockBody(entry as Record<string, unknown>)}\n`;
  }
  let value: unknown = { [SERVER_NAME]: entry };
  for (const key of [...(agent.containerPath ?? [])].reverse()) {
    value = { [key]: value };
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** A snippet of any server's entry for one agent, nested under the agent's own key, to paste by hand. */
export function entrySnippet(agent: AgentDescriptor, target: ServerTarget, scope: AgentScope = 'user'): string | undefined {
  const wanted = target.entry(agent, scope);
  if (!wanted) {
    return undefined;
  }
  if (agent.format === 'toml') {
    return `${codexBlockBody(wanted.entry as Record<string, unknown>, target.name)}\n`;
  }
  let value: unknown = { [target.name]: wanted.entry };
  for (const key of [...(agent.containerPath ?? [])].reverse()) {
    value = { [key]: value };
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

export { AGENTS, findAgent };
export type { AgentDescriptor, AgentId, AgentScope };
