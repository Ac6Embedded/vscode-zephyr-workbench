// manage_toolchain install and add_components: every value is checked against
// what the official release sites list, the destination is checked, and only
// then is the user asked. The install itself runs as a job through the same
// functions the Add Toolchain wizard and the Toolchains view use.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ArmGnuBareMetalTargetTriple, RustLinkedCToolchainType, ZephyrSdkInstallation } from '../../../models/ToolchainInstallations';
import { buildArmGnuDownloadUrl, getArmGnuHostTarget } from '../../../utils/zephyr/armGnuToolchainUtils';
import {
  buildRustDistUrls, getRustHostTriple, RUST_MINIMAL_PRESET_TARGETS, RUST_STABLE_CHANNEL, updateRustToolchainLlvm,
} from '../../../utils/zephyr/rustToolchainUtils';
import {
  checkRustPrerequisites, findRustup, getManagedRustupBinPath, getManagedRustupRootDir, getRustupInitUrl,
  installManagedRustup, resolveRustupToolchainName,
} from '../../../utils/zephyr/rustupUtils';
import {
  generateSdkUrls, getSdkHostTarget, isSdkV1OrLater, isWritableLocation, mapToolchainIdToPackage,
} from '../../../utils/zephyr/sdkUtils';
import {
  addGnuToolchainsToSdk, downloadRustLlvm, findGlobalSdkOfVersion, globalSdkComponents, installArmGnuToolchain,
  installLlvmIntoSdk, installRustupToolchain, installSdkToLocation, installStandaloneRustToolchain, planRustLlvm,
  RustLlvmPlan, rustCToolchainLinkError, sdkLlvmUrl,
} from '../../../utils/zephyr/toolchainInstall';
import { buildWestSdkInstallArgs, canRunWestSdk, runSdkSetup, runWestSdkInstall } from '../../../utils/zephyr/westSdkRunner';
import { normalizeForCompare } from '../../core/argSafety';
import {
  assertArmGnuVersion, assertDownloadUrl, assertFolderName, assertReleaseNumber, assertRustTarget, assertSdkToolchainId,
  DownloadSource, OFFICIAL_SOURCES,
} from '../../core/downloadArgs';
import { McpToolError } from '../../core/errors';
import { ToolContext } from '../../core/toolSpec';
import { JobView } from '../../jobs/jobManager';
import { HostDeps } from './deps';
import { progressWait, remainingWaitMs } from './progress';
import {
  assertParentFolder, assertPlainAbsolutePath, bool, confirmationOf, confirmationRequired, invalid, num,
  permissionDenied, requireString, str, toolchainSubject,
} from './toolchainArgs';
import { prefetch, toolchainDiscovery } from './toolchainDiscovery';
import {
  readToolchainInventory, samePath, sameSdkPath, SdkEntry, storedRegistrationsWithin, ToolchainInventory,
} from './toolchainInventory';
import {
  assertNoToolchainJob, runningToolchainJob, runToolchainJob, TOOLCHAIN_DOWNLOAD_LOCK, ToolchainJobPlan,
} from './toolchainJobs';

type Ctx = ToolContext<HostDeps>;

/** An install ready to confirm and run, or an answer with nothing to do. */
type Planned =
  | {
    /** What dry_run reports, and what the result repeats. */
    report: Record<string, unknown>;
    /** Completes "wants to ...". */
    summary: string;
    folder?: string;
    plan: ToolchainJobPlan;
    /** Checked again once the user has answered, against what is on disk then. */
    recheck?(): Promise<void> | void;
  }
  | { done: Record<string, unknown> };

const NEXT_CONFIGURE = 'Select it for an application with configure (target "app", action "update", toolchain), or call list_toolchains to see it.';

function hostUnsupported(what: string): McpToolError {
  return invalid(`${what} is not offered for this machine (${process.platform} ${process.arch}).`,
    'Ask the user to install a toolchain for this machine by hand and register it with manage_toolchain action "register".',
    { host_unsupported: true, platform: process.platform, arch: process.arch });
}

function notOffered(what: string, value: string, offered: readonly string[], hint: string): McpToolError {
  return invalid(`${what} "${value}" is not offered.`, hint, { offered: offered.slice(0, 40) });
}

function stringList(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  return Array.isArray(value) ? value.map(String) : undefined;
}

const unique = <T>(items: T[]): T[] => [...new Set(items)];

/**
 * Refuse a destination a registration still points at or into. It holds no
 * toolchain, so the registration was left behind when its folder was deleted,
 * and registering the new toolchain would fail on it only after the download.
 */
function assertNoStaleRegistration(folder: string, otherwise: string): void {
  const stale = storedRegistrationsWithin(folder);
  if (stale.length > 0) {
    throw invalid(`A toolchain registration still points at or into ${folder}, which holds no toolchain: it was left behind when that toolchain was deleted.`,
      `Remove each one with remove_or_delete what "toolchain" and its path from details.registrations first, or ${otherwise}.`,
      { registrations: stale });
  }
}

function failedNext(view: JobView, extra = ''): string {
  if (view.status === 'cancelled') {
    return `The install was cancelled.${extra} Call manage_toolchain again to retry.`;
  }
  return `The install failed: see result.error and the log (job {"action": "log", "job_id": "${view.job_id}"}).${extra}`;
}

