import { strict as assert } from 'assert';
import { TOOL_CATALOG } from '../../../mcp/core/catalog';
import { normalizeMcpSettings } from '../../../mcp/core/settings';
import { permissionOf, selectTools } from '../../../mcp/core/toolSpec';

describe('mcp/core/settings', () => {
  it('uses the defaults when nothing is set', () => {
    const { settings, problems } = normalizeMcpSettings({});
    assert.deepEqual(problems, []);
    assert.deepEqual(settings.permissions, { preset: 'core', tools: {} });
    assert.equal(settings.enabled, 'auto');
    assert.equal(settings.defaultWaitSeconds, 45);
  });

  it('reads a preset and the choice for each tool', () => {
    const { settings, problems } = normalizeMcpSettings({ permissions: 'custom', toolPermissions: { build_app: 'ask', list_apps: 'block' } });
    assert.deepEqual(problems, []);
    assert.deepEqual(settings.permissions, { preset: 'custom', tools: { build_app: 'ask', list_apps: 'block' } });
  });

  it('serves only the read-only tools for a preset it does not understand', () => {
    const { settings, problems } = normalizeMcpSettings({ permissions: 'everything' });
    assert.equal(settings.permissions.locked, true);
    assert.equal(problems.length, 1);
    const served = selectTools(TOOL_CATALOG, settings.permissions);
    assert.ok(served.length > 0 && served.every(tool => tool.annotations.readOnlyHint === true));
  });

  it('blocks a tool whose choice it cannot read, and locks custom when the list is not a list', () => {
    const one = normalizeMcpSettings({ permissions: 'custom', toolPermissions: { build_app: 'sometimes', list_apps: 'allow' } });
    assert.deepEqual(one.settings.permissions.tools, { build_app: 'block', list_apps: 'allow' });
    assert.equal(one.problems.length, 1);
    const broken = normalizeMcpSettings({ permissions: 'custom', toolPermissions: ['build_app'] });
    assert.equal(broken.settings.permissions.locked, true, 'an array must not silently allow everything');
    // Under another preset the list is not used, so it cannot widen anything.
    assert.equal(normalizeMcpSettings({ permissions: 'core', toolPermissions: 'x' }).settings.permissions.locked, undefined);
  });

  it('rejects out of range numbers', () => {
    const { settings, problems } = normalizeMcpSettings({ port: 70000, defaultWaitSeconds: -1 });
    assert.equal(settings.port, 0);
    assert.equal(settings.defaultWaitSeconds, 45);
    assert.equal(problems.length, 2);
  });

  it('turns the integration off for an enabled value it cannot read', () => {
    for (const value of ['yes', 'Off', false, true]) {
      assert.equal(normalizeMcpSettings({ enabled: value }).settings.enabled, 'off', JSON.stringify(value));
    }
  });

  it('never gives every tool for an unknown preset, even if one slips through', () => {
    const chosen = selectTools(TOOL_CATALOG, { preset: 'bogus' as 'core', tools: {} });
    assert.ok(chosen.every(tool => permissionOf(tool, { preset: 'core', tools: {} }) !== 'block'),
      'anything unknown is read as the core preset');
  });
});
