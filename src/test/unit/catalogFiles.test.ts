import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AppTemplate, findAppTemplates, findSnippets, isAppTemplateFolder, readBoardYmlMetadata, readSampleMetadata,
} from '../../utils/zephyr/catalogFiles';

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

  describe('readSampleMetadata', () => {
    it('reads the sample title and a flattened description', async () => {
      write(path.join(tmp, 'sample.yaml'), 'sample:\n  name: Blinky Sample\n  description: |\n    Blinks\n    an LED.\n');
      assert.deepEqual(await readSampleMetadata(tmp), { title: 'Blinky Sample', description: 'Blinks an LED.' });
    });

    it('reads it from the tests.yaml of Zephyr 4.5', async () => {
      write(path.join(tmp, 'tests.yaml'), 'sample:\n  name: lvgl\n  description: LVGL sample application\ntests:\n  sample.display.lvgl.gui: {}\n');
      assert.deepEqual(await readSampleMetadata(tmp), { title: 'lvgl', description: 'LVGL sample application' });
    });

    it('caps a long description', async () => {
      write(path.join(tmp, 'sample.yaml'), `sample:\n  name: Long\n  description: ${'word '.repeat(200)}\n`);
      const { description } = await readSampleMetadata(tmp);
      assert.ok(description && description.length <= 300 && description.endsWith('...'));
    });

    it('returns nothing for a test folder', async () => {
      write(path.join(tmp, 'testcase.yaml'), 'tests:\n  kernel.common: {}\n');
      assert.deepEqual(await readSampleMetadata(tmp), {});
      write(path.join(tmp, 'tests.yaml'), 'tests:\n  kernel.common: {}\n');
      assert.deepEqual(await readSampleMetadata(tmp), {});
    });
  });

  describe('findAppTemplates', () => {
    let ws: string;
    let zephyr: string;

    /** A buildable sample or test: a test definition file and a CMakeLists.txt. */
    function template(dir: string, file: string, text = 'tests:\n  some.scenario: {}\n'): string {
      write(path.join(dir, file), text);
      write(path.join(dir, 'CMakeLists.txt'), 'project(app)\n');
      return dir;
    }

    /** A west project: a git checkout, with a zephyr/module.yml when `moduleYml` is given. */
    function checkout(relative: string, moduleYml?: string, file = 'module.yml'): string {
      const dir = path.join(ws, relative);
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
      if (moduleYml !== undefined) {
        write(path.join(dir, 'zephyr', file), moduleYml);
      }
      return dir;
    }

    async function find(manifest = 'deps/zephyr'): Promise<Map<string, AppTemplate>> {
      const found = await findAppTemplates({ root: ws, zephyrBase: zephyr, manifestDir: path.join(ws, manifest) });
      return new Map(found.map(entry => [path.relative(ws, entry.dir).split(path.sep).join('/'), entry]));
    }

    beforeEach(() => {
      ws = path.join(tmp, 'ws');
      zephyr = checkout('deps/zephyr');
      fs.mkdirSync(path.join(ws, '.west'));
    });

    it('lists the samples and tests of Zephyr by the folder they are in, whatever the file name', async () => {
      // Zephyr 4.5: tests.yaml everywhere, with or without a sample block.
      template(path.join(zephyr, 'samples', 'subsys', 'display', 'lvgl'), 'tests.yaml', 'sample:\n  name: lvgl\ntests:\n  sample.display.lvgl.gui: {}\n');
      template(path.join(zephyr, 'samples', 'kernel', 'condvar'), 'tests.yaml');
      template(path.join(zephyr, 'tests', 'drivers', 'generic_emul'), 'tests.yaml', 'sample:\n  name: emul\ntests:\n  drivers.emul: {}\n');
      // Zephyr 4.4 and before.
      template(path.join(zephyr, 'samples', 'subsys', 'testsuite', 'integration'), 'testcase.yaml');
      template(path.join(zephyr, 'tests', 'drivers', 'mbox', 'mbox_error_cases'), 'sample.yaml', 'sample:\n  name: mbox\n');

      const found = await find();
      assert.deepEqual([...found.keys()].sort(), [
        'deps/zephyr/samples/kernel/condvar',
        'deps/zephyr/samples/subsys/display/lvgl',
        'deps/zephyr/samples/subsys/testsuite/integration',
        'deps/zephyr/tests/drivers/generic_emul',
        'deps/zephyr/tests/drivers/mbox/mbox_error_cases',
      ]);
      assert.deepEqual(found.get('deps/zephyr/samples/subsys/display/lvgl'),
        { name: 'lvgl', dir: path.join(zephyr, 'samples', 'subsys', 'display', 'lvgl'), kind: 'sample', origin: 'zephyr' });
      assert.equal(found.get('deps/zephyr/samples/kernel/condvar')?.kind, 'sample');
      assert.equal(found.get('deps/zephyr/samples/subsys/testsuite/integration')?.kind, 'sample');
      assert.equal(found.get('deps/zephyr/tests/drivers/generic_emul')?.kind, 'test');
      assert.equal(found.get('deps/zephyr/tests/drivers/mbox/mbox_error_cases')?.kind, 'test');
    });

    it('keeps walking below a template, and leaves out a test definition that cannot be built', async () => {
      template(path.join(zephyr, 'samples', 'subsys', 'kvss', 'zms'), 'tests.yaml');
      template(path.join(zephyr, 'samples', 'subsys', 'kvss', 'zms', 'zms_cycle_count'), 'tests.yaml');
      // Zephyr 4.5 multi-image test: the parent only lists its images as required_applications.
      const stress = path.join(zephyr, 'tests', 'bsim', 'conn_stress');
      write(path.join(stress, 'tests.yaml'), 'tests:\n  conn_stress:\n    build: false\n    required_applications:\n      - application: conn_stress.central\n        path: central\n');
      template(path.join(stress, 'central'), 'tests.yaml');
      template(path.join(stress, 'peripheral'), 'tests.yaml');

      assert.deepEqual([...(await find()).keys()].sort(), [
        'deps/zephyr/samples/subsys/kvss/zms',
        'deps/zephyr/samples/subsys/kvss/zms/zms_cycle_count',
        'deps/zephyr/tests/bsim/conn_stress/central',
        'deps/zephyr/tests/bsim/conn_stress/peripheral',
      ]);
    });

    it('skips build folders and dot folders', async () => {
      const hello = template(path.join(zephyr, 'samples', 'hello_world'), 'tests.yaml');
      write(path.join(hello, 'build', 'CMakeCache.txt'), '');
      template(path.join(hello, 'build', 'copy'), 'tests.yaml');
      template(path.join(hello, '.cache', 'copy'), 'tests.yaml');
      assert.deepEqual([...(await find()).keys()], ['deps/zephyr/samples/hello_world']);
    });

    it('lists the samples and tests folders modules declare in module.yml, and nothing else of a module', async () => {
      const rust = checkout('deps/modules/lang/rust', 'samples:\n  - samples\ntests:\n  - tests\n');
      // A module usually builds from its root, which does not make it an application.
      write(path.join(rust, 'CMakeLists.txt'), 'zephyr_library()\n');
      template(path.join(rust, 'samples', 'hello_world'), 'sample.yaml', 'sample:\n  name: Rust hello\n');
      template(path.join(rust, 'tests', 'time'), 'testcase.yaml');
      const mcuboot = checkout('deps/bootloader/mcuboot', 'samples:\n  - boot/zephyr\n', 'module.yaml');
      template(path.join(mcuboot, 'boot', 'zephyr'), 'sample.yaml', 'sample:\n  name: mcuboot\n');
      const hal = checkout('deps/modules/hal/acme', 'build:\n  cmake: .\n');
      template(path.join(hal, 'tests', 'unit'), 'testcase.yaml');

      const found = await find();
      assert.deepEqual([...found.keys()].sort(), [
        'deps/bootloader/mcuboot/boot/zephyr',
        'deps/modules/lang/rust/samples/hello_world',
        'deps/modules/lang/rust/tests/time',
      ]);
      assert.deepEqual([...found.values()].map(entry => entry.origin), ['module', 'module', 'module']);
      assert.equal(found.get('deps/modules/lang/rust/tests/time')?.kind, 'test');
      assert.equal(found.get('deps/bootloader/mcuboot/boot/zephyr')?.kind, 'sample');
    });

    it('does not look for west projects inside an application', async () => {
      const app = template(path.join(ws, 'applications', 'app'), 'tests.yaml');
      const vendored = path.join(app, 'lib', 'module');
      fs.mkdirSync(path.join(vendored, '.git'), { recursive: true });
      write(path.join(vendored, 'zephyr', 'module.yml'), 'samples:\n  - samples\n');
      template(path.join(vendored, 'samples', 'demo'), 'sample.yaml');
      assert.deepEqual([...(await find()).keys()], []);
    });

    it('walks a manifest repository that lists no folders, deciding the kind of each template', async () => {
      const repo = checkout('example-application', 'build:\n  cmake: .\n');
      template(path.join(repo, 'app'), 'sample.yaml', 'sample:\n  name: Example\n');
      template(path.join(repo, 'tests', 'lib', 'custom'), 'testcase.yaml');
      template(path.join(repo, 'demos', 'blinky'), 'tests.yaml', 'sample:\n  name: Blinky\ntests:\n  demo.blinky: {}\n');
      template(path.join(repo, 'samples', 'plain'), 'tests.yaml');
      template(path.join(repo, 'tests', 'plain'), 'tests.yaml');

      const found = await find('example-application');
      assert.deepEqual([...found.entries()].map(([key, entry]) => [key, entry.kind, entry.origin]).sort(), [
        ['example-application/app', 'sample', 'workspace'],
        ['example-application/demos/blinky', 'sample', 'workspace'],
        ['example-application/samples/plain', 'sample', 'workspace'],
        ['example-application/tests/lib/custom', 'test', 'workspace'],
        ['example-application/tests/plain', 'test', 'workspace'],
      ]);
    });

    it('searches a manifest repository that lists its folders as a module only', async () => {
      const nrf = checkout('nrf', 'samples:\n  - applications\n  - samples\ntests:\n  - tests\n');
      write(path.join(nrf, 'CMakeLists.txt'), 'add_subdirectory(lib)\n');
      template(path.join(nrf, 'applications', 'asset_tracker'), 'sample.yaml');
      template(path.join(nrf, 'samples', 'bluetooth', 'peripheral_uart'), 'sample.yaml');
      template(path.join(nrf, 'tests', 'lib', 'date_time'), 'testcase.yaml');
      template(path.join(nrf, 'scripts', 'tool'), 'tests.yaml');

      const found = await find('nrf');
      assert.deepEqual([...found.keys()].sort(), [
        'nrf/applications/asset_tracker',
        'nrf/samples/bluetooth/peripheral_uart',
        'nrf/tests/lib/date_time',
      ]);
      assert.ok([...found.values()].every(entry => entry.origin === 'module'));
    });

    it('checks the top-level folders of the workspace, once each', async () => {
      const app = template(path.join(ws, 'my_app'), 'tests.yaml', 'sample:\n  name: Mine\ntests:\n  my.app: {}\n');
      template(path.join(ws, 'applications', 'deeper'), 'tests.yaml');
      fs.mkdirSync(path.join(app, '.git'));

      const found = await find('my_app');
      assert.deepEqual([...found.keys()], ['my_app']);
      assert.deepEqual(found.get('my_app'), { name: 'my_app', dir: app, kind: 'sample', origin: 'workspace' });
    });

    it('returns nothing for a workspace without Zephyr samples or tests', async () => {
      assert.deepEqual(await findAppTemplates({ root: ws, zephyrBase: path.join(ws, 'missing'), manifestDir: path.join(ws, 'missing') }), []);
    });
  });

  describe('isAppTemplateFolder', () => {
    it('needs a test definition file and a CMakeLists.txt', async () => {
      write(path.join(tmp, 'tests.yaml'), 'tests:\n  some.test: {}\n');
      assert.equal(await isAppTemplateFolder(tmp), false);
      write(path.join(tmp, 'CMakeLists.txt'), 'project(app)\n');
      assert.equal(await isAppTemplateFolder(tmp), true);
      assert.equal(await isAppTemplateFolder(path.join(tmp, 'missing')), false);
    });
  });
});