/** A release number the release site lists. */
async function offeredSdkVersion(value: string | undefined): Promise<string> {
  if (!value) {
    throw invalid('install with family "zephyr_sdk" needs version.', 'Call list_toolchains with available "zephyr_sdk" to see the releases.');
  }
  const version = assertReleaseNumber(value, 'version');
  const offered = await toolchainDiscovery.sdkVersions();
  if (!offered.includes(version)) {
    throw notOffered('Zephyr SDK', version, offered, 'Call list_toolchains with available "zephyr_sdk" to see the releases.');
  }
  return version;
}

/** GNU toolchain ids as package names, each offered by that SDK release for this host. */
async function offeredSdkToolchains(version: string, requested: string[]): Promise<string[]> {
  const ids = unique(requested.map(id => assertSdkToolchainId(id, mapToolchainIdToPackage)));
  if (ids.length === 0) {
    return ids;
  }
  const offered = await toolchainDiscovery.sdkToolchains(version);
  const unknown = ids.filter(id => !offered.includes(id));
  if (unknown.length > 0) {
    throw invalid(`Zephyr SDK ${version} offers no ${unknown.join(', ')} for this machine.`,
      'Pass ids from details.offered, as list_toolchains available "zephyr_sdk" with version lists them.',
      { offered });
  }
  return ids;
}

function sdkUrls(urls: string[]): Array<{ url: string; file: string }> {
  return urls.map(url => {
    assertDownloadUrl(url, [OFFICIAL_SOURCES.zephyrSdk], { archive: true });
    return { url, file: path.basename(new URL(url).pathname) };
  });
}

/** sdk_type, toolchains and llvm, as the wizard allows them together. */
async function sdkComponents(args: Record<string, unknown>, version: string) {
  const sdkType = str(args.sdk_type) ?? 'full';
  const requested = stringList(args, 'toolchains') ?? [];
  const llvm = bool(args.llvm) ?? false;
  if (sdkType === 'full' && requested.length > 0) {
    throw invalid('toolchains only applies to sdk_type "minimal": a full SDK has every GNU toolchain.');
  }
  if (llvm && (sdkType !== 'minimal' || !isSdkV1OrLater(version))) {
    throw invalid(`llvm needs sdk_type "minimal" and an SDK from 1.0 (this is ${version}).`,
      'Install a minimal SDK 1.0 or later with llvm true, or add LLVM to an installed SDK 1.0 or later with action "add_components".');
  }
  const toolchains = sdkType === 'minimal' ? await offeredSdkToolchains(version, requested) : [];
  return { sdkType, toolchains, llvm };
}

async function planSdkLocation(args: Record<string, unknown>): Promise<Planned> {
  if (!getSdkHostTarget()) {
    throw hostUnsupported('The Zephyr SDK');
  }
  const version = await offeredSdkVersion(str(args.version));
  const { sdkType, toolchains, llvm } = await sdkComponents(args, version);
  const parent = assertParentFolder(requireString(args, 'parent_path', 'install with destination "location"'));
  const target = path.join(parent, `zephyr-sdk-${version}`);
  const checkTarget = () => {
    if (fs.existsSync(target)) {
      throw invalid(`${target} already exists.`,
        'Register it with manage_toolchain action "register" if it is a Zephyr SDK, or pass another parent_path.');
    }
    assertNoStaleRegistration(target, 'pass another parent_path');
  };
  checkTarget();
  const downloads = sdkUrls(generateSdkUrls(sdkType, version, toolchains, llvm));
  if (downloads.length === 0) {
    throw hostUnsupported('The Zephyr SDK');
  }
  const report = {
    family: 'zephyr_sdk', destination: 'location', version, sdk_type: sdkType,
    ...(sdkType === 'minimal' ? { toolchains, llvm } : {}), install_path: target, downloads,
  };
  return {
    report,
    summary: `download Zephyr SDK ${version} (${sdkType}) and install it into ${target}`,
    folder: target,
    recheck: checkTarget,
    plan: {
      kind: 'install',
      lockKey: TOOLCHAIN_DOWNLOAD_LOCK,
      requestKey: `install:zephyr_sdk:location:${normalizeForCompare(target)}:${sdkType}:${toolchains.join(',')}:${llvm}`,
      command: `install Zephyr SDK ${version} (${sdkType}) into ${target}`,
      step: `Install Zephyr SDK ${version}`,
      downloads: { sources: [OFFICIAL_SOURCES.zephyrSdk], archive: true },
      run: async ({ ictx }) => {
        const sdkPath = await installSdkToLocation(ictx, {
          sdkType, sdkVersion: version, toolchains, parentPath: parent, includeLlvm: llvm, expectedRoot: target,
        });
        if (!sdkPath) {
          throw new Error('No Zephyr SDK release exists for this machine.');
        }
        return { ...report, installed_path: sdkPath, registered: true, ...installedSdkContent(sdkPath) };
      },
      onFailure: async ({ log }) => removeUnregisteredFolder(target, log),
      next: view => view.status === 'succeeded'
        ? `Zephyr SDK ${version} is installed at ${target} and registered. ${NEXT_CONFIGURE}`
        : failedNext(view),
    },
  };
}

/** What really is in an SDK on disk. */
function installedSdkContent(sdkPath: string) {
  try {
    const sdk = new ZephyrSdkInstallation(vscode.Uri.file(sdkPath));
    return { gnu_toolchains: sdk.getInstalledGnuToolchains().map(t => t.name), llvm_installed: sdk.hasLlvmToolchain() };
  } catch {
    return {};
  }
}

