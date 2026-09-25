// The toolchain install and removal functions the Add Toolchain wizard, the
// Toolchains view and the agent tools share. The view commands show exactly
// the messages these return and report the progress these send, so the texts
// and their order are pinned here. Nothing is downloaded: the download hook
// refuses every URL, which stops a run right where its first download starts.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  globalSdkComponents, installSdkToLocation, installStandaloneRustToolchain, planRustLlvm, rustCToolchainLinkError,
  sdkLlvmUrl, ToolchainInstallContext,
} from '../../utils/zephyr/toolchainInstall';
import { deleteArmGnuToolchainFiles, deleteRustToolchainFiles, deleteZephyrSdkFiles } from '../../utils/zephyr/toolchainRemoval';
import { getSdkHostTarget } from '../../utils/zephyr/sdkUtils';
import { buildLlvmDownloadUrl, getLlvmTopLevelDirName } from '../../utils/zephyr/rustToolchainUtils';

const vscodeStub = require('vscode') as Record<string, any>;

type Lists = Record<string, unknown[]>;

/** Settings held in memory: zephyr-workbench.listSDKs and friends. */
function useSettings(): { lists: Lists; writes: string[] } {
  const state = { lists: {} as Lists, writes: [] as string[] };
  let saved: unknown;
  beforeEach(() => {
    state.lists = {};
    state.writes = [];
    saved = vscodeStub.workspace.getConfiguration;
    vscodeStub.workspace.getConfiguration = () => ({
      get: (key: string, fallback?: unknown) => (key in state.lists ? JSON.parse(JSON.stringify(state.lists[key])) : fallback),
      update: async (key: string, value: unknown[]) => {
        state.lists[key] = JSON.parse(JSON.stringify(value));
        state.writes.push(key);
      },
    });
  });
  afterEach(() => {
    vscodeStub.workspace.getConfiguration = saved;
  });
  return state;
}

function tempDir(name: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `zw-${name}-`)));
}

/** An install context that records everything and refuses every download. */
function recordingContext(events: string[]): ToolchainInstallContext {
  return {
    context: {} as ToolchainInstallContext['context'],
    reporter: {
      report: value => events.push(`report ${value.message ?? ''}${value.increment !== undefined ? ` +${value.increment}` : ''}`),
      warn: message => events.push(`warn ${message}`),
    },
    token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as never,
    hooks: {
      beforeDownload: url => {
        events.push(`download ${url}`);
        throw new Error('no network in unit tests');
      },
    },
    cleanupDownloads: async () => { events.push('cleanup'); },
    removeFolder: async dir => {
      events.push(`remove ${dir}`);
      fs.rmSync(dir, { recursive: true, force: true });
    },
    withRegistration: async work => {
      events.push('register');
      return work();
    },
  };
}

