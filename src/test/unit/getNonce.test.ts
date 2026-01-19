import { strict as assert } from 'assert';

import { getNonce } from '../../utilities/getNonce';

describe('getNonce', () => {
  afterEach(() => {
    // restore in case a test overrides it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyGlobal = globalThis as any;
    if (anyGlobal.__origRandom) {
      Math.random = anyGlobal.__origRandom;
      delete anyGlobal.__origRandom;
    }
  });

  it('returns a 32-char alphanumeric string', () => {
    const n = getNonce();
    assert.equal(n.length, 32);
    assert.match(n, /^[A-Za-z0-9]{32}$/);
  });

  it('is deterministic with a mocked Math.random', () => {
    // Force Math.random() to always pick index 0 => 'A'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyGlobal = globalThis as any;
    anyGlobal.__origRandom = Math.random;
    Math.random = () => 0;

    const n = getNonce();
    assert.equal(n, 'A'.repeat(32));
  });
});
