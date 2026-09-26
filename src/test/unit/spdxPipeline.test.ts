// The SPDX pipeline the Applications view command and the analyze tool share:
// what it deletes, the steps it runs in order with their task specs, and how
// it reports a failed step, with the steps and the deletion faked.

import { strict as assert } from 'assert';
import * as path from 'path';
import type { ZephyrApplication } from '../../models/ZephyrApplication';
import type { ZephyrBuildConfig } from '../../models/ZephyrBuildConfig';
import {
  appendBuildOutputMeta, runSpdxPipeline, SpdxPipelineError, SpdxStep,
} from '../../utils/zephyr/spdxPipeline';

const appRoot = path.resolve('/work/app');

function world(westArgs = '') {
  const makeConfig = (name: string, active: boolean) => ({
    name, active, westArgs,
    getBuildDir: () => path.join(appRoot, 'build', name),
  });
  const primary = makeConfig('primary', true);
  const debug = makeConfig('debug', false);
  const app = { appRootPath: appRoot, buildConfigs: [primary, debug] };
  return { app: app as unknown as ZephyrApplication, primary: primary as unknown as ZephyrBuildConfig, debug: debug as unknown as ZephyrBuildConfig };
}

describe('SPDX pipeline', () => {
  it('deletes, then runs init, build and generate with the specs of each step', async () => {
    const { app, debug } = world();
    const events: string[] = [];
    const steps: SpdxStep[] = [];
    const activeDuringBuild: boolean[] = [];
    const result = await runSpdxPipeline(app, debug, '2.3', async step => {
      steps.push(step);
      events.push(step.kind);
      if (step.kind === 'build') {
        activeDuringBuild.push(...app.buildConfigs.map(config => config.active));
      }
      return 0;
    }, { deleteScope: 'config', deleteBuildDir: async dir => { events.push(`delete ${dir}`); } });

    assert.deepEqual(events, [`delete ${path.join(appRoot, 'build', 'debug')}`, 'init', 'build', 'generate']);
    assert.deepEqual(steps.map(step => step.spec.name), ['SPDX init', 'West Build', 'SPDX generate']);
    assert.ok(steps.every(step => step.spec.configName === 'debug'));
    assert.deepEqual(steps[1].spec.options, { rawWestArgsOverride: '-- -DCONFIG_BUILD_OUTPUT_META=y' });
    // The setting is off in the stub, so the SDK is not described.
    assert.deepEqual(steps[2].spec.options, {});
    // The configuration is active while it builds, and put back afterwards.
    assert.deepEqual(activeDuringBuild, [false, true]);
    assert.deepEqual(app.buildConfigs.map(config => config.active), [true, false]);
    assert.deepEqual(result, { ok: true, buildDir: path.join(appRoot, 'build', 'debug'), spdxDir: path.join(appRoot, 'build', 'debug', 'spdx') });
  });

  it('runs the 3.0 generator, and describes the SDK when asked', async () => {
    const { app, primary } = world();
    const steps: SpdxStep[] = [];
    await runSpdxPipeline(app, primary, '3.0', async step => { steps.push(step); return 0; },
      { deleteScope: 'config', includeSdk: true, deleteBuildDir: async () => undefined });
    assert.equal(steps[2].spec.name, 'SPDX generate 3.0');
    assert.deepEqual(steps[2].spec.options, { extraArgs: ['--include-sdk'] });
  });

  it('deletes the whole build folder from an application node', async () => {
    const { app, primary } = world();
    const deleted: string[] = [];
    await runSpdxPipeline(app, primary, '2.3', async () => 0, { deleteScope: 'app', deleteBuildDir: async dir => { deleted.push(dir); } });
    assert.deepEqual(deleted, [path.join(appRoot, 'build')]);
  });

  it('stops after a failed build and returns its exit code', async () => {
    const { app, primary } = world();
    const kinds: string[] = [];
    const result = await runSpdxPipeline(app, primary, '2.3', async step => { kinds.push(step.kind); return step.kind === 'build' ? 2 : 0; },
      { deleteScope: 'config', deleteBuildDir: async () => undefined });
    assert.deepEqual(result, { ok: false, step: 'build', exitCode: 2 });
    assert.deepEqual(kinds, ['init', 'build']);
    assert.deepEqual(app.buildConfigs.map(config => config.active), [true, false]);
  });

  it('reports a failed SPDX step with the message the commands always used', async () => {
    const { app, primary } = world();
    const error = await runSpdxPipeline(app, primary, '2.3', async step => (step.kind === 'init' ? 1 : 0),
      { deleteScope: 'config', deleteBuildDir: async () => undefined }).catch(e => e);
    assert.ok(error instanceof SpdxPipelineError);
    assert.equal(error.phase, 'step');
    assert.equal(String(error.reason), "Error: 'west spdx --init' failed with exit code 1. See the terminal output.");
  });

  it('touches nothing for a configuration name that is not a plain folder name', async () => {
    const { app, primary } = world();
    (primary as unknown as { name: string }).name = '../elsewhere';
    let deleted = false;
    const error = await runSpdxPipeline(app, primary, '2.3', async () => 0,
      { deleteScope: 'config', deleteBuildDir: async () => { deleted = true; } }).catch(e => e);
    assert.ok(error instanceof SpdxPipelineError);
    assert.equal(error.phase, 'resolve');
    assert.equal(deleted, false);
  });

  it('passes a deletion failure through as it is', async () => {
    const { app, primary } = world();
    const error = await runSpdxPipeline(app, primary, '2.3', async () => 0,
      { deleteScope: 'config', deleteBuildDir: async () => { throw new Error('in use'); } }).catch(e => e);
    assert.ok(!(error instanceof SpdxPipelineError));
    assert.equal(error.message, 'in use');
  });

  it('adds CONFIG_BUILD_OUTPUT_META after the CMake separator', () => {
    assert.equal(appendBuildOutputMeta(''), '-- -DCONFIG_BUILD_OUTPUT_META=y');
    assert.equal(appendBuildOutputMeta('-p auto'), '-p auto -- -DCONFIG_BUILD_OUTPUT_META=y');
    assert.equal(appendBuildOutputMeta('-- -DFOO=1'), '-- -DFOO=1 -DCONFIG_BUILD_OUTPUT_META=y');
    assert.equal(appendBuildOutputMeta('-- -DCONFIG_BUILD_OUTPUT_META=y'), '-- -DCONFIG_BUILD_OUTPUT_META=y');
  });
});
