import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JobLog } from '../../../mcp/jobs/jobLog';

function newLog(): JobLog {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-joblog-'));
  return new JobLog(path.join(dir, 'jobs', 'w1', 'build-1.log'));
}

describe('mcp/jobs/jobLog', () => {
  it('creates missing directories on first append', () => {
    const log = newLog();
    log.append('hello\n');
    assert.ok(fs.existsSync(log.filePath));
    log.close();
  });

  it('strips colour before writing, so the stored log is clean', () => {
    const log = newLog();
    log.open();
    log.append('\u001b[32m[1/2]\u001b[0m compiling\n');
    log.close();
    assert.equal(fs.readFileSync(log.filePath, 'utf8'), '[1/2] compiling\n');
  });

  it('collapses carriage-return progress repaints', () => {
    const log = newLog();
    log.open();
    log.append('10%\r55%\r100%\n');
    log.close();
    assert.equal(fs.readFileSync(log.filePath, 'utf8'), '100%\n');
  });

  it('pages from an offset and reports eof', () => {
    const log = newLog();
    log.open();
    log.append('abcdefghij');
    log.close();
    const first = log.read(0, 4);
    assert.equal(first.text, 'abcd');
    assert.equal(first.next_offset, 4);
    assert.equal(first.eof, false);
    const second = log.read(first.next_offset, 100);
    assert.equal(second.text, 'efghij');
    assert.equal(second.eof, true);
  });

  it('returns an empty slice for a log that does not exist yet', () => {
    const log = newLog();
    const slice = log.read(0, 100);
    assert.equal(slice.text, '');
    assert.equal(slice.total_bytes, 0);
    assert.equal(slice.eof, true);
  });

  it('clamps an offset past the end instead of throwing', () => {
    const log = newLog();
    log.open();
    log.append('short');
    log.close();
    const slice = log.read(9999, 100);
    assert.equal(slice.text, '');
    assert.equal(slice.offset, 5);
  });

  it('tails the last lines of a long log', () => {
    const log = newLog();
    log.open();
    for (let i = 0; i < 500; i++) {
      log.append(`line ${i}\n`);
    }
    log.close();
    const tail = log.tail(3);
    assert.deepEqual(tail.split('\n'), ['line 497', 'line 498', 'line 499']);
  });

  it('never emits a partial first line when tailing', () => {
    const log = newLog();
    log.open();
    log.append(`${'x'.repeat(50000)}\nlast line\n`);
    log.close();
    const tail = log.tail(40, 200);
    assert.ok(!tail.includes('xxxx') || tail.startsWith('... (truncated)'),
      'a truncated tail must announce itself');
  });

  it('caps the tail by characters', () => {
    const log = newLog();
    log.open();
    for (let i = 0; i < 200; i++) {
      log.append(`${'y'.repeat(100)}\n`);
    }
    log.close();
    const tail = log.tail(100, 500);
    assert.ok(tail.length <= 520, `expected a capped tail, got ${tail.length} characters`);
    assert.match(tail, /^\.\.\. \(truncated\)/);
  });

  it('greps matching lines with context', () => {
    const log = newLog();
    log.open();
    log.append(['before', 'main.c:12: error: boom', 'after', 'unrelated'].join('\n'));
    log.close();
    const hit = log.grep('error:', 1);
    assert.deepEqual(hit.split('\n'), ['before', 'main.c:12: error: boom', 'after']);
  });

  it('treats grep patterns as plain text with * wildcards, never as a regex', () => {
    const log = newLog();
    log.open();
    log.append(['a ([unclosed thing', 'region FLASH overflowed', 'other'].join('\n'));
    log.close();
    assert.equal(log.grep('([unclosed'), 'a ([unclosed thing', 'regex syntax is literal text');
    assert.equal(log.grep('region*overflowed'), 'region FLASH overflowed');
  });

  it('stays fast on a pattern that would freeze a backtracking regex', () => {
    const log = newLog();
    log.open();
    for (let i = 0; i < 2000; i++) {
      log.append(`${'a'.repeat(60)}\n`);
    }
    log.close();
    const started = Date.now();
    log.grep('(a+)+!');
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  });

  it('tracks written size', () => {
    const log = newLog();
    log.open();
    log.append('12345\n');
    assert.equal(log.size, 6);
    log.close();
  });
});
