// Client-side Kconfig model + flatten engines. Pure TypeScript (no DOM/React) so the
// visibility semantics can be unit-tested directly. Ported from Zephyr's menuconfig.py
// (_shown_nodes / _visible) and guiconfig.py (_shown_full_nodes).

import type {
  KcNode, KcTreeInit, KcDeltaSet, NodeId, KcSearchOrder,
} from '../../utils/kconfig/kconfigRpcTypes';

export interface FlatRow {
  id: NodeId;
  depth: number;
}

export interface CompiledQuery {
  regexes: RegExp[];
  error?: string;
}

export class KcStore {
  readonly nodes = new Map<NodeId, KcNode>();
  rootChildren: NodeId[] = [];
  generation = 0;
  searchOrder: KcSearchOrder = { syms: [], choices: [], menus: [], comments: [] };
  configPath = '';
  minconfigPath = '';
  mainmenu = 'Configuration';
  dirty = false;

  /** Memoized "has a visible descendant" per node (invalidated on delta). */
  private visDescCache = new Map<NodeId, boolean>();

  constructor(init: KcTreeInit) {
    this.load(init);
  }

  load(init: KcTreeInit) {
    this.nodes.clear();
    for (const n of init.nodes) { this.nodes.set(n.id, n); }
    this.rootChildren = init.rootChildren;
    this.generation = init.generation;
    this.searchOrder = init.searchOrder;
    this.configPath = init.configPath;
    this.minconfigPath = init.minconfigPath;
    this.mainmenu = init.mainmenu || 'Configuration';
    this.dirty = init.dirty;
    this.visDescCache.clear();
  }

  /** Apply a set of per-node dynamic-field deltas from a mutation. */
  applyDelta(delta: KcDeltaSet) {
    for (const change of delta.changes) {
      const node = this.nodes.get(change.id);
      if (node) { Object.assign(node, change); }
    }
    this.dirty = delta.dirty;
    // Visibility of any node may have shifted; drop the descendant cache.
    this.visDescCache.clear();
  }

  get(id: NodeId): KcNode | undefined { return this.nodes.get(id); }

  key(id: NodeId): string | undefined { return this.nodes.get(id)?.key; }

  // -- visibility helpers ---------------------------------------------------

  private hasVisibleDescendant(id: NodeId): boolean {
    const cached = this.visDescCache.get(id);
    if (cached !== undefined) { return cached; }
    const node = this.nodes.get(id);
    let result = false;
    if (node) {
      for (const cid of node.children) {
        const child = this.nodes.get(cid);
        if (child && (child.visible || this.hasVisibleDescendant(cid))) { result = true; break; }
      }
    }
    this.visDescCache.set(id, result);
    return result;
  }

  private shouldShow(node: KcNode, showAll: boolean): boolean {
    return showAll || node.visible || this.hasVisibleDescendant(node.id);
  }

  isExpandable(node: KcNode): boolean {
    return node.children.length > 0;
  }

  /** True when expanding/entering the node would show at least one child (menuconfig `---->` vs `----`). */
  hasShownChildren(id: NodeId, showAll: boolean): boolean {
    const node = this.nodes.get(id);
    if (!node) { return false; }
    return node.children.some((cid) => {
      const child = this.nodes.get(cid);
      return !!child && this.shouldShow(child, showAll);
    });
  }

  // -- full-tree flatten (guiconfig default) --------------------------------

  flattenFull(opts: { showAll: boolean; expanded: Set<string> }): FlatRow[] {
    const out: FlatRow[] = [];
    const walk = (ids: NodeId[], depth: number) => {
      for (const id of ids) {
        const node = this.nodes.get(id);
        if (!node || !this.shouldShow(node, opts.showAll)) { continue; }
        out.push({ id, depth });
        if (node.children.length && opts.expanded.has(node.key)) {
          walk(node.children, depth + 1);
        }
      }
    };
    walk(this.rootChildren, 0);
    return out;
  }

  // -- filtered flatten (persistent toolbar filter) -------------------------

  flattenFiltered(query: CompiledQuery, showAll: boolean): FlatRow[] {
    if (query.error || query.regexes.length === 0) { return []; }
    const include = new Set<NodeId>();
    for (const node of this.nodes.values()) {
      if ((showAll || node.visible || node.promptVisible) && this.matches(node, query)) {
        include.add(node.id);
        let p = node.parent;
        while (p !== null && !include.has(p)) { include.add(p); p = this.nodes.get(p)?.parent ?? null; }
      }
    }
    const out: FlatRow[] = [];
    const walk = (ids: NodeId[], depth: number) => {
      for (const id of ids) {
        if (!include.has(id)) { continue; }
        out.push({ id, depth });
        const node = this.nodes.get(id);
        if (node && node.children.length) { walk(node.children, depth + 1); }
      }
    };
    walk(this.rootChildren, 0);
    return out;
  }

  // -- search (menuconfig jump-to semantics) --------------------------------

  matches(node: KcNode, query: CompiledQuery): boolean {
    if (query.regexes.length === 0) { return false; }
    const name = (node.name ?? '').toLowerCase();
    const prompt = (node.prompt ?? '').toLowerCase();
    // Menus/comments have no name; match on prompt only.
    for (const re of query.regexes) {
      const hit = (node.name ? re.test(name) : false) || re.test(prompt);
      if (!hit) { return false; }
    }
    return true;
  }

  /**
   * Jump-to search: symbols (by name) first, then choices, menus, comments (matching
   * menuconfig's result ordering). Returns node ids in rank order.
   */
  search(query: CompiledQuery): NodeId[] {
    if (query.error || query.regexes.length === 0) { return []; }
    const out: NodeId[] = [];
    const scan = (ids: NodeId[]) => {
      for (const id of ids) {
        const node = this.nodes.get(id);
        if (node && this.matches(node, query)) { out.push(id); }
      }
    };
    scan(this.searchOrder.syms);
    scan(this.searchOrder.choices);
    scan(this.searchOrder.menus);
    scan(this.searchOrder.comments);
    return out;
  }

  /** Ancestor ids from the node up to (but excluding) the root, nearest-first. */
  ancestors(id: NodeId): NodeId[] {
    const out: NodeId[] = [];
    let p = this.nodes.get(id)?.parent ?? null;
    while (p !== null) { out.push(p); p = this.nodes.get(p)?.parent ?? null; }
    return out;
  }
}

/**
 * Compile a jump-to/filter query using menuconfig semantics: lowercase, split on
 * whitespace into multiple regexes that must ALL match (AND). Invalid regex -> error.
 */
export function compileQuery(raw: string): CompiledQuery {
  const parts = raw.toLowerCase().split(/\s+/).filter(Boolean);
  const regexes: RegExp[] = [];
  for (const p of parts) {
    try {
      regexes.push(new RegExp(p));
    } catch (e) {
      return { regexes: [], error: `Bad regular expression: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { regexes };
}
