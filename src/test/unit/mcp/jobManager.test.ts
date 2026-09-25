import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { McpToolError } from '../../../mcp/core/errors';
import { ToolContext } from '../../../mcp/core/toolSpec';
import { HostDeps } from '../../../mcp/host/handlers/deps';
import { job as jobTool } from '../../../mcp/host/handlers/jobs';
import { isPersisted, JobManager, JobRunResult, JobSpec, JobView } from '../../../mcp/jobs/jobManager';
import { pruneJobRecords } from '../../../mcp/jobs/jobRecords';

function manager(): JobManager {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-jobs-'));
  return new JobManager({ logPathFor: id => path.join(dir, `${id}.log`) });
}

/** A controllable fake build: the test decides when it finishes. */
function fakeJob(over: Partial<JobSpec> = {}) {
  let finish: (result: JobRunResult) => void = () => undefined;
  let emit: (chunk: string) => void = () => undefined;
  const spec: JobSpec = {
    kind: 'build',
    lockKey: '/ws/app/build/primary',
    requestKey: 'build:/ws/app/build/primary:{}',
    appPath: '/ws/app',
    configName: 'primary',
    // A job on another lock key builds in a folder of its own, unless the test says otherwise.
    buildDir: over.lockKey ?? '/ws/app/build/primary',
    command: 'west build --board nucleo_f401re',
    run: (sink, signal) => new Promise(resolve => {
      emit = chunk => sink.onData(chunk);
      finish = result => resolve(result);
      signal.addEventListener('abort', () => resolve({ exitCode: undefined }));
    }),
    ...over,
  };
  return { spec, finish: (r: JobRunResult) => finish(r), emit: (c: string) => emit(c) };
}