/**
 * After a failed install, delete the folder it was creating, which did not
 * exist before the call, unless something in it got registered (an Arm GNU
 * root is the archive's own folder inside it); a retry needs it gone.
 */
export async function removeUnregisteredFolder(folder: string, log: (text: string) => void): Promise<Record<string, unknown>> {
  if (!fs.existsSync(folder) || storedRegistrationsWithin(folder).length > 0) {
    return {};
  }
  try {
    await fs.promises.rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    log(`Deleted the partial folder ${folder}\n`);
    return { removed_partial_folder: folder };
  } catch (error) {
    return { partial_folder_left: folder, partial_folder_error: error instanceof Error ? error.message : String(error) };
  }
}

async function planSdkGlobal(args: Record<string, unknown>): Promise<Planned> {
  const version = await offeredSdkVersion(str(args.version));
  const { sdkType, toolchains, llvm } = await sdkComponents(args, version);
  // west gets it as one quoted argument, so a home folder with a space is fine.
  const base = assertPlainAbsolutePath(str(args.install_base) ?? os.homedir(), 'install_base', { spaces: true });
  if (!isWritableLocation(base)) {
    throw permissionDenied(base);
  }
  if (!canRunWestSdk()) {
    throw new McpToolError('ENV_NOT_READY', 'west is not available to install a global Zephyr SDK.', {
      hint: 'Call check_environment: west comes with the host tools, which the user installs from Zephyr Workbench.',
    });
  }
  const components = globalSdkComponents(sdkType, toolchains);
  // Like west sdk install, an SDK of this version found globally is reused:
  // its setup script adds the components.
  const existing = await findGlobalSdkOfVersion(version);
  const existingPath = existing?.rootUri.fsPath;
  if (existingPath && !isWritableLocation(existingPath)) {
    throw permissionDenied(existingPath);
  }
  const westOptions = {
    version, installBase: base, gnuToolchains: components.gnuToolchains,
    noGnuToolchains: components.noGnuToolchains, llvm, noHostTools: true,
  };
  const target = existingPath ?? path.join(base, `zephyr-sdk-${version}`);
  const report = {
    family: 'zephyr_sdk', destination: 'global', version, sdk_type: sdkType,
    ...(sdkType === 'minimal' ? { toolchains, llvm } : {}),
    install_path: target,
    ...(existingPath
      ? { reuses_existing: existingPath, command: `setup script of ${existingPath}` }
      : { install_base: base, command: ['west', ...buildWestSdkInstallArgs(westOptions)].join(' ') }),
    host_tools: false,
    downloads_from: 'github.com/zephyrproject-rtos/sdk-ng releases',
  };
  return {
    report,
    summary: existingPath
      ? `add components to the global Zephyr SDK ${version} at ${existingPath}`
      : `install Zephyr SDK ${version} globally into ${base} with west sdk install`,
    folder: target,
    plan: {
      kind: 'install',
      lockKey: TOOLCHAIN_DOWNLOAD_LOCK,
      requestKey: `install:zephyr_sdk:global:${normalizeForCompare(target)}:${sdkType}:${toolchains.join(',')}:${llvm}`,
      command: existingPath ? `add components to the global Zephyr SDK ${version}` : `west sdk install --version ${version} -b ${base}`,
      step: `Install Zephyr SDK ${version} globally`,
      // west downloads the SDK itself, from the official releases only: no
      // alternate API URL or token is ever passed.
      run: async ({ ictx, log }) => {
        if (existingPath) {
          await runSdkSetup(existingPath, { gnuToolchains: components.setupGnuToolchains, llvm, hostTools: false }, log, ictx.token);
          return { ...report, installed_path: existingPath, ...installedSdkContent(existingPath) };
        }
        fs.mkdirSync(base, { recursive: true });
        const result = await runWestSdkInstall(ictx.context, westOptions, undefined, ictx.token, log);
        return { ...report, installed_path: result.sdkPath, ...installedSdkContent(result.sdkPath) };
      },
      next: view => view.status === 'succeeded'
        ? `Zephyr SDK ${version} is installed globally; the Zephyr build system finds it by itself. Select it for an application with configure (target "app", action "update", toolchain {"family": "global_sdk"}).`
        : failedNext(view),
    },
  };
}

