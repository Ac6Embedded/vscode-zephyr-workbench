// The readers of what the adapters and gdb answer: addresses in an evaluate
// result, the bytes of gdb's x command, the registers of "info registers",
// and the variable budget that keeps one inspect answer small.

import { strict as assert } from 'assert';
import { expandVariables, parseAddress, parseGdbHexBytes, parseInfoRegisters } from '../../../debug/dapRequests';

describe('debug/dapRequests', () => {
  it('reads the address an evaluate result names', () => {
    assert.equal(parseAddress('(uint8_t *) 0x20000100 <buffer>'), 0x20000100);
    assert.equal(parseAddress('0x20000100 <buffer>'), 0x20000100);
    assert.equal(parseAddress('536871168'), 536871168);
    assert.equal(parseAddress('{a = 1}'), undefined);
    assert.equal(parseAddress('"text"'), undefined);
  });

  it('reads the bytes of gdb x/<n>xb, across lines, with the start address', () => {
    const text = [
      '0x20000000 <buf>:\t0x01\t0x02\t0x03\t0x04\t0x05\t0x06\t0x07\t0x08',
      '0x20000008 <buf+8>:\t0xaa\t0xbb',
      'some other line',
    ].join('\n');
    assert.deepEqual(parseGdbHexBytes(text), { address: 0x20000000, bytes: [1, 2, 3, 4, 5, 6, 7, 8, 0xaa, 0xbb] });
    assert.deepEqual(parseGdbHexBytes('Cannot access memory at address 0x0'), { bytes: [] });
  });

  it('reads the registers of info registers', () => {
    const text = [
      'r0             0x20001000          536875008',
      'sp             0x20002000          0x20002000 <z_main_stack+2048>',
      'pc             0x8000abc           0x8000abc <main+12>',
      'xpsr           0x61000000          1627389952',
      '-exec info registers',
      'The target is not running.',
    ].join('\n');
    assert.deepEqual(parseInfoRegisters(text), [
      { name: 'r0', value: '0x20001000' },
      { name: 'sp', value: '0x20002000' },
      { name: 'pc', value: '0x8000abc' },
      { name: 'xpsr', value: '0x61000000' },
    ]);
  });

  it('keeps an expansion within its budget, and says how many were left out', async () => {
    const variables: Record<number, unknown[]> = {
      1: Array.from({ length: 10 }, (_, i) => ({ name: `v${i}`, value: String(i), variablesReference: i === 0 ? 2 : 0 })),
      2: [{ name: 'inner', value: 'x'.repeat(50), variablesReference: 0 }],
    };
    const session = {
      type: 'cppdbg',
      customRequest: async (_command: string, args: { variablesReference: number }) => ({ variables: variables[args.variablesReference] }),
    };
    const budget = { items: 5, valueChars: 10, perLevel: 4 };
    const out = await expandVariables(session, 1, 1, budget);
    assert.deepEqual(out.map(entry => entry.name), ['v0', 'v1', 'v2', 'v3', '...']);
    assert.equal(out[0].children?.[0].value, `${'x'.repeat(10)}...`);
    assert.equal(out[4].value, '6 more not shown');
    assert.equal(budget.items, 0);
  });
});
