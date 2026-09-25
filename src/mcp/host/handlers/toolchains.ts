// Toolchains: list_toolchains, manage_toolchain, and remove_or_delete what
// "toolchain" and "toolchain_files". Installs and deletions run as jobs
// (toolchainInstalls.ts, toolchainRemovals.ts); registering and linking are
// quick settings writes done here, under the toolchain settings lock.

import * as fs from 'fs';
import * as path from 'path';
import { findLibclangDir, IarToolchainInstallation, normalizeArmGnuTargetTriple, ArmGnuToolchainInstallation, ZephyrSdkInstallation } from '../../../models/ToolchainInstallations';
import { getWestWorkspace } from '../../../utils/utils';
import {
  getArmGnuHostTarget, inferArmGnuToolchainVersion, normalizeArmGnuToolchainRoot, registerArmGnuToolchain,
} from '../../../utils/zephyr/armGnuToolchainUtils';
import { refreshGlobalSdkDetection } from '../../../utils/zephyr/globalSdkService';
import {
  buildLlvmDownloadUrl, getRustHostTriple, isLlvmPath, llvmRootFromSelection, RUST_MINIMAL_PRESET_TARGETS,
  RUST_STABLE_CHANNEL, updateRustToolchainLink, updateRustToolchainLlvm,
} from '../../../utils/zephyr/rustToolchainUtils';
import { checkSdkCompatibility } from '../../../utils/zephyr/sdkCompatUtils';
import {
  getRecommendedGlobalInstallBases, getSdkHostTarget, isSdkV1OrLater, isWritableLocation, normalizeIarToolchainRoot,
  registerIARToolchain, registerZephyrSDK,
} from '../../../utils/zephyr/sdkUtils';
import { assertReleaseNumber } from '../../core/downloadArgs';
import { ToolContext, ToolHandler } from '../../core/toolSpec';
import { HostDeps } from './deps';
import {
  assertPlainAbsolutePath, bool, checkTypes, confirmationOf, confirmationRequired, fullToolHint, invalid,
  refuseUnexpected, requireString, str, toolchainSubject,
} from './toolchainArgs';
import { prefetch, toolchainDiscovery } from './toolchainDiscovery';
import { addToolchainComponents, installArgsOf, installToolchain, listedRust, resolveRustCToolchain } from './toolchainInstalls';
import {
  applicationsUsing, armGnuView, globalSdkSourcesByPath, iarRegistrationHasToken, iarView, readToolchainInventory, rustView,
  sameSdkPath, sdkView, storedRegistrationPath, storedSdkPath,
} from './toolchainInventory';
import { removeToolchainEntry } from './toolchainRemovals';

type Ctx = ToolContext<HostDeps>;

// list_toolchains

const INSTALL_HINT_SERVED = 'call manage_toolchain with action "install"';
const INSTALL_HINT_UNSERVED = 'install one with manage_toolchain, which only the full toolset offers, or ask the user to use the Add Toolchain wizard of Zephyr Workbench';

