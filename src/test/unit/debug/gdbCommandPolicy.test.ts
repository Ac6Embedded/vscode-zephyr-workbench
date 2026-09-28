// The gdb command policy of debug_app: commands that read the target or talk
// to the gdb server pass, and everything that reaches the host, changes gdb
// itself or could hide a second command is refused.

import { strict as assert } from 'assert';
import { ALLOWED_GDB_COMMANDS, checkGdbCommand, checkGdbExpression, sideEffectReason } from '../../../debug/gdbCommandPolicy';

describe('debug/gdbCommandPolicy', () => {
  const allowed: [string, string][] = [
    ['info registers', 'info'],
    ['i r', 'info'],
    ['info threads', 'info'],
    ['print count', 'print'],
    ['p count', 'print'],
    ['p/x $pc', 'print'],
    ['print/x cfg.flags | 0x4', 'print'],
    ['p $sp', 'print'],
    ['output my_struct', 'output'],
    ['x/8xw 0x20000000', 'x'],
    ['x/s &buffer', 'x'],
    ['bt', 'backtrace'],
    ['backtrace full', 'backtrace'],
    ['frame 2', 'frame'],
    ['f 1', 'frame'],
    ['up', 'up'],
    ['down 2', 'down'],
    ['list main', 'list'],
    ['ptype struct k_thread', 'ptype'],
    ['whatis counter', 'whatis'],
    ['disassemble /r main', 'disassemble'],
    ['set var counter = 3', 'set var'],
    ['set variable counter = 3', 'set var'],
    ['monitor reset halt', 'monitor'],
    ['mon reg', 'monitor'],
    ['  info   breakpoints  ', 'info'],
  ];
  for (const [text, kind] of allowed) {
    it(`allows "${text}"`, () => {
      const result = checkGdbCommand(text);
      assert.ok(result.ok, `refused: ${(result as { reason?: string }).reason}`);
      assert.equal(result.kind, kind);
      assert.equal(result.command, text.trim());
    });
  }

  const refused: [string, RegExp][] = [
    ['shell ls', /host/],
    ['!ls', /host/],
    ['! ls', /host/],
    ['pipe bt | grep main', /host/],
    ['| bt | grep main', /host/],
    ['python print(1)', /host/],
    ['py print(1)', /host/],
    ['pi', /host/],
    ['source /tmp/evil.gdb', /host/],
    ['dump memory /tmp/out 0 100', /host/],
    ['append memory /tmp/out 0 100', /host/],
    ['restore /tmp/out', /host/],
    ['set logging on', /set is allowed only/],
    ['set logging file /tmp/x', /set is allowed only/],
    ['set pagination off', /set is allowed only/],
    ['define hook', /host/],
    ['document hook', /host/],
    ['file /tmp/other.elf', /host/],
    ['exec-file /tmp/other', /host/],
    ['symbol-file /tmp/other.elf', /host/],
    ['add-symbol-file /tmp/other.elf 0', /host/],
    ['load', /host/],
    ['core core.1', /host/],
    ['cd /tmp', /host/],
    ['make all', /host/],
    ['run', /host/],
    ['start', /host/],
    ['kill', /host/],
    ['attach 1', /host/],
    ['detach', /host/],
    ['target remote :3333', /host/],
    ['quit', /host/],
    ['q', /host/],
    ['eval "shell ls"', /host/],
    ['info registers\nshell ls', /more than one line/],
    ['info registers\rshell ls', /more than one line/],
    ['p 1; shell ls', /";"/],
    ['p "a\\" "shell ls"', /backslash/],
    ['p $_shell("ls")', /\$_shell/],
    ['frame apply all p $sp', /frame apply/],
    ['f apply 2 shell ls', /frame apply/],
    ['-data-list-register-values x', /MI/],
    ['monitor', /monitor needs a command/],
    ['call reboot()', /not one of the allowed/],
    ['continue', /not one of the allowed/],
    ['thread apply all bt', /not one of the allowed/],
    ['with print pretty -- shell ls', /not one of the allowed/],
    ['infox', /not one of the allowed/],
    ['', /empty/],
    ['   ', /empty/],
    ['p\u0007x', /control character/],
    ['bt#', /does not start with a gdb command name/],
  ];
  for (const [text, reason] of refused) {
    it(`refuses ${JSON.stringify(text)}`, () => {
      const result = checkGdbCommand(text);
      assert.equal(result.ok, false);
      assert.match((result as { reason: string }).reason, reason);
    });
  }

  it('names the allowed commands for the refusal', () => {
    assert.ok(ALLOWED_GDB_COMMANDS.some(command => command.startsWith('monitor (mon) with reset, halt')));
    assert.ok(ALLOWED_GDB_COMMANDS.includes('set var'));
    assert.ok(!ALLOWED_GDB_COMMANDS.some(command => /shell|python|source/.test(command)));
  });

  describe('monitor', () => {
    for (const text of ['monitor reset halt', 'mon reg', 'monitor halt', 'monitor mdw 0x20000000 4', 'monitor reset', 'monitor go',
      'monitor read32 0x20000000', 'monitor memU32 0x20000000', 'monitor flash info 0', 'monitor resume']) {
      it(`allows "${text}"`, () => {
        const result = checkGdbCommand(text);
        assert.ok(result.ok, `refused: ${(result as { reason?: string }).reason}`);
        assert.equal(result.kind, 'monitor');
      });
    }

    const refusedMonitor: [string, RegExp][] = [
      // pyOCD runs "!" in a host shell and "$" as Python.
      ['monitor !calc.exe', /host through pyOCD/],
      ['monitor  !dir', /host through pyOCD/],
      ['mon $__import__(\'os\').system(\'calc\')', /host through pyOCD/],
      ['monitor dump_image C:/Users/x/Startup/a.bat 0x20000000 64', /touch host files/],
      ['monitor script C:/tmp/evil.tcl', /touch host files/],
      ['monitor savemem 0x20000000 64 C:/tmp/a.bat', /touch host files/],
      ['monitor log_output C:/tmp/a.bat', /touch host files/],
      ['monitor load_image C:/x.bin 0x0', /touch host files/],
      ['monitor shutdown', /touch host files/],
      ['monitor exec SetRTTAddr 0', /touch host files/],
      ['monitor arm semihosting enable', /touch host files/],
      // OpenOCD runs what is inside brackets as a Tcl command.
      ['monitor mdw [exec calc]', /"\["/],
      ['monitor flash write_image erase C:/x.hex', /flash info, banks, list or probe/],
      ['monitor flash read_bank 0 C:/x.bin', /flash info, banks, list or probe/],
      ['monitor flash', /flash info, banks, list or probe/],
      // pyOCD takes a prefix of savemem.
      ['monitor savem 0x0 4 C:/x', /not one of the allowed monitor commands/],
      ['monitor set option x=1', /not one of the allowed monitor commands/],
    ];
    for (const [text, reason] of refusedMonitor) {
      it(`refuses ${JSON.stringify(text)}`, () => {
        const result = checkGdbCommand(text);
        assert.equal(result.ok, false);
        assert.match((result as { reason: string }).reason, reason);
      });
    }
  });

  describe('checkGdbExpression', () => {
    for (const text of ['counter', '*(uint32_t*)0x20000000', 'arr[3].field', '$pc', ' cfg.speed ', 'strcmp(name, "abc") == 0', '-1 + x', '(-counter)']) {
      it(`accepts ${JSON.stringify(text)}`, () => {
        const result = checkGdbExpression(text);
        assert.ok(result.ok, `refused: ${(result as { reason?: string }).reason}`);
        assert.equal(result.expression, text.trim());
      });
    }

    const refusedExpression: [string, RegExp][] = [
      ['$_shell("calc")', /\$_shell runs a command on the host/],
      ['x + $_shell("calc")', /\$_shell/],
      ['$_shell ("calc")', /\$_shell/],
      ['counter\n-var-create - * "$_shell(1)"', /more than one line/],
      ['counter\r-exec shell calc', /more than one line/],
      ['"a\\" + 1', /backslash/],
      ['-var-create - * x', /taken as a gdb command/],
      ['-exec shell calc', /taken as a gdb command/],
      ['-counter', /in parentheses/],
      ['`shell calc', /taken as a gdb command/],
      ['a\u0007', /control character/],
      ['  ', /empty/],
    ];
    for (const [text, reason] of refusedExpression) {
      it(`refuses ${JSON.stringify(text)}`, () => {
        const result = checkGdbExpression(text);
        assert.equal(result.ok, false);
        assert.match((result as { reason: string }).reason, reason);
      });
    }
  });
});

