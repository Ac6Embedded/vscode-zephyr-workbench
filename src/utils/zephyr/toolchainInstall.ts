// Toolchain installs shared by the Add Toolchain wizard, the Toolchains view
// and the agent tools. Each function does the work only and throws what went
// wrong: the caller keeps its own progress notification, messages, pickers and
// download cleanup, so the views behave exactly as they did before.

import * as vscode from 'vscode';
import fs from 'fs';
import path from 'path';
import {
  ArmGnuBareMetalTargetTriple,
  ArmGnuToolchainInstallation,
  GlobalZephyrSdkInstallation,
  RustLinkedCToolchainType,
  RustToolchainInstallation,
  ZephyrSdkInstallation,
} from '../../models/ToolchainInstallations';
import { download, DownloadHooks, extractTar } from '../installUtils';
import { registerArmGnuToolchain } from './armGnuToolchainUtils';
import { refreshGlobalSdkDetection } from './globalSdkService';
import {
  buildLlvmDownloadUrl,
  buildRustDistUrls,
  detectRustVersion,
  getLlvmTopLevelDirName,
  getRustDistTopLevelDirName,
  installMingwToolchain,
  installRustDistComponents,
  isLlvmPath,
  registerOrUpdateRustToolchain,
  registerRustToolchain,
  RegisteredRustToolchain,
  RustHostTriple,
  WINLIBS_MANUAL_URL,
} from './rustToolchainUtils';
import { FoundRustup, installRustToolchainViaRustup } from './rustupUtils';
import { extractSDK, generateSdkUrls, mapToolchainIdToPackage, registerZephyrSDK } from './sdkUtils';

/** Where an install tells how it goes. vscode.Progress fits as is. */
export interface ToolchainInstallReporter {
  report(value: { message?: string; increment?: number }): void;
  /** Something failed that does not stop the install, such as the optional MinGW. */
  warn?(message: string): void;
}

export interface ToolchainInstallContext {
  context: vscode.ExtensionContext;
  reporter: ToolchainInstallReporter;
  token: vscode.CancellationToken;
  /** Vets each URL before it is fetched and learns each downloaded file. */
  hooks?: DownloadHooks;
  /**
   * Called at the point the install is done with its downloads: the views
   * empty the whole download folder, an agent job deletes only its own files.
   */
  cleanupDownloads(): Promise<void>;
  /** Deletes a folder: deleteFolder for the views, a UI-free remover for an agent. */
  removeFolder(dir: string): Promise<unknown>;
  /** Runs a registration in the toolchain settings; an agent runs it under its settings lock. */
  withRegistration<T>(work: () => Promise<T>): Promise<T>;
}

const cancelled = () => Object.assign(new Error('Download cancelled'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });

// Rust

/**
 * Why a Rust toolchain cannot link with this C toolchain, or undefined when it
 * can. A Rust toolchain only works alongside a Zephyr SDK or an Arm GNU
 * toolchain, so an install must always provide a valid link.
 */
export function rustCToolchainLinkError(cToolchainType?: string, cToolchainPath?: string): string | undefined {
  if (!cToolchainType || !cToolchainPath) {
    return "Missing linked C toolchain, please select a Zephyr SDK or ARM GNU toolchain.";
  }

  if (cToolchainType === 'zephyr-sdk') {
    return ZephyrSdkInstallation.isSdkPath(cToolchainPath)
      ? undefined
      : `The linked Zephyr SDK is not valid: ${cToolchainPath}`;
  }

  if (cToolchainType === 'gnuarmemb') {
    return ArmGnuToolchainInstallation.isArmGnuPath(cToolchainPath)
      ? undefined
      : `The linked Arm GNU toolchain is not valid: ${cToolchainPath}`;
  }

  return `Unknown linked C toolchain type: ${cToolchainType}`;
}

/** The host LLVM a Rust toolchain links to: an already extracted copy, or a release to download. */
export type RustLlvmPlan =
  | { kind: 'reuse'; llvmRoot: string }
  | { kind: 'download'; llvmRoot: string; url: string; destDir: string };

