// The guards that keep a task the user starts out of a build folder an agent
// is deleting. The job manager, both guards and executeTask are the
// production code; only VS Code's dialogs, progress notifications and task
// system are stood in for.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { guardTaskLaunches, watchBuildConflicts } from '../../../mcp/host/buildConflicts';
import { JobManager, JobState } from '../../../mcp/jobs/jobManager';
import { buildShellTask, executeTask, TaskLaunchDeclined } from '../../../utils/execUtils';

const vscodeStub = require('vscode') as Record<string, any>;

type Answer = () => string | undefined;

interface FakeTask {
  name: string;
  definition: Record<string, unknown>;
  scope: undefined;
  group: { id: string };
  execution?: unknown;
}

interface Harness {
  app: string;
  jobs: JobManager;
  warnings: Array<{ message: string; modal: boolean; items: string[] }>;
  /** Answers for the next warnings, in order; each may act while its warning is shown. */
  answers: Answer[];
  progress: Array<{ title: string; cancellable: boolean }>;
  /** The user presses Cancel on the progress notification. */
  stopWaiting(): void;
  /** Tasks that reached VS Code, and whether the deletion had ended by then. */
  launched: Array<{ name: string; deletionEnded: boolean }>;
  /** Fire onDidStartTask for a task started outside the workbench; resolves once the handler is done. */
  startOutside(task: FakeTask): Promise<{ terminated: boolean }>;
  deletion?: JobState;
}

const realSetTimeout = setTimeout;
const tick = (ms = 10) => new Promise(resolve => realSetTimeout(resolve, ms));

function task(app: string, config?: string, name = 'West Build'): FakeTask {
  return {
    name,
    definition: { type: 'zephyr-workbench', command: 'west', args: ['build'], __appRootPath: app, ...(config ? { config } : {}) },
    scope: undefined,
    group: { id: 'build' },
  };
}

/** An agent west update of a workspace root, running until `finish`. */
function startWestUpdate(h: Harness, root: string): { job: JobState; finish(): Promise<void> } {
  let release: () => void = () => undefined;
  const { job } = h.jobs.start({
    kind: 'west', lockKey: root, requestKey: `west-update:${root}`, westWorkspace: root, writes: ['west_workspace'],
    command: 'west update',
    run: () => new Promise(resolve => { release = () => resolve({ exitCode: 0 }); }),
  });
  return { job, finish: async () => { release(); await job.done; } };
}

/** A workbench task of an application whose folder is `folder`, as VS Code scopes it. */
function scopedTask(folder: string, name = 'West Build'): FakeTask {
  return { ...task(folder, 'primary', name), scope: { uri: { fsPath: folder }, name: path.basename(folder), index: 0 } as never };
}

/** The west update the tree runs, a shell task in the workspace root. */
function westShellTask(root: string): FakeTask {
  return {
    name: 'West Update',
    definition: { type: 'zephyr-workbench-shell', label: 'West Update' },
    scope: undefined,
    group: { id: 'none' },
    execution: { commandLine: 'west update', options: { cwd: root } },
  } as FakeTask;
}

/**
 * Create Venv as createLocalManagedVenv builds it: run from the home folder,
 * given the venv to create on its command line (install.ps1 takes -VenvPath)
 * and the Zephyr tree whose requirements it installs as ZEPHYR_BASE.
 */
function createVenvTask(home: string, venv: string, zephyrBase: string, windows = false): FakeTask {
  const venvOptions = windows ? `-CreateVenv -VenvPath "${venv}"` : `--create-venv --venv-path "${venv}"`;
  return buildShellTask('Creating local virtual environment', `bash /ext/scripts/hosttools/install.sh ${venvOptions} --zephyr-deps west /opt/zinstaller`, {
    cwd: home, env: { ENV_FILE: '/opt/zinstaller/env.sh', ZEPHYR_BASE: zephyrBase }, executable: 'bash', shellArgs: ['-c'],
  }) as unknown as FakeTask;
}