// inspect expressions, memory addresses and breakpoint conditions go to gdb
// in full without asking, so only expressions that read may pass.
describe('debug/gdbCommandPolicy sideEffectReason', () => {
  const writes: [string, RegExp][] = [
    ['g_state = 3', /assignment/],
    ['a += 1', /assignment/],
    ['a-=1', /assignment/],
    ['flags |= 0x4', /assignment/],
    ['x <<= 2', /assignment/],
    ['x >>= 2', /assignment/],
    ['*(uint32_t *)0x20000000 = 0', /assignment/],
    ['x++', /\+\+ and --/],
    ['--x', /\+\+ and --/],
    ['sys_reboot(0)', /function call/],
    ['reset_fn ()', /function call/],
    ['$_shell("ls")', /function call/],
    ['cb_table[1](0)', /function call/],
    ['(*handler)(0)', /function call/],
    ['(my_type)(a + b)', /function call/],
  ];
  for (const [expression, reason] of writes) {
    it(`refuses ${JSON.stringify(expression)}`, () => {
      assert.match(sideEffectReason(expression) ?? '', reason);
    });
  }

  const reads = [
    'a == b', 'a <= b', 'a >= b', 'a != b', 'a<=b', 'sizeof(x)', 'sizeof (struct k_thread)', '_Alignof(int)', '(int)x',
    '*(uint32_t*)0x20000000', '(uint8_t)(a + b)', '(struct k_thread *)(ptr)', '(unsigned long)(x)', '*ptr', 'arr[1].f', 'p->next',
    '"a=b"', '\'=\'', '"f(1)"', 'x - -1', '&buffer', 'cfg.flags & 0x4', '{int}0x20000000', 'buf@4', 'a < b && c > d',
  ];
  for (const expression of reads) {
    it(`lets ${JSON.stringify(expression)} read`, () => {
      assert.equal(sideEffectReason(expression), undefined);
    });
  }
});
