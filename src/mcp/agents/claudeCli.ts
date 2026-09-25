// Claude Code's user-scope configuration lives in ~/.claude.json, a file Claude
// Code rewrites constantly while it runs. Editing it directly races with those
// writes, so user scope goes through Claude's own CLI instead.
//
// The CLI may not be on PATH: installing only the Claude Code VS Code extension
// ships a private copy. Phase 0 confirmed that bundled copy accepts
// `mcp add-json -s user`, so it is a valid fallback.
//
// An npm install is the awkward case. On Windows it is a `claude.cmd` shim,
// which Node refuses to run without a shell, and on any OS its entry point is
// a JavaScript file that needs a `node` the editor may not see on PATH. Both
// are run through the editor's own runtime instead, the same way the bridge is.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** How to run the Claude CLI. */
export interface ClaudeCli {
  command: string;
  /** Arguments placed before Claude's own, such as the path of cli.js. */
  prefix: string[];
  env?: Record<string, string>;
  /** What the preview shows the user. */
  display: string;
}

const NPM_PACKAGE = ['@anthropic-ai', 'claude-code'];

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Look a program up on PATH without spawning a shell. */
function onPath(names: string[]): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

const isScript = (file: string) => /\.[cm]?js$/i.test(file);

/** Run a JavaScript entry point on the editor's runtime. */
function scriptCli(script: string, display: string): ClaudeCli {
  return { command: process.execPath, prefix: [script], env: { ELECTRON_RUN_AS_NODE: '1' }, display };
}

/**
 * The real program behind an npm shim: `<prefix>/claude.cmd` sits next to
 * `<prefix>/node_modules/@anthropic-ai/claude-code`, whose package.json names
 * the entry point. Undefined when that layout is not there.
 */
export function resolveNpmShim(shim: string): ClaudeCli | undefined {
  const packageDir = path.join(path.dirname(shim), 'node_modules', ...NPM_PACKAGE);
  let bin: unknown;
  try {
    bin = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).bin;
  } catch {
    return undefined;
  }
  const relative = typeof bin === 'string' ? bin : (bin as Record<string, unknown> | undefined)?.claude;
  if (typeof relative !== 'string') {
    return undefined;
  }
  const target = path.join(packageDir, relative);
  if (!isFile(target)) {
    return undefined;
  }
  if (isScript(target)) {
    return scriptCli(target, shim);
  }
  return /\.exe$/i.test(target) || process.platform !== 'win32'
    ? { command: target, prefix: [], display: shim }
    : undefined;
}

/** Turn a found file into something execFile can run without a shell. */
function toCli(candidate: string): ClaudeCli | undefined {
  if (/\.(cmd|bat)$/i.test(candidate)) {
    return resolveNpmShim(candidate);
  }
  let real = candidate;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    // Use the path as found.
  }
  // An npm install on macOS or Linux is a symlink to cli.js with a
  // `#!/usr/bin/env node` line, and a GUI-started editor may have no node on PATH.
  return isScript(real) ? scriptCli(real, candidate) : { command: candidate, prefix: [], display: candidate };
}

/** Where Claude Code keeps its own files: `CLAUDE_CONFIG_DIR`, else ~/.claude. */
export function claudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? configured : path.join(os.homedir(), '.claude');
}

/**
 * Find a usable Claude CLI: PATH first, then the standard install locations,
 * then the private copy inside the Claude Code VS Code extension.
 */
export function findClaudeCli(claudeExtensionPath?: string): ClaudeCli | undefined {
  const windows = process.platform === 'win32';
  const exe = windows ? 'claude.exe' : 'claude';
  const fromPath = onPath(windows ? ['claude.exe', 'claude.cmd'] : ['claude']);
  const found = fromPath ? toCli(fromPath) : undefined;
  if (found) {
    return found;
  }
  const known = [
    path.join(os.homedir(), '.local', 'bin', exe),
    path.join(claudeConfigDir(), 'local', exe),
  ];
  if (claudeExtensionPath) {
    known.push(path.join(claudeExtensionPath, 'resources', 'native-binary', exe));
  }
  for (const candidate of known) {
    const cli = isFile(candidate) ? toCli(candidate) : undefined;
    if (cli) {
      return cli;
    }
  }
  return undefined;
}

interface CliResult {
  ok: boolean;
  output: string;
  /** For a removal: the server was not there, which is not a failure. */
  notFound?: boolean;
}

