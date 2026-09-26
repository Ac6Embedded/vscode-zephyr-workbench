// What the environment check concludes from the facts it gathered: whether
// the machine can build, and each problem with the Zephyr Workbench command
// that fixes it. Pure so it is unit tested; the host gathers the facts.
//
// Every fix names a command the user can run from the palette, because the
// agent cannot install anything itself and must hand the step to the user.

import * as path from 'path';
import { normalizeForCompare } from './argSafety';

export type EnvironmentProblemCode =
  | 'HOST_TOOLS_MISSING'
  | 'HOST_TOOLS_INCOMPLETE'
  | 'HOST_TOOLS_OUTDATED'
  | 'ENV_SCRIPT_NOT_SET'
  | 'ENV_SCRIPT_MISSING'
  | 'VENV_SETTING_INVALID'
  | 'VENV_MISSING'
  | 'WEST_MISSING'
  | 'PYTHON_TOO_OLD'
  | 'NO_SDK'
  | 'TOOLCHAIN_MISSING'
  | 'SDK_INCOMPATIBLE'
  | 'RUNNER_TOOL_MISSING'
  | 'RUNNER_TOOL_OUTDATED'
  | 'POWERSHELL_POLICY'
  | 'SHELL_SUBSTITUTED'
  | 'HOMEBREW_MISSING'
  | 'XCODE_CLT_MISSING';

export interface EnvironmentProblem {
  code: EnvironmentProblemCode;
  severity: 'error' | 'warning';
  message: string;
  /** What the user should do, naming the Zephyr Workbench command where one exists. */
  fix: string;
}

export interface EnvironmentFacts {
  platform: string;
  hostTools: {
    internalDir: string;
    installed: boolean;
    complete: boolean;
    envFileExists: boolean;
    stampExists: boolean;
    zinstallerVersion?: string;
    zinstallerMinimum: string;
    zinstallerUpToDate: boolean;
    /** Labels of the parts known to be missing. */
    missingParts: string[];
    /** Present only when Homebrew was probed. */
    homebrewOk?: boolean;
    /** True when the macOS Command Line Tools are known to be missing. */
    developerToolsMissing?: boolean;
    /** Present only when the PowerShell policy was read. */
    powershellPolicy?: { current: string; allowed: boolean };
  };
  settings: {
    envScript?: string;
    envScriptExists: boolean;
    venvSetting?: string;
    venvSettingOk: boolean;
    shellSubstitutedFrom?: string;
    shellUsed: string;
  };
  venv: {
    path?: string;
    source: string;
    /**
     * For an application venv (source 'application'): its west workspace's
     * dedicated venv, or the application's own. Unset when unknown.
     */
    owner?: 'west_workspace' | 'application';
    exists: boolean;
    version?: string;
    tooOld?: boolean;
    minimum: string;
  };
  west: { found: boolean; path?: string };
  sdks: {
    count: number;
    /** Set when an application was checked. */
    application?: ApplicationToolchain & {
      toolchainVariant: string;
      compat?: { status: string; message?: string };
    };
  };
  /** The runners an application will use, with the manifest tools that serve them. */
  runners?: Array<{
    runner: string;
    role: 'configured' | 'default_flash' | 'default_debug';
    toolIds: string[];
    toolNames: string[];
    installed: boolean | null;
    updateAvailable: boolean;
  }>;
}

