// AI Manager UI. Three pages: the Zephyr Workbench MCP server (its agents, the
// server itself and the tools agents may call), the Zephyr Project's own MCP
// server, and third-party agent skills. Each shows the essentials in one line
// per item; paths, per-scope actions and explanations open on demand.

import React, { useEffect, useState } from 'react';
import {
  EXTERNAL_LINKS, ExternalLinkId, THIRD_PARTY_SKILLS, ZEPHYR_MCP_DATA_SOURCES,
} from '../../mcp/core/externalResources';
import { Disclosure, DisclosureProvider } from './disclosure';
import { AgentRow, AiManagerState, AiManagerView, ConnectionTest, JobRow, post, ToolRow } from './state';
import {
  confirmRows, displayPath, formatTime, groupAgents, JOB_TONE, jobTitle, RowAction, rowStatus, scopeAction, scopeLabel,
  ServerKey, serverSummary, signInHint, SPINNER, summarizeAgent, Tone, TOOL_GROUP_LABEL, toolKind, TOOLSETS,
  toolsSummary, zephyrClientConfig,
} from './view';

const TONE_ICON: Record<Tone, string> = {
  ok: 'pass-filled',
  warn: 'warning',
  off: 'circle-large-outline',
  info: 'info',
  error: 'error',
};

function Status({ tone, text, icon, title }: { tone: Tone; text: string; icon?: string; title?: string }) {
  return (
    <span className={`zw-status-text ${tone}`} title={title}>
      <span className={`codicon codicon-${icon ?? TONE_ICON[tone]}`} aria-hidden="true" />
      <span className="zw-status-label">{text}</span>
    </span>
  );
}

function ActionButton({ action }: { action: RowAction }) {
  return (
    <button
      type="button"
      className={`zw-action${action.primary ? ' primary' : ''}`}
      title={action.title}
      disabled={action.disabled}
      onClick={() => post(action.message)}
    >
      {action.label}
    </button>
  );
}

export function StatusHeader({ state }: { state: AiManagerState }) {
  const { server } = state;
  const summary = serverSummary(server);
  const canStart = server.supported && !server.running && server.enabled !== 'off';
  // Stopped from VS Code, the server waits for the user: Start is the one thing to do.
  const startFirst = canStart && server.stopped_by_user === true;
  return (
    <>
      <div className="zw-card">
        <Disclosure
          id="server"
          defaultOpen
          summary={(
            <span className="zw-summary">
              <Status tone={summary.tone} text={summary.text} />
              {server.supported && <span className="zw-meta">{toolsSummary(server)}</span>}
            </span>
          )}
          actions={server.supported ? (
            <>
              {startFirst && <ActionButton action={{ label: 'Start', primary: true, message: { command: 'start' } }} />}
              <ActionButton action={{
                label: server.testing ? 'Testing...' : 'Test connection',
                primary: !startFirst,
                disabled: server.testing,
                title: 'Start the server and reach it the way an agent does',
                message: { command: 'testConnection' },
              }}
              />
            </>
          ) : undefined}
        >
          <dl className="zw-facts">
            {server.running && server.port !== undefined && (
              <>
                <dt>Address</dt>
                <dd className="zw-mono">127.0.0.1:{server.port}</dd>
              </>
            )}
            <dt>This window</dt>
            <dd>{server.workspace_folders.length > 0 ? server.workspace_folders.join(', ') : 'No folder open'}</dd>
            {server.other_windows > 0 && (
              <>
                <dt>Other windows</dt>
                <dd>
                  {server.other_windows === 1
                    ? '1 other VS Code window serves agents too. Each call goes to the window that has its project open.'
                    : `${server.other_windows} other VS Code windows serve agents too. Each call goes to the window that has its project open.`}
                </dd>
              </>
            )}
          </dl>
          <div className="zw-actions">
            {server.running && <ActionButton action={{ label: 'Restart', message: { command: 'restart' } }} />}
            {server.running && <ActionButton action={{ label: 'Stop', message: { command: 'stop' } }} />}
            {canStart && !startFirst && <ActionButton action={{ label: 'Start', message: { command: 'start' } }} />}
            <ActionButton action={{ label: 'Show activity log', message: { command: 'showLog' } }} />
          </div>
        </Disclosure>
        {server.supported && <TestResult test={server.last_test} testing={server.testing} />}
      </div>
      {!server.supported && server.unsupported_reason && (
        <div className="zw-warning error">{server.unsupported_reason}</div>
      )}
      {server.pending_confirmation && (
        <div className="zw-warning">
          An agent is waiting for your answer in a VS Code dialog ({server.pending_confirmation}).
        </div>
      )}
    </>
  );
}

