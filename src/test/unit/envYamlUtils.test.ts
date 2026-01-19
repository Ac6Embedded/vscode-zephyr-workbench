import { strict as assert } from 'assert';

import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'yaml';

import { getExtraPaths, normalizePath, removeExtraPath, setExtraPath } from '../../utils/envYamlUtils';

describe('envYamlUtils', () => {
  let tmpDir: string;
  let envPath: string;
  let priorPortable: string | undefined;

  beforeEach(() => {
    priorPortable = process.env['VSCODE_PORTABLE'];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zwb-envyml-'));
    process.env['VSCODE_PORTABLE'] = tmpDir;

    // envYamlUtils resolves to: <VSCODE_PORTABLE>/.zinstaller/env.yml
    fs.mkdirSync(path.join(tmpDir, '.zinstaller'), { recursive: true });
    envPath = path.join(tmpDir, '.zinstaller', 'env.yml');
  });

  afterEach(() => {
    if (priorPortable === undefined) {
      delete process.env['VSCODE_PORTABLE'];
    } else {
      process.env['VSCODE_PORTABLE'] = priorPortable;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('normalizes windows paths', () => {
    assert.equal(normalizePath('C:\\foo\\bar'), 'C:/foo/bar');
  });

  it('setExtraPath creates structure and writes YAML', () => {
    const res = setExtraPath('EXTRA_TOOLS', 0, '  C:\\tools  ');
    assert.ok(fs.existsSync(envPath));

    const txt = fs.readFileSync(envPath, 'utf8');
    const parsed = yaml.parse(txt);

    assert.deepEqual(parsed.other.EXTRA_TOOLS.path, ['C:/tools']);
    assert.deepEqual(getExtraPaths('EXTRA_TOOLS'), ['C:/tools']);
    assert.ok(res);
  });

  it('setExtraPath appends when idx equals length', () => {
    setExtraPath('EXTRA_RUNNERS', 0, 'A');
    setExtraPath('EXTRA_RUNNERS', 1, 'B');

    assert.deepEqual(getExtraPaths('EXTRA_RUNNERS'), ['A', 'B']);
  });

  it('removeExtraPath removes entries and cleans empty containers', () => {
    setExtraPath('EXTRA_TOOLS', 0, 'A');
    removeExtraPath('EXTRA_TOOLS', 0);

    assert.deepEqual(getExtraPaths('EXTRA_TOOLS'), []);

    const txt = fs.readFileSync(envPath, 'utf8');
    const parsed = yaml.parse(txt) || {};

    // best-effort check: structure removed or empty
    const extra = parsed?.other?.EXTRA_TOOLS?.path;
    assert.ok(extra === undefined || (Array.isArray(extra) && extra.length === 0));
  });

  it('removeExtraPath pops last entry on out-of-range idx', () => {
    setExtraPath('EXTRA_TOOLS', 0, 'A');
    setExtraPath('EXTRA_TOOLS', 1, 'B');
    removeExtraPath('EXTRA_TOOLS', 99);

    assert.deepEqual(getExtraPaths('EXTRA_TOOLS'), ['A']);
  });
});