async function listInstalled(args: Record<string, unknown>, ctx: Ctx) {
  if (args.rescan === true) {
    // Updates the detection cache only; no setting is written.
    await refreshGlobalSdkDetection();
  }
  const inventory = await readToolchainInventory();
  const usage = Array.isArray(args.include) && args.include.includes('usage');
  const apps = usage ? await ctx.deps.services.listApplications() : undefined;
  const withUsage = <T>(view: T, entry: Parameters<typeof applicationsUsing>[0]) =>
    apps ? { ...view, used_by: applicationsUsing(entry, apps) } : view;

  const empty = inventory.sdks.length + inventory.armGnu.length + inventory.iar.length + inventory.rust.length === 0;
  const next = [
    empty
      ? `No toolchain is installed: ${fullToolHint(ctx, 'manage_toolchain', INSTALL_HINT_SERVED, INSTALL_HINT_UNSERVED)}.`
      : 'Select one for an application with configure (target "app", action "update", toolchain).',
    inventory.missing.length > 0
      ? fullToolHint(ctx, 'remove_or_delete',
        'Remove the registrations listed in missing with remove_or_delete what "toolchain".',
        'The registrations listed in missing can be removed with remove_or_delete, which only the full toolset offers, or from the Toolchains view of Zephyr Workbench (Refresh).')
      : undefined,
  ].filter(Boolean).join(' ');

  const globalSources = inventory.sdks.some(entry => entry.global) ? await globalSdkSourcesByPath() : new Map();
  return {
    zephyr_sdks: inventory.sdks.map(entry => withUsage(sdkView(entry, globalSources), entry)),
    arm_gnu: inventory.armGnu.map(entry => withUsage(armGnuView(entry), entry)),
    iar: inventory.iar.map(entry => withUsage(iarView(entry), entry)),
    rust: inventory.rust.map(entry => withUsage(rustView(entry), entry)),
    missing: inventory.missing.map(entry => ({ family: entry.family, path: entry.path, reason: entry.reason })),
    ...(args.rescan === true ? { rescanned: true } : {}),
    next,
  };
}

async function zephyrBaseFor(args: Record<string, unknown>, ctx: Ctx): Promise<{ for: string; zephyrBase: string } | undefined> {
  const appPath = str(args.app_path);
  const westWorkspace = str(args.west_workspace);
  if (appPath) {
    const app = await ctx.deps.services.resolveApp(appPath);
    if (!app.westWorkspaceRootPath) {
      throw invalid(`The application ${app.appRootPath} is not linked to a west workspace, so it has no Zephyr version to recommend an SDK for.`);
    }
    return { for: app.appRootPath, zephyrBase: getWestWorkspace(app.westWorkspaceRootPath).kernelUri.fsPath };
  }
  if (westWorkspace) {
    const { workspace } = await ctx.deps.services.resolveWestWorkspace(westWorkspace);
    return { for: workspace.rootUri.fsPath, zephyrBase: workspace.kernelUri.fsPath };
  }
  return undefined;
}

async function availableZephyrSdk(args: Record<string, unknown>, ctx: Ctx) {
  const host = getSdkHostTarget();
  if (!host) {
    throw invalid(`The Zephyr SDK is not offered for this machine (${process.platform} ${process.arch}).`, undefined, { host_unsupported: true });
  }
  // Resolved first: a wrong app_path or version should not cost a network lookup.
  const base = await zephyrBaseFor(args, ctx);
  const wanted = str(args.version);
  const number = wanted ? assertReleaseNumber(wanted, 'version') : undefined;
  if (number) {
    prefetch(() => toolchainDiscovery.sdkToolchains(number));
  }
  const versions = await toolchainDiscovery.sdkVersions();
  let version: Record<string, unknown> | undefined;
  if (number) {
    if (!versions.includes(number)) {
      throw invalid(`Zephyr SDK "${number}" is not offered.`, 'Pass one of details.offered.', { offered: versions.slice(0, 40) });
    }
    version = {
      version: number,
      toolchains: await toolchainDiscovery.sdkToolchains(number),
      llvm_available: isSdkV1OrLater(number),
    };
  }
  let recommended: Record<string, unknown> | undefined;
  if (base) {
    const verdict = checkSdkCompatibility(versions[0] ?? '0.0.0', base.zephyrBase);
    recommended = {
      for: base.for,
      ...(verdict.zephyrVersion ? { zephyr_version: verdict.zephyrVersion } : {}),
      ...(verdict.recommendedSdk ? { sdk_version: verdict.recommendedSdk } : {}),
      ...(verdict.minSdk ? { min_sdk: verdict.minSdk } : {}),
      compatible_versions: versions.filter(candidate => checkSdkCompatibility(candidate, base.zephyrBase).status === 'compatible').slice(0, 10),
    };
  }
  return {
    available: 'zephyr_sdk',
    host: `${host.os}-${host.arch}`,
    versions,
    ...(version ? { version } : {}),
    // A full SDK has every GNU toolchain; a minimal one has those chosen, and
    // LLVM from 1.0.
    sdk_types: ['full', 'minimal'],
    global_install_bases: getRecommendedGlobalInstallBases().map((folder, index) => ({
      path: folder, writable: isWritableLocation(folder), ...(index === 0 ? { default: true } : {}),
    })),
    ...(recommended ? { recommended } : {}),
    next: fullToolHint(ctx, 'manage_toolchain',
      'Install one with manage_toolchain action "install" family "zephyr_sdk".',
      'Installing needs manage_toolchain, which only the full toolset offers, or the Add Toolchain wizard of Zephyr Workbench.'),
  };
}

