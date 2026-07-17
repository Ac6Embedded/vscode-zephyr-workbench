import { strict as assert } from 'assert';

import {
  composeWestBuildArgs,
  expandAndNormalizeWestArgs,
  ExpandWestArgsOptions,
  getWestBuildSourceDirArgValue,
  hasWestBuildSourceDirArg,
  splitWestBuildArgs,
} from '../../utils/zephyr/westArgUtils';

// Emulates makeConfiguredVariableResolver: known names resolve to raw values
// (no path.normalize), unknown names return undefined.
const VARIABLES: Record<string, string> = {
  'workspaceFolder': 'C:\\ws space\\app',
  'config:extraConf': 'C:\\cfg\\extra.conf',
  'config:multiArgs': '-DFOO=1 -DBAR=2',
  'env:ZW_URL': 'https://example.com/pack',
  'env:ZW_UNSET': '',
};
function fakeResolver(name: string): string | undefined {
  return VARIABLES[name];
}

const bashOpts: ExpandWestArgsOptions = {
  shellKind: 'bash',
  resolveVariable: fakeResolver,
  isWindows: true,
};

describe('expandAndNormalizeWestArgs', () => {
  describe('variable expansion + POSIX slash normalization', () => {
    it('expands -s ${workspaceFolder}/app into a quoted forward-slash path', () => {
      assert.equal(
        expandAndNormalizeWestArgs('-s ${workspaceFolder}/app', bashOpts),
        '-s "C:/ws space/app/app"',
      );
    });

    it('quotes only the value of -s=<path> words', () => {
      assert.equal(
        expandAndNormalizeWestArgs('-s=${workspaceFolder}', bashOpts),
        '-s="C:/ws space/app"',
      );
    });

    it('quotes only the value of --source-dir=<path> words', () => {
      assert.equal(
        expandAndNormalizeWestArgs('--source-dir=${workspaceFolder}', bashOpts),
        '--source-dir="C:/ws space/app"',
      );
    });

    it('whole-word quotes the attached -s<path> form', () => {
      assert.equal(
        expandAndNormalizeWestArgs('-s${workspaceFolder}', bashOpts),
        '"-sC:/ws space/app"',
      );
    });

    it('expands a word that is only a variable', () => {
      assert.equal(
        expandAndNormalizeWestArgs('${workspaceFolder}', bashOpts),
        '"C:/ws space/app"',
      );
    });

    it('does not add quotes when the variable is already inside quotes', () => {
      assert.equal(
        expandAndNormalizeWestArgs('-s "${workspaceFolder}/app"', bashOpts),
        '-s "C:/ws space/app/app"',
      );
    });

    it('normalizes plain unquoted Windows paths without variables', () => {
      assert.equal(
        expandAndNormalizeWestArgs('-s C:\\apps\\blinky', bashOpts),
        '-s C:/apps/blinky',
      );
    });

    it('converts UNC paths without collapsing the leading slashes', () => {
      assert.equal(
        expandAndNormalizeWestArgs('-s \\\\srv\\share', bashOpts),
        '-s //srv/share',
      );
    });

    it('keeps backslashes for POSIX shells off Windows', () => {
      assert.equal(
        expandAndNormalizeWestArgs('-s a\\b', { ...bashOpts, isWindows: false }),
        '-s a\\b',
      );
    });
  });

  describe('user quoting and escapes are preserved (span-preserving)', () => {
    it('keeps double-quoted values with shell metacharacters byte-identical', () => {
      const input = '-- -DEXTRA_CONF_FILE="debug.conf;net.conf"';
      assert.equal(expandAndNormalizeWestArgs(input, bashOpts), input);
    });

    it('keeps single-quoted values (incl. $ and command substitutions) byte-identical', () => {
      for (const input of [
        "-DOPT='$abc'",
        "-DVERSION='$(git describe)'",
        "-DK='a b'",
        '-DEXTRA_CFLAGS=\'-DVERSION_STR="1.2.3"\'',
      ]) {
        assert.equal(expandAndNormalizeWestArgs(input, bashOpts), input);
      }
    });

    it('keeps quoted backslash paths byte-identical (they survived the shell before)', () => {
      const input = '-s "C:\\a b\\app"';
      assert.equal(expandAndNormalizeWestArgs(input, bashOpts), input);
    });

    it('preserves backslash escape sequences in unquoted spans', () => {
      assert.equal(
        expandAndNormalizeWestArgs('-DNAME=\\"x\\"', bashOpts),
        '-DNAME=\\"x\\"',
      );
    });

    it('preserves backslash-escaped shell metacharacters (never activates them)', () => {
      for (const input of [
        '-- -DEXTRA_CONF_FILE=debug.conf\\;net.conf',
        '-DX=a\\&b',
        '-DX=a\\|b',
        '-DX=\\(foo\\)',
        '-DX=a\\*b',
        '-DX=a\\<b',
      ]) {
        assert.equal(expandAndNormalizeWestArgs(input, bashOpts), input);
      }
    });

    it('doubles a trailing backslash when auto-quoting so the closing quote survives', () => {
      assert.equal(
        expandAndNormalizeWestArgs('-s ${workspaceFolder}\\', bashOpts),
        '-s "C:/ws space/app\\\\"',
      );
      assert.equal(
        expandAndNormalizeWestArgs('-s=${workspaceFolder}\\', bashOpts),
        '-s="C:/ws space/app\\\\"',
      );
    });

    it('preserves empty quoted arguments', () => {
      assert.equal(expandAndNormalizeWestArgs('--flag ""', bashOpts), '--flag ""');
    });

    it('leaves non-path args byte-identical', () => {
      const input = 'build -t menuconfig -b nucleo_f401re --pristine always';
      assert.equal(expandAndNormalizeWestArgs(input, bashOpts), input);
    });

    it('leaves unknown ${...} variables untouched', () => {
      const input = '${input:west.runner} --build-dir ${BUILD_DIR}';
      assert.equal(expandAndNormalizeWestArgs(input, bashOpts), input);
    });

    it('preserves -- separators in place', () => {
      assert.equal(
        expandAndNormalizeWestArgs('--pristine always -- -DEXTRA_CONF_FILE=${config:extraConf}', bashOpts),
        '--pristine always -- -DEXTRA_CONF_FILE=C:/cfg/extra.conf',
      );
    });
  });

  describe('non-path variable values are inlined verbatim', () => {
    it('does not corrupt URL-valued variables', () => {
      assert.equal(
        expandAndNormalizeWestArgs('-DURL=${env:ZW_URL}', bashOpts),
        '-DURL=https://example.com/pack',
      );
    });

    it('an unset ${env:...} word expands to nothing, not "."', () => {
      assert.equal(
        expandAndNormalizeWestArgs('--extra ${env:ZW_UNSET}', bashOpts),
        '--extra',
      );
    });

    it('a ${config:...} value expanding to multiple args stays unquoted for shell word-splitting', () => {
      assert.equal(
        expandAndNormalizeWestArgs('${config:multiArgs}', bashOpts),
        '-DFOO=1 -DBAR=2',
      );
    });
  });

  describe('cmd.exe / PowerShell passthrough', () => {
    it('expands variables but keeps backslashes for cmd.exe, quoting spaced path values', () => {
      assert.equal(
        expandAndNormalizeWestArgs('-s ${workspaceFolder}', { ...bashOpts, shellKind: 'cmd.exe' }),
        '-s "C:\\ws space\\app"',
      );
    });

    it('keeps plain Windows paths byte-identical for powershell.exe', () => {
      assert.equal(
        expandAndNormalizeWestArgs('-s C:\\plain\\path', { ...bashOpts, shellKind: 'powershell.exe' }),
        '-s C:\\plain\\path',
      );
    });
  });

  describe('empty input', () => {
    it('returns the empty string for undefined, empty and whitespace-only input', () => {
      assert.equal(expandAndNormalizeWestArgs(undefined, bashOpts), '');
      assert.equal(expandAndNormalizeWestArgs('', bashOpts), '');
      assert.equal(expandAndNormalizeWestArgs('   ', bashOpts), '');
    });
  });

  describe('pipeline integration', () => {
    it('routes an expanded leading -D word to cmakeArgs in splitWestBuildArgs', () => {
      const expanded = expandAndNormalizeWestArgs('-DCONF_FILE=${workspaceFolder}/a.conf', bashOpts);
      const split = splitWestBuildArgs(expanded);
      assert.equal(split.westArgs, '');
      assert.equal(split.cmakeArgs, '-DCONF_FILE="C:/ws space/app/a.conf"');
    });

    it('does not re-process formatWestFlagDValues output', () => {
      const expanded = expandAndNormalizeWestArgs('-s ${workspaceFolder}', bashOpts);
      const split = splitWestBuildArgs(expanded, ['OPENOCD=C:\\t\\openocd.exe']);
      assert.equal(split.westArgs, '-s "C:/ws space/app"');
      assert.equal(split.cmakeArgs, "-DOPENOCD='C:\\t\\openocd.exe'");
    });

    it('getWestBuildSourceDirArgValue reads quoted helper output', () => {
      assert.equal(
        getWestBuildSourceDirArgValue('--source-dir="C:/a b/app"'),
        'C:/a b/app',
      );
      assert.equal(getWestBuildSourceDirArgValue('-s "C:/a b"'), 'C:/a b');
      assert.equal(
        hasWestBuildSourceDirArg(expandAndNormalizeWestArgs('-s ${workspaceFolder}', bashOpts)),
        true,
      );
    });

    it('composeWestBuildArgs joins west and cmake args with --', () => {
      assert.equal(
        composeWestBuildArgs('-s app -- -DFOO=1'),
        '-s app -- -DFOO=1',
      );
    });
  });
});
