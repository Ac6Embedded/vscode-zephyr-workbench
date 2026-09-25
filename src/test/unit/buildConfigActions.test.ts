// Which tasks in a shared tasks.json follow a configuration that becomes
// active. A west workspace keeps one tasks.json for all its applications, so a
// change on one application must leave the other applications' tasks alone.
// The tasks.json code is the production code; only the workspace settings
// that list the applications are stood in for.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ZephyrApplication } from '../../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../../models/ZephyrBuildConfig';
import { updateTasks } from '../../providers/ZephyrTaskProvider';
import { syncActiveBuildConfig, tasksRunningFor } from '../../utils/zephyr/buildConfigActions';

const vscodeStub = require('vscode') as { workspace: { getConfiguration: unknown } };

interface SavedTask {
  label: string;
  type: string;
  appRoot?: string;
  config?: string;
  command?: string;
  args?: string[];
}

const ARGS = (index: number) => [
  'build', `--board \${config:zephyr-workbench.build.configurations.${index}.board}`,
];

describe('utils/zephyr/buildConfigActions tasks.json scope', () => {
  let savedGetConfiguration: unknown;
  let ws: string;
  let folder: { uri: { fsPath: string }; name: string; index: number };
  let settings: Record<string, unknown>;

  before(() => {
    savedGetConfiguration = vscodeStub.workspace.getConfiguration;
    vscodeStub.workspace.getConfiguration = () => ({
      get: (key: string, fallback?: unknown) => (key in settings ? settings[key] : fallback),
      update: async () => undefined,
    });
  });
  after(() => {
    vscodeStub.workspace.getConfiguration = savedGetConfiguration;
  });

  beforeEach(() => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-tasks-')));
    folder = { uri: { fsPath: ws }, name: 'ws', index: 0 };
    // A west workspace with applications A and B, A selected.
    settings = {
      'westWorkspace.applications': [{ path: 'apps/A' }, { path: 'apps/B' }],
      'westWorkspace.selectedApplication': 'apps/A',
    };
  });

  const project = (relative: string, west = true) => ({
    appRootPath: path.join(ws, relative),
    appWorkspaceFolder: folder,
    isWestWorkspaceApplication: west,
    buildConfigs: [],
  }) as unknown as ZephyrApplication;

  function writeTasks(tasks: SavedTask[]): void {
    fs.mkdirSync(path.join(ws, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks }, null, 2));
  }

  function readTasks(): Record<string, SavedTask> {
    const saved = JSON.parse(fs.readFileSync(path.join(ws, '.vscode', 'tasks.json'), 'utf8')) as { tasks: SavedTask[] };
    return Object.fromEntries(saved.tasks.map(task => [task.label, task]));
  }

  const TASKS: SavedTask[] = [
    { label: 'Build A', type: 'zephyr-workbench', appRoot: 'apps/A', config: 'primary', command: 'west', args: ARGS(0) },
    { label: 'Build B', type: 'zephyr-workbench', appRoot: 'apps/B', config: 'primary', command: 'west', args: ARGS(0) },
    // Saved by "Add Custom Task" with no appRoot: it runs for the selected application.
    { label: 'Custom', type: 'zephyr-workbench', config: 'primary', command: 'west', args: ARGS(0) },
    { label: 'Echo', type: 'shell', command: 'echo' },
  ];

  it('moves only the tasks of the application whose configuration became active', async () => {
    writeTasks(TASKS);
    await syncActiveBuildConfig(project('apps/B'), { name: 'release' } as ZephyrBuildConfig, 1);
    const tasks = readTasks();
    assert.equal(tasks['Build B'].config, 'release');
    assert.deepEqual(tasks['Build B'].args, ARGS(1));
    // A has no "release"; its tasks would lose their board and build folder.
    assert.equal(tasks['Build A'].config, 'primary');
    assert.deepEqual(tasks['Build A'].args, ARGS(0));
    assert.equal(tasks.Custom.config, 'primary');
    assert.deepEqual(tasks.Echo, TASKS[3]);
  });

  it('counts a task with no application as the selected application\'s, and an appRoot inside an application as that one\'s', () => {
    const ownedByA = tasksRunningFor(project('apps/A'));
    const ownedByB = tasksRunningFor(project('apps/B'));
    const custom = { type: 'zephyr-workbench' };
    const nested = { type: 'zephyr-workbench', appRoot: path.join(ws, 'apps', 'A', 'src') };
    const internal = { type: 'zephyr-workbench', __appRootPath: path.join(ws, 'apps', 'B') };
    assert.deepEqual([ownedByA(custom), ownedByA(nested), ownedByA(internal)], [true, true, false]);
    assert.deepEqual([ownedByB(custom), ownedByB(nested), ownedByB(internal)], [false, false, true]);
  });

  it('keeps every task of a freestanding application that names no other application', () => {
    settings = {};
    const owned = tasksRunningFor(project('', false));
    assert.equal(owned({ type: 'zephyr-workbench' }), true);
    assert.equal(owned({ type: 'zephyr-workbench', appRoot: ws }), true);
    assert.equal(owned({ type: 'zephyr-workbench', appRoot: path.join(path.dirname(ws), 'elsewhere') }), false);
  });

  it('still moves every workbench task when no scope is given, as the Applications view does', async () => {
    writeTasks(TASKS);
    await updateTasks(folder as never, 'release', 1);
    const tasks = readTasks();
    assert.deepEqual(['Build A', 'Build B', 'Custom'].map(label => tasks[label].config), ['release', 'release', 'release']);
    assert.deepEqual(tasks.Echo, TASKS[3]);
  });
});
