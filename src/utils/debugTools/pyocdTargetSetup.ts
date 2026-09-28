import {
  checkPyOCDTarget,
  dryRunInstallPyOCDPacks,
  installPyOCDTarget,
  PyOCDExecOptions,
  updatePyOCDPack,
} from '../execUtils';

/*
 * The steps setupPyOCDTarget (debugUtils.ts) takes to give pyOCD support for
 * a target, without any of its UI: no notification, no progress toast and
 * no output channel brought to the front. A caller without a window to show
 * them in, such as an agent job, reports the outcome itself.
 */

/** The pyOCD calls the setup makes, injectable so a test runs no pyocd. */
export interface PyOCDTargetOps {
  checkTarget(name: string, venvPath?: string): Promise<boolean>;
  dryRunInstall(pattern: string, opts: PyOCDExecOptions): Promise<string[]>;
  updateIndex(opts: PyOCDExecOptions): Promise<string>;
  install(name: string, opts: PyOCDExecOptions): Promise<string>;
}

export const DEFAULT_PYOCD_TARGET_OPS: PyOCDTargetOps = {
  checkTarget: checkPyOCDTarget,
  dryRunInstall: dryRunInstallPyOCDPacks,
  updateIndex: updatePyOCDPack,
  install: installPyOCDTarget,
};

export interface PyOCDTargetSetupResult {
  target: string;
  /** pyOCD knew the target before anything was downloaded. */
  alreadyAvailable: boolean;
  /** The packs the install resolved to; empty when no pack provides the target. */
  packs: string[];
  /** The pack index was refreshed because the first lookup found no pack. */
  indexUpdated: boolean;
  /** pyOCD knows the target now. */
  available: boolean;
}

/**
 * Make sure pyOCD has target support for `target`, in the venv a debug
 * session uses. `pyocd pack install` exits 0 even when the pattern matches
 * nothing, so the packs are resolved with a dry run first, the index is
 * refreshed once when that finds none, and the target is checked again after
 * the install. Throws what pyocd throws, including a CancellationError.
 */
export async function installPyOCDTargetSupport(
  target: string,
  opts: Omit<PyOCDExecOptions, 'show' | 'clear'> & { venvPath?: string },
  ops: PyOCDTargetOps = DEFAULT_PYOCD_TARGET_OPS,
): Promise<PyOCDTargetSetupResult> {
  // Never reveal the output channel: nobody may be looking at this window.
  const execOpts: PyOCDExecOptions = { ...opts, show: false };
  if (await ops.checkTarget(target, opts.venvPath)) {
    return { target, alreadyAvailable: true, packs: [], indexUpdated: false, available: true };
  }
  let indexUpdated = false;
  let packs = await ops.dryRunInstall(target, execOpts);
  if (packs.length === 0) {
    // The local pack index may be stale: refresh it once and look again.
    await ops.updateIndex(execOpts);
    indexUpdated = true;
    packs = await ops.dryRunInstall(target, execOpts);
  }
  if (packs.length === 0) {
    return { target, alreadyAvailable: false, packs, indexUpdated, available: false };
  }
  await ops.install(target, execOpts);
  return { target, alreadyAvailable: false, packs, indexUpdated, available: await ops.checkTarget(target, opts.venvPath) };
}
