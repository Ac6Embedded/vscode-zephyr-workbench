// AI Manager: connect AI coding agents to Zephyr Workbench and to the Zephyr
// Project's own MCP server, and point to third-party agent skills.
//
// The panel is a view over the same settings and agent config files the palette
// commands write, never a second source of truth, so the two can never
// disagree. It follows the shape of the other manager panels (West Manager,
// Kconfig Manager) so it behaves the way users already expect.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getNonce } from '../utilities/getNonce';
import { getUri } from '../utilities/getUri';
import {
  AGENTS, AgentScope, applyPlan, inspectAgent, inspectEntry, planEntryWrite, remoteTarget,
  removeServerEntry, ServerTarget, workbenchTarget, WritePlan,
} from '../mcp/agents';
import { claudeAccountConnectorNames, ClaudeServerStatus, findClaudeCli, listClaudeServers } from '../mcp/agents/claudeCli';
import { applyClaudeCheck, ClaudeCheck } from '../mcp/agents/claudeReport';
import { parseJsonc, readJsonPath } from '../mcp/agents/jsonMerge';
import { EXTERNAL_LINKS, isExternalLinkId, ZEPHYR_PROJECT_MCP } from '../mcp/core/externalResources';
import { launcherSpec } from '../mcp/agents/launcher';
import { installBridge } from '../mcp/host/bridgeInstaller';
import { getMcpPaths } from '../mcp/core/paths';
import { McpController, readSettings } from '../mcp/host/mcpController';
import { TOOL_CATALOG } from '../mcp/core/catalog';
import { PERMISSION_PRESETS, PermissionPreset, permissionOf, TOOL_PERMISSIONS, ToolPermission } from '../mcp/core/toolSpec';

export type AiManagerTab = 'connections' | 'permissions';
export type AiManagerView = 'workbench' | 'zephyr' | 'skills';

/** Which server a Connect or Remove is for. */
type ServerKind = 'workbench' | 'zephyr';

interface InboundMessage {
  command: string;
  agentId?: string;
  scope?: AgentScope;
  /** 'zephyr' for the Zephyr Project's server; the workbench's own otherwise. */
  server?: string;
  tool?: string;
  preset?: string;
  permission?: string;
  file?: string;
  tab?: AiManagerTab;
  view?: string;
  link?: string;
  text?: string;
}

const VIEWS: readonly AiManagerView[] = ['workbench', 'zephyr', 'skills'];
const TABS: readonly AiManagerTab[] = ['connections', 'permissions'];

/** The Zephyr Project's server, the same entry for every user. */
const ZEPHYR_TARGET = remoteTarget(ZEPHYR_PROJECT_MCP.name, ZEPHYR_PROJECT_MCP.url);

/** How long Claude Code's answer is reused: asking takes seconds, since it checks every server. */
const CLAUDE_CHECK_TTL_MS = 5 * 60_000;

/** Claude Code's last answer about the servers it reaches from one folder. */
interface ClaudeCheckState {
  folder?: string;
  at?: number;
  servers?: ClaudeServerStatus[];
  error?: string;
  running?: Promise<void>;
  /** Asked again while a check ran, whose answer may predate a change. */
  again?: boolean;
}

export class AiManagerPanel {
  public static currentPanel: AiManagerPanel | undefined;
  /** Kept when the panel closes, so reopening it does not ask Claude Code again. */
  private static claudeCheck: ClaudeCheckState = {};
  private readonly disposables: vscode.Disposable[] = [];

