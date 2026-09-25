import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { McpToolError } from '../../../mcp/core/errors';
import {
  FolderChangeScheduler, folderChangeRestartsHost, FolderWorkspace, SchedulerClock,
} from '../../../mcp/host/folderChanges';
import { resolveWindowId } from '../../../mcp/host/registryWriter';
import { JobKind, JobManager, JobStatus } from '../../../mcp/jobs/jobManager';
import { tryRemoveWorkspaceFolder } from '../../../utils/utils';

function memento(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) as T : fallback),
    update: async (key: string, value: unknown) => {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    },
  } as vscode.Memento;
}

const hostContext = (globalState: vscode.Memento) =>
  ({ globalState, workspaceState: memento() }) as unknown as vscode.ExtensionContext;

const settle = () => new Promise(resolve => setImmediate(resolve));

/** Timers that only fire when the test moves time forward. */
class ManualClock implements SchedulerClock {
  private time = 1_750_000_000_000;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; run: () => void }>();

  now = () => this.time;
  setTimeout = (run: () => void, ms: number) => {
    this.seq += 1;
    this.timers.set(this.seq, { at: this.time + ms, run });
    return this.seq;
  };
  clearTimeout = (handle: unknown) => {
    this.timers.delete(handle as number);
  };

  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    await settle();
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) {
        break;
      }
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].run();
      await settle();
    }
    this.time = end;
    await settle();
  }
}

