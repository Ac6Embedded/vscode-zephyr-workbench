import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeAddUser, ClaudeCli, claudeRemoveUser, findClaudeCli, resolveNpmShim } from '../../../mcp/agents/claudeCli';
import { findAgent, planWrite } from '../../../mcp/agents';

const direct = (cli: string): ClaudeCli => ({ command: cli, prefix: [], display: cli });

/** A stand-in `claude` that records every invocation and fails add-json on demand. */
function fakeClaude(dir: string, failAdd = false): { cli: string; log: string } {
  const log = path.join(dir, 'calls.log');
  const cli = path.join(dir, 'claude');
  fs.writeFileSync(cli, [
    '#!/bin/sh',
    `echo "$@" >> "${log}"`,
    failAdd ? 'case "$2" in add-json) echo "MCP server zephyr-workbench already exists" >&2; exit 1;; esac' : '',
    'exit 0',
  ].join('\n'), { mode: 0o755 });
  return { cli, log };
}

describe('mcp/agents/claudeCli', function () {
  before(function () {
    if (process.platform === 'win32') {
      this.skip();
    }
  });

  it('finds the CLI on PATH first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-claude-'));
    fakeClaude(dir);
    const saved = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${saved}`;
    try {
      assert.equal(findClaudeCli()?.command, path.join(dir, 'claude'));
    } finally {
      process.env.PATH = saved;
    }
  });

  it('falls back to the copy bundled inside the Claude Code extension', () => {
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-claude-ext-'));
    const bundled = path.join(ext, 'resources', 'native-binary');
    fs.mkdirSync(bundled, { recursive: true });
    fakeClaude(bundled);
    const saved = process.env.PATH;
    const savedHome = process.env.HOME;
    process.env.PATH = '/nonexistent';
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-nohome-'));
    try {
      assert.equal(findClaudeCli(ext)?.command, path.join(bundled, 'claude'));
    } finally {
      process.env.PATH = saved;
      process.env.HOME = savedHome;
    }
  });

  it('removes any previous entry before adding, because add-json is not idempotent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-claude-'));
    const { cli, log } = fakeClaude(dir);
    const result = await claudeAddUser(direct(cli), 'zephyr-workbench', { type: 'stdio', command: '/x', args: [] });
    assert.equal(result.ok, true);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.match(calls[0], /^mcp remove -s user zephyr-workbench$/);
    assert.match(calls[1], /^mcp add-json -s user zephyr-workbench \{"type":"stdio"/);
  });

  it('reports a CLI failure instead of claiming success', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-claude-'));
    const { cli } = fakeClaude(dir, true);
    const result = await claudeAddUser(direct(cli), 'zephyr-workbench', {});
    assert.equal(result.ok, false);
    assert.match(result.output, /already exists/);
  });

  it('plans Claude Code user scope as a CLI run, never a direct edit of ~/.claude.json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-claude-'));
    fakeClaude(dir);
    const saved = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${saved}`;
    try {
      const plan = await planWrite(findAgent('claude-code')!, 'user', { command: '/l', args: [], env: {} });
      assert.equal(plan.method, 'cli');
      assert.equal(plan.next, plan.previous, 'the file itself must not be rewritten');
      assert.deepEqual(plan.commands?.[1].args.slice(0, 4), ['mcp', 'add-json', '-s', 'user']);
    } finally {
      process.env.PATH = saved;
    }
  });

  it('warns rather than editing the file when no CLI exists', async () => {
    const saved = process.env.PATH;
    const savedHome = process.env.HOME;
    process.env.PATH = '/nonexistent';
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-nohome-'));
    try {
      const plan = await planWrite(findAgent('claude-code')!, 'user', { command: '/l', args: [], env: {} });
      assert.equal(plan.unchanged, true);
      assert.match(plan.warning ?? '', /Claude CLI was not found/);
    } finally {
      process.env.PATH = saved;
      process.env.HOME = savedHome;
    }
  });

  it('runs an npm install through the editor runtime, since a GUI editor may not see node', async () => {
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-npm-'));
    const pkg = path.join(prefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(pkg, { recursive: true });
    const log = path.join(prefix, 'calls.log');
    fs.writeFileSync(path.join(pkg, 'cli.js'),
      `require('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');`);
    fs.mkdirSync(path.join(prefix, 'bin'));
    fs.symlinkSync(path.join(pkg, 'cli.js'), path.join(prefix, 'bin', 'claude'));
    const saved = process.env.PATH;
    process.env.PATH = `${path.join(prefix, 'bin')}${path.delimiter}${saved}`;
    try {
      const cli = findClaudeCli();
      assert.equal(cli?.command, process.execPath);
      assert.equal(cli?.prefix[0], fs.realpathSync(path.join(pkg, 'cli.js')));
      const result = await claudeAddUser(cli as ClaudeCli, 'zephyr-workbench', {});
      assert.equal(result.ok, true, result.output);
      assert.match(fs.readFileSync(log, 'utf8'), /mcp add-json -s user zephyr-workbench/);
    } finally {
      process.env.PATH = saved;
    }
  });

  it('resolves a Windows npm shim to the package entry point instead of running the .cmd', () => {
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-npm-win-'));
    const pkg = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ bin: { claude: 'cli.js' } }));
    fs.writeFileSync(path.join(pkg, 'cli.js'), '');
    const cli = resolveNpmShim(path.join(prefix, 'claude.cmd'));
    assert.equal(cli?.command, process.execPath);
    assert.deepEqual(cli?.prefix, [path.join(pkg, 'cli.js')]);
    assert.equal(cli?.env?.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(resolveNpmShim(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-npm-none-')), 'claude.cmd')), undefined,
      'no package next to the shim: skip it rather than guess');
  });

  it('puts the previous entry back when adding the new one fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-claude-'));
    const log = path.join(dir, 'calls.log');
    const cli = path.join(dir, 'claude');
    // Fails to add the new entry (command "/new"), accepts the old one.
    fs.writeFileSync(cli, [
      '#!/bin/sh',
      `echo "$@" >> "${log}"`,
      'case "$*" in *add-json*/new*) echo "invalid" >&2; exit 1;; esac',
      'exit 0',
    ].join('\n'), { mode: 0o755 });
    const result = await claudeAddUser(direct(cli), 'zephyr-workbench', { command: '/new' }, { command: '/old' });
    assert.equal(result.ok, false);
    assert.match(result.output, /put back/);
    assert.match(fs.readFileSync(log, 'utf8'), /add-json -s user zephyr-workbench \{"command":"\/old"\}/);
  });

  it('tells a missing entry apart from a failed removal', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-claude-'));
    const cli = path.join(dir, 'claude');
    fs.writeFileSync(cli, '#!/bin/sh\necho "No user-scoped MCP server found with name: zephyr-workbench" >&2\nexit 1\n', { mode: 0o755 });
    const result = await claudeRemoveUser(direct(cli), 'zephyr-workbench');
    assert.equal(result.ok, false);
    assert.equal(result.notFound, true);
  });

  it('leaves the entry alone when the first removal fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-claude-'));
    const log = path.join(dir, 'calls.log');
    const cli = path.join(dir, 'claude');
    fs.writeFileSync(cli, [
      '#!/bin/sh',
      `echo "$@" >> "${log}"`,
      'case "$2" in remove) echo "config file is locked" >&2; exit 1;; esac',
      'exit 0',
    ].join('\n'), { mode: 0o755 });
    const result = await claudeAddUser(direct(cli), 'zephyr-workbench', { command: '/new' }, { command: '/old' });
    assert.equal(result.ok, false);
    assert.match(result.output, /left unchanged/);
    assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /add-json/, 'nothing may be added over the old entry');
  });
});