async function planArmGnu(args: Record<string, unknown>): Promise<Planned> {
  const host = getArmGnuHostTarget();
  if (!host) {
    throw hostUnsupported('The Arm GNU Toolchain');
  }
  const version = assertArmGnuVersion(requireString(args, 'version', 'install with family "arm_gnu"'));
  const target = (str(args.arm_target) ?? 'arm-none-eabi') as ArmGnuBareMetalTargetTriple;
  const catalog = await toolchainDiscovery.armGnuCatalog();
  if (!catalog.releases.some(release => release.version === version)) {
    throw notOffered('Arm GNU Toolchain', version, catalog.releases.map(release => release.version),
      'Call list_toolchains with available "arm_gnu" to see the releases for this machine.');
  }
  const asset = catalog.assets.find(candidate => candidate.version === version && candidate.targetTriple === target);
  // The URL always comes from the catalog, never from the agent.
  const url = assertDownloadUrl(asset?.url ?? buildArmGnuDownloadUrl(version, host.id, target), [OFFICIAL_SOURCES.armGnu], { archive: true });
  const archive = path.basename(new URL(url).pathname);
  const folder = assertFolderName(str(args.folder_name) ?? archive.replace(/(\.tar\.xz|\.zip)$/i, ''));
  const parent = assertParentFolder(requireString(args, 'parent_path', 'install with family "arm_gnu"'));
  const installPath = path.join(parent, folder);
  const checkTarget = () => {
    if (fs.existsSync(installPath) && fs.readdirSync(installPath).length > 0) {
      throw invalid(`The destination folder already exists and is not empty: ${installPath}`, 'Pass another folder_name or parent_path.');
    }
    // A registered root is the archive's folder inside installPath.
    assertNoStaleRegistration(installPath, 'pass another folder_name or parent_path');
  };
  checkTarget();
  const report = { family: 'arm_gnu', version, arm_target: target, install_path: installPath, downloads: [{ url, file: archive }] };
  return {
    report,
    summary: `download the Arm GNU Toolchain ${version} (${target}) and install it into ${installPath}`,
    folder: installPath,
    recheck: checkTarget,
    plan: {
      kind: 'install',
      lockKey: TOOLCHAIN_DOWNLOAD_LOCK,
      requestKey: `install:arm_gnu:${normalizeForCompare(installPath)}:${version}:${target}`,
      command: `install the Arm GNU Toolchain ${version} (${target}) into ${installPath}`,
      step: `Install Arm GNU Toolchain ${version}`,
      downloads: { sources: [OFFICIAL_SOURCES.armGnu], archive: true },
      run: async ({ ictx }) => {
        fs.mkdirSync(installPath, { recursive: true });
        const toolchainPath = await installArmGnuToolchain(ictx, { version, targetTriple: target, downloadUrl: url, parentPath: parent, installPath });
        if (!toolchainPath) {
          throw new Error('The archive held no toolchain folder.');
        }
        return { ...report, installed_path: toolchainPath, registered: true };
      },
      onFailure: async ({ log }) => removeUnregisteredFolder(installPath, log),
      next: view => view.status === 'succeeded'
        ? `The Arm GNU Toolchain ${version} is installed and registered. ${NEXT_CONFIGURE}`
        : failedNext(view),
    },
  };
}

/** The C toolchain a Rust toolchain links with: a listed Zephyr SDK or Arm GNU Toolchain. */
export function resolveRustCToolchain(value: unknown, inventory: ToolchainInventory): { type: RustLinkedCToolchainType; path: string; family: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('A Rust toolchain needs c_toolchain {family, path}: the Zephyr SDK or Arm GNU Toolchain it links Zephyr with.',
      'Pass one list_toolchains returns.');
  }
  const { family, path: cPath } = value as { family?: unknown; path?: unknown };
  if (typeof cPath !== 'string' || !cPath) {
    throw invalid('c_toolchain needs path.');
  }
  let found: string | undefined;
  let type: RustLinkedCToolchainType;
  if (family === 'zephyr_sdk') {
    type = 'zephyr-sdk';
    found = inventory.sdks.find(sdk => sameSdkPath(sdk.path, cPath))?.path;
  } else if (family === 'arm_gnu') {
    type = 'gnuarmemb';
    found = inventory.armGnu.find(entry => samePath(entry.path, cPath))?.path;
  } else {
    throw invalid('c_toolchain family must be "zephyr_sdk" or "arm_gnu".');
  }
  if (!found) {
    throw invalid(`c_toolchain ${cPath} is not a ${family === 'zephyr_sdk' ? 'Zephyr SDK' : 'Arm GNU Toolchain'} list_toolchains lists.`,
      'Pass a path list_toolchains returns, or install one first.');
  }
  const error = rustCToolchainLinkError(type, found);
  if (error) {
    throw invalid(error);
  }
  return { type, path: found, family };
}

async function offeredRustTargets(args: Record<string, unknown>): Promise<string[]> {
  const requested = stringList(args, 'targets');
  if (!requested || requested.length === 0) {
    return [...RUST_MINIMAL_PRESET_TARGETS];
  }
  const targets = unique(requested.map(assertRustTarget));
  const offered = (await toolchainDiscovery.rust()).targets;
  const unknown = targets.filter(target => !offered.includes(target));
  if (unknown.length > 0) {
    throw invalid(`Zephyr supports no Rust target ${unknown.join(', ')}.`, 'Pass targets from details.offered.', { offered });
  }
  return targets;
}

async function offeredLlvmVersion(value: string | undefined): Promise<string> {
  const llvm = await toolchainDiscovery.llvmVersions();
  if (!value) {
    if (!llvm.suggested[0]) {
      throw invalid('No LLVM release is offered for bindgen.', 'Call list_toolchains with available "llvm".');
    }
    return llvm.suggested[0];
  }
  const version = assertReleaseNumber(value, 'llvm_version');
  if (!llvm.all.includes(version)) {
    throw notOffered('LLVM', version, llvm.suggested, 'Call list_toolchains with available "llvm" to see the releases.');
  }
  return version;
}

