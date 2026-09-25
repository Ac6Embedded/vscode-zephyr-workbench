// The MCP settings, checked. VS Code does not type-check values when they are
// read, and a hand-edited settings.json can hold anything. A value that is not
// understood must never widen what an agent may do, so every security-relevant
// setting falls back to its most restrictive meaning and the problem is logged.

import { CONFIRM_CATEGORIES, ConfirmCategory, DEFAULT_CONFIRM_ACTIONS, Toolset } from './toolSpec';

export interface McpSettings {
  enabled: 'auto' | 'on' | 'off';
  port: number;
  toolset: Toolset;
  disabledTools: string[];
  revealTerminal: 'always' | 'silent' | 'never';
  defaultWaitSeconds: number;
  homeDir: string;
  showStatusBar: boolean;
  /** Categories the user must approve in a dialog before an agent acts. */
  confirmActions: ConfirmCategory[];
}

export type RawMcpSettings = { [K in keyof McpSettings]?: unknown };

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value);

export function normalizeMcpSettings(raw: RawMcpSettings): { settings: McpSettings; problems: string[] } {
  const problems: string[] = [];
  const invalid = (key: string, value: unknown, used: string) =>
    problems.push(`zephyr-workbench.mcp.${key} has an invalid value (${JSON.stringify(value)}); using ${used}.`);

  let toolset: Toolset = 'core';
  if (raw.toolset !== undefined) {
    if (oneOf(raw.toolset, ['full', 'core', 'read-only'] as const)) {
      toolset = raw.toolset;
    } else {
      toolset = 'read-only';
      invalid('toolset', raw.toolset, '"read-only"');
    }
  }

  let disabledTools: string[] = [];
  if (raw.disabledTools !== undefined) {
    if (Array.isArray(raw.disabledTools) && raw.disabledTools.every(item => typeof item === 'string')) {
      // delete_build became remove_or_delete before release; a setting that
      // hid the old name keeps hiding the tool that replaced it.
      disabledTools = (raw.disabledTools as string[]).map(name => (name === 'delete_build' ? 'remove_or_delete' : name));
    } else {
      // Which tools were meant to be hidden is unknown, so hide every write.
      toolset = 'read-only';
      invalid('disabledTools', raw.disabledTools, 'the "read-only" toolset until it is fixed');
    }
  }

  let enabled: McpSettings['enabled'] = 'auto';
  if (raw.enabled !== undefined) {
    if (oneOf(raw.enabled, ['auto', 'on', 'off'] as const)) {
      enabled = raw.enabled;
    } else {
      // The master switch: a value nobody can read means off, not on.
      enabled = 'off';
      invalid('enabled', raw.enabled, '"off" until it is fixed');
    }
  }

  let port = 0;
  if (raw.port !== undefined) {
    if (typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port >= 0 && raw.port <= 65535) {
      port = raw.port;
    } else {
      invalid('port', raw.port, 'an automatic port');
    }
  }

  let revealTerminal: McpSettings['revealTerminal'] = 'silent';
  if (raw.revealTerminal !== undefined) {
    if (oneOf(raw.revealTerminal, ['always', 'silent', 'never'] as const)) {
      revealTerminal = raw.revealTerminal;
    } else {
      invalid('revealTerminal', raw.revealTerminal, '"silent"');
    }
  }

  let defaultWaitSeconds = 45;
  if (raw.defaultWaitSeconds !== undefined) {
    if (typeof raw.defaultWaitSeconds === 'number' && raw.defaultWaitSeconds >= 0 && raw.defaultWaitSeconds <= 1500) {
      defaultWaitSeconds = raw.defaultWaitSeconds;
    } else {
      invalid('defaultWaitSeconds', raw.defaultWaitSeconds, '45');
    }
  }

  let confirmActions: ConfirmCategory[] = [...DEFAULT_CONFIRM_ACTIONS];
  if (raw.confirmActions !== undefined) {
    if (Array.isArray(raw.confirmActions) && raw.confirmActions.every(item => oneOf(item, CONFIRM_CATEGORIES))) {
      confirmActions = [...new Set(raw.confirmActions as ConfirmCategory[])];
    } else {
      // What the user meant to allow is unknown, so everything asks.
      confirmActions = [...CONFIRM_CATEGORIES];
      invalid('confirmActions', raw.confirmActions, 'every category until it is fixed');
    }
  }

  const homeDir = typeof raw.homeDir === 'string' ? raw.homeDir : '';
  if (raw.homeDir !== undefined && typeof raw.homeDir !== 'string') {
    invalid('homeDir', raw.homeDir, 'the default folder');
  }
  const showStatusBar = typeof raw.showStatusBar === 'boolean' ? raw.showStatusBar : true;

  return {
    settings: { enabled, port, toolset, disabledTools, revealTerminal, defaultWaitSeconds, homeDir, showStatusBar, confirmActions },
    problems,
  };
}
