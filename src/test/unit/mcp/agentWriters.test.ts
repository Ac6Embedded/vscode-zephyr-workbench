import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AGENTS, applyWrite, configSnippet, findAgent, inspectAgent, planWrite, PlanOptions, projectLauncher, removeEntry } from '../../../mcp/agents';
import { codexBlockBody } from '../../../mcp/agents/descriptors';
import { parseJsonc, removeJsonPath } from '../../../mcp/agents/jsonMerge';
import { BEGIN, END, parseToml, removeServer, stripServer, upsertServer } from '../../../mcp/agents/tomlBlock';
import { LauncherSpec } from '../../../mcp/agents/launcher';

const LAUNCHER: LauncherSpec = { command: '/home/u/.zephyr-workbench/mcp/zw-mcp', args: [], env: {} };
const WIN_LAUNCHER: LauncherSpec = {
  command: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
  args: ['C:\\Users\\u\\.zephyr-workbench\\mcp\\bridge.cjs'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
};

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zw-agent-'));
}

/** Backups go to a throwaway folder, never the real MCP home. */
const OPTIONS: PlanOptions = { backupDir: path.join(os.tmpdir(), `zw-agent-backups-${process.pid}`) };

/** Write a plan into a temp project and return the resulting file text. */
async function writeInto(agentId: string, folder: string, launcher = LAUNCHER): Promise<{ file: string; text: string }> {
  const agent = findAgent(agentId)!;
  const plan = await planWrite(agent, 'project', launcher, folder, OPTIONS);
  assert.equal(plan.warning, undefined, plan.warning);
  applyWrite(plan, folder);
  return { file: plan.file, text: fs.readFileSync(plan.file, 'utf8') };
}

const CODEX_BODY = codexBlockBody(findAgent('codex')!.entry(LAUNCHER) as Record<string, unknown>);
/** Parsed TOML as plain objects (smol-toml returns null-prototype ones). */
const plainToml = (text: string) => JSON.parse(JSON.stringify(parseToml(text, 'config.toml'))) as Record<string, unknown>;
const serverIn = (text: string) =>
  (plainToml(text).mcp_servers as Record<string, Record<string, unknown>> | undefined)?.['zephyr-workbench'];

