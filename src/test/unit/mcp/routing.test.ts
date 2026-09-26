import { strict as assert } from 'assert';
import { z } from 'zod';
import { describeCandidates, routeOfCall, routingTargetOf, scoreWindow, selectWindow } from '../../../mcp/core/routing';
import { WindowRecord } from '../../../mcp/core/registry';
import { ToolMeta } from '../../../mcp/core/toolSpec';

function win(id: string, over: Partial<WindowRecord> = {}): WindowRecord {
  return {
    schema: 1,
    windowId: id,
    pid: 1000,
    platform: 'linux',
    hostname: 'host',
    port: 40000,
    url: `http://127.0.0.1:40000/mcp`,
    token: 't',
    workspaceFolders: [],
    appRoots: [],
    westWorkspaces: [],
    ide: { name: 'Visual Studio Code', version: '1.138.0', uriScheme: 'vscode' },
    nodeExecPath: '/code',
    extensionVersion: '4.2.1',
    catalogVersion: '1',
    startedAt: '2026-09-22T10:00:00.000Z',
    focusedAt: '2026-09-22T10:00:00.000Z',
    heartbeatAt: '2026-09-22T10:00:00.000Z',
    ...over,
  };
}

const LINUX = 'linux' as NodeJS.Platform;

describe('mcp/core/routing', () => {
  describe('scoreWindow', () => {
    it('scores a target inside a known folder above a folder inside the target', () => {
      const inside = scoreWindow(win('a', { appRoots: ['/ws/apps/blinky'] }), '/ws/apps/blinky/src', LINUX);
      const contains = scoreWindow(win('b', { appRoots: ['/ws/apps/blinky'] }), '/ws', LINUX);
      assert.ok(inside.score >= 3, 'target inside a known folder should score at least 3');
      assert.ok(contains.score >= 2 && contains.score < 3, 'known folder inside target should score in the 2 band');
      assert.ok(inside.score > contains.score);
    });

    it('prefers the longest matching folder so a nested app beats its west workspace', () => {
      const record = win('a', { westWorkspaces: ['/ws'], appRoots: ['/ws/apps/blinky'] });
      const scored = scoreWindow(record, '/ws/apps/blinky', LINUX);
      assert.equal(scored.matchedPath, '/ws/apps/blinky');
    });

    it('scores zero when nothing is related', () => {
      assert.equal(scoreWindow(win('a', { appRoots: ['/ws/a'] }), '/elsewhere', LINUX).score, 0);
    });
  });

  describe('selectWindow', () => {
    it('reports none when no window is live', () => {
      assert.equal(selectWindow([], { target: '/ws' }).reason, 'none');
    });

    it('honours an explicit pin', () => {
      const a = win('a', { appRoots: ['/ws/a'] });
      const b = win('b', { appRoots: ['/ws/b'] });
      const result = selectWindow([a, b], { pinnedWindowId: 'b', target: '/ws/a' });
      assert.equal(result.reason, 'pinned');
      assert.equal(result.chosen?.windowId, 'b');
    });

    it('ignores a stale pin instead of failing', () => {
      const a = win('a', { appRoots: ['/ws/a'] });
      const result = selectWindow([a], { pinnedWindowId: 'gone', target: '/ws/a', platform: LINUX });
      assert.equal(result.reason, 'path');
      assert.equal(result.chosen?.windowId, 'a');
    });

    it('routes by path when several windows are open', () => {
      const a = win('a', { appRoots: ['/ws/a'] });
      const b = win('b', { appRoots: ['/ws/b'] });
      const result = selectWindow([a, b], { target: '/ws/b/src/main.c', platform: LINUX });
      assert.equal(result.chosen?.windowId, 'b');
      assert.equal(result.reason, 'path');
    });

    it('uses the only live window when nothing matches', () => {
      const a = win('a', { appRoots: ['/ws/a'] });
      const result = selectWindow([a], { target: '/somewhere/else', platform: LINUX });
      assert.equal(result.reason, 'single');
      assert.equal(result.chosen?.windowId, 'a');
    });

    it('refuses the single-window shortcut in strict mode', () => {
      const a = win('a', { appRoots: ['/ws/a'] });
      const result = selectWindow([a], { target: '/elsewhere', mode: 'strict', platform: LINUX });
      assert.equal(result.reason, 'ambiguous');
      assert.equal(result.chosen, undefined);
    });

    it('never falls back to focus for a mutating call', () => {
      const a = win('a', { appRoots: ['/ws/a'], focusedAt: '2026-09-22T12:00:00.000Z' });
      const b = win('b', { appRoots: ['/ws/b'] });
      const result = selectWindow([a, b], { target: '/elsewhere', allowFocusFallback: false, platform: LINUX });
      assert.equal(result.reason, 'ambiguous');
      assert.equal(result.candidates.length, 2);
    });

    it('falls back to the most recently focused window for a read-only call', () => {
      const a = win('a', { appRoots: ['/ws/a'], focusedAt: '2026-09-22T10:00:00.000Z' });
      const b = win('b', { appRoots: ['/ws/b'], focusedAt: '2026-09-22T12:00:00.000Z' });
      const result = selectWindow([a, b], { target: '/elsewhere', allowFocusFallback: true, platform: LINUX });
      assert.equal(result.reason, 'focused');
      assert.equal(result.chosen?.windowId, 'b');
    });

    it('treats several windows under the target as ambiguous for a build', () => {
      // An agent started at "/" or $HOME contains every window. Picking the
      // longest folder is a guess, and a build must never run on a guess.
      const a = win('a', { appRoots: ['/home/u/ws-one/app'] });
      const b = win('b', { appRoots: ['/home/u/ws-two/longer/app'] });
      const mutating = selectWindow([a, b], { target: '/home/u', allowFocusFallback: false, platform: LINUX });
      assert.equal(mutating.reason, 'ambiguous');
      assert.equal(mutating.chosen, undefined);
      const reading = selectWindow([a, b], { target: '/home/u', allowFocusFallback: true, platform: LINUX });
      assert.ok(reading.chosen, 'a read may still pick the best guess');
    });

    it('still routes a build when exactly one window lies under the target', () => {
      const a = win('a', { appRoots: ['/home/u/ws-one/app'] });
      const b = win('b', { appRoots: ['/elsewhere/app'] });
      const result = selectWindow([a, b], { target: '/home/u', allowFocusFallback: false, platform: LINUX });
      assert.equal(result.chosen?.windowId, 'a');
    });

    it('breaks a path tie by most recent focus', () => {
      const a = win('a', { appRoots: ['/ws'], focusedAt: '2026-09-22T10:00:00.000Z' });
      const b = win('b', { appRoots: ['/ws'], focusedAt: '2026-09-22T12:00:00.000Z' });
      const result = selectWindow([a, b], { target: '/ws/app', platform: LINUX });
      assert.equal(result.chosen?.windowId, 'b');
    });

    it('sends a call on the machine to the most recently focused window when no path matches', () => {
      const a = win('a', { appRoots: ['/ws/a'], focusedAt: '2026-09-22T12:00:00.000Z' });
      const b = win('b', { appRoots: ['/ws/b'], focusedAt: '2026-09-22T10:00:00.000Z' });
      const result = selectWindow([a, b], { target: '/elsewhere', machineScope: true, platform: LINUX });
      assert.equal(result.reason, 'focused');
      assert.equal(result.chosen?.windowId, 'a');
    });

    it('still prefers the window that holds the agent folder for a call on the machine', () => {
      const a = win('a', { appRoots: ['/ws/a'], focusedAt: '2026-09-22T12:00:00.000Z' });
      const b = win('b', { appRoots: ['/ws/b'], focusedAt: '2026-09-22T10:00:00.000Z' });
      const result = selectWindow([a, b], { target: '/ws/b/src', machineScope: true, platform: LINUX });
      assert.equal(result.reason, 'path');
      assert.equal(result.chosen?.windowId, 'b');
    });

    it('keeps strict routing strict for a call on the machine', () => {
      const a = win('a', { appRoots: ['/ws/a'] });
      const b = win('b', { appRoots: ['/ws/b'] });
      assert.equal(selectWindow([a], { target: '/elsewhere', machineScope: true, mode: 'strict', platform: LINUX }).reason, 'ambiguous');
      assert.equal(selectWindow([a, b], { target: '/elsewhere', machineScope: true, mode: 'strict', platform: LINUX }).reason, 'ambiguous');
    });

    it('keeps a live pin for a call on the machine', () => {
      const a = win('a', { appRoots: ['/ws/a'], focusedAt: '2026-09-22T12:00:00.000Z' });
      const b = win('b', { appRoots: ['/ws/b'] });
      const result = selectWindow([a, b], { pinnedWindowId: 'b', machineScope: true, platform: LINUX });
      assert.equal(result.reason, 'pinned');
      assert.equal(result.chosen?.windowId, 'b');
    });
  });

  describe('routingTargetOf', () => {
    const tool = (over: Partial<ToolMeta> = {}): ToolMeta => ({
      name: 't', title: 't', summary: 't', description: 't', inputSchema: z.object({}),
      annotations: { openWorldHint: false }, category: 'action', ...over,
    });

    it('routes by app_path when the tool says nothing', () => {
      assert.equal(routingTargetOf(tool(), { app_path: '/ws/a', path: '/soc/uart' }), '/ws/a');
      assert.equal(routingTargetOf(tool(), { path: '/soc/uart' }), undefined, 'a devicetree path never routes');
    });

    it('takes the first routing argument that holds a path, in catalog order', () => {
      const meta = tool({ routeBy: ['app_path', 'west_workspace', 'parent_dir'] });
      assert.equal(routingTargetOf(meta, { west_workspace: '/ws', parent_dir: '/apps' }), '/ws');
      assert.equal(routingTargetOf(meta, { app_path: '', west_workspace: 7, parent_dir: '/apps' }), '/apps',
        'empty strings and non-strings are skipped');
      assert.equal(routingTargetOf(meta, {}), undefined);
      assert.equal(routingTargetOf(meta, undefined), undefined);
    });
  });

  describe('routeOfCall', () => {
    const tool = (over: Partial<ToolMeta> = {}): ToolMeta => ({
      name: 't', title: 't', summary: 't', description: 't', inputSchema: z.object({ app_path: z.string().optional(), west_workspace: z.string().optional() }),
      annotations: { openWorldHint: false }, category: 'action', ...over,
    });

    it('names for hints only the routing arguments the tool takes', () => {
      assert.deepEqual(routeOfCall(tool({ routeBy: ['west_workspace'] }), {}).routeBy, ['west_workspace']);
      assert.deepEqual(routeOfCall(tool(), {}).routeBy, ['app_path']);
      assert.deepEqual(routeOfCall(tool({ inputSchema: z.object({ job_id: z.string() }) }), {}).routeBy, [],
        'the app_path default is no way to name a folder for a tool without app_path');
    });

    it('is machine-wide only for a call that names no folder', () => {
      const meta = tool({ routeBy: ['west_workspace'], machineScope: { create: true } });
      assert.deepEqual(routeOfCall(meta, { action: 'create' }), { target: undefined, machineScope: true, routeBy: ['west_workspace'] });
      assert.equal(routeOfCall(meta, { action: 'create', west_workspace: '/ws' }).machineScope, false);
      assert.equal(routeOfCall(meta, { action: 'update' }).machineScope, false);
    });
  });

  it('describes candidates for the ambiguity message', () => {
    const text = describeCandidates([win('a', { workspaceFolders: ['/ws/a'] }), win('b')]);
    assert.match(text, /a \(\/ws\/a\)/);
    assert.match(text, /b \(no folder\)/);
  });
});
