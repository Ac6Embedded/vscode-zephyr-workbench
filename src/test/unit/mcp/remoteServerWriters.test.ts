// A second server next to the workbench's own: the Zephyr Project's MCP server,
// reached over the network. It is written, inspected and removed by the same
// writers, and neither entry may ever disturb the other.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AGENTS, applyWrite, entrySnippet, findAgent, inspectEntry, planEntryWrite, planWrite, PlanOptions, remoteTarget,
  removeEntry, removeServerEntry,
} from '../../../mcp/agents';
import { codexBlockBody } from '../../../mcp/agents/descriptors';
import { parseJsonc } from '../../../mcp/agents/jsonMerge';
import { LauncherSpec } from '../../../mcp/agents/launcher';
import { BEGIN, END, markersFor, parseToml, removeServer, upsertServer } from '../../../mcp/agents/tomlBlock';
import { ZEPHYR_PROJECT_MCP } from '../../../mcp/core/externalResources';

const LAUNCHER: LauncherSpec = { command: '/home/u/.zephyr-workbench/mcp/zw-mcp', args: [], env: {} };
const OPTIONS: PlanOptions = { backupDir: path.join(os.tmpdir(), `zw-remote-backups-${process.pid}`) };
const ZEPHYR = remoteTarget(ZEPHYR_PROJECT_MCP.name, ZEPHYR_PROJECT_MCP.url);
const URL = ZEPHYR_PROJECT_MCP.url;

const tmpProject = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zw-remote-'));
const plainToml = (text: string) => JSON.parse(JSON.stringify(parseToml(text, 'config.toml'))) as {
  mcp_servers?: Record<string, Record<string, unknown>>;
};

