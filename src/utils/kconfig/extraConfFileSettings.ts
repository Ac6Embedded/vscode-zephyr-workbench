// Adds a Kconfig fragment to a build configuration's EXTRA_CONF_FILE setting.
//
// The list is read from the stored settings and written back in the same step, rather
// than extended from the configuration object the caller holds: a Kconfig Manager tab
// keeps its object for as long as it is open, and an agent call runs a Kconfig check and
// may wait for a confirmation first, so writing their copy back would undo a change made
// in the meantime. updateApplicationConfig covers both the folder settings of a
// freestanding application and the entry of a west-workspace one, and reports a
// configuration or entry that is gone instead of writing nothing (or a new entry). No UI:
// the callers report the outcome in their own way.

import { ZEPHYR_ENV_SETTING_PREFIX_KEY } from '../../constants';
import type { ZephyrApplication } from '../../models/ZephyrApplication';
import type { ZephyrBuildConfig } from '../../models/ZephyrBuildConfig';
import { resolveStoredEnvValue } from '../env/zephyrEnvUtils';
import { readStoredBuildConfigs, updateApplicationConfig } from '../zephyr/applicationSettings';
import { isInExtraConfFiles, withExtraConfFile } from './extraConfFiles';

/** added: written; listed: it already was; missing: the configuration is no longer stored. */
export type AddExtraConfFileResult = 'added' | 'listed' | 'missing';

export async function addExtraConfFile(app: ZephyrApplication, config: ZephyrBuildConfig, file: string): Promise<AddExtraConfFileResult> {
  const stored = readStoredBuildConfigs(app).find(candidate => candidate?.name === config.name);
  if (!stored) {
    return 'missing';
  }
  const value = resolveStoredEnvValue('EXTRA_CONF_FILE', stored[`${ZEPHYR_ENV_SETTING_PREFIX_KEY}.EXTRA_CONF_FILE`], app.appWorkspaceFolder);
  const current = { EXTRA_CONF_FILE: typeof value === 'string' && value ? [value] : value };
  if (isInExtraConfFiles(current, file)) {
    config.envVars['EXTRA_CONF_FILE'] = current.EXTRA_CONF_FILE;
    return 'listed';
  }
  const next = withExtraConfFile(current, file);
  // No await since the read above, so the write starts from exactly the list it read.
  if (!await updateApplicationConfig(app, config.name, { env: { EXTRA_CONF_FILE: next } })) {
    return 'missing';
  }
  config.envVars['EXTRA_CONF_FILE'] = next;
  return 'added';
}
