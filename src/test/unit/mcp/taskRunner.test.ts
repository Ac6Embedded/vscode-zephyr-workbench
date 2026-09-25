// The two ways an agent job runs in a terminal: a captured workbench task,
// which spawns a real shell here, and an in-process step mirrored into a
// Pseudoterminal. VS Code's task system is stood in for, so a test decides
// when, or whether, the terminal opens.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const stub = require('vscode') as Record<string, any>;

type Pty = {
  onDidWrite(listener: (text: string) => void): unknown;
  onDidClose(listener: (code: number) => void): unknown;
  open(dimensions: unknown): void;
  close(): void;
};

class FakeEmitter<T> {
  private listeners: Array<(value: T) => void> = [];
  event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
  };
  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

class FakeShellExecution {
  constructor(readonly commandLine: string, readonly options?: Record<string, unknown>) {}
}

class FakeCustomExecution {
  constructor(readonly callback: () => Promise<Pty>) {}
}

class FakeTask {
  presentationOptions: Record<string, unknown> = {};
  group: unknown;
  detail: unknown;
  constructor(
    readonly definition: Record<string, unknown>, readonly scope: unknown, readonly name: string,
    readonly source: string, readonly execution?: unknown, readonly problemMatchers?: unknown,
  ) {}
}

const FAKES: Record<string, unknown> = {
  EventEmitter: FakeEmitter,
  ShellExecution: FakeShellExecution,
  CustomExecution: FakeCustomExecution,
  Task: FakeTask,
  TaskScope: { Workspace: 2 },
  TaskRevealKind: { Always: 1, Silent: 2, Never: 3 },
  TaskPanelKind: { Shared: 1, Dedicated: 2, New: 3 },
};

interface Terminal { output: string; closedWith?: number; pty: Pty }

const realSetTimeout = setTimeout;
const tick = (ms = 10) => new Promise(resolve => realSetTimeout(resolve, ms));
const text = (terminal: Terminal) => terminal.output.replace(/\r\n/g, '\n');

/** Any timer of a second or more fires at once, so a watchdog shows without waiting for it. */
async function withShortWatchdogs<T>(work: () => Promise<T>): Promise<T> {
  (global as { setTimeout: unknown }).setTimeout = (fn: () => void, ms?: number, ...args: unknown[]) =>
    realSetTimeout(fn, (ms ?? 0) >= 1000 ? 0 : ms, ...args);
  try {
    return await work();
  } finally {
    (global as { setTimeout: unknown }).setTimeout = realSetTimeout;
  }
}