describe('mcp/agents writers', () => {
  it('covers every agent the first release promises', () => {
    const ids = AGENTS.map(a => a.id).sort();
    assert.deepEqual(ids, [
      'claude-code', 'codex', 'copilot-cli', 'cursor', 'gemini-cli', 'opencode', 'vscode-copilot',
    ]);
  });

  describe('Claude Code', () => {
    it('writes a project .mcp.json with a stdio entry under mcpServers', async () => {
      const folder = tmpProject();
      const { file, text } = await writeInto('claude-code', folder);
      assert.equal(file, path.join(folder, '.mcp.json'));
      const parsed = parseJsonc<{ mcpServers: Record<string, { type: string; command: string }> }>(text, file);
      assert.equal(parsed.mcpServers['zephyr-workbench'].type, 'stdio');
      assert.equal(parsed.mcpServers['zephyr-workbench'].command, LAUNCHER.command);
    });
  });

  describe('VS Code', () => {
    it('uses the servers key, not mcpServers', async () => {
      const folder = tmpProject();
      const { file, text } = await writeInto('vscode-copilot', folder);
      assert.equal(file, path.join(folder, '.vscode', 'mcp.json'));
      const parsed = parseJsonc<Record<string, unknown>>(text, file);
      assert.ok(parsed.servers, 'VS Code reads a top-level "servers" key');
      assert.equal(parsed.mcpServers, undefined);
    });
  });

  describe('opencode', () => {
    it('writes command as an array under the mcp key', async () => {
      const folder = tmpProject();
      const { file, text } = await writeInto('opencode', folder, WIN_LAUNCHER);
      const parsed = parseJsonc<{ mcp: Record<string, { type: string; command: string[]; timeout: number }> }>(text, file);
      const entry = parsed.mcp['zephyr-workbench'];
      assert.equal(entry.type, 'local');
      assert.ok(Array.isArray(entry.command), 'opencode takes the command as an array');
      assert.deepEqual(entry.command, [WIN_LAUNCHER.command, ...WIN_LAUNCHER.args]);
      // In opencode this same value also caps every tool call, so it must clear a build.
      assert.ok(entry.timeout >= 600_000, 'the timeout must be large enough for a full build');
    });
  });

  describe('Gemini CLI', () => {
    it('writes a timeout big enough for a real build and does not auto-trust', async () => {
      const folder = tmpProject();
      const { file, text } = await writeInto('gemini-cli', folder);
      const parsed = parseJsonc<{ mcpServers: Record<string, { timeout: number; trust: boolean }> }>(text, file);
      assert.ok(parsed.mcpServers['zephyr-workbench'].timeout >= 600_000);
      assert.equal(parsed.mcpServers['zephyr-workbench'].trust, false);
    });
  });

  describe('Copilot CLI', () => {
    it('writes the same entry as Claude Code, because both read a project .mcp.json', async () => {
      const folder = tmpProject();
      const { text, file } = await writeInto('copilot-cli', folder);
      const parsed = parseJsonc<{ mcpServers: Record<string, unknown> }>(text, file);
      assert.deepEqual(parsed.mcpServers['zephyr-workbench'], findAgent('claude-code')!.entry(LAUNCHER));
      assert.equal(inspectAgent(findAgent('claude-code')!, 'project', LAUNCHER, folder).state, 'configured',
        'writing for one must not make the other look outdated');
    });
  });

  describe('Claude Code user file', () => {
    it('follows CLAUDE_CONFIG_DIR', () => {
      const saved = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = '/custom/claude';
      try {
        assert.equal(findAgent('claude-code')!.file('user'), path.join('/custom/claude', '.claude.json'));
      } finally {
        if (saved === undefined) {
          delete process.env.CLAUDE_CONFIG_DIR;
        } else {
          process.env.CLAUDE_CONFIG_DIR = saved;
        }
      }
    });
  });

  describe('Codex TOML', () => {
    it('writes a marked table that parses as TOML', () => {
      const text = upsertServer('', 'zephyr-workbench', CODEX_BODY, 'config.toml');
      assert.ok(text.includes(BEGIN) && text.includes(END));
      assert.match(text, /\[mcp_servers\.zephyr-workbench\]/);
      assert.equal(serverIn(text)?.tool_timeout_sec, 1800);
    });

    it('preserves the user content and comments around it', () => {
      const existing = [
        '# my codex settings',
        'model = "gpt-5"',
        '',
        '[mcp_servers.node_repl]',
        'command = "node"',
        '',
        '# trusted folders',
        '[projects."/home/u/ws"]',
        'trust_level = "trusted"',
        '',
      ].join('\n');
      const text = upsertServer(existing, 'zephyr-workbench', CODEX_BODY, 'config.toml');
      assert.ok(text.startsWith(existing.trimEnd()), 'everything before must be byte for byte the same');
      assert.ok(serverIn(text));
    });

    it('is a no-op when the entry is already right, wherever it sits', () => {
      const once = upsertServer('model = "x"\n', 'zephyr-workbench', CODEX_BODY, 'config.toml');
      const withMore = `${once}\n[projects."/a"]\ntrust_level = "trusted"\n`;
      assert.equal(upsertServer(once, 'zephyr-workbench', CODEX_BODY, 'config.toml'), once);
      assert.equal(upsertServer(withMore, 'zephyr-workbench', CODEX_BODY, 'config.toml'), withMore);
    });

    it('replaces an outdated block rather than stacking a second one', () => {
      const old = upsertServer('model = "x"\n', 'zephyr-workbench',
        codexBlockBody({ command: '/old', args: [] }), 'config.toml');
      const text = upsertServer(old, 'zephyr-workbench', CODEX_BODY, 'config.toml');
      assert.equal(text.split(BEGIN).length - 1, 1, 'exactly one managed block');
      assert.equal(serverIn(text)?.command, LAUNCHER.command);
    });

    it('takes over a table written by hand from the docs, keeping everything else', () => {
      const handWritten = [
        'model = "x"',
        '',
        '[mcp_servers.zephyr-workbench]',
        'command = "mine"',
        '',
        '[mcp_servers."zephyr-workbench".env]',
        'FOO = "1"',
        '',
        '# keep this comment with the next table',
        '[mcp_servers.other]',
        'command = "other"',
        '',
      ].join('\n');
      const text = upsertServer(handWritten, 'zephyr-workbench', CODEX_BODY, 'config.toml');
      assert.equal(serverIn(text)?.command, LAUNCHER.command);
      assert.equal(serverIn(text)?.env, undefined, 'the old subtable must go with its table');
      assert.match(text, /# keep this comment with the next table\n\[mcp_servers\.other\]/);
      assert.ok((parseToml(text, 'c').mcp_servers as Record<string, unknown>).other);
    });

    it('recovers from a block whose end marker was deleted', () => {
      const broken = `model = "x"\n${BEGIN}\n[mcp_servers.zephyr-workbench]\ncommand = "old"\n`;
      const text = upsertServer(broken, 'zephyr-workbench', CODEX_BODY, 'config.toml');
      assert.equal(text.split(BEGIN).length - 1, 1);
      assert.equal(text.split(END).length - 1, 1);
      assert.equal(serverIn(text)?.command, LAUNCHER.command);
    });

    it('removes dotted keys that define the entry outside a table of its own', () => {
      const dotted = '[mcp_servers]\nzephyr-workbench.command = "a"\nzephyr-workbench.args = [\n  "x",\n]\nother = { command = "o" }\n';
      const text = upsertServer(dotted, 'zephyr-workbench', CODEX_BODY, 'config.toml');
      assert.equal(serverIn(text)?.command, LAUNCHER.command);
      assert.deepEqual((plainToml(text).mcp_servers as Record<string, unknown>).other, { command: 'o' });
    });

    it('is not fooled by table-like lines inside multi-line strings and arrays', () => {
      const tricky = [
        'notes = """',
        '[mcp_servers.zephyr-workbench]',
        '"""',
        'list = [',
        '  ["mcp_servers"],',
        ']',
        '',
      ].join('\n');
      assert.equal(stripServer(tricky, 'zephyr-workbench'), tricky);
      const text = upsertServer(tricky, 'zephyr-workbench', CODEX_BODY, 'config.toml');
      assert.equal(parseToml(text, 'c').notes, '[mcp_servers.zephyr-workbench]\n');
    });

    it('keeps Windows line endings', () => {
      const crlf = 'model = "x"\r\n\r\n[a]\r\nb = 1\r\n';
      const text = upsertServer(crlf, 'zephyr-workbench', CODEX_BODY, 'config.toml');
      assert.ok(!/[^\r]\n/.test(text), 'every line ending must stay CRLF');
    });

    it('refuses invalid TOML instead of guessing', async () => {
      const folder = tmpProject();
      const file = path.join(folder, 'config.toml');
      fs.writeFileSync(file, 'model = \n');
      const patched = { ...findAgent('codex')!, file: () => file };
      const plan = await planWrite(patched, 'user', LAUNCHER, folder, OPTIONS);
      assert.equal(plan.unchanged, true);
      assert.match(plan.warning ?? '', /not valid TOML/);
      assert.equal(inspectAgent(patched, 'user', LAUNCHER).state, 'foreign');
    });

    it('reports configured and outdated from the parsed values, not the text', () => {
      const text = upsertServer('', 'zephyr-workbench', CODEX_BODY, 'config.toml');
      const folder = tmpProject();
      const file = path.join(folder, 'config.toml');
      fs.writeFileSync(file, text);
      const patched = { ...findAgent('codex')!, file: () => file };
      assert.equal(inspectAgent(patched, 'user', LAUNCHER).state, 'configured');
      assert.equal(inspectAgent(patched, 'user', { ...LAUNCHER, args: ['--x'] }).state, 'outdated',
        'a change in args alone must count as outdated');
    });

    it('removes the entry and nothing else', () => {
      const text = upsertServer('model = "x"\n', 'zephyr-workbench', CODEX_BODY, 'config.toml');
      assert.equal(removeServer(text, 'zephyr-workbench', 'config.toml'), 'model = "x"\n');
    });

    it('writes a nested env table correctly', () => {
      const body = codexBlockBody({ command: 'x', args: [], env: { ELECTRON_RUN_AS_NODE: '1' } });
      const text = upsertServer('', 'zephyr-workbench', body, 'config.toml');
      assert.match(text, /\[mcp_servers\.zephyr-workbench\.env\]/);
      assert.deepEqual(serverIn(text)?.env, { ELECTRON_RUN_AS_NODE: '1' });
    });
  });

  describe('merging into existing JSON', () => {
    it('keeps comments and other servers intact', async () => {
      const folder = tmpProject();
      const file = path.join(folder, '.mcp.json');
      fs.writeFileSync(file, [
        '{',
        '  // my own notes, which must survive',
        '  "mcpServers": {',
        '    "other-server": { "type": "stdio", "command": "keep-me" }',
        '  }',
        '}',
        '',
      ].join('\n'));
      const { text } = await writeInto('claude-code', folder);
      assert.match(text, /my own notes, which must survive/, 'comments must be preserved');
      assert.match(text, /keep-me/, 'the other server must be preserved');
      assert.match(text, /zephyr-workbench/);
    });

    it('is idempotent', async () => {
      const folder = tmpProject();
      const first = await writeInto('claude-code', folder);
      const agent = findAgent('claude-code')!;
      const plan = await planWrite(agent, 'project', LAUNCHER, folder, OPTIONS);
      assert.equal(plan.unchanged, true, 'a second identical write must be a no-op');
      assert.equal(plan.next, first.text);
    });

    it('keeps a backup when it replaces an existing entry', async () => {
      const folder = tmpProject();
      await writeInto('claude-code', folder);
      const agent = findAgent('claude-code')!;
      const changed = await planWrite(agent, 'project', { ...LAUNCHER, command: '/new/path' }, folder, OPTIONS);
      const { backup } = applyWrite(changed, folder);
      assert.ok(backup && fs.existsSync(backup), 'a replaced file must leave a backup');
      assert.match(fs.readFileSync(backup as string, 'utf8'), /zw-mcp/);
      assert.equal(path.dirname(backup as string), OPTIONS.backupDir, 'backups must never land in the project');
      assert.deepEqual(fs.readdirSync(folder), ['.mcp.json']);
    });

    it('refuses a container that is not an object rather than mangling it', async () => {
      const folder = tmpProject();
      fs.writeFileSync(path.join(folder, '.mcp.json'), '{ "mcpServers": [] }\n');
      const plan = await planWrite(findAgent('claude-code')!, 'project', LAUNCHER, folder, OPTIONS);
      assert.equal(plan.unchanged, true);
      assert.match(plan.warning ?? '', /not an object/);
    });

    it('refuses to write when the file changed after the preview', async () => {
      const folder = tmpProject();
      const plan = await planWrite(findAgent('cursor')!, 'project', LAUNCHER, folder, OPTIONS);
      fs.mkdirSync(path.join(folder, '.cursor'));
      fs.writeFileSync(path.join(folder, '.cursor', 'mcp.json'), '{"mcpServers":{"mine":{}}}');
      assert.throws(() => applyWrite(plan, folder), /changed since the preview/);
    });

    it('never writes through a symbolic link planted in a project', async function () {
      if (process.platform === 'win32') {
        this.skip();
        return;
      }
      const folder = tmpProject();
      const victim = path.join(tmpProject(), 'victim.json');
      fs.writeFileSync(victim, '{}');
      fs.symlinkSync(victim, path.join(folder, '.mcp.json'));
      const plan = await planWrite(findAgent('claude-code')!, 'project', LAUNCHER, folder, OPTIONS);
      assert.equal(plan.unchanged, true);
      assert.match(plan.warning ?? '', /symbolic link/);

      const linkedDir = tmpProject();
      fs.symlinkSync(tmpProject(), path.join(linkedDir, '.cursor'));
      const dirPlan = await planWrite(findAgent('cursor')!, 'project', LAUNCHER, linkedDir, OPTIONS);
      assert.match(dirPlan.warning ?? '', /symbolic link/);
      assert.equal(fs.readFileSync(victim, 'utf8'), '{}');
    });

    it('edits the real file behind a linked user config, keeping the link', async function () {
      if (process.platform === 'win32') {
        this.skip();
        return;
      }
      const dotfiles = tmpProject();
      const real = path.join(dotfiles, 'mcp.json');
      fs.writeFileSync(real, '{}\n');
      const link = path.join(tmpProject(), 'mcp.json');
      fs.symlinkSync(real, link);
      const patched = { ...findAgent('cursor')!, file: () => link };
      applyWrite(await planWrite(patched, 'user', LAUNCHER, undefined, OPTIONS));
      assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link must survive');
      assert.match(fs.readFileSync(real, 'utf8'), /zephyr-workbench/);
    });

    it('refuses a file it cannot parse rather than overwriting it', async () => {
      const folder = tmpProject();
      const file = path.join(folder, '.mcp.json');
      fs.writeFileSync(file, '{ this is not json');
      const agent = findAgent('claude-code')!;
      const status = inspectAgent(agent, 'project', LAUNCHER, folder);
      assert.equal(status.state, 'foreign', 'an unparseable file must be reported, not clobbered');
    });
  });

  describe('inspect', () => {
    it('reports not-configured, then configured, then outdated', async () => {
      const folder = tmpProject();
      const agent = findAgent('cursor')!;
      assert.equal(inspectAgent(agent, 'project', LAUNCHER, folder).state, 'not-configured');
      applyWrite(await planWrite(agent, 'project', LAUNCHER, folder, OPTIONS), folder);
      assert.equal(inspectAgent(agent, 'project', LAUNCHER, folder).state, 'configured');
      // A moved editor changes the launcher path, which is the real "outdated" case.
      assert.equal(inspectAgent(agent, 'project', { ...LAUNCHER, command: '/moved' }, folder).state, 'outdated');
    });

    it('reports no-file for VS Code at user scope, which the API covers instead', () => {
      const agent = findAgent('vscode-copilot')!;
      assert.equal(inspectAgent(agent, 'user', LAUNCHER).state, 'no-file');
    });
  });

  describe('remove', () => {
    it('removes only our entry and leaves the rest', async () => {
      const folder = tmpProject();
      const file = path.join(folder, '.mcp.json');
      fs.writeFileSync(file, JSON.stringify({
        mcpServers: { 'other-server': { command: 'keep-me' } },
      }, null, 2));
      const agent = findAgent('claude-code')!;
      applyWrite(await planWrite(agent, 'project', LAUNCHER, folder, OPTIONS), folder);
      const result = await removeEntry(agent, 'project', folder, OPTIONS);
      assert.equal(result.changed, true);
      const after = parseJsonc<{ mcpServers: Record<string, unknown> }>(fs.readFileSync(file, 'utf8'), file);
      assert.equal(after.mcpServers['zephyr-workbench'], undefined);
      assert.ok(after.mcpServers['other-server'], 'the other server must survive removal');
    });

    it('is a no-op when nothing was configured', async () => {
      const folder = tmpProject();
      const result = await removeEntry(findAgent('cursor')!, 'project', folder, OPTIONS);
      assert.equal(result.changed, false);
    });
  });

  describe('copyable snippets', () => {
    it('nests the exact entry under each agent key, and parses', () => {
      const vscodeSnippet = JSON.parse(configSnippet(findAgent('vscode-copilot'), LAUNCHER));
      assert.deepEqual(vscodeSnippet.servers['zephyr-workbench'], findAgent('vscode-copilot')!.entry(LAUNCHER));
      const opencode = JSON.parse(configSnippet(findAgent('opencode'), WIN_LAUNCHER));
      assert.ok(Array.isArray(opencode.mcp['zephyr-workbench'].command));
      const codex = configSnippet(findAgent('codex'), LAUNCHER);
      assert.equal(serverIn(codex)?.command, LAUNCHER.command);
      const generic = JSON.parse(configSnippet(undefined, WIN_LAUNCHER));
      assert.deepEqual(generic.mcpServers['zephyr-workbench'].env, { ELECTRON_RUN_AS_NODE: '1' });
    });
  });

  describe('review regressions', () => {
    it('removes an entry without touching comments or the formatting of its neighbours', () => {
      const text = [
        '{',
        '  "mcpServers": {',
        '    // my note about other',
        '    "other": {"command":"o"}, // trailing note',
        '    "zephyr-workbench": {',
        '      "command": "x"',
        '    },',
        '    // "old": { "command": "commented out" },',
        '    "third": 1',
        '  }',
        '}',
        '',
      ].join('\n');
      const after = removeJsonPath(text, ['mcpServers', 'zephyr-workbench']);
      assert.match(after, /my note about other/);
      assert.match(after, /"other": \{"command":"o"\}, \/\/ trailing note/, 'the neighbour must not be reformatted');
      assert.match(after, /\/\/ "old": \{ "command": "commented out" \},/);
      assert.equal(parseJsonc<{ mcpServers: Record<string, unknown> }>(after, 'f').mcpServers['zephyr-workbench'], undefined);
    });

    it('removes the last entry and the comma before it', () => {
      const text = '{\n  "mcpServers": {\n    "other": 1,\n    "zephyr-workbench": {"command": "x"}\n  }\n}\n';
      assert.equal(removeJsonPath(text, ['mcpServers', 'zephyr-workbench']), '{\n  "mcpServers": {\n    "other": 1\n  }\n}\n');
    });

    it('keeps the user comments after the Codex block on Remove', () => {
      const withBlock = upsertServer('model = "x"\n', 'zephyr-workbench', CODEX_BODY, 'config.toml');
      const text = `${withBlock}# my own trailing note\n`;
      const removed = removeServer(text, 'zephyr-workbench', 'config.toml');
      assert.match(removed, /# my own trailing note/);
      assert.equal(serverIn(removed), undefined);
    });

    it('never writes through a planted temporary file', async function () {
      if (process.platform === 'win32') {
        this.skip();
        return;
      }
      const folder = tmpProject();
      const victim = path.join(tmpProject(), 'victim');
      fs.writeFileSync(victim, 'untouched');
      const plan = await planWrite(findAgent('claude-code')!, 'project', LAUNCHER, folder, OPTIONS);
      // Every name the old, predictable scheme could have used is planted as a link.
      for (let pid = process.pid - 2; pid <= process.pid + 2; pid++) {
        fs.symlinkSync(victim, path.join(path.dirname(plan.file), `.${path.basename(plan.file)}.zw-${pid}.tmp`));
      }
      applyWrite(plan, folder);
      assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched');
      assert.equal(fs.lstatSync(plan.file).isSymbolicLink(), false);
      assert.match(fs.readFileSync(plan.file, 'utf8'), /zephyr-workbench/);
    });

    it('writes where a dangling dotfile link points, keeping the link', async function () {
      if (process.platform === 'win32') {
        this.skip();
        return;
      }
      const dotfiles = tmpProject();
      const real = path.join(dotfiles, 'cursor-mcp.json');
      const link = path.join(tmpProject(), 'mcp.json');
      fs.symlinkSync(real, link);
      const patched = { ...findAgent('cursor')!, file: () => link };
      applyWrite(await planWrite(patched, 'user', LAUNCHER, undefined, OPTIONS));
      assert.ok(fs.lstatSync(link).isSymbolicLink());
      assert.match(fs.readFileSync(real, 'utf8'), /zephyr-workbench/);
    });

    it('offers Codex at user scope only, and follows CODEX_HOME and XDG_CONFIG_HOME', () => {
      const saved = { codex: process.env.CODEX_HOME, xdg: process.env.XDG_CONFIG_HOME };
      process.env.CODEX_HOME = '/custom/codex';
      process.env.XDG_CONFIG_HOME = '/custom/xdg';
      try {
        assert.equal(findAgent('codex')!.file('project', '/ws'), undefined);
        assert.equal(findAgent('codex')!.file('user'), path.join('/custom/codex', 'config.toml'));
        assert.equal(findAgent('opencode')!.file('user'), path.join('/custom/xdg', 'opencode', 'opencode.json'));
      } finally {
        for (const [key, value] of [['CODEX_HOME', saved.codex], ['XDG_CONFIG_HOME', saved.xdg]] as const) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    });

    it('tells the user a project entry works for them only', async () => {
      const plan = await planWrite(findAgent('cursor')!, 'project', LAUNCHER, tmpProject(), OPTIONS);
      assert.match(plan.notice ?? '', /works for you only/);
      assert.equal(plan.warning, undefined, 'a notice must not block the write');
    });
  });

  describe('verification regressions', () => {
    it('keeps the user comments after the Codex block on Repair', () => {
      const old = upsertServer('model = "x"\n', 'zephyr-workbench', codexBlockBody({ command: '/old', args: [] }), 'config.toml');
      const text = `${old}# my own trailing note\n`;
      const repaired = upsertServer(text, 'zephyr-workbench', CODEX_BODY, 'config.toml');
      assert.match(repaired, /# my own trailing note/);
      assert.equal(serverIn(repaired)?.command, LAUNCHER.command);
    });

    it('keeps a comment that sits between the entry and its comma', () => {
      const text = '{\n  "mcpServers": {\n    "zephyr-workbench": {"command": "x"}\n    // note\n    , "b": 2\n  }\n}\n';
      const after = removeJsonPath(text, ['mcpServers', 'zephyr-workbench']);
      assert.match(after, /\/\/ note/);
      assert.deepEqual(parseJsonc<{ mcpServers: Record<string, unknown> }>(after, 'f').mcpServers, { b: 2 });
    });

    it('follows a chain of dotfile links to its end, keeping every link', async function () {
      if (process.platform === 'win32') {
        this.skip();
        return;
      }
      const dotfiles = tmpProject();
      const final = path.join(dotfiles, 'cursor', 'mcp.json');
      fs.mkdirSync(path.dirname(final));
      const middle = path.join(dotfiles, 'cursor-link');
      fs.symlinkSync('cursor/mcp.json', middle);
      const link = path.join(tmpProject(), 'mcp.json');
      fs.symlinkSync(middle, link);
      const patched = { ...findAgent('cursor')!, file: () => link };
      applyWrite(await planWrite(patched, 'user', LAUNCHER, undefined, OPTIONS));
      assert.ok(fs.lstatSync(link).isSymbolicLink());
      assert.ok(fs.lstatSync(middle).isSymbolicLink());
      assert.match(fs.readFileSync(final, 'utf8'), /zephyr-workbench/);
    });
  });

  describe('shared project files', () => {
    const home = os.homedir();
    const mine: LauncherSpec = { command: path.join(home, '.zephyr-workbench', 'mcp', 'zw-mcp'), args: [], env: {} };

    it('names the launcher through each agent\'s own home variable', () => {
      const expected: Record<string, string> = {
        'claude-code': '${HOME}/.zephyr-workbench/mcp/zw-mcp',
        'copilot-cli': '${HOME}/.zephyr-workbench/mcp/zw-mcp',
        'gemini-cli': '${HOME}/.zephyr-workbench/mcp/zw-mcp',
        'vscode-copilot': '${userHome}/.zephyr-workbench/mcp/zw-mcp',
        cursor: '${userHome}/.zephyr-workbench/mcp/zw-mcp',
        opencode: '{env:HOME}/.zephyr-workbench/mcp/zw-mcp',
      };
      for (const [id, command] of Object.entries(expected)) {
        const result = projectLauncher(findAgent(id)!, mine, 'darwin', home);
        assert.equal(result.portable, true, id);
        assert.equal(result.launcher.command, command, id);
      }
    });

    it('keeps the absolute form where no portable one exists', () => {
      assert.equal(projectLauncher(findAgent('cursor')!, mine, 'win32', home).portable, false, 'the Windows launcher is the editor itself');
      assert.equal(projectLauncher(findAgent('cursor')!, { ...mine, command: '/opt/zw/zw-mcp' }, 'linux', home).portable, false);
      assert.equal(projectLauncher(findAgent('codex')!, mine, 'linux', home).portable, false, 'Codex expands nothing');
    });

    it('writes the same project file for every developer, and reads it back as configured', async function () {
      if (process.platform === 'win32') {
        this.skip();
        return;
      }
      const folder = tmpProject();
      const plan = await planWrite(findAgent('claude-code')!, 'project', mine, folder, OPTIONS);
      assert.match(plan.next, /"command": "\$\{HOME\}\/\.zephyr-workbench\/mcp\/zw-mcp"/);
      assert.match(plan.notice ?? '', /works for everyone/);
      assert.ok(!plan.next.includes(home), 'no personal path may be committed');
      applyWrite(plan, folder);
      assert.equal(inspectAgent(findAgent('claude-code')!, 'project', mine, folder).state, 'configured');
      assert.equal(inspectAgent(findAgent('copilot-cli')!, 'project', mine, folder).state, 'configured');
    });

    it('keeps user files absolute, since only the user reads them', async () => {
      const file = path.join(tmpProject(), 'mcp.json');
      const patched = { ...findAgent('cursor')!, file: () => file };
      const plan = await planWrite(patched, 'user', mine, undefined, OPTIONS);
      assert.ok(plan.next.includes(mine.command));
    });
  });
});
