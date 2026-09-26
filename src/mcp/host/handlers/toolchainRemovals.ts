// remove_or_delete what "toolchain" (unregister, keep the files) and
// "toolchain_files" (delete from disk), through the functions the Toolchains
// view uses. An IAR toolchain is licensed software the workbench can never put
// back, and the SDK of the host tools belongs to them: neither is ever deleted.

import {
  ArmGnuToolchainInstallation, RustToolchainInstallation, ZephyrSdkInstallation,
} from '../../../models/ToolchainInstallations';
import { removeDirectory } from '../../../utils/utils';
import { unregisterArmGnuToolchain } from '../../../utils/zephyr/armGnuToolchainUtils';
import { getCachedGlobalSdks, getGlobalSdkSources } from '../../../utils/zephyr/globalSdkService';
import { unregisterRustToolchain } from '../../../utils/zephyr/rustToolchainUtils';
import { unregisterIARToolchain } from '../../../utils/zephyr/sdkUtils';
import {
  deleteArmGnuToolchainFiles, deleteRustToolchainFiles, deleteZephyrSdkFiles, unregisterZephyrSdk,
} from '../../../utils/zephyr/toolchainRemoval';
import { isInside, normalizeForCompare } from '../../core/argSafety';
import { McpToolError } from '../../core/errors';
import { logSafe } from '../../core/redact';
import { ToolContext } from '../../core/toolSpec';
import { HostDeps } from './deps';
import {
  assertListedPath, bool, checkTypes, confirmationOf, confirmationRequired, invalid, isHomeOrRoot, num,
  requireString, str, toolchainSubject,
} from './toolchainArgs';
import {
  applicationsUsing, findListed, iarRegistrationHasToken, isMissing, ListedToolchain, MissingEntry,
  readToolchainInventory, sameSdkPath, SdkEntry, storedRegistrationPath, storedSdkPath, toolchainsDependingOn, ToolchainFamily,
  ToolchainInventory,
} from './toolchainInventory';
import { assertNoToolchainJob, runToolchainJob, toolchainFilesLock } from './toolchainJobs';

type Ctx = ToolContext<HostDeps>;

const LABEL: Record<ToolchainFamily, string> = {
  zephyr_sdk: 'Zephyr SDK',
  arm_gnu: 'Arm GNU Toolchain',
  iar: 'IAR toolchain',
  rust: 'Rust toolchain',
};

/** The one listed toolchain `path` names. */
function resolveListed(inventory: ToolchainInventory, target: string): ListedToolchain | MissingEntry {
  const found = findListed(inventory, target);
  if (found.length === 0) {
    throw invalid(`No toolchain list_toolchains lists is at "${logSafe(target, 300)}".`,
      'Call list_toolchains and pass one of the paths it returns, exactly.');
  }
  // A registration whose folder is gone is only ever one entry; two live ones
  // at one folder would be a hand-edited settings file.
  const live = found.filter(entry => !isMissing(entry));
  if (live.length > 1) {
    throw invalid(`"${logSafe(target, 300)}" is registered as ${live.map(entry => LABEL[entry.family]).join(' and ')}.`,
      'Ask the user to remove the extra registration from the Toolchains & Host Tools view.', { families: live.map(entry => entry.family) });
  }
  return live[0] ?? found[0];
}

function describe(entry: ListedToolchain | MissingEntry): { family: ToolchainFamily; path: string } {
  return { family: entry.family, path: entry.path };
}

async function usageOf(ctx: Ctx, entry: ListedToolchain | MissingEntry, inventory: ToolchainInventory) {
  const apps = await ctx.deps.services.listApplications();
  return {
    usedBy: applicationsUsing(entry, apps),
    linkedBy: toolchainsDependingOn(entry, inventory),
  };
}

function refuseWhileUsed(usedBy: string[], force: boolean, label: string): void {
  if (usedBy.length > 0 && !force) {
    throw invalid(`${usedBy.length} application(s) of this window build with this ${label}.`,
      'Switch them to another toolchain with configure (target "app", action "update", toolchain) first, or pass force true to go ahead; they then need another toolchain before they build again.',
      { used_by: usedBy });
  }
}

