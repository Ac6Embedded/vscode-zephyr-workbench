// The tool contract. Kept SDK-agnostic on purpose: only `host/sdkAdapter.ts`
// and the bridge import the MCP SDK, so swapping SDK lines touches two files
// rather than every tool.

import { z } from 'zod';

export type ToolCategory = 'query' | 'artifact' | 'config' | 'action' | 'editor' | 'job';

/** The kinds of change an action makes, which a tool set to Ask asks about. */
export const CONFIRM_CATEGORIES = ['hardware', 'delete', 'workspace', 'install', 'settings'] as const;
export type ConfirmCategory = typeof CONFIRM_CATEGORIES[number];

/**
 * What a dialog is about: the kind of change an action makes, or `call` for a
 * tool with no such action that the user set to Ask before each use.
 */
export type AskCategory = ConfirmCategory | 'call';

/** Asked under the core preset: everything that touches hardware, deletes, or changes the machine. */
export const CORE_ASK_CATEGORIES: readonly ConfirmCategory[] = ['hardware', 'delete', 'workspace', 'install'];

/** What the user lets an agent do with one tool: use it, be asked first, or not see it at all. */
export const TOOL_PERMISSIONS = ['allow', 'ask', 'block'] as const;
export type ToolPermission = typeof TOOL_PERMISSIONS[number];

/** The presets of the AI Manager's Permissions tab. */
export const PERMISSION_PRESETS = ['full', 'core', 'custom'] as const;
export type PermissionPreset = typeof PERMISSION_PRESETS[number];

export interface Permissions {
  preset: PermissionPreset;
  /** The user's choice per tool, for the custom preset. A tool it does not name gets its core permission. */
  tools: Readonly<Record<string, ToolPermission>>;
  /** The settings could not be read: only the read-only tools are served until they are fixed. */
  locked?: boolean;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  /**
   * True only for the tools that reach the network (git servers, download
   * sites, PyPI). Everything else touches this machine alone.
   */
  openWorldHint: boolean;
}

/**
 * Metadata for one tool. Deliberately free of handlers so the bridge can ship
 * the same catalog and answer `tools/list` with no VS Code window running.
 */
export interface ToolMeta {
  name: string;
  title: string;
  /**
   * What the AI Manager tells the user the tool does, in its tooltip: one or
   * two plain sentences. Never sent to agents, which read `description`.
   */
  summary: string;
  /**
   * What the agent sees. Four sentences: what it does and the exact command or
   * artifact behind it, when to use it and which sibling to use instead, what
   * the inputs mean, and what comes back with its limits.
   */
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  outputSchema?: z.ZodObject<z.ZodRawShape>;
  annotations: ToolAnnotations;
  category: ToolCategory;
  /**
   * What the user is asked before this tool acts: one category for the whole
   * tool, or one per value of its `action` (or `target`) argument. Taken from
   * the catalog, never from the handler, so the AI Manager shows exactly what
   * will ask.
   */
  confirm?: ConfirmCategory | Readonly<Record<string, ConfirmCategory>>;
  /** Result size hint for clients that honour it. */
  maxResultChars?: number;
  /**
   * Arguments that name a folder on disk, in the order the bridge tries them
   * to pick the VS Code window. Defaults to ['app_path']. Only arguments that
   * really are filesystem paths belong here: query_devicetree's `path` is a
   * devicetree node and must never steer routing.
   */
  routeBy?: readonly string[];
  /**
   * Calls that act on the machine rather than on a folder, such as installing
   * a toolchain. When a single VS Code window runs, such a call goes to it even
   * when the agent's folder is unrelated. True for the whole tool, or per value
   * of its `action` (or `target`, `what`) argument.
   */
  machineScope?: boolean | Readonly<Record<string, boolean>>;
}

/** The arguments the bridge routes a call of this tool by. */
export function routeByOf(meta: ToolMeta): readonly string[] {
  return meta.routeBy ?? ['app_path'];
}

/** Whether this call acts on the machine rather than on a folder. */
export function isMachineScope(meta: ToolMeta, args: Record<string, unknown>): boolean {
  const scope = meta.machineScope;
  if (scope === undefined || typeof scope === 'boolean') {
    return scope === true;
  }
  for (const key of ['action', 'target', 'what']) {
    const value = args[key];
    if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(scope, value)) {
      return scope[value];
    }
  }
  return false;
}

