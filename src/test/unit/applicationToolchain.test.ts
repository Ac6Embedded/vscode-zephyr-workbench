// The toolchain choices an application is offered, shared by the
// change-toolchain quick step and configure target "app" action "update",
// and the change they make, against registered toolchains on disk.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ZephyrApplication } from '../../models/ZephyrApplication';
import { changeToolchainQuickStep } from '../../quicksteps/changeToolchainQuickStep';
import {
  applyApplicationToolchain, hasApplicationToolchainChanged, lacksCToolchain, listApplicationToolchainChoices, resolveChoiceSdk,
} from '../../utils/zephyr/applicationToolchain';
import {
  FakeUri, FakeWindow, installFakeWindow, makeApplicationFolder, makeArmGnu, makeSdk, makeWestWorkspace, readSettingsFile, tempDir,
  writeFile, writeSettingsFile,
} from './appTestWorkspace';

const stub = require('vscode') as { window: Record<string, unknown> };

interface Fixture {
  window: FakeWindow;
  ws: string;
  sdkLlvm: string;
  sdkPlain: string;
  iar: string;
  armGnu: string;
  rustLinked: string;
  rustUnlinked: string;
  app: string;
}

function fixture(): Fixture {
  const root = tempDir('zw-toolchains-');
  const ws = makeWestWorkspace(path.join(root, 'ws'));
  const sdkLlvm = makeSdk(path.join(root, 'zephyr-sdk-1.0.0'), '1.0.0', { llvm: true });
  const sdkPlain = makeSdk(path.join(root, 'zephyr-sdk-0.17.0'), '0.17.0');
  const iar = path.join(root, 'iar');
  writeFile(path.join(iar, 'bin', process.platform === 'win32' ? 'iccarm.exe' : 'iccarm'));
  const armGnu = makeArmGnu(path.join(root, 'arm-gnu-toolchain-14.2.rel1-x86_64-arm-none-eabi'));
  const rust = (dir: string) => {
    const exe = process.platform === 'win32' ? '.exe' : '';
    writeFile(path.join(dir, 'bin', `rustc${exe}`));
    writeFile(path.join(dir, 'bin', `cargo${exe}`));
    return dir;
  };
  const rustLinked = rust(path.join(root, 'rust-linked'));
  const rustUnlinked = rust(path.join(root, 'rust-unlinked'));
  const app = makeApplicationFolder(path.join(root, 'app'));
  writeSettingsFile(app, {
    'zephyr-workbench.westWorkspace': ws,
    'zephyr-workbench.toolchain': 'zephyr',
    'zephyr-workbench.sdk': sdkPlain,
    'zephyr-workbench.build.configurations': [{ name: 'primary', board: 'custom_board', active: 'true' }],
  });
  const window = installFakeWindow([app]);
  window.user['zephyr-workbench.listSDKs'] = [sdkLlvm, sdkPlain];
  window.user['zephyr-workbench.listIARs'] = [{ iarPath: iar, zephyrSdkPath: sdkPlain, token: 'secret-token' }];
  window.user['zephyr-workbench.listArmGnuToolchains'] = [{ toolchainPath: armGnu, targetTriple: 'arm-none-eabi', version: '14.2.rel1' }];
  window.user['zephyr-workbench.listRustToolchains'] = [
    { toolchainPath: rustLinked, version: '1.85.0', targets: ['thumbv7em-none-eabihf'], cToolchainType: 'zephyr-sdk', cToolchainPath: sdkLlvm },
    { toolchainPath: rustUnlinked, version: '1.80.0', targets: [] },
  ];
  return { window, ws, sdkLlvm, sdkPlain, iar, armGnu, rustLinked, rustUnlinked, app };
}

function applicationOf(f: Fixture): ZephyrApplication {
  ZephyrApplication.clearApplicationWorkspaceCache();
  return new ZephyrApplication({ uri: FakeUri.file(f.app), name: 'app', index: 0 } as never, f.app);
}