function llvmPlanOrThrow(destDir: string, version: string): RustLlvmPlan {
  const plan = planRustLlvm(destDir, version);
  if ('error' in plan) {
    throw hostUnsupported('A host LLVM download');
  }
  if (plan.kind === 'download') {
    assertDownloadUrl(plan.url, [OFFICIAL_SOURCES.llvm], { archive: true });
  }
  return plan;
}

function llvmReport(plan: RustLlvmPlan, version: string) {
  return plan.kind === 'reuse'
    ? { version, path: plan.llvmRoot, reuses_existing: true }
    : { version, path: plan.llvmRoot, download: plan.url };
}

/** The host LLVM of a plan, downloading it when it is not there yet. */
async function llvmRootOf(work: { ictx: Parameters<typeof downloadRustLlvm>[0] }, plan: RustLlvmPlan): Promise<string> {
  if (plan.kind === 'reuse') {
    return plan.llvmRoot;
  }
  fs.mkdirSync(plan.destDir, { recursive: true });
  return downloadRustLlvm(work.ictx, plan);
}

async function offeredRustVersion(value: string | undefined, standalone: boolean): Promise<string> {
  const offered = (await toolchainDiscovery.rust()).versions;
  if (!value) {
    if (standalone) {
      throw invalid('A standalone Rust toolchain needs version, a numbered release.', 'Call list_toolchains with available "rust".');
    }
    return RUST_STABLE_CHANNEL;
  }
  if (value === RUST_STABLE_CHANNEL && !standalone) {
    return value;
  }
  const version = assertReleaseNumber(value, 'version');
  if (!offered.includes(version)) {
    throw notOffered('Rust', version, offered, 'Call list_toolchains with available "rust" to see the releases.');
  }
  return version;
}

async function planRustup(args: Record<string, unknown>, inventory: ToolchainInventory): Promise<Planned> {
  const rustup = await findRustup();
  if (!rustup) {
    throw new McpToolError('ENV_NOT_READY', 'rustup is not installed, and a Rust toolchain installs through it.', {
      hint: 'Install the workbench rustup first with manage_toolchain action "install" family "rustup", then retry.',
    });
  }
  const version = await offeredRustVersion(str(args.version), false);
  const targets = await offeredRustTargets(args);
  const cToolchain = resolveRustCToolchain(args.c_toolchain, inventory);
  const llvmVersion = await offeredLlvmVersion(str(args.llvm_version));
  // Downloaded LLVM lives beside the rustup-managed toolchains, as the wizard puts it.
  const llvmPlan = llvmPlanOrThrow(getManagedRustupRootDir(), llvmVersion);
  // On Windows without the MSVC Build Tools, the self-contained GNU host is used.
  const prereq = await checkRustPrerequisites();
  const toolchainName = resolveRustupToolchainName(version, prereq.ok);
  const gnuFallback = process.platform === 'win32' && !prereq.ok;
  const report = {
    family: 'rust', method: 'rustup', version, rustup_toolchain: toolchainName, targets,
    c_toolchain: { family: cToolchain.family, path: cToolchain.path },
    llvm: llvmReport(llvmPlan, llvmVersion), rustup: rustup.rustupPath,
    ...(gnuFallback ? { gnu_host_fallback: true } : {}),
  };
  return {
    report,
    summary: `install the Rust toolchain ${toolchainName} through rustup with ${targets.length} target(s), and LLVM ${llvmVersion}`,
    plan: {
      kind: 'install',
      lockKey: TOOLCHAIN_DOWNLOAD_LOCK,
      requestKey: `install:rust:rustup:${toolchainName}:${targets.join(',')}:${normalizeForCompare(cToolchain.path)}:${llvmVersion}`,
      command: `rustup toolchain install ${toolchainName} with ${targets.join(' ')}`,
      step: `Install Rust ${toolchainName}`,
      downloads: { sources: [OFFICIAL_SOURCES.llvm], archive: true },
      run: async work => {
        const llvmRoot = await llvmRootOf(work, llvmPlan);
        const entry = await installRustupToolchain(work.ictx, {
          rustup, toolchainName, targets, cToolchainType: cToolchain.type, cToolchainPath: cToolchain.path, llvmRoot,
          // Installing the same rustup toolchain again updates its targets and links.
          updateExisting: true,
        });
        if (gnuFallback) {
          work.ictx.reporter.warn?.('Visual Studio C++ Build Tools were not found: the self-contained GNU host toolchain was installed instead.');
        }
        return { ...report, installed_path: entry.toolchainPath, installed_version: entry.version, targets: entry.targets, llvm_path: llvmRoot, registered: true };
      },
      next: view => view.status === 'succeeded'
        ? `The Rust toolchain is installed and registered. ${NEXT_CONFIGURE}`
        : failedNext(view),
    },
  };
}