/**
 * `_meta` key the bridge uses to pass the agent's own client info to the
 * window. Without it every call would be attributed to the bridge itself.
 */
export const FORWARDED_CLIENT_META_KEY = 'com.ac6.zephyr-workbench/client';

export interface ProgressReport {
  progress: number;
  total?: number;
  message?: string;
}

/** Filled in by a handler as it goes, and written to the audit log with the call. */
export interface AuditBag {
  confirmation?: string;
  confirmCategory?: AskCategory;
  jobId?: string;
  target?: { app_path?: string; config_name?: string; folder?: string; runner?: string };
}

/** What a handler is given. `deps` is the host-side dependency bundle. */
export interface ToolContext<S = unknown> {
  signal: AbortSignal;
  progress(report: ProgressReport): void;
  /**
   * The agent calling. `instance` is unique per agent session (one bridge
   * process), so an approval "for this session" cannot be claimed by another
   * caller that merely uses the same client name.
   */
  client: { name?: string; version?: string; instance?: string };
  deps: S;
  /** The catalog entry of the tool being called. */
  tool: ToolMeta;
  /** When the call arrived, so every wait in it shares one clock. */
  startedAt: number;
  audit: AuditBag;
}

/** The confirmation category a call falls under, from the catalog entry. */
export function confirmCategoryOf(meta: ToolMeta, args: Record<string, unknown>): ConfirmCategory | undefined {
  const confirm = meta.confirm;
  if (confirm === undefined || typeof confirm === 'string') {
    return confirm;
  }
  for (const key of ['action', 'target', 'what']) {
    const value = args[key];
    if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(confirm, value)) {
      return confirm[value];
    }
  }
  return undefined;
}

export type ToolHandler<S = unknown> = (args: Record<string, unknown>, ctx: ToolContext<S>) => Promise<unknown>;

/** Every kind of change the actions of a tool can make, from the catalog entry. */
export function confirmCategoriesOf(meta: ToolMeta): ConfirmCategory[] {
  const confirm = meta.confirm;
  if (confirm === undefined) {
    return [];
  }
  return typeof confirm === 'string' ? [confirm] : [...new Set(Object.values(confirm))];
}

/** Ask for a tool whose actions make one of these kinds of change, allow any other. */
export function permissionForCategories(meta: ToolMeta, categories: readonly ConfirmCategory[]): 'ask' | 'allow' {
  return confirmCategoriesOf(meta).some(category => categories.includes(category)) ? 'ask' : 'allow';
}

/**
 * The core preset: asks before anything that touches hardware or changes the
 * machine, allows the rest, and blocks the tools that delete.
 */
export function corePermission(meta: ToolMeta): ToolPermission {
  return meta.annotations.destructiveHint === true ? 'block' : permissionForCategories(meta, CORE_ASK_CATEGORIES);
}

/** What the user lets an agent do with a tool. Pure so it is unit tested. */
export function permissionOf(meta: ToolMeta, permissions: Permissions): ToolPermission {
  if (permissions.locked) {
    // Fail closed: anything not explicitly read-only is treated as a write.
    return meta.annotations.readOnlyHint === true ? 'allow' : 'block';
  }
  if (permissions.preset === 'full') {
    return 'allow';
  }
  if (permissions.preset === 'custom') {
    return permissions.tools[meta.name] ?? corePermission(meta);
  }
  return corePermission(meta);
}

/** The tools agents see: every one that is not blocked. */
export function selectTools(catalog: readonly ToolMeta[], permissions: Permissions): ToolMeta[] {
  return catalog.filter(tool => permissionOf(tool, permissions) !== 'block');
}

/** Stable hash of the visible tool list, used to invalidate the VS Code definition. */
export function catalogVersion(tools: readonly ToolMeta[]): string {
  let hash = 5381;
  for (const tool of tools) {
    for (const ch of tool.name) {
      hash = ((hash << 5) + hash + ch.charCodeAt(0)) >>> 0;
    }
  }
  return hash.toString(16);
}
