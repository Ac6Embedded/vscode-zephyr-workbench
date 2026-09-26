import { strict as assert } from 'assert';
import {
  assertBoardIdentifier,
  assertConfigName,
  assertInside,
  assertKconfigSymbol,
  assertRunnerName,
  assertSafeShellFragment,
  hasBalancedQuotes,
  isInside,
  isPlainPath,
  isPlainShellArgument,
  normalizeForCompare,
} from '../../../mcp/core/argSafety';
import { McpToolError } from '../../../mcp/core/errors';

function rejects(value: string, label = 'west_args'): McpToolError {
  try {
    assertSafeShellFragment(value, label);
  } catch (error) {
    assert.ok(error instanceof McpToolError, `expected McpToolError for ${JSON.stringify(value)}`);
    assert.equal((error as McpToolError).code, 'INVALID_ARGUMENT');
    return error as McpToolError;
  }
  throw new Error(`expected ${JSON.stringify(value)} to be rejected`);
}

describe('mcp/core/argSafety', () => {
  describe('assertSafeShellFragment', () => {
    it('accepts the west arguments users really pass', () => {
      const accepted = [
        '-DCONFIG_DEBUG=y',
        '--shield x_nucleo_iks01a3',
        '-- -DEXTRA_CONF_FILE=debug.conf',
        '-DOVERLAY_CONFIG="one.conf two.conf"',
        "-DFOO='bar baz'",
        'C:\\ws space\\app\\prj.conf',
        '/home/user/zephyrproject/apps/blinky',
        '-DCMAKE_BUILD_TYPE=Release -DFOO=1',
        '',
      ];
      for (const value of accepted) {
        assert.equal(assertSafeShellFragment(value, 'west_args'), value, `should accept ${JSON.stringify(value)}`);
      }
    });

    it('accepts the variable references the workbench expands itself', () => {
      for (const value of [
        '-DEXTRA_CONF_FILE=${workspaceFolder}/debug.conf',
        '${userHome}/boards',
        '${workspaceFolderBasename}.conf',
      ]) {
        assert.equal(assertSafeShellFragment(value, 'west_args'), value, `should accept ${value}`);
      }
    });

    it('rejects variable names outside the allow-list, including ${IFS}', () => {
      // ${IFS} expands to whitespace in a POSIX shell and is a word-splitting
      // vector; ${env:} and ${config:} resolve to values we do not control.
      rejects('${IFS}cat');
      rejects('${env:ZEPHYR_EXTRA}/x.conf');
      rejects('${config:zephyr-workbench.westWorkspace}/zephyr');
    });

    it('rejects command chaining and substitution', () => {
      for (const value of [
        '; touch /tmp/x',
        '-DFOO=1 && rm -rf /',
        'a | tee /tmp/x',
        'a `id`',
        'a $(id)',
        '-DFOO=$(whoami)',
        'a > /tmp/out',
        'a < /etc/passwd',
        'a & disown',
        '${IFS}cat',
        'a\nrm -rf /',
        'a\rrm',
      ]) {
        rejects(value);
      }
    });

    it('rejects a bare dollar that is not a well-formed reference', () => {
      rejects('$HOME/x');
      rejects('-DFOO=$BAR');
    });

    it('rejects unbalanced quotes', () => {
      rejects('-DFOO="unterminated');
      rejects("-DFOO='unterminated");
    });

    it('rejects an over-long value', () => {
      rejects('a'.repeat(4097));
    });

    it('names the offending field in the message', () => {
      const error = rejects('; id', 'runner_args');
      assert.match(error.message, /^runner_args contains/);
    });
  });

  describe('hasBalancedQuotes', () => {
    it('handles nesting and escapes', () => {
      assert.equal(hasBalancedQuotes(`"it's fine"`), true);
      assert.equal(hasBalancedQuotes(`'say "hi"'`), true);
      assert.equal(hasBalancedQuotes(`"escaped \\" quote"`), true);
      assert.equal(hasBalancedQuotes(`"open`), false);
      assert.equal(hasBalancedQuotes(`it's`), false);
    });
  });

  describe('identifier patterns', () => {
    it('accepts real board identifiers', () => {
      for (const board of ['nucleo_f401re', 'esp32_devkitc_wroom/esp32/procpu', 'xiao_ble@1.0.0', 'native_sim/native/64']) {
        assert.equal(assertBoardIdentifier(board), board);
      }
    });
    it('rejects a board with a shell character', () => {
      assert.throws(() => assertBoardIdentifier('nucleo;id'), McpToolError);
    });
    it('accepts and rejects config names', () => {
      assert.equal(assertConfigName('primary'), 'primary');
      assert.equal(assertConfigName('debug.v2-1'), 'debug.v2-1');
      assert.throws(() => assertConfigName(''), McpToolError);
      assert.throws(() => assertConfigName('a'.repeat(65)), McpToolError);
      assert.throws(() => assertConfigName('has space'), McpToolError);
    });
    it('accepts runner names and Kconfig symbols', () => {
      assert.equal(assertRunnerName('openocd'), 'openocd');
      assert.equal(assertRunnerName('jlink'), 'jlink');
      assert.equal(assertKconfigSymbol('CONFIG_GPIO'), 'CONFIG_GPIO');
      assert.throws(() => assertKconfigSymbol('CONFIG-GPIO'), McpToolError);
    });
  });

  describe('path containment', () => {
    it('treats a folder as inside itself', () => {
      assert.equal(isInside('/a/b', '/a/b', 'linux'), true);
    });
    it('matches descendants but not sibling prefixes', () => {
      assert.equal(isInside('/a/b/c', '/a/b', 'linux'), true);
      assert.equal(isInside('/a/bc', '/a/b', 'linux'), false);
    });
    it('folds case on win32 and darwin only', () => {
      assert.equal(isInside('C:\\WS\\App', 'c:\\ws', 'win32'), true);
      assert.equal(isInside('/Users/Roy/App', '/users/roy', 'darwin'), true);
      assert.equal(isInside('/Users/Roy/App', '/users/roy', 'linux'), false);
    });
    it('ignores a trailing separator', () => {
      assert.equal(normalizeForCompare('/a/b/', 'linux'), '/a/b');
      assert.equal(isInside('/a/b/c', '/a/b/', 'linux'), true);
    });
    it('rejects a path outside every known folder', () => {
      assert.equal(assertInside(process.cwd(), [process.cwd()], 'app_path'), process.cwd());
      try {
        assertInside('/definitely/not/here', [process.cwd()], 'app_path');
        throw new Error('expected rejection');
      } catch (error) {
        assert.ok(error instanceof McpToolError);
        assert.equal((error as McpToolError).code, 'PATH_OUTSIDE_WORKSPACE');
      }
    });
    it('blocks a parent-directory escape', () => {
      assert.equal(isInside('/a/b/../../etc', '/a/b', 'linux'), false);
    });
  });

  describe('plain paths for a command line', () => {
    it('accepts the paths board roots really use, in any script', () => {
      for (const value of [
        '/home/dev/zephyrproject/modules/hal/acme',
        '/opt/my boards/v1.2_rc+3@lab=x~y',
        'C:\\Users\\Zoë\\zephyr-boards',
        'D:/work/板/boards',
      ]) {
        assert.equal(isPlainPath(value), true, value);
      }
    });

    it('refuses what a shell would expand, glob or split', () => {
      for (const value of [
        // The workbench rewrites %IFS% to ${IFS} for bash, which splits the argument.
        '/opt/b%IFS%--soc-root%IFS%/tmp/x',
        '/opt/b$IFS', '/opt/b${IFS}',
        // Unquoted globs turn one root into one argument per matching file.
        '/opt/g/a*', '/opt/g/a?', '/opt/g/[ab]',
        // cmd.exe escapes and delayed expansion.
        'C:\\boards^&calc', 'C:\\boards!x!',
        // PowerShell reads an unquoted comma as an array.
        'C:\\a,b',
        '/opt/"quoted"', "/opt/'quoted'", '/opt/a;b', '/opt/a|b', '/opt/a&b', '/opt/a(b)', '/opt/a`b`', '/opt/a\tb', '',
      ]) {
        assert.equal(isPlainPath(value), false, value);
      }
    });

    it('checks a shaped argument, quotes included', () => {
      assert.equal(isPlainShellArgument('/opt/boards'), true);
      assert.equal(isPlainShellArgument('"/opt/my boards"'), true);
      assert.equal(isPlainShellArgument('/opt/my boards'), false, 'unquoted, a space splits it');
      assert.equal(isPlainShellArgument('/opt/b${IFS}x'), false, 'a rewrite that brings back expansion is caught');
      assert.equal(isPlainShellArgument('"C:\\my boards\\"'), false, 'Windows reads \\" as an escaped quote');
      assert.equal(isPlainShellArgument('"/opt/a"b"'), false);
    });
  });
});
