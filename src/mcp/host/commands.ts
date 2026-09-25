// Palette commands for the AI agent integration.
//
// Every command either opens the AI Manager on the right tab or performs the
// same action the panel performs, so the palette and the panel can never
// disagree about what is configured.

import * as vscode from 'vscode';
import { AiManagerPanel, AiManagerTab } from '../../panels/AiManagerPanel';
import { AGENTS, configSnippet } from '../agents';
import { launcherSpec } from '../agents/launcher';
import { getMcpPaths } from '../core/paths';
import { McpController, readSettings } from './mcpController';

export function registerMcpCommands(
  context: vscode.ExtensionContext,
  controller: () => McpController | undefined,
): void {
  const open = (tab: AiManagerTab) => AiManagerPanel.show(context.extensionUri, controller, tab, context.globalStorageUri);

  const register = (id: string, run: (...args: unknown[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, run));
  };

  register('zephyr-workbench.ai-manager', () => open('agents'));
  register('zephyr-workbench.mcp.connect', () => open('agents'));
  register('zephyr-workbench.mcp.showStatus', () => open('servers'));
  register('zephyr-workbench.mcp.tools', () => open('tools'));

  register('zephyr-workbench.mcp.start', async () => {
    const active = controller();
    if (!active) {
      void vscode.window.showWarningMessage('The Zephyr Workbench MCP integration is not available in this window.');
      return;
    }
    try {
      await active.ensureStarted();
      void vscode.window.showInformationMessage(
        `The Zephyr Workbench MCP server is running on 127.0.0.1:${active.endpoint?.port}.`);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Could not start the MCP server: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  register('zephyr-workbench.mcp.stop', async () => {
    await controller()?.stopByUser();
    void vscode.window.showInformationMessage('The Zephyr Workbench MCP server is stopped. Agents cannot start it again until you start it.');
  });

  register('zephyr-workbench.mcp.restart', async () => {
    await controller()?.restart();
    void vscode.window.showInformationMessage('The Zephyr Workbench MCP server restarted.');
  });

  register('zephyr-workbench.mcp.showLog', () => controller()?.showLog());

  register('zephyr-workbench.mcp.doctor', async () => {
    const active = controller();
    if (!active) {
      void vscode.window.showWarningMessage('The Zephyr Workbench MCP integration is not available in this window.');
      return;
    }
    const checks = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Testing the AI agent connection' },
      () => active.runConnectionTest(),
    );
    // The full report is in the MCP output channel, next to the agent activity.
    const problems = checks.filter(check => !check.ok);
    const report = 'Show Report';
    const first = problems[0];
    const choice = first
      ? await vscode.window.showWarningMessage(
        problems.length === 1
          ? `AI agent connection: ${first.name} has a problem. ${first.fix ?? first.detail}`
          : `AI agent connection: ${problems.length} problems, starting with ${first.name}. ${first.fix ?? first.detail}`,
        report)
      : await vscode.window.showInformationMessage(
        `AI agent connection: all ${checks.length} checks passed. An agent can reach this window.`, report);
    if (choice === report) {
      active.showLog();
    }
  });

  register('zephyr-workbench.mcp.copyConfig', async () => {
    const items = [
      ...AGENTS.map(agent => ({
        label: agent.label,
        description: agent.file('user') ?? agent.file('project', '<project>'),
        agent,
      })),
      { label: 'Another MCP client', description: 'Generic mcpServers JSON', agent: undefined },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Which agent is the configuration for?' });
    if (!pick) {
      return;
    }
    // The snippet points at the launcher, so make sure it is in place.
    controller()?.installBridgeFiles();
    const paths = getMcpPaths(readSettings().homeDir || undefined);
    await vscode.env.clipboard.writeText(configSnippet(pick.agent, launcherSpec(paths, process.execPath, 'auto')));
    void vscode.window.showInformationMessage(
      `Copied the ${pick.label} configuration. Merge it into ${pick.description ?? 'the client configuration'}, then restart the agent session.`);
  });
}
