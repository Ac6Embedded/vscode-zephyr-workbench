import { strict as assert } from 'assert';
import * as path from 'path';

import {
  appendStoredBuildConfig,
  applyStoredSettingsPatch,
  canDeleteBuildConfig,
  defaultNewConfigName,
  getNewConfigName,
  markActiveStoredBuildConfig,
  removeStoredBuildConfig,
  resolveBuildDirToDelete,
  StoredBuildConfig,
  validateBuildConfigName,
} from '../../utils/zephyr/buildConfigRules';

const named = (...names: string[]) => names.map(name => ({ name }));

describe('buildConfigRules', () => {
  describe('validateBuildConfigName', () => {
    it('accepts letters, digits, - and _', () => {
      assert.equal(validateBuildConfigName('debug_2-rc', ['primary']), undefined);
    });

    it('refuses an empty name, spaces, dots and path separators', () => {
      assert.match(validateBuildConfigName('', []) ?? '', /cannot be empty/);
      assert.match(validateBuildConfigName('   ', []) ?? '', /cannot be empty/);
      for (const bad of ['my build', 'a.b', '..', 'a/b', 'a\\b', '$(x)']) {
        assert.match(validateBuildConfigName(bad, []) ?? '', /can only contain/, bad);
      }
    });

    it('refuses a name longer than 64 characters', () => {
      assert.equal(validateBuildConfigName('a'.repeat(64), []), undefined);
      assert.match(validateBuildConfigName('a'.repeat(65), []) ?? '', /at most 64/);
    });

    it('treats names that differ only by case as the same, because build folders collide', () => {
      assert.match(validateBuildConfigName('Primary', ['primary']) ?? '', /already exists/);
      assert.match(validateBuildConfigName('primary', ['primary']) ?? '', /already exists/);
    });
  });

  describe('getNewConfigName and defaultNewConfigName', () => {
    it('proposes primary for the first configuration', () => {
      assert.equal(defaultNewConfigName([]), 'primary');
    });

    it('proposes setup_2 when no setup name is used yet', () => {
      assert.equal(getNewConfigName(named('primary')), 'setup_2');
      assert.equal(defaultNewConfigName(named('primary')), 'setup_2');
    });

    it('proposes the number after the highest setup_N, counting a bare setup as 1', () => {
      assert.equal(getNewConfigName(named('setup')), 'setup_2');
      assert.equal(getNewConfigName(named('primary', 'setup_3', 'setup_7')), 'setup_8');
    });
  });

  it('keeps the last configuration of an application', () => {
    assert.equal(canDeleteBuildConfig(0), false);
    assert.equal(canDeleteBuildConfig(1), false);
    assert.equal(canDeleteBuildConfig(2), true);
  });

  describe('stored list edits', () => {
    it('sets keys and removes them for undefined, an empty string or an empty list', () => {
      const stored: StoredBuildConfig = { name: 'a', board: 'x', 'west-args': '-o=-j4', 'west-flags': ['A=1'] };
      applyStoredSettingsPatch(stored, { board: 'y', 'west-args': '', 'west-flags': [], 'default-runner': 'jlink', 'custom-args': undefined });
      assert.deepEqual(stored, { name: 'a', board: 'y', 'default-runner': 'jlink' });
    });

    it('appends an inactive copy unless asked to activate it', () => {
      const configs: StoredBuildConfig[] = [{ name: 'primary', active: 'true' }];
      assert.equal(appendStoredBuildConfig(configs, { name: 'debug', active: 'true' }, false), 1);
      assert.deepEqual(configs, [{ name: 'primary', active: 'true' }, { name: 'debug' }]);
    });

    it('makes an appended configuration the only active one when asked', () => {
      const configs: StoredBuildConfig[] = [{ name: 'primary', active: 'true' }];
      appendStoredBuildConfig(configs, { name: 'debug' }, true);
      assert.deepEqual(configs, [{ name: 'primary' }, { name: 'debug', active: 'true' }]);
    });

    it('refuses to append a name already used, ignoring case', () => {
      const configs: StoredBuildConfig[] = [{ name: 'primary' }];
      assert.equal(appendStoredBuildConfig(configs, { name: 'PRIMARY' }, false), -1);
      assert.equal(configs.length, 1);
    });

    it('marks exactly one configuration active and reports its index', () => {
      const configs: StoredBuildConfig[] = [{ name: 'a', active: 'true' }, { name: 'b' }, { name: 'c', active: 'true' }];
      assert.equal(markActiveStoredBuildConfig(configs, 'b'), 1);
      assert.deepEqual(configs, [{ name: 'a' }, { name: 'b', active: 'true' }, { name: 'c' }]);
      assert.equal(markActiveStoredBuildConfig(configs, 'missing'), -1);
    });

    it('elects the first remaining configuration when the active one is removed', () => {
      const configs: StoredBuildConfig[] = [{ name: 'a' }, { name: 'b', active: 'true' }, { name: 'c' }];
      assert.deepEqual(removeStoredBuildConfig(configs, 'b'), { removed: true, elected: { name: 'a', index: 0 } });
      assert.deepEqual(configs, [{ name: 'a', active: 'true' }, { name: 'c' }]);
    });

    it('leaves the active configuration alone when another one is removed', () => {
      const configs: StoredBuildConfig[] = [{ name: 'a' }, { name: 'b', active: 'true' }];
      assert.deepEqual(removeStoredBuildConfig(configs, 'a'), { removed: true });
      assert.deepEqual(configs, [{ name: 'b', active: 'true' }]);
      assert.deepEqual(removeStoredBuildConfig(configs, 'missing'), { removed: false });
    });
  });

  describe('resolveBuildDirToDelete', () => {
    const app = path.join(path.sep, 'ws', 'app');

    it('targets <app>/build without a configuration and <app>/build/<name> with one', () => {
      assert.equal(resolveBuildDirToDelete(app), path.join(app, 'build'));
      assert.equal(resolveBuildDirToDelete(app, 'primary'), path.join(app, 'build', 'primary'));
    });

    it('refuses a name that would leave the build folder or reach below it', () => {
      for (const bad of ['', '.', '..', '../..', 'a/b', 'a\\b', 'a/', path.join(path.sep, 'etc')]) {
        assert.throws(() => resolveBuildDirToDelete(app, bad), /not a plain folder name/, JSON.stringify(bad));
      }
    });
  });
});
