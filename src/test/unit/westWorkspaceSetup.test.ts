// The west workspace steps shared by the Add West Workspace wizard, the west
// workspace commands and the manage_west_workspace tool, run against real
// folders and the vscode stub.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  deleteWestWorkspace, initWestWorkspace, removeWorkspaceVenv, resolveWorkspaceDestination, WestInitSteps,
  westInitProblem, westWorkspaceImportProblem, writeFolderSettingsFile,
} from '../../utils/zephyr/westWorkspaceSetup';

const stub = require('vscode') as { workspace: Record<string, unknown> };

function tempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-west-setup-')));
}

/** Steps that record their order; `fail` names one that throws. */
function recordingSteps(fail?: keyof WestInitSteps): { steps: WestInitSteps; ran: string[] } {
  const ran: string[] = [];
  const step = (name: keyof WestInitSteps) => async () => {
    ran.push(name);
    if (name === fail) {
      throw Object.assign(new Error(`${name} failed`), { exitCode: 2 });
    }
  };
  return {
    ran,
    steps: {
      init: step('init'), enableRust: step('enableRust'), update: step('update'), boards: step('boards'),
      createVenv: step('createVenv'), fetchBlobs: step('fetchBlobs'), register: step('register'),
    },
  };
}

describe('utils/zephyr/westWorkspaceSetup', () => {
  describe('resolveWorkspaceDestination', () => {
    it('creates a new workspace in an empty or missing subfolder', () => {
      const location = tempDir();
      assert.deepEqual(resolveWorkspaceDestination(location, 'remote', 'zephyrproject'),
        { workspacePath: path.join(location, 'zephyrproject') });
      fs.mkdirSync(path.join(location, 'empty'));
      assert.equal(resolveWorkspaceDestination(location, 'template', 'empty').problem, undefined);
    });

    it('refuses a subfolder that is not empty, and a folder that looks like a workspace', () => {
      const location = tempDir();
      fs.mkdirSync(path.join(location, 'used'));
      fs.writeFileSync(path.join(location, 'used', 'file'), '');
      assert.match(resolveWorkspaceDestination(location, 'remote', 'used').problem ?? '', /already exists and is not empty/);
      fs.mkdirSync(path.join(location, 'deps'));
      assert.match(resolveWorkspaceDestination(location, 'manifest', '').problem ?? '', /already contains a west workspace/);
    });

    it('expects .west for a local import and ignores the subfolder', () => {
      const location = tempDir();
      assert.match(resolveWorkspaceDestination(location, 'local', 'zephyrproject').problem ?? '', /missing '\.west'/);
      fs.mkdirSync(path.join(location, '.west'));
      assert.deepEqual(resolveWorkspaceDestination(location, 'local', 'zephyrproject'), { workspacePath: location });
    });
  });

  describe('initWestWorkspace', () => {
    it('runs init, update, boards, then register, and the optional steps only when asked', async () => {
      const plain = recordingSteps();
      await initWestWorkspace({ enableRust: false, createVenv: false, fetchBlobs: false }, plain.steps);
      assert.deepEqual(plain.ran, ['init', 'update', 'boards', 'register']);

      const full = recordingSteps();
      const reported: string[] = [];
      await initWestWorkspace({ enableRust: true, createVenv: true, fetchBlobs: true }, full.steps, {
        report: (_increment, message) => reported.push(message),
      });
      assert.deepEqual(full.ran, ['init', 'enableRust', 'update', 'boards', 'createVenv', 'fetchBlobs', 'register']);
      assert.deepEqual(reported, [
        'Initializing manifest...', 'Enabling Rust module...', 'Updating projects...', 'Loading boards...',
        'Creating workspace virtual environment...',
      ]);
    });

    it('stops at a failed step and passes its error on', async () => {
      const { steps, ran } = recordingSteps('update');
      await assert.rejects(initWestWorkspace({ enableRust: true, createVenv: false, fetchBlobs: false }, steps),
        (error: Error & { exitCode?: number }) => error.exitCode === 2);
      assert.deepEqual(ran, ['init', 'enableRust', 'update']);
    });

    it('stops with a cancelled error once cancellation is asked', async () => {
      const { steps, ran } = recordingSteps();
      await assert.rejects(initWestWorkspace({ enableRust: false, createVenv: false, fetchBlobs: false }, steps, {
        isCancelled: () => ran.includes('update'),
      }), (error: Error) => (error as { cause?: unknown }).cause === 'cancelled');
      assert.deepEqual(ran, ['init', 'update']);
    });
  });

  describe('problems the commands report', () => {
    let savedFolders: unknown;
    beforeEach(() => { savedFolders = stub.workspace.workspaceFolders; });
    afterEach(() => { stub.workspace.workspaceFolders = savedFolders; });

    it('refuses a missing path or a folder already in the window', () => {
      const root = tempDir();
      assert.match(westInitProblem(undefined) ?? '', /invalid or already exists/);
      assert.equal(westInitProblem(root), undefined);
      stub.workspace.workspaceFolders = [{ uri: { fsPath: root }, name: 'x', index: 0 }];
      assert.match(westInitProblem(root) ?? '', /invalid or already exists/);
      assert.match(westWorkspaceImportProblem(root) ?? '', /invalid or already exists/);
    });

    it('only imports a folder that holds .west', () => {
      const root = tempDir();
      assert.equal(westWorkspaceImportProblem(root), 'The folder is not a West workspace');
      fs.mkdirSync(path.join(root, '.west'));
      assert.equal(westWorkspaceImportProblem(root), undefined);
    });
  });

  describe('writeFolderSettingsFile', () => {
    it('creates the file, keeps other settings and comments-parsed values, and is idempotent', async () => {
      const root = tempDir();
      assert.equal(await writeFolderSettingsFile(root, { 'cmake.enableAutomaticKitScan': false }), 'written');
      const file = path.join(root, '.vscode', 'settings.json');
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'cmake.enableAutomaticKitScan': false });

      fs.writeFileSync(file, '{\n  // mine\n  "editor.tabSize": 2,\n}\n');
      assert.equal(await writeFolderSettingsFile(root, { 'cmake.enableAutomaticKitScan': false }), 'written');
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'editor.tabSize': 2, 'cmake.enableAutomaticKitScan': false });
      assert.equal(await writeFolderSettingsFile(root, { 'cmake.enableAutomaticKitScan': false }), 'unchanged');
    });

    it('leaves a file it cannot parse untouched', async () => {
      const root = tempDir();
      const file = path.join(root, '.vscode', 'settings.json');
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, '[1, 2');
      assert.equal(await writeFolderSettingsFile(root, { a: 1 }), 'unparsable');
      assert.equal(fs.readFileSync(file, 'utf8'), '[1, 2');
    });
  });

  describe('removal helpers', () => {
    let savedGetConfiguration: unknown;
    beforeEach(() => { savedGetConfiguration = stub.workspace.getConfiguration; });
    afterEach(() => { stub.workspace.getConfiguration = savedGetConfiguration; });

    it('clears the venv setting and removes only the managed .venv', async () => {
      const root = tempDir();
      const updates: Array<[string, unknown]> = [];
      stub.workspace.getConfiguration = () => ({ update: async (key: string, value: unknown) => { updates.push([key, value]); } });
      const removed: string[] = [];
      const folder = { uri: { fsPath: root }, name: 'ws', index: 0 } as never;
      assert.equal(await removeWorkspaceVenv(folder, dir => removed.push(dir)), undefined);
      fs.mkdirSync(path.join(root, '.venv'));
      assert.equal(await removeWorkspaceVenv(folder, dir => removed.push(dir)), path.join(root, '.venv'));
      assert.deepEqual(updates, [['venv.path', undefined], ['venv.path', undefined]]);
      assert.deepEqual(removed, [path.join(root, '.venv')]);
    });

    it('deletes a workspace only through a folder, unregistering it first', async () => {
      const calls: string[] = [];
      const ops = { unregister: () => { calls.push('unregister'); }, remove: (dir: string) => { calls.push(`remove ${dir}`); return 'removed'; } };
      assert.equal(await deleteWestWorkspace('/ws', ops, undefined), undefined);
      assert.deepEqual(calls, []);
      assert.equal(await deleteWestWorkspace('/ws', ops, { uri: { fsPath: '/ws' } } as never), 'removed');
      assert.deepEqual(calls, ['unregister', 'remove /ws']);
    });
  });
});
