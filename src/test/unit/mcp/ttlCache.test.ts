import { strict as assert } from 'assert';
import { TtlCache } from '../../../mcp/core/ttlCache';

/** A load the test settles by hand, counting how often it was started. */
function manualLoad<T>() {
  let starts = 0;
  const pending: { resolve: (value: T) => void; reject: (error: Error) => void }[] = [];
  return {
    get starts() { return starts; },
    load: () => {
      starts++;
      return new Promise<T>((resolve, reject) => pending.push({ resolve, reject }));
    },
    resolve: (value: T) => pending.shift()?.resolve(value),
    reject: (error: Error) => pending.shift()?.reject(error),
  };
}

/** Let the cache's internal promise chain run. */
const tick = () => new Promise(resolve => setImmediate(resolve));

describe('mcp/core/ttlCache', () => {
  let now = 0;
  const cache = () => new TtlCache<string>({ ttlMs: 1000, maxEntries: 2, now: () => now });

  beforeEach(() => {
    now = 1_000_000;
  });

  it('starts one load for concurrent callers of the same key', async () => {
    const c = cache();
    const source = manualLoad<string>();
    const first = c.get('k', source.load);
    const second = c.get('k', source.load);
    await tick();
    source.resolve('boards');
    const [a, b] = await Promise.all([first, second]);
    assert.equal(source.starts, 1, 'ten agent calls in a row must start west once');
    assert.equal(a.value, 'boards');
    assert.equal(b.value, 'boards');
    assert.equal(a.cached, false, 'a caller that waited on the load did not get a cached value');
  });

  it('serves the stored value while it is fresh and reloads once it is stale', async () => {
    const c = cache();
    let loads = 0;
    const load = async () => `v${++loads}`;
    assert.deepEqual(await c.get('k', load), { value: 'v1', cached: false, storedAt: now });
    now += 999;
    const hit = await c.get('k', load);
    assert.equal(hit.value, 'v1');
    assert.equal(hit.cached, true);
    assert.equal(hit.storedAt, now - 999, 'the age of a cached value is visible');
    now += 1;
    assert.equal((await c.get('k', load)).value, 'v2');
  });

  it('skips the stored value on refresh, but joins a load already running', async () => {
    const c = cache();
    await c.get('k', async () => 'old');
    assert.equal((await c.get('k', async () => 'new', true)).value, 'new');

    const source = manualLoad<string>();
    const running = c.get('k2', source.load);
    const refreshed = c.get('k2', source.load, true);
    await tick();
    source.resolve('fresh');
    assert.equal((await refreshed).value, 'fresh');
    await running;
    assert.equal(source.starts, 1);
  });

  it('gives a plain call made during a refresh the refreshed value, not the one it replaces', async () => {
    const c = cache();
    await c.get('k', async () => 'old');
    const source = manualLoad<string>();
    const refreshed = c.get('k', source.load, true);
    // An agent retrying a timed-out refresh without refresh, as it is told to.
    const retry = c.get('k', source.load);
    await tick();
    source.resolve('new');
    assert.equal((await refreshed).value, 'new');
    const joined = await retry;
    assert.equal(joined.value, 'new', 'the old value must not come back while the refresh runs');
    assert.equal(joined.cached, false);
    assert.equal(source.starts, 1, 'the retry joins the refresh instead of starting another load');
    const after = await c.get('k', source.load);
    assert.deepEqual([after.value, after.cached], ['new', true], 'once stored, the refreshed value is served from the cache');
    assert.equal(source.starts, 1);
  });

  it('does not bring back the value a failed refresh was meant to replace', async () => {
    const c = cache();
    await c.get('k', async () => 'old');
    await assert.rejects(c.get('k', async () => { throw new Error('west failed'); }, true), /west failed/);
    const next = await c.get('k', async () => 'retried');
    assert.equal(next.value, 'retried', 'the next call loads again');
  });

  it('never stores a failed load, so the next call tries again', async () => {
    const c = cache();
    await assert.rejects(c.get('k', async () => { throw new Error('west failed'); }), /west failed/);
    assert.equal((await c.get('k', async () => 'ok')).value, 'ok');
  });

  it('recovers from a load that throws before returning a promise', async () => {
    const c = cache();
    const throwing = (): Promise<string> => { throw new Error('no env script'); };
    await assert.rejects(c.get('k', throwing), /no env script/);
    assert.equal((await c.get('k', async () => 'ok')).value, 'ok', 'no stuck load is left behind');
  });

  it('drops the oldest key once it holds too many', async () => {
    const c = cache();
    let loads = 0;
    const load = async () => `v${++loads}`;
    await c.get('a', load);
    await c.get('b', load);
    await c.get('c', load);
    assert.equal((await c.get('b', load)).cached, true);
    assert.equal((await c.get('c', load)).cached, true);
    assert.equal((await c.get('a', load)).cached, false, '"a" was evicted');
  });
});
