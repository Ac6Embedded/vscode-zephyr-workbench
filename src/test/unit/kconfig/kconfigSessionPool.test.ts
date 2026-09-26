import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { KconfigLaunchSpec } from '../../../utils/kconfig/kconfigEnvExtractor';
import { KconfigSessionPool, PoolClient } from '../../../utils/kconfig/kconfigSessionPool';
import type { StartKconfigServerOptions } from '../../../utils/kconfig/kconfigSession';

class FakeClient implements PoolClient {
  state = 'ready';
  recentStderr: string[] = [];
  calls: string[] = [];
  disposed = false;
  constructor(readonly dir: string) {}
  async call<T>(method: string): Promise<T> {
    this.calls.push(method);
    return {} as T;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.state = 'disposed';
  }
}

function makeBuild(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'zephyr', 'kconfig'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'build.ninja'), 'rules');
  fs.writeFileSync(path.join(dir, 'zephyr', '.config'), 'CONFIG_A=y\n');
  fs.writeFileSync(path.join(dir, 'zephyr', 'edt.pickle'), 'x');
  fs.writeFileSync(path.join(dir, 'zephyr', 'kconfig', 'sources.txt'), 'Kconfig\n');
  return dir;
}

/** Rewrite a file with a new size, so its fingerprint changes whatever the clock resolution. */
function touch(file: string): void {
  fs.appendFileSync(file, '# changed\n');
}

