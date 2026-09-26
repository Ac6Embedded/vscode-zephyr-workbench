import { strict as assert } from 'assert';
import {
  BoardEntry, filterCatalog, pageEntries, SampleEntry, searchableText, ShieldEntry, westFailureToToolError,
} from '../../../mcp/core/catalogSearch';
import { McpToolError } from '../../../mcp/core/errors';
import { compileMatcher, matcherFor } from '../../../mcp/core/match';

const board = (over: Partial<BoardEntry>): BoardEntry => ({
  name: 'b', identifiers: ['b'], qualifiers: [], revisions: [], dir: '/z/boards/b', ...over,
});

const BOARDS: BoardEntry[] = [
  board({ name: 'nrf5340dk', identifiers: ['nrf5340dk/nrf5340/cpuapp', 'nrf5340dk/nrf5340/cpunet'], vendor: 'nordic', full_name: 'nRF5340 DK' }),
  board({ name: 'nucleo_h563zi', identifiers: ['nucleo_h563zi'], vendor: 'st', full_name: 'Nucleo H563ZI' }),
  board({ name: 'stm32f4_disco', identifiers: ['stm32f4_disco'], vendor: 'stm' }),
  board({ name: 'qemu_x86', identifiers: ['qemu_x86', 'qemu_x86/atom/nopae'] }),
];

