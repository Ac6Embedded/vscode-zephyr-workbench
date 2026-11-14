import { strict as assert } from 'assert';

import { needsPristineRebuild, WestBuildState } from '../../utils/zephyr/westBuildState';

function state(overrides: Partial<WestBuildState> = {}): WestBuildState {
  return {
    board: 'nucleo_f401re',
    sysbuild: false,
    snippets: [],
    cmakeArgs: '',
    envVars: { EXTRA_CONF_FILE: [] },
    toolchainEnv: { ZEPHYR_TOOLCHAIN_VARIANT: 'zephyr' },
    sdkEnv: { ZEPHYR_SDK_INSTALL_DIR: '/opt/zephyr-sdk-1.0.1' },
    workspaceEnv: { ZEPHYR_BASE: '/ws/zephyr' },
    ...overrides,
  };
}

describe('needsPristineRebuild', () => {
  it('is false without a previous state, or when nothing changed', () => {
    assert.equal(needsPristineRebuild(undefined, state()), false);
    assert.equal(needsPristineRebuild(state(), state()), false);
  });

  it('is true for the changes a CMake re-run cannot apply', () => {
    const changes: Partial<WestBuildState>[] = [
      { board: 'nucleo_l476rg' },
      { sysbuild: true },
      { snippets: ['cdc-acm-console'] },
      { envVars: { EXTRA_CONF_FILE: [], SHIELD: ['x_nucleo_iks01a3'] } },
      { sourceDirOverride: '/ws/app/other' },
      { toolchainEnv: { ZEPHYR_TOOLCHAIN_VARIANT: 'gnuarmemb' } },
      { sdkEnv: {} },
      { workspaceEnv: { ZEPHYR_BASE: '/other/zephyr' } },
    ];
    for (const change of changes) {
      assert.equal(needsPristineRebuild(state(), state(change)), true, JSON.stringify(change));
    }
  });

  it('is false for the changes a CMake re-run applies', () => {
    const changes: Partial<WestBuildState>[] = [
      { cmakeArgs: '-DCONFIG_ASSERT=y' },
      { envVars: { EXTRA_CONF_FILE: ['/ws/app/extra.conf'] } },
      { envVars: { EXTRA_CONF_FILE: [], EXTRA_ZEPHYR_MODULES: ['/ws/module'] } },
    ];
    for (const change of changes) {
      assert.equal(needsPristineRebuild(state(), state(change)), false, JSON.stringify(change));
    }
  });
});