describe('mcp/jobs/jobManager', () => {
  it('starts a job and reports it as running', () => {
    const m = manager();
    const { job } = m.start(fakeJob().spec);
    assert.equal(job.status, 'running');
    assert.match(m.view(job).next, /"action": "status"/);
  });

  it('succeeds on exit code zero and fails otherwise', async () => {
    const m = manager();
    const ok = fakeJob();
    const started = m.start(ok.spec);
    ok.finish({ exitCode: 0 });
    await m.wait(started.job, 1000);
    assert.equal(started.job.status, 'succeeded');

    const bad = fakeJob({ lockKey: '/other', requestKey: 'other' });
    const started2 = m.start(bad.spec);
    bad.finish({ exitCode: 1 });
    await m.wait(started2.job, 1000);
    assert.equal(started2.job.status, 'failed');
    assert.equal(m.view(started2.job).exit_code, 1);
  });

  it('attaches an identical retry to the running job instead of starting a second build', () => {
    const m = manager();
    const first = fakeJob();
    const a = m.start(first.spec);
    // A Codex retry after its 60 second timeout sends the same request again.
    const b = m.start(fakeJob().spec);
    assert.equal(b.attached, true);
    assert.equal(b.job.id, a.job.id);
  });

  it('refuses a different job on the same build directory with a pollable id', () => {
    const m = manager();
    const a = m.start(fakeJob().spec);
    try {
      m.start(fakeJob({ requestKey: 'build:different-args' }).spec);
      throw new Error('expected BUSY');
    } catch (error) {
      assert.ok(error instanceof McpToolError);
      assert.equal((error as McpToolError).code, 'BUSY');
      assert.match((error as McpToolError).hint ?? '', new RegExp(a.job.id));
      assert.equal((error as McpToolError).retryable, true);
    }
  });

  it('allows a concurrent job on a different build directory', () => {
    const m = manager();
    m.start(fakeJob().spec);
    const other = m.start(fakeJob({ lockKey: '/ws/other/build/primary', requestKey: 'other' }).spec);
    assert.equal(other.attached, false);
    assert.equal(other.job.status, 'running');
  });

  it('releases the lock when the job finishes', async () => {
    const m = manager();
    const first = fakeJob();
    const a = m.start(first.spec);
    first.finish({ exitCode: 0 });
    await m.wait(a.job, 1000);
    const again = m.start(fakeJob({ requestKey: 'a-later-build' }).spec);
    assert.equal(again.job.status, 'running');
  });

  it('returns from wait as soon as the job ends', async () => {
    const m = manager();
    const f = fakeJob();
    const { job } = m.start(f.spec);
    setTimeout(() => f.finish({ exitCode: 0 }), 5);
    await m.wait(job, 5000);
    assert.equal(job.status, 'succeeded');
  });

  it('returns from wait on timeout without failing the job', async () => {
    const m = manager();
    const { job } = m.start(fakeJob().spec);
    await m.wait(job, 10);
    assert.equal(job.status, 'running', 'a wait timeout must not end the job');
    assert.match(m.view(job).next, /until status is not running/);
  });

  it('cancels a job and marks it cancelled', async () => {
    const m = manager();
    const { job } = m.start(fakeJob().spec);
    const view = m.cancel(job.id);
    assert.equal(view.status, 'cancelled');
    await m.wait(job, 1000);
    assert.equal(job.status, 'cancelled', 'a late runner result must not overwrite the cancellation');
  });

  it('parses diagnostics and memory from captured output', async () => {
    const m = manager();
    const f = fakeJob();
    const { job } = m.start(f.spec);
    f.emit('/ws/app/src/main.c:12:5: error: boom\n');
    f.emit('Memory region         Used Size  Region Size  %age Used\n');
    f.emit('           FLASH:       23180 B         1 MB      2.21%\n');
    f.finish({ exitCode: 1 });
    await m.wait(job, 1000);
    const view = m.view(job);
    assert.equal(view.diagnostics?.errors, 1);
    assert.equal(view.diagnostics?.items[0].line, 12);
    assert.equal(view.memory?.[0].region, 'FLASH');
    assert.match(view.log.tail, /error: boom/);
  });

  it('writes captured output to the log file', async () => {
    const m = manager();
    const f = fakeJob();
    const { job } = m.start(f.spec);
    f.emit('hello from the build\n');
    f.finish({ exitCode: 0 });
    await m.wait(job, 1000);
    assert.match(fs.readFileSync(job.log.filePath, 'utf8'), /hello from the build/);
  });

  it('reports an unknown job id as JOB_NOT_FOUND', () => {
    const m = manager();
    try {
      m.get('build-nope');
      throw new Error('expected JOB_NOT_FOUND');
    } catch (error) {
      assert.ok(error instanceof McpToolError);
      assert.equal((error as McpToolError).code, 'JOB_NOT_FOUND');
    }
  });

  it('marks running jobs failed after a host restart', () => {
    const m = manager();
    const { job } = m.start(fakeJob().spec);
    m.failRunning('The VS Code window reloaded while this job was running.');
    assert.equal(job.status, 'failed');
    // The lock must be released or the next build would be refused forever.
    assert.equal(m.start(fakeJob({ requestKey: 'after-restart' }).spec).job.status, 'running');
  });

  it('lists jobs newest first', async () => {
    let clock = 1000;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-jobs-'));
    const m = new JobManager({ logPathFor: id => path.join(dir, `${id}.log`), now: () => (clock += 10) });
    const a = m.start(fakeJob({ lockKey: 'a', requestKey: 'a' }).spec);
    const b = m.start(fakeJob({ lockKey: 'b', requestKey: 'b' }).spec);
    assert.deepEqual(m.list().map(j => j.id), [b.job.id, a.job.id]);
  });

  it('forgets terminal jobs beyond the retention limit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-jobs-'));
    const m = new JobManager({ logPathFor: id => path.join(dir, `${id}.log`), maxRetained: 2 });
    for (let i = 0; i < 5; i++) {
      const f = fakeJob({ lockKey: `lock-${i}`, requestKey: `req-${i}` });
      const { job } = m.start(f.spec);
      f.finish({ exitCode: 0 });
      await m.wait(job, 1000);
    }
    assert.ok(m.list().length <= 2, `expected retention to cap the list, got ${m.list().length}`);
  });

  it('gives every job a distinct id', () => {
    const m = manager();
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const { job } = m.start(fakeJob({ lockKey: `lock-${i}`, requestKey: `req-${i}` }).spec);
      ids.add(job.id);
    }
    assert.equal(ids.size, 20, 'job ids must be unique');
  });

  it('keeps the build directory locked until a cancelled job has really exited', async () => {
    const m = manager();
    let exit: () => void = () => undefined;
    const slow = fakeJob({
      // A process that takes a moment to die after SIGTERM, like ninja does.
      run: (_sink, signal) => new Promise(resolve => {
        signal.addEventListener('abort', () => { exit = () => resolve({ exitCode: undefined }); });
      }),
    });
    const { job } = m.start(slow.spec);
    m.cancel(job.id);
    assert.throws(() => m.start(fakeJob({ requestKey: 'rebuild' }).spec),
      (error: McpToolError) => error.code === 'BUSY' && /still stopping/.test(error.message),
      'a second build must not start while the first is still exiting');
    exit();
    await m.wait(job, 1000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(m.start(fakeJob({ requestKey: 'rebuild' }).spec).job.status, 'running');
  });

  it('aborts running jobs when the window goes away, so their processes are killed', () => {
    const m = manager();
    let aborted = false;
    m.start(fakeJob({
      run: (_sink, signal) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); }),
    }).spec);
    m.failRunning('window closed');
    assert.equal(aborted, true, 'failRunning must abort, not only relabel');
  });

  it('emits a heartbeat while waiting', async () => {
    const m = manager();
    const f = fakeJob();
    const { job } = m.start(f.spec);
    f.emit('[3/10] Building C object main.c.obj\n');
    const ticks: string[] = [];
    setTimeout(() => f.finish({ exitCode: 0 }), 70);
    await m.wait(job, 5000, { everyMs: 20, tick: j => ticks.push(m.lastLine(j)) });
    assert.ok(ticks.length >= 2, `expected heartbeats, got ${ticks.length}`);
    assert.equal(ticks[0], '[3/10] Building C object main.c.obj');
  });

  it('stops waiting, but keeps the job, when the caller aborts', async () => {
    const m = manager();
    const f = fakeJob();
    const { job } = m.start(f.spec);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    await m.wait(job, 5000, { signal: controller.signal });
    assert.ok(Date.now() - started < 1000, 'wait must end on abort');
    assert.equal(job.status, 'running', 'aborting the call must not cancel the build');
    f.finish({ exitCode: 0 });
  });

  it('asks admit before a new job, and lets a retry attach to the running one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-jobs-'));
    let refusing = false;
    const asked: string[] = [];
    const m = new JobManager({
      logPathFor: id => path.join(dir, `${id}.log`),
      admit: spec => {
        asked.push(spec.requestKey);
        if (refusing) {
          throw new McpToolError('BUSY', 'restarting');
        }
      },
    });
    const first = m.start(fakeJob().spec);
    refusing = true;
    assert.equal(m.start(fakeJob().spec).job.id, first.job.id, 'the identical retry still attaches');
    assert.throws(() => m.start(fakeJob({ lockKey: '/other', requestKey: 'other' }).spec), (error: McpToolError) => error.code === 'BUSY');
    assert.deepEqual(asked, ['build:/ws/app/build/primary:{}', 'other']);
    assert.equal(m.list().length, 1, 'nothing was started for the refused job');
  });

  it('notifies on start, cancel and end, which drives the status bar', async () => {
    let changes = 0;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-jobs-'));
    const m = new JobManager({ logPathFor: id => path.join(dir, `${id}.log`), onDidChange: () => { changes++; } });
    const f = fakeJob();
    const { job } = m.start(f.spec);
    f.finish({ exitCode: 0 });
    await m.wait(job, 1000);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(changes >= 2, `expected start and end notifications, got ${changes}`);
  });
});

