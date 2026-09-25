import { strict as assert } from 'assert';
import type * as vscode from 'vscode';
import { forgetWindowHandoff, rememberWindowHandoff, resolveWindowId } from '../../../mcp/host/registryWriter';

/** An in-memory Memento, enough for resolveWindowId and the handoff. */
function memento(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) as T : fallback),
    update: async (key: string, value: unknown) => {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    },
  } as vscode.Memento;
}

/** One extension host: its own workspace state, and the user-wide state every window shares. */
function hostContext(globalState: vscode.Memento, workspaceState = memento()): vscode.ExtensionContext {
  return { globalState, workspaceState } as unknown as vscode.ExtensionContext;
}

describe('mcp/host/registryWriter window id handoff', () => {
  const now = 1_000_000;

  it('keeps a random id per workspace', () => {
    const context = hostContext(memento());
    const id = resolveWindowId(context, ['/ws/a'], now);
    assert.match(id, /^[0-9a-f]{12}$/);
    assert.equal(resolveWindowId(context, ['/ws/a'], now), id);
  });

  it('hands the id to the host that comes back with the expected folders, over its stored id', async () => {
    const shared = memento();
    await rememberWindowHandoff(hostContext(shared), 'abc123', ['/ws/a', '/ws/b'], 120_000, now);
    const next = hostContext(shared);
    await next.workspaceState.update('zephyr-workbench.mcp.windowId', 'stored99');
    assert.equal(resolveWindowId(next, ['/ws/a/', '/ws/b', '/ws/c'], now + 5_000), 'abc123');
    assert.equal(next.workspaceState.get('zephyr-workbench.mcp.windowId'), 'abc123', 'remembered for the next reload');
    const other = hostContext(shared);
    assert.notEqual(resolveWindowId(other, ['/ws/a', '/ws/b'], now + 6_000), 'abc123', 'taken once only');
  });

  it('ignores a handoff that expired or whose folders are not all there', async () => {
    const shared = memento();
    await rememberWindowHandoff(hostContext(shared), 'abc123', ['/ws/a', '/ws/b'], 120_000, now);
    assert.notEqual(resolveWindowId(hostContext(shared), ['/ws/a'], now + 1_000), 'abc123');
    assert.notEqual(resolveWindowId(hostContext(shared), ['/ws/a', '/ws/b'], now + 120_001), 'abc123');
  });

  it('hands an id left for an empty window to an empty window only', async () => {
    const shared = memento();
    await rememberWindowHandoff(hostContext(shared), 'abc123', [], 120_000, now);
    assert.notEqual(resolveWindowId(hostContext(shared), ['/ws/a'], now + 1_000), 'abc123');
    assert.equal(resolveWindowId(hostContext(shared), [], now + 1_000), 'abc123');
  });

  it('keeps other windows\' handoffs, replaces its own, and can take it back', async () => {
    const shared = memento();
    const context = hostContext(shared);
    await rememberWindowHandoff(context, 'first1', ['/one'], 120_000, now);
    await rememberWindowHandoff(context, 'second', ['/two'], 120_000, now);
    await rememberWindowHandoff(context, 'second', ['/two', '/three'], 120_000, now);
    await forgetWindowHandoff(context, 'first1', now);
    assert.notEqual(resolveWindowId(hostContext(shared), ['/one'], now + 1), 'first1');
    assert.notEqual(resolveWindowId(hostContext(shared), ['/two'], now + 1), 'second', 'the newer handoff replaced the older');
    assert.equal(resolveWindowId(hostContext(shared), ['/two', '/three'], now + 1), 'second');
  });
});