describe('mcp/core/catalogSearch', () => {
  describe('searchableText', () => {
    it('covers name, identifiers, vendor and full name of a board', () => {
      assert.deepEqual(searchableText(BOARDS[0]), [
        'nrf5340dk', 'nrf5340dk/nrf5340/cpuapp', 'nrf5340dk/nrf5340/cpunet', 'nordic', 'nRF5340 DK',
      ]);
    });

    it('covers the display path of a sample', () => {
      const sample: SampleEntry = {
        name: 'blinky', kind: 'sample', path: '/ws/zephyr/samples/basic/blinky',
        display_path: 'zephyr/samples/basic/blinky', source: 'zephyr',
      };
      assert.deepEqual(searchableText(sample), ['blinky', 'zephyr/samples/basic/blinky']);
    });
  });

  describe('filterCatalog', () => {
    it('keeps every entry without filters', () => {
      assert.equal(filterCatalog(BOARDS, {}).length, BOARDS.length);
    });

    it('matches a pattern against any searchable field', () => {
      const names = (pattern: string) => filterCatalog(BOARDS, { matches: compileMatcher(pattern) }).map(b => b.name);
      assert.deepEqual(names('cpunet'), ['nrf5340dk'], 'a qualifier target finds its board');
      assert.deepEqual(names('Nucleo H5*'), ['nucleo_h563zi'], 'the full name is searched');
      assert.deepEqual(names('nopae'), ['qemu_x86']);
    });

    it('compares vendor exactly and case-insensitively', () => {
      assert.deepEqual(filterCatalog(BOARDS, { vendor: 'ST' }).map(b => b.name), ['nucleo_h563zi'], '"st" must not pick "stm"');
      assert.deepEqual(filterCatalog(BOARDS, { vendor: ' nordic ' }).map(b => b.name), ['nrf5340dk']);
    });

    it('drops entries without a vendor when one is asked for', () => {
      const shields: ShieldEntry[] = [{ name: 'x_shield', vendor: 'acme' }, { name: 'y_shield' }];
      assert.deepEqual(filterCatalog(shields, { vendor: 'acme' }).map(s => s.name), ['x_shield']);
    });

    it('applies vendor and pattern together', () => {
      const found = filterCatalog(BOARDS, { vendor: 'nordic', matches: compileMatcher('nucleo') });
      assert.deepEqual(found, []);
    });
  });

  describe('pageEntries', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ i }));

    it('returns one window and the offset of the next', () => {
      assert.deepEqual(pageEntries(items, 2, 3, 10000), { page: [{ i: 2 }, { i: 3 }, { i: 4 }], nextOffset: 5 });
    });

    it('omits the next offset on the last page', () => {
      assert.deepEqual(pageEntries(items, 8, 5, 10000), { page: [{ i: 8 }, { i: 9 }] });
      assert.deepEqual(pageEntries(items, 20, 5, 10000), { page: [] });
    });

    it('stops early at the character budget, and resumes where it stopped', () => {
      const big = Array.from({ length: 5 }, (_, i) => ({ i, text: 'x'.repeat(100) }));
      const first = pageEntries(big, 0, 5, 250);
      assert.equal(first.page.length, 2);
      assert.equal(first.nextOffset, 2);
    });

    it('always returns at least one entry, so paging cannot stall', () => {
      const huge = [{ text: 'x'.repeat(1000) }, { text: 'y' }];
      assert.deepEqual(pageEntries(huge, 0, 2, 10), { page: [huge[0]], nextOffset: 1 });
    });
  });

  describe('westFailureToToolError', () => {
    it('reports a timeout as a retryable TIMEOUT', () => {
      const error = westFailureToToolError('west boards', { message: 'stopped', stderr: '', stopped: 'timeout' });
      assert.equal(error.code, 'TIMEOUT');
      assert.equal(error.retryable, true);
    });

    it('reports a missing west shields command as DEPENDENCY_MISSING', () => {
      const error = westFailureToToolError('west shields', {
        message: 'x', stderr: 'usage: west [-h]\nwest: error: argument <command>: invalid choice: \'shields\'',
      });
      assert.equal(error.code, 'DEPENDENCY_MISSING');
      assert.match(error.hint ?? '', /Zephyr 3\.7/);
    });

    it('does not blame the Zephyr version for a board listing failure', () => {
      const error = westFailureToToolError('west boards', { message: 'x', stderr: 'west: unknown command "boards"' });
      assert.equal(error.code, 'INTERNAL');
    });

    it('reports a west that cannot start as ENV_NOT_READY', () => {
      for (const stderr of ['sh: west: command not found', "'west' is not recognized as an internal or external command", 'No module named west']) {
        assert.equal(westFailureToToolError('west boards', { message: 'x', stderr }).code, 'ENV_NOT_READY', stderr);
      }
    });

    it('recognises a missing west in the wording of every shell, for both listings', () => {
      const wordings = [
        // zsh is the shell the workbench runs west in on macOS.
        'zsh:1: command not found: west',
        'bash: line 1: west: command not found',
        'sh: 1: west: not found',
        "west : The term 'west' is not recognized as a name of a cmdlet, function, script file, or executable program.",
        // fish says "Unknown command", which must not read as a Zephyr without west shields.
        'fish: Unknown command: west',
      ];
      for (const command of ['west boards', 'west shields'] as const) {
        for (const stderr of wordings) {
          const error = westFailureToToolError(command, { message: 'exit 127', stderr });
          assert.equal(error.code, 'ENV_NOT_READY', `${command}: ${stderr}`);
          assert.match(error.hint ?? '', /Install Host Tools/);
        }
      }
    });

    it('carries the end of stderr, cleaned of terminal escapes, for anything else', () => {
      const error = westFailureToToolError('west boards', {
        message: 'exit 1', stderr: `${'noise\n'.repeat(400)}\u001b[31mFATAL ERROR: bad board.yml\u001b[0m\n`,
      });
      assert.equal(error.code, 'INTERNAL');
      assert.match(error.message, /FATAL ERROR: bad board\.yml$/);
      assert.ok(!error.message.includes('\u001b'), 'no escape sequence reaches the agent');
      assert.ok(error.message.length < 1600, 'stderr is cut to its tail');
    });

    it('falls back to the error message when west printed nothing', () => {
      assert.match(westFailureToToolError('west shields', { message: 'exit 2', stderr: '' }).message, /exit 2/);
    });
  });

  describe('matcherFor', () => {
    it('means no filter for a missing or empty pattern', () => {
      assert.equal(matcherFor(undefined), undefined);
      assert.equal(matcherFor(''), undefined);
    });

    it('turns a refused pattern into INVALID_ARGUMENT', () => {
      assert.throws(() => matcherFor('x'.repeat(500)), (error: unknown) =>
        error instanceof McpToolError && error.code === 'INVALID_ARGUMENT');
    });

    it('compiles a usable matcher', () => {
      assert.equal(matcherFor('nrf*dk')?.('nrf5340dk'), true);
    });
  });
});
