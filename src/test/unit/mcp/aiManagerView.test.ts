// The AI Manager's at-a-glance view: what each row sums up to, and that the
// panel renders essentials in its rows and keeps the details folded away,
// apart from the rows that start open.

import { strict as assert } from 'assert';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentRow, AiManagerState, ToolRow } from '../../../webview/aimanager/state';
import {
  confirmRows, displayPath, groupAgents, jobTitle, rowStatus, scopeAction, serverSummary, signInHint, SPINNER, summarizeAgent,
} from '../../../webview/aimanager/view';
import { ConnectionsTab, SkillsView, StatusHeader, ToolsTab, WorkbenchView, ZephyrView } from '../../../webview/aimanager/app';
import { isOpenIn, OpenState, toggledIn } from '../../../webview/aimanager/disclosure';

const row = (over: Partial<AgentRow>): AgentRow => ({
  id: 'cursor', label: 'Cursor', detected: true, scope: 'user', file: '/home/u/.cursor/mcp.json',
  state: 'not-configured', ...over,
});

const tool = (over: Partial<ToolRow>): ToolRow => ({
  name: 'build_app', title: 'Build', category: 'action', read_only: false, destructive: false, disabled: false, asks: [], ...over,
});

function state(over: Partial<AiManagerState> = {}): AiManagerState {
  return {
    view: 'workbench',
    tab: 'connections',
    server: {
      running: true, enabled: 'auto', supported: true, window_id: 'w', port: 50123, toolset: 'core', tool_count: 2,
      tools: [
        tool({ name: 'get_status', title: 'Workbench status', summary: 'Gives the agent an overview of this window.', category: 'query', read_only: true }),
        tool({ name: 'manage_app', title: 'Create or import an application', asks: ['workspace', 'install'] }),
      ],
      workspace_folders: ['/work/zephyrproject'], jobs: [], other_windows: 0,
      confirm_actions: ['workspace', 'install'], session_approvals: 0,
    },
    launcher: { command: '/home/u/.zephyr-workbench/mcp/zw-mcp', args: [], env: {} },
    bridge: { path: '/home/u/.zephyr-workbench/mcp/bridge.cjs', installed: true, home: '/home/u/.zephyr-workbench/mcp' },
    workspace_folder: '/work/zephyrproject',
    agents: [
      row({ id: 'claude-code', label: 'Claude Code', file: '/home/u/.claude.json', state: 'configured', exists: true }),
      row({ id: 'claude-code', label: 'Claude Code', scope: 'project', file: '/work/zephyrproject/.mcp.json', exists: false }),
      row({ id: 'cursor', label: 'Cursor' }),
      row({ id: 'gemini-cli', label: 'Gemini CLI', detected: false, file: '/home/u/.gemini/settings.json' }),
    ],
    zephyr: {
      name: 'zephyr-docs',
      url: 'https://zephyrproject.mcp.kapa.ai',
      agents: [
        row({ id: 'claude-code', label: 'Claude Code', file: '/home/u/.claude.json', state: 'configured', exists: true }),
        row({ id: 'vscode-copilot', label: 'GitHub Copilot in VS Code', file: undefined, via_link: true, detected: false }),
        row({ id: 'cursor', label: 'Cursor', sign_in: 'To sign in, open Cursor Settings, then MCP, and choose Login next to the server.' }),
      ],
    },
    platform: 'linux',
    home: '/home/u',
    ...over,
  };
}

// React separates adjacent text pieces with empty comments; they are not text.
const render = (element: React.ReactElement) => renderToStaticMarkup(element).replace(/<!-- -->/g, '');

/** The markup with every folded-away details body cut out: what the user sees at first. */
function visible(markup: string): string {
  let out = markup;
  for (;;) {
    const start = out.search(/<div id="zw-details-[^"]*" class="zw-disclosure-body" hidden="">/);
    if (start < 0) {
      return out;
    }
    // Up to the </div> that closes this body, counting the divs nested in it.
    const tags = /<div\b|<\/div>/g;
    tags.lastIndex = start;
    let depth = 0;
    let match: RegExpExecArray | null;
    while ((match = tags.exec(out)) !== null) {
      depth += match[0] === '</div>' ? -1 : 1;
      if (depth === 0) {
        break;
      }
    }
    assert.ok(match, 'a details body is never closed');
    out = out.slice(0, start) + out.slice(tags.lastIndex);
  }
}