async function planRustStandalone(args: Record<string, unknown>, inventory: ToolchainInventory): Promise<Planned> {
  const hostTriple = getRustHostTriple();
  if (!hostTriple) {
    throw hostUnsupported('A standalone Rust toolchain');
  }
  const version = await offeredRustVersion(str(args.version), true);
  const targets = await offeredRustTargets(args);
  const cToolchain = resolveRustCToolchain(args.c_toolchain, inventory);
  const llvmVersion = await offeredLlvmVersion(str(args.llvm_version));
  const installMingwArg = bool(args.install_mingw);
  if (installMingwArg && process.platform !== 'win32') {
    throw invalid('install_mingw only applies on Windows.');
  }
  // Checked like the wizard's default: MinGW is offered, and checked, on Windows only.
  const installMingw = process.platform === 'win32' && installMingwArg !== false;
  const folder = assertFolderName(str(args.folder_name) ?? `rust-${version}-llvm-${llvmVersion}`);
  const parent = assertParentFolder(requireString(args, 'parent_path', 'install with family "rust" and method "standalone"'));
  const installPath = path.join(parent, folder);
  const checkTarget = () => {
    if (fs.existsSync(installPath) && fs.readdirSync(installPath).length > 0) {
      throw invalid(`The destination folder already exists and is not empty: ${installPath}`, 'Pass another folder_name or parent_path.');
    }
    assertNoStaleRegistration(installPath, 'pass another folder_name or parent_path');
  };
  checkTarget();
  // Downloaded LLVM lands in the same Location as the toolchain, as the wizard puts it.
  const llvmPlan = llvmPlanOrThrow(parent, llvmVersion);
  const urls = buildRustDistUrls(version, hostTriple, targets);
  for (const url of urls) {
    assertDownloadUrl(url, [OFFICIAL_SOURCES.rustDist], { archive: true });
  }
  const report = {
    family: 'rust', method: 'standalone', version, targets, host_triple: hostTriple,
    c_toolchain: { family: cToolchain.family, path: cToolchain.path },
    llvm: llvmReport(llvmPlan, llvmVersion), install_path: installPath,
    downloads: urls.map(url => ({ url, file: path.basename(new URL(url).pathname) })),
    ...(process.platform === 'win32' ? { install_mingw: installMingw } : {}),
  };
  const sources: DownloadSource[] = [OFFICIAL_SOURCES.rustDist, OFFICIAL_SOURCES.llvm, OFFICIAL_SOURCES.winlibs];
  return {
    report,
    summary: `download Rust ${version} with ${targets.length} target(s) and LLVM ${llvmVersion}, and install it into ${installPath}`,
    folder: installPath,
    recheck: checkTarget,
    plan: {
      kind: 'install',
      lockKey: TOOLCHAIN_DOWNLOAD_LOCK,
      // The whole request, link and LLVM included, so a different one is never joined.
      requestKey: `install:rust:standalone:${normalizeForCompare(installPath)}:${version}:${targets.join(',')}`
        + `:${cToolchain.type}:${normalizeForCompare(cToolchain.path)}:${llvmVersion}:${installMingw}`,
      command: `install Rust ${version} into ${installPath}`,
      step: `Install Rust ${version}`,
      downloads: { sources, archive: true },
      run: async work => {
        fs.mkdirSync(installPath, { recursive: true });
        const llvmRoot = await llvmRootOf(work, llvmPlan);
        // It deletes the partial install folder itself when it fails.
        const entry = await installStandaloneRustToolchain(work.ictx, {
          version, targets, hostTriple, parentPath: parent, installPath,
          cToolchainType: cToolchain.type, cToolchainPath: cToolchain.path, llvmRoot, installMingw,
        });
        return { ...report, installed_path: entry.toolchainPath, llvm_path: llvmRoot, registered: true };
      },
      next: view => view.status === 'succeeded'
        ? `Rust ${version} is installed and registered. ${NEXT_CONFIGURE}`
        : failedNext(view),
    },
  };
}

async function planManagedRustup(): Promise<Planned> {
  const rustupPath = getManagedRustupBinPath();
  if (fs.existsSync(rustupPath)) {
    return {
      done: {
        family: 'rustup', already_installed: true, rustup_path: rustupPath,
        next: 'rustup is installed. Install a Rust toolchain with manage_toolchain action "install" family "rust".',
      },
    };
  }
  const url = getRustupInitUrl();
  if (!url) {
    throw hostUnsupported('rustup');
  }
  assertDownloadUrl(url, [OFFICIAL_SOURCES.rustupInit], { archive: false });
  const root = getManagedRustupRootDir();
  const report = {
    family: 'rustup', install_path: root, downloads: [{ url, file: path.basename(new URL(url).pathname) }],
    changes_path: false,
  };
  return {
    report,
    summary: `download rustup and install it under ${root} (it changes neither PATH nor any shell profile)`,
    folder: root,
    plan: {
      kind: 'install',
      lockKey: TOOLCHAIN_DOWNLOAD_LOCK,
      requestKey: 'install:rustup',
      command: `install rustup under ${root}`,
      step: 'Install rustup',
      downloads: { sources: [OFFICIAL_SOURCES.rustupInit], archive: false },
      run: async ({ ictx }) => {
        await installManagedRustup(ictx.context, ictx.reporter, ictx.token, ictx.hooks);
        return { ...report, rustup_path: getManagedRustupBinPath() };
      },
      next: view => view.status === 'succeeded'
        ? 'rustup is installed. Install a Rust toolchain with manage_toolchain action "install" family "rust".'
        : failedNext(view),
    },
  };
}

/** The listed Rust toolchain `rust_path` names. */
export function listedRust(value: string | undefined, inventory: ToolchainInventory) {
  if (!value) {
    throw invalid('This action needs rust_path, a Rust toolchain list_toolchains returns.');
  }
  const entry = inventory.rust.find(candidate => samePath(candidate.path, value));
  if (!entry) {
    throw invalid(`${value} is not a Rust toolchain list_toolchains lists.`, 'Pass a rust[].path list_toolchains returns.');
  }
  return entry;
}