describe('applicationToolchain', () => {
  let f: Fixture;
  const savedWindow: Record<string, unknown> = {};
  beforeEach(() => {
    f = fixture();
    for (const name of ['showQuickPick', 'showErrorMessage', 'showWarningMessage']) {
      savedWindow[name] = stub.window[name];
    }
  });
  afterEach(() => {
    f.window.restore();
    Object.assign(stub.window, savedWindow);
  });

  it('lists the SDKs, then the IAR, Arm GNU and Rust toolchains, as the quick step does', async () => {
    const choices = await listApplicationToolchainChoices(applicationOf(f));
    assert.deepEqual(choices.map(choice => [choice.family, choice.label, choice.path]), [
      ['zephyr_sdk', 'Zephyr SDK 1.0.0', f.sdkLlvm],
      ['zephyr_sdk', 'Zephyr SDK 0.17.0', f.sdkPlain],
      ['iar', 'IAR-iar', f.iar],
      ['arm_gnu', 'Arm GNU 14.2.Rel1 (arm-none-eabi)', f.armGnu],
      ['rust', 'Rust 1.85.0', f.rustLinked],
      ['rust', 'Rust 1.80.0', f.rustUnlinked],
    ]);
    const [sdkLlvm, , iar, armGnu, rustLinked, rustUnlinked] = choices;
    assert.deepEqual([sdkLlvm.selectedVariant, sdkLlvm.zephyrSdkPath], ['zephyr', f.sdkLlvm]);
    assert.deepEqual([iar.selectedVariant, iar.iarToolchainPath], ['iar', f.iar]);
    assert.ok(!JSON.stringify(iar).includes('secret-token'), 'a choice never carries the IAR token');
    assert.deepEqual([armGnu.selectedVariant, armGnu.armGnuToolchainPath], ['gnuarmemb', f.armGnu]);
    assert.deepEqual([rustLinked.selectedVariant, rustLinked.zephyrSdkPath, rustLinked.rustToolchainPath], ['zephyr', f.sdkLlvm, f.rustLinked]);
    assert.equal(rustLinked.description, '+ zephyr-sdk-1.0.0');
    assert.equal(resolveChoiceSdk(applicationOf(f), rustLinked)?.rootUri.fsPath, f.sdkLlvm, 'a Rust link to an SDK offers its LLVM');
    assert.equal(rustUnlinked.description, '+ no C toolchain linked');
    assert.ok(lacksCToolchain(rustUnlinked));
    assert.ok(!lacksCToolchain(rustLinked));
  });

  it('shows the quick step the same choices and asks for the LLVM variant only when the SDK has it', async () => {
    const choices = await listApplicationToolchainChoices(applicationOf(f));
    const shown: Array<Array<{ label: string; description?: string }>> = [];
    const answers: Array<(items: Array<{ label: string }>) => unknown> = [];
    stub.window.showQuickPick = async (items: Array<{ label: string }>) => {
      shown.push(items);
      return answers.shift()?.(items);
    };

    answers.push(items => items[0], items => items.find(item => item.label === 'LLVM CLANG'));
    const llvm = await changeToolchainQuickStep({} as never, applicationOf(f));
    assert.deepEqual(shown[0].map(item => [item.label, item.description]), choices.map(choice => [choice.label, choice.description]));
    assert.equal(shown.length, 2, 'the SDK with LLVM asks for the variant');
    assert.deepEqual([llvm?.selectedVariant, llvm?.zephyrSdkPath], ['zephyr/llvm', f.sdkLlvm]);

    shown.length = 0;
    answers.push(items => items[1]);
    const plain = await changeToolchainQuickStep({} as never, applicationOf(f));
    assert.equal(shown.length, 1, 'an SDK without LLVM does not ask');
    assert.deepEqual([plain?.selectedVariant, plain?.zephyrSdkPath], ['zephyr', f.sdkPlain]);

    const errors: string[] = [];
    stub.window.showErrorMessage = async (message: string) => { errors.push(message); };
    answers.push(items => items[5]);
    assert.equal(await changeToolchainQuickStep({} as never, applicationOf(f)), undefined);
    assert.deepEqual(errors, ['This Rust toolchain has no linked C toolchain; right-click it in the Toolchains view to link one.']);
  });

  it('tells a change of toolchain from the same one picked again', async () => {
    const app = applicationOf(f);
    assert.ok(!hasApplicationToolchainChanged(app, { selectedVariant: 'zephyr', zephyrSdkPath: f.sdkPlain }));
    assert.ok(hasApplicationToolchainChanged(app, { selectedVariant: 'zephyr/llvm', zephyrSdkPath: f.sdkPlain }));
    assert.ok(hasApplicationToolchainChanged(app, { selectedVariant: 'zephyr', zephyrSdkPath: f.sdkLlvm }));
    assert.ok(hasApplicationToolchainChanged(app, { selectedVariant: 'zephyr', zephyrSdkPath: f.sdkPlain, rustToolchainPath: f.rustLinked }));
    assert.ok(hasApplicationToolchainChanged(app, { selectedVariant: 'gnuarmemb', armGnuToolchainPath: f.armGnu }));
  });

  it('switches an application to Arm GNU as the change-toolchain command does', async () => {
    const result = await applyApplicationToolchain(applicationOf(f), { selectedVariant: 'gnuarmemb', armGnuToolchainPath: f.armGnu });
    assert.deepEqual({ applied: result.applied, changed: result.changed, removed: result.launchConfigsRemoved }, { applied: true, changed: true, removed: 0 });
    const settings = readSettingsFile(f.app);
    assert.equal(settings['zephyr-workbench.toolchain'], 'gnuarmemb');
    assert.equal(settings['zephyr-workbench.gnuarmemb'], f.armGnu);
    assert.equal(settings['zephyr-workbench.sdk'], undefined);
    assert.equal(applicationOf(f).selectedArmGnuToolchainInstallation?.toolchainPath, f.armGnu);
  });

  it('reports a picked Arm GNU toolchain that is not registered any more, and changes nothing', async () => {
    const before = fs.readFileSync(path.join(f.app, '.vscode', 'settings.json'), 'utf8');
    const result = await applyApplicationToolchain(applicationOf(f), { selectedVariant: 'gnuarmemb', armGnuToolchainPath: path.join(f.app, 'gone') });
    assert.deepEqual({ applied: result.applied, error: result.error }, { applied: false, error: 'The selected Arm GNU toolchain could not be found.' });
    assert.equal(fs.readFileSync(path.join(f.app, '.vscode', 'settings.json'), 'utf8'), before);
  });

  it('reports the SDK compatibility where the command shows its warning', async () => {
    const seen: string[] = [];
    const result = await applyApplicationToolchain(applicationOf(f), { selectedVariant: 'zephyr', zephyrSdkPath: f.sdkLlvm }, {
      onSdkCompat: compat => seen.push(`${compat.sdkVersion.trim()}:${compat.verdict.zephyrVersion}`),
    });
    assert.deepEqual(seen, ['1.0.0:4.1.0']);
    assert.equal(result.sdkCompat?.sdkVersion.trim(), '1.0.0');
    assert.equal(result.compilerPathDeferred, undefined, 'the command always looks the compiler up');
    assert.equal(readSettingsFile(f.app)['zephyr-workbench.sdk'], f.sdkLlvm);
  });

  it('leaves the compiler path to the next build when asked not to configure a throwaway build', async () => {
    const result = await applyApplicationToolchain(applicationOf(f), { selectedVariant: 'zephyr', zephyrSdkPath: f.sdkLlvm }, {
      compilerPath: 'if-configured',
    });
    assert.equal(result.compilerPathDeferred, true);
    assert.ok(!fs.existsSync(path.join(f.app, '.tmp')));
    assert.equal(readSettingsFile(f.app)['zephyr-workbench.sdk'], f.sdkLlvm);
  });
});