/**
 * The last Test connection, under the server line: a word when it passed, each
 * problem with its fix when not. The full report is in the MCP output channel.
 */
function TestResult({ test, testing }: { test?: ConnectionTest; testing?: boolean }) {
  if (testing) {
    return (
      <div className="zw-test">
        <Status tone="info" icon={SPINNER} text="Testing the connection the way an agent makes it" />
      </div>
    );
  }
  if (!test) {
    return null;
  }
  const problems = test.checks.filter(check => !check.ok);
  const time = formatTime(test.at);
  return (
    <div className="zw-test">
      <div className="zw-test-head">
        {problems.length === 0
          ? <Status tone="ok" text={`Connection test passed${time ? ` at ${time}` : ''}`} />
          : <Status tone="error" text={problems.length === 1 ? 'Connection test found a problem' : `Connection test found ${problems.length} problems`} />}
        <ActionButton action={{
          label: 'Show report', title: 'Open the full report in the Zephyr Workbench: MCP output', message: { command: 'showLog' },
        }}
        />
      </div>
      {problems.map(problem => (
        <div key={problem.name} className="zw-problem">
          <div><span className="zw-section-name">{problem.name}:</span> {problem.detail}</div>
          {problem.fix && <div className="zw-meta">Fix: {problem.fix}</div>}
        </div>
      ))}
    </div>
  );
}

function AgentItem({ rows, state, server }: { rows: AgentRow[]; state: AiManagerState; server?: ServerKey }) {
  const first = rows[0];
  const summary = summarizeAgent(rows, server);
  // A row can carry its own note, such as why its file could not be read.
  const notes = [...new Set([...rows.map(row => row.note), signInHint(rows)].filter((note): note is string => !!note))];
  const quiet = summary.tone === 'ok' || rows.some(row => row.checking);
  return (
    <Disclosure
      id={`agent:${server ?? 'workbench'}:${first.id}`}
      className="zw-item"
      summary={(
        <span className="zw-summary">
          <span className="zw-name">{first.label}</span>
          <Status tone={summary.tone} text={summary.text} icon={summary.icon} title={summary.title} />
        </span>
      )}
      actions={summary.action ? <ActionButton action={summary.action} /> : undefined}
      actionsWhenClosed
    >
      <div className="zw-scopes">
        {rows.map(row => {
          const action = scopeAction(row, server, quiet);
          const status = rowStatus(row);
          return (
            <div key={`${row.scope}:${row.alias ?? ''}`} className="zw-scope">
              <span className="zw-scope-label">{scopeLabel(row.scope)}</span>
              <Status tone={status.tone} text={status.text} icon={status.icon} title={status.title} />
              <span className={row.file ? 'zw-mono zw-path' : 'zw-path'} title={row.file}>
                {row.file ? displayPath(row.file, state.home, state.workspace_folder) : row.source ?? (row.via_link ? 'VS Code settings' : '')}
              </span>
              <span className="zw-actions">
                {row.file && row.exists !== false && (
                  <ActionButton action={{ label: 'Open file', message: { command: 'openFile', file: row.file } }} />
                )}
                {action && <ActionButton action={action} />}
              </span>
            </div>
          );
        })}
      </div>
      {notes.map(note => <p key={note} className="zw-note">{note}</p>)}
    </Disclosure>
  );
}