async function planHostLlvm(args: Record<string, unknown>, inventory: ToolchainInventory): Promise<Planned> {
  const rust = listedRust(str(args.rust_path), inventory);
  const llvmVersion = await offeredLlvmVersion(str(args.llvm_version));
  // Where the wizard would have put it: beside the rustup toolchains, or in
  // the folder of a standalone toolchain.
  const destDir = rust.registration?.rustupToolchain ? getManagedRustupRootDir() : path.dirname(rust.path);
  if (!isWritableLocation(destDir)) {
    throw permissionDenied(destDir);
  }
  const llvmPlan = llvmPlanOrThrow(destDir, llvmVersion);
  const report = { family: 'llvm', rust_path: rust.path, llvm: llvmReport(llvmPlan, llvmVersion), current_llvm_path: rust.installation.llvmPath };
  return {
    report,
    summary: `download LLVM ${llvmVersion} into ${destDir} and link it to the Rust toolchain at ${rust.path}`,
    folder: destDir,
    plan: {
      kind: 'install',
      lockKey: TOOLCHAIN_DOWNLOAD_LOCK,
      requestKey: `install:llvm:${normalizeForCompare(rust.path)}:${llvmVersion}`,
      command: `install LLVM ${llvmVersion} for ${rust.path}`,
      step: `Install LLVM ${llvmVersion}`,
      downloads: { sources: [OFFICIAL_SOURCES.llvm], archive: true },
      run: async work => {
        const llvmRoot = await llvmRootOf(work, llvmPlan);
        await work.ictx.withRegistration(() => updateRustToolchainLlvm(rust.path, llvmRoot));
        return { ...report, llvm_path: llvmRoot, linked: true };
      },
      next: view => view.status === 'succeeded'
        ? 'The host LLVM is installed and linked; LIBCLANG_PATH points into it on the next build.'
        : failedNext(view),
    },
  };
}

/** Arguments each install takes beyond action, family, dry_run and wait_sec. */
export function installArgsOf(family: string | undefined, args: Record<string, unknown>): readonly string[] {
  switch (family) {
    case 'zephyr_sdk':
      return str(args.destination) === 'global'
        ? ['destination', 'version', 'sdk_type', 'toolchains', 'llvm', 'install_base']
        : ['destination', 'version', 'sdk_type', 'toolchains', 'llvm', 'parent_path'];
    case 'arm_gnu':
      return ['version', 'arm_target', 'parent_path', 'folder_name'];
    case 'rust':
      return str(args.method) === 'standalone'
        ? ['method', 'version', 'targets', 'c_toolchain', 'llvm_version', 'parent_path', 'folder_name', 'install_mingw']
        : ['method', 'version', 'targets', 'c_toolchain', 'llvm_version'];
    case 'llvm':
      return ['rust_path', 'llvm_version'];
    default:
      return [];
  }
}

async function planInstall(args: Record<string, unknown>): Promise<Planned> {
  const family = str(args.family);
  // The release lookups a family needs start together, while the rest is checked.
  if (family === 'zephyr_sdk') {
    const version = str(args.version)?.trim().replace(/^v/, '');
    const numbered = !!version && /^\d+\.\d+\.\d+$/.test(version);
    prefetch(() => toolchainDiscovery.sdkVersions(),
      ...(numbered && (stringList(args, 'toolchains') ?? []).length > 0 ? [() => toolchainDiscovery.sdkToolchains(version)] : []));
  } else if (family === 'rust') {
    prefetch(() => toolchainDiscovery.rust(), () => toolchainDiscovery.llvmVersions());
  }
  const inventory = await readToolchainInventory();
  switch (family) {
    case 'zephyr_sdk':
      return str(args.destination) === 'global' ? planSdkGlobal(args) : planSdkLocation(args);
    case 'arm_gnu':
      return planArmGnu(args);
    case 'rust':
      return str(args.method) === 'standalone' ? planRustStandalone(args, inventory) : planRustup(args, inventory);
    case 'rustup':
      return planManagedRustup();
    case 'llvm':
      return planHostLlvm(args, inventory);
    case 'iar':
      throw invalid('An IAR toolchain cannot be installed by the workbench: it is licensed software the user installs.',
        'Register an installed one with manage_toolchain action "register" family "iar".');
    default:
      throw invalid('install needs family: zephyr_sdk, arm_gnu, rust, rustup or llvm.');
  }
}

function listedSdk(value: string | undefined, inventory: ToolchainInventory): SdkEntry {
  if (!value) {
    throw invalid('add_components needs sdk_path, a Zephyr SDK list_toolchains returns.');
  }
  const sdk = inventory.sdks.find(candidate => sameSdkPath(candidate.path, value));
  if (!sdk) {
    throw invalid(`${value} is not a Zephyr SDK list_toolchains lists.`, 'Pass a zephyr_sdks[].path list_toolchains returns.');
  }
  return sdk;
}