/** A workspace that applies each call and confirms it a moment later, like VS Code. */
function fakeWorkspace(initial: string[], workspaceFile: boolean) {
  const listeners = new Set<() => void>();
  const state = {
    list: [...initial],
    workspaceFile,
    refuse: false,
    /** Never confirms, like a host being shut down. */
    silent: false,
    calls: [] as [number, number, string[]][],
  };
  const workspace: FolderWorkspace = {
    folders: () => [...state.list],
    hasWorkspaceFile: () => state.workspaceFile,
    update: (start, deleteCount, add) => {
      state.calls.push([start, deleteCount, add]);
      if (state.refuse) {
        return false;
      }
      state.list.splice(start, deleteCount, ...add);
      if (!state.silent) {
        queueMicrotask(() => listeners.forEach(listener => listener()));
      }
      return true;
    },
    onDidChange: listener => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  return { state, workspace };
}

function harness(initial: string[], workspaceFile: boolean) {
  const { state, workspace } = fakeWorkspace(initial, workspaceFile);
  const clock = new ManualClock();
  const shared = memento();
  const jobs: { id: string; status: JobStatus; endedAt?: number; spec?: { kind: JobKind } }[] = [];
  const lines: string[] = [];
  const scheduler = new FolderChangeScheduler({
    context: hostContext(shared), windowId: 'win1', jobs: { list: () => jobs }, log: line => lines.push(line), workspace, clock,
  });
  return { state, clock, shared, jobs, lines, scheduler };
}

describe('mcp/host/folderChanges', () => {
  describe('folderChangeRestartsHost', () => {
    it('restarts an empty or single-folder window for any real change', () => {
      assert.equal(folderChangeRestartsHost({ add: ['/a'] }, { workspaceFile: false, folders: [] }), true);
      assert.equal(folderChangeRestartsHost({ add: ['/b'] }, { workspaceFile: false, folders: ['/a'] }), true);
      assert.equal(folderChangeRestartsHost({ remove: ['/a'] }, { workspaceFile: false, folders: ['/a'] }), true);
    });

    it('restarts a workspace only when its first folder changes', () => {
      const current = { workspaceFile: true, folders: ['/a', '/b'] };
      assert.equal(folderChangeRestartsHost({ add: ['/c'] }, current), false);
      assert.equal(folderChangeRestartsHost({ remove: ['/b'] }, current), false);
      assert.equal(folderChangeRestartsHost({ remove: ['/a/'] }, current), true);
      assert.equal(folderChangeRestartsHost({ add: ['/c'] }, { workspaceFile: true, folders: [] }), true);
    });

    it('restarts nothing for a change that changes nothing', () => {
      assert.equal(folderChangeRestartsHost({ add: ['/a/'] }, { workspaceFile: false, folders: ['/a'] }), false);
      assert.equal(folderChangeRestartsHost({ remove: ['/x'] }, { workspaceFile: false, folders: ['/a'] }), false);
      assert.equal(folderChangeRestartsHost({}, { workspaceFile: false, folders: [] }), false);
    });
  });

  describe('FolderChangeScheduler', () => {
    // The tests with a real JobManager log to temp folders, removed after
    // each test. Every folder is kept in the list, so the last test can check.
    const jobLogDirs: string[] = [];
    const jobLogDir = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-folder-jobs-'));
      jobLogDirs.push(dir);
      return dir;
    };
    afterEach(() => {
      for (const dir of jobLogDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('applies a change that keeps the host at once, adding at the end', async () => {
      const h = harness(['/a', '/b'], true);
      assert.deepEqual(await h.scheduler.apply({ add: ['/c'] }, { reason: 'create_app' }), { applied: true, restart_pending: false });
      assert.deepEqual(h.state.calls, [[2, 0, ['/c']]]);
      assert.deepEqual(h.scheduler.pending(), []);
      assert.equal(h.scheduler.restartNotice(), undefined);
    });

    it('treats a folder that is already there as done', async () => {
      const h = harness(['/a'], false);
      assert.deepEqual(await h.scheduler.apply({ add: ['/a/'] }, { reason: 'create_app' }), { applied: true, restart_pending: false });
      assert.deepEqual(h.state.calls, []);
    });

    it('removes later folders first, one confirmed call at a time', async () => {
      const h = harness(['/a', '/b', '/c'], true);
      const outcome = await h.scheduler.apply({ remove: ['/b', '/c'], add: ['/d'] }, { reason: 'test' });
      assert.equal(outcome.applied, true);
      assert.deepEqual(h.state.calls, [[2, 1, []], [1, 1, []], [1, 0, ['/d']]]);
      assert.deepEqual(h.state.list, ['/a', '/d']);
    });

    it('reports a change VS Code refused or never confirmed within 20 seconds', async () => {
      const refused = harness(['/a', '/b'], true);
      refused.state.refuse = true;
      assert.equal((await refused.scheduler.apply({ add: ['/c'] }, { reason: 'test' })).applied, false);

      const silent = harness(['/a', '/b'], true);
      silent.state.silent = true;
      const outcome = silent.scheduler.apply({ add: ['/c'] }, { reason: 'test' });
      await silent.clock.advance(19_999);
      let done = false;
      void outcome.then(() => { done = true; });
      await settle();
      assert.equal(done, false);
      await silent.clock.advance(1);
      assert.equal((await outcome).applied, false);
    });

    it('answers first and applies a restarting change once no job runs', async () => {
      const h = harness(['/ws/app'], false);
      h.jobs.push({ id: 'win1.west-1-aa', status: 'running' }, { id: 'win1.build-2-bb', status: 'running' });
      const outcome = await h.scheduler.apply({ add: ['/ws/new'] }, { reason: 'create_west_workspace', jobId: 'win1.west-1-aa' });
      assert.deepEqual(outcome, { applied: false, restart_pending: true, waiting_for_jobs: ['win1.build-2-bb'] });
      assert.equal(h.scheduler.pending().length, 1);
      assert.equal(h.scheduler.pending()[0].job_id, 'win1.west-1-aa');

      await h.clock.advance(10_000);
      assert.deepEqual(h.state.calls, [], 'jobs still run');
      assert.ok(h.lines.some(line => line.includes('waits for job(s)')));

      h.jobs.length = 0;
      await h.clock.advance(2_000);
      assert.deepEqual(h.state.calls, [[1, 0, ['/ws/new']]]);
      assert.deepEqual(h.scheduler.pending(), []);

      // The host that comes back finds its id and the note.
      h.scheduler.dispose();
      assert.equal(resolveWindowId(hostContext(h.shared), ['/ws/app', '/ws/new']), 'win1');
      const after = new FolderChangeScheduler({
        context: hostContext(h.shared), windowId: 'win1', jobs: { list: () => [] }, log: () => undefined, clock: h.clock,
      });
      const note = after.restartNotice();
      assert.equal(note?.reason, 'create_west_workspace');
      assert.deepEqual(note?.added, ['/ws/new']);
      assert.deepEqual(note?.removed, []);
      assert.equal(note?.job_id, 'win1.west-1-aa');
      await h.clock.advance(14 * 60_000);
      assert.ok(after.restartNotice());
      await h.clock.advance(60_000);
      assert.equal(after.restartNotice(), undefined, 'the note expires after 15 minutes');
    });

    it('does not wait for a serial capture, which only watches a port and may run for an hour', async () => {
      const h = harness(['/ws/app'], false);
      h.jobs.push({ id: 'win1.serial-1-aa', status: 'running', spec: { kind: 'serial' } });
      const outcome = await h.scheduler.apply({ add: ['/ws/new'] }, { reason: 'create_west_workspace' });
      assert.deepEqual(outcome, { applied: false, restart_pending: true });
      await h.clock.advance(3_000);
      assert.deepEqual(h.state.calls, [[1, 0, ['/ws/new']]], 'the restart ends the capture like a cancel');
    });

    it('waits at least 2.5 seconds, so the answer is sent first', async () => {
      const h = harness([], false);
      await h.scheduler.apply({ add: ['/a'] }, { reason: 'test' });
      await h.clock.advance(2_499);
      assert.deepEqual(h.state.calls, []);
      await h.clock.advance(1);
      assert.deepEqual(h.state.calls, [[0, 0, ['/a']]]);
    });

    it('applies every scheduled change in one go', async () => {
      const h = harness(['/a'], false);
      await h.scheduler.apply({ add: ['/b'] }, { reason: 'first' });
      await h.clock.advance(1_000);
      await h.scheduler.apply({ add: ['/c', '/b'] }, { reason: 'second' });
      await h.clock.advance(2_000);
      assert.deepEqual(h.state.calls, [], 'the later change pushes the start back');
      await h.clock.advance(500);
      assert.deepEqual(h.state.calls, [[1, 0, ['/b', '/c']]]);
    });

    it('replaces the only folder of a single-folder window in one call', async () => {
      const h = harness(['/a'], false);
      await h.scheduler.apply({ remove: ['/a'], add: ['/b'] }, { reason: 'test' });
      await h.clock.advance(2_500);
      assert.deepEqual(h.state.calls, [[0, 1, ['/b']]]);
    });

    it('removes the first folder of a workspace last', async () => {
      const h = harness(['/a', '/b'], true);
      const outcome = await h.scheduler.apply({ remove: ['/a'], add: ['/c'] }, { reason: 'test' });
      assert.equal(outcome.restart_pending, true);
      await h.clock.advance(2_500);
      assert.deepEqual(h.state.calls, [[2, 0, ['/c']], [0, 1, []]]);
    });

    it('gives up after 30 minutes of running jobs, saying why', async () => {
      const h = harness(['/a'], false);
      h.jobs.push({ id: 'win1.build-1-aa', status: 'cancelled' });
      await h.scheduler.apply({ add: ['/b'] }, { reason: 'test' });
      await h.clock.advance(30 * 60_000 + 2_000);
      assert.deepEqual(h.state.calls, [], 'a cancelled job still exiting counts as running');
      assert.deepEqual(h.scheduler.pending(), []);
      assert.ok(h.lines.some(line => line.startsWith('Gave up') && line.includes('win1.build-1-aa')));
    });

    it('drops the handoff and the note when the host was not restarted after all', async () => {
      const h = harness(['/a'], false);
      await h.scheduler.apply({ add: ['/b'] }, { reason: 'test' });
      await h.clock.advance(2_500);
      assert.ok(h.scheduler.restartNotice());
      await h.clock.advance(30_000);
      assert.equal(h.scheduler.restartNotice(), undefined);
      assert.notEqual(resolveWindowId(hostContext(h.shared), ['/a', '/b']), 'win1');
    });

    it('does not restart under a job that started while the change waited its turn', async () => {
      const h = harness(['/a', '/b'], true);
      assert.equal((await h.scheduler.apply({ remove: ['/a'] }, { reason: 'test' })).restart_pending, true);
      // A change that keeps the host, which VS Code is slow to confirm, holds the turn.
      h.state.silent = true;
      const keeping = h.scheduler.apply({ add: ['/c'] }, { reason: 'other' });
      await h.clock.advance(2_500);
      h.jobs.push({ id: 'win1.build-1-aa', status: 'running' });
      await h.clock.advance(17_500);
      assert.equal((await keeping).applied, false);
      assert.deepEqual(h.state.calls, [[2, 0, ['/c']]], 'the restarting change is not applied under the job');
      assert.equal(h.scheduler.pending().length, 1, 'it waits for the job again');
      assert.equal(h.scheduler.restartNotice(), undefined, 'and leaves no note of a restart');

      h.state.silent = false;
      h.jobs.length = 0;
      await h.clock.advance(2_000);
      assert.deepEqual(h.state.calls, [[2, 0, ['/c']], [0, 1, []]]);
      assert.deepEqual(h.scheduler.pending(), []);
    });

    it('refuses to start a job from the moment a restarting change lands until the host turns out to stay', async () => {
      const dir = jobLogDir();
      const { state, workspace } = fakeWorkspace(['/a'], false);
      const clock = new ManualClock();
      // The handoff is written slowly, as a globalState round trip can be.
      const globalState = memento();
      const write = globalState.update.bind(globalState);
      let release: () => void = () => undefined;
      const gate = new Promise<void>(resolve => { release = resolve; });
      globalState.update = async (key: string, value: unknown) => { await gate; await write(key, value); };

      let scheduler: FolderChangeScheduler | undefined;
      // Wired as the MCP controller wires them.
      const jobs = new JobManager({ logPathFor: id => path.join(dir, `${id}.log`), admit: () => scheduler?.refuseJobStart() });
      scheduler = new FolderChangeScheduler({ context: hostContext(globalState), windowId: 'win1', jobs, log: () => undefined, workspace, clock });
      const start = (key: string) => jobs.start({
        kind: 'build', lockKey: key, requestKey: key, command: 'west build', run: async () => ({ exitCode: 0 }),
      });
      const busy = (key: string) => assert.throws(() => start(key), (error: McpToolError) => error.code === 'BUSY' && /get_status/.test(error.hint ?? ''));

      await scheduler.apply({ add: ['/b'] }, { reason: 'test' });
      start('during-grace');
      await clock.advance(2_500);
      busy('during-handoff');
      assert.deepEqual(state.calls, []);

      release();
      await clock.advance(0);
      assert.deepEqual(state.calls, [[1, 0, ['/b']]]);
      busy('while-restarting');
      assert.deepEqual(jobs.list().map(job => job.spec.requestKey), ['during-grace']);

      await clock.advance(30_000);
      start('host-stayed');
      scheduler.dispose();
    });

    it('lets jobs start again at once when VS Code refuses the restarting change', async () => {
      const dir = jobLogDir();
      const { state, workspace } = fakeWorkspace(['/a'], false);
      state.refuse = true;
      const clock = new ManualClock();
      let scheduler: FolderChangeScheduler | undefined;
      const jobs = new JobManager({ logPathFor: id => path.join(dir, `${id}.log`), admit: () => scheduler?.refuseJobStart() });
      scheduler = new FolderChangeScheduler({ context: hostContext(memento()), windowId: 'win1', jobs, log: () => undefined, workspace, clock });
      await scheduler.apply({ add: ['/b'] }, { reason: 'test' });
      await clock.advance(2_500);
      assert.deepEqual(state.calls, [[1, 0, ['/b']]]);
      assert.equal(jobs.start({ kind: 'build', lockKey: 'k', requestKey: 'k', command: 'west build', run: async () => ({ exitCode: 0 }) }).attached, false);
    });

    it('drops a scheduled change when the window goes away first', async () => {
      const h = harness(['/a'], false);
      await h.scheduler.apply({ add: ['/b'] }, { reason: 'test' });
      h.scheduler.dispose();
      await h.clock.advance(5_000);
      assert.deepEqual(h.state.calls, []);
      assert.deepEqual(h.scheduler.pending(), []);
    });

    // Kept last: it checks the folders the tests above made.
    it('leaves no job log folder behind', () => {
      assert.deepEqual(jobLogDirs.filter(dir => fs.existsSync(dir)), []);
    });
  });
});

describe('utils/tryRemoveWorkspaceFolder', () => {
  // The stub's workspace object is shared with the module under test.
  const workspace = vscode.workspace as unknown as {
    workspaceFolders?: { uri: { fsPath: string } }[];
    updateWorkspaceFolders?: (start: number, deleteCount: number) => boolean;
  };
  let calls: [number, number][] = [];

  beforeEach(() => {
    calls = [];
    workspace.updateWorkspaceFolders = (start, deleteCount) => { calls.push([start, deleteCount]); return true; };
  });

  afterEach(() => {
    workspace.workspaceFolders = undefined;
    delete workspace.updateWorkspaceFolders;
  });

  it('removes the folder by path, with no UI', () => {
    workspace.workspaceFolders = [{ uri: vscode.Uri.file('/ws/a') }, { uri: vscode.Uri.file('/ws/b') }];
    assert.equal(tryRemoveWorkspaceFolder('/ws/b'), 'removed');
    assert.deepEqual(calls, [[1, 1]]);
  });

  it('says why nothing was removed', () => {
    assert.equal(tryRemoveWorkspaceFolder('/ws/a'), 'none');
    workspace.workspaceFolders = [{ uri: vscode.Uri.file('/ws/a') }];
    assert.equal(tryRemoveWorkspaceFolder('/ws/other'), 'not-found');
    assert.deepEqual(calls, []);
  });
});