/** An agent deletion that, like removeDirectory, keeps removing files after a cancel until `finish`. */
function startDeletion(h: Harness, configName?: string): { job: JobState; buildDir: string; finish(): Promise<void> } {
  const buildDir = configName ? path.join(h.app, 'build', configName) : path.join(h.app, 'build');
  let release: () => void = () => undefined;
  const { job } = h.jobs.start({
    kind: 'clean', lockKey: buildDir, requestKey: `clean:${buildDir}`, appPath: h.app, configName, buildDir,
    command: `delete ${buildDir}`,
    run: () => new Promise(resolve => { release = () => resolve({ exitCode: 0 }); }),
  });
  h.deletion = job;
  return { job, buildDir, finish: async () => { release(); await job.done; } };
}

describe('mcp/host/buildConflicts agent deletions', () => {
  const saved: Record<string, unknown> = {};
  let h: Harness;
  let disposables: Array<{ dispose(): void }>;

  beforeEach(() => {
    saved.tasks = vscodeStub.tasks;
    saved.TaskGroup = vscodeStub.TaskGroup;
    saved.showWarningMessage = vscodeStub.window.showWarningMessage;
    saved.withProgress = vscodeStub.window.withProgress;

    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-conflicts-')));
    const startListeners: Array<(event: unknown) => unknown> = [];
    const cancelListeners = new Set<() => void>();
    let lastLaunched: FakeTask | undefined;
    h = {
      app: path.join(root, 'blinky'),
      jobs: new JobManager({ logPathFor: id => path.join(root, `${id}.log`) }),
      warnings: [],
      answers: [],
      progress: [],
      launched: [],
      stopWaiting: () => { for (const cancel of cancelListeners) { cancel(); } },
      startOutside: async fake => {
        let terminated = false;
        const execution = { task: fake, terminate: () => { terminated = true; } };
        await Promise.all(startListeners.map(listener => listener({ execution })));
        return { terminated };
      },
    };

    vscodeStub.TaskGroup = { Build: { id: 'build' } };
    vscodeStub.window.showWarningMessage = async (message: string, ...rest: unknown[]) => {
      const options = typeof rest[0] === 'object' && rest[0] !== null ? rest.shift() as { modal?: boolean } : undefined;
      h.warnings.push({ message, modal: options?.modal === true, items: rest as string[] });
      return h.answers.shift()?.();
    };
    vscodeStub.window.withProgress = async (
      options: { title: string; cancellable: boolean },
      work: (progress: unknown, token: unknown) => Promise<unknown>,
    ) => {
      h.progress.push({ title: options.title, cancellable: options.cancellable });
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: (listener: () => void) => {
          const once = () => { token.isCancellationRequested = true; listener(); };
          cancelListeners.add(once);
          return { dispose: () => cancelListeners.delete(once) };
        },
      };
      return work({ report() {} }, token);
    };
    vscodeStub.tasks = {
      executeTask: async (fake: FakeTask) => {
        lastLaunched = fake;
        h.launched.push({ name: fake.name, deletionEnded: h.deletion?.endedAt !== undefined });
        return { task: fake };
      },
      onDidEndTask: (listener: (event: unknown) => void) => {
        setImmediate(() => listener({ execution: { task: lastLaunched } }));
        return { dispose() {} };
      },
      onDidStartTask: (listener: (event: unknown) => unknown) => {
        startListeners.push(listener);
        return { dispose: () => startListeners.splice(startListeners.indexOf(listener), 1) };
      },
    };
    disposables = [guardTaskLaunches(h.jobs), watchBuildConflicts(h.jobs)];
  });

  afterEach(() => {
    for (const disposable of disposables) {
      disposable.dispose();
    }
    vscodeStub.tasks = saved.tasks;
    vscodeStub.TaskGroup = saved.TaskGroup;
    vscodeStub.window.showWarningMessage = saved.showWarningMessage;
    vscodeStub.window.withProgress = saved.withProgress;
  });

  describe('a task launched from the workbench', () => {
    it('is held back while a cancelled deletion is still removing files', async () => {
      const deletion = startDeletion(h, 'primary');
      h.jobs.cancel(deletion.job.id);
      assert.equal(deletion.job.status, 'cancelled');

      h.answers.push(() => undefined);
      await assert.rejects(executeTask(task(h.app, 'primary') as never), TaskLaunchDeclined);
      assert.equal(h.warnings.length, 1);
      assert.equal(h.warnings[0].modal, true);
      assert.match(h.warnings[0].message, /deleting a build folder/);
      assert.deepEqual(h.launched, []);

      // Once the files are gone the task starts without asking.
      await deletion.finish();
      await executeTask(task(h.app, 'primary') as never);
      assert.equal(h.warnings.length, 1);
      assert.deepEqual(h.launched, [{ name: 'West Build', deletionEnded: true }]);
    });

    it('waits for a deletion cancelled while the dialog is open to really end', async () => {
      const deletion = startDeletion(h, 'primary');
      h.answers.push(() => {
        h.jobs.cancel(deletion.job.id);
        return 'Wait and Run';
      });
      const run = executeTask(task(h.app, 'primary') as never);
      await tick(30);
      assert.deepEqual(h.launched, [], 'the task waits while the files are still being removed');

      await deletion.finish();
      await run;
      assert.deepEqual(h.launched, [{ name: 'West Build', deletionEnded: true }]);
    });

    it('keeps waiting as long as the deletion runs, with a notification the user can cancel', async () => {
      const deletion = startDeletion(h, 'primary');
      h.answers.push(() => 'Wait and Run');
      // Any timer of a second or more fires at once, so a time limit on the wait would show.
      (global as { setTimeout: unknown }).setTimeout = (fn: () => void, ms?: number, ...args: unknown[]) =>
        realSetTimeout(fn, (ms ?? 0) >= 1000 ? 0 : ms, ...args);
      try {
        const run = executeTask(task(h.app, 'primary') as never);
        await tick(30);
        assert.deepEqual(h.launched, []);
        assert.deepEqual(h.progress, [{ title: `Waiting for the AI agent to finish deleting ${deletion.buildDir}`, cancellable: true }]);

        await deletion.finish();
        await run;
        assert.deepEqual(h.launched, [{ name: 'West Build', deletionEnded: true }]);
      } finally {
        (global as { setTimeout: unknown }).setTimeout = realSetTimeout;
      }
    });

    it('stays unstarted when the user stops waiting', async () => {
      const deletion = startDeletion(h, 'primary');
      h.answers.push(() => 'Wait and Run');
      const run = executeTask(task(h.app, 'primary') as never);
      await tick(10);
      h.stopWaiting();
      await assert.rejects(run, TaskLaunchDeclined);
      assert.deepEqual(h.launched, []);
      assert.equal(deletion.job.endedAt, undefined);
      assert.equal(h.warnings.length, 1, 'stopping is the user\'s own choice, so nothing more is shown');
      await deletion.finish();
    });
  });

  describe('a task started outside the workbench', () => {
    it('gets a warning while an agent deletes its build folder, and can be stopped', async () => {
      const deletion = startDeletion(h, 'primary');
      h.answers.push(() => 'Stop My Task');
      const { terminated } = await h.startOutside(task(h.app, 'primary'));
      assert.equal(terminated, true);
      assert.equal(h.warnings.length, 1);
      assert.equal(h.warnings[0].modal, false);
      assert.equal(h.warnings[0].message,
        `An AI agent is deleting ${deletion.buildDir} right now. "West Build" uses that folder, so it will likely fail.`);
      assert.deepEqual(h.warnings[0].items, ['Stop My Task', 'Let It Run']);
      await deletion.finish();
    });

    it('is warned about a deletion of every build folder and about a cancelled one still removing files', async () => {
      const all = startDeletion(h, undefined);
      h.answers.push(() => 'Let It Run');
      assert.equal((await h.startOutside(task(h.app, 'debug'))).terminated, false);
      assert.equal(h.warnings.length, 1);
      await all.finish();

      const cancelled = startDeletion(h, 'primary');
      h.jobs.cancel(cancelled.job.id);
      await h.startOutside(task(h.app, 'primary'));
      assert.equal(h.warnings.length, 2);
      await cancelled.finish();

      // Once it has ended, and for another configuration, there is nothing to say.
      await h.startOutside(task(h.app, 'primary'));
      const other = startDeletion(h, 'debug');
      await h.startOutside(task(h.app, 'primary'));
      assert.equal(h.warnings.length, 2);
      await other.finish();
    });
  });
  describe('an agent changing a west workspace', () => {
    it('holds back a build of an application in that workspace until the agent is done', async () => {
      const root = path.dirname(h.app);
      const update = startWestUpdate(h, root);
      h.answers.push(() => 'Wait and Run');
      const run = executeTask(scopedTask(path.join(root, 'apps', 'blinky')) as never);
      await tick(30);
      assert.deepEqual(h.launched, [], 'the build waits for west update');
      assert.equal(h.warnings[0].modal, true);
      assert.match(h.warnings[0].message, /changing the west workspace/);
      await update.finish();
      await run;
      assert.equal(h.launched.length, 1);
    });

    it('holds back the tree\'s own west update of that workspace, and leaves other workspaces alone', async () => {
      const root = path.dirname(h.app);
      const update = startWestUpdate(h, root);
      h.answers.push(() => undefined);
      await assert.rejects(executeTask(westShellTask(root) as never), TaskLaunchDeclined);
      await executeTask(westShellTask(path.join(os.tmpdir(), 'other-workspace')) as never);
      assert.equal(h.launched.length, 1);
      assert.equal(h.warnings.length, 1);
      await update.finish();
    });

    it('leaves alone a shell task that only runs from a folder above the workspace, such as a tools install from the home folder', async () => {
      const root = path.join(path.dirname(h.app), 'zephyrproject');
      const update = startWestUpdate(h, root);
      const toolsInstall = { ...westShellTask(path.dirname(root)), name: 'Installing Host debug tools' };
      await executeTask(toolsInstall as never);
      assert.equal((await h.startOutside(toolsInstall)).terminated, false);
      assert.deepEqual(h.warnings, [], 'nothing is asked or shown');
      assert.equal(h.launched.length, 1);

      // A shell task inside the workspace still waits.
      h.answers.push(() => undefined);
      await assert.rejects(executeTask(westShellTask(path.join(root, 'zephyr')) as never), TaskLaunchDeclined);
      assert.equal(h.warnings.length, 1);
      await update.finish();
    });

    it('holds back Create Venv from the home folder when the venv it makes or the Zephyr tree it reads is in the workspace', async () => {
      const home = path.dirname(h.app);
      const root = path.join(home, 'zephyrproject');
      const elsewhere = path.join(home, 'elsewhere');
      const update = startWestUpdate(h, root);
      for (const createVenv of [
        // The west workspace venv.
        createVenvTask(home, path.join(root, '.venv'), path.join(root, 'zephyr')),
        // A freestanding application's venv, from the requirements of the workspace it builds with.
        createVenvTask(home, path.join(elsewhere, 'app', '.venv'), path.join(root, 'zephyr')),
        // A venv written into the workspace, by install.ps1.
        createVenvTask(home, path.join(root, 'app', '.venv'), path.join(elsewhere, 'zephyr'), true),
      ]) {
        h.answers.push(() => undefined);
        await assert.rejects(executeTask(createVenv as never), TaskLaunchDeclined);
      }
      assert.deepEqual(h.launched, []);
      assert.deepEqual(h.warnings.map(warning => [warning.modal, warning.message]),
        Array(3).fill([true, `An AI agent is changing the west workspace ${root} right now.`]));

      // Started some other way, it gets the warning instead.
      h.answers.push(() => 'Stop My Task');
      const outside = await h.startOutside(createVenvTask(home, path.join(root, '.venv'), path.join(root, 'zephyr')));
      assert.equal(outside.terminated, true);
      assert.equal(h.warnings[3].modal, false);
      await update.finish();
    });

    it('lets Create Venv run for a venv and a Zephyr tree outside the workspace', async () => {
      const home = path.dirname(h.app);
      const update = startWestUpdate(h, path.join(home, 'zephyrproject'));
      const other = path.join(home, 'zephyrproject-other');
      const createVenv = createVenvTask(home, path.join(other, '.venv'), path.join(other, 'zephyr'));
      await executeTask(createVenv as never);
      assert.equal((await h.startOutside(createVenv)).terminated, false);
      assert.deepEqual(h.warnings, [], 'nothing is asked or shown');
      assert.equal(h.launched.length, 1);
      await update.finish();
    });

    it('warns about a task started outside the workbench', async () => {
      const root = path.dirname(h.app);
      const update = startWestUpdate(h, root);
      h.answers.push(() => 'Stop My Task');
      const { terminated } = await h.startOutside(westShellTask(root));
      assert.equal(terminated, true);
      assert.match(h.warnings[0].message, /changing the west workspace .* "West Update" uses it/);
      await update.finish();
    });
  });
});
