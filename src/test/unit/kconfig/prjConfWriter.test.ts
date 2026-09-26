import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  BEGIN,
  END,
  planPrjConfUpsert,
  readPrjConfManagedRegion,
  symbolOf,
  upsertPrjConfManagedRegion,
} from '../../../utils/kconfig/prjConfWriter';

describe('prjConfWriter', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zwb-prjconf-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  describe('symbolOf', () => {
    it('reads both assignment forms', () => {
      assert.equal(symbolOf('CONFIG_FOO=y'), 'CONFIG_FOO');
      assert.equal(symbolOf('  CONFIG_BAR = "x"'), 'CONFIG_BAR');
      assert.equal(symbolOf('# CONFIG_BAZ is not set'), 'CONFIG_BAZ');
      assert.equal(symbolOf('# a comment'), undefined);
    });
  });

  describe('planPrjConfUpsert', () => {
    it('creates the region after the existing content, with one blank line between', () => {
      const plan = planPrjConfUpsert('CONFIG_GPIO=y\n', ['CONFIG_LOG=y']);
      assert.equal(plan.text, `CONFIG_GPIO=y\n\n${BEGIN}\nCONFIG_LOG=y\n${END}\n`);
      assert.equal(plan.changed, true);
      assert.deepEqual(plan.regionLines, ['CONFIG_LOG=y']);
    });

    it('keeps earlier managed lines: a second write adds to the region instead of replacing it', () => {
      const first = planPrjConfUpsert('', ['CONFIG_A=y']).text;
      const second = planPrjConfUpsert(first, ['CONFIG_B=y']);
      assert.deepEqual(second.regionLines, ['CONFIG_A=y', 'CONFIG_B=y']);
    });

    it('replaces the line of a symbol in place', () => {
      const first = planPrjConfUpsert('', ['CONFIG_A=y', 'CONFIG_B=1', 'CONFIG_C=y']).text;
      const second = planPrjConfUpsert(first, ['CONFIG_B=2']);
      assert.deepEqual(second.regionLines, ['CONFIG_A=y', 'CONFIG_B=2', 'CONFIG_C=y']);
    });

    it('removes a symbol, and the markers with the last one', () => {
      const text = `CONFIG_GPIO=y\n\n${BEGIN}\nCONFIG_A=y\nCONFIG_B=y\n${END}\n\n# tail\n`;
      const partial = planPrjConfUpsert(text, [], ['CONFIG_A']);
      assert.deepEqual(partial.regionLines, ['CONFIG_B=y']);
      const empty = planPrjConfUpsert(partial.text, [], ['CONFIG_B']);
      assert.equal(empty.text, 'CONFIG_GPIO=y\n\n# tail\n');
      assert.deepEqual(empty.regionLines, []);
    });

    it('does not grow the file on repeated writes of the same content', () => {
      let text = 'CONFIG_GPIO=y\n\n\n';
      text = planPrjConfUpsert(text, ['CONFIG_A=y']).text;
      const once = text;
      for (let i = 0; i < 4; i++) {
        text = planPrjConfUpsert(text, ['CONFIG_A=n']).text;
        text = planPrjConfUpsert(text, ['CONFIG_A=y']).text;
      }
      assert.equal(text, once);
      assert.ok(!text.endsWith('\n\n'));
    });

    it('leaves the file byte for byte alone when nothing changes', () => {
      const text = `# keep   \r\n\r\n\r\n${BEGIN}\r\nCONFIG_A=y\r\n${END}\r\n\r\n`;
      const plan = planPrjConfUpsert(text, ['CONFIG_A=y']);
      assert.equal(plan.changed, false);
      assert.equal(plan.text, text);
    });

    it('finds the region of a CRLF file and keeps its line endings', () => {
      const text = `CONFIG_GPIO=y\r\n\r\n${BEGIN}\r\nCONFIG_A=y\r\n${END}\r\n`;
      const plan = planPrjConfUpsert(text, ['CONFIG_B=y']);
      assert.equal(plan.text, `CONFIG_GPIO=y\r\n\r\n${BEGIN}\r\nCONFIG_A=y\r\nCONFIG_B=y\r\n${END}\r\n`);
      assert.equal(plan.text.split(BEGIN).length, 2, 'exactly one region');
    });

    it('reports assignments outside the region, and whether they come after it', () => {
      const text = `CONFIG_A=n\n\n${BEGIN}\n${END}\nCONFIG_B=n\n`;
      const plan = planPrjConfUpsert(text, ['CONFIG_A=y', 'CONFIG_B=y']);
      assert.deepEqual(plan.outsideAssignments, [
        { symbol: 'CONFIG_A', line: 1, afterRegion: false },
        { symbol: 'CONFIG_B', line: 7, afterRegion: true },
      ]);
      assert.equal(plan.lineOf.CONFIG_A, 4);
    });

    it('refuses a line carrying a control character', () => {
      assert.throws(() => planPrjConfUpsert('', ['CONFIG_S="a"\nCONFIG_EVIL=y']), /control character/);
      assert.throws(() => planPrjConfUpsert('', ['CONFIG_S="a\u0000"']), /control character/);
    });
  });

  describe('upsertPrjConfManagedRegion', () => {
    it('creates a missing file and its folder, and reads the region back', () => {
      const file = path.join(tmp, 'sub', 'extra.conf');
      const result = upsertPrjConfManagedRegion(file, ['CONFIG_A=y']);
      assert.equal(result.written, 1);
      assert.deepEqual(result.lines, ['CONFIG_A=y']);
      assert.deepEqual(readPrjConfManagedRegion(file), ['CONFIG_A=y']);
      assert.deepEqual(fs.readdirSync(path.dirname(file)), ['extra.conf'], 'no temporary file is left behind');
    });

    it('keeps the lines of an earlier export', () => {
      const file = path.join(tmp, 'prj.conf');
      fs.writeFileSync(file, 'CONFIG_GPIO=y\n');
      upsertPrjConfManagedRegion(file, ['CONFIG_A=y']);
      const result = upsertPrjConfManagedRegion(file, ['CONFIG_B=y']);
      assert.deepEqual(result.lines, ['CONFIG_A=y', 'CONFIG_B=y']);
      assert.ok(fs.readFileSync(file, 'utf8').startsWith('CONFIG_GPIO=y\n'));
    });

    it('names outside conflicts with the CONFIG_ prefix, as the panel shows them', () => {
      const file = path.join(tmp, 'prj.conf');
      fs.writeFileSync(file, 'CONFIG_A=n\n');
      assert.deepEqual(upsertPrjConfManagedRegion(file, ['CONFIG_A=y']).outsideConflicts, ['CONFIG_A']);
    });

    it('returns an empty region for a missing file', () => {
      assert.deepEqual(readPrjConfManagedRegion(path.join(tmp, 'none.conf')), []);
    });
  });

  describe('writing through links and permissions', () => {
    const isPosix = process.platform !== 'win32';

    it('writes the file a linked prj.conf points to, and keeps the link and the mode', function () {
      const shared = path.join(tmp, 'shared', 'common.conf');
      fs.mkdirSync(path.dirname(shared));
      fs.writeFileSync(shared, 'CONFIG_GPIO=y\n');
      fs.chmodSync(shared, 0o640);
      const prj = path.join(tmp, 'app', 'prj.conf');
      fs.mkdirSync(path.dirname(prj));
      try {
        fs.symlinkSync(path.join('..', 'shared', 'common.conf'), prj);
      } catch {
        this.skip();
      }
      upsertPrjConfManagedRegion(prj, ['CONFIG_LOG=y']);
      assert.ok(fs.lstatSync(prj).isSymbolicLink(), 'the link survives');
      assert.deepEqual(readPrjConfManagedRegion(shared), ['CONFIG_LOG=y'], 'the shared file got the change');
      if (isPosix) {
        assert.equal(fs.statSync(shared).mode & 0o777, 0o640);
      }
      assert.deepEqual(fs.readdirSync(path.dirname(prj)), ['prj.conf'], 'no temporary file is left next to the link');
      assert.deepEqual(fs.readdirSync(path.dirname(shared)), ['common.conf']);
    });

    it('creates the target of a link that does not exist yet', function () {
      const prj = path.join(tmp, 'prj.conf');
      try {
        fs.symlinkSync('real.conf', prj);
      } catch {
        this.skip();
      }
      upsertPrjConfManagedRegion(prj, ['CONFIG_LOG=y']);
      assert.ok(fs.lstatSync(prj).isSymbolicLink());
      assert.deepEqual(readPrjConfManagedRegion(path.join(tmp, 'real.conf')), ['CONFIG_LOG=y']);
    });

    it('keeps the permissions of a plain file', function () {
      if (!isPosix) { this.skip(); }
      const prj = path.join(tmp, 'prj.conf');
      fs.writeFileSync(prj, 'CONFIG_GPIO=y\n');
      fs.chmodSync(prj, 0o600);
      upsertPrjConfManagedRegion(prj, ['CONFIG_LOG=y']);
      assert.equal(fs.statSync(prj).mode & 0o777, 0o600);
    });

    it('refuses a read-only file, as a plain write does', function () {
      if (isPosix && process.getuid?.() === 0) { this.skip(); }
      const prj = path.join(tmp, 'prj.conf');
      fs.writeFileSync(prj, 'CONFIG_GPIO=y\n');
      fs.chmodSync(prj, 0o444);
      try {
        assert.throws(() => upsertPrjConfManagedRegion(prj, ['CONFIG_LOG=y']), (e: NodeJS.ErrnoException) => e.code === 'EACCES' || e.code === 'EPERM');
        assert.equal(fs.readFileSync(prj, 'utf8'), 'CONFIG_GPIO=y\n');
      } finally {
        fs.chmodSync(prj, 0o644);
      }
    });

    it('updates every hard link of the file', function () {
      const prj = path.join(tmp, 'prj.conf');
      const other = path.join(tmp, 'other.conf');
      fs.writeFileSync(prj, 'CONFIG_GPIO=y\n');
      try {
        fs.linkSync(prj, other);
      } catch {
        this.skip();
      }
      upsertPrjConfManagedRegion(prj, ['CONFIG_LOG=y']);
      assert.deepEqual(readPrjConfManagedRegion(other), ['CONFIG_LOG=y']);
    });
  });
});
