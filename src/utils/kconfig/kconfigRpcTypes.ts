// Shared wire contract between the Kconfig server (Python), the extension-host panel,
// and the webview. Kept dependency-free so it can be imported from all three.

export type NodeId = number;
export type Tri = 0 | 1 | 2;
export type KcType = 'bool' | 'tristate' | 'string' | 'int' | 'hex' | 'unknown';
export type KcKind = 'menu' | 'comment' | 'symbol' | 'choice';

/** Structural fields of a node — stable for the life of a generation. */
export interface KcNodeStatic {
  id: NodeId;
  /** Stable across reloads (e.g. `sym:CONFIG_FOO#0`); used to restore UI state. */
  key: string;
  kind: KcKind;
  name?: string;
  type: KcType;
  prompt?: string;
  isMenuconfig: boolean;
  parent: NodeId | null;
  children: NodeId[];
  defLocation: { file: string; line: number };
}

/** Value/visibility fields that change as symbols are edited. */
export interface KcNodeDynamic {
  visible: boolean;
  promptVisible: boolean;
  strValue: string;
  triValue: Tri;
  assignable: Tri[];
  userValueSet: boolean;
  isYModeChoiceSym: boolean;
  choiceSelected: boolean;
  selectionPrompt: string | null;
  range: { low: string; high: string } | null;
}

export type KcNode = KcNodeStatic & KcNodeDynamic;

export interface KcSearchOrder {
  syms: NodeId[];
  choices: NodeId[];
  menus: NodeId[];
  comments: NodeId[];
}

/** Full tree dump, sent once per generation (get_tree). */
export interface KcTreeInit {
  generation: number;
  /** The Kconfig `mainmenu` prompt (menuconfig's screen title). */
  mainmenu?: string;
  rootChildren: NodeId[];
  nodes: KcNode[];
  searchOrder: KcSearchOrder;
  configPath: string;
  minconfigPath: string;
  dirty: boolean;
  warnings: string[];
  envSource: 'ninja' | 'fallback';
}

/** A per-node delta after a mutation (the changed dynamic fields + id). */
export type KcNodeDelta = Partial<KcNodeDynamic> & { id: NodeId };

export interface KcDeltaSet {
  generation: number;
  changes: KcNodeDelta[];
  dirty: boolean;
}

// -- Info pane --------------------------------------------------------------

export type KcExprToken =
  | { t: 'sym'; name: string; value: string; targetId?: NodeId }
  | { t: 'op'; text: string }
  | { t: 'text'; text: string };

export interface KcExprLine {
  prefix: '' | '&&' | '||';
  tokens: KcExprToken[];
  valueHint?: 'n' | 'm' | 'y';
}

export interface KcSymRef {
  name: string;
  targetId?: NodeId;
}

export interface KcDefinition {
  file: string;
  line: number;
  includePath: { file: string; line: number }[];
  menuPath: { label: string; targetId?: NodeId }[];
  kconfigSrc: string;
}

export interface KcNodeInfo {
  id: NodeId;
  name?: string;
  prompts: string[];
  typeStr: string;
  valueStr?: string;
  choiceMode?: string;
  helps: string[];
  directDep?: { value: 'n' | 'm' | 'y'; lines: KcExprLine[] };
  defaults: { value: KcExprLine; condition?: { value: 'n' | 'm' | 'y'; lines: KcExprLine[] } }[];
  choiceSyms?: { name: string; selected: boolean; targetId?: NodeId }[];
  selectImply: { title: string; syms: KcSymRef[] }[];
  definitions: KcDefinition[];
  /** Present only when the symbol is currently unmet: the false dependency terms. */
  blockers?: KcExprLine[] | null;
}

// -- Change review ----------------------------------------------------------

export interface KcChange {
  name: string;
  baseline: string | null;
  current: string;
  configString: string;
  targetId?: NodeId;
}

/** One temporary (.config vs fragment baseline) value, as computed by get_drift. */
export interface KcDriftEntry {
  name: string;
  baseline: string | null;
  current: string;
  configString: string;
  targetId?: NodeId;
  /** Path of a later-merging fragment that would override the exported value. */
  overriddenBy?: string;
}

