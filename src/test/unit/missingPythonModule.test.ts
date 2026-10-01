// A board discovery that fails because the venv west runs in lacks a Python
// module: which module, which venv, and the button that rebuilds that venv.

import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WestCommandError } from '../../commands/WestCommands';
import { WestWorkspace } from '../../models/WestWorkspace';
import { missingPythonModule } from '../../utils/zephyr/westFailures';
import { describeMissingPythonModule } from '../../utils/zephyr/missingPythonModule';
import { westCommandVenv } from '../../utils/zephyr/westWorkspaceSetup';

// Settings come from `settings`, and the internal dir and env.yml follow
// VSCODE_PORTABLE into a scratch folder, so nothing here depends on this
// machine, as in the venv resolution tests.
const stub = require('vscode') as {
  Uri: object;
  workspace: { getConfiguration: unknown };
  commands: { executeCommand: unknown };
};
const VENV = 'zephyr-workbench.venv.path';

const TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "C:\\ws\\deps\\zephyr\\scripts\\list_boards.py", line 13, in <module>',
  '    import jsonschema',
  "ModuleNotFoundError: No module named 'jsonschema'",
].join('\n');

describe('missingPythonModule', () => {
  it('names the module west could not import', () => {
    assert.equal(missingPythonModule(TRACEBACK), 'jsonschema');
    assert.equal(missingPythonModule("ModuleNotFoundError: No module named 'jsonschema.exceptions'"), 'jsonschema');
    assert.equal(missingPythonModule('ImportError: No module named yaml'), 'yaml');
  });

  it('leaves a missing west and other failures alone', () => {
    assert.equal(missingPythonModule("ModuleNotFoundError: No module named 'west'"), undefined);
    assert.equal(missingPythonModule("ERROR: SoC 'atsamd51j19a' is not found"), undefined);
    assert.equal(missingPythonModule(''), undefined);
  });
});

describe('a board discovery that fails on a missing Python module', () => {
  let root: string;
  let workspace: WestWorkspace;
  let settings: Record<string, unknown>;
  let commands: unknown[][];
  let savedPortable: string | undefined;
  let saved: { Uri: object; getConfiguration: unknown; executeCommand: unknown };

  before(() => {
    // The settings reader tests `scope instanceof vscode.Uri`, which needs a constructor.
    saved = { Uri: stub.Uri, getConfiguration: stub.workspace.getConfiguration, executeCommand: stub.commands.executeCommand };
    stub.Uri = Object.assign(function Uri() { /* stub */ }, saved.Uri);
    stub.workspace.getConfiguration = () => ({ get: (key: string) => settings[key], update: async () => undefined });
    stub.commands.executeCommand = async (...args: unknown[]) => { commands.push(args); };
  });
  after(() => {
    stub.Uri = saved.Uri;
    stub.workspace.getConfiguration = saved.getConfiguration;
    stub.commands.executeCommand = saved.executeCommand;
  });
  beforeEach(() => {
    savedPortable = process.env.VSCODE_PORTABLE;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-pymodule-'));
    process.env.VSCODE_PORTABLE = root;
    fs.mkdirSync(path.join(root, '.zinstaller'));
    workspace = { name: 'zephyrproject', rootUri: { fsPath: path.join(root, 'zephyrproject') } } as unknown as WestWorkspace;
    settings = {};
    commands = [];
  });
  afterEach(() => {
    if (savedPortable === undefined) {
      delete process.env.VSCODE_PORTABLE;
    } else {
      process.env.VSCODE_PORTABLE = savedPortable;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const failure = (stderr = TRACEBACK) => new WestCommandError(stderr, stderr);

  it('offers to recreate the dedicated venv of the workspace', async () => {
    settings[VENV] = path.join(root, 'zephyrproject', '.venv');
    assert.equal(westCommandVenv(workspace).kind, 'dedicated');
    const notice = describeMissingPythonModule(failure(), workspace);
    assert.equal(notice?.module, 'jsonschema');
    assert.match(notice?.message ?? '', /Python module 'jsonschema', which is missing from the dedicated venv of zephyrproject/);
    assert.equal(notice?.repair?.title, 'Recreate dedicated venv');
    await notice?.repair?.run();
    assert.deepEqual(commands, [['zephyr-workbench-west-workspace.create-venv', { westWorkspace: workspace }]]);
  });

  it('offers to reinstall the global venv when west runs in the venv of the host tools', async () => {
    for (const configured of [undefined, path.join(root, '.zinstaller', '.venv')]) {
      settings[VENV] = configured;
      commands = [];
      assert.equal(westCommandVenv(workspace).kind, 'global');
      const notice = describeMissingPythonModule(failure(), workspace);
      assert.match(notice?.message ?? '', /missing from the global venv/);
      assert.equal(notice?.repair?.title, 'Reinstall global venv');
      await notice?.repair?.run();
      assert.deepEqual(commands, [['zephyr-workbench.reinstall-venv', true]]);
    }
  });

  it('only names a venv the workbench did not create, without a button', () => {
    const custom = path.join(root, 'my-python');
    settings[VENV] = custom;
    assert.deepEqual(westCommandVenv(workspace), { kind: 'custom', path: custom });
    const notice = describeMissingPythonModule(failure(), workspace);
    assert.match(notice?.message ?? '', new RegExp(`missing from the venv ${custom.replace(/\\/g, '\\\\')}`));
    assert.equal(notice?.repair, undefined);
  });

  it('says nothing for any other failure', () => {
    assert.equal(describeMissingPythonModule(failure("ERROR: SoC 'atsamd51j19a' is not found"), workspace), undefined);
    assert.equal(describeMissingPythonModule(failure("ModuleNotFoundError: No module named 'west'"), workspace), undefined);
    assert.equal(describeMissingPythonModule(new Error(TRACEBACK), workspace), undefined, 'only a west run is read');
  });
});
