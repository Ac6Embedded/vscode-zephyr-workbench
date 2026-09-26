import { strict as assert } from 'assert';
import { KeyedMutex } from '../../../mcp/core/keyedMutex';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

describe('mcp/core/keyedMutex', () => {
  it('runs work under one key one at a time, in arrival order', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const job = (name: string) => mutex.run('settings', async () => {
      events.push(`${name} start`);
      await tick();
      events.push(`${name} end`);
      return name;
    });
    const results = await Promise.all([job('a'), job('b'), job('c')]);
    assert.deepEqual(results, ['a', 'b', 'c']);
    assert.deepEqual(events, ['a start', 'a end', 'b start', 'b end', 'c start', 'c end']);
  });

  it('lets work under different keys overlap', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const job = (key: string) => mutex.run(key, async () => {
      events.push(`${key} start`);
      await tick();
      events.push(`${key} end`);
    });
    await Promise.all([job('one'), job('two')]);
    assert.deepEqual(events.slice(0, 2).sort(), ['one start', 'two start']);
  });

  it('keeps going after a failure, and forgets a key once nothing waits on it', async () => {
    const mutex = new KeyedMutex();
    const failed = mutex.run('k', async () => { throw new Error('boom'); });
    const next = mutex.run('k', async () => 'after');
    assert.ok(mutex.isBusy('k'));
    await assert.rejects(failed, /boom/);
    assert.equal(await next, 'after');
    assert.equal(mutex.isBusy('k'), false);
  });
});