function run(cli: ClaudeCli, args: string[], timeoutMs = 30_000): Promise<CliResult> {
  return new Promise(resolve => {
    execFile(cli.command, [...cli.prefix, ...args], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...(cli.env ?? {}) },
    }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout ?? ''}${stderr ?? ''}`.trim() });
    });
  });
}

/**
 * Register the server at user scope. `add-json` refuses a name that already
 * exists, so any previous entry is removed first; that failing just means there
 * was nothing to remove.
 */
const isNotFound = (output: string) => /not found|no (user[- ]scoped )?mcp server/i.test(output);

export async function claudeAddUser(cli: ClaudeCli, name: string, entry: unknown, previous?: unknown): Promise<CliResult> {
  const removed = await run(cli, ['mcp', 'remove', '-s', 'user', name]);
  if (!removed.ok && !isNotFound(removed.output)) {
    // Nothing changed yet: say so, and do not try to add over the old entry.
    return { ok: false, output: `${removed.output || 'The Claude CLI did not answer.'} The existing entry was left unchanged.` };
  }
  const added = await run(cli, ['mcp', 'add-json', '-s', 'user', name, JSON.stringify(entry)]);
  if (!added.ok && previous !== undefined) {
    // Never leave the user with less than they had.
    const restored = await run(cli, ['mcp', 'add-json', '-s', 'user', name, JSON.stringify(previous)]);
    return {
      ok: false,
      output: `${added.output}${restored.ok ? ' The previous entry was put back.' : ' The previous entry could not be put back.'}`,
    };
  }
  return added;
}

export async function claudeRemoveUser(cli: ClaudeCli, name: string): Promise<CliResult> {
  const result = await run(cli, ['mcp', 'remove', '-s', 'user', name]);
  return result.ok ? result : { ...result, notFound: isNotFound(result.output) };
}

/** One server as `claude mcp list` reports it. */
export interface ClaudeServerStatus {
  name: string;
  /** The address of a remote server, or the command line of a local one. */
  target: string;
  /** Comes from the user's claude.ai account (a connector), not from a file on this machine. */
  account: boolean;
  health: 'connected' | 'needs-auth' | 'failed' | 'unknown';
}

/**
 * Read the output of `claude mcp list`: one `<name>: <target> - <status>` line
 * per server. Servers from the claude.ai account are named `claude.ai <name>`.
 */
export function parseClaudeMcpList(output: string): ClaudeServerStatus[] {
  const servers: ClaudeServerStatus[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const colon = line.indexOf(': ');
    const dash = line.lastIndexOf(' - ');
    if (colon <= 0 || dash <= colon) {
      continue;
    }
    const name = line.slice(0, colon);
    const status = line.slice(dash + 3);
    servers.push({
      name,
      target: line.slice(colon + 2, dash).trim(),
      account: name.startsWith('claude.ai '),
      health: /needs auth|authenticat/i.test(status) ? 'needs-auth'
        : /fail|error|not connected/i.test(status) ? 'failed'
          : /connected/i.test(status) ? 'connected'
            : 'unknown',
    });
  }
  return servers;
}

/**
 * Every MCP server Claude Code would use from `cwd`, including the connectors
 * of the claude.ai account, which no file on this machine lists. Claude checks
 * each server while it lists them, starting the local ones, so this takes a
 * few seconds: call it sparingly.
 */
export async function listClaudeServers(cli: ClaudeCli, cwd?: string, timeoutMs = 30_000): Promise<ClaudeServerStatus[]> {
  const result = await new Promise<CliResult>(resolve => {
    execFile(cli.command, [...cli.prefix, 'mcp', 'list'], {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...(cli.env ?? {}) },
    }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout ?? ''}${stderr ?? ''}`.trim() });
    });
  });
  if (!result.ok) {
    throw new Error(result.output || 'claude mcp list did not answer.');
  }
  return parseClaudeMcpList(result.output);
}

/**
 * The claude.ai connectors Claude Code has connected on this machine, by name,
 * as it records them. Only a hint: a name says nothing about the address.
 */
export function claudeAccountConnectorNames(file: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { claudeAiMcpEverConnected?: unknown };
    const names = parsed.claudeAiMcpEverConnected;
    return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : [];
  } catch {
    return [];
  }
}
