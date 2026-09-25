// The fence in front of deleting an application folder, and the folder
// arguments of manage_app, against real folders.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertAppFolderPath, assertApplicationsSubfolder, assertAppName } from '../../../mcp/core/appArgs';
import { AppFolderFenceInput, checkAppFolderDeletion, measureFolder } from '../../../mcp/core/appFolderFence';
import { McpToolError } from '../../../mcp/core/errors';

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as McpToolError).code;
  }
}

function write(file: string, text = ''): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function makeApp(dir: string): string {
  write(path.join(dir, 'CMakeLists.txt'), 'project(app)\n');
  write(path.join(dir, 'prj.conf'), 'CONFIG_GPIO=y\n');
  return dir;
}

describe('mcp/core/appArgs', () => {
  it('takes plain application names only', () => {
    assert.equal(assertAppName('blinky_2.0-rc'), 'blinky_2.0-rc');
    for (const bad of ['', 'my app', '../x', 'a/b', '-x', '.hidden', 'x'.repeat(65), 'a;b', '$(id)']) {
      assert.equal(codeOf(() => assertAppName(bad)), 'INVALID_ARGUMENT', bad);
    }
  });

  it('keeps the applications subfolder relative, inside the workspace and without spaces', () => {
    assert.equal(assertApplicationsSubfolder('applications'), 'applications');
    assert.equal(assertApplicationsSubfolder('apps/nordic/'), 'apps/nordic');
    assert.equal(assertApplicationsSubfolder(''), '');
    for (const bad of ['/abs', 'C:\\apps', '../out', 'apps/../..', 'my apps', 'apps/./x', 'a$b']) {
      assert.equal(codeOf(() => assertApplicationsSubfolder(bad)), 'INVALID_ARGUMENT', bad);
    }
  });

  it('takes absolute plain folder paths without spaces', () => {
    const home = os.homedir();
    assert.equal(assertAppFolderPath(path.join(home, 'apps'), 'parent_dir'), path.join(home, 'apps'));
    for (const bad of ['relative/apps', path.join(home, 'my apps'), path.join(home, 'a$b'), `${home}/a/../b`, `${home}/x;rm`]) {
      assert.equal(codeOf(() => assertAppFolderPath(bad, 'parent_dir')), 'INVALID_ARGUMENT', bad);
    }
  });
});

