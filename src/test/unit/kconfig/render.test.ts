// Server-side render smoke test for the Kconfig Manager React components. Exercises the
// real Row/ValueControl/InfoPane render paths for every node kind without needing a DOM,
// catching render-time crashes and verifying the glyph-to-control mapping produces markup.

import { strict as assert } from 'assert';

// app.tsx constructs an RPC client at module load which touches browser globals; stub
// them before requiring it. (require, unlike import, is not hoisted above this.)
(global as any).window = { addEventListener() { /* noop */ }, removeEventListener() { /* noop */ } };
(global as any).acquireVsCodeApi = () => ({ postMessage() {}, getState() { return {}; }, setState() {} });
(global as any).ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KcStore } from '../../../webview/kconfigmanager/store';
import type { KcNode, KcTreeInit, KcNodeInfo, NodeId } from '../../../utils/kconfig/kconfigRpcTypes';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../../../webview/kconfigmanager/app');

function mk(id: NodeId, p: Partial<KcNode> & { kind: KcNode['kind'] }): KcNode {
  return {
    id, key: `k${id}`, kind: p.kind, name: p.name,
    type: p.type ?? 'unknown', prompt: p.prompt, isMenuconfig: p.isMenuconfig ?? false,
    parent: p.parent ?? null, children: p.children ?? [], defLocation: { file: 'Kconfig', line: id },
    visible: p.visible ?? true, promptVisible: p.promptVisible ?? true, strValue: p.strValue ?? '',
    triValue: p.triValue ?? 0, assignable: p.assignable ?? [], userValueSet: p.userValueSet ?? true,
    isYModeChoiceSym: p.isYModeChoiceSym ?? false, choiceSelected: p.choiceSelected ?? false,
    selectionPrompt: p.selectionPrompt ?? null, range: p.range ?? null,
  };
}

function storeWithAllKinds(): { store: KcStore; rows: { id: NodeId; depth: number }[] } {
  const nodes: KcNode[] = [
    mk(0, { kind: 'menu', prompt: 'A Menu', children: [] }),
    mk(1, { kind: 'comment', prompt: 'A comment' }),
    mk(2, { kind: 'symbol', name: 'BOOLSYM', prompt: 'Bool option', type: 'bool', triValue: 2, assignable: [0, 2], userValueSet: false }),
    mk(3, { kind: 'symbol', name: 'TRISYM', prompt: 'Tri option', type: 'tristate', triValue: 1, assignable: [0, 1, 2] }),
    mk(4, { kind: 'symbol', name: 'LOCKEDSYM', prompt: 'Locked', type: 'bool', triValue: 2, assignable: [2] }),
    mk(5, { kind: 'choice', prompt: 'A choice', triValue: 2, selectionPrompt: 'Member A', children: [6, 7] }),
    mk(6, { kind: 'symbol', name: 'MEMBERA', prompt: 'Member A', type: 'bool', isYModeChoiceSym: true, choiceSelected: true, assignable: [2] }),
    mk(7, { kind: 'symbol', name: 'MEMBERB', prompt: 'Member B', type: 'bool', isYModeChoiceSym: true, choiceSelected: false, assignable: [2] }),
    mk(8, { kind: 'symbol', name: 'STRSYM', prompt: 'A string', type: 'string', strValue: 'hello' }),
    mk(9, { kind: 'symbol', name: 'INTSYM', prompt: 'An int', type: 'int', strValue: '42', range: { low: '0', high: '255' } }),
    mk(10, { kind: 'symbol', name: 'HEXSYM', prompt: 'A hex', type: 'hex', strValue: '0x1000', range: { low: '0x0', high: '0xffff' } }),
    mk(11, { kind: 'symbol', name: 'INVIS', prompt: 'Invisible', type: 'bool', visible: false, assignable: [] }),
  ];
  const init: KcTreeInit = {
    generation: 1, rootChildren: nodes.map((n) => n.id), nodes,
    searchOrder: { syms: [], choices: [], menus: [], comments: [] },
    configPath: '/x/.config', minconfigPath: '/x/.config', dirty: false, warnings: [], envSource: 'ninja',
  };
  return { store: new KcStore(init), rows: nodes.map((n, i) => ({ id: n.id, depth: i === 6 || i === 7 ? 1 : 0 })) };
}

