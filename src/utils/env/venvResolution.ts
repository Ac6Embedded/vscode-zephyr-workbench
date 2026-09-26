import { ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY } from "../../constants";
import { ConfigurationScope, getConfiguredVenvPath, getConfiguredWorkbenchPath } from "../execUtils";
import { findManagedVenvDirectory, getManagedVenvWestPath } from "../installUtils";
import { fileExists, getInternalDirRealPath } from "../utils";
import { loadEnvYamlState } from "./envYamlFileUtils";

// The one place that knows which Python virtual environment an application's
// commands run in. Kept out of extension.ts so the public API and the
// environment check cannot drift apart.

export type VenvSource = 'application' | 'setting' | 'env-yml' | 'managed-default' | 'none';

export interface EffectiveVenv {
  path?: string;
  source: VenvSource;
}

/** env.yml python.global_venv_path: the venv the sourced env script activates by default. */
export function readEnvYamlGlobalVenvPath(): string | undefined {
  const value = loadEnvYamlState().data?.python?.global_venv_path;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Resolve the venv, most specific first: the application's own venv (its
 * per-app venv.path, else its west workspace's venv), then the venv.path
 * setting at `scope`, then the zinstaller-managed `<.zinstaller>/.venv`.
 *
 * `followEnvScript` answers what a build really activates instead. Builds
 * ignore an SPDX-only venv.path (getConfiguredVenvPath), and with no
 * PYTHON_VENV_PATH the sourced env script falls back to env.yml's
 * global_venv_path, which is not always the managed default. The public API
 * keeps the historical answer, so it leaves this off.
 */
export function resolveEffectiveVenv(
  app?: { venvPath?: string },
  scope?: ConfigurationScope,
  options: { followEnvScript?: boolean } = {},
): EffectiveVenv {
  if (app?.venvPath) {
    return { path: app.venvPath, source: 'application' };
  }
  const configured = options.followEnvScript
    ? getConfiguredVenvPath(scope)
    : getConfiguredWorkbenchPath(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY, scope);
  if (configured) {
    return { path: configured, source: 'setting' };
  }
  if (options.followEnvScript) {
    const fromEnvYaml = readEnvYamlGlobalVenvPath();
    if (fromEnvYaml) {
      return { path: fromEnvYaml, source: 'env-yml' };
    }
  }
  // `venv.path` is usually empty on zinstaller setups (the venv is recorded in
  // env.yml, which only the sourced env.sh reads), so without this fallback
  // every headless consumer gets nothing even though a good venv exists.
  const managed = findManagedVenvDirectory(getInternalDirRealPath(), '.venv');
  return managed ? { path: managed, source: 'managed-default' } : { source: 'none' };
}

export interface BuildVenvStatus {
  venv: EffectiveVenv;
  exists: boolean;
  /** Where west lives in that venv, when the venv exists. */
  westPath?: string;
  westFound: boolean;
}

/**
 * The venv a build of `app` (or, without one, any env-sourced command)
 * activates, and whether west is in it. Files only, so get_status can call it
 * as cheaply as the environment check, and the two agree.
 */
export function resolveBuildVenv(app?: { venvPath?: string }, scope?: ConfigurationScope): BuildVenvStatus {
  const venv = resolveEffectiveVenv(app, scope, { followEnvScript: true });
  const exists = !!venv.path && fileExists(venv.path);
  const westPath = venv.path && exists ? getManagedVenvWestPath(venv.path) : undefined;
  return { venv, exists, ...(westPath ? { westPath } : {}), westFound: !!westPath && fileExists(westPath) };
}
