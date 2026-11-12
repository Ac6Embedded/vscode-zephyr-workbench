// Debugging one core of a multicore target (src/debug/gdbCore.ts): which
// runners have cores, the port the debugger connects to for a core, and the
// core read back from the two ports a launch entry holds.

import { strict as assert } from 'assert';
import { gdbClientPort, isGdbCore, MAX_GDB_CORE, resolveDebuggerPort, runnerHasCores, splitGdbCore } from '../../debug/gdbCore';

describe('gdb core', () => {
  it('knows OpenOCD serves each core on its own port, and no other runner does', () => {
    assert.ok(runnerHasCores('openocd'));
    assert.ok(runnerHasCores('OpenOCD'));
    for (const runner of ['jlink', 'pyocd', 'linkserver', 'stlink_gdbserver', 'qemu', '', undefined]) {
      assert.ok(!runnerHasCores(runner), String(runner));
    }
  });

  it('connects to the server port plus the core', () => {
    assert.equal(gdbClientPort('3333', 0), '3333');
    assert.equal(gdbClientPort('3333', undefined), '3333');
    assert.equal(gdbClientPort('3333', 1), '3334');
    assert.equal(gdbClientPort('3333', 2), '3335');
  });

  it('leaves a port that is not a number as it is, for the form checks to report', () => {
    assert.equal(gdbClientPort('abc', 1), 'abc');
    assert.equal(gdbClientPort('', 1), '');
  });

  it('reads the server port and the core back from the two ports', () => {
    assert.deepEqual(splitGdbCore('3333', '3333'), { serverPort: '3333', clientPort: '3333', core: 0 });
    assert.deepEqual(splitGdbCore('3333', '3334'), { serverPort: '3333', clientPort: '3334', core: 1 });
    assert.deepEqual(splitGdbCore(' 3333 ', '3336'), { serverPort: '3333', clientPort: '3336', core: 3 });
  });

  it('reads no core from ports that do not describe one', () => {
    assert.equal(splitGdbCore(undefined, '3334'), undefined);
    assert.equal(splitGdbCore('3333', undefined), undefined);
    assert.equal(splitGdbCore('abc', '3334'), undefined);
    assert.equal(splitGdbCore('3333', '3332'), undefined, 'below the server');
    assert.equal(splitGdbCore('3333', String(3333 + MAX_GDB_CORE + 1)), undefined, 'too far above it');
    assert.ok(splitGdbCore('3333', String(3333 + MAX_GDB_CORE)));
  });

  it('accepts whole core numbers from 0 to the maximum only', () => {
    for (const core of [0, 1, MAX_GDB_CORE]) {
      assert.ok(isGdbCore(core), String(core));
    }
    for (const core of [-1, 1.5, MAX_GDB_CORE + 1, NaN, '1', undefined, null]) {
      assert.ok(!isGdbCore(core), String(core));
    }
  });

  describe('the port the debugger connects to', () => {
    it('is the one of the core for OpenOCD', () => {
      assert.equal(resolveDebuggerPort('openocd', '3333', '3334'), '3334');
      assert.equal(resolveDebuggerPort('openocd', '3333', '3333'), '3333');
    });

    it('is the server port for OpenOCD when gdbTarget cannot be a core of it', () => {
      assert.equal(resolveDebuggerPort('openocd', '3333', '3000'), '3333');
      assert.equal(resolveDebuggerPort('openocd', '3333', '4000'), '3333');
      assert.equal(resolveDebuggerPort('openocd', '3333', undefined), '3333');
    });

    it('is the server port for a runner without cores, as before', () => {
      assert.equal(resolveDebuggerPort('jlink', '2331', '2332'), '2331');
      assert.equal(resolveDebuggerPort(undefined, '2331', '2332'), '2331');
    });

    it('falls back to gdbTarget, then to nothing, when the arguments name no port', () => {
      assert.equal(resolveDebuggerPort('openocd', undefined, '3334'), '3334');
      assert.equal(resolveDebuggerPort('openocd', undefined, undefined), undefined);
    });
  });
});
