import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import {
  readKconfigFragments,
  findBuildInfoYml,
  checkFragmentStaleness,
  findLaterFragmentOverrides,
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
});
