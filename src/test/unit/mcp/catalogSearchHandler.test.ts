// search_zephyr_catalog's handler with the workspace and west replaced by a
// fake listing, so what it does with the agent's arguments is tested on its own.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findTool } from '../../../mcp/core/catalog';
import { BoardEntry, CatalogEntry, CatalogKind, SampleEntry, SnippetEntry } from '../../../mcp/core/catalogSearch';
import { McpToolError } from '../../../mcp/core/errors';
import { AuditBag, ToolContext } from '../../../mcp/core/toolSpec';
import { TtlCache } from '../../../mcp/core/ttlCache';
import { CatalogListing, CatalogResult } from '../../../mcp/host/catalogSources';
import { searchZephyrCatalog } from '../../../mcp/host/handlers/catalogSearch';
import { HostDeps } from '../../../mcp/host/handlers/deps';
import { useUiGuard } from './uiGuard';

interface ListCall { kind: CatalogKind; refresh: boolean }

function harness(listing: Promise<CatalogResult> | ((refresh: boolean) => Promise<CatalogResult>), over: Partial<ToolContext<HostDeps>> = {}, wait = 45) {
  const calls: ListCall[] = [];
  const workspace = { rootUri: { fsPath: '/ws' }, version: '4.4.1' };
  const services = {
    resolveWestWorkspace: async (westWorkspace?: string, appPath?: string) => {
      if (westWorkspace === '/elsewhere') {
        throw new McpToolError('PATH_OUTSIDE_WORKSPACE', 'outside');
      }
      return { workspace, ...(appPath ? { app: { appRootPath: appPath } } : {}) };
    },
    catalog: {
      list: (kind: CatalogKind, _ws: unknown, _app: unknown, refresh: boolean) => {
        calls.push({ kind, refresh });
        return typeof listing === 'function' ? listing(refresh) : listing;
      },
    },
  };
  const ctx: ToolContext<HostDeps> = {
    signal: new AbortController().signal,
    progress: () => undefined,
    client: { name: 'test' },
    deps: { services, defaultWaitSeconds: wait } as unknown as HostDeps,
    tool: findTool('search_zephyr_catalog')!,
    startedAt: Date.now(),
    audit: {} as AuditBag,
    ...over,
  };
  return { calls, run: (args: Record<string, unknown>) => searchZephyrCatalog(args, ctx) as Promise<Record<string, unknown>> };
}

function result(entries: CatalogEntry[], over: Partial<CatalogResult> = {}): Promise<CatalogResult> {
  return Promise.resolve({ source: 'west boards', entries, skippedRoots: [], cached: false, listedAt: 0, ...over });
}

const board = (name: string, vendor?: string): BoardEntry => ({
  name, identifiers: [name], qualifiers: [], revisions: [], dir: `/ws/zephyr/boards/${name}`, ...(vendor ? { vendor } : {}),
});

const BOARDS = [
  board('nrf52840dk', 'nordic'), board('nrf5340dk', 'nordic'), board('nrf9160dk', 'nordic'),
  board('nucleo_f401re', 'st'), board('qemu_x86'),
];

