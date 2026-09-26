// Claude Code's own answer about the servers it reaches: read from
// `claude mcp list`, then applied to the rows the AI Manager read from files,
// so a server held by the claude.ai account reads as connected.

import { strict as assert } from 'assert';
import { parseClaudeMcpList } from '../../../mcp/agents/claudeCli';
import { applyClaudeCheck, ReportedRow } from '../../../mcp/agents/claudeReport';

const URL = 'https://zephyrproject.mcp.kapa.ai';
const TARGET = { name: 'zephyr-docs', url: URL, hint: /zephyr/i };

// The shape Claude Code 2.x prints, with a local server's command line elided.
const LISTING = [
  'Checking MCP server health…',
  '',
  'claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected',
  `claude.ai Zephyr Docs: ${URL} - ✔ Connected`,
  'claude.ai Drive: https://drivemcp.googleapis.com/mcp/v1 - ! Needs authentication',
  'zephyr-workbench: /home/u/.zephyr-workbench/mcp/zw-mcp  - ✔ Connected',
  `zephyr: ${URL}/ (HTTP) - ✗ Failed to connect`,
].join('\n');

const row = (over: Partial<ReportedRow>): ReportedRow => ({
  id: 'claude-code', label: 'Claude Code', detected: true, scope: 'user', state: 'not-configured', ...over,
});

describe('mcp/agents Claude Code report', () => {
  describe('parseClaudeMcpList', () => {
    it('reads each server with its address, its origin and its health', () => {
      const servers = parseClaudeMcpList(LISTING);
      assert.deepEqual(servers.map(server => [server.name, server.account, server.health]), [
        ['claude.ai Claude Docs', true, 'connected'],
        ['claude.ai Zephyr Docs', true, 'connected'],
        ['claude.ai Drive', true, 'needs-auth'],
        ['zephyr-workbench', false, 'connected'],
        ['zephyr', false, 'failed'],
      ]);
      assert.equal(servers[1].target, URL);
      assert.equal(servers[4].target, `${URL}/ (HTTP)`);
    });

    it('reads nothing from a listing without servers', () => {
      assert.deepEqual(parseClaudeMcpList('No MCP servers configured. Use `claude mcp add` to add a server.'), []);
    });
  });

  describe('applyClaudeCheck', () => {
    const files = [row({}), row({ scope: 'project' })];

    it('adds the claude.ai connector that reaches the server, under its own name', () => {
      const rows = applyClaudeCheck(files, TARGET, { checking: false, servers: parseClaudeMcpList(LISTING) });
      const account = rows.find(item => item.scope === 'account');
      assert.deepEqual(account, {
        id: 'claude-code', label: 'Claude Code', detected: true, scope: 'account', state: 'configured',
        alias: 'Zephyr Docs', health: 'connected', checking: undefined, source: 'claude.ai connector Zephyr Docs',
      });
    });

    it('shows an entry no file here holds, such as one kept for this folder alone', () => {
      const rows = applyClaudeCheck(files, TARGET, { checking: false, servers: parseClaudeMcpList(LISTING) });
      const other = rows.find(item => item.scope === 'other');
      assert.equal(other?.alias, 'zephyr');
      assert.equal(other?.health, 'failed');
      assert.equal(rows.filter(item => item.scope === 'other').length, 1, 'the workbench server reaches another address');
    });

    it('gives the entries of the files the health Claude Code reported', () => {
      const servers = parseClaudeMcpList(`zephyr-docs: ${URL} (HTTP) - ! Needs authentication`);
      const rows = applyClaudeCheck([row({ state: 'configured' }), row({ scope: 'project' })], TARGET, { checking: false, servers });
      assert.equal(rows[0].health, 'needs-auth');
      assert.equal(rows.filter(item => item.scope === 'other').length, 0, 'the entry of the user file is not shown twice');
      assert.equal(rows.find(item => item.scope === 'account')?.state, 'not-configured', 'the account was asked and holds nothing');
    });

    it('marks the account as being checked, and falls back to the names Claude Code recorded', () => {
      const pending = applyClaudeCheck(files, TARGET, { checking: true });
      assert.deepEqual(pending.find(item => item.scope === 'account')?.checking, true);
      const hinted = applyClaudeCheck(files, TARGET, {
        checking: false, error: 'timed out', recorded: ['claude.ai Gmail', 'claude.ai Zephyr Docs'],
      });
      const account = hinted.find(item => item.scope === 'account');
      assert.equal(account?.unverified, true);
      assert.equal(account?.alias, 'Zephyr Docs');
      assert.equal(account?.check_error, 'timed out');
    });

    it('says the check failed when nothing hints at a connector, and adds nothing when Claude Code was never asked', () => {
      const failed = applyClaudeCheck(files, TARGET, { checking: false, error: 'timed out', recorded: ['claude.ai Gmail'] });
      assert.deepEqual(failed.find(item => item.scope === 'account')?.check_error, 'timed out');
      assert.deepEqual(applyClaudeCheck(files, TARGET, { checking: false, recorded: [] }), files);
    });
  });
});
