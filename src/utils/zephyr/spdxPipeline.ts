// The SPDX SBOM pipeline of one build configuration: delete the build folder,
// `west spdx --init`, a west build with CONFIG_BUILD_OUTPUT_META, then
// `west spdx` (2.3 or 3.0). The Applications view command and the agent's
// analyze tool both run it; each passes its own way of running a step and of
// deleting the folder, and keeps its own messages.

import * as path from 'path';
import type { ZephyrApplication } from '../../models/ZephyrApplication';
import type { ZephyrBuildConfig } from '../../models/ZephyrBuildConfig';
import { westSpdxGenerateSpec, westSpdxInitSpec, WestProjectTaskSpec } from '../../commands/WestCommands';
import { resolveBuildDirToDelete } from './buildConfigRules';

export type SpdxVersion = '2.3' | '3.0';

/** One step of the pipeline, as the task buildWestProjectTask would build for it. */
export interface SpdxStep {
  kind: 'init' | 'build' | 'generate';
  spec: WestProjectTaskSpec;
}

/**
 * Runs one step and resolves with its exit code, or undefined when the step
 * could not say (no task for it, as the UI's west*Command functions treat it).
 */
export type SpdxStepRunner = (step: SpdxStep) => Promise<number | undefined>;

export interface SpdxPipelineOptions {
  /**
   * 'config' deletes only <app>/build/<config>; 'app' deletes the whole
   * <app>/build, as the command does from an application node.
   */
  deleteScope: 'config' | 'app';
  /** Also describe the Zephyr SDK. Undefined follows the sbomTotal.includeSdk setting. */
  includeSdk?: boolean;
  /** Delete the build folder, so the SPDX init applies to a fresh configure. */
  deleteBuildDir(dir: string): Promise<void>;
}

export type SpdxPipelineResult =
  | { ok: true; buildDir: string; spdxDir: string }
  | { ok: false; step: 'build'; exitCode: number };

/**
 * A failure the caller reports: 'resolve' when the build folder cannot be
 * deleted safely (nothing was touched), 'step' when a west step failed. Any
 * other error, such as one deleting the folder, is thrown as it is.
 */
export class SpdxPipelineError extends Error {
  constructor(readonly phase: 'resolve' | 'step', readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = 'SpdxPipelineError';
  }
}

/** The west arguments of the build step: CONFIG_BUILD_OUTPUT_META=y after the CMake separator. */
export function appendBuildOutputMeta(input: string): string {
  if (input) {
    if (input.includes('CONFIG_BUILD_OUTPUT_META=y')) {
      return input;
    } else if (input.includes('--')) {
      return `${input} -DCONFIG_BUILD_OUTPUT_META=y`;
    } else {
      return `${input} -- -DCONFIG_BUILD_OUTPUT_META=y`;
    }
  } else {
    return '-- -DCONFIG_BUILD_OUTPUT_META=y';
  }
}

/** The generate step of `version`, with the SDK described or not when the caller says so. */
export function spdxGenerateSpec(config: ZephyrBuildConfig, version: SpdxVersion, includeSdk?: boolean): WestProjectTaskSpec {
  const spec = westSpdxGenerateSpec(config, version);
  return includeSdk === undefined ? spec : { ...spec, options: includeSdk ? { extraArgs: ['--include-sdk'] } : {} };
}

/**
 * Run the pipeline for `config`. The configuration is made the active one in
 * memory while the steps run, and put back afterwards.
 */
export async function runSpdxPipeline(
  app: ZephyrApplication,
  config: ZephyrBuildConfig,
  version: SpdxVersion,
  runStep: SpdxStepRunner,
  options: SpdxPipelineOptions,
): Promise<SpdxPipelineResult> {
  let buildDirToDelete: string;
  try {
    buildDirToDelete = resolveBuildDirToDelete(app.appRootPath, options.deleteScope === 'config' ? config.name : undefined);
  } catch (error) {
    throw new SpdxPipelineError('resolve', error);
  }

  await options.deleteBuildDir(buildDirToDelete);

  const extraArgs = appendBuildOutputMeta(config.westArgs);
  const previousActiveStates = app.buildConfigs.map(candidate => ({
    config: candidate,
    active: candidate.active,
  }));

  try {
    const initCode = await runStep({ kind: 'init', spec: westSpdxInitSpec(config) });
    if (typeof initCode === 'number' && initCode !== 0) {
      throw new Error(`'west spdx --init' failed with exit code ${initCode}. See the terminal output.`);
    }

    for (const candidate of app.buildConfigs) {
      candidate.active = candidate.name === config.name;
    }

    const buildCode = await runStep({
      kind: 'build',
      spec: { name: 'West Build', configName: config.name, options: { rawWestArgsOverride: extraArgs } },
    });
    if (typeof buildCode === 'number' && buildCode !== 0) {
      return { ok: false, step: 'build', exitCode: buildCode };
    }

    const generateCode = await runStep({ kind: 'generate', spec: spdxGenerateSpec(config, version, options.includeSdk) });
    if (typeof generateCode === 'number' && generateCode !== 0) {
      throw new Error(`'west spdx' failed with exit code ${generateCode}. See the terminal output.`);
    }
    const buildDir = config.getBuildDir(app);
    return { ok: true, buildDir, spdxDir: path.join(buildDir, 'spdx') };
  } catch (error) {
    throw new SpdxPipelineError('step', error);
  } finally {
    for (const state of previousActiveStates) {
      state.config.active = state.active;
    }
  }
}
