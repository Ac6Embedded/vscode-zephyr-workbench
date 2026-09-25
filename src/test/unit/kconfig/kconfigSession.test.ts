import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { isInExtraConfFiles, withExtraConfFile } from '../../../utils/kconfig/extraConfFiles';
import { resolveKconfigFile, startKconfigServer, venvPythonPath } from '../../../utils/kconfig/kconfigSession';

describe('kconfigSession helpers', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zwb-ksession-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('finds the interpreter of a virtual environment', () => {
    const bin = process.platform === 'win32' ? path.join(tmp, 'Scripts', 'python.exe') : path.join(tmp, 'bin', 'python');
    assert.equal(venvPythonPath(tmp), undefined);
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '');
    assert.equal(venvPythonPath(tmp), bin);
    assert.equal(venvPythonPath(undefined), undefined);
  });

  it('makes an in-tree Kconfig path absolute only when the file is there', () => {
    fs.mkdirSync(path.join(tmp, 'kernel'));
    fs.writeFileSync(path.join(tmp, 'kernel', 'Kconfig'), '');
    assert.equal(resolveKconfigFile('kernel/Kconfig', tmp), path.join(tmp, 'kernel', 'Kconfig'));
    assert.equal(resolveKconfigFile('missing/Kconfig', tmp), 'missing/Kconfig');
    const absolute = path.join(tmp, 'kernel', 'Kconfig');
    assert.equal(resolveKconfigFile(absolute, '/elsewhere'), absolute);
  });

  it('refuses to start without a configured build, with a code the caller can map', async () => {
    await assert.rejects(
      startKconfigServer({ buildDir: path.join(tmp, 'nothing'), serverScriptPath: '/unused.py' }),
      (e: { code?: string }) => e.code === 'env-unavailable',
    );
  });

  describe('EXTRA_CONF_FILE list', () => {
    it('recognises a listed file whatever the spelling of its path', () => {
      const file = path.join(tmp, 'extra.conf');
      assert.ok(isInExtraConfFiles({ EXTRA_CONF_FILE: [path.join(tmp, '.', 'extra.conf')] }, file));
      assert.ok(!isInExtraConfFiles({ EXTRA_CONF_FILE: 'not-a-list' }, file));
      assert.ok(!isInExtraConfFiles(undefined, file));
    });

    it('appends a file once and drops entries that are not text', () => {
      assert.deepEqual(withExtraConfFile({ EXTRA_CONF_FILE: ['/a.conf', 7] }, '/b.conf'), ['/a.conf', '/b.conf']);
      assert.deepEqual(withExtraConfFile({ EXTRA_CONF_FILE: ['/a.conf'] }, '/a.conf'), ['/a.conf']);
      assert.deepEqual(withExtraConfFile({}, '/a.conf'), ['/a.conf']);
    });
  });
});
