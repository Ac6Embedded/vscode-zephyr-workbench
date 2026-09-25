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
  /**
   * Set on a symbol the export target's managed region already assigns, whose line no
   * longer gives the current value: 'update' replaces the line with configString,
   * 'remove' drops it, because a configuration file can no longer assign the symbol.
   * `baseline` is then the value the line assigns.
   */
  managedLine?: 'update' | 'remove';
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

// -- Agent methods (find / explain / check_merge) ------------------------------
// Used by the MCP server's own sessions; they never change the loaded state.

export type KcTriStr = 'n' | 'm' | 'y';

export interface KcFindEntry {
  kind: 'symbol' | 'choice';
  id?: NodeId;
  type: KcType;
  hasPrompt: boolean;
  /** Name of the choice a symbol belongs to (`<choice>` when it is unnamed). */
  choice: string | null;
  value: string;
  nodeIds: NodeId[];
}

export interface KcFindResult {
  found: Record<string, KcFindEntry>;
  /** Unknown name -> close or containing names. */
  unknown: Record<string, string[]>;
  matches?: string[];
  totalMatches?: number;
}

/** One term of an expression, rendered with the current value of each symbol in it. */
export interface KcTerm {
  expr: string;
  value: KcTriStr;
}

export interface KcReverseDep {
  /** The whole `SEL && condition` term. */
  expr: string;
  active: boolean;
  name?: string;
  value?: string;
}

export interface KcChoiceSummary {
  name: string;
  prompt: string | null;
  mode: KcTriStr;
  selected: string | null;
  members: { name: string; value: string }[];
  optional: boolean;
}

export interface KcExplainSymbol {
  kind: 'symbol';
  name: string;
  type: KcType;
  value: string;
  userValue: string | null;
  assignable: KcTriStr[];
  visibility: KcTriStr;
  promptless: boolean;
  prompts: string[];
  helps: string[];
  dependsOn: { value: KcTriStr; terms: KcTerm[] };
  promptConditions: { prompt: string; value: KcTriStr; terms: KcTerm[] }[];
  blockedBy: (KcTerm & { kind: 'depends_on' | 'visibility' })[];
  /** Every active selector, then inactive ones up to a limit; the total counts all of them. */
  selectedBy: KcReverseDep[];
  selectedByTotal: number;
  impliedBy: KcReverseDep[];
  impliedByTotal: number;
  selects: { name: string; condition?: string; active: boolean }[];
  implies: { name: string; condition?: string; active: boolean }[];
  /**
   * The defaults whose condition holds, in evaluation order; `used` marks the first,
   * the value taken when nothing assigns the symbol. The total counts every default.
   */
  defaults: KcExplainDefault[];
  defaultsTotal: number;
  ranges: { low: string; high: string; condition: string | null; active: boolean }[];
  activeRange: { low: string; high: string } | null;
  choice: KcChoiceSummary | null;
  definitions: KcExplainDefinition[];
  configString: string;
}

export interface KcExplainDefault {
  value: string;
  used: boolean;
  condition?: string;
  conditionValue?: KcTriStr;
  /** Relative to ZEPHYR_BASE for in-tree Kconfig files. */
  file?: string;
  line?: number;
}

export interface KcExplainDefinition {
  /** Relative to ZEPHYR_BASE for in-tree Kconfig files. */
  file: string;
  line: number;
  menuPath: string;
  /** Whether the enclosing `if` and `depends on` of this definition hold. */
  active: boolean;
}

export interface KcExplainChoice extends KcChoiceSummary {
  kind: 'choice';
  type: KcType;
  value: string;
  visibility: KcTriStr;
  prompts: string[];
  helps: string[];
  dependsOn: { value: KcTriStr; terms: KcTerm[] };
  blockedBy: (KcTerm & { kind: 'depends_on' })[];
  definitions: KcExplainDefinition[];
}

export interface KcExplainResult {
  symbols: (KcExplainSymbol | KcExplainChoice)[];
  unknown: Record<string, string[]>;
}

/** What a requested symbol looks like after the simulated merge. */
export interface KcMergeSymbol {
  /** The winning assignment in the merge, unescaped; null when nothing assigns it. */
  userValue: string | null;
  value: string;
  /** Whether Zephyr's kconfig.py would accept the assignment (the value took). */
  took: boolean;
  failure: string | null;
  promptless: boolean;
  /** Where the winning assignment is, when kconfiglib records it. */
  assignedAt: { file: string; line: number } | null;
  missingDeps: KcTerm[];
  activeSelectors: string[];
  activeRange: { low: string; high: string } | null;
  choice: KcChoiceSummary | null;
}

export type KcCheckMergeResult =
  | {
      ok: true;
      symbols: Record<string, KcMergeSymbol>;
      /** Values in the loaded .config. */
      current: Record<string, string | null>;
      /** Values after merging the fragments the build uses today. */
      before: Record<string, string | null>;
      /** Symbols whose assignment only fails with the proposed fragments. */
      newFailures: Record<string, string>;
      existingFailures: Record<string, string>;
      existingFailuresTotal: number;
      newWarnings: string[];
      sideEffects: { name: string; from: string | null; to: string }[];
      sideEffectsTotal: number;
      discarded: { name: string; current: string; afterMerge: string | null }[];
      discardedTotal: number;
      missingFragments: string[];
    }
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
  /** Why build.ninja was not usable. Only set when `envSource` is 'fallback'. */
  envSourceDetail?: string;
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
  /**
   * Writes the user-confirmed lines to the target chosen when the flow started, and drops
   * the managed lines of `remove` (symbol names without CONFIG_), among those it offered.
   */
  'kconfig/persistPrjConfWrite': {
    params: { lines: string[]; remove?: string[] };
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