/**
 * Where the host LLVM linked to a Rust toolchain comes from: the release of
 * llvm-project extracted into `downloadDestDir`, the folder the Rust toolchain
 * uses (no separate location is asked). An already extracted copy is reused.
 * Returns the reason when there is no LLVM to get.
 */
export function planRustLlvm(downloadDestDir: string, llvmVersion?: string): RustLlvmPlan | { error: string } {
  if (!llvmVersion) {
    return { error: "Missing LLVM version, please choose the LLVM release to download." };
  }

  const url = buildLlvmDownloadUrl(llvmVersion);
  const topDir = getLlvmTopLevelDirName(llvmVersion);
  if (!url || !topDir) {
    return { error: "LLVM download is not supported on this platform; select a local LLVM instead." };
  }

  const llvmRoot = path.join(downloadDestDir, topDir);
  if (isLlvmPath(llvmRoot)) {
    // Already extracted by a previous import; reuse it.
    return { kind: 'reuse', llvmRoot };
  }
  return { kind: 'download', llvmRoot, url, destDir: downloadDestDir };
}

/** Download and extract the host LLVM a plan names. Returns its root, which contains libclang. */
export async function downloadRustLlvm(
  ictx: ToolchainInstallContext,
  plan: Extract<RustLlvmPlan, { kind: 'download' }>,
): Promise<string> {
  const { context, reporter, token, hooks } = ictx;
  reporter.report({ message: `Download ${plan.url}` });
  const downloadedFileUri = await download(plan.url, plan.destDir, context, reporter, token, hooks);

  reporter.report({ message: `Extracting ${downloadedFileUri}` });
  await extractTar(downloadedFileUri.fsPath, plan.destDir, reporter, token);

  if (!isLlvmPath(plan.llvmRoot)) {
    throw new Error("The extracted folder is not a valid LLVM installation (libclang not found).");
  }
  await ictx.cleanupDownloads();
  return plan.llvmRoot;
}

export interface RustupToolchainInstall {
  rustup: FoundRustup;
  /** The rustup toolchain name, from resolveRustupToolchainName. */
  toolchainName: string;
  targets: string[];
  cToolchainType: RustLinkedCToolchainType;
  cToolchainPath: string;
  llvmRoot: string;
  /** Update the registration of a toolchain already registered, instead of failing as a duplicate. */
  updateExisting?: boolean;
}

/** Install a Rust toolchain and its targets through rustup, then register it. */
export async function installRustupToolchain(
  ictx: ToolchainInstallContext,
  opts: RustupToolchainInstall,
): Promise<RegisteredRustToolchain> {
  const toolchainPath = await installRustToolchainViaRustup(opts.rustup, opts.toolchainName, opts.targets, ictx.reporter, ictx.token);
  const version = await detectRustVersion(toolchainPath);
  const detectedTargets = RustToolchainInstallation.detectInstalledTargets(toolchainPath);

  const entry: RegisteredRustToolchain = {
    toolchainPath,
    version,
    targets: detectedTargets.length ? detectedTargets : opts.targets,
    rustupToolchain: opts.toolchainName,
    cToolchainType: opts.cToolchainType,
    cToolchainPath: opts.cToolchainPath,
    llvmPath: opts.llvmRoot,
  };
  await ictx.withRegistration(() => opts.updateExisting ? registerOrUpdateRustToolchain(entry) : registerRustToolchain(entry));
  return entry;
}

export interface StandaloneRustToolchainInstall {
  version: string;
  targets: string[];
  hostTriple: RustHostTriple;
  /** Where the dist archives are downloaded from, as the wizard passes it. */
  parentPath: string;
  /** The empty folder the toolchain is assembled in. */
  installPath: string;
  cToolchainType: RustLinkedCToolchainType;
  cToolchainPath: string;
  llvmRoot: string;
  installMingw?: boolean;
}

