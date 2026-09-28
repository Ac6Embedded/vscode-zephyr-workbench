// The West Flash task and the guard that keeps a user's task off a
// configuration an agent is flashing. The argument composition is the real
// buildDirectTask code; only VS Code's dialogs and task system are stood in for.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { guardTaskLaunches, runningAgentBuildFor, watchBuildConflicts } from '../../../mcp/host/buildConflicts';
import { JobManager, JobState } from '../../../mcp/jobs/jobManager';
import { directTaskArgs, taskTemplate } from '../../../providers/ZephyrTaskProvider';
import { executeTask, TaskLaunchDeclined } from '../../../utils/execUtils';

const vscodeStub = require('vscode') as Record<string, any>;

const SHELL = { buildDirVar: '${BUILD_DIR}', expand: { shellKind: 'bash', isWindows: false } };

describe('providers/ZephyrTaskProvider direct task arguments', () => {
  it('never passes --board to west flash, which its parser would take as --board-dir', () => {
    const args = directTaskArgs(taskTemplate('West Flash')!, 'West Flash', 'nrf52840dk/nrf52840', {
      flashRunner: 'jlink', flashRunnerArgs: '--speed 4000', extraArgs: ['--domain app', '--erase'],
    }, SHELL);
    assert.deepEqual(args, ['flash', '--runner jlink', '--domain app', '--erase', '--build-dir "${BUILD_DIR}"', '--speed 4000']);
  });

  it('keeps --board for the tasks whose subcommand takes it, and leaves it out of west spdx', () => {
    const build = directTaskArgs(taskTemplate('West Build')!, 'West Build', 'nrf52840dk/nrf52840', {}, SHELL);
    assert.ok(build.includes('--board nrf52840dk/nrf52840'), build.join(' '));
    const spdx = directTaskArgs(taskTemplate('SPDX init')!, 'SPDX init', 'nrf52840dk/nrf52840', {}, SHELL);
    assert.ok(!spdx.some(arg => arg.startsWith('--board')), spdx.join(' '));
  });

  it('ignores the flash runner options for a task other than West Flash', () => {
    const build = directTaskArgs(taskTemplate('West Build')!, 'West Build', 'b', { flashRunner: 'jlink', flashRunnerArgs: '--x' }, SHELL);
    assert.ok(!build.some(arg => arg.includes('jlink') || arg === '--x'), build.join(' '));
  });
});

