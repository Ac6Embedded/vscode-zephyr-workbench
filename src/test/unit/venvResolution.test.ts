import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The modules' vscode import resolves to the stub under src/test/unit/stubs
// (NODE_PATH), like the other unit tests.
import { resolveBuildVenv, resolveEffectiveVenv } from '../../utils/env/venvResolution';
import { collectEnvironmentSettings } from '../../utils/hostToolsStatusCollector';

// Settings come from `settings`, and the internal dir, env.yml and the managed
// venv follow VSCODE_PORTABLE into a scratch folder, so nothing here depends
// on this machine.

type Settings = Record<string, unknown>;
// The raw stub module, whose exports are swapped for this file's tests.
const stub = require('vscode') as { Uri: object; workspace: { getConfiguration: unknown } };
const ENV_SCRIPT = 'zephyr-workbench.pathToEnvScript';
const VENV = 'zephyr-workbench.venv.path';
const bin = process.platform === 'win32' ? 'Scripts' : 'bin';
const westExe = process.platform === 'win32' ? 'west.exe' : 'west';

describe('environment settings and venv resolution', () => {
  let root: string;
  let internal: string;
  let settings: Settings;
  let savedPortable: string | undefined;
  let savedUri: object;
  let savedGetConfiguration: unknown;

  before(() => {
    // The settings reader tests `scope instanceof vscode.Uri`, which needs a constructor.
    savedUri = stub.Uri;
    stub.Uri = Object.assign(function Uri() { /* stub */ }, savedUri);
    savedGetConfiguration = stub.workspace.getConfiguration;
    stub.workspace.getConfiguration = () => ({ get: (key: string) => settings[key], update: async () => undefined });
  });
  after(() => {
    stub.Uri = savedUri;
    stub.workspace.getConfiguration = savedGetConfiguration;
  });
  beforeEach(() => {
    savedPortable = process.env.VSCODE_PORTABLE;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-venv-'));
    process.env.VSCODE_PORTABLE = root;
    internal = path.join(root, '.zinstaller');
    fs.mkdirSync(internal);
    settings = {};
  });
  afterEach(() => {
    if (savedPortable === undefined) {
      delete process.env.VSCODE_PORTABLE;
    } else {
      process.env.VSCODE_PORTABLE = savedPortable;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const makeVenv = (dir: string, withWest = true) => {
    fs.mkdirSync(path.join(dir, bin), { recursive: true });
    if (withWest) {
      fs.writeFileSync(path.join(dir, bin, westExe), '');
    }
    return dir;
  };

  describe('resolveEffectiveVenv', () => {
    it('prefers the application venv, then venv.path, then the managed venv', () => {
      assert.deepEqual(resolveEffectiveVenv(), { source: 'none' });

      const managed = makeVenv(path.join(internal, '.venv'));
      assert.deepEqual(resolveEffectiveVenv(), { path: managed, source: 'managed-default' });

      settings[VENV] = path.join(root, 'configured');
      assert.deepEqual(resolveEffectiveVenv(), { path: path.join(root, 'configured'), source: 'setting' });

      assert.deepEqual(resolveEffectiveVenv({ venvPath: '/apps/a/.venv' }), { path: '/apps/a/.venv', source: 'application' });
    });

    it('keeps the public API answer while builds follow the env script', () => {
      const managed = makeVenv(path.join(internal, '.venv'));
      const custom = makeVenv(path.join(root, 'custom-venv'));
      fs.writeFileSync(path.join(internal, 'env.yml'), `python:\n  global_venv_path: ${JSON.stringify(custom)}\n`);

      // With no PYTHON_VENV_PATH the sourced env script activates env.yml's venv.
      assert.deepEqual(resolveBuildVenv().venv, { path: custom, source: 'env-yml' });
      assert.deepEqual(resolveEffectiveVenv(), { path: managed, source: 'managed-default' });

      // Builds ignore an SPDX-only venv.path; the public API always returned it.
      settings[VENV] = path.join(root, '.venv-spdx');
      assert.deepEqual(resolveBuildVenv().venv, { path: custom, source: 'env-yml' });
      assert.equal(resolveEffectiveVenv().source, 'setting');
    });
  });

  describe('resolveBuildVenv', () => {
    it('finds west in the venv a build activates', () => {
      const venv = makeVenv(path.join(internal, '.venv'));
      assert.deepEqual(resolveBuildVenv(), {
        venv: { path: venv, source: 'managed-default' },
        exists: true,
        westPath: path.join(venv, bin, westExe),
        westFound: true,
      });

      const noWest = makeVenv(path.join(root, 'no-west'), false);
      const withoutWest = resolveBuildVenv({ venvPath: noWest });
      assert.equal(withoutWest.exists, true);
      assert.equal(withoutWest.westFound, false);

      const gone = resolveBuildVenv({ venvPath: path.join(root, 'deleted') });
      assert.equal(gone.exists, false);
      assert.equal(gone.westFound, false);
      assert.equal(gone.westPath, undefined);
    });
  });

  describe('collectEnvironmentSettings', () => {
    it('refuses env-sourced commands exactly where a build would', () => {
      let status = collectEnvironmentSettings();
      assert.equal(status.envScript.ok, false);
      assert.equal(status.venvSetting.ok, true, 'an empty venv.path is valid');
      assert.equal(status.preflightError?.setting, ENV_SCRIPT);
      assert.equal(status.envSourcedReady, false);

      const envScript = path.join(internal, 'env.sh');
      settings[ENV_SCRIPT] = envScript;
      status = collectEnvironmentSettings();
      assert.equal(status.envScript.configured, envScript);
      assert.equal(status.envScript.ok, false, 'the setting points at a file that does not exist');
      assert.equal(status.preflightError, undefined);
      assert.equal(status.envSourcedReady, false);

      fs.writeFileSync(envScript, '');
      status = collectEnvironmentSettings();
      assert.equal(status.envScript.ok, true);
      assert.equal(status.envSourcedReady, true);
      assert.ok(status.shell.path.length > 0);

      settings[VENV] = path.join(root, 'missing-venv');
      status = collectEnvironmentSettings();
      assert.deepEqual(status.venvSetting, { configured: path.join(root, 'missing-venv'), exists: false, ok: false });
      assert.equal(status.preflightError?.setting, VENV);
      assert.equal(status.envSourcedReady, false);
    });

    it('ignores an SPDX-only venv.path, as every build does', () => {
      const envScript = path.join(internal, 'env.sh');
      fs.writeFileSync(envScript, '');
      settings[ENV_SCRIPT] = envScript;
      settings[VENV] = path.join(root, '.venv-spdx');

      const status = collectEnvironmentSettings();
      assert.deepEqual(status.venvSetting, { configured: path.join(root, '.venv-spdx'), exists: false, ok: true, spdxOnlyIgnored: true });
      assert.equal(status.envSourcedReady, true);
    });
  });
});