describe('mcp/agents remote servers', () => {
  it('gives every agent an entry for a remote server, in its own shape', () => {
    const shapes = Object.fromEntries(AGENTS.map(agent => [agent.id, agent.remoteEntry?.(URL, 'user')]));
    assert.deepEqual(shapes, {
      'claude-code': { type: 'http', url: URL },
      codex: { url: URL },
      'vscode-copilot': { type: 'http', url: URL },
      cursor: { url: URL },
      // Older Gemini versions read a bare `url` as the SSE transport.
      'gemini-cli': { httpUrl: URL },
      opencode: { type: 'remote', url: URL, enabled: true },
      // Copilot CLI's reference requires `tools` in its own file.
      'copilot-cli': { type: 'http', url: URL, tools: ['*'] },
    });
  });

  it('writes one shape into the .mcp.json Claude Code and Copilot CLI share', async () => {
    const folder = tmpProject();
    const claude = findAgent('claude-code')!;
    const copilot = findAgent('copilot-cli')!;
    assert.deepEqual(copilot.remoteEntry!(URL, 'project'), claude.remoteEntry!(URL, 'project'));
    applyWrite(await planEntryWrite(claude, 'project', ZEPHYR, folder, OPTIONS), folder);
    assert.equal(inspectEntry(copilot, 'project', ZEPHYR, folder).state, 'configured',
      'the entry Claude Code wrote reads as connected for Copilot CLI too');
  });

  it('says how to sign in with every agent, naming the server where the agent needs it', () => {
    for (const agent of AGENTS) {
      const text = agent.signIn?.('zephyr-docs') ?? '';
      assert.ok(text.length > 0, `${agent.id} has no sign-in hint`);
      assert.ok(!text.includes('\u2014'), `${agent.id}: no em-dash in text the user sees`);
    }
    assert.match(findAgent('codex')!.signIn!('zephyr-docs'), /codex mcp login zephyr-docs/);
  });

  it('writes the Zephyr Project entry beside the workbench one, and removes it alone', async () => {
    for (const id of ['claude-code', 'cursor', 'gemini-cli', 'opencode', 'vscode-copilot']) {
      const agent = findAgent(id)!;
      const folder = tmpProject();
      applyWrite(await planWrite(agent, 'project', LAUNCHER, folder, OPTIONS), folder);
      const plan = await planEntryWrite(agent, 'project', ZEPHYR, folder, OPTIONS);
      assert.equal(plan.warning, undefined, `${id}: ${plan.warning}`);
      assert.equal(plan.server, 'zephyr-docs');
      applyWrite(plan, folder);

      const container = agent.containerPath ?? [];
      const read = () => {
        let value = parseJsonc<Record<string, unknown>>(fs.readFileSync(plan.file, 'utf8'), plan.file) as Record<string, unknown>;
        for (const key of container) {
          value = value[key] as Record<string, unknown>;
        }
        return value;
      };
      assert.deepEqual(read()['zephyr-docs'], agent.remoteEntry!(URL, 'project'), id);
      assert.ok(read()['zephyr-workbench'], `${id}: the workbench entry stays`);
      assert.equal(inspectEntry(agent, 'project', ZEPHYR, folder).state, 'configured', id);

      const removed = await removeServerEntry(agent, 'project', 'zephyr-docs', folder, OPTIONS);
      assert.equal(removed.changed, true, id);
      assert.equal(read()['zephyr-docs'], undefined, id);
      assert.ok(read()['zephyr-workbench'], `${id}: removing the Zephyr entry keeps the workbench one`);
    }
  });

  it('reports a changed Zephyr entry as outdated, and leaves the workbench status alone', async () => {
    const agent = findAgent('cursor')!;
    const folder = tmpProject();
    applyWrite(await planEntryWrite(agent, 'project', remoteTarget('zephyr-docs', 'https://old.example'), folder, OPTIONS), folder);
    assert.equal(inspectEntry(agent, 'project', ZEPHYR, folder).state, 'outdated');
    const replan = await planEntryWrite(agent, 'project', ZEPHYR, folder, OPTIONS);
    assert.equal(replan.unchanged, false);
    applyWrite(replan, folder);
    assert.equal(inspectEntry(agent, 'project', ZEPHYR, folder).state, 'configured');
    assert.equal((await removeEntry(agent, 'project', folder, OPTIONS)).changed, false, 'no workbench entry to remove');
  });

  describe('an entry added by hand under another name', () => {
    const write = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };

    it('reads as connected when it reaches the server, whatever its name or form', () => {
      const cursor = findAgent('cursor')!;
      for (const entry of [
        { url: `${URL}/` },
        { type: 'http', url: URL.toUpperCase().replace('HTTPS', 'https') },
        // A client that only starts local servers reaches it through mcp-remote.
        { command: 'npx', args: ['-y', 'mcp-remote', URL] },
      ]) {
        const folder = tmpProject();
        write(path.join(folder, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { zephyr: entry } }));
        const status = inspectEntry(cursor, 'project', ZEPHYR, folder);
        assert.equal(status.state, 'configured', JSON.stringify(entry));
        assert.equal(status.alias, 'zephyr');
      }
    });

    it('does not take another server for it', () => {
      const cursor = findAgent('cursor')!;
      for (const url of ['https://nordicsemi.mcp.kapa.ai', `${URL}.example.com`, 'https://example.com/?next=zephyrproject.mcp.kapa.ai']) {
        const folder = tmpProject();
        write(path.join(folder, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { url } } }));
        assert.equal(inspectEntry(cursor, 'project', ZEPHYR, folder).state, 'not-configured', url);
      }
    });

    it('is found in the Codex file too, and never removed from here', async () => {
      const home = tmpProject();
      const previous = process.env.CODEX_HOME;
      process.env.CODEX_HOME = home;
      try {
        const codex = findAgent('codex')!;
        write(path.join(home, 'config.toml'), `model = "x"

[mcp_servers.zephyr]
url = "${URL}"
`);
        const status = inspectEntry(codex, 'user', ZEPHYR, undefined);
        assert.equal(status.state, 'configured');
        assert.equal(status.alias, 'zephyr');
        const removed = await removeServerEntry(codex, 'user', 'zephyr-docs', undefined, OPTIONS);
        assert.equal(removed.changed, false, 'only an entry under the panel\'s own name is removed');
      } finally {
        if (previous === undefined) {
          delete process.env.CODEX_HOME;
        } else {
          process.env.CODEX_HOME = previous;
        }
      }
    });
  });

  it('plans the Claude user entry with the CLI, under its own name', async () => {
    const plan = await planEntryWrite(findAgent('claude-code')!, 'user', ZEPHYR, undefined, {
      ...OPTIONS, claudeExtensionPath: '/nonexistent',
    });
    if (plan.commands) {
      assert.deepEqual(plan.commands[1].args.slice(0, 5), ['mcp', 'add-json', '-s', 'user', 'zephyr-docs']);
      assert.deepEqual(JSON.parse(plan.commands[1].args[5]), { type: 'http', url: URL });
    } else {
      // No Claude CLI on this machine: the plan says so rather than editing ~/.claude.json.
      assert.match(plan.warning ?? '', /Claude CLI was not found/);
    }
  });

  describe('Codex', () => {
    const workbench = codexBlockBody(findAgent('codex')!.entry(LAUNCHER) as Record<string, unknown>);
    const zephyr = codexBlockBody({ url: URL }, 'zephyr-docs');

    it('keeps each server in its own marked block', () => {
      let text = upsertServer('model = "x"\n', 'zephyr-workbench', workbench, 'config.toml');
      text = upsertServer(text, 'zephyr-docs', zephyr, 'config.toml');
      const { begin, end } = markersFor('zephyr-docs');
      assert.notEqual(begin, BEGIN);
      for (const marker of [BEGIN, END, begin, end]) {
        assert.equal(text.split(marker).length - 1, 1, `${marker} appears once`);
      }
      const servers = plainToml(text).mcp_servers!;
      assert.deepEqual(servers['zephyr-docs'], { url: URL });
      assert.equal(servers['zephyr-workbench'].command, LAUNCHER.command);
    });

    it('removes one server with its markers and keeps the other block whole', () => {
      const both = upsertServer(upsertServer('model = "x"\n', 'zephyr-workbench', workbench, 'config.toml'),
        'zephyr-docs', zephyr, 'config.toml');
      const withoutZephyr = removeServer(both, 'zephyr-docs', 'config.toml');
      assert.equal(withoutZephyr, upsertServer('model = "x"\n', 'zephyr-workbench', workbench, 'config.toml'));
      const withoutWorkbench = removeServer(both, 'zephyr-workbench', 'config.toml');
      assert.ok(!withoutWorkbench.includes(BEGIN) && !withoutWorkbench.includes(END));
      assert.ok(withoutWorkbench.includes(markersFor('zephyr-docs').begin));
      assert.deepEqual(Object.keys(plainToml(withoutWorkbench).mcp_servers!), ['zephyr-docs']);
    });

    it('updates the Zephyr entry in place when the workbench block comes after it', () => {
      let text = upsertServer('model = "x"\n', 'zephyr-docs', codexBlockBody({ url: 'https://old.example' }, 'zephyr-docs'), 'config.toml');
      text = upsertServer(text, 'zephyr-workbench', workbench, 'config.toml');
      text = upsertServer(text, 'zephyr-docs', zephyr, 'config.toml');
      const servers = plainToml(text).mcp_servers!;
      assert.deepEqual(servers['zephyr-docs'], { url: URL });
      assert.equal(text.split(BEGIN).length - 1, 1, 'the workbench markers survive the update');
    });
  });

  it('gives a snippet in each agent\'s own shape', () => {
    assert.deepEqual(JSON.parse(entrySnippet(findAgent('gemini-cli')!, ZEPHYR)!), { mcpServers: { 'zephyr-docs': { httpUrl: URL } } });
    assert.deepEqual(JSON.parse(entrySnippet(findAgent('opencode')!, ZEPHYR)!), { mcp: { 'zephyr-docs': { type: 'remote', url: URL, enabled: true } } });
    assert.equal(entrySnippet(findAgent('codex')!, ZEPHYR), `[mcp_servers.zephyr-docs]\nurl = "${URL}"\n`);
  });
});
