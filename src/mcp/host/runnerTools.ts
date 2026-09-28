// What manage_runners and the runner part of list_runners do to the machine:
// the runner installers, the graphical sudo prompt, the PowerShell policy and
// pyocd. Gathered on one object so a test with no installer, no sudo and no
// pyocd can stand in for each of them. Production always uses these.

import { detectGuiSudoAvailability } from '../../utils/environmentUtils';
import {
  cleanPyOCDPacks, getConfiguredVenvPath, getInstalledPyOCDPacks, getPyOCDTargetsJson, getPyOCDVersion, hasPyOCDPackIndex,
  dryRunInstallPyOCDPacks, updatePyOCDPack,
} from '../../utils/execUtils';
import { collectEnvironmentSettings } from '../../utils/hostToolsStatusCollector';
import {
  buildDebugToolsInstallTask, planHostDebugToolsInstall, refreshRunnersAfterInstall, runElevatedCommandHeadless,
} from '../../utils/installUtils';
import { allowPowershellScriptsForCurrentUser } from '../../utils/powershellUtils';
import { DEFAULT_PYOCD_TARGET_OPS } from '../../utils/debugTools/pyocdTargetSetup';
import { runCapturedTask, runLoggedStep } from './taskRunner';

/** Bounds each PowerShell policy call, so a stuck PowerShell cannot hold the job. */
const POWERSHELL_POLICY_TIMEOUT_MS = 30000;

export const runnerTools = {
  /** The OS the tools are installed for. */
  platform: (): NodeJS.Platform => process.platform,
  /** Whether a graphical sudo prompt can be shown, for tools that need root on Linux and macOS. */
  guiSudo: (platform: NodeJS.Platform) => detectGuiSudoAvailability(platform),
  /** Whether version commands can run through the env-sourced shell. */
  envSourcedReady: (): boolean => collectEnvironmentSettings().envSourcedReady,
  /** The silent part of the PowerShell policy fix the Install Runners panel makes. */
  allowPowershellScripts: () => allowPowershellScriptsForCurrentUser(POWERSHELL_POLICY_TIMEOUT_MS),
  planInstall: planHostDebugToolsInstall,
  installTask: buildDebugToolsInstallTask,
  runTask: runCapturedTask,
  runStep: runLoggedStep,
  elevate: runElevatedCommandHeadless,
  afterInstall: refreshRunnersAfterInstall,
  /** The global venv, the one the installers' pip writes to. */
  globalVenv: (): string | undefined => getConfiguredVenvPath(),
  pyocd: {
    version: getPyOCDVersion,
    hasIndex: hasPyOCDPackIndex,
    installedPacks: getInstalledPyOCDPacks,
    targets: (venvPath?: string) => getPyOCDTargetsJson(false, venvPath),
    dryRunInstall: dryRunInstallPyOCDPacks,
    updateIndex: updatePyOCDPack,
    clean: cleanPyOCDPacks,
    /** What the board target install runs, through installPyOCDTargetSupport. */
    targetOps: DEFAULT_PYOCD_TARGET_OPS,
  },
};
