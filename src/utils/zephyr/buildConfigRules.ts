// Rules about build configurations that the Applications view and the agent
// tools must agree on: what a name may be, which name a new configuration
// gets, when one may be deleted, and which folder deleting its build output
// removes. Free of `vscode` so every rule is unit tested.

import * as path from 'path';

/** Letters, digits, "-" and "_": the name becomes the folder build/<name>. */
export const BUILD_CONFIG_NAME_PATTERN = /^[a-zA-Z0-9-_]+$/;
export const BUILD_CONFIG_NAME_MAX_LENGTH = 64;

/**
 * Why `input` cannot name a new build configuration, or undefined when it can.
 * The duplicate check ignores case: "Debug" and "debug" would share one build
 * folder on macOS and Windows.
 */
export function validateBuildConfigName(input: string, existingNames: readonly string[]): string | undefined {
  if (input.trim() === '') {
    return 'Configuration name cannot be empty.';
  }
  if (!BUILD_CONFIG_NAME_PATTERN.test(input)) {
    return 'Configuration name can only contain letters, digits, "-", "_", and must not include spaces.';
  }
  if (input.length > BUILD_CONFIG_NAME_MAX_LENGTH) {
    return `Configuration name must be at most ${BUILD_CONFIG_NAME_MAX_LENGTH} characters.`;
  }
  const wanted = input.toLowerCase();
  if (existingNames.some(name => name.toLowerCase() === wanted)) {
    return `This "${input}" build configuration already exists`;
  }
  return undefined;
}

/** The next free "setup_N" name after the highest one in use. */
export function getNewConfigName(configs: readonly { name: string }[]): string {
  const regex = /^setup(_(\d+))?$/;

  const setupNumbers = configs
    .map(config => {
      const match = config.name.match(regex);
      if (match && match[2]) {
        return parseInt(match[2], 10);
      } else if (config.name === 'setup') {
        return 1;
      }
      return null;
    })
    .filter(num => num !== null) as number[];

  if (setupNumbers.length === 0) {
    return 'setup_2';
  }

  const latestSetupNumber = Math.max(...setupNumbers);
  return `setup_${latestSetupNumber + 1}`;
}

/** The name proposed for a new configuration: "primary" for the first one. */
export function defaultNewConfigName(configs: readonly { name: string }[]): string {
  return configs.length > 0 ? getNewConfigName(configs) : 'primary';
}

/** An application always keeps one build configuration, so the last one stays. */
export function canDeleteBuildConfig(configCount: number): boolean {
  return configCount > 1;
}

// Edits of the stored list of build configurations, as settings.json holds
// it. applicationSettings.ts reads the list, applies one of these and writes
// it back once; keeping them here keeps the rules testable without VS Code.

/** A build configuration exactly as stored in settings, portable paths and all. */
export type StoredBuildConfig = Record<string, any>;

function storedNameIs(config: StoredBuildConfig | undefined, name: string): boolean {
  return config?.name === name;
}

/** Set stored keys such as board or west-args; undefined, '' or [] removes the key. */
export function applyStoredSettingsPatch(stored: StoredBuildConfig, settings: Record<string, string | string[] | undefined>): void {
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
      delete stored[key];
    } else {
      stored[key] = value;
    }
  }
}

/**
 * Append `created` unless a configuration of that name exists, ignoring case.
 * With `active` it becomes the only active configuration; otherwise it is
 * stored inactive whatever it was copied from. Returns its index, or -1.
 */
export function appendStoredBuildConfig(configs: StoredBuildConfig[], created: StoredBuildConfig, active: boolean): number {
  const wanted = String(created.name).toLowerCase();
  if (configs.some(config => typeof config?.name === 'string' && config.name.toLowerCase() === wanted)) {
    return -1;
  }
  delete created.active;
  if (active) {
    for (const config of configs) {
      delete config.active;
    }
    created.active = 'true';
  }
  return configs.push(created) - 1;
}

/** Make `name` the only active configuration. Returns its index, or -1 when it is missing. */
export function markActiveStoredBuildConfig(configs: StoredBuildConfig[], name: string): number {
  const index = configs.findIndex(config => storedNameIs(config, name));
  if (index === -1) {
    return -1;
  }
  configs.forEach((config, position) => {
    if (position === index) {
      config.active = 'true';
    } else {
      delete config.active;
    }
  });
  return index;
}

/**
 * Remove `name`. When it was the active one, the first remaining configuration
 * becomes active, so the application always keeps one.
 */
export function removeStoredBuildConfig(
  configs: StoredBuildConfig[],
  name: string,
): { removed: boolean; elected?: { name: string; index: number } } {
  const index = configs.findIndex(config => storedNameIs(config, name));
  if (index === -1) {
    return { removed: false };
  }
  const wasActive = configs[index].active === 'true';
  configs.splice(index, 1);
  if (wasActive && configs.length > 0 && !configs.some(config => config.active === 'true')) {
    configs[0].active = 'true';
    return { removed: true, elected: { name: String(configs[0].name), index: 0 } };
  }
  return { removed: true };
}

/**
 * The folder a "delete build" removes: <app>/build/<configName>, or the whole
 * <app>/build when no configuration is given. Throws when the name is not one
 * plain folder name, because a hand-edited name such as ".." would otherwise
 * point the delete at the application itself or above it.
 */
export function resolveBuildDirToDelete(appRootPath: string, configName?: string): string {
  const buildRoot = path.join(appRootPath, 'build');
  if (configName === undefined) {
    return buildRoot;
  }
  const target = path.join(buildRoot, configName);
  const relative = path.relative(buildRoot, target);
  if (!relative || relative === '.' || relative === '..' || relative.includes('/') || relative.includes('\\')
    || path.isAbsolute(relative) || relative !== configName) {
    throw new Error(`The build configuration name "${configName}" is not a plain folder name, so its build folder cannot be deleted safely.`);
  }
  return target;
}