async function availableArmGnu(ctx: Ctx) {
  const host = getArmGnuHostTarget();
  if (!host) {
    throw invalid(`Arm publishes no Arm GNU Toolchain for this machine (${process.platform} ${process.arch}).`, undefined, { host_unsupported: true });
  }
  const catalog = await toolchainDiscovery.armGnuCatalog();
  return {
    available: 'arm_gnu',
    host: host.id,
    releases: catalog.releases.map(release => ({
      version: release.version,
      display_version: release.displayVersion,
      targets: [...new Set(catalog.assets.filter(asset => asset.version === release.version).map(asset => asset.targetTriple))],
    })),
    next: fullToolHint(ctx, 'manage_toolchain',
      'Install one with manage_toolchain action "install" family "arm_gnu".',
      'Installing needs manage_toolchain, which only the full toolset offers, or the Add Toolchain wizard of Zephyr Workbench.'),
  };
}

function prerequisitesMessage(ok: boolean): string {
  if (ok) {
    return 'The host linker Rust needs is present.';
  }
  switch (process.platform) {
    case 'win32':
      return 'The Visual Studio C++ Build Tools are missing, so rustup installs use the self-contained GNU host toolchain instead. The user can install the Build Tools from the Add Toolchain wizard of Zephyr Workbench.';
    case 'darwin':
      return 'The Xcode Command Line Tools are missing; the user installs them with xcode-select --install.';
    default:
      return 'No C compiler and linker were found; the user installs one, for example the build-essential package.';
  }
}

async function availableRust(ctx: Ctx) {
  const [rust, rustup] = await Promise.all([toolchainDiscovery.rust(), toolchainDiscovery.rustupStatus()]);
  const hostTriple = getRustHostTriple();
  return {
    available: 'rust',
    rustup_versions: rust.versions,
    standalone_versions: rust.versions.filter(version => version !== RUST_STABLE_CHANNEL),
    standalone_supported: !!hostTriple,
    ...(hostTriple ? { host_triple: hostTriple } : {}),
    targets: rust.targets.map(target => ({ target, ...(rust.targetDescriptions[target] ? { description: rust.targetDescriptions[target] } : {}) })),
    presets: { minimal: [...RUST_MINIMAL_PRESET_TARGETS], all: rust.targets },
    rustup: {
      installed: rustup.installed,
      managed: rustup.managed,
      ...(rustup.rustupPath ? { path: rustup.rustupPath } : {}),
      ...(rustup.version ? { version: rustup.version } : {}),
      ...(rustup.updateAvailable ? { update_available: rustup.latestVersion } : {}),
      managed_root: rustup.managedRootDir,
    },
    prerequisites: { ok: rustup.prereqOk, message: prerequisitesMessage(rustup.prereqOk) },
    ...(process.platform === 'win32' && !rustup.prereqOk ? { gnu_host_fallback: true } : {}),
    next: fullToolHint(ctx, 'manage_toolchain',
      rustup.installed
        ? 'Install one with manage_toolchain action "install" family "rust", with a c_toolchain list_toolchains lists.'
        : 'Install the workbench rustup with manage_toolchain action "install" family "rustup" first, then family "rust".',
      'Installing needs manage_toolchain, which only the full toolset offers, or the Add Toolchain wizard of Zephyr Workbench.'),
  };
}