const command = (name: string) => `the Zephyr Workbench command "${name}"`;
const run = (name: string) => `Run ${command(name)}`;
const sentence = (clause: string) => `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;

/**
 * How to rebuild the venv builds use, as a clause to finish a fix with.
 * "Reinstall VENV" rebuilds only the host tools venv (<internal dir>/.venv),
 * so a west workspace's venv, an application's own venv or a custom
 * venv.path needs its own step, or the next check reports the same problem.
 */
function venvRebuildStep(venv: EnvironmentFacts['venv'], internalDir: string): string {
  const reinstall = `run ${command('Reinstall VENV')}`;
  const managed = internalDir ? path.join(internalDir, '.venv') : undefined;
  // Whatever pointed at it, the host tools venv is the one Reinstall VENV rebuilds.
  if (!venv.path || (managed && normalizeForCompare(venv.path) === normalizeForCompare(managed))) {
    return reinstall;
  }
  if (venv.source === 'application') {
    const workspace = `recreate it with ${command('Manage venv: Create/Recreate Dedicated venv')} on the west workspace`;
    const own = `recreate it with ${command('Create local Python Virtual Environment')} on the application, or point the application at another venv with "Set local Python Virtual Environment"`;
    if (venv.owner === 'west_workspace') {
      return workspace;
    }
    if (venv.owner === 'application') {
      return own;
    }
    return `if it is the west workspace's venv, ${workspace}; if it is the application's own, ${own}`;
  }
  if (venv.source === 'setting') {
    return `recreate the venv zephyr-workbench.venv.path points at (${venv.path}), or clear or correct that setting`;
  }
  return reinstall;
}

export interface ReadinessFlags {
  hostToolsComplete: boolean;
  envScriptOk: boolean;
  venvSettingOk: boolean;
  westFound: boolean;
  toolchainOk: boolean;
}

/**
 * Whether a build can start. The one rule get_status and check_environment
 * share, so the quick answer and the detailed one never disagree.
 */
export function isReadyToBuild(flags: ReadinessFlags): boolean {
  return flags.hostToolsComplete && flags.envScriptOk && flags.venvSettingOk && flags.westFound && flags.toolchainOk;
}

/** What an application needs from the toolchains, when an answer covers one. */
export interface ApplicationToolchain {
  needsSdk: boolean;
  /** False when the variant's own toolchain (Arm GNU, IAR) is selected but not registered. */
  toolchainResolved: boolean;
}

/** A Zephyr SDK is available, or the application's own toolchain resolves when it needs none. */
function toolchainOk(sdkCount: number, application?: ApplicationToolchain): boolean {
  if (!application) {
    return sdkCount > 0;
  }
  return application.toolchainResolved && (!application.needsSdk || sdkCount > 0);
}

/** No Zephyr SDK is registered and one is needed: the NO_SDK rule, shared with get_status. */
export function isSdkMissing(sdkCount: number, application?: ApplicationToolchain): boolean {
  return sdkCount === 0 && (!application || application.needsSdk);
}

/** What get_status reads about the environment: files and settings only, nothing run. */
export interface QuickEnvironmentFacts {
  hostToolsInstalled: boolean;
  hostToolsComplete: boolean;
  zinstallerUpToDate: boolean;
  envScriptOk: boolean;
  venvSettingOk: boolean;
  /** The venv builds activate exists. */
  venvExists: boolean;
  westFound: boolean;
  sdkCount: number;
  /** Set when the answer covers an application, as check_environment's does. */
  application?: ApplicationToolchain;
}

export interface QuickEnvironmentSummary {
  environment: {
    ready: boolean;
    host_tools_installed: boolean;
    host_tools_complete: boolean;
    env_script_ok: boolean;
    venv_ok: boolean;
    zinstaller_up_to_date: boolean;
  };
  /** The environment's share of get_status next_steps, first things first. */
  nextSteps: string[];
}

/**
 * get_status's environment answer. It applies the same readiness rule as
 * check_environment to facts read for the same application, so the quick
 * answer never contradicts the detailed one, and it sends the agent to
 * check_environment for the detail.
 */
export function summarizeQuickEnvironment(facts: QuickEnvironmentFacts): QuickEnvironmentSummary {
  const ready = isReadyToBuild({
    hostToolsComplete: facts.hostToolsComplete,
    envScriptOk: facts.envScriptOk,
    venvSettingOk: facts.venvSettingOk,
    westFound: facts.westFound,
    toolchainOk: toolchainOk(facts.sdkCount, facts.application),
  });
  const nextSteps: string[] = [];
  if (!facts.hostToolsInstalled) {
    nextSteps.push('Host tools are not installed. Run the Zephyr Workbench command "Install Host Tools".');
  } else if (!facts.hostToolsComplete) {
    // The tools folder exists but the installer never wrote its stamp: a
    // step failed or was interrupted, so a plain rerun is the fix.
    nextSteps.push('The host tools install did not finish. Run the Zephyr Workbench command "Install Host Tools" again.');
  }
  if (!ready) {
    nextSteps.push('Call check_environment to see exactly what is missing and the command that fixes each problem.');
  }
  return {
    environment: {
      ready,
      host_tools_installed: facts.hostToolsInstalled,
      host_tools_complete: facts.hostToolsComplete,
      env_script_ok: facts.envScriptOk,
      venv_ok: facts.venvSettingOk && facts.venvExists && facts.westFound,
      zinstaller_up_to_date: facts.zinstallerUpToDate,
    },
    nextSteps,
  };
}

/** True when a build can start: host tools complete, settings valid, west present, and a toolchain. */
export function isEnvironmentReady(facts: EnvironmentFacts): boolean {
  return isReadyToBuild({
    hostToolsComplete: facts.hostTools.complete,
    envScriptOk: !!facts.settings.envScript && facts.settings.envScriptExists,
    venvSettingOk: facts.settings.venvSettingOk,
    westFound: facts.west.found,
    toolchainOk: toolchainOk(facts.sdks.count, facts.sdks.application),
  });
}

export function deriveEnvironmentProblems(facts: EnvironmentFacts): EnvironmentProblem[] {
  const problems: EnvironmentProblem[] = [];
  const add = (code: EnvironmentProblemCode, severity: 'error' | 'warning', message: string, fix: string) =>
    problems.push({ code, severity, message, fix });
  const host = facts.hostTools;

  // First, because Homebrew and the host tools installer both need them.
  if (host.developerToolsMissing) {
    add('XCODE_CLT_MISSING', host.complete ? 'warning' : 'error',
      'The macOS Command Line Tools are not installed. Homebrew and the host tools installer need them, and without them python3, git and make in /usr/bin do not run.',
      host.complete
        ? 'Install them by running xcode-select --install in a terminal.'
        : `Install them by running xcode-select --install in a terminal, then run ${command('Install Host Tools')}.`);
  }
  if (!host.installed) {
    add('HOST_TOOLS_MISSING', 'error',
      `The Zephyr host tools are not installed in ${host.internalDir}.`,
      `${run('Install Host Tools')}.`);
  } else if (!host.complete || host.missingParts.length > 0) {
    const gaps = [
      ...(!host.envFileExists ? ['the environment script'] : []),
      ...(!host.stampExists ? ['the completion stamp (a step failed or was interrupted)'] : []),
      ...(host.missingParts.length > 0 ? [`these parts: ${host.missingParts.join(', ')}`] : []),
    ];
    add('HOST_TOOLS_INCOMPLETE', host.complete ? 'warning' : 'error',
      `The host tools install is incomplete: missing ${gaps.join('; ')}.`,
      `${run('Install Host Tools')} again, or "Install Host Tools (Advanced)" to repair single parts.`);
  }
  if (host.installed && host.zinstallerVersion && !host.zinstallerUpToDate) {
    add('HOST_TOOLS_OUTDATED', 'warning',
      `The host tools were installed by zinstaller ${host.zinstallerVersion}, older than the ${host.zinstallerMinimum} this version of the workbench needs.`,
      `${run('Host Tools Manager')} and reinstall the host tools from it.`);
  }
  if (host.homebrewOk === false) {
    add('HOMEBREW_MISSING', host.complete ? 'warning' : 'error',
      'Homebrew was not found. On macOS the host tools installer uses it for CMake, Ninja, dtc and the other build tools.',
      `Install Homebrew from https://brew.sh, then run ${command('Install Host Tools')}.`);
  }
  if (host.powershellPolicy && !host.powershellPolicy.allowed) {
    add('POWERSHELL_POLICY', 'warning',
      `PowerShell script execution is "${host.powershellPolicy.current}" for the current user, so the installer and env.ps1 may be refused.`,
      `${run('Verify Host Tools')}, which sets the policy to RemoteSigned for the current user.`);
  }

  const settings = facts.settings;
  if (!settings.envScript) {
    add('ENV_SCRIPT_NOT_SET', 'error',
      'zephyr-workbench.pathToEnvScript is empty, so builds, flashing and runner probes cannot start.',
      `${run('Install Host Tools')}, which sets it, or point the setting at the env script of an existing install.`);
  } else if (!settings.envScriptExists) {
    add('ENV_SCRIPT_MISSING', 'error',
      `zephyr-workbench.pathToEnvScript points at "${settings.envScript}", which does not exist.`,
      `${run('Install Host Tools')} to recreate it, or correct the setting.`);
  }
  if (!settings.venvSettingOk) {
    add('VENV_SETTING_INVALID', 'error',
      `zephyr-workbench.venv.path points at "${settings.venvSetting ?? ''}", which does not exist, so every command that sources the environment is refused.`,
      `${run('Reinstall VENV')}, or clear or correct zephyr-workbench.venv.path.`);
  }
  if (settings.shellSubstitutedFrom) {
    add('SHELL_SUBSTITUTED', 'warning',
      `The terminal shell ${settings.shellSubstitutedFrom} cannot run the generated env script, so commands run in ${settings.shellUsed} instead.`,
      'Nothing is required. To match, set the VS Code terminal default profile to bash or zsh.');
  }

  const venv = facts.venv;
  const rebuild = venvRebuildStep(venv, host.internalDir);
  // A broken venv.path already explains a missing venv; do not report it twice.
  if (settings.venvSettingOk) {
    if (!venv.path) {
      add('VENV_MISSING', 'error',
        'No Python virtual environment was found for builds.',
        `${run('Reinstall VENV')}.`);
    } else if (!venv.exists) {
      add('VENV_MISSING', 'error',
        `The Python virtual environment builds use (${venv.path}, from ${venv.source}) does not exist.`,
        sentence(rebuild));
    }
  }
  if (venv.exists && !facts.west.found) {
    add('WEST_MISSING', 'error',
      `west is not installed in the Python virtual environment ${venv.path}.`,
      sentence(rebuild));
  }
  if (venv.tooOld && venv.version) {
    add('PYTHON_TOO_OLD', 'warning',
      `The virtual environment runs Python ${venv.version}, older than the recommended ${venv.minimum}.`,
      `Install a newer Python, then ${rebuild}.`);
  }

  const app = facts.sdks.application;
  if (isSdkMissing(facts.sdks.count, app)) {
    add('NO_SDK', 'error',
      'No Zephyr SDK is registered or detected.',
      `${run('Add Toolchain')}.`);
  }
  if (app && !app.toolchainResolved) {
    add('TOOLCHAIN_MISSING', 'error',
      `The application builds with the ${app.toolchainVariant} toolchain, but the one it selects is not registered in Zephyr Workbench.`,
      `${run('Add Toolchain')} to register it, then select it with "Change Toolchain" on the application.`);
  }
  if (app?.compat && (app.compat.status === 'incompatible' || app.compat.status === 'partial')) {
    add('SDK_INCOMPATIBLE', 'warning',
      app.compat.message ?? `The application's Zephyr SDK is ${app.compat.status} with its Zephyr version.`,
      `Install the recommended SDK with ${command('Add Toolchain')}, then select it with "Change Toolchain" on the application.`);
  }

  for (const runner of facts.runners ?? []) {
    const what = runner.role === 'default_debug' ? 'debugs' : 'flashes';
    const tools = runner.toolNames.length > 0 ? runner.toolNames.join(' or ') : runner.toolIds.join(' or ');
    if (runner.installed === false) {
      add('RUNNER_TOOL_MISSING', runner.role === 'default_debug' ? 'warning' : 'error',
        `The ${runner.runner} runner this configuration ${what} with needs ${tools}, which is not installed.`,
        `${run('Install Runners')} and install ${tools}.`);
    } else if (runner.installed === true && runner.updateAvailable) {
      add('RUNNER_TOOL_OUTDATED', 'warning',
        `${tools}, used by the ${runner.runner} runner, is older than the version the workbench installs.`,
        `${run('Install Runners')} to update it.`);
    }
  }

  // Errors first, so the first entry is the one to fix first.
  return problems.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

/** The fixes in order, without repeats, as the concrete steps to take. */
export function environmentNextSteps(problems: readonly EnvironmentProblem[]): string[] {
  return [...new Set(problems.map(problem => problem.fix))];
}