/** The agents found here, each on one line, and the others folded in a group of their own. */
function AgentList({ agents, state, server }: { agents: AgentRow[]; state: AiManagerState; server?: ServerKey }) {
  const { main, other } = groupAgents(agents);
  return (
    <>
      <div className="zw-list">
        {main.map(rows => <AgentItem key={rows[0].id} rows={rows} state={state} server={server} />)}
      </div>
      {other.length > 0 && (
        <Disclosure
          id={`agents:${server ?? 'workbench'}:other`}
          className="zw-section"
          summary={<span className="zw-section-name">Not found on this machine <span className="zw-count">{other.length}</span></span>}
        >
          <p className="zw-note">
            These agents are not in their usual places. You can still connect one, for example before you install it.
          </p>
          <div className="zw-list">
            {other.map(rows => <AgentItem key={rows[0].id} rows={rows} state={state} server={server} />)}
          </div>
        </Disclosure>
      )}
    </>
  );
}

export function AgentsTab({ state }: { state: AiManagerState }) {
  return (
    <div>
      <p className="zw-note zw-intro">
        Connecting writes one entry into the agent&apos;s own configuration, after showing you the change.
        Restart the agent session afterwards.
      </p>
      <AgentList agents={state.agents} state={state} />
    </div>
  );
}

function LinkButton({ link, label, primary }: { link: ExternalLinkId; label: string; primary?: boolean }) {
  return (
    <ActionButton action={{ label, primary, title: EXTERNAL_LINKS[link], message: { command: 'openLink', link } }} />
  );
}

/** A block of text to copy, such as a configuration snippet or commands. */
function CopyBlock({ text, label }: { text: string; label: string }) {
  return (
    <div className="zw-copy">
      <pre className="zw-code zw-mono">{text}</pre>
      <ActionButton action={{ label, message: { command: 'copy', text } }} />
    </div>
  );
}

/** A short fact with an icon. */
function Chip({ icon, text }: { icon?: string; text: string }) {
  return (
    <span className="zw-badge zw-chip">
      {icon && <span className={`codicon codicon-${icon}`} aria-hidden="true" />}
      {text}
    </span>
  );
}