describe('utils/zephyr/toolchainInstall', () => {
  it('keeps the messages the wizard shows for a bad Rust C toolchain link', () => {
    assert.equal(rustCToolchainLinkError(undefined, '/x'), 'Missing linked C toolchain, please select a Zephyr SDK or ARM GNU toolchain.');
    assert.equal(rustCToolchainLinkError('zephyr-sdk', '/no/such/sdk'), 'The linked Zephyr SDK is not valid: /no/such/sdk');
    assert.equal(rustCToolchainLinkError('gnuarmemb', '/no/such/gnu'), 'The linked Arm GNU toolchain is not valid: /no/such/gnu');
    assert.equal(rustCToolchainLinkError('iar', '/x'), 'Unknown linked C toolchain type: iar');
    const sdk = tempDir('sdk');
    fs.writeFileSync(path.join(sdk, 'sdk_version'), '0.17.4\n');
    assert.equal(rustCToolchainLinkError('zephyr-sdk', sdk), undefined);
  });

  it('plans the host LLVM as the wizard did: the version is required, a copy already there is reused', () => {
    assert.deepEqual(planRustLlvm('/dest', undefined), { error: 'Missing LLVM version, please choose the LLVM release to download.' });
    const url = buildLlvmDownloadUrl('20.1.8');
    if (!url) {
      assert.deepEqual(planRustLlvm('/dest', '20.1.8'), { error: 'LLVM download is not supported on this platform; select a local LLVM instead.' });
      return;
    }
    const dest = tempDir('llvm');
    const plan = planRustLlvm(dest, '20.1.8');
    assert.deepEqual(plan, { kind: 'download', llvmRoot: path.join(dest, getLlvmTopLevelDirName('20.1.8')!), url, destDir: dest });
    // A libclang in the expected folder means an earlier import extracted it.
    const libDir = path.join(dest, getLlvmTopLevelDirName('20.1.8')!, process.platform === 'win32' ? 'bin' : 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(libDir, process.platform === 'win32' ? 'libclang.dll' : process.platform === 'darwin' ? 'libclang.dylib' : 'libclang.so'), '');
    assert.equal((planRustLlvm(dest, '20.1.8') as { kind: string }).kind, 'reuse');
  });

  it('maps global SDK components exactly as the global install command did', () => {
    assert.deepEqual(globalSdkComponents('full', ['arm']), { gnuToolchains: undefined, noGnuToolchains: false, setupGnuToolchains: ['all'] });
    assert.deepEqual(globalSdkComponents('minimal', ['arm', 'riscv64']), {
      gnuToolchains: ['arm-zephyr-eabi', 'riscv64-zephyr-elf'], noGnuToolchains: false, setupGnuToolchains: ['arm-zephyr-eabi', 'riscv64-zephyr-elf'],
    });
    assert.deepEqual(globalSdkComponents('minimal', []), { gnuToolchains: [], noGnuToolchains: true, setupGnuToolchains: [] });
  });

  it('offers SDK LLVM only from 1.0', () => {
    if (!getSdkHostTarget()) {
      return;
    }
    assert.match(sdkLlvmUrl('1.0.0') ?? '', /\/v1\.0\.0\/toolchain_llvm_/);
    assert.equal(sdkLlvmUrl('0.17.4'), undefined);
  });

  it('starts an SDK install with the progress the notification always showed', async () => {
    if (!getSdkHostTarget()) {
      return;
    }
    const events: string[] = [];
    const parent = tempDir('sdk-parent');
    await assert.rejects(installSdkToLocation(recordingContext(events), {
      sdkType: 'minimal', sdkVersion: '0.17.4', toolchains: ['arm'], parentPath: parent,
    }), /no network/);
    assert.match(events[0], /^report Download https:\/\/github\.com\/zephyrproject-rtos\/sdk-ng\/releases\/download\/v0\.17\.4\/zephyr-sdk-0\.17\.4_.*_minimal\..* \+0$/);
    assert.match(events[1], /^download /);
    // Nothing was registered, and the download folder is left to the caller.
    assert.ok(!events.includes('register') && !events.includes('cleanup'));
  });

  it('deletes a partial standalone Rust install, staging folder included, and names the archive that failed', async () => {
    const events: string[] = [];
    const parent = tempDir('rust');
    const installPath = path.join(parent, 'rust-1.87.0');
    fs.mkdirSync(installPath);
    const track = { currentUrl: '' };
    await assert.rejects(installStandaloneRustToolchain(recordingContext(events), {
      version: '1.87.0', targets: ['thumbv7em-none-eabi'], hostTriple: 'x86_64-unknown-linux-gnu', parentPath: parent,
      installPath, cToolchainType: 'zephyr-sdk', cToolchainPath: '/sdk', llvmRoot: '/llvm',
    }, track), /no network/);
    assert.equal(track.currentUrl, 'https://static.rust-lang.org/dist/rustc-1.87.0-x86_64-unknown-linux-gnu.tar.xz');
    assert.deepEqual(events.filter(event => event.startsWith('remove ')), [
      `remove ${installPath}`,
      `remove ${path.join(installPath, '.zw-rust-staging')}`,
    ]);
    assert.ok(!fs.existsSync(installPath));
    assert.ok(!events.includes('register'));
  });
});