/**
 * Assemble a standalone Rust toolchain from the official dist archives and
 * register it. A partially assembled install is unusable and would block a
 * retry, because the destination must be empty, so it is deleted on failure.
 * `track.currentUrl` names the archive being handled when it failed.
 */
export async function installStandaloneRustToolchain(
  ictx: ToolchainInstallContext,
  opts: StandaloneRustToolchainInstall,
  track: { currentUrl: string } = { currentUrl: '' },
): Promise<RegisteredRustToolchain> {
  const { context, reporter, token, hooks } = ictx;
  const { installPath } = opts;
  const urls = buildRustDistUrls(opts.version, opts.hostTriple, opts.targets);
  // Staging lives inside the install folder so component moves
  // stay on the same volume.
  const stagingPath = path.join(installPath, '.zw-rust-staging');
  try {
    fs.mkdirSync(stagingPath, { recursive: true });
    const incrementPerComponent = 90 / urls.length;

    for (const url of urls) {
      if (token.isCancellationRequested) {
        throw cancelled();
      }
      track.currentUrl = url;
      reporter.report({ message: `Download ${url}` });
      const downloadedFileUri = await download(url, opts.parentPath, context, reporter, token, hooks);

      reporter.report({ message: `Extracting ${downloadedFileUri}` });
      await extractTar(downloadedFileUri.fsPath, stagingPath, reporter, token);

      const extractedDir = path.join(stagingPath, getRustDistTopLevelDirName(url));
      reporter.report({
        message: `Installing ${path.basename(extractedDir)}`,
        increment: incrementPerComponent,
      });
      await installRustDistComponents(extractedDir, installPath);
      await ictx.removeFolder(extractedDir);
    }

    if (!RustToolchainInstallation.isRustPath(installPath)) {
      throw new Error("The assembled folder is not a valid Rust toolchain.");
    }

    // Optional Windows host dependencies: a full MinGW-w64 GCC
    // (gcc, dlltool, ...) bundled inside the toolchain; its bin
    // is added to PATH automatically once present.
    if (opts.installMingw && process.platform === 'win32') {
      try {
        reporter.report({ message: "Installing MinGW-w64 host dependencies..." });
        await installMingwToolchain(context, installPath, reporter, token, hooks);
      } catch (mingwError: any) {
        if (mingwError.code === 'ERR_STREAM_PREMATURE_CLOSE') {
          throw mingwError;
        }
        reporter.warn?.(
          `MinGW-w64 install failed: ${mingwError?.message ?? mingwError}. `
          + `Download it manually from ${WINLIBS_MANUAL_URL} (Win64/UCRT) and extract it to ${path.join(installPath, 'mingw64')}.`
        );
      }
    }

    const entry: RegisteredRustToolchain = {
      toolchainPath: installPath,
      version: opts.version,
      targets: opts.targets,
      hostTriple: opts.hostTriple,
      cToolchainType: opts.cToolchainType,
      cToolchainPath: opts.cToolchainPath,
      llvmPath: opts.llvmRoot,
    };
    await ictx.withRegistration(() => registerRustToolchain(entry));
    await ictx.cleanupDownloads();

    reporter.report({
      message: "Importing Rust Toolchain done",
      increment: 10,
    });
    return entry;
  } catch (e) {
    await ictx.removeFolder(installPath);
    throw e;
  } finally {
    await ictx.removeFolder(stagingPath);
  }
}

// Zephyr SDK

export interface SdkLocationInstall {
  sdkType: string;
  sdkVersion: string;
  /** GNU toolchain ids for a minimal SDK, friendly (arm) or package (arm-zephyr-eabi) names. */
  toolchains: string[];
  parentPath: string;
  includeLlvm?: boolean;
  /** When given, the SDK must extract exactly there, or it is not registered. */
  expectedRoot?: string;
}

/**
 * Download an official Zephyr SDK and the requested toolchains into
 * `parentPath` and register it. Returns the SDK root, or undefined when no
 * release exists for this host.
 */
