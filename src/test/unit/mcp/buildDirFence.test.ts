import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkBuildDirDeletion } from '../../../mcp/core/buildDirFence';
import { McpToolError } from '../../../mcp/core/errors';

function tempApp(): string {
  // realpath: on macOS the temp folder is itself reached through a symbolic link.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-fence-')));
  const app = path.join(root, 'app');
  fs.mkdirSync(app);
  return app;
}

function write(file: string, text = ''): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as McpToolError).code;
  }
}

describe('mcp/core/buildDirFence', () => {
  it('reports a missing folder without refusing, so a repeated delete is harmless', () => {
    const app = tempApp();
    const target = path.join(app, 'build', 'primary');
    assert.deepEqual(checkBuildDirDeletion({ appRootPath: app, target, configNames: ['primary'], knownRoots: [app] }), { exists: false });
    write(path.join(app, 'build', 'other', 'CMakeCache.txt'));
    assert.deepEqual(checkBuildDirDeletion({ appRootPath: app, target, configNames: ['primary'], knownRoots: [app] }), { exists: false });
  });

  it('accepts a configuration folder that holds build output, is empty, or is named after a configuration', () => {
    const app = tempApp();
    write(path.join(app, 'build', 'a', 'CMakeCache.txt'));
    write(path.join(app, 'build', 'b', 'domains.yaml'));
    fs.mkdirSync(path.join(app, 'build', 'c'));
    write(path.join(app, 'build', 'primary', 'notes.txt'));
    for (const name of ['a', 'b', 'c', 'primary']) {
      const result = checkBuildDirDeletion({ appRootPath: app, target: path.join(app, 'build', name), configNames: ['primary'], knownRoots: [app] });
      assert.deepEqual(result, { exists: true }, name);
    }
  });

  it('refuses a folder that holds no build output and belongs to no configuration', () => {
    const app = tempApp();
    write(path.join(app, 'build', 'docs', 'notes.txt'));
    try {
      checkBuildDirDeletion({ appRootPath: app, target: path.join(app, 'build', 'docs'), configNames: ['primary'], knownRoots: [app] });
      assert.fail('expected a refusal');
    } catch (error) {
      assert.equal((error as McpToolError).code, 'INVALID_ARGUMENT');
      assert.match((error as McpToolError).message, /does not look like a Zephyr build folder/);
    }
  });

  it('refuses a target that is not <app>/build or one folder directly in it', () => {
    const app = tempApp();
    for (const target of [app, path.join(app, 'src'), path.join(app, 'build', 'a', 'b'), path.dirname(app)]) {
      assert.equal(codeOf(() => checkBuildDirDeletion({ appRootPath: app, target, configNames: [], knownRoots: [app] })),
        'PATH_OUTSIDE_WORKSPACE', target);
    }
  });

  it('refuses symbolic links, for the build folder and for a configuration folder', function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    const app = tempApp();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-outside-'));
    write(path.join(outside, 'CMakeCache.txt'));
    fs.mkdirSync(path.join(app, 'build'));
    fs.symlinkSync(outside, path.join(app, 'build', 'primary'));
    assert.equal(codeOf(() => checkBuildDirDeletion({
      appRootPath: app, target: path.join(app, 'build', 'primary'), configNames: ['primary'], knownRoots: [app],
    })), 'PATH_OUTSIDE_WORKSPACE');

    const other = tempApp();
    fs.symlinkSync(outside, path.join(other, 'build'));
    assert.equal(codeOf(() => checkBuildDirDeletion({
      appRootPath: other, target: path.join(other, 'build'), configNames: [], knownRoots: [other],
    })), 'PATH_OUTSIDE_WORKSPACE');
    assert.ok(fs.existsSync(path.join(outside, 'CMakeCache.txt')));
  });

  it('refuses a folder that contains a folder this window works in', () => {
    const app = tempApp();
    write(path.join(app, 'build', 'primary', 'CMakeCache.txt'));
    const nested = path.join(app, 'build', 'primary', 'nested_app');
    fs.mkdirSync(nested);
    assert.equal(codeOf(() => checkBuildDirDeletion({
      appRootPath: app, target: path.join(app, 'build', 'primary'), configNames: ['primary'], knownRoots: [app, nested],
    })), 'PATH_OUTSIDE_WORKSPACE');
  });

  it('refuses a file where a build folder should be', () => {
    const app = tempApp();
    write(path.join(app, 'build', 'primary'), 'not a folder');
    assert.equal(codeOf(() => checkBuildDirDeletion({
      appRootPath: app, target: path.join(app, 'build', 'primary'), configNames: ['primary'], knownRoots: [app],
    })), 'INVALID_ARGUMENT');
  });

  describe('the whole build folder', () => {
    it('accepts a flat build straight into <app>/build', () => {
      const app = tempApp();
      write(path.join(app, 'build', 'build_info.yml'));
      write(path.join(app, 'build', 'zephyr', 'zephyr.elf'));
      assert.deepEqual(checkBuildDirDeletion({ appRootPath: app, target: path.join(app, 'build'), configNames: [], knownRoots: [app] }),
        { exists: true });
    });

    it('accepts configuration folders and the files an operating system drops everywhere', () => {
      const app = tempApp();
      write(path.join(app, 'build', 'primary', '.zephyr-workbench-build-state.json'));
      write(path.join(app, 'build', 'old', 'CMakeCache.txt'));
      fs.mkdirSync(path.join(app, 'build', 'empty'));
      write(path.join(app, 'build', '.DS_Store'));
      assert.deepEqual(checkBuildDirDeletion({ appRootPath: app, target: path.join(app, 'build'), configNames: ['primary'], knownRoots: [app] }),
        { exists: true });
    });

    it('lists what it does not recognise and deletes nothing', () => {
      const app = tempApp();
      write(path.join(app, 'build', 'primary', 'CMakeCache.txt'));
      write(path.join(app, 'build', 'README.md'));
      write(path.join(app, 'build', 'keep', 'data.bin'));
      try {
        checkBuildDirDeletion({ appRootPath: app, target: path.join(app, 'build'), configNames: ['primary'], knownRoots: [app] });
        assert.fail('expected a refusal');
      } catch (error) {
        assert.equal((error as McpToolError).code, 'INVALID_ARGUMENT');
        const details = (error as McpToolError).details as { unexpected: string[]; unexpected_count: number };
        assert.deepEqual([...details.unexpected].sort(), ['README.md', 'keep']);
        assert.equal(details.unexpected_count, 2);
      }
    });
  });
});
