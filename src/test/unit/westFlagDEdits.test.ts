import { strict as assert } from 'assert';

import {
  addWestFlagDValue,
  removeWestFlagDValue,
  replaceWestFlagDValue,
  tokenizeWestArgs,
  westFlagDName,
} from '../../utils/zephyr/westArgUtils';

// The -D flag list edits the Applications view and the configure tool share.
describe('west -D flag list edits', () => {
  it('names a flag with or without a value', () => {
    assert.equal(westFlagDName('CONFIG_DEBUG=y'), 'CONFIG_DEBUG');
    assert.equal(westFlagDName('FOO'), 'FOO');
    assert.equal(westFlagDName('A=b=c'), 'A');
  });

  it('adds a normalized flag once', () => {
    const flags = ['A=1'];
    assert.equal(addWestFlagDValue(flags, '-DB=2'), true);
    assert.equal(addWestFlagDValue(flags, '-- -DB=2'), false);
    assert.equal(addWestFlagDValue(flags, '   '), false);
    assert.deepEqual(flags, ['A=1', 'B=2']);
  });

  it('replaces a flag in place, and drops it instead when the new value already exists', () => {
    const flags = ['A=1', 'B=2'];
    assert.equal(replaceWestFlagDValue(flags, 'A=1', '-DA=3'), true);
    assert.deepEqual(flags, ['A=3', 'B=2']);
    assert.equal(replaceWestFlagDValue(flags, 'A=3', 'B=2'), true);
    assert.deepEqual(flags, ['B=2']);
    assert.equal(replaceWestFlagDValue(flags, 'missing', 'C=1'), false);
  });

  it('removes a flag matched exactly', () => {
    const flags = ['A=1', 'B=2'];
    assert.equal(removeWestFlagDValue(flags, 'A'), false);
    assert.equal(removeWestFlagDValue(flags, 'A=1'), true);
    assert.deepEqual(flags, ['B=2']);
  });

  it('splits west arguments into words, honouring quotes', () => {
    assert.deepEqual(tokenizeWestArgs('-o=-j4 --domain "my app" \'x y\''), ['-o=-j4', '--domain', 'my app', 'x y']);
    assert.deepEqual(tokenizeWestArgs(undefined), []);
  });
});
