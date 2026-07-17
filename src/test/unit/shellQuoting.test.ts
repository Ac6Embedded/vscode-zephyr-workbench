import { strict as assert } from 'assert';

import { isPosixShellKind, quoteIfNeeded } from '../../utils/shellQuoting';

describe('shellQuoting', () => {
  describe('quoteIfNeeded', () => {
    it('returns space-free values unchanged', () => {
      assert.equal(quoteIfNeeded('C:/Users/roy/app'), 'C:/Users/roy/app');
      assert.equal(quoteIfNeeded('-DFOO=bar'), '-DFOO=bar');
    });

    it('double-quotes values containing whitespace', () => {
      assert.equal(quoteIfNeeded('C:/Users/First Last/app'), '"C:/Users/First Last/app"');
      assert.equal(quoteIfNeeded('a\tb'), '"a\tb"');
    });

    it('is idempotent on already-quoted values', () => {
      assert.equal(quoteIfNeeded('"C:/Users/First Last/app"'), '"C:/Users/First Last/app"');
      assert.equal(quoteIfNeeded(quoteIfNeeded('a b')), '"a b"');
    });

    it('returns the empty string unchanged', () => {
      assert.equal(quoteIfNeeded(''), '');
    });
  });

  describe('isPosixShellKind', () => {
    it('is true for the POSIX family', () => {
      for (const kind of ['bash', 'zsh', 'dash', 'fish']) {
        assert.equal(isPosixShellKind(kind), true, kind);
      }
    });

    it('is false for Windows shells and unknowns', () => {
      for (const kind of ['cmd.exe', 'powershell.exe', 'pwsh.exe', 'sh', '']) {
        assert.equal(isPosixShellKind(kind), false, kind);
      }
    });
  });
});