async function planAddComponents(args: Record<string, unknown>): Promise<Planned> {
  if (args.family !== undefined && args.family !== 'zephyr_sdk') {
    throw invalid('add_components only extends a Zephyr SDK: family must be "zephyr_sdk" or left out.');
  }
  const inventory = await readToolchainInventory();
  const entry = listedSdk(str(args.sdk_path), inventory);
  const sdk = entry.installation;
  const version = entry.version;
  const requested = stringList(args, 'toolchains') ?? [];
  const llvm = bool(args.llvm) ?? false;
  if (requested.length === 0 && !llvm) {
    throw invalid('add_components needs toolchains, llvm true, or both.');
  }
  if (llvm && !isSdkV1OrLater(version)) {
    throw invalid(`The LLVM toolchain is only available for Zephyr SDK 1.0 or later (this SDK is ${version}).`);
  }
  const ids = await offeredSdkToolchains(version, requested);
  const installed = new Set(sdk.getInstalledGnuToolchains().map(toolchain => toolchain.name));
  const toInstall = ids.filter(id => !installed.has(id));
  const alreadyInstalled = [...ids.filter(id => installed.has(id)), ...(llvm && sdk.hasLlvmToolchain() ? ['llvm'] : [])];
  const withLlvm = llvm && !sdk.hasLlvmToolchain();
  if (toInstall.length === 0 && !withLlvm) {
    return {
      done: {
        sdk_path: entry.path, version, added: [], already_installed: alreadyInstalled,
        next: 'Everything asked for is already installed in this SDK.',
      },
    };
  }
  const llvmUrl = withLlvm ? sdkLlvmUrl(version) : undefined;
  if (withLlvm && !llvmUrl) {
    throw hostUnsupported(`The LLVM toolchain of Zephyr SDK ${version}`);
  }
  // A global SDK in a system folder needs administrator rights, which the
  // workbench never asks for.
  for (const dest of [...(toInstall.length > 0 ? [sdk.getGnuToolchainsRootPath()] : []), ...(withLlvm ? [entry.path] : [])]) {
    if (!isWritableLocation(dest)) {
      throw permissionDenied(dest);
    }
  }
  const downloads = sdkUrls([
    ...toInstall.map(id => generateSdkUrls('minimal', version, [id], false)[1]).filter((url): url is string => !!url),
    ...(llvmUrl ? [llvmUrl] : []),
  ]);
  const report = {
    sdk_path: entry.path, version, toolchains: toInstall, llvm: withLlvm,
    ...(alreadyInstalled.length > 0 ? { already_installed: alreadyInstalled } : {}), downloads,
  };
  const what = [...toInstall, ...(withLlvm ? ['LLVM'] : [])].join(', ');
  return {
    report,
    summary: `download ${what} into the Zephyr SDK ${version} at ${entry.path}`,
    folder: entry.path,
    plan: {
      kind: 'install',
      lockKey: TOOLCHAIN_DOWNLOAD_LOCK,
      requestKey: `add:${normalizeForCompare(entry.path)}:${toInstall.join(',')}:${withLlvm}`,
      command: `add ${what} to the Zephyr SDK at ${entry.path}`,
      step: `Add components to Zephyr SDK ${version}`,
      downloads: { sources: [OFFICIAL_SOURCES.zephyrSdk], archive: true },
      run: async ({ ictx }) => {
        const added = toInstall.length > 0 ? await addGnuToolchainsToSdk(ictx, sdk, toInstall) : [];
        if (withLlvm && llvmUrl) {
          await installLlvmIntoSdk(ictx, sdk, llvmUrl);
        }
        return { ...report, added: [...added, ...(withLlvm ? ['llvm'] : [])], ...installedSdkContent(entry.path) };
      },
      next: view => view.status === 'succeeded'
        ? 'The components are installed. An application builds with them on its next pristine build (build_app with pristine "always").'
        : failedNext(view),
    },
  };
}

/** Plan, check, ask, then run one install or component download as a job. */
async function confirmAndRun(args: Record<string, unknown>, ctx: Ctx, planned: Planned): Promise<unknown> {
  const { jobs, defaultWaitSeconds, confirmations } = ctx.deps;
  if ('done' in planned) {
    return { action: args.action, ...(args.dry_run ? { dry_run: true } : {}), ...planned.done };
  }
  const { plan } = planned;
  const waitSec = num(args.wait_sec) ?? defaultWaitSeconds;
  const running = runningToolchainJob(jobs, plan.lockKey, plan.requestKey);
  if (running && !args.dry_run) {
    // The same install already runs: join it rather than asking again.
    await jobs.wait(running, remainingWaitMs(ctx, waitSec), progressWait(ctx, jobs));
    return jobs.view(running, { attached: true });
  }
  if (!running) {
    assertNoToolchainJob(jobs);
  }
  if (args.dry_run === true) {
    return {
      action: args.action, dry_run: true, ...planned.report,
      ...(running ? { already_running: running.id } : {}),
      confirmation_required: confirmationRequired(ctx, args),
      next: 'Call manage_toolchain again without dry_run to install.',
    };
  }
  const outcome = await confirmations.require(ctx, args, toolchainSubject(planned.summary, args, planned.folder));
  // Another install may have started, or the folder appeared, while the dialog was open.
  assertNoToolchainJob(jobs);
  await planned.recheck?.();
  const confirmation = confirmationOf(ctx, outcome);
  return runToolchainJob(ctx, plan, waitSec, confirmation ? { confirmation } : {});
}

export async function installToolchain(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  return confirmAndRun(args, ctx, await planInstall(args));
}

export async function addToolchainComponents(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  return confirmAndRun(args, ctx, await planAddComponents(args));
}
