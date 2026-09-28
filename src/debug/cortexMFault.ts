// Decodes the fault status registers of an ARMv7-M or ARMv8-M Mainline core
// (Cortex-M3, M4, M7, M33, M55, M85) into plain text, so an
// agent reading a HardFault does not have to know the bit layout. Pure: the
// words come from a memory read of the System Control Block.

/** Where the registers live in the System Control Block. */
export const FAULT_REGISTERS = {
  CFSR: 0xE000ED28,
  HFSR: 0xE000ED2C,
  DFSR: 0xE000ED30,
  MMFAR: 0xE000ED34,
  BFAR: 0xE000ED38,
} as const;

/** One read covers CFSR through BFAR: five consecutive 32-bit words. */
export const FAULT_BLOCK_START = FAULT_REGISTERS.CFSR;
export const FAULT_BLOCK_LENGTH = 20;

export interface FaultWords {
  cfsr: number;
  hfsr: number;
  mmfar: number;
  bfar: number;
}

export interface FaultBit {
  register: 'MMFSR' | 'BFSR' | 'UFSR' | 'HFSR';
  bit: string;
  meaning: string;
}

export interface DecodedFault {
  cfsr: string;
  hfsr: string;
  mmfar: string;
  bfar: string;
  /** Every bit set, in register order. */
  bits: FaultBit[];
  /** The data address of a MemManage fault, when MMARVALID says it holds one. */
  memmanage_address?: string;
  /** The data address of a precise BusFault, when BFARVALID says it holds one. */
  bus_fault_address?: string;
  /** One line per bit, then the addresses, for a person to read. */
  summary: string;
}

interface BitSpec {
  mask: number;
  register: FaultBit['register'];
  bit: string;
  meaning: string;
}

// CFSR bits 7:0 are the MemManage Fault Status Register, 15:8 the BusFault
// one and 31:16 the UsageFault one; the masks are positions in CFSR.
const CFSR_BITS: readonly BitSpec[] = [
  { mask: 1 << 0, register: 'MMFSR', bit: 'IACCVIOL', meaning: 'MemManage: an instruction fetch from a location the MPU or the execute-never attribute forbids.' },
  { mask: 1 << 1, register: 'MMFSR', bit: 'DACCVIOL', meaning: 'MemManage: a load or store to a location the MPU forbids.' },
  { mask: 1 << 3, register: 'MMFSR', bit: 'MUNSTKERR', meaning: 'MemManage: unstacking on exception return hit a forbidden location.' },
  { mask: 1 << 4, register: 'MMFSR', bit: 'MSTKERR', meaning: 'MemManage: stacking on exception entry hit a forbidden location, often a stack overflow into an MPU guard.' },
  { mask: 1 << 5, register: 'MMFSR', bit: 'MLSPERR', meaning: 'MemManage: lazy saving of the floating-point state hit a forbidden location.' },
  { mask: 1 << 7, register: 'MMFSR', bit: 'MMARVALID', meaning: 'MMFAR holds the address of the MemManage fault.' },
  { mask: 1 << 8, register: 'BFSR', bit: 'IBUSERR', meaning: 'BusFault: an instruction fetch failed on the bus.' },
  { mask: 1 << 9, register: 'BFSR', bit: 'PRECISERR', meaning: 'BusFault: a data access failed, and the stacked PC points at the instruction that made it.' },
  { mask: 1 << 10, register: 'BFSR', bit: 'IMPRECISERR', meaning: 'BusFault: a buffered write failed; the stacked PC is somewhere after the instruction that made it.' },
  { mask: 1 << 11, register: 'BFSR', bit: 'UNSTKERR', meaning: 'BusFault: unstacking on exception return failed.' },
  { mask: 1 << 12, register: 'BFSR', bit: 'STKERR', meaning: 'BusFault: stacking on exception entry failed, often a stack pointer outside RAM.' },
  { mask: 1 << 13, register: 'BFSR', bit: 'LSPERR', meaning: 'BusFault: lazy saving of the floating-point state failed.' },
  { mask: 1 << 15, register: 'BFSR', bit: 'BFARVALID', meaning: 'BFAR holds the address of the BusFault.' },
  { mask: 1 << 16, register: 'UFSR', bit: 'UNDEFINSTR', meaning: 'UsageFault: the core executed an undefined instruction.' },
  { mask: 1 << 17, register: 'UFSR', bit: 'INVSTATE', meaning: 'UsageFault: an instruction ran in an invalid state, usually a branch to an address with bit 0 clear (ARM state).' },
  { mask: 1 << 18, register: 'UFSR', bit: 'INVPC', meaning: 'UsageFault: an exception return loaded an invalid EXC_RETURN or PC.' },
  { mask: 1 << 19, register: 'UFSR', bit: 'NOCP', meaning: 'UsageFault: a coprocessor instruction ran with the coprocessor off, such as an FPU instruction without the FPU enabled.' },
  { mask: 1 << 20, register: 'UFSR', bit: 'STKOF', meaning: 'UsageFault: a stack pointer went below its stack limit register (ARMv8-M).' },
  { mask: 1 << 24, register: 'UFSR', bit: 'UNALIGNED', meaning: 'UsageFault: an unaligned access with unaligned trapping on, or an unaligned multiple or exclusive access.' },
  { mask: 1 << 25, register: 'UFSR', bit: 'DIVBYZERO', meaning: 'UsageFault: an integer division by zero with division trapping on.' },
];