async function rejectsWith(pending: Promise<unknown>, code: string): Promise<McpToolError> {
  let caught: unknown;
  try {
    await pending;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof McpToolError, `expected ${code}, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  return caught;
}

describe('mcp/host/handlers/catalogSearch', () => {
  useUiGuard();

  it('refuses an unknown kind before listing anything', async () => {
    const { calls, run } = harness(result(BOARDS));
    await rejectsWith(run({ kind: 'widget' }), 'INVALID_ARGUMENT');
    assert.equal(calls.length, 0);
  });

  it('refuses vendor for a kind that has none', async () => {
    const { calls, run } = harness(result([]));
    const error = await rejectsWith(run({ kind: 'snippet', vendor: 'nordic' }), 'INVALID_ARGUMENT');
    assert.match(error.message, /board.*shield/);
    assert.equal(calls.length, 0);
  });

  it('refuses a pattern the matcher cannot take', async () => {
    const { run } = harness(result(BOARDS));
    await rejectsWith(run({ kind: 'board', pattern: 'x'.repeat(201) }), 'INVALID_ARGUMENT');
  });

  it('passes on an error from resolving the workspace', async () => {
    const { run } = harness(result(BOARDS));
    await rejectsWith(run({ kind: 'board', west_workspace: '/elsewhere' }), 'PATH_OUTSIDE_WORKSPACE');
  });

  it('filters in-process, pages, and says where the next page starts', async () => {
    const { calls, run } = harness(result(BOARDS, { cached: true, listedAt: Date.UTC(2026, 0, 2) }));
    const out = await run({ kind: 'board', pattern: 'nrf*dk', limit: 2, refresh: true });
    assert.deepEqual(calls, [{ kind: 'board', refresh: true }], 'the pattern never reaches the listing');
    assert.equal(out.total_matches, 3);
    assert.deepEqual((out.items as BoardEntry[]).map(b => b.name), ['nrf52840dk', 'nrf5340dk']);
    assert.equal(out.next_offset, 2);
    assert.equal(out.west_workspace, '/ws');
    assert.equal(out.zephyr_version, '4.4.1');
    assert.equal(out.source, 'west boards');
    assert.equal(out.cached, true);
    assert.equal(out.listed_at, '2026-01-02T00:00:00.000Z');

    const last = await run({ kind: 'board', pattern: 'nrf*dk', limit: 2, offset: 2 });
    assert.deepEqual((last.items as BoardEntry[]).map(b => b.name), ['nrf9160dk']);
    assert.equal(last.next_offset, undefined);
  });

  it('keeps one vendor', async () => {
    const { run } = harness(result(BOARDS));
    const out = await run({ kind: 'board', vendor: 'ST' });
    assert.deepEqual((out.items as BoardEntry[]).map(b => b.name), ['nucleo_f401re']);
  });

  it('clamps limit and offset the schema would already refuse', async () => {
    const { run } = harness(result(BOARDS));
    const out = await run({ kind: 'board', limit: 0, offset: -3 });
    assert.equal((out.items as BoardEntry[]).length, 1);
    assert.equal(out.next_offset, 1);
  });

  describe('samples and tests', () => {
    let tmp: string;

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-catalog-handler-'));
    });

    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    function sample(name: string, kind: 'sample' | 'test', title?: string): SampleEntry {
      const dir = path.join(tmp, name);
      fs.mkdirSync(dir, { recursive: true });
      if (title) {
        fs.writeFileSync(path.join(dir, 'sample.yaml'), `sample:\n  name: ${title}\n  description: About ${title}.\n`);
      }
      return { name, kind, path: dir, display_path: `zephyr/samples/${name}`, source: 'zephyr' };
    }

    it('splits one listing by kind and reads titles only for the page returned', async () => {
      const entries = [sample('blinky', 'sample', 'Blinky'), sample('button', 'sample', 'Button'), sample('kernel_common', 'test')];
      const { calls, run } = harness(result(entries, { source: 'filesystem' }));

      const samples = await run({ kind: 'sample', limit: 1 });
      assert.equal(samples.total_matches, 2);
      assert.deepEqual(samples.items, [{ ...entries[0], title: 'Blinky', description: 'About Blinky.' }]);
      assert.equal((entries[0] as SampleEntry).title, undefined, 'the cached listing is never modified');

      const tests = await run({ kind: 'test' });
      assert.deepEqual((tests.items as SampleEntry[]).map(t => t.name), ['kernel_common']);
      assert.deepEqual(calls.map(c => c.kind), ['sample', 'test']);
    });

    it('explains where it looked when nothing matches', async () => {
      const { run } = harness(result([sample('blinky', 'sample')], { source: 'filesystem' }));
      const out = await run({ kind: 'sample', pattern: 'lvgl' });
      assert.equal(out.total_matches, 0);
      assert.match(String(out.note), /other modules are not listed/);
    });
  });

  it('says what a snippet flagged needs_snippet_root needs before west build -S finds it', async () => {
    const snippets: SnippetEntry[] = [
      { name: 'cdc-acm-console', dir: '/ws/zephyr/snippets/cdc-acm-console', root: '/ws/zephyr' },
      { name: 'foo', dir: '/app/snippets/foo', root: '/app', needs_snippet_root: true },
    ];
    const { run } = harness(result(snippets, { source: 'filesystem' }));
    const flagged = await run({ kind: 'snippet', app_path: '/app' });
    assert.match(String(flagged.note), /needs_snippet_root.*SNIPPET_ROOT/);
    const plain = await run({ kind: 'snippet', app_path: '/app', pattern: 'cdc*' });
    assert.equal(plain.note, undefined, 'no note when no returned match is flagged');
  });

  it('reports configured board roots it had to leave out', async () => {
    const { run } = harness(result(BOARDS, { skippedRoots: ['/odd;root'] }));
    const out = await run({ kind: 'board' });
    assert.match(String(out.note), /\/odd;root/);
  });

  it('passes on a listing failure as its tool error', async () => {
    const { run } = harness(() => Promise.reject(new McpToolError('DEPENDENCY_MISSING', 'no west shields')));
    await rejectsWith(run({ kind: 'shield' }), 'DEPENDENCY_MISSING');
  });

  describe('waiting on a slow listing', () => {
    it('answers TIMEOUT when the wait budget is spent, and leaves the listing running', async () => {
      let finished = false;
      const slow = new Promise<CatalogResult>(resolve => setTimeout(() => {
        finished = true;
        resolve({ source: 'west boards', entries: BOARDS, skippedRoots: [], cached: false, listedAt: 0 });
      }, 50));
      // The call arrived 60 seconds ago, so the 45 second budget is gone.
      const { run } = harness(slow, { startedAt: Date.now() - 60_000 });
      const error = await rejectsWith(run({ kind: 'board' }), 'TIMEOUT');
      assert.equal(error.retryable, true);
      assert.match(error.hint ?? '', /search_zephyr_catalog again/);
      await slow;
      assert.ok(finished, 'giving up on the wait does not stop the listing');
    });

    it('tells a timed-out refresh to retry without refresh, so the retry reuses the run', async () => {
      // The real cache in front of a west run the test finishes by hand.
      const cache = new TtlCache<CatalogListing>({ ttlMs: 600_000, maxEntries: 4 });
      await cache.get('boards', async () => ({ source: 'west boards', entries: [board('old_board')], skippedRoots: [] }));
      let runs = 0;
      let finishRun: () => void = () => undefined;
      const westRun = () => {
        runs++;
        return new Promise<CatalogListing>(resolve => {
          finishRun = () => resolve({ source: 'west boards', entries: BOARDS, skippedRoots: [] });
        });
      };
      const list = async (refresh: boolean): Promise<CatalogResult> => {
        const got = await cache.get('boards', westRun, refresh);
        return { ...got.value, cached: got.cached, listedAt: got.storedAt };
      };

      // The refresh call has no budget left, as when west takes longer than the wait.
      const slow = harness(list, { startedAt: Date.now() - 60_000 });
      const timeout = await rejectsWith(slow.run({ kind: 'board', refresh: true }), 'TIMEOUT');
      assert.match(timeout.message, /without refresh/);
      assert.match(timeout.hint ?? '', /without refresh/);

      // The retry the hint asks for, made while west still runs, joins that run.
      const retry = harness(list).run({ kind: 'board' });
      await new Promise(resolve => setImmediate(resolve));
      finishRun();
      const joined = await retry;
      assert.deepEqual((joined.items as BoardEntry[]).map(b => b.name), BOARDS.map(b => b.name), 'never the list the refresh replaces');
      assert.equal(joined.cached, false);
      assert.equal(runs, 1);

      // And once the run has finished, the next retry is served from the cache.
      const later = await harness(list).run({ kind: 'board' });
      assert.equal(later.cached, true);
      assert.equal(later.total_matches, BOARDS.length);
      assert.equal(runs, 1, 'west ran once for the refresh and its retries');
    });

    it('still waits for a listing when the wait setting is 0', async () => {
      const soon = new Promise<CatalogResult>(resolve => setTimeout(() => resolve({
        source: 'filesystem', entries: [], skippedRoots: [], cached: false, listedAt: 0,
      }), 30));
      const { run } = harness(soon, {}, 0);
      const out = await run({ kind: 'snippet' });
      assert.equal(out.total_matches, 0);
    });

    it('stops waiting when the call is cancelled', async () => {
      const controller = new AbortController();
      const { run } = harness(new Promise<CatalogResult>(() => undefined), { signal: controller.signal });
      const pending = run({ kind: 'board' });
      setTimeout(() => controller.abort(), 10);
      await rejectsWith(pending, 'TIMEOUT');
    });
  });
});