// -- Server method payloads (raw JSON-RPC over stdio) -----------------------
// These mirror kconfig_server.py's method table exactly.

export interface KcInitResult {
  loadMessage: string;
  needsSave: boolean;
  nodeCount: number;
  symbolCount: number;
  kconfigRoot: string;
  configPath: string;
}

export type KcSetValueResult =
  | ({ ok: true } & Omit<KcDeltaSet, never>)
  | { ok: false; error: string };

/** Envelope every server response carries alongside its result/error. */
export interface KcResponseMeta {
  dirty: boolean;
  warnings: string[];
}

// -- Panel <-> webview messages (postMessage) -------------------------------
// The RPC request/response envelope matches the workbench's existing Eclair layer
// (`src/utils/eclair/eclairEvent.ts`) so the webview can reuse the same RpcClient.

export interface KcTarget {
  appName: string;
  configName: string;
  board: string;
  appRootPath: string;
  configPath: string;
  envSource: 'ninja' | 'fallback';
}

/** Methods the webview calls on the extension host (see KconfigManagerPanel). */
export type KconfigRpcMethods = {
  'kconfig/getTarget': { params: undefined; result: KcTarget };
  'kconfig/getTree': { params: undefined; result: KcTreeInit };
  'kconfig/setValue': { params: { generation: number; id: NodeId; value: string }; result: KcSetValueResult };
  'kconfig/unsetValue': { params: { generation: number; id: NodeId }; result: KcSetValueResult };
  'kconfig/undo': { params: undefined; result: KcSetValueResult };
  'kconfig/redo': { params: undefined; result: KcSetValueResult };
  'kconfig/revert': { params: { name: string }; result: KcSetValueResult };
  'kconfig/getChanges': { params: undefined; result: { changes: KcChange[] } };
  'kconfig/getInfo': { params: { id: NodeId }; result: KcNodeInfo };
  'kconfig/save': {
    params: { kind: 'config' | 'as' | 'minimal'; path?: string };
    result: { ok: boolean; path?: string; message?: string; canceled?: boolean; dirty: boolean };
  };
  'kconfig/loadConfig': {
    params: { path?: string; replace?: boolean };
    result: { ok: boolean; canceled?: boolean; message?: string } & Partial<KcDeltaSet> & { needsSave?: boolean };
  };
  /** Lightweight query: how many temporary values could be exported right now. */
  'kconfig/getDriftCount': { params: undefined; result: { count: number; stale: boolean } };
  /** Kicks the drift-export flow; the panel replies with a driftReady/driftError event. */
  'kconfig/persistPrjConf': { params: { target: 'prj' | 'fragment' }; result: { started: boolean } };
  /** Writes the user-confirmed lines to the target chosen when the flow started. */
  'kconfig/persistPrjConfWrite': {
    params: { lines: string[] };
    result: { ok: boolean; written: number; path: string; outsideConflicts: string[] };
  };
  'kconfig/openLocation': { params: { file: string; line: number }; result: void };
  'kconfig/buildNow': { params: undefined; result: { started: boolean } };
  'kconfig/restart': { params: undefined; result: { ok: boolean } };
};

/** Push events the extension host sends to the webview (not request/response). */
export type KconfigEvent =
  | { kind: 'phase'; phase: 'configuring' | 'starting' | 'ready' | 'error' | 'crashed'; message?: string }
  | { kind: 'dirty'; dirty: boolean }
  | { kind: 'warnings'; warnings: string[] }
  | { kind: 'delta'; delta: KcDeltaSet }
  | { kind: 'reloading' }
  | { kind: 'reloaded'; init: KcTreeInit }
  | { kind: 'externalChange'; hasLocalEdits: boolean }
  | {
      kind: 'driftReady';
      target: 'prj' | 'fragment';
      targetPath: string;
      drift: KcDriftEntry[];
      missingFragments: string[];
      stale: boolean;
      staleReason?: string;
    }
  | { kind: 'driftError'; message: string };
