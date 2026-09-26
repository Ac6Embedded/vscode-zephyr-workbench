import { strict as assert } from 'assert';
import * as path from 'path';
import { conflictOf, conflictsWith, JobClaim, writesOf } from '../../../mcp/jobs/jobConflicts';

describe('mcp/jobs/jobConflicts', () => {
  const ws = path.join(path.sep, 'ws');
  const app = path.join(ws, 'app');
  const venv = path.join(ws, '.venv');
  const primary = path.join(app, 'build', 'primary');

  const build = (over: Partial<JobClaim> = {}): JobClaim => ({
    kind: 'build', lockKey: primary, buildDir: primary, westWorkspace: ws, venvPath: venv, ...over,
  });
  const westUpdate = (over: Partial<JobClaim> = {}): JobClaim => ({
    kind: 'west', lockKey: `west:${ws}`, westWorkspace: ws, writes: ['west_workspace'], ...over,
  });

  it('always conflicts on the same lock key, whatever the jobs write', () => {
    const a: JobClaim = { kind: 'flash', lockKey: 'same' };
    const b: JobClaim = { kind: 'run', lockKey: 'same' };
    assert.equal(conflictOf(a, b), 'lock');
  });

  it('keeps a build out of a folder another build or a deletion writes, in either direction', () => {
    const deletion: JobClaim = { kind: 'clean', lockKey: path.join(app, 'build'), buildDir: path.join(app, 'build') };
    assert.equal(conflictOf(build({ lockKey: 'build-a' }), build({ lockKey: 'build-b' })), 'build_dir');
    assert.equal(conflictOf(build(), deletion), 'build_dir');
    assert.equal(conflictOf(deletion, build()), 'build_dir');
    assert.equal(conflictsWith(build(), build({ lockKey: 'other', buildDir: path.join(app, 'build', 'primary2') })), false,
      'a sibling folder whose name starts the same is not inside');
  });

  it('lets two readers of one build folder run together, but not a reader and a writer', () => {
    const flash: JobClaim = { kind: 'flash', lockKey: 'flash', buildDir: primary };
    const debug: JobClaim = { kind: 'task', lockKey: 'debug', buildDir: primary };
    assert.equal(conflictsWith(flash, debug), false);
    assert.equal(conflictOf(flash, build({ lockKey: 'build' })), 'build_dir');
    assert.equal(conflictOf(flash, { ...debug, writes: ['build_dir'] }), 'build_dir');
  });

  it('keeps a build out of a west workspace an agent is updating, compared as normalized paths', () => {
    assert.equal(conflictOf(build(), westUpdate()), 'west_workspace');
    assert.equal(conflictOf(westUpdate({ westWorkspace: `${ws}${path.sep}` }), build()), 'west_workspace');
    assert.equal(conflictsWith(build(), westUpdate({ westWorkspace: path.join(path.sep, 'other') })), false);
  });

  it('lets builds of one west workspace and one venv run side by side', () => {
    const other = build({ lockKey: 'debug', buildDir: path.join(app, 'build', 'debug') });
    assert.equal(conflictsWith(build(), other), false);
  });

  it('keeps every user of a Python environment out while it is rebuilt', () => {
    const rebuild: JobClaim = { kind: 'install', lockKey: `venv:${venv}`, venvPath: venv, writes: ['venv'] };
    assert.equal(conflictOf(build(), rebuild), 'venv');
    assert.equal(conflictsWith(build({ venvPath: path.join(ws, '.venv2') }), rebuild), false);
    assert.equal(conflictsWith(rebuild, { kind: 'install', lockKey: 'other-venv', venvPath: path.join(ws, 'other') }), false);
  });

  it('implies a build folder write only for builds and deletions that name one', () => {
    assert.deepEqual([...writesOf(build())], ['build_dir']);
    assert.deepEqual([...writesOf({ kind: 'clean', lockKey: 'x', buildDir: primary })], ['build_dir']);
    assert.deepEqual([...writesOf({ kind: 'build', lockKey: 'x' })], []);
    assert.deepEqual([...writesOf({ kind: 'flash', lockKey: 'x', buildDir: primary })], []);
    assert.deepEqual([...writesOf(westUpdate())], ['west_workspace']);
  });
});