describe('mcp/jobs/jobManager results', () => {
  it('returns what the runner produced as result', async () => {
    const m = manager();
    const f = fakeJob({ kind: 'install', lockKey: 'sdk', requestKey: 'sdk' });
    const { job } = m.start(f.spec);
    assert.equal(m.view(job).result, undefined, 'nothing is produced before the end');
    f.finish({ exitCode: 0, extra: { installed_path: '/opt/sdk' } });
    await m.wait(job, 1000);
    assert.deepEqual(m.view(job).result, { installed_path: '/opt/sdk' });
  });

  it('lets a finished job name its own next step, and keeps the generic one while it runs', async () => {
    const m = manager();
    const f = fakeJob({ kind: 'west', next: view => `Updated ${view.result?.projects} projects. Call get_status.` });
    const { job } = m.start(f.spec);
    assert.match(m.view(job).next, /Still running/);
    f.finish({ exitCode: 0, extra: { projects: 42 } });
    await m.wait(job, 1000);
    assert.equal(m.view(job).next, 'Updated 42 projects. Call get_status.');
  });

  it('lets a job that runs until stopped say what to do while it runs, and names a serial port in a refusal', async () => {
    const m = manager();
    const serial = { kind: 'serial' as const, lockKey: 'serial:/dev/ttyACM0', buildDir: undefined, appPath: undefined, configName: undefined };
    const f = fakeJob({ ...serial, requestKey: 'serial:/dev/ttyACM0:115200', runningNext: view => `Read ${view.job_id} with the hardware tool.` });
    const { job } = m.start(f.spec);
    assert.equal(m.view(job).next, `Read ${job.id} with the hardware tool.`);
    const other = fakeJob({ ...serial, requestKey: 'serial:/dev/ttyACM0:9600' });
    assert.throws(() => m.start(other.spec), (error: McpToolError) => error.code === 'BUSY' && /serial port/.test(error.message));
    f.finish({ exitCode: 0 });
    await m.wait(job, 1000);
    assert.match(m.view(job).next, /"action": "log"/, 'finished, the generic step is back');
  });

  it('keeps the generic next step when the job\'s own one throws', async () => {
    const m = manager();
    const f = fakeJob({ next: () => { throw new Error('broken'); } });
    const { job } = m.start(f.spec);
    f.finish({ exitCode: 0 });
    await m.wait(job, 1000);
    assert.match(m.view(job).next, /"action": "log"/);
  });

  it('parses compiler output only for builds and tasks, unless the job or the caller says otherwise', async () => {
    const m = manager();
    const views: Record<string, JobView> = {};
    const cases: Array<[string, Partial<JobSpec>]> = [
      ['build', { kind: 'build' }],
      ['task', { kind: 'task' }],
      ['west', { kind: 'west' }],
      ['install', { kind: 'install' }],
      ['west parsed', { kind: 'west', parse: true }],
      ['build unparsed', { kind: 'build', parse: false }],
    ];
    for (const [name, over] of cases) {
      const f = fakeJob({ ...over, lockKey: name, requestKey: name });
      const { job } = m.start(f.spec);
      f.emit('/ws/app/src/main.c:12:5: error: boom\n');
      f.finish({ exitCode: 1 });
      await m.wait(job, 1000);
      views[name] = m.view(job);
      if (name === 'build') {
        assert.equal(m.view(job, { parse: false }).diagnostics, undefined, 'the caller overrides the job');
      }
    }
    assert.deepEqual(Object.keys(views).filter(name => views[name].diagnostics), ['build', 'task', 'west parsed']);
  });
});