/** remove_or_delete what "toolchain": unregister, keep the files. */
async function unregisterToolchainEntry(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  // Only compared with the listed paths: the listed entry is what is acted on.
  const target = assertListedPath(requireString(args, 'path', 'what "toolchain"'), 'path');
  const force = bool(args.force) === true;
  const inventory = await readToolchainInventory();
  const entry = resolveListed(inventory, target);
  const label = LABEL[entry.family];

  let stored = entry.path;
  if (entry.family === 'zephyr_sdk') {
    const sdk = entry as SdkEntry | MissingEntry;
    if (!isMissing(sdk) && sdk.internal) {
      throw invalid('This Zephyr SDK belongs to the host tools install and is never removed.', undefined, { internal: true });
    }
    const registered = storedSdkPath(entry.path);
    if (!registered) {
      throw invalid(`The Zephyr SDK at ${entry.path} is not registered: the build system finds it globally by itself.`,
        'There is nothing to unregister. Delete it from disk with what "toolchain_files" if it must go.', { global: true });
    }
    stored = registered;
  }
  const hasToken = entry.family === 'iar' ? iarRegistrationHasToken(entry.path) : undefined;
  const { usedBy, linkedBy } = await usageOf(ctx, entry, inventory);
  refuseWhileUsed(usedBy, force, label);
  const base = {
    what: 'toolchain', ...describe(entry),
    ...(isMissing(entry) ? { folder: entry.reason } : {}),
    ...(usedBy.length > 0 ? { used_by: usedBy } : {}),
    ...(linkedBy.length > 0 ? { linked_by: linkedBy } : {}),
    ...(hasToken !== undefined ? { has_token: hasToken } : {}),
  };

  if (args.dry_run === true) {
    return {
      ...base, dry_run: true, would_unregister: true, files_kept: true,
      ...(entry.family === 'zephyr_sdk' && !isMissing(entry) && (entry as SdkEntry).global ? { reappears_as_global: true } : {}),
      ...(hasToken ? { token_lost: true } : {}),
      confirmation_required: confirmationRequired(ctx, args),
      next: hasToken
        ? 'Its licence token is lost with the registration, and the agent cannot restore it. Ask the user first, then call remove_or_delete again without dry_run.'
        : 'Call remove_or_delete again without dry_run to unregister it.',
    };
  }

  const summary = `unregister the ${label} at ${entry.path} (its files stay on disk)${hasToken ? ' and forget its stored licence token' : ''}`;
  const outcome = await ctx.deps.confirmations.require(ctx, args, toolchainSubject(summary, args, entry.path));
  const confirmation = confirmationOf(ctx, outcome);

  let unregistered = false;
  await ctx.deps.services.withToolchainSettingsLock(async () => {
    // Read again under the lock: another window or call may have removed it
    // while the user was asked.
    const current = entry.family === 'zephyr_sdk' ? storedSdkPath(stored) : storedRegistrationPath(entry.family, stored);
    if (!current) {
      return;
    }
    switch (entry.family) {
      case 'zephyr_sdk':
        // A globally discoverable SDK reappears as global at once.
        await unregisterZephyrSdk(current);
        break;
      case 'arm_gnu':
        await unregisterArmGnuToolchain(current);
        break;
      case 'iar':
        await unregisterIARToolchain(current);
        break;
      case 'rust':
        await unregisterRustToolchain(current);
        break;
    }
    unregistered = true;
  });
  if (!unregistered) {
    return {
      ...base,
      unregistered: false,
      already_unregistered: true,
      files_kept: true,
      ...(confirmation ? { confirmation } : {}),
      next: 'It was unregistered meanwhile, so nothing changed. Call list_toolchains to see what is left.',
    };
  }
  await ctx.deps.refreshViews(['toolchains']);

  const stillGlobal = entry.family === 'zephyr_sdk'
    && getCachedGlobalSdks().some(sdk => sameSdkPath(sdk.rootUri.fsPath, entry.path));
  return {
    ...base,
    unregistered: true,
    files_kept: true,
    ...(entry.family === 'zephyr_sdk' ? { still_listed_as_global: stillGlobal } : {}),
    ...(hasToken ? { token_lost: true } : {}),
    ...(confirmation ? { confirmation } : {}),
    next: stillGlobal
      ? 'It stays listed as a global Zephyr SDK, which the build system finds by itself.'
      : entry.family === 'iar'
        ? 'Done. To use it again, the user adds it in the Add Toolchain wizard (open_in_workbench target "add_toolchain"), where a licence token is entered.'
        : 'Done. Register it again with manage_toolchain action "register" if needed.',
  };
}

