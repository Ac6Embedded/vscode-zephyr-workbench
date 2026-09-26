import { strict as assert } from 'assert';
import * as path from 'path';
import { parseBuildOutput } from '../../../mcp/jobs/diagnosticsParser';

describe('mcp/jobs/diagnosticsParser', () => {
  it('parses a GCC error with file, line, column and message', () => {
    const out = parseBuildOutput([
      '[12/430] Building C object CMakeFiles/app.dir/src/main.c.obj',
      'FAILED: CMakeFiles/app.dir/src/main.c.obj',
      '/ws/app/src/main.c:12:5: error: \'counter\' undeclared (first use in this function)',
      '   12 |     counter = 1;',
      '      |     ^~~~~~~',
    ].join('\n'));
    // The ninja "FAILED:" line is also an error, but the compiler diagnostic
    // that caused it must be first because that is what the agent acts on.
    const first = out.diagnostics[0];
    assert.equal(first.severity, 'error');
    assert.equal(first.tool, 'gcc');
    assert.equal(first.file, '/ws/app/src/main.c');
    assert.equal(first.line, 12);
    assert.equal(first.column, 5);
    assert.match(first.message, /counter' undeclared/);
    assert.equal(out.errors >= 1, true);
  });

  it('captures the warning flag as a code', () => {
    const out = parseBuildOutput("/ws/app/src/main.c:8:9: warning: unused variable 'x' [-Wunused-variable]");
    assert.equal(out.diagnostics[0].code, '-Wunused-variable');
    assert.equal(out.diagnostics[0].severity, 'warning');
    assert.equal(out.warnings, 1);
  });

  it('attaches a note to the diagnostic it explains', () => {
    const out = parseBuildOutput([
      '/ws/app/src/main.c:12:5: error: too few arguments to function \'foo\'',
      '/ws/app/src/foo.h:3:6: note: declared here',
    ].join('\n'));
    assert.equal(out.diagnostics.length, 1, 'the note must not be a separate diagnostic');
    assert.equal(out.diagnostics[0].related?.length, 1);
    assert.match(out.diagnostics[0].related![0].message, /declared here/);
  });

  it('skips "In file included from" noise', () => {
    const out = parseBuildOutput([
      'In file included from /ws/app/src/main.c:4:',
      '                 from /ws/app/src/other.h:2:',
      '/ws/app/src/main.c:12:5: error: boom',
    ].join('\n'));
    assert.equal(out.diagnostics.length, 1);
  });

  it('parses a linker region overflow, the classic embedded failure', () => {
    const out = parseBuildOutput(
      "/opt/zephyr-sdk/arm-zephyr-eabi/bin/../lib/gcc/arm-zephyr-eabi/12.2.0/../../../../arm-zephyr-eabi/bin/ld: region `FLASH' overflowed by 13480 bytes");
    const d = out.diagnostics[0];
    assert.equal(d.tool, 'ld');
    assert.equal(d.severity, 'error');
    assert.equal(d.code, 'FLASH');
    assert.match(d.message, /overflowed by 13480 bytes/);
  });

  it('parses an undefined reference', () => {
    const out = parseBuildOutput("app.c.obj: in function `main': undefined reference to `missing_fn'");
    assert.equal(out.diagnostics[0].tool, 'ld');
    assert.match(out.diagnostics[0].message, /undefined reference to missing_fn/);
  });

  it('parses a CMake error block and folds its indented body into the message', () => {
    const out = parseBuildOutput([
      'CMake Error at /ws/zephyr/cmake/modules/dts.cmake:243 (message):',
      '  devicetree error: /soc/uart@40011000 has no property nonexistent',
      '',
      '-- Configuring incomplete.',
    ].join('\n'));
    const d = out.diagnostics[0];
    assert.equal(d.file, '/ws/zephyr/cmake/modules/dts.cmake');
    assert.equal(d.line, 243);
    // A devicetree error reported through CMake is retagged to its real source.
    assert.equal(d.tool, 'devicetree');
    assert.match(d.message, /has no property nonexistent/);
  });

  it('parses Kconfig assignment warnings and the abort error', () => {
    const out = parseBuildOutput([
      "warning: CONFIG_SPI_NOR (defined at drivers/flash/Kconfig.nor:8) was assigned the value 'y' but got the value 'n'.",
      'error: Aborting due to Kconfig warnings',
    ].join('\n'));
    const warning = out.diagnostics.find(d => d.severity === 'warning');
    assert.equal(warning?.tool, 'kconfig');
    assert.equal(warning?.code, 'CONFIG_SPI_NOR');
    assert.equal(warning?.file, 'drivers/flash/Kconfig.nor');
    assert.equal(warning?.line, 8);
    assert.ok(out.diagnostics.some(d => d.tool === 'kconfig' && d.severity === 'error'));
  });

  it('parses a dtc syntax error with its line and column', () => {
    const out = parseBuildOutput('Error: /ws/app/boards/nucleo.overlay:14.9-15.2 syntax error');
    const d = out.diagnostics[0];
    assert.equal(d.tool, 'devicetree');
    assert.equal(d.line, 14);
    assert.equal(d.column, 9);
    assert.match(d.message, /syntax error/);
  });

  it('parses west and ninja failures', () => {
    const out = parseBuildOutput([
      'FAILED: zephyr/zephyr.elf',
      'ninja: build stopped: subcommand failed.',
      'FATAL ERROR: command exited with status 1',
    ].join('\n'));
    const tools = out.diagnostics.map(d => d.tool);
    assert.ok(tools.includes('ninja'));
    assert.ok(tools.includes('west'));
  });

  it('parses the memory usage table Zephyr prints after linking', () => {
    const out = parseBuildOutput([
      'Memory region         Used Size  Region Size  %age Used',
      '           FLASH:       23180 B         1 MB      2.21%',
      '             RAM:        4416 B       256 KB      1.68%',
      '        IDT_LIST:          0 GB        32 KB      0.00%',
      '',
    ].join('\n'));
    assert.equal(out.memory.length, 3);
    const flash = out.memory[0];
    assert.equal(flash.region, 'FLASH');
    assert.equal(flash.used_bytes, 23180);
    assert.equal(flash.total_bytes, 1024 * 1024);
    assert.equal(flash.percent, 2.21);
    assert.equal(out.memory[1].total_bytes, 256 * 1024);
  });

  it('puts errors before warnings so the first item is the actionable one', () => {
    const out = parseBuildOutput([
      '/ws/a.c:1:1: warning: first warning [-Wall]',
      '/ws/b.c:2:1: warning: second warning [-Wall]',
      '/ws/c.c:3:1: error: the real problem',
    ].join('\n'));
    assert.equal(out.diagnostics[0].severity, 'error');
    assert.match(out.diagnostics[0].message, /the real problem/);
  });

  it('de-duplicates identical diagnostics repeated by parallel jobs', () => {
    const line = '/ws/app/src/main.c:12:5: error: boom';
    const out = parseBuildOutput([line, line, line].join('\n'));
    assert.equal(out.diagnostics.length, 1);
    assert.equal(out.errors, 1);
  });

  it('caps the list and reports truncation', () => {
    const many = Array.from({ length: 30 }, (_, i) => `/ws/f${i}.c:${i + 1}:1: error: e${i}`).join('\n');
    const out = parseBuildOutput(many, { maxDiagnostics: 5 });
    assert.equal(out.diagnostics.length, 5);
    assert.equal(out.truncated, true);
    assert.equal(out.errors, 30, 'counts reflect everything found, not just what was returned');
  });

  it('resolves a relative compiler path against the build directory', () => {
    // ninja reports paths relative to the build directory it runs in.
    const out = parseBuildOutput('../../src/main.c:3:1: error: boom', { buildDir: '/ws/app/build/primary' });
    assert.equal(out.diagnostics[0].file, '/ws/app/src/main.c');
  });

  it('returns nothing for a clean build', () => {
    const out = parseBuildOutput([
      '-- west build: building application',
      '[430/430] Linking C executable zephyr/zephyr.elf',
      'Memory region         Used Size  Region Size  %age Used',
      '           FLASH:       23180 B         1 MB      2.21%',
    ].join('\n'));
    assert.deepEqual(out.diagnostics, []);
    assert.equal(out.errors, 0);
    assert.equal(out.memory.length, 1, 'a clean build still reports memory usage');
  });
});

describe('mcp/jobs/diagnosticsParser paths and linker', () => {
  it('resolves CMake paths against the source dir and Kconfig paths against ZEPHYR_BASE', () => {
    const log = [
      'CMake Error at CMakeLists.txt:3 (message):',
      '  broken',
      '',
      'warning: UART_CONSOLE (defined at drivers/console/Kconfig:42) was assigned the value y but got the value n.',
    ].join('\n');
    const parsed = parseBuildOutput(log, { buildDir: '/ws/app/build', sourceDir: '/ws/app', zephyrBase: '/ws/zephyr' });
    const cmake = parsed.diagnostics.find(d => d.tool === 'cmake');
    const kconfig = parsed.diagnostics.find(d => d.tool === 'kconfig');
    assert.equal(cmake?.file, path.resolve('/ws/app', 'CMakeLists.txt'));
    assert.equal(kconfig?.file, path.resolve('/ws/zephyr', 'drivers/console/Kconfig'));
  });

  it('reads a linker warning as a warning, including from a Windows ld.bfd.exe', () => {
    const log = [
      'C:/zephyr-sdk/arm-zephyr-eabi/bin/ld.bfd.exe: warning: orphan section `.my_data\' from `app.a(main.c.obj)\' being placed in section `.my_data\'',
      'c:/zephyr-sdk/arm-zephyr-eabi/bin/ld.bfd.exe: cannot find -lfoo',
    ].join('\n');
    const parsed = parseBuildOutput(log);
    assert.equal(parsed.errors, 1);
    assert.equal(parsed.warnings, 1);
    assert.match(parsed.diagnostics.find(d => d.severity === 'warning')?.message ?? '', /^orphan section/);
  });

  it('keeps the file and line of a multiple definition', () => {
    const parsed = parseBuildOutput('/ws/app/src/main.c:12: multiple definition of `foo\'; /ws/app/src/other.c:3: first defined here');
    assert.equal(parsed.diagnostics[0].file, '/ws/app/src/main.c');
    assert.equal(parsed.diagnostics[0].line, 12);
    assert.equal(parsed.diagnostics[0].tool, 'ld');
  });

  it('can return every diagnostic when asked', () => {
    const log = Array.from({ length: 30 }, (_, i) => `/ws/a.c:${i + 1}:1: warning: w${i}`).join('\n');
    assert.equal(parseBuildOutput(log).diagnostics.length, 20);
    assert.equal(parseBuildOutput(log, { maxDiagnostics: Number.POSITIVE_INFINITY }).diagnostics.length, 30);
  });
});

describe('mcp/jobs/diagnosticsParser linker formats and sysbuild', () => {
  it('reads the file and line of the undefined reference form current ld prints', () => {
    const parsed = parseBuildOutput('/ws/app/src/main.c:3:(.text.main+0x8): undefined reference to `missing_fn\'');
    assert.equal(parsed.diagnostics[0].file, '/ws/app/src/main.c');
    assert.equal(parsed.diagnostics[0].line, 3);
    assert.match(parsed.diagnostics[0].message, /^undefined reference to/);
  });

  it('does not invent a file for an object without debug information', () => {
    const parsed = parseBuildOutput('main.c:(.text+0x8): undefined reference to `missing_fn\'', { buildDir: '/ws/app/build' });
    assert.equal(parsed.diagnostics[0].file, undefined);
  });

  it('reads a link-time warning as a warning, and the in-function line as context only', () => {
    const log = [
      '/opt/sdk/bin/arm-zephyr-eabi-ld.bfd: warn_main.o: in function `main\':',
      '/ws/app/src/warn_main.c:2:(.text+0x8): warning: foo is deprecated',
    ].join('\n');
    const parsed = parseBuildOutput(log);
    assert.equal(parsed.errors, 0);
    assert.equal(parsed.warnings, 1);
    assert.equal(parsed.diagnostics[0].line, 2);
  });

  it('resolves each sysbuild image against its own source directory', () => {
    const log = [
      '-- Application: /ws/zephyr/share/sysbuild',
      '-- Application: /ws/app',
      'CMake Error at CMakeLists.txt:4 (target_sources):',
      '  Cannot find source file',
      '',
    ].join('\n');
    const parsed = parseBuildOutput(log, { sourceDir: '/ws/zephyr/share/sysbuild' });
    assert.equal(parsed.diagnostics[0].file, path.resolve('/ws/app', 'CMakeLists.txt'));
  });
});
