// Starts a kconfig_server.py session on a build: reproduce the menuconfig environment,
// pick the interpreter, spawn the server and load the Kconfig tree.
//
// Shared by the Kconfig Manager panel and the MCP server, which must not open any UI,
// so this module is free of any `vscode` dependency (fs/path only) and reports every
// failure as a KconfigServerError with a code the caller can act on.

import * as fs from 'fs';
import * as path from 'path';
import { extractKconfigLaunchSpec, isExtractError, type KconfigLaunchSpec } from './kconfigEnvExtractor';
import { KconfigServerClient, KconfigServerError, type KconfigServerOptions } from './kconfigServerClient';

/** How long the full Kconfig parse may take: slow disks and Windows need the margin. */
export const KCONFIG_INIT_TIMEOUT_MS = 120000;

export interface StartKconfigServerOptions {
  /** The build directory, or a sysbuild image directory. */
  buildDir: string;
  /** Lets the extractor find a nested `<buildDir>/<appName>` build (see resolveInnerBuildDir). */
  appName?: string;
  /** The application's Python virtual environment, used when build.ninja names no interpreter. */
  venvPath?: string;
  serverScriptPath: string;
  log?: KconfigServerOptions['log'];
  onDirty?: KconfigServerOptions['onDirty'];
  onWarnings?: KconfigServerOptions['onWarnings'];
  onExit?: KconfigServerOptions['onExit'];
  /**
   * Called once the client exists and before it starts, so the owner holds it (and can
   * dispose of it) even when starting or loading the tree fails.
   */
  onCreated?: (client: KconfigServerClient, spec: KconfigLaunchSpec) => void;
}

/** The interpreter inside a virtual environment, if there is one. */
export function venvPythonPath(venvPath?: string): string | undefined {
  if (!venvPath) { return undefined; }
  const candidate = process.platform === 'win32'
    ? path.join(venvPath, 'Scripts', 'python.exe')
    : path.join(venvPath, 'bin', 'python');
  return fs.existsSync(candidate) ? candidate : undefined;
}

/**
 * kconfiglib reports in-tree Kconfig files relative to ZEPHYR_BASE. Make such a path
 * absolute when the file is there; anything else is returned unchanged.
 */
export function resolveKconfigFile(file: string, zephyrBase: string): string {
  if (!file || path.isAbsolute(file) || !zephyrBase) { return file; }
  const candidate = path.join(zephyrBase, file);
  return fs.existsSync(candidate) ? candidate : file;
}

/**
 * Spawn the server for a build and load its Kconfig tree. Rejects with a
 * KconfigServerError: `env-unavailable` when the menuconfig environment cannot be
 * reproduced, `no-python` when no interpreter is known, `fallback-env-failed` when the
 * tree does not load from the CMake cache reconstruction, or the client's own codes.
 */
export async function startKconfigServer(o: StartKconfigServerOptions): Promise<{ client: KconfigServerClient; spec: KconfigLaunchSpec }> {
  const spec = extractKconfigLaunchSpec(o.buildDir, o.appName);
  if (isExtractError(spec)) {
    throw new KconfigServerError(`Could not reproduce the Kconfig environment: ${spec.error}`, 'env-unavailable');
  }
  // build.ninja carries the authoritative interpreter; fall back to the app venv.
  if (!spec.python) {
    const venvPython = venvPythonPath(o.venvPath);
    if (!venvPython) {
      throw new KconfigServerError('No Python interpreter found (build.ninja and app venv both unavailable).', 'no-python');
    }
    spec.python = venvPython;
  }
  o.log?.(`[server] python: ${spec.python} (env source: ${spec.source}, config: ${spec.configPath})`);
  if (spec.fallbackReason) {
    o.log?.(`[server] build.ninja not used: ${spec.fallbackReason}`);
  }

  const client = new KconfigServerClient({
    spec,
    serverScriptPath: o.serverScriptPath,
    log: o.log,
    onDirty: o.onDirty,
    onWarnings: o.onWarnings,
    onExit: o.onExit,
  });
  o.onCreated?.(client, spec);
  try {
    await client.start();
    await client.call('init', {}, KCONFIG_INIT_TIMEOUT_MS);
  } catch (e) {
    // The CMakeCache fallback cannot reproduce the per-module ZEPHYR_<NAME>_KCONFIG
    // variables, so kconfiglib fails on `osource "$(ZEPHYR_<NAME>_KCONFIG)"` with an
    // error that says nothing about the real cause. Name it.
    if (spec.source === 'fallback') {
      const why = spec.fallbackReason ? ` (${spec.fallbackReason})` : '';
      throw new KconfigServerError(
        `${e instanceof Error ? e.message : String(e)}\n\n` +
        `The Kconfig environment had to be reconstructed from the CMake cache because ` +
        `build.ninja could not be used${why}. That reconstruction cannot supply the ` +
        `per-module Kconfig paths, which is the likely cause of the error above. ` +
        `Re-run the CMake configure stage, then Retry.`,
        'fallback-env-failed',
      );
    }
    throw e;
  }
  return { client, spec };
}
