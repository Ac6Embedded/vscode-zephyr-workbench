import { strict as assert } from 'assert';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import {
  buildAliasProbeTool,
  findDebugToolIdsForRunner,
  getConfiguredDebugToolPath,
  getDefaultToolIdForAlias,
  isDebugToolCompatible,
  listDebugToolSelectors,
  ManifestDebugTool,
  resolveDebugToolSelectors,
} from '../../utils/debugTools/debugToolManifestUtils';
import type { DebugToolsManifest } from '../../utils/debugTools/debugToolVersionUtils';

// The shipped manifest, so a renamed tool or a lost `runners:` entry fails here
// before an agent is told a board's runner has no tool.
const SHIPPED: DebugToolsManifest = yaml.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../scripts/runners/debug-tools.yml'), 'utf8'));

const SMALL: DebugToolsManifest = {
  aliases: [{ alias: 'probe', default: 'probe-b', ['version-command']: 'probe --version' }],
  debug_tools: [
    { tool: 'probe-a', alias: 'probe', version: '1.0' },
    { tool: 'probe-b', alias: 'probe', version: '2.0' },
    { tool: 'flasher', version: '3.0', runners: ['vendor_flash'] },
  ] as ManifestDebugTool[],
};

describe('debugToolManifestUtils', () => {
  it('maps a runner to the manifest tool that serves it, from the shipped manifest', () => {
    assert.deepEqual(findDebugToolIdsForRunner(SHIPPED, 'openocd'), ['openocd'], 'an alias row follows its selected variant');
    assert.deepEqual(findDebugToolIdsForRunner(SHIPPED, 'jlink'), ['jlink']);
    assert.deepEqual(findDebugToolIdsForRunner(SHIPPED, 'pyocd'), ['pyocd']);
    assert.deepEqual(findDebugToolIdsForRunner(SHIPPED, 'stlink_gdbserver'), ['stm32cubeclt']);
    assert.deepEqual(findDebugToolIdsForRunner(SHIPPED, 'silabs_commander'), ['simplicity_commander']);
    assert.deepEqual(findDebugToolIdsForRunner(SHIPPED, 'qemu'), [], 'a runner the workbench does not install maps to nothing');
  });

  it('resolves tool ids, aliases and runner names, and returns the unknown ones', () => {
    const { ids, unknown } = resolveDebugToolSelectors(SHIPPED, ['openocd-esp32', 'openocd', 'stlink_gdbserver', 'nope', 'jlink']);
    assert.deepEqual(ids.sort(), ['jlink', 'openocd', 'openocd-esp32', 'stm32cubeclt']);
    assert.deepEqual(unknown, ['nope']);
  });

  it('lists every accepted name once, runner names included', () => {
    const names = listDebugToolSelectors(SHIPPED);
    for (const expected of ['openocd', 'openocd-zephyr', 'jlink', 'stm32cubeclt', 'stlink_gdbserver', 'silabs_commander']) {
      assert.ok(names.includes(expected), `${expected} should be selectable`);
    }
    assert.equal(names.length, new Set(names).size);
    assert.deepEqual(names, [...names].sort());
  });

  it('picks an alias default from env.yml, then the manifest, then the first variant', () => {
    assert.equal(getDefaultToolIdForAlias(SMALL, undefined, 'probe'), 'probe-b');
    assert.equal(getDefaultToolIdForAlias(SMALL, { runners: { probe: { default: 'probe-a' } } }, 'probe'), 'probe-a');
    const noDefault: DebugToolsManifest = { ...SMALL, aliases: [{ alias: 'probe' }] };
    assert.equal(getDefaultToolIdForAlias(noDefault, undefined, 'probe'), 'probe-a');
  });

  it('probes an alias with its own command and the selected variant reference version', () => {
    const probe = buildAliasProbeTool(SMALL, { runners: { probe: { default: 'probe-a' } } }, 'probe');
    assert.equal(probe?.tool, 'probe');
    assert.equal(probe?.version, '1.0');
    assert.equal(probe?.['version-command'], 'probe --version');
    assert.equal(buildAliasProbeTool(SMALL, undefined, 'missing'), undefined);
  });

  it('maps runner names declared under `runners` on a tool', () => {
    assert.deepEqual(findDebugToolIdsForRunner(SMALL, 'vendor_flash'), ['flasher']);
    assert.deepEqual(resolveDebugToolSelectors(SMALL, ['vendor_flash']).ids, ['flasher']);
  });

  it('tells whether the panel can install a tool on each OS', () => {
    const tool = { os: { linux: {}, darwin: {} } };
    assert.equal(isDebugToolCompatible(tool, 'linux'), true);
    assert.equal(isDebugToolCompatible(tool, 'darwin'), true);
    assert.equal(isDebugToolCompatible(tool, 'win32'), false);
    assert.equal(isDebugToolCompatible({}, 'linux'), false, 'no os entry: not installable from the panel');
  });

  it('reads only a non-empty configured path', () => {
    assert.equal(getConfiguredDebugToolPath({ runners: { jlink: { path: '/opt/jlink' } } }, 'jlink'), '/opt/jlink');
    assert.equal(getConfiguredDebugToolPath({ runners: { jlink: { path: '' } } }, 'jlink'), undefined);
    assert.equal(getConfiguredDebugToolPath(undefined, 'jlink'), undefined);
  });
});