describe('mcp/host/buildConflicts agent flashes', () => {
  const saved: Record<string, unknown> = {};
  let root: string;
  let app: string;
  let jobs: JobManager;
  let warnings: Array<{ message: string; detail?: string; items: string[] }>;
  let answers: Array<string | undefined>;
  let launched: string[];
  let startListeners: Array<(event: unknown) => unknown>;
  let disposables: Array<{ dispose(): void }>;
  let release: () => void;

  function userTask(config = 'primary', name = 'West Flash') {
    return {
      name,
      definition: { type: 'zephyr-workbench', command: 'west', args: ['flash'], __appRootPath: app, config },
      scope: undefined,
      group: { id: 'none' },
    };
  }

  function startFlash(): JobState {
    const buildDir = path.join(app, 'build', 'primary');
    const { job } = jobs.start({
      kind: 'flash', lockKey: 'flash:jlink:default', requestKey: 'flash', appPath: app, configName: 'primary', buildDir,
      writes: ['build_dir'], command: 'west flash --runner jlink',
      run: (_sink, signal) => new Promise(resolve => {
        release = () => resolve({ exitCode: 0 });
        signal.addEventListener('abort', () => resolve({ exitCode: undefined }), { once: true });
      }),
    });
    return job;
  }

  beforeEach(() => {
    saved.tasks = vscodeStub.tasks;
    saved.showWarningMessage = vscodeStub.window.showWarningMessage;
    saved.withProgress = vscodeStub.window.withProgress;
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-flash-guard-')));
    app = path.join(root, 'blinky');
    jobs = new JobManager({ logPathFor: id => path.join(root, `${id}.log`) });
    warnings = [];
    answers = [];
    launched = [];
    startListeners = [];
    release = () => undefined;
    vscodeStub.window.showWarningMessage = async (message: string, ...rest: unknown[]) => {
      const options = typeof rest[0] === 'object' && rest[0] !== null ? rest.shift() as { detail?: string } : undefined;
      warnings.push({ message, detail: options?.detail, items: rest as string[] });
      return answers.shift();
    };
    vscodeStub.window.withProgress = async (_options: unknown, work: (progress: unknown, token: unknown) => Promise<unknown>) =>
      work({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
    let lastLaunched: unknown;
    vscodeStub.tasks = {
      ...(saved.tasks as object),
      executeTask: async (task: { name: string }) => {
        launched.push(task.name);
        lastLaunched = task;
        return { task };
      },
      onDidEndTask: (listener: (event: unknown) => void) => {
        setImmediate(() => listener({ execution: { task: lastLaunched } }));
        return { dispose() {} };
      },
      onDidStartTask: (listener: (event: unknown) => unknown) => {
        startListeners.push(listener);
        return { dispose() {} };
      },
    };
    disposables = [guardTaskLaunches(jobs), watchBuildConflicts(jobs)];
  });

  afterEach(async () => {
    for (const disposable of disposables) {
      disposable.dispose();
    }
    release();
    await Promise.all(jobs.list().map(job => job.done));
    vscodeStub.tasks = saved.tasks;
    vscodeStub.window.showWarningMessage = saved.showWarningMessage;
    vscodeStub.window.withProgress = saved.withProgress;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('counts a running agent flash like an agent build of its configuration', () => {
    startFlash();
    assert.ok(runningAgentBuildFor(jobs, userTask() as never));
    assert.equal(runningAgentBuildFor(jobs, userTask('secondary') as never), undefined);
  });

  it('counts a build run through run_command like an agent build, and no other command', () => {
    const buildDir = path.join(app, 'build', 'primary');
    let done: (value: { exitCode: number }) => void = () => undefined;
    const ended = new Promise<{ exitCode: number }>(resolve => { done = resolve; });
    release = () => done({ exitCode: 0 });
    jobs.start({
      kind: 'run', lockKey: 'command:a', requestKey: 'command:a', appPath: app, configName: 'primary', command: 'west boards', run: () => ended,
    });
    assert.equal(runningAgentBuildFor(jobs, userTask('primary', 'West Build') as never), undefined, 'a command that only reads');
    jobs.start({
      kind: 'run', lockKey: 'command:b', requestKey: 'command:b', appPath: app, configName: 'primary', buildDir, writes: ['build_dir'],
      command: 'west build -p always', run: () => ended,
    });
    assert.ok(runningAgentBuildFor(jobs, userTask('primary', 'West Build') as never));
    assert.equal(runningAgentBuildFor(jobs, userTask('secondary', 'West Build') as never), undefined);
  });

  it('asks before a user task on the configuration an agent is flashing, in words about flashing', async () => {
    startFlash();
    answers.push(undefined);
    await assert.rejects(executeTask(userTask() as never), TaskLaunchDeclined);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].message, 'An AI agent is flashing primary right now.');
    assert.match(warnings[0].detail ?? '', /same build folder and board/);
    assert.deepEqual(warnings[0].items, ['Stop Agent Flash and Run']);
    assert.deepEqual(launched, []);
  });

  it('stops the agent flash when the user chooses to, then runs the task', async () => {
    const job = startFlash();
    answers.push('Stop Agent Flash and Run');
    await executeTask(userTask('primary', 'West Build') as never);
    assert.equal(job.status, 'cancelled');
    assert.deepEqual(launched, ['West Build']);
  });

  it('warns about a task started outside the workbench during an agent flash', async () => {
    startFlash();
    answers.push(undefined);
    let terminated = false;
    await Promise.all(startListeners.map(listener => listener({ execution: { task: userTask(), terminate: () => { terminated = true; } } })));
    assert.equal(terminated, false);
    assert.match(warnings[0].message, /^An AI agent is flashing primary right now\. "West Flash" uses the same build folder and board/);
    assert.deepEqual(warnings[0].items, ['Stop My Task', 'Stop Agent Flash', 'Let Both Run']);
  });
});