const noop = () => {};

describe('Kconfig Manager render (SSR smoke)', () => {
  it('renders the tree with every node kind without throwing', () => {
    const { store, rows } = storeWithAllKinds();
    const html = renderToStaticMarkup(
      React.createElement(app.VirtualTree, {
        store, rows, selected: 2, showName: true, expanded: new Set<string>(),
        onSelect: noop, onToggleExpand: noop, onPrimary: noop, onEnter: noop,
        onSetValue: noop, onDirectSet: noop, onCycle: noop, onKeyDown: noop,
        hasShownChildren: () => true,
      }),
    );
    assert.ok(html.includes('Bool option'), 'bool prompt rendered');
    assert.ok(html.includes('Tri option'), 'tristate prompt rendered');
    assert.ok(html.includes('A choice'), 'choice prompt rendered');
    assert.ok(html.includes('codicon-lock'), 'locked symbol shows a lock glyph');
    assert.ok(html.includes('kc-radio'), 'choice members render radios');
    assert.ok(html.includes('kc-value'), 'string/int/hex render an editable value chip');
    assert.ok(html.includes('>NEW<'), 'unset bool shows a NEW badge');
    assert.ok(html.includes('BOOLSYM'), 'show-name renders CONFIG names');
    assert.ok(html.includes('kc-row invisible') || html.includes('invisible'), 'invisible row styled');
    assert.ok(!html.includes('codicon-close'), 'an unset bool renders an empty box, not an X');
    assert.ok(html.includes('kc-mglyph'), 'tristate m renders the M glyph');
  });

  it('renders the info pane with expr links, blockers and definitions', () => {
    const info: KcNodeInfo = {
      id: 2, name: 'BOOLSYM', typeStr: 'bool', valueStr: 'y',
      prompts: ['Bool option'], helps: ['Some help text.'],
      directDep: { value: 'y', lines: [{ prefix: '', tokens: [{ t: 'sym', name: 'DEP', value: 'y', targetId: 3 }], valueHint: 'y' }] },
      defaults: [{ value: { prefix: '', tokens: [{ t: 'text', text: 'y' }] } }],
      selectImply: [{ title: 'Symbols currently selecting this symbol', syms: [{ name: 'SELECTOR', targetId: 4 }] }],
      blockers: [{ prefix: '', tokens: [{ t: 'sym', name: 'MISSING', value: 'n', targetId: 5 }], valueHint: 'n' }],
      definitions: [{
        file: 'kernel/Kconfig', line: 123, includePath: [{ file: 'Kconfig', line: 1 }],
        menuPath: [{ label: '(Top)' }, { label: 'Kernel', targetId: 0 }], kconfigSrc: 'config BOOLSYM\n\tbool "Bool option"',
      }],
    };
    const html = renderToStaticMarkup(
      React.createElement(app.InfoPane, { info, width: 360, onNavigate: noop, onOpenLocation: noop }),
    );
    assert.ok(html.includes('BOOLSYM'), 'name rendered');
    assert.ok(html.includes('Some help text.'), 'help rendered');
    assert.ok(html.includes('Blocked by'), 'blockers section rendered');
    assert.ok(html.includes('DEP'), 'direct-dep token rendered');
    assert.ok(html.includes('kernel/Kconfig'), 'definition location rendered');
    assert.ok(html.includes('Included via'), 'include chain rendered');
    assert.ok(html.includes('Menu path') || html.includes('Kernel'), 'menu path rendered');
    assert.ok(html.includes('config BOOLSYM'), 'raw kconfig source rendered');
  });

  it('renders the empty info pane', () => {
    const html = renderToStaticMarkup(
      React.createElement(app.InfoPane, { info: undefined, width: 360, onNavigate: noop, onOpenLocation: noop }),
    );
    assert.ok(html.includes('Select a symbol'));
  });
});