async function availableLlvm(ctx: Ctx) {
  const llvm = await toolchainDiscovery.llvmVersions();
  return {
    available: 'llvm',
    host_supported: !!buildLlvmDownloadUrl(llvm.suggested[0] ?? '20.1.0'),
    versions: llvm.suggested,
    ...(llvm.all.length > llvm.suggested.length ? { all_versions: llvm.all } : {}),
    next: fullToolHint(ctx, 'manage_toolchain',
      'A Rust install downloads one (llvm_version); link one to an installed Rust toolchain with manage_toolchain action "install" family "llvm".',
      'A host LLVM is installed with a Rust toolchain, through manage_toolchain, which only the full toolset offers, or the Add Toolchain wizard of Zephyr Workbench.'),
  };
}

export const listToolchains: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  checkTypes(args, { strings: ['available', 'version', 'app_path', 'west_workspace'], booleans: ['rescan'], stringArrays: ['include'] });
  const available = str(args.available);
  if (!available) {
    refuseUnexpected(args, ['include', 'rescan'], 'list_toolchains without available');
    return listInstalled(args, ctx);
  }
  refuseUnexpected(args, available === 'zephyr_sdk' ? ['available', 'version', 'app_path', 'west_workspace'] : ['available'],
    `list_toolchains with available "${available}"`);
  if (args.app_path !== undefined && args.west_workspace !== undefined) {
    throw invalid('Pass app_path or west_workspace, not both.');
  }
  switch (available) {
    case 'zephyr_sdk': return availableZephyrSdk(args, ctx);
    case 'arm_gnu': return availableArmGnu(ctx);
    case 'rust': return availableRust(ctx);
    case 'llvm': return availableLlvm(ctx);
    default: throw invalid('available must be zephyr_sdk, arm_gnu, rust or llvm.');
  }
};

// manage_toolchain register and link

const REGISTER_FAMILIES = ['zephyr_sdk', 'arm_gnu', 'iar'] as const;
const LABEL: Record<typeof REGISTER_FAMILIES[number], string> = {
  zephyr_sdk: 'Zephyr SDK', arm_gnu: 'Arm GNU Toolchain', iar: 'IAR toolchain',
};

