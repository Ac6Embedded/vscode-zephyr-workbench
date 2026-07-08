import { strict as assert } from 'assert';
import { KcStore, compileQuery } from '../../../webview/kconfigmanager/store';
import type { KcNode, KcTreeInit, NodeId } from '../../../utils/kconfig/kconfigRpcTypes';

// Small helper to build a KcNode with sane defaults.
function mk(id: NodeId, partial: Partial<KcNode> & { kind: KcNode['kind'] }): KcNode {
  return {
    id,
    key: partial.key ?? `k${id}`,
    kind: partial.kind,
    name: partial.name,
    type: partial.type ?? (partial.kind === 'symbol' ? 'bool' : 'unknown'),
    prompt: partial.prompt,
    isMenuconfig: partial.isMenuconfig ?? (partial.kind === 'menu' || partial.kind === 'choice'),
    parent: partial.parent ?? null,
    children: partial.children ?? [],
    defLocation: { file: 'Kconfig', line: id },
    visible: partial.visible ?? true,
    promptVisible: partial.promptVisible ?? partial.visible ?? true,
    strValue: partial.strValue ?? '',
    triValue: partial.triValue ?? 0,
    assignable: partial.assignable ?? [],
    userValueSet: partial.userValueSet ?? true,
    isYModeChoiceSym: partial.isYModeChoiceSym ?? false,
    choiceSelected: partial.choiceSelected ?? false,
    selectionPrompt: partial.selectionPrompt ?? null,
    range: partial.range ?? null,
  };
}

// Tree:
//   M1 (menu, visible)
//     A (sym, visible)
//     B (sym, INVISIBLE) -> C (sym, visible)      // invisible parent of a visible child
//   M2 (menu, INVISIBLE, no visible descendants)
//     D (sym, invisible)
//   E (sym, menuconfig, visible)
//     F (sym, visible)
function buildStore(): KcStore {
  const nodes: KcNode[] = [
    mk(0, { kind: 'menu', prompt: 'Menu One', children: [1, 2], name: undefined }),
    mk(1, { kind: 'symbol', name: 'A', prompt: 'Alpha', parent: 0, visible: true }),
    mk(2, { kind: 'symbol', name: 'B', prompt: 'Beta', parent: 0, visible: false, promptVisible: false, children: [3] }),
    mk(3, { kind: 'symbol', name: 'C', prompt: 'Gamma', parent: 2, visible: true }),
    mk(4, { kind: 'menu', prompt: 'Menu Two', children: [5], visible: false }),
    mk(5, { kind: 'symbol', name: 'D', prompt: 'Delta', parent: 4, visible: false, promptVisible: false }),
    mk(6, { kind: 'symbol', name: 'E', prompt: 'Epsilon', isMenuconfig: true, children: [7], visible: true }),
    mk(7, { kind: 'symbol', name: 'F', prompt: 'Zeta', parent: 6, visible: true }),
  ];
  const init: KcTreeInit = {
    generation: 1,
    rootChildren: [0, 4, 6],
    nodes,
    searchOrder: { syms: [1, 2, 3, 5, 7], choices: [], menus: [0, 4], comments: [] },
    configPath: '/x/.config',
    minconfigPath: '/x/.config',
    dirty: false,
    warnings: [],
    envSource: 'ninja',
  };
  return new KcStore(init);
}

describe('KcStore flatten engines', () => {
  it('full tree, collapsed, no show-all: shows visible top-level nodes only', () => {
    const s = buildStore();
    const rows = s.flattenFull({ showAll: false, expanded: new Set() });
    assert.deepEqual(rows.map((r) => r.id), [0, 6]); // M1, E ; M2 hidden (invisible, no visible desc)
  });

  it('full tree, expand M1: invisible B is shown because it has a visible child', () => {
    const s = buildStore();
    const rows = s.flattenFull({ showAll: false, expanded: new Set(['k0']) });
    assert.deepEqual(rows.map((r) => r.id), [0, 1, 2, 6]); // M1, A, B(shown), E ; C only if B expanded
  });

  it('full tree, expand M1 + B: reveals C', () => {
    const s = buildStore();
    const rows = s.flattenFull({ showAll: false, expanded: new Set(['k0', 'k2']) });
    assert.deepEqual(rows.map((r) => [r.id, r.depth]), [[0, 0], [1, 1], [2, 1], [3, 2], [6, 0]]);
  });

  it('full tree, show-all: reveals invisible M2 and D', () => {
    const s = buildStore();
    const rows = s.flattenFull({ showAll: true, expanded: new Set(['k0', 'k4']) });
    assert.deepEqual(rows.map((r) => r.id), [0, 1, 2, 4, 5, 6]);
  });

  it('hasShownChildren reflects whether expanding shows anything', () => {
    const s = buildStore();
    assert.equal(s.hasShownChildren(0, false), true);  // M1 has visible A
    assert.equal(s.hasShownChildren(4, false), false); // M2 children all invisible
    assert.equal(s.hasShownChildren(4, true), true);   // show-all reveals D
  });

});

describe('KcStore search', () => {
  it('matches by name or prompt, AND across whitespace-split regexes', () => {
    const s = buildStore();
    // 'a' matches name A and prompts Beta/Gamma/Delta/Zeta (all contain 'a').
    assert.deepEqual(s.search(compileQuery('a')), [1, 2, 3, 5, 7]);
    // AND semantics: 'a m' requires both -> only Gamma (id 3, has 'a' and 'm').
    assert.deepEqual(s.search(compileQuery('a m')), [3]);
  });

  it('name-anchored search ranks symbols before menus', () => {
    const s = buildStore();
    const res = s.search(compileQuery('e'));
    // symbols first (in searchOrder), then menus
    const firstMenuIdx = res.findIndex((id) => s.get(id)!.kind === 'menu');
    const lastSymIdx = res.map((id) => s.get(id)!.kind).lastIndexOf('symbol');
    if (firstMenuIdx >= 0) { assert.ok(lastSymIdx < firstMenuIdx); }
  });

  it('reports a bad regular expression', () => {
    const q = compileQuery('[unterminated');
    assert.ok(q.error);
    assert.match(q.error!, /Bad regular expression/);
  });

  it('empty query yields no matches', () => {
    const s = buildStore();
    assert.deepEqual(s.search(compileQuery('   ')), []);
  });
});

describe('KcStore applyDelta', () => {
  it('updates dynamic fields and dirty, and re-derives visibility', () => {
    const s = buildStore();
    // Make B visible via a delta; now it should appear without needing the child rule.
    s.applyDelta({ generation: 1, dirty: true, changes: [{ id: 2, visible: true, strValue: 'y', triValue: 2 }] });
    assert.equal(s.get(2)!.visible, true);
    assert.equal(s.get(2)!.strValue, 'y');
    assert.equal(s.dirty, true);
    const rows = s.flattenFull({ showAll: false, expanded: new Set(['k0']) });
    assert.deepEqual(rows.map((r) => r.id), [0, 1, 2, 6]);
  });

  it('ancestors walks up to the root', () => {
    const s = buildStore();
    assert.deepEqual(s.ancestors(3), [2, 0]);
  });
});
