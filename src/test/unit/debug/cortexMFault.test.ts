// The Cortex-M fault decoder, bit by bit: every documented bit of MMFSR,
// BFSR, UFSR and HFSR, the fault addresses only when their valid bit says so,
// the byte order of the register block, and which builds it applies to.

import { strict as assert } from 'assert';
import {
  decodeCortexMFault, FAULT_BLOCK_LENGTH, FAULT_BLOCK_START, FAULT_REGISTERS, faultDecodingSupport, faultWordsFromBytes,
} from '../../../debug/cortexMFault';

const CFSR_BITS: [number, string, string][] = [
  [0, 'MMFSR', 'IACCVIOL'],
  [1, 'MMFSR', 'DACCVIOL'],
  [3, 'MMFSR', 'MUNSTKERR'],
  [4, 'MMFSR', 'MSTKERR'],
  [5, 'MMFSR', 'MLSPERR'],
  [7, 'MMFSR', 'MMARVALID'],
  [8, 'BFSR', 'IBUSERR'],
  [9, 'BFSR', 'PRECISERR'],
  [10, 'BFSR', 'IMPRECISERR'],
  [11, 'BFSR', 'UNSTKERR'],
  [12, 'BFSR', 'STKERR'],
  [13, 'BFSR', 'LSPERR'],
  [15, 'BFSR', 'BFARVALID'],
  [16, 'UFSR', 'UNDEFINSTR'],
  [17, 'UFSR', 'INVSTATE'],
  [18, 'UFSR', 'INVPC'],
  [19, 'UFSR', 'NOCP'],
  [20, 'UFSR', 'STKOF'],
  [24, 'UFSR', 'UNALIGNED'],
  [25, 'UFSR', 'DIVBYZERO'],
];

const HFSR_BITS: [number, string][] = [[1, 'VECTTBL'], [30, 'FORCED'], [31, 'DEBUGEVT']];

const words = (cfsr: number, hfsr = 0, mmfar = 0, bfar = 0) => ({ cfsr, hfsr, mmfar, bfar });