async function registerToolchain(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  const family = str(args.family) as typeof REGISTER_FAMILIES[number] | undefined;
  if (!family || !REGISTER_FAMILIES.includes(family)) {
    throw invalid('register takes family "zephyr_sdk", "arm_gnu" or "iar".',
      'Rust toolchains and LLVM are installed with action "install", which registers them.');
  }
  const given = assertPlainAbsolutePath(requireString(args, 'path', 'register'), 'path', { spaces: true });
  let report: Record<string, unknown>;
  let registered: () => string | undefined;
  let write: () => Promise<void>;
  let next: string;
  if (family === 'zephyr_sdk') {
    if (!ZephyrSdkInstallation.isSdkPath(given)) {
      throw invalid(`${given} is not a Zephyr SDK: it has no sdk_version file.`, 'Pass the root folder of the SDK.');
    }
    const version = fs.readFileSync(path.join(given, 'sdk_version'), 'utf8').trim();
    report = { family, path: given, version };
    registered = () => storedSdkPath(given);
    write = () => registerZephyrSDK(given);
    next = 'Select it for an application with configure (target "app", action "update", toolchain {"family": "zephyr_sdk"}).';
  } else if (family === 'arm_gnu') {
    const root = normalizeArmGnuToolchainRoot(given);
    if (!ArmGnuToolchainInstallation.isArmGnuPath(root)) {
      throw invalid(`${root} is not a valid Arm GNU Toolchain: its bin folder has no arm-none-eabi-gcc or aarch64-none-elf-gcc.`);
    }
    const targetTriple = normalizeArmGnuTargetTriple(undefined, root);
    const version = inferArmGnuToolchainVersion(root);
    report = { family, path: root, target: targetTriple, ...(version ? { version } : {}) };
    registered = () => storedRegistrationPath('arm_gnu', root);
    write = () => registerArmGnuToolchain({ toolchainPath: root, targetTriple, version });
    next = 'Select it for an application with configure (target "app", action "update", toolchain {"family": "arm_gnu"}).';
  } else {
    const root = normalizeIarToolchainRoot(given);
    if (!IarToolchainInstallation.isIarPath(root)) {
      throw invalid(`${root} is not a valid IAR toolchain: no iccarm was found.`);
    }
    const sdkPath = requireString(args, 'zephyr_sdk_path', 'register with family "iar"');
    const inventory = await readToolchainInventory();
    const sdk = inventory.sdks.find(candidate => sameSdkPath(candidate.path, sdkPath));
    if (!sdk) {
      throw invalid(`zephyr_sdk_path ${sdkPath} is not a Zephyr SDK list_toolchains lists.`, 'Pass a zephyr_sdks[].path list_toolchains returns.');
    }
    report = { family, path: root, zephyr_sdk_path: sdk.path, has_token: false };
    registered = () => storedRegistrationPath('iar', root);
    // Never a token from the agent: a licence token must not pass through its transcript.
    write = () => registerIARToolchain({ zephyrSdkPath: sdk.path, iarPath: root, token: '' });
    next = 'It is registered without a licence token, so it runs under a perpetual licence. If it needs an IAR_LMS_BEARER_TOKEN, never ask for it here: remove this registration with remove_or_delete (what "toolchain") and have the user add it again in the Add Toolchain wizard, which open_in_workbench target "add_toolchain" opens and which asks for the token.';
  }

  const existing = registered();
  if (existing) {
    return {
      action: 'register', ...report, path: existing, registered: true, already_registered: true,
      ...(family === 'iar' ? { has_token: iarRegistrationHasToken(existing) } : {}),
      next: 'It was already registered; nothing changed.',
    };
  }
  if (args.dry_run === true) {
    return {
      action: 'register', dry_run: true, would_register: report, confirmation_required: confirmationRequired(ctx, args),
      next: 'Call manage_toolchain again without dry_run to register it.',
    };
  }
  const outcome = await ctx.deps.confirmations.require(ctx, args,
    toolchainSubject(`register the ${LABEL[family]} at ${report.path}`, args, String(report.path)));
  const confirmation = confirmationOf(ctx, outcome);
  let already = false;
  await ctx.deps.services.withToolchainSettingsLock(async () => {
    // Read again under the lock: another call may have registered it meanwhile.
    already = !!registered();
    if (!already) {
      await write();
    }
  });
  await ctx.deps.refreshViews(['toolchains']);
  return {
    action: 'register', ...report, registered: true, ...(already ? { already_registered: true } : {}),
    ...(confirmation ? { confirmation } : {}), next,
  };
}

