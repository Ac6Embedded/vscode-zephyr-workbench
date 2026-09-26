import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import {
  readKconfigFragments,
  findBuildInfoYml,
  checkFragmentStaleness,
  findFragmentAssignments,
  findLaterFragmentOverrides,
  fragmentsMergedAfter,
  mergeListWithTarget,
} from '../../../utils/kconfig/fragmentStaleness';

function md5(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

describe('fragmentStaleness', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zwb-frag-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

  function writeBuild(fragContents: Record<string, string>) {
    const buildDir = path.join(tmp, 'build', 'primary');
    fs.mkdirSync(path.join(buildDir, 'zephyr', 'kconfig'), { recursive: true });
    const files: string[] = [];
    let checksum = '';
    for (const [name, content] of Object.entries(fragContents)) {
      const p = path.join(tmp, name);
      fs.writeFileSync(p, content);
      files.push(p);
      checksum += md5(content);
    }
    // The Kconfig-source hashes appended by zephyr: one real source file.
    const kconfigSource = path.join(tmp, 'Kconfig');
    fs.writeFileSync(kconfigSource, 'config FOO\n\tbool "Foo"\n');
    fs.writeFileSync(path.join(buildDir, 'zephyr', 'kconfig', 'sources.txt'), kconfigSource + '\n');
    checksum += md5('config FOO\n\tbool "Foo"\n');
    fs.writeFileSync(path.join(buildDir, 'zephyr', '.cmake.dotconfig.checksum'), checksum);
    fs.writeFileSync(path.join(buildDir, 'build_info.yml'), [
      'cmake:',
      '  kconfig:',
      '    files:',
      ...files.map((f) => `     - '${f}'`),
      '    user-files:',
      `     - '${files[files.length - 1]}'`,
      '',
    ].join('\n'));
    return { buildDir, files };
  }

  describe('readKconfigFragments + findBuildInfoYml', () => {
    it('reads the ordered fragment list and user files', () => {
      const { buildDir, files } = writeBuild({ 'board_defconfig': 'CONFIG_SERIAL=y\n', 'prj.conf': 'CONFIG_DEBUG=y\n' });
      const ymlPath = findBuildInfoYml(buildDir);
      assert.ok(ymlPath);
      const info = readKconfigFragments(ymlPath!);
      assert.ok(info);
      assert.deepEqual(info!.files, files);
      assert.deepEqual(info!.userFiles, [files[1]]);
    });

    it('finds a sysbuild-root build_info.yml from the domain dir', () => {
      const root = path.join(tmp, 'build', 'primary');
      const domain = path.join(root, 'myapp');
      fs.mkdirSync(domain, { recursive: true });
      fs.writeFileSync(path.join(root, 'build_info.yml'), 'cmake: {}\n');
      assert.equal(findBuildInfoYml(domain), path.join(root, 'build_info.yml'));
    });

    it('returns undefined for missing or fragment-less yml', () => {
      const p = path.join(tmp, 'x.yml');
      fs.writeFileSync(p, 'cmake:\n  kconfig: {}\n');
      assert.equal(readKconfigFragments(p), undefined);
      assert.equal(readKconfigFragments(path.join(tmp, 'nope.yml')), undefined);
    });
  });

  describe('checkFragmentStaleness', () => {
    it('reports fresh when fragment hashes match the checksum prefix', () => {
      const { buildDir, files } = writeBuild({ 'board_defconfig': 'CONFIG_SERIAL=y\n', 'prj.conf': 'CONFIG_DEBUG=y\n' });
      assert.deepEqual(checkFragmentStaleness(buildDir, files), { stale: false });
    });

    it('reports stale after a fragment is edited', () => {
      const { buildDir, files } = writeBuild({ 'board_defconfig': 'CONFIG_SERIAL=y\n', 'prj.conf': 'CONFIG_DEBUG=y\n' });
      fs.appendFileSync(files[1], 'CONFIG_NEW_THING=y\n');
      const res = checkFragmentStaleness(buildDir, files);
      assert.equal(res.stale, true);
      assert.match(res.reason ?? '', /prj\.conf/);
    });

    it('reports stale when the checksum file is missing', () => {
      const { buildDir, files } = writeBuild({ 'prj.conf': 'CONFIG_DEBUG=y\n' });
      fs.rmSync(path.join(buildDir, 'zephyr', '.cmake.dotconfig.checksum'));
      const res = checkFragmentStaleness(buildDir, files);
      assert.equal(res.stale, true);
    });

    it('reports stale when a fragment file disappeared', () => {
      const { buildDir, files } = writeBuild({ 'prj.conf': 'CONFIG_DEBUG=y\n' });
      fs.rmSync(files[0]);
      assert.equal(checkFragmentStaleness(buildDir, files).stale, true);
    });

    it('reports stale when a Kconfig source changed', () => {
      const { buildDir, files } = writeBuild({ 'prj.conf': 'CONFIG_DEBUG=y\n' });
      fs.appendFileSync(path.join(tmp, 'Kconfig'), 'config BAR\n\tbool "Bar"\n');
      const res = checkFragmentStaleness(buildDir, files);
      assert.equal(res.stale, true);
      assert.match(res.reason ?? '', /Kconfig sources changed/);
    });

    it('leaves out the file sysbuild forces on an image, which the checksum does not cover', () => {
      // build_info.yml lists merge_config_files plus FORCED_CONF_FILE; the checksum holds
      // only merge_config_files, then the Kconfig sources.
      const { buildDir, files } = writeBuild({ 'board_defconfig': 'CONFIG_SERIAL=y\n', 'prj.conf': 'CONFIG_DEBUG=y\n' });
      const forced = path.join(buildDir, 'zephyr', '.config.sysbuild');
      fs.writeFileSync(forced, 'CONFIG_BOOTLOADER_MCUBOOT=y\n');
      const listed = [...files, forced];
      assert.deepEqual(checkFragmentStaleness(buildDir, listed), { stale: false });
      // The real fragments are still compared.
      fs.appendFileSync(files[1], 'CONFIG_NEW_THING=y\n');
      assert.match(checkFragmentStaleness(buildDir, listed).reason ?? '', /prj\.conf/);
    });

    it('reports stale when the sources list is missing', () => {
      const { buildDir, files } = writeBuild({ 'prj.conf': 'CONFIG_DEBUG=y\n' });
      fs.rmSync(path.join(buildDir, 'zephyr', 'kconfig', 'sources.txt'));
      const res = checkFragmentStaleness(buildDir, files);
      assert.equal(res.stale, true);
      assert.match(res.reason ?? '', /sources list/);
    });
  });

  describe('findLaterFragmentOverrides', () => {
    it('maps overridden names to the first later fragment that assigns them', () => {
      const extra = path.join(tmp, 'extra.conf');
      fs.writeFileSync(extra, 'CONFIG_FOO=y\n# CONFIG_BAR is not set\n');
      const overrides = findLaterFragmentOverrides([extra], ['FOO', 'BAR', 'BAZ']);
      assert.equal(overrides.get('FOO'), extra);
      assert.equal(overrides.get('BAR'), extra);
      assert.equal(overrides.has('BAZ'), false);
    });

    it('ignores missing files and empty inputs', () => {
      assert.equal(findLaterFragmentOverrides([path.join(tmp, 'nope.conf')], ['FOO']).size, 0);
      assert.equal(findLaterFragmentOverrides([], ['FOO']).size, 0);
    });
  });

  describe('merge order helpers', () => {
    const board = '/zp/zephyr/boards/b/b_defconfig';
    const prj = '/app/prj_debug.conf';
    const extra = '/app/extra.conf';
    const generated = '/app/build/primary/zephyr/misc/generated/extra_kconfig_options.conf';
    const info = { files: [board, prj, extra, generated], userFiles: [prj], extraUserFiles: [extra] };

    it('lists what merges after the prj.conf the build really uses, even under another name', () => {
      assert.deepEqual(fragmentsMergedAfter(info, prj, true), [extra, generated]);
      // The panel used to anchor on <app>/prj.conf, which is not in this list.
      assert.deepEqual(fragmentsMergedAfter(info, '/app/prj.conf', true), [extra, generated]);
    });

    it('puts a new fragment at the EXTRA_CONF_FILE position', () => {
      assert.deepEqual(fragmentsMergedAfter(info, '/app/new.conf', false), [generated]);
    });

    it('replaces a listed target in place with its stand-in', () => {
      const merged = mergeListWithTarget(info, prj, '/tmp/standin.conf', '/app/build/primary');
      assert.deepEqual(merged, { files: [board, '/tmp/standin.conf', extra, generated], inBuild: true });
    });

    it('inserts a new fragment after the last EXTRA_CONF_FILE entry', () => {
      const merged = mergeListWithTarget(info, '/app/new.conf', '/tmp/new.conf', '/app/build/primary');
      assert.deepEqual(merged, { files: [board, prj, extra, '/tmp/new.conf', generated], inBuild: false });
    });

    it('inserts a new fragment before the files the build generates when there is no extra fragment', () => {
      const plain = { files: [board, prj, generated], userFiles: [prj], extraUserFiles: [] };
      const merged = mergeListWithTarget(plain, '/app/new.conf', '/tmp/new.conf', '/app/build/primary');
      assert.deepEqual(merged.files, [board, prj, '/tmp/new.conf', generated]);
    });

    it('finds every assignment of a symbol in merge order, with its line', () => {
      const a = path.join(tmp, 'a.conf');
      const b = path.join(tmp, 'b.conf');
      fs.writeFileSync(a, 'CONFIG_FOO=y\r\n# CONFIG_BAR is not set\r\n');
      fs.writeFileSync(b, '# comment\nCONFIG_FOO=n\nCONFIG_BAZ="x y"\n');
      const found = findFragmentAssignments([a, path.join(tmp, 'missing.conf'), b], ['FOO', 'BAR', 'BAZ', 'QUX']);
      assert.deepEqual(found.get('FOO'), [{ file: a, line: 1, value: 'y' }, { file: b, line: 2, value: 'n' }]);
      assert.deepEqual(found.get('BAR'), [{ file: a, line: 2, value: 'n' }]);
      assert.deepEqual(found.get('BAZ'), [{ file: b, line: 3, value: '"x y"' }]);
      assert.equal(found.has('QUX'), false);
    });
  });
});