/** Whether a folder holds that kind of toolchain now. */
function looksLike(entry: ListedToolchain): boolean {
  switch (entry.family) {
    case 'zephyr_sdk': return ZephyrSdkInstallation.isSdkPath(entry.path);
    case 'arm_gnu': return ArmGnuToolchainInstallation.isArmGnuPath(entry.path);
    case 'rust': return RustToolchainInstallation.isRustPath(entry.path);
    default: return false;
  }
}

/** remove_or_delete what "toolchain_files": delete from disk, as a job. */
async function deleteToolchainEntry(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  const target = assertListedPath(requireString(args, 'path', 'what "toolchain_files"'), 'path');
  const force = bool(args.force) === true;
  const inventory = await readToolchainInventory();
  const entry = resolveListed(inventory, target);
  if (isMissing(entry)) {
    throw invalid(entry.reason === 'folder_gone'
      ? `The folder of the ${LABEL[entry.family]} at ${entry.path} is already gone.`
      : `${entry.path} no longer looks like a ${LABEL[entry.family]}, so it is not deleted.`,
    'Remove the registration with what "toolchain".');
  }
  if (entry.family === 'iar') {
    throw invalid('An IAR toolchain is never deleted from disk by an agent: it is licensed software the workbench cannot reinstall.',
      'Unregister it with what "toolchain" if it must go, and ask the user to delete its files themselves.');
  }
  if (entry.family === 'zephyr_sdk' && (entry as SdkEntry).internal) {
    throw invalid('This Zephyr SDK belongs to the host tools install and is never deleted.', undefined, { internal: true });
  }
  const label = LABEL[entry.family];
  if (!looksLike(entry)) {
    throw invalid(`${entry.path} no longer looks like a ${label}, so it is not deleted.`);
  }
  // A toolchain folder never is, or holds, the home folder, a filesystem root,
  // an application or a west workspace.
  const roots = await ctx.deps.services.knownRoots();
  const holding = roots.filter(root => isInside(root, entry.path));
  if (isHomeOrRoot(entry.path) || holding.length > 0) {
    throw invalid(`${entry.path} holds more than a toolchain, so it is not deleted.`,
      'Ask the user to delete the toolchain themselves.', holding.length > 0 ? { holds: holding } : undefined);
  }
  const { usedBy, linkedBy } = await usageOf(ctx, entry, inventory);
  refuseWhileUsed(usedBy, force, label);

  const sdk = entry.family === 'zephyr_sdk' ? entry as SdkEntry : undefined;
  const storedSdk = sdk ? storedSdkPath(sdk.path) : undefined;
  const sources = sdk ? (await getGlobalSdkSources(sdk.path)) ?? [] : [];
  const rust = entry.family === 'rust' ? inventory.rust.find(candidate => candidate.path === entry.path) : undefined;
  const rustupToolchain = rust?.registration?.rustupToolchain;
  const llvmLeft = rust?.installation.llvmPath;
  const base = {
    what: 'toolchain_files', ...describe(entry),
    ...(usedBy.length > 0 ? { used_by: usedBy } : {}),
    ...(linkedBy.length > 0 ? { linked_by: linkedBy } : {}),
    ...(sdk ? { registered: !!storedSdk, global: sdk.global } : {}),
    ...(rust ? { method: rustupToolchain ? 'rustup' : 'folder', ...(rustupToolchain ? { rustup_toolchain: rustupToolchain } : {}) } : {}),
    ...(llvmLeft ? { llvm_left: llvmLeft } : {}),
    ...(sources.includes('env') ? { env_var_still_points_here: true } : {}),
  };

  if (args.dry_run === true) {
    return {
      ...base, dry_run: true, would_delete: entry.path,
      ...(sdk ? { would_remove_cmake_registry_entries: sources.includes('cmake-registry') } : {}),
      confirmation_required: confirmationRequired(ctx, args),
      next: 'Call remove_or_delete again without dry_run to delete it.',
    };
  }

  assertNoToolchainJob(ctx.deps.jobs);
  const outcome = await ctx.deps.confirmations.require(ctx, args, toolchainSubject(`delete the ${label} at ${entry.path} from disk`, args, entry.path));
  const confirmation = confirmationOf(ctx, outcome);
  assertNoToolchainJob(ctx.deps.jobs);

  const busy = (removal: unknown) => {
    if (removal === 'busy') {
      throw new McpToolError('BUSY_EXTERNAL', `Some files in ${entry.path} are in use, so it was only partly deleted.`, {
        hint: 'Ask the user to close any terminal, build or debug session using that toolchain, then call remove_or_delete again.',
      });
    }
  };
  // What was done with the registration, which another window or the view may
  // have removed while the user was asked or the folder was deleted.
  const registration = (unregistered: boolean, wasRegistered: boolean) =>
    unregistered ? { unregistered: true } : wasRegistered ? { unregistered: false, already_unregistered: true } : {};
  return runToolchainJob(ctx, {
    kind: 'clean',
    lockKey: toolchainFilesLock(entry.path),
    requestKey: `clean:toolchain:${normalizeForCompare(entry.path)}`,
    command: `delete ${entry.path}`,
    step: `Delete ${label}`,
    run: async ({ log, warnings }) => {
      log(`Deleting ${entry.path}\n`);
      const settings = ctx.deps.services;
      // Each removal reads the registration again under the lock, right when
      // it unregisters, and skips that step when it is gone.
      if (sdk) {
        // As the view does: unregister, delete the folder, remove its CMake
        // package registry entries, detect global SDKs again.
        const { removal, registryEntriesRemoved, unregistered } = await settings.withToolchainSettingsLock(() =>
          deleteZephyrSdkFiles(storedSdk ?? entry.path, { unregister: () => storedSdkPath(sdk.path), remove: removeDirectory }));
        busy(removal);
        return { ...base, deleted: entry.path, ...registration(unregistered, !!storedSdk), cmake_registry_entries_removed: registryEntriesRemoved };
      }
      if (entry.family === 'arm_gnu') {
        const { removal, unregistered } = await settings.withToolchainSettingsLock(() => deleteArmGnuToolchainFiles(entry.path, {
          remove: removeDirectory,
          unregister: () => storedRegistrationPath('arm_gnu', entry.path),
        }));
        busy(removal);
        return { ...base, deleted: entry.path, ...registration(unregistered, true) };
      }
      const result = await settings.withToolchainSettingsLock(() => deleteRustToolchainFiles(entry.path, rustupToolchain, {
        remove: removeDirectory,
        warn: message => { warnings.push(message); log(`Warning: ${message}\n`); },
        unregister: () => storedRegistrationPath('rust', entry.path),
      }));
      busy(result.removal);
      return { ...base, deleted: entry.path, method: result.method, ...registration(result.unregistered, true) };
    },
    next: view => view.status === 'succeeded'
      ? (sources.includes('env')
        ? 'Deleted. ZEPHYR_SDK_INSTALL_DIR still points at this folder: tell the user to unset it.'
        : 'Deleted. Call list_toolchains to see what is left.')
      : `The deletion ${view.status === 'cancelled' ? 'was cancelled' : 'failed'}: see result.error and the log.`,
  }, num(args.wait_sec) ?? ctx.deps.defaultWaitSeconds, confirmation ? { confirmation } : {});
}

/** remove_or_delete with what "toolchain" or "toolchain_files". */
export async function removeToolchainEntry(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  checkTypes(args, { strings: ['path'], booleans: ['force', 'dry_run'] });
  return str(args.what) === 'toolchain_files' ? deleteToolchainEntry(args, ctx) : unregisterToolchainEntry(args, ctx);
}
