import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JobManager, JobSpec } from '../../../mcp/jobs/jobManager';

// Locks are keyed on exact paths, so deleting <app>/build must still find a
// build running in <app>/build/primary, and a build must find a deletion of
// the folder above its own.
describe('mcp/jobs/jobManager runningOverlapping', () => {
  function manager(): JobManager {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-overlap-'));
    return new JobManager({ logPathFor: id => path.join(dir, `${id}.log`) });
  }

  function held(buildDir: string, kind: JobSpec['kind'] = 'build') {
    let finish: () => void = () => undefined;
    const spec: JobSpec = {
      kind, lockKey: buildDir, requestKey: `${kind}:${buildDir}`, buildDir, command: kind,
      run: () => new Promise(resolve => { finish = () => resolve({ exitCode: 0 }); }),
    };
    return { spec, finish: () => finish() };
  }

  const app = path.join(path.sep, 'ws', 'app');

  it('finds jobs in the folder, below it and above it, and none elsewhere', () => {
    const m = manager();
    m.start(held(path.join(app, 'build', 'primary')).spec);
    assert.equal(m.runningOverlapping(path.join(app, 'build')).length, 1);
    assert.equal(m.runningOverlapping(path.join(app, 'build', 'primary')).length, 1);
    assert.equal(m.runningOverlapping(path.join(app, 'build', 'primary', 'zephyr')).length, 1);
    assert.equal(m.runningOverlapping(path.join(app, 'build', 'primary2')).length, 0);
    assert.equal(m.runningOverlapping(path.join(app, 'build', 'debug')).length, 0);
  });

  it('forgets a job once its process has ended', async () => {
    const m = manager();
    const job = held(path.join(app, 'build'), 'clean');
    const { job: state } = m.start(job.spec);
    job.finish();
    await m.wait(state, 1000);
    assert.equal(m.runningOverlapping(path.join(app, 'build', 'primary')).length, 0);
  });
});
