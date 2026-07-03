import { strict as assert } from 'assert';

import {
  getAdvancedRowParts,
  getHostToolsParts,
  getSelectablePartIds,
  hasProviderColumn,
} from '../../utils/hostToolsPartsRegistry';

describe('hostToolsPartsRegistry', () => {
  it('win32 reproduces the legacy artifacts exactly', () => {
    // These literals are the pre-registry HOST_TOOLS_PART_ARTIFACTS map: the
    // registry must keep the win32 behavior byte-identical.
    const legacyArtifacts: Record<string, string> = {
      gperf: 'tools/gperf/bin/gperf.exe',
      cmake: 'tools/cmake/bin/cmake.exe',
      ninja: 'tools/ninja/ninja.exe',
      dtc: 'tools/dtc/usr/bin/dtc.exe',
      git: 'tools/git/bin/git.exe',
      wget: 'tools/wget/wget.exe',
      venv: '.venv/Scripts/Activate.ps1',
      python: 'tools/python/python/python.exe',
    };
    const derived: Record<string, string> = {};
    for (const p of getHostToolsParts('win32')) {
      if (p.probe.artifact) { derived[p.id] = p.probe.artifact; }
    }
    assert.deepEqual(derived, legacyArtifacts);
  });

  it('win32 reproduces the legacy selectable whitelist exactly', () => {
    const legacy = ['gperf', 'cmake', 'ninja', 'dtc', 'git', 'wget', 'python', 'venv'];
    assert.deepEqual([...getSelectablePartIds('win32')].sort(), [...legacy].sort());
  });

  it('win32 reproduces the legacy advanced rows in order', () => {
    assert.deepEqual(
      getAdvancedRowParts('win32').map(p => p.id),
      ['cmake', 'ninja', 'gperf', 'dtc', 'git', 'wget']
    );
    assert.equal(hasProviderColumn('win32'), false);
  });

  it('linux matches the install.sh --tools contract', () => {
    assert.deepEqual(
      [...getSelectablePartIds('linux')].sort(),
      ['cmake', 'ninja', 'python', 'system', 'venv']
    );
    assert.deepEqual(
      getAdvancedRowParts('linux').map(p => p.id),
      ['cmake', 'ninja', 'system']
    );
    assert.equal(hasProviderColumn('linux'), true);
    const system = getHostToolsParts('linux').find(p => p.id === 'system');
    assert.ok(system?.sudo, 'system row must carry the sudo flag');
    assert.deepEqual(system?.probe.versionKeysAllOf, ['git', 'gperf', 'dtc']);
    const venv = getHostToolsParts('linux').find(p => p.id === 'venv');
    assert.equal(venv?.probe.artifact, '.venv/bin/activate');
  });

  it('darwin matches the install-mac.sh --tools contract', () => {
    assert.deepEqual(
      [...getSelectablePartIds('darwin')].sort(),
      ['cmake', 'dtc', 'git', 'gperf', 'ninja', 'python', 'utilities', 'venv']
    );
    assert.deepEqual(
      getAdvancedRowParts('darwin').map(p => p.id),
      ['cmake', 'ninja', 'gperf', 'dtc', 'git', 'utilities']
    );
    assert.equal(hasProviderColumn('darwin'), true);
    // No filesystem artifact for brew tools: presence comes from commands.
    for (const p of getAdvancedRowParts('darwin')) {
      assert.ok(Array.isArray(p.probe.cmds) && p.probe.cmds.length > 0, `${p.id} needs a cmds probe`);
    }
  });

  it('rows never include python or venv (always-installed essentials)', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const rows = getAdvancedRowParts(platform).map(p => p.id);
      assert.ok(!rows.includes('python'), `${platform}: python must not be a row`);
      assert.ok(!rows.includes('venv'), `${platform}: venv must not be a row`);
      // But both must stay selectable for the --tools whitelist.
      const selectable = getSelectablePartIds(platform);
      assert.ok(selectable.includes('python'), `${platform}: python must be selectable`);
      assert.ok(selectable.includes('venv'), `${platform}: venv must be selectable`);
    }
  });
});
