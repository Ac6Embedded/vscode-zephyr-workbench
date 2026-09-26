// The MCP settings, checked. VS Code does not type-check values when they are
// read, and a hand-edited settings.json can hold anything. A value that is not
// understood must never widen what an agent may do, so every security-relevant
// setting falls back to its most restrictive meaning and the problem is logged.

import { PERMISSION_PRESETS, PermissionPreset, Permissions, TOOL_PERMISSIONS, ToolPermission } from './toolSpec';

export interface McpSettings {
  enabled: 'auto' | 'on' | 'off';
  port: number;
  /** What agents may do with each tool: the preset, and the user's own choices for the custom one. */
  permissions: Permissions;
  revealTerminal: 'always' | 'silent' | 'never';
  defaultWaitSeconds: number;
  homeDir: string;
  showStatusBar: boolean;
}

/** The settings as read, one per key of zephyr-workbench.mcp. */
export interface RawMcpSettings {
  enabled?: unknown;
  port?: unknown;
  permissions?: unknown;
  toolPermissions?: unknown;
  revealTerminal?: unknown;
  defaultWaitSeconds?: unknown;
  homeDir?: unknown;
  showStatusBar?: unknown;
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value);

export function normalizeMcpSettings(raw: RawMcpSettings): { settings: McpSettings; problems: string[] } {
  const problems: string[] = [];
  const invalid = (key: string, value: unknown, used: string) =>
    problems.push(`zephyr-workbench.mcp.${key} has an invalid value (${JSON.stringify(value)}); using ${used}.`);

  let preset: PermissionPreset = 'core';
  let locked = false;
  if (raw.permissions !== undefined) {
    if (oneOf(raw.permissions, PERMISSION_PRESETS)) {
      preset = raw.permissions;
    } else {
      // What the user meant to allow is unknown, so only reading is.
      locked = true;
      invalid('permissions', raw.permissions, 'the read-only tools only until it is fixed');
    }
  }

  const tools: Record<string, ToolPermission> = {};
  if (raw.toolPermissions !== undefined) {
    const value = raw.toolPermissions;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, permission] of Object.entries(value as Record<string, unknown>)) {
        if (oneOf(permission, TOOL_PERMISSIONS)) {
          tools[name] = permission;
        } else {
          // One tool the user meant to limit somehow: it is blocked.
          tools[name] = 'block';
          invalid(`toolPermissions.${name}`, permission, '"block"');
        }
      }
    } else if (preset === 'custom') {
      // The custom preset is made of this list, so nothing it allows is known.
      locked = true;
      invalid('toolPermissions', value, 'the read-only tools only until it is fixed');
    } else {
      invalid('toolPermissions', value, 'nothing from it, since the preset is not custom');
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

  const homeDir = typeof raw.homeDir === 'string' ? raw.homeDir : '';
  if (raw.homeDir !== undefined && typeof raw.homeDir !== 'string') {
    invalid('homeDir', raw.homeDir, 'the default folder');
  }
  const showStatusBar = typeof raw.showStatusBar === 'boolean' ? raw.showStatusBar : true;

  return {
    settings: {
      enabled, port, permissions: { preset, tools, ...(locked ? { locked } : {}) },
      revealTerminal, defaultWaitSeconds, homeDir, showStatusBar,
    },
    problems,
  };
}