async function linkRustToolchain(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  const inventory = await readToolchainInventory();
  const rust = listedRust(str(args.rust_path), inventory);
  const llvmArg = str(args.llvm_path);
  const unlink = bool(args.unlink_llvm) === true;
  if (args.c_toolchain === undefined && !llvmArg && !unlink) {
    throw invalid('link needs c_toolchain, llvm_path or unlink_llvm true.');
  }
  if (llvmArg && unlink) {
    throw invalid('llvm_path and unlink_llvm cannot be combined.');
  }
  const cToolchain = args.c_toolchain !== undefined ? resolveRustCToolchain(args.c_toolchain, inventory) : undefined;
  let llvmRoot: string | undefined;
  if (llvmArg) {
    llvmRoot = llvmRootFromSelection(assertPlainAbsolutePath(llvmArg, 'llvm_path', { spaces: true }));
    if (!isLlvmPath(llvmRoot)) {
      throw invalid(`${llvmRoot} is not a valid LLVM installation (libclang not found).`,
        'Pass the root of a host LLVM, or download one with manage_toolchain action "install" family "llvm".');
    }
  }
  const current = rust.installation;
  const report = {
    rust_path: rust.path,
    ...(cToolchain ? { c_toolchain: { family: cToolchain.family, path: cToolchain.path } } : {}),
    ...(llvmRoot ? { llvm_path: llvmRoot } : {}),
    ...(unlink ? { unlink_llvm: true } : {}),
    before: {
      ...(current.cToolchainPath ? { c_toolchain_path: current.cToolchainPath } : {}),
      ...(current.llvmPath ? { llvm_path: current.llvmPath } : {}),
    },
  };
  if (args.dry_run === true) {
    return { action: 'link', dry_run: true, ...report, confirmation_required: confirmationRequired(ctx, args), next: 'Call manage_toolchain again without dry_run to change the links.' };
  }
  const outcome = await ctx.deps.confirmations.require(ctx, args,
    toolchainSubject(`change what the Rust toolchain at ${rust.path} links to`, args, rust.path));
  const confirmation = confirmationOf(ctx, outcome);
  await ctx.deps.services.withToolchainSettingsLock(async () => {
    if (cToolchain) {
      await updateRustToolchainLink(rust.path, cToolchain.type, cToolchain.path);
    }
    if (llvmRoot || unlink) {
      await updateRustToolchainLlvm(rust.path, llvmRoot);
    }
  });
  await ctx.deps.refreshViews(['toolchains']);
  return {
    action: 'link', ...report, linked: true,
    ...(llvmRoot ? { libclang_dir: findLibclangDir(llvmRoot) } : {}),
    ...(confirmation ? { confirmation } : {}),
    next: 'The next build of an application using this Rust toolchain uses the new links.',
  };
}

const JOB_ARGS = ['action', 'family', 'dry_run', 'wait_sec'];

export const manageToolchain: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  checkTypes(args, {
    strings: ['action', 'family', 'version', 'destination', 'parent_path', 'install_base', 'sdk_type', 'sdk_path',
      'arm_target', 'folder_name', 'method', 'llvm_version', 'path', 'zephyr_sdk_path', 'rust_path', 'llvm_path'],
    booleans: ['llvm', 'install_mingw', 'unlink_llvm', 'dry_run'],
    stringArrays: ['toolchains', 'targets'],
  });
  const action = str(args.action);
  const family = str(args.family);
  switch (action) {
    case 'install':
      if (!family) {
        throw invalid('install needs family: zephyr_sdk, arm_gnu, rust, rustup or llvm.');
      }
      refuseUnexpected(args, [...JOB_ARGS, ...installArgsOf(family, args)], `install with family "${family}"`);
      return installToolchain(args, ctx);
    case 'add_components':
      refuseUnexpected(args, [...JOB_ARGS, 'sdk_path', 'toolchains', 'llvm'], 'add_components');
      return addToolchainComponents(args, ctx);
    case 'register':
      refuseUnexpected(args, ['action', 'family', 'path', 'dry_run', ...(family === 'iar' ? ['zephyr_sdk_path'] : [])],
        `register with family "${family ?? ''}"`);
      return registerToolchain(args, ctx);
    case 'link':
      refuseUnexpected(args, ['action', 'rust_path', 'c_toolchain', 'llvm_path', 'unlink_llvm', 'dry_run'], 'link');
      return linkRustToolchain(args, ctx);
    default:
      throw invalid('action must be install, add_components, register or link.');
  }
};

/** remove_or_delete with what "toolchain" or "toolchain_files". */
export async function removeToolchain(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  return removeToolchainEntry(args, ctx);
}
