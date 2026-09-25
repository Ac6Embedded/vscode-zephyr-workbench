import { strict as assert } from 'assert';
import { TOOL_CATALOG } from '../../../mcp/core/catalog';
import { normalizeMcpSettings } from '../../../mcp/core/settings';
import { selectTools, Toolset } from '../../../mcp/core/toolSpec';

describe('mcp/core/settings', () => {
  it('uses the defaults when nothing is set', () => {
    const { settings, problems } = normalizeMcpSettings({});
    assert.deepEqual(problems, []);
    assert.equal(settings.toolset, 'core');
    assert.equal(settings.enabled, 'auto');
    assert.equal(settings.defaultWaitSeconds, 45);
  });

  it('fails closed on a toolset it does not understand', () => {
    const { settings, problems } = normalizeMcpSettings({ toolset: 'everything' });
    assert.equal(settings.toolset, 'read-only');
    assert.equal(problems.length, 1);
  });

  it('fails closed when disabledTools is not a list of names', () => {
    const { settings } = normalizeMcpSettings({ toolset: 'full', disabledTools: 'build_app' });
    assert.equal(settings.toolset, 'read-only', 'a string must not silently disable nothing');
    assert.deepEqual(settings.disabledTools, []);
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

  it('never gives every tool for an unknown toolset, even if one slips through', () => {
    const chosen = selectTools(TOOL_CATALOG, 'bogus' as Toolset);
    assert.ok(chosen.every(tool => tool.annotations.readOnlyHint === true));
  });

  it('asks before hardware, delete, workspace and install actions by default', () => {
    assert.deepEqual(normalizeMcpSettings({}).settings.confirmActions, ['hardware', 'delete', 'workspace', 'install']);
    assert.deepEqual(normalizeMcpSettings({ confirmActions: [] }).settings.confirmActions, [], 'an empty list never asks');
  });

  it('asks before everything when confirmActions cannot be read', () => {
    const { settings, problems } = normalizeMcpSettings({ confirmActions: ['hardware', 'everything'] });
    assert.deepEqual(settings.confirmActions, ['hardware', 'delete', 'workspace', 'install', 'settings']);
    assert.equal(problems.length, 1);
  });
});