describe('AI Manager view', () => {
  describe('summarizeAgent', () => {
    it('offers Connect for all projects when nothing is set up', () => {
      const summary = summarizeAgent([row({}), row({ scope: 'project', file: '/p/.cursor/mcp.json' })]);
      assert.equal(summary.text, 'Not connected');
      assert.equal(summary.action?.label, 'Connect');
      assert.deepEqual(summary.action?.message, { command: 'connect', agentId: 'cursor', scope: 'user' });
    });

    it('puts a stale entry first, and offers to repair that scope', () => {
      const summary = summarizeAgent([row({ state: 'configured' }), row({ scope: 'project', state: 'outdated' })]);
      assert.equal(summary.tone, 'warn');
      assert.equal(summary.text, 'Needs updating for this project');
      assert.deepEqual(summary.action?.message, { command: 'connect', agentId: 'cursor', scope: 'project' });
    });

    it('says which scope is connected, and offers nothing to click', () => {
      assert.deepEqual(summarizeAgent([row({ state: 'configured' })]), { tone: 'ok', text: 'Connected for all projects' });
      assert.equal(summarizeAgent([row({ state: 'configured' }), row({ scope: 'project', state: 'configured' })]).text, 'Connected');
    });

    it('sends a hand-edited file to the file', () => {
      const foreign = summarizeAgent([row({ state: 'foreign' })]);
      assert.equal(foreign.text, 'Edited by hand');
      assert.deepEqual(foreign.action?.message, { command: 'openFile', file: '/home/u/.cursor/mcp.json' });
    });

    it('shows Copilot as connected automatically once VS Code got the server, and offers the project file otherwise', () => {
      const copilot = (over: Partial<AgentRow>) => [
        row({ id: 'vscode-copilot', state: 'no-file', file: undefined, ...over }),
        row({ id: 'vscode-copilot', scope: 'project', file: '/p/.vscode/mcp.json' }),
      ];
      const automatic = summarizeAgent(copilot({ automatic: true, source: 'Registered by Zephyr Workbench' }));
      assert.equal(automatic.tone, 'ok');
      assert.equal(automatic.text, 'Connected automatically');
      assert.equal(automatic.action, undefined);
      assert.equal(rowStatus(copilot({ automatic: true })[0]).text, 'Connected');
      // An older VS Code, or the server turned off: only the project file can connect Copilot.
      const manual = summarizeAgent(copilot({}));
      assert.equal(manual.text, 'Not connected');
      assert.deepEqual(manual.action?.message, { command: 'connect', agentId: 'vscode-copilot', scope: 'project' });
      assert.equal(rowStatus(copilot({})[0]).text, 'Not available');
    });

    it('gives each scope line its own action', () => {
      assert.equal(scopeAction(row({ state: 'configured' }))?.label, 'Remove');
      assert.equal(scopeAction(row({ state: 'outdated' }))?.label, 'Repair');
      assert.equal(scopeAction(row({ state: 'not-configured' }))?.label, 'Connect');
      assert.equal(scopeAction(row({ state: 'no-file' })), undefined);
    });
  });

  describe('a remote server, which an agent account can hold too', () => {
    const account = (over: Partial<AgentRow>): AgentRow => row({
      id: 'claude-code', label: 'Claude Code', scope: 'account', file: undefined, source: 'claude.ai connectors', ...over,
    });
    const local = (over: Partial<AgentRow> = {}) => row({ id: 'claude-code', label: 'Claude Code', file: '/home/u/.claude.json', ...over });

    it('says only this machine was read when no account could be asked', () => {
      const summary = summarizeAgent([row({})], 'zephyr');
      assert.equal(summary.text, 'Not set up on this machine');
      assert.match(summary.title ?? '', /configuration files on this machine/);
      assert.deepEqual(summary.action?.message, { command: 'connect', agentId: 'cursor', scope: 'user', server: 'zephyr' });
      // The workbench's own server is local, so its files are the whole answer.
      assert.equal(summarizeAgent([row({})]).text, 'Not connected');
    });

    it('reads an account connector as connected, and offers nothing to click', () => {
      const summary = summarizeAgent([local(), account({ state: 'configured', alias: 'Zephyr Docs', health: 'connected' })], 'zephyr');
      assert.deepEqual(summary, { tone: 'ok', text: 'Connected through your account' });
    });

    it('says "Not connected" once the account was asked and holds nothing', () => {
      assert.equal(summarizeAgent([local(), account({ state: 'not-configured' })], 'zephyr').text, 'Not connected');
      // A failed check proves nothing about the account.
      assert.equal(summarizeAgent([local(), account({ state: 'not-configured', check_error: 'timed out' })], 'zephyr').text,
        'Not set up on this machine');
    });

    it('spins while the account is asked, and holds Connect back until the answer', () => {
      const summary = summarizeAgent([local(), account({ state: 'not-configured', checking: true })], 'zephyr');
      assert.deepEqual(summary, { tone: 'info', text: 'Checking your account', icon: SPINNER });
      // An entry that works already needs no wait.
      assert.equal(summarizeAgent([local({ state: 'configured' }), account({ state: 'not-configured', checking: true })], 'zephyr').text,
        'Connected for all projects');
    });

    it('says what the agent reported: a sign-in to do, or a server that does not answer', () => {
      const signIn = summarizeAgent([local({ state: 'configured', health: 'needs-auth' })], 'zephyr');
      assert.deepEqual(signIn, { tone: 'warn', text: 'Added, needs sign-in' });
      assert.equal(summarizeAgent([local({ state: 'configured', health: 'failed' })], 'zephyr').text, 'Added, does not answer');
      assert.equal(rowStatus(local({ state: 'configured', health: 'needs-auth' })).text, 'Needs sign-in');
    });

    it('marks a connector known only by name as probable', () => {
      const summary = summarizeAgent([local(), account({ state: 'configured', alias: 'Zephyr Docs', unverified: true })], 'zephyr');
      assert.equal(summary.tone, 'info');
      assert.equal(summary.text, 'Probably connected through your account');
      assert.equal(rowStatus(account({ state: 'configured', unverified: true, checking: true })).icon, SPINNER);
    });

    it('says how to sign in only while an entry here may still need it', () => {
      const hint = 'To sign in, run /mcp.';
      assert.equal(signInHint([local({ sign_in: hint })]), undefined, 'nothing to sign in to yet');
      assert.equal(signInHint([local({ sign_in: hint, state: 'configured' })]), hint);
      assert.equal(signInHint([local({ sign_in: hint, state: 'configured', health: 'needs-auth' })]), hint);
      assert.equal(signInHint([local({ sign_in: hint, state: 'configured', health: 'connected' })]), undefined);
      // The account signs in on its own.
      assert.equal(signInHint([local({ sign_in: hint }), account({ state: 'configured', health: 'connected' })]), undefined);
    });

    it('keeps another Connect quiet once the agent reaches the server, or while its account is asked', () => {
      assert.equal(scopeAction(local(), 'zephyr')?.primary, true);
      assert.equal(scopeAction(local(), 'zephyr', true)?.primary, false);
      const markup = render(React.createElement(ZephyrView, {
        state: state({
          view: 'zephyr',
          zephyr: {
            name: 'zephyr-docs', url: 'https://zephyrproject.mcp.kapa.ai',
            agents: [local({ sign_in: 'To sign in, run /mcp.' }), account({ state: 'configured', alias: 'Zephyr Docs', health: 'connected' })],
          },
        }),
      }));
      const claude = markup.slice(markup.indexOf('Claude Code'), markup.indexOf('Manual setup'));
      assert.doesNotMatch(claude, /zw-action primary/);
      assert.doesNotMatch(claude, /To sign in/);
      assert.match(claude, /Your account[\s\S]*Connected[\s\S]*claude\.ai connectors/);
    });

    it('offers Check again on the account line, and never removes what the panel did not write', () => {
      assert.deepEqual(scopeAction(account({ state: 'configured' }))?.message, { command: 'checkAccount' });
      assert.equal(scopeAction(account({ state: 'not-configured', checking: true })), undefined);
      const byHand = row({ state: 'configured', alias: 'zephyr' });
      assert.equal(scopeAction(byHand, 'zephyr'), undefined);
      assert.equal(rowStatus(byHand).text, 'Connected as zephyr');
      assert.equal(scopeAction(row({ scope: 'other', state: 'configured', alias: 'zephyr', file: undefined })), undefined);
    });
  });

  describe('groupAgents', () => {
    it('keeps agents found here, set up, or needing no setup, and tucks the rest away', () => {
      const { installed, notInstalled } = groupAgents([
        row({ id: 'a', detected: true }),
        row({ id: 'b', detected: false, state: 'configured' }),
        row({ id: 'c', detected: false, state: 'no-file', file: undefined }),
        row({ id: 'd', detected: false }),
        row({ id: 'd', detected: false, scope: 'project' }),
      ]);
      assert.deepEqual(installed.map(rows => rows[0].id), ['a', 'b', 'c']);
      assert.deepEqual(notInstalled.map(rows => rows.map(r => r.scope)), [['user', 'project']]);
    });
  });

  describe('displayPath', () => {
    it('shortens project files to the project and user files to ~', () => {
      assert.equal(displayPath('/work/p/.mcp.json', '/home/u', '/work/p'), '.mcp.json');
      assert.equal(displayPath('/home/u/.claude.json', '/home/u', '/work/p'), '~/.claude.json');
      assert.equal(displayPath('/etc/other.json', '/home/u', '/work/p'), '/etc/other.json');
      // A folder whose name only starts like the project is not in it.
      assert.equal(displayPath('/work/p2/.mcp.json', '/home/u', '/work/p'), '/work/p2/.mcp.json');
    });

    it('compares Windows paths without regard to case', () => {
      assert.equal(displayPath('C:\\Users\\U\\.cursor\\mcp.json', 'c:\\users\\u'), '~\\.cursor\\mcp.json');
    });
  });

  describe('serverSummary', () => {
    it('reads each server state in a few words', () => {
      const server = state().server;
      assert.equal(serverSummary(server).text, 'Server running');
      assert.equal(serverSummary({ ...server, running: false }).text, 'Server idle, starts automatically when an agent connects');
      assert.equal(serverSummary({ ...server, running: false, stopped_by_user: true }).text, 'Server stopped');
      assert.equal(serverSummary({ ...server, running: false, enabled: 'off' }).text, 'Server turned off in the settings');
      assert.equal(serverSummary({ ...server, supported: false }).tone, 'error');
    });
  });

  describe('confirmRows', () => {
    it('lists the tools each category covers, and puts the unused ones last', () => {
      const rows = confirmRows([tool({ name: 'manage_app', asks: ['workspace'] }), tool({ name: 'off', asks: ['delete'], disabled: true })]);
      assert.deepEqual(rows[0], { category: 'workspace', label: rows[0].label, tools: ['manage_app'] });
      assert.ok(rows.slice(1).every(entry => entry.tools.length === 0), 'a disabled tool covers nothing');
      assert.deepEqual(rows.map(entry => entry.category).sort(), ['delete', 'hardware', 'install', 'settings', 'workspace']);
    });
  });

  describe('jobTitle', () => {
    it('names the application and configuration, or what a job without one did', () => {
      assert.equal(jobTitle({ job_id: 'j', kind: 'build', status: 'succeeded', app_path: '/w/apps/blinky', config_name: 'primary' }), 'Build blinky (primary)');
      assert.equal(jobTitle({ job_id: 'j', kind: 'install', status: 'succeeded', command: 'install Zephyr SDK 1.0.1 (minimal)' }), 'Install Zephyr SDK 1.0.1 (minimal)');
      // A shell line says nothing to the user, so the kind stands in for it.
      assert.equal(jobTitle({ job_id: 'j', kind: 'west', status: 'failed', command: '. /env.sh && west update' }), 'West');
    });
  });

  describe('open rows', () => {
    it('shows each row as its default until the user clicks it', () => {
      let open: OpenState = new Map();
      assert.equal(isOpenIn(open, 'server', true), true);
      assert.equal(isOpenIn(open, 'agent:cursor', false), false);
      // A row open by default closes on the first click, and opens again on the next.
      open = toggledIn(open, 'server', true);
      assert.equal(isOpenIn(open, 'server', true), false);
      open = toggledIn(open, 'server', true);
      assert.equal(isOpenIn(open, 'server', true), true);
      // Other rows keep their own state.
      open = toggledIn(open, 'agent:cursor', false);
      assert.equal(isOpenIn(open, 'agent:cursor', false), true);
      assert.equal(isOpenIn(open, 'server', true), true);
    });
  });

  describe('rendering', () => {
    it('shows one line per agent with its status and one button, and folds the details away', () => {
      const markup = render(React.createElement(ConnectionsTab, { state: state() }));
      const shown = visible(markup);
      assert.match(shown, /Claude Code/);
      assert.match(shown, /Connected for all projects/);
      assert.match(shown, /Cursor[\s\S]*Not connected[\s\S]*>Connect</);
      // Paths, per-scope buttons and notes wait behind the chevron.
      assert.doesNotMatch(shown, /\.claude\.json|Open file|Remove/);
      assert.match(markup, /~\/\.claude\.json/);
      assert.match(markup, /aria-expanded="false"/);
      // Only the Installed group starts open; every agent row starts closed.
      assert.equal((markup.match(/aria-expanded="true"/g) ?? []).length, 1);
      assert.match(shown, /aria-expanded="true"[^>]*>[\s\S]*?Installed[\s\S]*?zw-count">2</);
      // An agent not found here goes in its own group, folded.
      assert.match(shown, /Not installed/);
      assert.doesNotMatch(shown, /Gemini CLI/);
    });

    it('offers Open file only for a file that is on disk', () => {
      const markup = render(React.createElement(ConnectionsTab, { state: state() }));
      const claude = markup.slice(markup.indexOf('Claude Code'), markup.indexOf('Cursor'));
      assert.equal((claude.match(/Open file/g) ?? []).length, 1, 'the missing project .mcp.json has none');
    });

    it('opens the server card by default, with its address and controls', () => {
      const markup = render(React.createElement(StatusHeader, { state: state() }));
      const shown = visible(markup);
      assert.match(shown, /aria-expanded="true"/);
      assert.match(shown, /Server running/);
      assert.match(shown, /2 tools, core toolset/);
      assert.match(shown, />Test connection</);
      assert.match(shown, /127\.0\.0\.1:50123/);
      // The open folders are the user's own; listing them only grows with the project count.
      assert.doesNotMatch(shown, /This window|\/work\/zephyrproject/);
      assert.match(shown, />Restart<[\s\S]*>Show activity log</);
    });

    it('shows a connection test running, then what it found, with the report one click away', () => {
      const base = state();
      const header = (server: Partial<AiManagerState['server']>) =>
        visible(render(React.createElement(StatusHeader, { state: { ...base, server: { ...base.server, ...server } } })));
      const running = header({ testing: true });
      assert.match(running, /disabled=""[^>]*>Testing\.\.\.</);
      assert.match(running, /codicon-loading/);
      const passed = header({ last_test: { at: '2026-09-25T10:00:00Z', checks: [{ name: 'Bridge', ok: true, detail: 'fine' }] } });
      assert.match(passed, /Connection test passed/);
      assert.match(passed, />Show report</);
      assert.doesNotMatch(passed, /fine/, 'the details of a passed check stay in the report');
      const failed = header({
        last_test: {
          at: '2026-09-25T10:00:00Z',
          checks: [
            { name: 'Bridge', ok: true, detail: 'fine' },
            { name: 'Agent path', ok: false, detail: 'The bridge did not answer.', fix: 'Reload the VS Code window.' },
          ],
        },
      });
      assert.match(failed, /Connection test found a problem/);
      assert.match(failed, /Agent path:[\s\S]*The bridge did not answer\.[\s\S]*Fix: Reload the VS Code window\./);
    });

    it('puts Start first when the user stopped the server, and says when an answer is waited for', () => {
      const base = state();
      const shown = visible(render(React.createElement(StatusHeader, {
        state: { ...base, server: { ...base.server, running: false, stopped_by_user: true, pending_confirmation: 'manage_app' } },
      })));
      assert.match(shown, /zw-action primary"[^>]*>Start</);
      assert.match(shown, /waiting for your answer[\s\S]*manage_app/);
    });

    it('explains each tool in a tooltip beside its name, in place of its title', () => {
      const shown = visible(render(React.createElement(ToolsTab, { state: state({ tab: 'tools' }) })));
      const row = shown.slice(shown.indexOf('>get_status<'), shown.indexOf('>manage_app<'));
      assert.match(row, /<button type="button" class="zw-tip-icon" aria-label="What get_status does" aria-describedby="([^"]+)"[\s\S]*<span id="\1" role="tooltip" class="zw-tip-text">Gives the agent an overview of this window\.</);
      assert.doesNotMatch(shown, /Workbench status/);
      // The tooltip is outside the label, so pointing at it never ticks the box.
      assert.match(row, /<\/label>[\s\S]*zw-tip-icon/);
    });

    it('shows the toolset, the Ask me first choices and, open by default, the tool list', () => {
      const shown = visible(render(React.createElement(ToolsTab, { state: state({ tab: 'tools' }) })));
      assert.match(shown, /Toolset/);
      assert.match(shown, /2 of 2 tools are on/);
      assert.match(shown, /Create, import or update applications and west workspaces/);
      assert.match(shown, /Tools agents can call/);
      assert.match(shown, /get_status[\s\S]*manage_app/);
    });

    it('leads the Zephyr Project MCP page with what it answers and short facts, then the agents', () => {
      const shown = visible(render(React.createElement(ZephyrView, { state: state({ view: 'zephyr' }) })));
      assert.match(shown, /Answers from Zephyr&#x27;s docs, code and GitHub, with sources\.[\s\S]*>Docs</);
      // The address is only in the Manual setup snippets, folded.
      assert.doesNotMatch(shown, /zephyrproject\.mcp\.kapa\.ai|>Copy</);
      assert.match(shown, /Official Zephyr Project MCP[\s\S]*Questions leave this machine[\s\S]*Sign in on first use/);
      assert.match(shown, /<button type="button" class="zw-link"[^>]*>Docs</);
      // Its own rows, whose buttons act on the Zephyr Project's server.
      assert.match(shown, /Claude Code[\s\S]*Connected for all projects/);
      assert.match(shown, /GitHub Copilot in VS Code[\s\S]*>Add to VS Code</);
      assert.match(shown, /Cursor[\s\S]*Not set up on this machine/);
      // The snippets, the data sources and the fine print are folded.
      assert.match(shown, /Manual setup[\s\S]*Data sources[\s\S]*About the answers/);
      assert.doesNotMatch(shown, /<table/);
      assert.doesNotMatch(shown, /&quot;url&quot;|mcp-remote|No personally identifiable information/);
    });

    it('keeps the Zephyr Project MCP page short: no paragraph runs past a line or two', () => {
      const markup = render(React.createElement(ZephyrView, { state: state({ view: 'zephyr' }) }));
      const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const paragraphs = [...visible(markup).matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(match => text(match[1]));
      for (const paragraph of paragraphs) {
        assert.ok(paragraph.length <= 120, `too long for a glance: ${paragraph}`);
      }
    });

    it('lists both skill collections in a few words, with their authors', () => {
      const shown = visible(render(React.createElement(SkillsView)));
      const text = shown.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      assert.match(text, /Zephyr Agent Skills[\s\S]*by beriberikix[\s\S]*Skills for building with Zephyr/);
      assert.match(text, /Zephyr AI Skills[\s\S]*by Beningo Embedded Group[\s\S]*Five skills for board support work/);
      assert.doesNotMatch(shown, /zw-chip/, 'no tags on the cards');
      assert.match(text, /Written by others\. Read a skill before you rely on it\./);
      // Open leads to each page; the address is not spelled out on the page.
      assert.doesNotMatch(text, /github\.com|beningo\.com/);
      assert.match(shown, />Open</);
      // Install commands wait behind their chevron.
      assert.doesNotMatch(shown, /claude plugin marketplace add/);
    });

    it('groups the Connections tab under Agents and Server, with only the installed agents open', () => {
      const base = state();
      const markup = render(React.createElement(ConnectionsTab, {
        state: { ...base, server: { ...base.server, jobs: [{ job_id: 'w.build-1', kind: 'build', status: 'failed', app_path: '/w/blinky', config_name: 'primary' }] } },
      }));
      const shown = visible(markup);
      assert.match(shown, />Agents<[\s\S]*Installed[\s\S]*Cursor[\s\S]*Not installed[\s\S]*Manual setup[\s\S]*>Server<[\s\S]*Recent jobs[\s\S]*1[\s\S]*About this server/);
      assert.doesNotMatch(shown, /Build blinky|zw-mcp|bridge\.cjs|loopback/);
      assert.match(markup, /zw-mcp[\s\S]*Build blinky \(primary\)[\s\S]*loopback/);
      assert.match(markup, /own local server: it runs inside VS Code on this machine, not on any\s+external server/);
    });

    it('has no Server tab any more', () => {
      const shown = render(React.createElement(WorkbenchView, { state: state() }));
      const tabs = [...shown.matchAll(/role="tab"[^>]*>([^<]+)</g)].map(match => match[1]);
      assert.deepEqual(tabs, ['Connections', 'Tools and safety']);
    });
  });
});