export async function installSdkToLocation(
  ictx: ToolchainInstallContext,
  opts: SdkLocationInstall,
): Promise<string | undefined> {
  const { context, reporter, token, hooks } = ictx;
  const { sdkVersion, parentPath } = opts;
  const urls = generateSdkUrls(opts.sdkType, sdkVersion, opts.toolchains, opts.includeLlvm ?? false);
  const url = urls[0];
  if (!url) {
    return undefined;
  }

  // Download SDK then extract SDK and get the first level extracted folder
  reporter.report({
    message: `Download ${url}`,
    increment: 0,
  });
  const downloadedFileUri = await download(url, parentPath, context, reporter, token, hooks);

  reporter.report({
    message: `Extracting ${downloadedFileUri}`,
    increment: 40,
  });
  const zephyrSDKPath = await extractSDK(downloadedFileUri.fsPath, parentPath, reporter, token);
  if (opts.expectedRoot && path.resolve(zephyrSDKPath) !== path.resolve(opts.expectedRoot)) {
    throw new Error(`The SDK archive extracted to ${zephyrSDKPath} instead of ${opts.expectedRoot}.`);
  }

  // If toolchain urls exist, download them
  if (urls.length > 1) {
    const gnuToolchainDestPath =
      (sdkVersion.startsWith('1.') || sdkVersion.startsWith('v1.'))
        ? path.join(zephyrSDKPath, 'gnu')
        : zephyrSDKPath;
    if (!fs.existsSync(gnuToolchainDestPath)) {
      fs.mkdirSync(gnuToolchainDestPath, { recursive: true });
    }
    for (let i = 1; i < urls.length; i++) {
      reporter.report({
        message: `Download ${urls[i]}`,
      });
      const toolchainFileUri = await download(urls[i], parentPath, context, reporter, token, hooks);
      reporter.report({
        message: `Extracting ${toolchainFileUri}`,
      });
      // LLVM archive already contains its llvm/ top-level folder; extract at SDK root.
      const isLlvm = urls[i].includes('/toolchain_llvm_');
      const destPath = isLlvm ? zephyrSDKPath : gnuToolchainDestPath;
      await extractSDK(toolchainFileUri.fsPath, destPath, reporter, token);
    }
  }

  reporter.report({
    message: `Importing SDK done`,
    increment: 60,
  });

  // Register the SDK into settings
  if (zephyrSDKPath) {
    await ictx.withRegistration(() => registerZephyrSDK(zephyrSDKPath));
    await ictx.cleanupDownloads();
  }
  return zephyrSDKPath;
}

/** What a global SDK install passes to west sdk install, or to the setup script of an SDK already there. */
export function globalSdkComponents(sdkType: string, toolchains: readonly string[]): {
  /** west sdk install -t; undefined installs every GNU toolchain. */
  gnuToolchains: string[] | undefined;
  /** west sdk install -T. */
  noGnuToolchains: boolean;
  /** setup -t for an SDK already installed. */
  setupGnuToolchains: string[] | undefined;
} {
  const gnuToolchains = sdkType === 'minimal'
    ? toolchains.map(mapToolchainIdToPackage)
    : undefined;
  return {
    gnuToolchains,
    noGnuToolchains: sdkType === 'minimal' && (gnuToolchains?.length ?? 0) === 0,
    setupGnuToolchains: sdkType === 'minimal' ? gnuToolchains : ['all'],
  };
}

/**
 * The globally discoverable SDK of this version, after detecting them again.
 * Like west sdk install, a global install reuses it: its setup script runs
 * with the requested components instead.
 */
export async function findGlobalSdkOfVersion(version: string): Promise<GlobalZephyrSdkInstallation | undefined> {
  const detected = await refreshGlobalSdkDetection();
  return detected.find(sdk => sdk.version.trim() === version);
}