const HFSR_BITS: readonly BitSpec[] = [
  { mask: 1 << 1, register: 'HFSR', bit: 'VECTTBL', meaning: 'HardFault: reading the vector table failed during exception processing.' },
  { mask: 1 << 30, register: 'HFSR', bit: 'FORCED', meaning: 'HardFault: a configurable fault (MemManage, BusFault or UsageFault) was escalated, because it is disabled or could not run; CFSR says which.' },
  // Bit 31 does not fit a signed shift, so it is spelled out.
  { mask: 0x80000000, register: 'HFSR', bit: 'DEBUGEVT', meaning: 'HardFault: a debug event, such as a breakpoint instruction, happened with halting debug off.' },
];

const hex32 = (value: number) => `0x${(value >>> 0).toString(16).padStart(8, '0')}`;

/** The four words from the 20 bytes at FAULT_BLOCK_START, little endian. */
export function faultWordsFromBytes(bytes: ArrayLike<number>): FaultWords {
  if (bytes.length < FAULT_BLOCK_LENGTH) {
    throw new Error(`The fault registers need ${FAULT_BLOCK_LENGTH} bytes, and ${bytes.length} were read.`);
  }
  const word = (offset: number) =>
    ((bytes[offset] & 0xff) | ((bytes[offset + 1] & 0xff) << 8) | ((bytes[offset + 2] & 0xff) << 16) | ((bytes[offset + 3] & 0xff) << 24)) >>> 0;
  return { cfsr: word(0), hfsr: word(4), mmfar: word(12), bfar: word(16) };
}

export function decodeCortexMFault(words: FaultWords): DecodedFault {
  const cfsr = words.cfsr >>> 0;
  const hfsr = words.hfsr >>> 0;
  const bits: FaultBit[] = [];
  for (const spec of CFSR_BITS) {
    if ((cfsr & spec.mask) >>> 0 !== 0) {
      bits.push({ register: spec.register, bit: spec.bit, meaning: spec.meaning });
    }
  }
  for (const spec of HFSR_BITS) {
    if ((hfsr & spec.mask) >>> 0 !== 0) {
      bits.push({ register: spec.register, bit: spec.bit, meaning: spec.meaning });
    }
  }
  const mmValid = (cfsr & (1 << 7)) !== 0;
  const bfValid = (cfsr & (1 << 15)) !== 0;
  const lines = bits.map(bit => `${bit.register}.${bit.bit}: ${bit.meaning}`);
  if (mmValid) {
    lines.push(`MemManage fault address (MMFAR): ${hex32(words.mmfar)}.`);
  }
  if (bfValid) {
    lines.push(`BusFault address (BFAR): ${hex32(words.bfar)}.`);
  }
  if (bits.length === 0) {
    lines.push('No fault status bit is set: the core has not faulted since these registers were last cleared.');
  }
  return {
    cfsr: hex32(cfsr),
    hfsr: hex32(hfsr),
    mmfar: hex32(words.mmfar),
    bfar: hex32(words.bfar),
    bits,
    ...(mmValid ? { memmanage_address: hex32(words.mmfar) } : {}),
    ...(bfValid ? { bus_fault_address: hex32(words.bfar) } : {}),
    summary: lines.join('\n'),
  };
}

/**
 * Whether fault decoding applies to a build, from its .config text: a
 * Cortex-M core with the configurable fault registers. ARMv6-M and ARMv8-M
 * Baseline cores (M0, M0+, M1, M23) have no CFSR, so reading it means nothing.
 */
export function faultDecodingSupport(dotConfig: string | undefined): { supported: true } | { supported: false; reason: string } {
  if (dotConfig === undefined) {
    return { supported: false, reason: 'The build has no .config, so whether it targets a Cortex-M core is unknown.' };
  }
  const set = (name: string) => new RegExp(`^${name}=y$`, 'm').test(dotConfig);
  if (!set('CONFIG_CPU_CORTEX_M')) {
    return { supported: false, reason: 'Fault decoding covers Cortex-M cores only, and this build does not set CONFIG_CPU_CORTEX_M.' };
  }
  if (set('CONFIG_ARMV6_M_ARMV8_M_BASELINE')) {
    return {
      supported: false,
      reason: 'This build targets an ARMv6-M or ARMv8-M Baseline core (such as Cortex-M0, M0+ or M23), which has no configurable fault status registers to decode.',
    };
  }
  return { supported: true };
}
