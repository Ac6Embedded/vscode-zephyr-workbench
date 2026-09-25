import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findSnippets, readBoardYmlMetadata, readSampleYamlMetadata } from '../../utils/zephyr/catalogFiles';

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

describe('catalogFiles', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-catalog-files-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('findSnippets', () => {
    it('finds nested snippets by the name in snippet.yml, not by folder', async () => {
      const zephyr = path.join(tmp, 'zephyr');
      write(path.join(zephyr, 'snippets', 'rtt-console', 'snippet.yml'), 'name: rtt-console\n');
      // A grouping folder with no snippet.yml of its own, as in Zephyr 4.x.
      write(path.join(zephyr, 'snippets', 'espressif', 'flash-2M', 'snippet.yml'), 'name: espressif-flash-2M\n');
      write(path.join(zephyr, 'snippets', 'espressif', 'flash-4M', 'snippet.yml'), 'name: espressif-flash-4M\n');

      const found = await findSnippets([zephyr]);

      assert.deepEqual(found.map(s => s.name), ['espressif-flash-2M', 'espressif-flash-4M', 'rtt-console']);
      assert.ok(!found.some(s => s.name === 'espressif'), 'a grouping folder is not a snippet');
      assert.equal(found[0].dir, path.join(zephyr, 'snippets', 'espressif', 'flash-2M'));
      assert.equal(found[0].root, zephyr);
    });

    it('keeps walking below a snippet folder, as the build system does', async () => {
      write(path.join(tmp, 'snippets', 'outer', 'snippet.yml'), 'name: outer\n');
      write(path.join(tmp, 'snippets', 'outer', 'inner', 'snippet.yml'), 'name: inner\n');
      assert.deepEqual((await findSnippets([tmp])).map(s => s.name), ['inner', 'outer']);
    });

    it('searches every root once and ignores roots without a snippets folder', async () => {
      const a = path.join(tmp, 'a');
      const b = path.join(tmp, 'b');
      write(path.join(a, 'snippets', 'one', 'snippet.yml'), 'name: one\n');
      write(path.join(b, 'snippets', 'two', 'snippet.yml'), 'name: two\n');
      const found = await findSnippets([a, b, a, path.join(tmp, 'missing'), '']);
      assert.deepEqual(found.map(s => [s.name, s.root]), [['one', a], ['two', b]]);
    });

    it('skips snippet.yml files that are malformed or carry an invalid name', async () => {
      write(path.join(tmp, 'snippets', 'good', 'snippet.yml'), 'name: good\n');
      write(path.join(tmp, 'snippets', 'broken', 'snippet.yml'), 'name: [unclosed\n');
      write(path.join(tmp, 'snippets', 'unnamed', 'snippet.yml'), 'append:\n  EXTRA_CONF_FILE: x.conf\n');
      write(path.join(tmp, 'snippets', 'bad-name', 'snippet.yml'), 'name: "-bad name"\n');
      assert.deepEqual((await findSnippets([tmp])).map(s => s.name), ['good']);
    });

    it('does not follow directory symlinks, so a link loop cannot hang it', async function () {
      if (process.platform === 'win32') {
        this.skip();
      }
      write(path.join(tmp, 'snippets', 'real', 'snippet.yml'), 'name: real\n');
      fs.symlinkSync(path.join(tmp, 'snippets'), path.join(tmp, 'snippets', 'real', 'loop'));
      assert.deepEqual((await findSnippets([tmp])).map(s => s.name), ['real']);
    });
  });

  describe('readBoardYmlMetadata', () => {
    it('reads vendor and full name of a single-board board.yml', async () => {
      write(path.join(tmp, 'board.yml'), 'board:\n  name: nrf52840dk\n  full_name: nRF52840 DK\n  vendor: nordic\n');
      assert.deepEqual(await readBoardYmlMetadata(tmp, 'nrf52840dk'), { vendor: 'nordic', full_name: 'nRF52840 DK' });
    });

    it('picks the right entry of a multi-board board.yml by name', async () => {
      write(path.join(tmp, 'board.yml'), [
        'boards:',
        '  - name: first_board',
        '    full_name: First',
        '    vendor: acme',
        '  - name: second_board',
        '    full_name: Second',
        '    vendor: other',
        '',
      ].join('\n'));
      assert.deepEqual(await readBoardYmlMetadata(tmp, 'second_board'), { vendor: 'other', full_name: 'Second' });
      assert.deepEqual(await readBoardYmlMetadata(tmp, 'unknown_board'), {});
    });

    it('returns nothing for a board folder without board.yml', async () => {
      assert.deepEqual(await readBoardYmlMetadata(tmp, 'legacy_board'), {});
    });
  });

  describe('readSampleYamlMetadata', () => {
    it('reads the sample title and a flattened description', async () => {
      write(path.join(tmp, 'sample.yaml'), 'sample:\n  name: Blinky Sample\n  description: |\n    Blinks\n    an LED.\n');
      assert.deepEqual(await readSampleYamlMetadata(tmp), { title: 'Blinky Sample', description: 'Blinks an LED.' });
    });

    it('caps a long description', async () => {
      write(path.join(tmp, 'sample.yaml'), `sample:\n  name: Long\n  description: ${'word '.repeat(200)}\n`);
      const { description } = await readSampleYamlMetadata(tmp);
      assert.ok(description && description.length <= 300 && description.endsWith('...'));
    });

    it('returns nothing for a test folder', async () => {
      write(path.join(tmp, 'testcase.yaml'), 'tests:\n  kernel.common: {}\n');
      assert.deepEqual(await readSampleYamlMetadata(tmp), {});
    });
  });
});