describe('KconfigSessionPool', () => {
  let tmp: string;
  let started: FakeClient[];
  let pools: KconfigSessionPool[];

  const pool = (over: Partial<ConstructorParameters<typeof KconfigSessionPool>[0]> = {}) => {
    const created = new KconfigSessionPool({
      serverScriptPath: '/unused/kconfig_server.py',
      start: async (o: StartKconfigServerOptions) => {
        const client = new FakeClient(o.buildDir);
        started.push(client);
        o.onCreated?.(client as never, {} as KconfigLaunchSpec);
        return { client, spec: { configPath: path.join(o.buildDir, 'zephyr', '.config') } as KconfigLaunchSpec };
      },
      ...over,
    });
    pools.push(created);
    return created;
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zwb-kpool-'));
    started = [];
    pools = [];
  });
  afterEach(async () => {
    await Promise.all(pools.map(p => p.closeAll()));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('starts a session once and reuses it while the build is unchanged', async () => {
    const dir = makeBuild(tmp, 'a');
    const p = pool();
    const colds: boolean[] = [];
    let starting = 0;
    for (let i = 0; i < 3; i++) {
      await p.use(dir, { onStart: () => { starting++; } }, async s => { colds.push(s.cold); });
    }
    assert.deepEqual(colds, [true, false, false]);
    assert.equal(starting, 1);
    assert.equal(started.length, 1);
  });

  it('runs one use of a session at a time', async () => {
    const dir = makeBuild(tmp, 'a');
    const p = pool();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const first = p.use(dir, {}, async () => {
      events.push('first:start');
      await new Promise<void>(resolve => { releaseFirst = resolve; });
      events.push('first:end');
    });
    await new Promise(resolve => setImmediate(resolve));
    const second = p.use(dir, {}, async () => { events.push('second'); });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(events, ['first:start'], 'the second use waits for the first');
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(events, ['first:start', 'first:end', 'second']);
  });

  it('reloads .config when only it changed, and restarts when the build was reconfigured', async () => {
    const dir = makeBuild(tmp, 'a');
    const p = pool();
    await p.use(dir, {}, async () => undefined);
    touch(path.join(dir, 'zephyr', '.config'));
    const cold = await p.use(dir, {}, async s => s.cold);
    assert.equal(cold, false);
    assert.deepEqual(started[0].calls, ['load_config']);
    assert.equal(started.length, 1);

    touch(path.join(dir, 'build.ninja'));
    assert.equal(await p.use(dir, {}, async s => s.cold), true);
    assert.equal(started.length, 2);
    assert.ok(started[0].disposed, 'the stale session is stopped');
  });

  it('keeps at most maxSessions alive, stopping the least recently used', async () => {
    const a = makeBuild(tmp, 'a');
    const b = makeBuild(tmp, 'b');
    const c = makeBuild(tmp, 'c');
    const p = pool({ maxSessions: 2 });
    await p.use(a, {}, async () => undefined);
    await p.use(b, {}, async () => undefined);
    await p.use(a, {}, async () => undefined);
    await p.use(c, {}, async () => undefined);
    assert.equal(p.size, 2);
    const byDir = (dir: string) => started.find(client => client.dir === dir) as FakeClient;
    assert.ok(byDir(b).disposed, 'b was used least recently');
    assert.ok(!byDir(a).disposed);
    assert.ok(!byDir(c).disposed);
  });

  it('stops a session left idle', async () => {
    const dir = makeBuild(tmp, 'a');
    const p = pool({ idleMs: 10 });
    await p.use(dir, {}, async () => undefined);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(p.size, 0);
    assert.ok(started[0].disposed);
  });

  it('stops every session on closeAll, including one still in use once it finishes', async () => {
    const a = makeBuild(tmp, 'a');
    const b = makeBuild(tmp, 'b');
    const p = pool();
    await p.use(a, {}, async () => undefined);
    let release!: () => void;
    const running = p.use(b, {}, async () => { await new Promise<void>(resolve => { release = resolve; }); });
    await new Promise(resolve => setTimeout(resolve, 10));
    await p.closeAll();
    const clientOf = (dir: string) => started.find(client => client.dir === dir) as FakeClient;
    assert.ok(clientOf(a).disposed);
    assert.ok(!clientOf(b).disposed, 'a session in use is not pulled from under its caller');
    release();
    await running;
    assert.ok(clientOf(b).disposed);
    // The pool stays usable afterwards.
    assert.equal(await p.use(a, {}, async s => s.cold), true);
  });

  it('restarts a crashed session, but not in a loop', async () => {
    const dir = makeBuild(tmp, 'a');
    let now = 1_000_000;
    const p = pool({ now: () => now });
    await p.use(dir, {}, async () => undefined);
    for (let i = 0; i < 3; i++) {
      started[started.length - 1].state = 'crashed';
      assert.equal(await p.use(dir, {}, async s => s.cold), true);
      now += 1000;
    }
    started[started.length - 1].state = 'crashed';
    await assert.rejects(p.use(dir, {}, async () => undefined), (e: { code?: string }) => e.code === 'crash-loop');
    now += 61_000;
    assert.equal(await p.use(dir, {}, async s => s.cold), true, 'the budget recovers after a minute');
  });

  it('keeps refusing a crash-looping server until the window has passed, not only on the next call', async () => {
    const dir = makeBuild(tmp, 'a');
    let now = 1_000_000;
    const p = pool({ now: () => now });
    // A server that dies on every request.
    const crashing = async (s: { client: PoolClient }) => { (s.client as FakeClient).state = 'crashed'; };
    await p.use(dir, {}, crashing);
    for (let i = 0; i < 3; i++) {
      await p.use(dir, {}, crashing);
    }
    assert.equal(started.length, 4);
    for (let i = 0; i < 3; i++) {
      await assert.rejects(p.use(dir, {}, async () => undefined), (e: { code?: string }) => e.code === 'crash-loop');
    }
    assert.equal(started.length, 4, 'no server is started while the loop is refused');
    now += 61_000;
    assert.equal(await p.use(dir, {}, async s => s.cold), true);
    assert.equal(started.length, 5);
  });

  describe('closeWithin', () => {
    it('stops the sessions inside a folder before it resolves, and only those', async () => {
      const inside = makeBuild(path.join(tmp, 'app', 'build'), 'primary');
      const outside = makeBuild(tmp, 'other');
      const p = pool();
      await p.use(inside, {}, async () => undefined);
      await p.use(outside, {}, async () => undefined);
      const reopen = await p.closeWithin(path.join(tmp, 'app', 'build'));
      const clientOf = (dir: string) => started.find(client => client.dir === dir) as FakeClient;
      assert.ok(clientOf(inside).disposed, 'the server has exited when closeWithin resolves');
      assert.ok(!clientOf(outside).disposed);
      assert.equal(p.size, 1);
      reopen();
    });

    it('refuses to start a session inside the folder until it is reopened', async () => {
      const dir = makeBuild(tmp, 'a');
      const p = pool();
      const reopen = await p.closeWithin(dir);
      await assert.rejects(p.use(dir, {}, async () => undefined), (e: { code?: string }) => e.code === 'closing');
      assert.equal(started.length, 0);
      reopen();
      reopen();
      assert.equal(await p.use(dir, {}, async s => s.cold), true);
    });

    it('waits for a running use, then stops its session instead of keeping it idle', async () => {
      const dir = makeBuild(tmp, 'a');
      const p = pool();
      let release!: () => void;
      const running = p.use(dir, {}, async () => { await new Promise<void>(resolve => { release = resolve; }); });
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.deepEqual(p.inUseWithin(tmp), [dir]);
      let closed = false;
      const closing = p.closeWithin(tmp).then(reopen => { closed = true; return reopen; });
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(closed, false, 'a call in progress is not cut off');
      release();
      await running;
      const reopen = await closing;
      assert.ok(started[0].disposed);
      assert.equal(p.size, 0);
      assert.deepEqual(p.inUseWithin(tmp), []);
      reopen();
    });
  });

  it('disposes a client whose start failed and keeps its last words', async () => {
    const dir = makeBuild(tmp, 'a');
    let leftover: FakeClient | undefined;
    const p = pool({
      start: async o => {
        leftover = new FakeClient(o.buildDir);
        leftover.recentStderr = ['Traceback', 'ImportError: kconfiglib'];
        o.onCreated?.(leftover as never, {} as KconfigLaunchSpec);
        throw Object.assign(new Error('Server exited during startup'), { code: 'startup-crash' });
      },
    });
    await assert.rejects(p.use(dir, {}, async () => undefined),
      (e: { stderrTail?: string[] }) => !!e.stderrTail && e.stderrTail[1] === 'ImportError: kconfiglib');
    assert.ok(leftover?.disposed);
    assert.equal(p.size, 0);
  });
});