describe('mcp/host/taskRunner', () => {
  const MODULES = ['../../../mcp/host/capturedTask', '../../../mcp/host/taskRunner'].map(m => require.resolve(m));
  const added: string[] = [];
  let savedTasks: unknown;
  let runner: typeof import('../../../mcp/host/taskRunner');
  let marker: string;

  /** 'now' opens the terminal as VS Code usually does, 'later' when a test says, 'refuse' never. */
  let mode: 'now' | 'later' | 'refuse';
  let terminals: Terminal[];
  let lateOpens: Array<() => Promise<void>>;
  let executed: FakeTask[];
  let sink: { chunks: string[]; onData(chunk: string): void; readonly all: string };

  before(() => {
    for (const [key, value] of Object.entries(FAKES)) {
      if (!(key in stub)) {
        added.push(key);
        stub[key] = value;
      }
    }
    // `import * as vscode` binds the keys a module sees when it loads, so the
    // modules under test are loaded afresh now that the stub has them.
    for (const file of MODULES) {
      delete require.cache[file];
    }
    runner = require('../../../mcp/host/taskRunner');
    marker = require('../../../mcp/host/capturedTask').CAPTURED_TASK_MARKER;
    savedTasks = stub.tasks;
  });

  after(() => {
    stub.tasks = savedTasks;
    for (const key of added) {
      delete stub[key];
    }
    for (const file of MODULES) {
      delete require.cache[file];
    }
  });

  beforeEach(() => {
    mode = 'now';
    terminals = [];
    lateOpens = [];
    executed = [];
    const chunks: string[] = [];
    sink = { chunks, onData: chunk => { chunks.push(chunk); }, get all() { return chunks.join(''); } };
    stub.tasks = {
      ...(savedTasks as object),
      executeTask: async (task: FakeTask) => {
        executed.push(task);
        if (mode === 'refuse') {
          throw new Error('the task system is busy');
        }
        const open = async () => {
          const pty = await (task.execution as FakeCustomExecution).callback();
          const terminal: Terminal = { output: '', pty };
          pty.onDidWrite(chunk => { terminal.output += chunk; });
          pty.onDidClose(code => { terminal.closedWith = code; });
          terminals.push(terminal);
          pty.open(undefined);
        };
        if (mode === 'now') {
          await open();
        } else {
          lateOpens.push(open);
        }
        return { task };
      },
    };
  });

  describe('runLoggedStep', () => {
    it('mirrors what the step logs into its own terminal and the job log, then closes it with 0', async () => {
      const value = await runner.runLoggedStep('Download SDK', sink, new AbortController().signal, async log => {
        log('downloading\n');
        log('done\n');
        return 42;
      }, { header: '> [agent test] Download SDK' });
      assert.equal(value, 42);
      assert.equal(sink.all, 'downloading\ndone\n');
      assert.equal(terminals.length, 1);
      assert.equal(text(terminals[0]), '> [agent test] Download SDK\nDownload SDK\n\ndownloading\ndone\n');
      assert.equal(terminals[0].closedWith, 0);
      assert.equal(executed[0].definition[marker], true, 'the launch guards must not take it for a user task');
      assert.equal(executed[0].presentationOptions.focus, false);
    });

    it('lets a step show one text in the terminal and write another to the job log', async () => {
      // A serial capture: raw output with colours for the user, clean lines for the agent.
      await runner.runLoggedStep('Serial', sink, new AbortController().signal, async (log, _signal, channels) => {
        channels.terminal('\u001b[32muart:~$ \u001b[m');
        channels.record('uart:~$ ');
        log('\n--- serial: closed ---\n');
      });
      assert.equal(sink.all, 'uart:~$ \n--- serial: closed ---\n');
      assert.equal(text(terminals[0]), 'Serial\n\n\u001b[32muart:~$ \u001b[m\n--- serial: closed ---\n');
    });

    it('shows why the step failed, closes with 1 and rethrows for the job to report', async () => {
      await assert.rejects(runner.runLoggedStep('Extract', sink, new AbortController().signal, async log => {
        log('extracting\n');
        throw new Error('checksum mismatch');
      }), /checksum mismatch/);
      assert.match(text(terminals[0]), /extracting\n\nchecksum mismatch\n$/);
      assert.equal(terminals[0].closedWith, 1);
      assert.equal(sink.all, 'extracting\n', 'the job manager writes the error to the log itself');
    });

    it('replays the output into a terminal VS Code opens late, and closes it at once when the step has already ended', async () => {
      mode = 'later';
      await runner.runLoggedStep('Download', sink, new AbortController().signal, async log => { log('fetched\n'); });
      assert.equal(terminals.length, 0);
      await lateOpens[0]();
      assert.equal(text(terminals[0]), 'Download\n\nfetched\n');
      assert.equal(terminals[0].closedWith, 0, 'a terminal opened after the end must not stay behind');
    });

    it('stops keeping output for a terminal that does not open within 10 seconds, and says so in the log', async () => {
      mode = 'later';
      await withShortWatchdogs(() => runner.runLoggedStep('Download', sink, new AbortController().signal, async log => {
        await tick(20);
        log('late output\n');
      }));
      assert.match(sink.all, /did not open a terminal for "Download" within 10 seconds/);
      assert.match(sink.all, /late output/);
      await lateOpens[0]();
      assert.equal(text(terminals[0]), 'Download\n\n(the earlier output is in the job log)\n');
      assert.equal(terminals[0].closedWith, 0);
    });

    it('stops the step when the user closes its terminal, or when the job is cancelled', async () => {
      const waitForAbort = (_log: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('stopped')));
      });
      const byUser = runner.runLoggedStep('Download', sink, new AbortController().signal, waitForAbort);
      await tick();
      terminals[0].pty.close();
      await assert.rejects(byUser, /stopped/);
      assert.equal(terminals[0].closedWith, 1);

      const job = new AbortController();
      const byJob = runner.runLoggedStep('Download', sink, job.signal, waitForAbort);
      await tick();
      job.abort();
      await assert.rejects(byJob, /stopped/);
      assert.equal(terminals[1].closedWith, 1);
    });

    it('sends its notices about the terminal to the step\'s own note, when it has one', async () => {
      mode = 'refuse';
      const notes: string[] = [];
      await runner.runLoggedStep('Serial', sink, new AbortController().signal, async log => {
        log('uart:~$ ');
        await tick();
      }, { note: message => notes.push(message) });
      await tick();
      assert.equal(notes.length, 1);
      assert.match(notes[0], /refused to show "Serial" in a terminal/);
      assert.doesNotMatch(sink.all, /refused/, 'a capture marks it as its own message, never as device output');
    });

    it('still runs the step when VS Code refuses the terminal, and says so in the log', async () => {
      mode = 'refuse';
      assert.equal(await runner.runLoggedStep('Download', sink, new AbortController().signal, async log => {
        log('ok\n');
        return 'done';
      }), 'done');
      await tick();
      assert.match(sink.all, /refused to show "Download" in a terminal: the task system is busy/);
    });
  });

  describe('runCapturedTask', function () {
    let folder: string;

    before(function () {
      if (process.platform === 'win32') {
        this.skip();
      }
    });
    beforeEach(() => { folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-runner-'))); });
    afterEach(() => { fs.rmSync(folder, { recursive: true, force: true }); });

    function shellTask(commandLine: string, options: Record<string, unknown> = {}): FakeTask {
      return new FakeTask(
        { type: 'zephyr-workbench', command: 'west', config: 'primary' },
        { uri: { fsPath: folder }, name: path.basename(folder), index: 0 },
        'West Build [primary]', 'Zephyr Workbench',
        // Whichever ShellExecution the stub has, so the capture's instanceof check holds.
        new (stub.ShellExecution as typeof FakeShellExecution)(commandLine, { executable: '/bin/sh', shellArgs: ['-c'], ...options }),
      );
    }

    it('resolves VS Code variables, runs without prompts, and returns the exit code and output', async () => {
      const task = shellTask(
        'echo "$GCM_INTERACTIVE|$GIT_SSH_COMMAND|$GIT_TERMINAL_PROMPT|$FROM_TASK|${workspaceFolderBasename}"; pwd; exit 3',
        { cwd: '${userHome}', env: { FROM_TASK: '${workspaceFolder}/x' } },
      );
      const run = await runner.runCapturedTask(task as never, sink, new AbortController().signal, { header: '> [agent test] West Build' });
      assert.deepEqual(run, { exitCode: 3, started: true });
      const lines = sink.all.trim().split('\n');
      assert.equal(lines[0], `never|ssh -o BatchMode=yes|0|${folder}/x|${path.basename(folder)}`);
      assert.equal(fs.realpathSync(lines[1]), fs.realpathSync(os.homedir()));
      assert.match(text(terminals[0]), /^> \[agent test\] West Build\necho "\$GCM_INTERACTIVE/);
      assert.ok(!text(terminals[0]).includes('${workspaceFolderBasename}'), 'the terminal shows the command as it ran');
      assert.equal(terminals[0].closedWith, 3);
      assert.equal(executed[0].definition[marker], true);
    });

    it('refuses to start in a folder that still names a variable, before VS Code sees the task', async () => {
      await assert.rejects(
        runner.runCapturedTask(shellTask('true', { cwd: '${config:zephyr-workbench.westWorkspace}' }) as never, sink, new AbortController().signal),
        /"West Build \[primary\]" was not started: its working folder "\$\{config:zephyr-workbench.westWorkspace\}"/,
      );
      assert.equal(executed.length, 0);
    });

    it('reports a run VS Code refused as failed and never started', async () => {
      mode = 'refuse';
      const run = await runner.runCapturedTask(shellTask('true') as never, sink, new AbortController().signal);
      assert.deepEqual(run, { exitCode: 1, started: false });
      assert.match(sink.all, /VS Code refused to start "West Build \[primary\]": the task system is busy/);
    });

    it('gives up on a terminal VS Code does not open within 10 seconds, and closes it if it opens later', async () => {
      mode = 'later';
      const run = await withShortWatchdogs(() => runner.runCapturedTask(shellTask('true') as never, sink, new AbortController().signal));
      assert.deepEqual(run, { exitCode: 1, started: false });
      assert.match(sink.all, /did not start the terminal for "West Build \[primary\]" within 10 seconds/);
      await lateOpens[0]();
      assert.match(text(terminals[0]), /abandoned before it started/);
      assert.equal(terminals[0].closedWith, 1);
    });

    it('stops the process when the job is cancelled, and runs nothing for a job cancelled before', async () => {
      const job = new AbortController();
      const pending = runner.runCapturedTask(shellTask('sleep 30') as never, sink, job.signal);
      await tick(200);
      job.abort();
      assert.deepEqual(await pending, { exitCode: undefined, started: true });

      assert.deepEqual(await runner.runCapturedTask(shellTask('true') as never, sink, job.signal), { exitCode: undefined, started: false });
      assert.equal(executed.length, 1);
    });
  });
});