describe('mcp/jobs/jobManager resource conflicts', () => {
  const ws = path.join(path.sep, 'ws');

  function westUpdate() {
    return fakeJob({
      kind: 'west', lockKey: `west:${ws}`, requestKey: `west-update:${ws}`, buildDir: undefined, appPath: undefined,
      configName: undefined, westWorkspace: ws, writes: ['west_workspace'], command: 'west update',
    });
  }

  it('refuses a build while an agent updates its west workspace, naming the holder', () => {
    const m = manager();
    const { job: update } = m.start(westUpdate().spec);
    assert.throws(() => m.start(fakeJob({ westWorkspace: ws }).spec), (error: McpToolError) => {
      assert.equal(error.code, 'BUSY');
      assert.equal(error.message, `A west job is already running for this west workspace (job_id "${update.id}").`);
      assert.match(error.hint ?? '', new RegExp(update.id));
      assert.equal((error.details as { job_id: string }).job_id, update.id);
      return true;
    });
  });

  it('refuses a west update while a build reads the workspace, and allows it once the build has exited', async () => {
    const m = manager();
    const build = fakeJob({ westWorkspace: `${ws}${path.sep}` });
    const { job } = m.start(build.spec);
    assert.throws(() => m.start(westUpdate().spec), (error: McpToolError) =>
      error.code === 'BUSY' && error.message.includes(job.id) && /build job .* west workspace/.test(error.message));
    build.finish({ exitCode: 0 });
    await m.wait(job, 1000);
    assert.equal(m.start(westUpdate().spec).job.status, 'running');
  });

  it('runs builds of one west workspace side by side, and still attaches an identical request', () => {
    const m = manager();
    const first = m.start(fakeJob({ westWorkspace: ws }).spec);
    const other = m.start(fakeJob({
      westWorkspace: ws, lockKey: '/ws/app/build/debug', requestKey: 'debug', buildDir: '/ws/app/build/debug',
    }).spec);
    assert.equal(other.attached, false);
    const again = m.start(fakeJob({ westWorkspace: ws }).spec);
    assert.equal(again.attached, true);
    assert.equal(again.job.id, first.job.id);
  });

  it('keeps a build out of a folder a deletion above it is still removing, even once cancelled', async () => {
    const m = manager();
    let exit: () => void = () => undefined;
    const deletion = fakeJob({
      kind: 'clean', lockKey: '/ws/app/build', requestKey: 'clean', buildDir: '/ws/app/build',
      run: (_sink, signal) => new Promise(resolve => {
        signal.addEventListener('abort', () => { exit = () => resolve({ exitCode: undefined }); });
      }),
    });
    const { job } = m.start(deletion.spec);
    m.cancel(job.id);
    assert.throws(() => m.start(fakeJob().spec),
      (error: McpToolError) => error.code === 'BUSY' && /still stopping in this build directory/.test(error.message));
    exit();
    await m.wait(job, 1000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(m.start(fakeJob().spec).job.status, 'running');
  });

  it('refuses a job that rebuilds a venv a running build uses', () => {
    const m = manager();
    const venv = path.join(ws, '.venv');
    m.start(fakeJob({ venvPath: venv }).spec);
    assert.throws(() => m.start(fakeJob({
      kind: 'install', lockKey: `venv:${venv}`, requestKey: 'venv', buildDir: undefined, venvPath: venv, writes: ['venv'],
    }).spec), (error: McpToolError) => error.code === 'BUSY' && /this Python environment/.test(error.message));
  });
});

describe('mcp/jobs/jobManager records', () => {
  let dir: string;
  const options = () => ({
    windowId: 'w1',
    logPathFor: (id: string) => path.join(dir, `${id}.log`),
    recordPathFor: (id: string) => path.join(dir, `${id}.json`),
  });

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-records-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function ctxFor(jobs: JobManager): ToolContext<HostDeps> {
    return {
      signal: new AbortController().signal,
      progress: () => undefined,
      client: { name: 'test' },
      deps: { jobs, defaultWaitSeconds: 1 } as unknown as HostDeps,
      tool: {} as never,
      startedAt: Date.now(),
      audit: {},
    };
  }

  it('writes exactly the finished view, readable only by its owner, with no temporary file left', async () => {
    const m = new JobManager(options());
    const f = fakeJob();
    const { job } = m.start(f.spec);
    assert.equal(fs.existsSync(path.join(dir, `${job.id}.json`)), false, 'nothing is recorded while it runs');
    f.emit('/ws/app/src/main.c:12:5: error: boom\n');
    f.finish({ exitCode: 1, extra: { note: 'kept' } });
    await m.wait(job, 1000);

    const file = path.join(dir, `${job.id}.json`);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(record, JSON.parse(JSON.stringify(m.view(job))));
    assert.equal(record.persisted, undefined, 'the file holds the view as it was, not the read-back marker');
    assert.equal(record.diagnostics.errors, 1);
    assert.deepEqual(record.result, { note: 'kept' });
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
    assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
  });

  it('answers status, log and cancel from the record after a restart', async () => {
    const before = new JobManager(options());
    const f = fakeJob();
    const { job } = before.start(f.spec);
    f.emit('first line\nsecond line\n');
    f.finish({ exitCode: 0 });
    await before.wait(job, 1000);
    const original = before.view(job);

    const after = new JobManager(options());
    const handle = after.get(job.id);
    assert.ok(isPersisted(handle));
    assert.deepEqual(handle.view, { ...original, persisted: true });

    const ctx = ctxFor(after);
    const status = await jobTool({ action: 'status', job_id: job.id }, ctx) as JobView;
    assert.equal(status.persisted, true);
    assert.equal(status.status, 'succeeded');
    const log = await jobTool({ action: 'log', job_id: job.id }, ctx) as { text: string; persisted: boolean };
    assert.equal(log.text, 'first line\nsecond line\n');
    assert.equal(log.persisted, true);
    const grep = await jobTool({ action: 'log', job_id: job.id, grep: 'second' }, ctx) as { text: string };
    assert.equal(grep.text, 'second line');
    const cancel = await jobTool({ action: 'cancel', job_id: job.id }, ctx) as JobView;
    assert.deepEqual(cancel, status, 'a finished job is returned unchanged');
  });

  it('records the jobs a closing window fails, and a cancelled one still stopping stays cancelled', () => {
    const m = new JobManager(options());
    const { job: running } = m.start(fakeJob({ run: () => new Promise(() => undefined) }).spec);
    const { job: stopping } = m.start(fakeJob({
      lockKey: 'other', requestKey: 'other', buildDir: '/ws/other/build', run: () => new Promise(() => undefined),
    }).spec);
    m.cancel(stopping.id);
    m.failRunning('The VS Code window closed while this job was running.');

    const after = new JobManager(options());
    const failed = after.get(running.id);
    assert.ok(isPersisted(failed));
    assert.equal(failed.view.status, 'failed');
    assert.match(failed.view.log.tail, /window closed/);
    const cancelled = after.get(stopping.id);
    assert.ok(isPersisted(cancelled));
    assert.equal(cancelled.view.status, 'cancelled');
    assert.ok(cancelled.view.ended_at);
  });

  it('reads no record for an id that is not a job id, nor for a record of another job', () => {
    const m = new JobManager(options());
    fs.writeFileSync(path.join(dir, 'w1.build-1-abcdef.json'), JSON.stringify({ job_id: 'w1.build-2-abcdef' }));
    fs.writeFileSync(path.join(dir, 'w1.build-3-abcdef.json'), '{ not json');
    fs.writeFileSync(path.join(dir, '..json'), '{}');
    for (const id of ['w1.build-1-abcdef', 'w1.build-3-abcdef', '../w1.build-1-abcdef', 'a/b', '.', 'w1.a.b']) {
      assert.throws(() => m.get(id), (error: McpToolError) => error.code === 'JOB_NOT_FOUND', id);
    }
  });

  it('answers a job that aged out of memory from its record', async () => {
    // Retention keeps the newest by start time, so every job starts at its own time.
    let clock = Date.now();
    const m = new JobManager({ ...options(), maxRetained: 1, now: () => (clock += 10) });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const f = fakeJob({ lockKey: `lock-${i}`, requestKey: `req-${i}` });
      const { job } = m.start(f.spec);
      ids.push(job.id);
      f.finish({ exitCode: 0 });
      await m.wait(job, 1000);
    }
    assert.equal(m.list().length, 1);
    const oldest = m.get(ids[0]);
    assert.ok(isPersisted(oldest));
    assert.equal(oldest.view.status, 'succeeded');
  });

  it('keeps the newest 200 records and drops those older than a week, with their logs, when a window starts', () => {
    const now = Date.now();
    const at = (name: string, ageMs: number) => {
      fs.writeFileSync(path.join(dir, name), '{}');
      const when = new Date(now - ageMs);
      fs.utimesSync(path.join(dir, name), when, when);
    };
    for (let i = 0; i < 205; i++) {
      at(`w1.build-${i}-aaaaaa.json`, i * 1000);
      at(`w1.build-${i}-aaaaaa.log`, i * 1000);
    }
    const week = 7 * 24 * 60 * 60 * 1000;
    at('w1.old-1-aaaaaa.json', week + 1000);
    at('w1.old-1-aaaaaa.log', week + 1000);
    at('w1.orphan-1-aaaaaa.log', week + 1000);
    at('w1.fresh-1-aaaaaa.log', 1000);
    at('w1.build-9-aaaaaa.json.123.abcdef.tmp', 5 * 60 * 1000);

    new JobManager({ ...options(), now: () => now });
    const names = new Set(fs.readdirSync(dir));
    const records = [...names].filter(name => name.endsWith('.json'));
    assert.equal(records.length, 200);
    for (let i = 200; i < 205; i++) {
      assert.equal(names.has(`w1.build-${i}-aaaaaa.json`), false);
      assert.equal(names.has(`w1.build-${i}-aaaaaa.log`), false, 'a dropped record takes its log along');
    }
    assert.ok(names.has('w1.build-0-aaaaaa.json') && names.has('w1.build-0-aaaaaa.log'));
    assert.equal(names.has('w1.old-1-aaaaaa.json'), false);
    assert.equal(names.has('w1.old-1-aaaaaa.log'), false);
    assert.equal(names.has('w1.orphan-1-aaaaaa.log'), false);
    assert.ok(names.has('w1.fresh-1-aaaaaa.log'), 'a recent log without a record is kept');
    assert.equal(names.has('w1.build-9-aaaaaa.json.123.abcdef.tmp'), false);
  });

  it('prunes nothing when the folder does not exist yet', () => {
    assert.doesNotThrow(() => pruneJobRecords(path.join(dir, 'missing'), Date.now()));
  });
});