describe('mcp/core/appFolderFence', () => {
  let root: string;
  let ws: string;
  let zephyr: string;
  let app: string;
  let input: AppFolderFenceInput;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-appfence-')));
    ws = path.join(root, 'ws');
    zephyr = path.join(ws, 'zephyr');
    fs.mkdirSync(path.join(ws, '.west'), { recursive: true });
    app = makeApp(path.join(root, 'apps', 'blinky'));
    input = {
      target: app,
      registeredApps: [app],
      westWorkspaces: [{ root: ws, protectedTrees: [zephyr, path.join(ws, 'modules', 'lang', 'rust')] }],
      knownRoots: [app, ws],
      homeDir: path.join(root, 'home'),
    };
  });

  it('lets a registered application folder go, and calls a missing one already gone', () => {
    assert.deepEqual(checkAppFolderDeletion(input), { exists: true });
    fs.rmSync(app, { recursive: true });
    assert.deepEqual(checkAppFolderDeletion(input), { exists: false });
  });

  it('refuses a folder that is not a registered application root', () => {
    assert.equal(codeOf(() => checkAppFolderDeletion({ ...input, target: path.join(app, 'src') })), 'APP_NOT_FOUND');
    assert.equal(codeOf(() => checkAppFolderDeletion({ ...input, registeredApps: [] })), 'APP_NOT_FOUND');
  });

  it('refuses a symbolic link, a west workspace root and the home folder', () => {
    const link = path.join(root, 'link');
    fs.symlinkSync(app, link);
    assert.equal(codeOf(() => checkAppFolderDeletion({ ...input, target: link, registeredApps: [link] })), 'PATH_OUTSIDE_WORKSPACE');

    makeApp(ws);
    assert.equal(codeOf(() => checkAppFolderDeletion({ ...input, target: ws, registeredApps: [ws] })), 'PATH_OUTSIDE_WORKSPACE');

    const home = makeApp(path.join(root, 'home'));
    assert.equal(codeOf(() => checkAppFolderDeletion({ ...input, target: home, registeredApps: [home] })), 'PATH_OUTSIDE_WORKSPACE');
  });

  it('refuses a sample configured in place inside the Zephyr tree', () => {
    const inPlace = makeApp(path.join(zephyr, 'samples', 'hello_world'));
    assert.equal(codeOf(() => checkAppFolderDeletion({ ...input, target: inPlace, registeredApps: [inPlace] })), 'PATH_OUTSIDE_WORKSPACE');
  });

  it('refuses a sample or test configured in place in any other west project, by its metadata', () => {
    const inPlace = makeApp(path.join(ws, 'nrf', 'samples', 'bluetooth', 'peripheral_uart'));
    write(path.join(inPlace, 'sample.yaml'), 'sample:\n  name: NUS\n');
    const refusal = (() => {
      try {
        checkAppFolderDeletion({ ...input, target: inPlace, registeredApps: [inPlace] });
      } catch (error) {
        return error as McpToolError;
      }
      return undefined;
    })();
    assert.equal(refusal?.code, 'PATH_OUTSIDE_WORKSPACE');
    assert.deepEqual(refusal?.details, { metadata: 'sample.yaml', inside: ws });

    const test = makeApp(path.join(ws, 'modules', 'lib', 'mylib', 'tests', 'unit'));
    write(path.join(test, 'testcase.yaml'), 'tests:\n  mylib.unit: {}\n');
    assert.equal(codeOf(() => checkAppFolderDeletion({ ...input, target: test, registeredApps: [test] })), 'PATH_OUTSIDE_WORKSPACE');

    write(path.join(app, 'src', 'sample.yaml'), 'not at the root');
    assert.deepEqual(checkAppFolderDeletion(input), { exists: true }, 'only a metadata file at the root marks a sample');
  });

  it('lets an application of its own keep sample or test metadata, unless it lies in another git checkout', () => {
    // A freestanding application with twister metadata for its CI, in its own repository.
    write(path.join(app, 'sample.yaml'), 'sample:\n  name: blinky\n');
    write(path.join(app, 'testcase.yaml'), 'tests:\n  blinky.ci: {}\n');
    fs.mkdirSync(path.join(app, '.git'));
    assert.deepEqual(checkAppFolderDeletion(input), { exists: true });
    fs.rmSync(path.join(app, '.git'), { recursive: true });
    assert.deepEqual(checkAppFolderDeletion(input), { exists: true }, 'nor in any repository');

    // The same folder as a sample of a plain checkout, such as a clone of a module.
    const checkout = path.join(root, 'apps');
    write(path.join(checkout, '.git'), 'gitdir: ../.git/modules/apps\n');
    const refusal = (() => {
      try {
        checkAppFolderDeletion(input);
      } catch (error) {
        return error as McpToolError;
      }
      return undefined;
    })();
    assert.equal(refusal?.code, 'PATH_OUTSIDE_WORKSPACE');
    assert.deepEqual(refusal?.details, { metadata: 'sample.yaml', inside: checkout });

    // Reached through a link to a folder deep in that checkout.
    const deep = makeApp(path.join(checkout, 'samples', 'uart'));
    write(path.join(deep, 'sample.yaml'), 'sample:\n  name: uart\n');
    const link = path.join(root, 'linked');
    fs.symlinkSync(path.join(checkout, 'samples'), link);
    const throughLink = path.join(link, 'uart');
    assert.equal(codeOf(() => checkAppFolderDeletion({ ...input, target: throughLink, registeredApps: [throughLink] })), 'PATH_OUTSIDE_WORKSPACE');
  });

  it('refuses a folder holding another application or a west workspace', () => {
    const nested = makeApp(path.join(app, 'nested'));
    assert.equal(codeOf(() => checkAppFolderDeletion({ ...input, registeredApps: [app, nested] })), 'PATH_OUTSIDE_WORKSPACE');
    const inner = path.join(app, 'inner-ws');
    fs.mkdirSync(inner);
    assert.equal(codeOf(() => checkAppFolderDeletion({
      ...input, westWorkspaces: [...input.westWorkspaces, { root: inner, protectedTrees: [] }],
    })), 'PATH_OUTSIDE_WORKSPACE');
  });

  it('refuses a folder that no longer looks like an application', () => {
    fs.rmSync(path.join(app, 'CMakeLists.txt'));
    fs.rmSync(path.join(app, 'prj.conf'));
    write(path.join(app, 'notes.txt'), 'mine');
    assert.equal(codeOf(() => checkAppFolderDeletion(input)), 'INVALID_ARGUMENT');
  });

  it('measures a folder without following links, and stops at its limit', () => {
    write(path.join(app, 'src', 'main.c'), '12345');
    fs.symlinkSync(root, path.join(app, 'loop'));
    const size = measureFolder(app);
    assert.equal(size.files, 3);
    assert.equal(size.bytes, 'project(app)\n'.length + 'CONFIG_GPIO=y\n'.length + 5);
    assert.ok(size.complete);
    assert.equal(measureFolder(app, 2).complete, false);
  });
});