describe('utils/zephyr/toolchainRemoval', () => {
  const settings = useSettings();

  // A deletion detects global SDKs again and cleans the CMake package
  // registry: both only ever see an empty temporary home here.
  let savedHome: string | undefined;
  let savedUri: unknown;
  before(() => {
    savedHome = process.env.HOME;
    process.env.HOME = tempDir('home');
    savedUri = vscodeStub.Uri;
    vscodeStub.Uri = class FakeUri {
      constructor(readonly fsPath: string) {}
      static file(fsPath: string) { return new FakeUri(fsPath); }
      static joinPath(base: FakeUri, ...parts: string[]) { return new FakeUri(path.join(base.fsPath, ...parts)); }
    };
  });
  after(() => {
    process.env.HOME = savedHome;
    vscodeStub.Uri = savedUri;
  });

  it('deletes a registered SDK as the view did: unregister, then the folder, then the registry', async () => {
    const sdk = tempDir('sdk-del');
    settings.lists.listSDKs = [sdk, '/other/sdk'];
    const order: string[] = [];
    const result = await deleteZephyrSdkFiles(sdk, {
      unregister: true,
      remove: dir => {
        order.push(`remove after ${settings.writes.join(',') || 'nothing'}`);
        fs.rmSync(dir, { recursive: true, force: true });
        return 'removed';
      },
    });
    assert.deepEqual(order, ['remove after listSDKs']);
    assert.deepEqual(settings.lists.listSDKs, ['/other/sdk']);
    assert.equal(result.removal, 'removed');
    assert.equal(typeof result.registryEntriesRemoved, 'number');
  });

  it('goes on with the registry cleanup after a failed folder deletion only when asked to', async () => {
    const reported: unknown[] = [];
    const failing = () => { throw new Error('in use'); };
    const result = await deleteZephyrSdkFiles('/no/such/sdk', { unregister: false, remove: failing, onRemoveError: error => reported.push(error) });
    assert.equal(reported.length, 1);
    assert.equal(result.removal, undefined);
    await assert.rejects(deleteZephyrSdkFiles('/no/such/sdk', { unregister: false, remove: failing }), /in use/);
  });

  it('unregisters an Arm GNU Toolchain before deleting its folder', async () => {
    const folder = tempDir('arm');
    settings.lists.listArmGnuToolchains = [{ toolchainPath: folder, targetTriple: 'arm-none-eabi' }];
    let listAtRemoval: unknown;
    await deleteArmGnuToolchainFiles(folder, { remove: dir => { listAtRemoval = settings.lists.listArmGnuToolchains; fs.rmSync(dir, { recursive: true }); } });
    assert.deepEqual(listAtRemoval, []);
    assert.ok(!fs.existsSync(folder));
  });

  it('deletes the folder of a standalone Rust toolchain, then unregisters it', async () => {
    const folder = tempDir('rust-del');
    settings.lists.listRustToolchains = [{ toolchainPath: folder, llvmPath: '/llvm' }];
    const result = await deleteRustToolchainFiles(folder, undefined, {
      remove: dir => { fs.rmSync(dir, { recursive: true }); return 'removed'; },
      warn: () => assert.fail('no warning expected'),
    });
    assert.deepEqual(result, { method: 'folder', removal: 'removed', unregistered: true });
    assert.deepEqual(settings.lists.listRustToolchains, []);
  });

  it('looks the registration up right when it unregisters, and skips that step when it is gone', async () => {
    const stored = (key: string, folder: string) =>
      (settings.lists[key] as Array<{ toolchainPath: string }> | undefined)?.find(entry => entry.toolchainPath === folder)?.toolchainPath;
    // The view removes a Rust registration while the folder is being deleted:
    // the lookup comes after the deletion, so it sees that.
    const rust = tempDir('rust-gone');
    settings.lists.listRustToolchains = [{ toolchainPath: rust }];
    const rustResult = await deleteRustToolchainFiles(rust, undefined, {
      remove: dir => { settings.lists.listRustToolchains = []; fs.rmSync(dir, { recursive: true }); return 'removed'; },
      warn: () => assert.fail('no warning expected'),
      unregister: () => stored('listRustToolchains', rust),
    });
    assert.deepEqual(rustResult, { method: 'folder', removal: 'removed', unregistered: false });
    assert.ok(!fs.existsSync(rust));

    const arm = tempDir('arm-gone');
    settings.lists.listArmGnuToolchains = [{ toolchainPath: '/other/arm' }];
    const armResult = await deleteArmGnuToolchainFiles(arm, {
      remove: dir => { fs.rmSync(dir, { recursive: true }); return 'removed'; },
      unregister: () => stored('listArmGnuToolchains', arm),
    });
    assert.deepEqual(armResult, { removal: 'removed', unregistered: false });
    assert.ok(!fs.existsSync(arm));
    assert.deepEqual(settings.lists.listArmGnuToolchains, [{ toolchainPath: '/other/arm' }]);

    const sdk = tempDir('sdk-gone');
    settings.lists.listSDKs = [];
    const sdkResult = await deleteZephyrSdkFiles(sdk, { unregister: () => undefined, remove: dir => fs.rmSync(dir, { recursive: true }) });
    assert.equal(sdkResult.unregistered, false);
    assert.ok(!fs.existsSync(sdk));
    assert.deepEqual(settings.writes, []);

    // The view passes no lookup: a registration already gone still fails the
    // deletion before anything is deleted, as it always did.
    const kept = tempDir('arm-view');
    await assert.rejects(deleteArmGnuToolchainFiles(kept, { remove: dir => fs.rmSync(dir, { recursive: true }) }), /is not found/);
    assert.ok(fs.existsSync(kept));
    fs.rmSync(kept, { recursive: true });
  });
});