describe('debug/cortexMFault', () => {
  it('reads the System Control Block at the ARMv7-M addresses, in one 20 byte block', () => {
    assert.equal(FAULT_REGISTERS.CFSR, 0xE000ED28);
    assert.equal(FAULT_REGISTERS.HFSR, 0xE000ED2C);
    assert.equal(FAULT_REGISTERS.MMFAR, 0xE000ED34);
    assert.equal(FAULT_REGISTERS.BFAR, 0xE000ED38);
    assert.equal(FAULT_BLOCK_START, 0xE000ED28);
    assert.equal(FAULT_BLOCK_START + FAULT_BLOCK_LENGTH, FAULT_REGISTERS.BFAR + 4);
  });

  for (const [bit, register, name] of CFSR_BITS) {
    it(`decodes CFSR bit ${bit} as ${register}.${name} alone`, () => {
      const decoded = decodeCortexMFault(words((1 << bit) >>> 0));
      assert.deepEqual(decoded.bits.map(entry => `${entry.register}.${entry.bit}`), [`${register}.${name}`]);
      assert.ok(decoded.bits[0].meaning.length > 20, 'every bit says what it means in words');
      assert.ok(decoded.summary.startsWith(`${register}.${name}: `));
    });
  }

  for (const [bit, name] of HFSR_BITS) {
    it(`decodes HFSR bit ${bit} as HFSR.${name} alone`, () => {
      const decoded = decodeCortexMFault(words(0, (bit === 31 ? 0x80000000 : 1 << bit) >>> 0));
      assert.deepEqual(decoded.bits.map(entry => `${entry.register}.${entry.bit}`), [`HFSR.${name}`]);
    });
  }

  it('ignores the reserved bits', () => {
    const reserved = ((1 << 2) | (1 << 6) | (1 << 14) | (1 << 21) | (1 << 22) | (1 << 23) | (1 << 26) | (1 << 31)) >>> 0;
    const hfsrReserved = ((1 << 0) | (1 << 2) | (1 << 29)) >>> 0;
    const decoded = decodeCortexMFault(words(reserved, hfsrReserved));
    assert.deepEqual(decoded.bits, []);
    assert.match(decoded.summary, /No fault status bit is set/);
  });

  it('gives the MemManage address only when MMARVALID is set', () => {
    const without = decodeCortexMFault(words(1 << 1, 0, 0x20001000));
    assert.equal(without.memmanage_address, undefined);
    const valid = decodeCortexMFault(words((1 << 1) | (1 << 7), 0, 0x20001000));
    assert.equal(valid.memmanage_address, '0x20001000');
    assert.match(valid.summary, /MemManage fault address \(MMFAR\): 0x20001000/);
  });

  it('gives the BusFault address only when BFARVALID is set', () => {
    const without = decodeCortexMFault(words(1 << 9, 0, 0, 0x40001234));
    assert.equal(without.bus_fault_address, undefined);
    const valid = decodeCortexMFault(words((1 << 9) | (1 << 15), 0x40000000, 0, 0x40001234));
    assert.equal(valid.bus_fault_address, '0x40001234');
    assert.deepEqual(valid.bits.map(entry => entry.bit), ['PRECISERR', 'BFARVALID', 'FORCED']);
    assert.equal(valid.cfsr, '0x00008200');
    assert.equal(valid.hfsr, '0x40000000');
  });

  it('decodes a forced HardFault from a division by zero', () => {
    const decoded = decodeCortexMFault(words(1 << 25, 1 << 30));
    assert.deepEqual(decoded.bits.map(entry => `${entry.register}.${entry.bit}`), ['UFSR.DIVBYZERO', 'HFSR.FORCED']);
    assert.match(decoded.summary, /division by zero/);
  });

  it('reads the words little endian from the register block', () => {
    const bytes = [
      0x00, 0x82, 0x00, 0x00, // CFSR 0x00008200
      0x00, 0x00, 0x00, 0x40, // HFSR 0x40000000
      0x00, 0x00, 0x00, 0x00, // DFSR
      0x78, 0x56, 0x34, 0x12, // MMFAR 0x12345678
      0x34, 0x12, 0x00, 0x40, // BFAR 0x40001234
    ];
    assert.deepEqual(faultWordsFromBytes(bytes), { cfsr: 0x8200, hfsr: 0x40000000, mmfar: 0x12345678, bfar: 0x40001234 });
    assert.equal(faultWordsFromBytes([...bytes.slice(0, 16), 0xff, 0xff, 0xff, 0xff]).bfar, 0xffffffff);
    assert.throws(() => faultWordsFromBytes(bytes.slice(0, 12)), /need 20 bytes/);
  });

  describe('which builds it applies to', () => {
    it('applies to a Cortex-M Mainline build', () => {
      assert.deepEqual(faultDecodingSupport('CONFIG_ARM=y\nCONFIG_CPU_CORTEX_M=y\nCONFIG_CPU_CORTEX_M4=y\n'), { supported: true });
    });

    it('says fault decoding covers Cortex-M only for another core', () => {
      const answer = faultDecodingSupport('CONFIG_RISCV=y\n# CONFIG_CPU_CORTEX_M is not set\n');
      assert.equal(answer.supported, false);
      assert.match((answer as { reason: string }).reason, /Cortex-M cores only/);
    });

    it('refuses a Baseline core, which has no CFSR', () => {
      const answer = faultDecodingSupport('CONFIG_CPU_CORTEX_M=y\nCONFIG_ARMV6_M_ARMV8_M_BASELINE=y\n');
      assert.equal(answer.supported, false);
      assert.match((answer as { reason: string }).reason, /Cortex-M0/);
    });

    it('says so when the build has no .config', () => {
      assert.equal(faultDecodingSupport(undefined).supported, false);
    });
  });
});