export function ZephyrView({ state }: { state: AiManagerState }) {
  const { zephyr } = state;
  return (
    <div>
      <div className="zw-card zw-panel">
        <p className="zw-lead">Answers from Zephyr&apos;s docs, code and GitHub, with sources.</p>
        <div className="zw-endpoint">
          <span className="zw-mono">{zephyr.url}</span>
          <span className="zw-actions">
            <ActionButton action={{ label: 'Copy', title: 'Copy the address', message: { command: 'copy', text: zephyr.url } }} />
            <LinkButton link="zephyr-mcp-docs" label="Docs" />
          </span>
        </div>
        <div className="zw-chips">
          <Chip icon="cloud" text="Hosted by Kapa.ai" />
          <Chip icon="cloud-upload" text="Questions leave this machine" />
          <Chip icon="key" text="Sign in on first use" />
        </div>
      </div>

      <div className="zw-section-name zw-heading">Agents</div>
      <AgentList agents={zephyr.agents} state={state} server="zephyr" />

      <Disclosure id="zephyr:generic" className="zw-section" summary={<span className="zw-section-name">Other MCP clients</span>}>
        <p className="zw-note">Streamable HTTP:</p>
        <CopyBlock text={zephyrClientConfig(zephyr, 'url')} label="Copy" />
        <p className="zw-note">Through mcp-remote, for a client that only starts local servers (needs Node.js):</p>
        <CopyBlock text={zephyrClientConfig(zephyr, 'mcp-remote')} label="Copy" />
        <div className="zw-actions"><LinkButton link="mcp-remote" label="About mcp-remote" /></div>
      </Disclosure>

      <Disclosure id="zephyr:sources" className="zw-section" defaultOpen summary={<span className="zw-section-name">Data sources</span>}>
        <table className="zw-table">
          <thead>
            <tr><th>Source</th><th>Details</th><th>Refresh</th></tr>
          </thead>
          <tbody>
            {ZEPHYR_MCP_DATA_SOURCES.map(row => (
              <tr key={row.source}>
                <td>{row.source}</td>
                <td>
                  {row.link ? (
                    <button type="button" className="zw-link" onClick={() => post({ command: 'openLink', link: row.link })}>
                      {row.details}
                    </button>
                  ) : row.details}
                </td>
                <td className="zw-nowrap">{row.refresh}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Disclosure>

      <Disclosure id="zephyr:about" className="zw-section" summary={<span className="zw-section-name">About the answers</span>}>
        <ul className="zw-bullets">
          <li>Answers are AI-generated and can be wrong: check what matters in the docs.</li>
          <li>Questions may be collected anonymously to improve the docs. No personally identifiable information is collected.</li>
        </ul>
        <div className="zw-actions"><LinkButton link="zephyr-mcp-wiki" label="Kapa.ai on the Zephyr wiki" /></div>
      </Disclosure>
    </div>
  );
}

export function SkillsView() {
  return (
    <div>
      <p className="zw-note zw-intro">Written by others. Read a skill before you rely on it.</p>
      {THIRD_PARTY_SKILLS.map(skill => (
        <div key={skill.link} className="zw-card zw-panel zw-skill">
          <div className="zw-skill-head">
            <span className="zw-name">{skill.name}</span>
            <LinkButton link={skill.link} label="Open" primary />
          </div>
          <div className="zw-meta">by {skill.author}</div>
          <p className="zw-lead zw-spaced">{skill.summary}</p>
          {skill.install && (
            <Disclosure id={`skill:${skill.link}`} summary={<span className="zw-section-name">How to install</span>}>
              {skill.install.map(method => (
                <div key={method.label}>
                  <p className="zw-note">{method.label}:</p>
                  <CopyBlock text={method.commands.join('\n')} label="Copy" />
                </div>
              ))}
            </Disclosure>
          )}
        </div>
      ))}
    </div>
  );
}

function JobItem({ job }: { job: JobRow }) {
  const running = job.status === 'running' || job.status === 'queued';
  return (
    <div className="zw-job" title={[job.job_id, job.command].filter(Boolean).join('\n')}>
      <Status
        tone={JOB_TONE[job.status] ?? 'off'}
        icon={running ? 'loading codicon-modifier-spin' : undefined}
        text={jobTitle(job)}
      />
      <span className="zw-meta">{job.status}</span>
      <span className="zw-meta">{formatTime(job.started_at)}</span>
    </div>
  );
}

export function ServersTab({ state }: { state: AiManagerState }) {
  const { launcher, bridge, server } = state;
  return (
    <div>
      <div className="zw-section-name zw-heading">Recent jobs</div>
      {server.jobs.length === 0
        ? <p className="zw-note">No agent job has run in this VS Code window yet.</p>
        : <div className="zw-list">{server.jobs.map(job => <JobItem key={job.job_id} job={job} />)}</div>}
      <Disclosure id="server:setup" className="zw-section" summary={<span className="zw-section-name">Manual setup</span>}>
        <p className="zw-note">
          An agent the Agents tab does not list can use this command as a local (stdio) MCP server.
        </p>
        <div className="zw-code zw-mono">{[launcher.command, ...launcher.args].join(' ')}</div>
        {Object.keys(launcher.env).length > 0 && (
          <div className="zw-code zw-mono">{Object.entries(launcher.env).map(([k, v]) => `${k}=${v}`).join(' ')}</div>
        )}
        <div className="zw-actions">
          <ActionButton action={{ label: 'Copy configuration for an agent', message: { command: 'copyConfig' } }} />
        </div>
        <dl className="zw-facts">
          <dt>Bridge</dt>
          <dd className="zw-mono">{bridge.path}{bridge.installed ? '' : ' (not installed yet)'}</dd>
          {bridge.launcher_path && (
            <>
              <dt>Launcher</dt>
              <dd className="zw-mono">{bridge.launcher_path}</dd>
            </>
          )}
        </dl>
      </Disclosure>
      <Disclosure id="server:about" className="zw-section" summary={<span className="zw-section-name">About this server</span>}>
        <p className="zw-note">
          This is the workbench&apos;s own server. It listens on the loopback interface only, on a port chosen
          at random, and every request needs a token that is regenerated each time VS Code starts. Neither the
          port nor the token appears in any configuration file.
        </p>
        <p className="zw-note">
          Documentation servers answer the questions this server cannot, such as how a Zephyr subsystem is
          meant to be used. They are not configured here yet. When they are, any entry that sends your
          questions off this machine will say so on its own row.
        </p>
      </Disclosure>
    </div>
  );
}

function ToolItem({ tool, asksFirst }: { tool: ToolRow; asksFirst: boolean }) {
  return (
    <label className="zw-tool">
      <input type="checkbox" checked={!tool.disabled} onChange={() => post({ command: 'toggleTool', tool: tool.name })} />
      <span className="zw-tool-name">
        <span className="zw-mono">{tool.name}</span> <span className="zw-meta">{tool.title}</span>
      </span>
      <span className="zw-badges">
        {asksFirst && <span className="zw-badge warn">asks first</span>}
        <span className="zw-badge">{toolKind(tool)}</span>
      </span>
    </label>
  );
}

export function ToolsTab({ state }: { state: AiManagerState }) {
  const { server } = state;
  const readOnly = server.toolset === 'read-only';
  const enabled = server.tools.filter(tool => !tool.disabled).length;
  const description = TOOLSETS.find(([name]) => name === server.toolset)?.[1];
  const confirms = confirmRows(server.tools);
  const hardwareAsked = confirms.some(row => row.category === 'hardware' && row.tools.length > 0);
  const groups = new Map<string, ToolRow[]>();
  for (const tool of server.tools) {
    groups.set(tool.category, [...(groups.get(tool.category) ?? []), tool]);
  }
  return (
    <div>
      <div className="zw-section-name zw-heading">Toolset</div>
      <div className="zw-segmented" role="group" aria-label="Toolset">
        {TOOLSETS.map(([name]) => (
          <button
            key={name}
            type="button"
            className={server.toolset === name ? 'active' : ''}
            aria-pressed={server.toolset === name}
            onClick={() => post({ command: 'setToolset', toolset: name })}
          >
            {name}
          </button>
        ))}
      </div>
      <p className="zw-note">
        {description} {enabled} of {server.tools.length} tools are on.
      </p>

      <div className="zw-section-name zw-heading">Ask me first</div>
      <p className="zw-note">
        {readOnly
          ? 'No tool in the read-only toolset changes anything, so nothing asks.'
          : 'Before these actions, VS Code shows a dialog naming the agent and what it wants to do. Only you can answer it.'}
      </p>
      <div className="zw-checks">
        {confirms.map(row => (
          <label
            key={row.category}
            className={`zw-check${row.tools.length === 0 ? ' unused' : ''}`}
            title={row.tools.length > 0 ? `Asked by ${row.tools.join(', ')}` : undefined}
          >
            <input
              type="checkbox"
              disabled={readOnly}
              checked={server.confirm_actions.includes(row.category)}
              onChange={() => post({ command: 'toggleConfirm', category: row.category })}
            />
            <span>
              {row.label}
              {row.tools.length === 0 && <span className="zw-meta"> (no enabled tool does this yet)</span>}
            </span>
          </label>
        ))}
      </div>
      {!readOnly && hardwareAsked && !server.confirm_actions.includes('hardware') && (
        <p className="zw-note">Agents can send text to a connected board's serial port without asking.</p>
      )}
      {server.session_approvals > 0 && (
        <div className="zw-actions zw-spaced">
          <ActionButton action={{
            label: `Forget session approvals (${server.session_approvals})`,
            message: { command: 'forgetApprovals' },
          }}
          />
        </div>
      )}

      <Disclosure
        id="tools:list"
        className="zw-section"
        defaultOpen
        summary={(
          <span className="zw-section-name">
            Tools agents can call <span className="zw-count">{enabled} of {server.tools.length}</span>
          </span>
        )}
      >
        <p className="zw-note">
          Agents see only the tools that are on. The server applies this itself, because several agents cannot
          filter tools on their own. Fewer tools leave room for your other extensions: a VS Code chat request
          allows 128 tools in all, and some other clients stop near 40.
        </p>
        {[...groups.entries()].map(([category, tools]) => (
          <div key={category} className="zw-tool-group">
            <div className="zw-tool-group-name">{TOOL_GROUP_LABEL[category] ?? category}</div>
            {tools.map(tool => (
              <ToolItem
                key={tool.name}
                tool={tool}
                asksFirst={tool.asks.some(category => server.confirm_actions.includes(category))}
              />
            ))}
          </div>
        ))}
      </Disclosure>
    </div>
  );
}

const VIEWS: [AiManagerView, string][] = [
  ['workbench', 'Zephyr Workbench MCP'],
  ['zephyr', 'Zephyr Project MCP'],
  ['skills', 'Third-party skills'],
];

const TABS: [AiManagerState['tab'], string][] = [
  ['agents', 'Agents'],
  ['servers', 'Server'],
  ['tools', 'Tools and safety'],
];

/** The Zephyr Workbench MCP page: the server card, then its three tabs. */
export function WorkbenchView({ state }: { state: AiManagerState }) {
  return (
    <>
      <StatusHeader state={state} />
      <div className="zw-tabs zw-subtabs" role="tablist" aria-label="Zephyr Workbench MCP">
        {TABS.map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={state.tab === tab}
            className={state.tab === tab ? 'active' : ''}
            onClick={() => post({ command: 'setTab', tab })}
          >
            {label}
          </button>
        ))}
      </div>
      {state.tab === 'agents' && <AgentsTab state={state} />}
      {state.tab === 'servers' && <ServersTab state={state} />}
      {state.tab === 'tools' && <ToolsTab state={state} />}
    </>
  );
}

export function App() {
  const [state, setState] = useState<AiManagerState | undefined>(undefined);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const message = event.data as { command?: string; state?: AiManagerState };
      if (message?.command === 'state' && message.state) {
        setState(message.state);
      }
    };
    window.addEventListener('message', listener);
    post({ command: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, []);

  if (!state) {
    return <div className="zw-ai"><p>Loading the AI Manager...</p></div>;
  }

  return (
    <DisclosureProvider>
      <div className="zw-ai">
        <h1>AI Manager</h1>
        <p className="zw-subtitle">
          Set up AI coding agents for Zephyr. This configures your editor and agents, not firmware.
        </p>
        <div className="zw-tabs zw-views" role="tablist" aria-label="AI Manager">
          {VIEWS.map(([view, label]) => (
            <button
              key={view}
              type="button"
              role="tab"
              aria-selected={state.view === view}
              className={state.view === view ? 'active' : ''}
              onClick={() => post({ command: 'setView', view })}
            >
              {label}
            </button>
          ))}
        </div>
        {state.view === 'workbench' && <WorkbenchView state={state} />}
        {state.view === 'zephyr' && <ZephyrView state={state} />}
        {state.view === 'skills' && <SkillsView />}
      </div>
    </DisclosureProvider>
  );
}