  private view: AiManagerView = 'workbench';

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly controller: () => McpController | undefined,
    private tab: AiManagerTab,
    /** The extension's global storage, in the current VS Code profile's folder. */
    private readonly globalStorageUri?: vscode.Uri,
  ) {
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.html = this.render(this.panel.webview);
    this.panel.webview.onDidReceiveMessage(
      (message: InboundMessage) => void this.handle(message), null, this.disposables,
    );
    // A dialog waiting for the user, or an approval given in it, shows here as it happens.
    const active = this.controller();
    if (active) {
      this.disposables.push(active.onDidChangeState(() => void this.post()));
    }
  }

  static show(
    extensionUri: vscode.Uri, controller: () => McpController | undefined, tab: AiManagerTab = 'connections',
    globalStorageUri?: vscode.Uri,
  ): void {
    if (AiManagerPanel.currentPanel) {
      AiManagerPanel.currentPanel.view = 'workbench';
      AiManagerPanel.currentPanel.tab = tab;
      AiManagerPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      void AiManagerPanel.currentPanel.post();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'zephyr-workbench.ai-manager.panel',
      'AI Manager',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out')],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'res', 'icons', 'ai_manager_icon.svg');
    AiManagerPanel.currentPanel = new AiManagerPanel(panel, extensionUri, controller, tab, globalStorageUri);
  }

  /** Where the bridge files live, honouring the homeDir setting. */
  private paths() {
    return getMcpPaths(readSettings().homeDir || undefined);
  }

  /** Install or refresh the bridge and its launcher. Idempotent. */
  installBridge(): { ok: boolean; problem?: string } {
    return installBridge(
      this.paths(), vscode.Uri.joinPath(this.extensionUri, 'out').fsPath, this.version(), process.execPath);
  }

  private version(): string {
    return vscode.extensions.getExtension('Ac6.zephyr-workbench')?.packageJSON?.version ?? '0.0.0';
  }

  private launcher() {
    return launcherSpec(this.paths(), process.execPath, 'auto');
  }

  private planOptions() {
    return {
      claudeExtensionPath: vscode.extensions.getExtension('anthropic.claude-code')?.extensionPath,
      backupDir: this.paths().backupsDir,
    };
  }

  private workspaceFolder(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private async state() {
    const controller = this.controller();
    const launcher = this.launcher();
    const folder = this.workspaceFolder();
    const settings = readSettings();
    const paths = this.paths();
    if (this.view === 'zephyr') {
      this.checkClaude(folder);
    }
    return {
      view: this.view,
      tab: this.tab,
      server: (await controller?.snapshot()) ?? {
        running: false, enabled: settings.enabled, supported: true, tool_count: 0, tools: [], jobs: [],
        workspace_folders: [], other_windows: 0, window_id: '', permission_preset: settings.permissions.preset,
        session_approvals: 0,
      },
      launcher,
      bridge: {
        path: paths.bridge,
        installed: fs.existsSync(paths.bridge),
        launcher_path: process.platform === 'win32' ? undefined : paths.launcher,
        home: paths.home,
      },
      workspace_folder: folder,
      agents: AGENTS.flatMap(agent => {
        const scopes: AgentScope[] = folder ? ['user', 'project'] : ['user'];
        return scopes
          .map(scope => inspectAgent(agent, scope, launcher, folder))
          .filter(status => status.state !== 'no-file' || status.id === 'vscode-copilot')
          // Open File is offered only for a file that is there to open.
          .map(status => ({ ...status, exists: !!status.file && fs.existsSync(status.file) }))
          .map(status => {
            if (status.id !== 'vscode-copilot' || !controller?.registeredWithVsCode) {
              return status;
            }
            // VS Code got the server from this extension, with no file at all: the
            // agent's general note about that has nothing left to say.
            const { note, ...rest } = status;
            const kept = note && note !== agent.note ? { note } : {};
            return status.state === 'no-file'
              ? { ...rest, ...kept, automatic: true, source: 'Registered automatically by Zephyr Workbench' }
              : { ...rest, ...kept };
          });
      }),
      zephyr: {
        name: ZEPHYR_PROJECT_MCP.name,
        url: ZEPHYR_PROJECT_MCP.url,
        agents: this.zephyrAgents(folder),
      },
      platform: process.platform,
      home: os.homedir(),
    };
  }

  /**
   * Where each agent stands with the Zephyr Project's server. The note of a row
   * says how to sign in, which that server asks for the first time. VS Code
   * adds a server for all projects itself, through its install link, so that
   * row reads its own configuration file rather than one written here.
   */
  private zephyrAgents(folder: string | undefined) {
    return AGENTS.flatMap(agent => {
      const scopes: AgentScope[] = folder ? ['user', 'project'] : ['user'];
      // A scope with no file, such as Codex for a project, has nothing to show.
      const rows = scopes.filter(scope => !!agent.file(scope, folder) || agent.id === 'vscode-copilot').map(scope => {
        const { current: _current, note, ...status } = inspectEntry(agent, scope, ZEPHYR_TARGET, folder);
        const row = {
          ...status,
          // A problem with the file, such as one that cannot be parsed; the agent's general note stays on the other page.
          ...(note && note !== agent.note ? { note } : {}),
          sign_in: agent.signIn?.(ZEPHYR_PROJECT_MCP.name),
          exists: !!status.file && fs.existsSync(status.file),
        };
        if (agent.id !== 'vscode-copilot' || scope !== 'user') {
          return row;
        }
        const file = this.vscodeUserMcpFile();
        const alias = file ? vscodeServerFor(file) : undefined;
        return {
          ...row,
          via_link: true,
          file,
          exists: !!file && fs.existsSync(file),
          state: alias ? 'configured' as const : 'not-configured' as const,
          ...(alias && alias !== ZEPHYR_PROJECT_MCP.name ? { alias } : {}),
        };
      });
      return agent.id === 'claude-code'
        ? applyClaudeCheck(rows, { ...ZEPHYR_PROJECT_MCP, hint: /zephyr/i }, this.claudeReport(agent, folder))
        : rows;
    });
  }

  /** Claude Code's answer for this folder, or the connector names it recorded when there is none. */
  private claudeReport(agent: (typeof AGENTS)[number], folder: string | undefined): ClaudeCheck {
    const check = AiManagerPanel.claudeCheck;
    const own = check.folder === folder ? check : {};
    const recordedIn = own.servers ? undefined : agent.file('user');
    return {
      checking: !!check.running,
      servers: own.servers,
      error: own.error,
      recorded: recordedIn ? claudeAccountConnectorNames(recordedIn) : undefined,
    };
  }

  /**
   * Ask Claude Code, in the background, which servers it reaches from this
   * folder. Only its answer covers the connectors of the claude.ai account,
   * and says whether a server still needs a sign-in. The panel shows the rows
   * as being checked meanwhile, and again once the answer is in.
   */
  private checkClaude(folder: string | undefined, force = false): void {
    const current = AiManagerPanel.claudeCheck;
    if (current.running) {
      current.again ||= force || current.folder !== folder;
      return;
    }
    const fresh = current.at !== undefined && current.folder === folder && Date.now() - current.at < CLAUDE_CHECK_TTL_MS;
    if (fresh && !force) {
      return;
    }
    const cli = findClaudeCli(this.planOptions().claudeExtensionPath);
    if (!cli) {
      return;
    }
    const done = (answer: Pick<ClaudeCheckState, 'servers' | 'error'>) => {
      const again = AiManagerPanel.claudeCheck.again;
      // An answer that may predate a change is shown, but never counts as fresh.
      AiManagerPanel.claudeCheck = { folder, at: again ? undefined : Date.now(), ...answer };
      const panel = AiManagerPanel.currentPanel;
      if (again) {
        panel?.checkClaude(panel.workspaceFolder(), true);
      }
      void panel?.post();
    };
    const running = listClaudeServers(cli, folder ?? os.homedir()).then(
      servers => done({ servers }),
      error => done({ error: (error instanceof Error ? error.message : String(error)).slice(0, 300) }),
    );
    AiManagerPanel.claudeCheck = { ...(current.folder === folder ? current : {}), folder, running, again: false };
  }

  /**
   * The MCP configuration file of the current VS Code profile, which is where
   * VS Code keeps the servers added for all projects. It sits next to the
   * profile's globalStorage folder, in which this extension's storage lives.
   */
  private vscodeUserMcpFile(): string | undefined {
    if (!this.globalStorageUri) {
      return undefined;
    }
    const profile = path.dirname(path.dirname(this.globalStorageUri.fsPath));
    return fs.existsSync(profile) ? path.join(profile, 'mcp.json') : undefined;
  }

  private async post(): Promise<void> {
    await this.panel.webview.postMessage({ command: 'state', state: await this.state() });
  }

  private async handle(message: InboundMessage): Promise<void> {
    const controller = this.controller();
    try {
      switch (message.command) {
        case 'ready':
          await this.post();
          return;
        case 'refresh':
          await this.post();
          return;
        case 'setTab':
          this.tab = TABS.includes(message.tab as AiManagerTab) ? message.tab as AiManagerTab : 'connections';
          await this.post();
          return;
        case 'setView':
          if (VIEWS.includes(message.view as AiManagerView)) {
            this.view = message.view as AiManagerView;
            await this.post();
          }
          return;
        case 'openLink':
          // Only the pages the AI Manager lists, never an address from the page itself.
          if (isExternalLinkId(message.link)) {
            await vscode.env.openExternal(vscode.Uri.parse(EXTERNAL_LINKS[message.link]));
          }
          return;
        case 'copy':
          if (typeof message.text === 'string' && message.text.length > 0 && message.text.length <= 4000) {
            await vscode.env.clipboard.writeText(message.text);
            void vscode.window.showInformationMessage('Copied to the clipboard.');
          }
          return;
        case 'start':
          await controller?.ensureStarted();
          await this.post();
          return;
        case 'stop':
          await controller?.stopByUser();
          await this.post();
          return;
        case 'restart':
          await controller?.restart();
          await this.post();
          return;
        case 'showLog':
          controller?.showLog();
          return;
        case 'openFile':
          if (message.file && fs.existsSync(message.file)) {
            await vscode.window.showTextDocument(vscode.Uri.file(message.file));
          } else if (message.file) {
            void vscode.window.showWarningMessage(`${message.file} does not exist yet.`);
          }
          return;
        case 'connect':
          await this.connect(message.agentId, message.scope ?? 'user', serverOf(message));
          return;
        case 'disconnect':
          await this.disconnect(message.agentId, message.scope ?? 'user', serverOf(message));
          return;
        case 'checkAccount':
          this.checkClaude(this.workspaceFolder(), true);
          await this.post();
          return;
        case 'setPreset':
          await this.setPreset(message.preset);
          return;
        case 'setPermission':
          await this.setPermission(message.tool, message.permission);
          return;
        case 'forgetApprovals':
          this.controller()?.forgetApprovals();
          await this.post();
          return;
        case 'testConnection':
          await this.testConnection();
          return;
        case 'copyConfig':
          await vscode.commands.executeCommand('zephyr-workbench.mcp.copyConfig');
          return;
        default:
          return;
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `AI Manager: ${error instanceof Error ? error.message : String(error)}`);
      await this.post();
    }
  }

  private target(server: ServerKind): ServerTarget {
    return server === 'zephyr' ? ZEPHYR_TARGET : workbenchTarget(this.launcher());
  }

  private async connect(agentId: string | undefined, scope: AgentScope, server: ServerKind = 'workbench'): Promise<void> {
    const agent = AGENTS.find(a => a.id === agentId);
    if (!agent) {
      return;
    }
    if (server === 'zephyr' && agent.id === 'vscode-copilot' && scope === 'user') {
      await this.addToVsCode();
      return;
    }
    if (server === 'workbench') {
      const install = this.installBridge();
      if (!install.ok) {
        void vscode.window.showErrorMessage(`AI Manager: ${install.problem}`);
        return;
      }
      // The server must be up, or the agent's first call would have nothing to reach.
      await this.controller()?.ensureStarted().catch(() => undefined);
    }
    const title = server === 'zephyr' ? 'the Zephyr Project MCP server' : 'Zephyr Workbench';

    const plan = await planEntryWrite(agent, scope, this.target(server), this.workspaceFolder(), this.planOptions());
    if (plan.warning) {
      void vscode.window.showWarningMessage(plan.warning, 'Open File').then(choice => {
        if (choice === 'Open File') {
          void vscode.window.showTextDocument(vscode.Uri.file(plan.file));
        }
      });
      return;
    }
    if (plan.unchanged) {
      void vscode.window.showInformationMessage(
        `${agent.label} is already configured for ${title}. Restart the agent session to pick it up.`);
      await this.post();
      return;
    }
    // Always preview before touching anything the user owns.
    const verb = plan.method === 'cli' ? 'Run' : plan.created ? 'Create' : 'Update';
    const to = server === 'zephyr' ? ` to ${title}` : '';
    const question = plan.method === 'cli'
      ? `Run the Claude CLI to connect ${agent.label}${to} for all projects?`
      : `${verb} ${plan.file} to connect ${agent.label}${to}?`;
    const choice = await vscode.window.showWarningMessage(
      question, { modal: true, detail: describePlan(plan) }, verb,
    );
    if (choice !== verb) {
      return;
    }
    let backup: string | undefined;
    try {
      ({ backup } = await applyPlan(plan, this.workspaceFolder()));
    } catch (error) {
      void vscode.window.showErrorMessage(`AI Manager: ${error instanceof Error ? error.message : String(error)}`);
      await this.post();
      return;
    }
    const actions = ['Open File'];
    const connected = server === 'zephyr'
      ? `${agent.label} can now use the Zephyr Project MCP server. Restart the agent session to load it.`
        + (agent.signIn ? ` ${agent.signIn(ZEPHYR_PROJECT_MCP.name)}` : '')
      : `${agent.label} is connected to Zephyr Workbench. Restart the agent session to load it.`;
    if (server === 'zephyr' && agent.id === 'claude-code') {
      this.checkClaude(this.workspaceFolder(), true);
    }
    await this.post();
    const picked = await vscode.window.showInformationMessage(
      connected + (backup ? ` The previous file was backed up to ${backup}.` : ''),
      ...actions,
    );
    if (picked === 'Open File') {
      await vscode.window.showTextDocument(vscode.Uri.file(plan.file));
    }
    await this.post();
  }

  private async disconnect(agentId: string | undefined, scope: AgentScope, server: ServerKind = 'workbench'): Promise<void> {
    const agent = AGENTS.find(a => a.id === agentId);
    if (!agent) {
      return;
    }
    const where = agent.id === 'claude-code' && scope === 'user'
      ? 'your Claude Code user configuration'
      : agent.file(scope, this.workspaceFolder()) ?? 'its configuration';
    const entry = server === 'zephyr' ? `Zephyr Project MCP (${ZEPHYR_PROJECT_MCP.name})` : 'Zephyr Workbench';
    const confirm = 'Remove';
    const choice = await vscode.window.showWarningMessage(
      `Remove the ${entry} entry for ${agent.label} from ${where}?`,
      {
        modal: true,
        detail: agent.id === 'claude-code' && scope === 'user'
          ? 'Only that entry is removed, using the Claude CLI. Connect adds it back.'
          : 'Only that entry is removed. A backup of the file is kept in the Zephyr Workbench MCP folder.',
      },
      confirm,
    );
    if (choice !== confirm) {
      return;
    }
    try {
      const result = await removeServerEntry(agent, scope, this.target(server).name, this.workspaceFolder(), this.planOptions());
      void vscode.window.showInformationMessage(result.changed
        ? `Removed the ${entry} entry from ${result.file}.`
        : `${agent.label} had no ${entry} entry to remove.`);
      if (server === 'zephyr' && agent.id === 'claude-code') {
        this.checkClaude(this.workspaceFolder(), true);
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`AI Manager: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.post();
  }

  /**
   * Hand the Zephyr Project's server to VS Code's own install link: VS Code
   * shows what it adds, asks the user, and keeps it in the current profile's
   * MCP configuration, where its MCP Servers view can later remove it.
   */
  private async addToVsCode(): Promise<void> {
    const config = { name: ZEPHYR_PROJECT_MCP.name, type: 'http', url: ZEPHYR_PROJECT_MCP.url };
    const uri = vscode.Uri.from({ scheme: vscode.env.uriScheme, path: 'mcp/install', query: JSON.stringify(config) });
    const opened = await vscode.env.openExternal(uri);
    if (!opened) {
      void vscode.window.showWarningMessage('VS Code did not open its MCP install prompt. Add the server from the Manual setup section instead.');
    }
  }

  /**
   * Pick a preset. Custom starts from what the tab shows when the user has no
   * choices of their own yet, and keeps them when they have: Full or Core
   * never erases them, so picking Custom again brings them back.
   */
  private async setPreset(preset: string | undefined): Promise<void> {
    if (!(PERMISSION_PRESETS as readonly string[]).includes(preset ?? '')) {
      return;
    }
    const config = vscode.workspace.getConfiguration('zephyr-workbench.mcp');
    const { permissions } = readSettings();
    if (preset === 'custom' && Object.keys(permissions.tools).length === 0) {
      await config.update('toolPermissions', this.currentPermissions(), vscode.ConfigurationTarget.Global);
    }
    await config.update('permissions', preset as PermissionPreset, vscode.ConfigurationTarget.Global);
    await this.post();
  }

  /**
   * Change one tool, which makes the permissions custom: every other tool
   * keeps what the tab showed for it.
   */
  private async setPermission(tool: string | undefined, permission: string | undefined): Promise<void> {
    if (!TOOL_CATALOG.some(meta => meta.name === tool) || !(TOOL_PERMISSIONS as readonly string[]).includes(permission ?? '')) {
      return;
    }
    const config = vscode.workspace.getConfiguration('zephyr-workbench.mcp');
    const next = { ...this.currentPermissions(), [tool as string]: permission as ToolPermission };
    await config.update('toolPermissions', next, vscode.ConfigurationTarget.Global);
    await config.update('permissions', 'custom', vscode.ConfigurationTarget.Global);
    await this.post();
  }

  /** What each tool gets now, written out in full so the settings file reads on its own. */
  private currentPermissions(): Record<string, ToolPermission> {
    const { permissions } = readSettings();
    return Object.fromEntries(TOOL_CATALOG.map(meta => [meta.name, permissionOf(meta, permissions)]));
  }

  /**
   * Start the server and run the same end-to-end check as the palette command,
   * which starts the bridge exactly as an agent would. The result shows in the
   * panel, and the full report in the MCP output channel.
   */
  private async testConnection(): Promise<void> {
    const controller = this.controller();
    if (!controller) {
      void vscode.window.showWarningMessage('The Zephyr Workbench MCP integration is not available in this window.');
      return;
    }
    await controller.runConnectionTest();
    await this.post();
  }

  private render(webview: vscode.Webview): string {
    const scriptUri = getUri(webview, this.extensionUri, ['out', 'aimanager.js']);
    const styleUri = getUri(webview, this.extensionUri, ['out', 'style.css']);
    const panelStyleUri = getUri(webview, this.extensionUri, ['out', 'aimanager.css']);
    const codiconUri = getUri(webview, this.extensionUri, ['out', 'codicon.css']);
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';" />
    <link rel="stylesheet" href="${styleUri}" />
    <link rel="stylesheet" href="${codiconUri}" />
    <link rel="stylesheet" href="${panelStyleUri}" />
    <title>AI Manager</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  dispose(): void {
    AiManagerPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

function serverOf(message: InboundMessage): ServerKind {
  return message.server === 'zephyr' ? 'zephyr' : 'workbench';
}

/**
 * The name under which VS Code's MCP configuration file reaches the Zephyr
 * Project's server: its own name, or any other one it was added under.
 */
function vscodeServerFor(file: string): string | undefined {
  try {
    const servers = readJsonPath(parseJsonc(fs.readFileSync(file, 'utf8'), file), ['servers']);
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      return undefined;
    }
    const entries = servers as Record<string, unknown>;
    if (entries[ZEPHYR_PROJECT_MCP.name] !== undefined) {
      return ZEPHYR_PROJECT_MCP.name;
    }
    return Object.keys(entries).find(name => ZEPHYR_TARGET.matches?.(entries[name]));
  } catch {
    return undefined;
  }
}

/** What the confirmation dialog shows: the commands for a CLI plan, a diff otherwise. */
function describePlan(plan: WritePlan): string {
  if (plan.method === 'cli' && plan.commands) {
    const quote = (arg: string) => (/[\s"'{}]/.test(arg) ? `'${arg}'` : arg);
    return plan.commands.map(c => `${path.basename(c.cli)} ${c.args.map(quote).join(' ')}`).join('\n');
  }
  const preview = buildPreview(plan.previous, plan.next);
  return plan.notice ? `${plan.notice}\n\n${preview}` : preview;
}

/** A compact line-level diff for the confirmation dialog. */
function buildPreview(previous: string, next: string): string {
  const before = previous.split('\n');
  const after = next.split('\n');
  const added = after.filter(line => !before.includes(line) && line.trim().length > 0);
  const removed = before.filter(line => !after.includes(line) && line.trim().length > 0);
  const lines: string[] = [];
  for (const line of removed.slice(0, 8)) {
    lines.push(`- ${line.trim()}`);
  }
  for (const line of added.slice(0, 20)) {
    lines.push(`+ ${line.trim()}`);
  }
  if (added.length > 20 || removed.length > 8) {
    lines.push('...');
  }
  return lines.join('\n') || 'No textual change.';
}