/** Add GNU toolchains (friendly or package ids) to an installed Zephyr SDK. Returns the ids handled. */
export async function addGnuToolchainsToSdk(
  ictx: ToolchainInstallContext,
  sdk: ZephyrSdkInstallation,
  selected: string[],
): Promise<string[]> {
  const { context, reporter, token, hooks } = ictx;
  const version = sdk.version.trim();
  const dest = sdk.getGnuToolchainsRootPath();
  const added: string[] = [];
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  for (const toolchain of selected) {
    // generateSdkUrls returns [baseMinimalSdkUrl, toolchainUrl]; keep only the toolchain package.
    const url = generateSdkUrls('minimal', version, [toolchain], false)[1];
    if (!url) {
      continue;
    }
    reporter.report({ message: `Download ${url}` });
    const downloadedFileUri = await download(url, dest, context, reporter, token, hooks);
    reporter.report({ message: `Extracting ${downloadedFileUri.fsPath}` });
    await extractSDK(downloadedFileUri.fsPath, dest, reporter, token);
    // The extracted `<prefix>/` directory is the source of truth for the tree;
    // a refresh re-scans the toolchains root and picks it up.
    added.push(toolchain);
  }
  await ictx.cleanupDownloads();
  return added;
}

/** The LLVM package of an SDK release for this host, or undefined when there is none. */
export function sdkLlvmUrl(version: string): string | undefined {
  // generateSdkUrls returns [baseMinimalSdkUrl, llvmUrl]; keep only the LLVM package.
  return generateSdkUrls('minimal', version, [], true)[1];
}

/** Install the LLVM toolchain of an SDK release into an installed v1+ Zephyr SDK. */
export async function installLlvmIntoSdk(
  ictx: ToolchainInstallContext,
  sdk: ZephyrSdkInstallation,
  url: string,
): Promise<void> {
  const { context, reporter, token, hooks } = ictx;
  // The LLVM archive already contains its own llvm/ folder, so extract at the SDK root.
  const dest = sdk.rootUri.fsPath;
  reporter.report({ message: `Download ${url}` });
  const downloadedFileUri = await download(url, dest, context, reporter, token, hooks);
  reporter.report({ message: `Extracting ${downloadedFileUri.fsPath}` });
  await extractSDK(downloadedFileUri.fsPath, dest, reporter, token);
  await ictx.cleanupDownloads();
}

// Arm GNU

export interface ArmGnuToolchainInstall {
  version: string;
  targetTriple: ArmGnuBareMetalTargetTriple;
  downloadUrl: string;
  /** Where the archive is downloaded from, as the wizard passes it. */
  parentPath: string;
  /** The empty folder the release is extracted into. */
  installPath: string;
}

/**
 * Download an Arm GNU Toolchain release, extract it and register it. Returns
 * the toolchain root, or '' when the archive had no folder to register.
 */
export async function installArmGnuToolchain(
  ictx: ToolchainInstallContext,
  opts: ArmGnuToolchainInstall,
): Promise<string> {
  const { context, reporter, token, hooks } = ictx;
  reporter.report({
    message: `Download ${opts.downloadUrl}`,
    increment: 0,
  });
  const downloadedFileUri = await download(opts.downloadUrl, opts.parentPath, context, reporter, token, hooks);

  reporter.report({
    message: `Extracting ${downloadedFileUri}`,
    increment: 60,
  });
  let toolchainPath = await extractSDK(downloadedFileUri.fsPath, opts.installPath, reporter, token);
  if (!ArmGnuToolchainInstallation.isArmGnuPath(toolchainPath) && ArmGnuToolchainInstallation.isArmGnuPath(opts.installPath)) {
    toolchainPath = opts.installPath;
  }

  if (toolchainPath) {
    if (!ArmGnuToolchainInstallation.isArmGnuPath(toolchainPath)) {
      throw new Error("The extracted folder is not a valid Arm GNU toolchain.");
    }
    await ictx.withRegistration(() => registerArmGnuToolchain({
      toolchainPath,
      targetTriple: opts.targetTriple,
      version: opts.version,
    }));
    await ictx.cleanupDownloads();
  }

  reporter.report({
    message: "Importing ARM GNU Toolchain done",
    increment: 40,
  });
  return toolchainPath;
}
