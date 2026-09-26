// list_toolchains, manage_toolchain and remove_or_delete toolchain, run
// against toolchain folders made on disk and toolchain lists held in memory.
// The home folder points at a temporary one, so global SDK detection and the
// host tools SDK only ever see what a test puts there. The release sites and
// the terminal are stood in for; the settings writers, the confirmation gate,
// the job manager and the folder checks are the production code.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { findTool, TOOL_CATALOG } from '../../../mcp/core/catalog';
import { McpToolError } from '../../../mcp/core/errors';
import { ConfirmCategory, permissionForCategories, ToolContext } from '../../../mcp/core/toolSpec';
import { AskAnswer, Confirmations } from '../../../mcp/host/confirmations';
import { HostDeps, WorkbenchView } from '../../../mcp/host/handlers/deps';
import { removeOrDelete } from '../../../mcp/host/handlers/removals';
import { toolchainDiscovery } from '../../../mcp/host/handlers/toolchainDiscovery';
import { removeUnregisteredFolder } from '../../../mcp/host/handlers/toolchainInstalls';
import { cancellationTokenFor, jobReporter, runToolchainJob, TOOLCHAIN_DOWNLOAD_LOCK, toolchainSteps } from '../../../mcp/host/handlers/toolchainJobs';
import { listToolchains, manageToolchain } from '../../../mcp/host/handlers/toolchains';
import { HostServices } from '../../../mcp/host/services';
import { isWorking, JobManager } from '../../../mcp/jobs/jobManager';
import { getArmGnuHostTarget } from '../../../utils/zephyr/armGnuToolchainUtils';
import { refreshGlobalSdkDetection } from '../../../utils/zephyr/globalSdkService';
import { getRustHostTriple } from '../../../utils/zephyr/rustToolchainUtils';
import { getSdkHostTarget } from '../../../utils/zephyr/sdkUtils';
import { useUiGuard } from './uiGuard';

const vscodeStub = require('vscode') as Record<string, any>;

class FakeUri {
  constructor(readonly fsPath: string) {}
  static file(fsPath: string): FakeUri { return new FakeUri(fsPath); }
  static parse(value: string): FakeUri { return new FakeUri(value.replace(/^file:\/\//, '')); }
  static joinPath(base: FakeUri, ...parts: string[]): FakeUri { return new FakeUri(path.join(base.fsPath, ...parts)); }
  toString(): string { return `file://${this.fsPath}`; }
}

const IAR_TOKEN = 'iar-secret-token-1234567890';

function write(file: string, text = ''): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A Zephyr SDK: a manifest naming every toolchain, and only `installed` of them on disk. */
function makeSdk(root: string, version: string, installed: string[], opts: { llvm?: boolean } = {}): string {
  write(path.join(root, 'sdk_version'), `${version}\n`);
  write(path.join(root, 'sdk_toolchains'), ['arm-zephyr-eabi', 'riscv64-zephyr-elf', 'x86_64-zephyr-elf'].join('\n'));
  for (const toolchain of installed) {
    fs.mkdirSync(path.join(root, toolchain, 'bin'), { recursive: true });
  }
  if (opts.llvm) {
    write(path.join(root, 'llvm', 'bin', process.platform === 'win32' ? 'clang.exe' : 'clang'));
  }
  return root;
}

function makeArmGnu(root: string): string {
  write(path.join(root, 'bin', `arm-none-eabi-gcc${process.platform === 'win32' ? '.exe' : ''}`));
  return root;
}

function makeIar(root: string): string {
  write(path.join(root, 'bin', process.platform === 'win32' ? 'iccarm.exe' : 'iccarm'));
  return root;
}

function makeRust(root: string): string {
  const exe = process.platform === 'win32' ? '.exe' : '';
  write(path.join(root, 'bin', `rustc${exe}`));
  write(path.join(root, 'bin', `cargo${exe}`));
  fs.mkdirSync(path.join(root, 'lib', 'rustlib', 'thumbv7em-none-eabi', 'lib'), { recursive: true });
  return root;
}

function makeLlvm(root: string): string {
  write(path.join(root, process.platform === 'win32' ? 'bin' : 'lib',
    process.platform === 'win32' ? 'libclang.dll' : process.platform === 'darwin' ? 'libclang.dylib' : 'libclang.so'));
  return root;
}

interface Harness {
  root: string;
  lists: Record<string, any[]>;
  apps: any[];
  asked: string[];
  refreshed: WorkbenchView[][];
  jobs: JobManager;
  deps: HostDeps;
  confirmActions: ConfirmCategory[];
  served: Set<string>;
  ctx(tool: string): ToolContext<HostDeps>;
  answer(value: AskAnswer): void;
  /** Runs while the confirmation dialog is open, before the answer. */
  onAsk?(): void;
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as McpToolError).code;
  }
}

/** Whether `check` holds within `ms`. */
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
}

async function errorOf(promise: Promise<unknown>): Promise<McpToolError> {
  try {
    await promise;
  } catch (error) {
    return error as McpToolError;
  }
  throw new Error('expected the call to fail');
}

describe('mcp/host/handlers/toolchains', function () {
  this.timeout(20000);
  useUiGuard();

  let h: Harness;
  const saved: Record<string, unknown> = {};

  before(() => {
    saved.getConfiguration = vscodeStub.workspace.getConfiguration;
    saved.Uri = vscodeStub.Uri;
    saved.home = process.env.HOME;
    saved.sdkDir = process.env.ZEPHYR_SDK_INSTALL_DIR;
    saved.run = toolchainSteps.run;
    saved.discovery = { ...toolchainDiscovery };
    vscodeStub.Uri = FakeUri;
    delete process.env.ZEPHYR_SDK_INSTALL_DIR;
    // The terminal of a step is VS Code's; here the step just runs.
    toolchainSteps.run = (async (_name: string, sink: { onData(text: string): void }, signal: AbortSignal,
      work: (log: (text: string) => void, signal: AbortSignal) => Promise<unknown>) => work(text => sink.onData(text), signal)) as never;
    Object.assign(toolchainDiscovery, {
      sdkVersions: async () => ['1.0.0', '0.17.4'],
      sdkToolchains: async () => ['arm-zephyr-eabi', 'riscv64-zephyr-elf', 'x86_64-zephyr-elf'],
      rust: async () => ({
        versions: ['stable', '1.87.0', '1.86.0'],
        targets: ['thumbv7em-none-eabi', 'thumbv7em-none-eabihf', 'thumbv8m.main-none-eabi', 'thumbv8m.main-none-eabihf', 'riscv32i-unknown-none-elf'],
        targetDescriptions: { 'thumbv7em-none-eabi': 'Cortex-M4/M7 (soft-float ABI)' },
      }),
      llvmVersions: async () => ({ suggested: ['20.1.8'], all: ['20.1.8', '20.1.7'] }),
      rustupStatus: async () => ({ installed: false, managed: false, managedRootDir: '/x', prereqOk: true, prereqMessage: '', prereqInstallable: false }),
      armGnuCatalog: async () => ({ releases: [], assets: [] }),
    });
  });

  after(async () => {
    // Leave the detection cache as empty as it was: detected in an empty home.
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-empty-home-'));
    await refreshGlobalSdkDetection();
    vscodeStub.workspace.getConfiguration = saved.getConfiguration;
    vscodeStub.Uri = saved.Uri;
    process.env.HOME = saved.home as string;
    if (saved.sdkDir !== undefined) {
      process.env.ZEPHYR_SDK_INSTALL_DIR = saved.sdkDir as string;
    }
    toolchainSteps.run = saved.run as typeof toolchainSteps.run;
    Object.assign(toolchainDiscovery, saved.discovery);
  });

  beforeEach(async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-toolchains-')));
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    process.env.HOME = home;
    const lists: Record<string, any[]> = { listSDKs: [], listIARs: [], listArmGnuToolchains: [], listRustToolchains: [] };
    vscodeStub.workspace.getConfiguration = () => ({
      get: (key: string, fallback?: unknown) => (key in lists ? JSON.parse(JSON.stringify(lists[key])) : fallback),
      update: async (key: string, value: any[]) => { lists[key] = JSON.parse(JSON.stringify(value)); },
      has: () => false,
      inspect: () => undefined,
    });
    await refreshGlobalSdkDetection();

    h = {} as Harness;
    const services = new HostServices(vscode.Uri.file(os.tmpdir()));
    services.listApplications = async () => h.apps as never;
    services.knownRoots = async () => [path.join(root, 'app')];
    const jobs = new JobManager({ logPathFor: id => path.join(root, `${id}.log`) });
    const asked: string[] = [];
    const answers: AskAnswer[] = [];
    const confirmations = new Confirmations({
      permission: tool => permissionForCategories(tool, h.confirmActions),
      waitMs: () => 2000,
      log: { recordConfirmation: () => undefined },
      ask: async message => {
        asked.push(message);
        h.onAsk?.();
        return answers.shift();
      },
    });
    const refreshed: WorkbenchView[][] = [];
    const deps: HostDeps = {
      services, jobs, confirmations,
      defaultWaitSeconds: 10,
      revealTerminal: 'never',
      permissionOf: tool => permissionForCategories(tool, h.confirmActions),
      kconfig: {} as HostDeps['kconfig'],
      extensionContext: {} as HostDeps['extensionContext'],
      folders: {} as HostDeps['folders'],
      refreshViews: async views => { refreshed.push([...views]); },
      servedTools: () => h.served,
    };
    Object.assign(h, {
      root, lists, apps: [], asked, refreshed, jobs, deps,
      confirmActions: ['install', 'delete', 'settings'] as ConfirmCategory[],
      served: new Set(TOOL_CATALOG.map(tool => tool.name)),
      ctx: (tool: string) => ({
        signal: new AbortController().signal,
        progress: () => undefined,
        client: { name: 'test-agent', version: '1', instance: 'session-1' },
        deps,
        tool: findTool(tool)!,
        startedAt: Date.now(),
        audit: {},
      }),
      answer: (value: AskAnswer) => answers.push(value),
    });
  });

  const list = (args: Record<string, unknown> = {}) => listToolchains(args, h.ctx('list_toolchains')) as Promise<any>;
  const manage = (args: Record<string, unknown>) => manageToolchain(args, h.ctx('manage_toolchain')) as Promise<any>;
  const remove = (args: Record<string, unknown>) => removeOrDelete(args, h.ctx('remove_or_delete')) as Promise<any>;

  describe('list_toolchains', () => {
    it('reports the GNU toolchains on disk, not the manifest, and the LLVM of each SDK', async () => {
      const sdk = makeSdk(path.join(h.root, 'sdks', 'zephyr-sdk-0.17.4'), '0.17.4', ['arm-zephyr-eabi']);
      h.lists.listSDKs = [sdk];
      const result = await list();
      const entry = result.zephyr_sdks.find((candidate: any) => candidate.path === sdk);
      assert.deepEqual(entry, {
        path: sdk, version: '0.17.4', registered: true, global: false, internal: false,
        gnu_toolchains: ['arm-zephyr-eabi'], llvm_installed: false,
      });
    });

    it('marks the SDK of the host tools as internal and a globally found one as global', async () => {
      const internal = makeSdk(path.join(process.env.HOME!, '.zinstaller', 'zephyr-sdk-0.17.4'), '0.17.4', []);
      fs.mkdirSync(path.join(process.env.HOME!, '.zinstaller', 'tools'), { recursive: true });
      const globalSdk = makeSdk(path.join(process.env.HOME!, 'zephyr-sdk-1.0.0'), '1.0.0', ['arm-zephyr-eabi'], { llvm: true });
      h.lists.listSDKs = [internal];
      const result = await list({ rescan: true });
      assert.equal(result.rescanned, true);
      const byPath = (p: string) => result.zephyr_sdks.find((candidate: any) => candidate.path === p);
      assert.equal(byPath(internal).internal, true);
      assert.deepEqual(
        { registered: byPath(globalSdk).registered, global: byPath(globalSdk).global, llvm: byPath(globalSdk).llvm_installed },
        { registered: false, global: true, llvm: true });
      assert.deepEqual(byPath(globalSdk).sources, ['default-location']);
    });

    it('says whether an IAR toolchain has a licence token and never shows the token', async () => {
      const sdk = makeSdk(path.join(h.root, 'sdk'), '0.17.4', []);
      const iar = makeIar(path.join(h.root, 'iar'));
      h.lists.listSDKs = [sdk];
      h.lists.listIARs = [{ iarPath: iar, zephyrSdkPath: sdk, token: IAR_TOKEN }];
      const result = await list({ include: ['usage'] });
      assert.deepEqual(result.iar, [{ path: iar, zephyr_sdk_path: sdk, has_token: true, used_by: [] }]);
      assert.ok(!JSON.stringify(result).includes(IAR_TOKEN));
    });

    it('lists the Arm GNU and Rust toolchains with their links, and registrations whose folder is gone', async () => {
      const arm = makeArmGnu(path.join(h.root, 'arm-gnu-toolchain-14.2.rel1-darwin-arm64-arm-none-eabi'));
      const rust = makeRust(path.join(h.root, 'rust'));
      const llvm = makeLlvm(path.join(h.root, 'llvm'));
      h.lists.listArmGnuToolchains = [{ toolchainPath: arm, targetTriple: 'arm-none-eabi', version: '14.2.rel1' }, { toolchainPath: path.join(h.root, 'gone') }];
      h.lists.listRustToolchains = [{ toolchainPath: rust, version: '1.87.0', rustupToolchain: 'stable', cToolchainType: 'gnuarmemb', cToolchainPath: arm, llvmPath: llvm }];
      h.lists.listSDKs = [path.join(h.root, 'not-an-sdk')];
      fs.mkdirSync(path.join(h.root, 'not-an-sdk'));
      const result = await list();
      assert.deepEqual(result.arm_gnu, [{ path: arm, version: '14.2.rel1', target: 'arm-none-eabi' }]);
      const [rustEntry] = result.rust;
      assert.equal(rustEntry.rustup_toolchain, 'stable');
      assert.deepEqual(rustEntry.c_toolchain, { family: 'arm_gnu', path: arm, valid: true });
      assert.equal(rustEntry.llvm_path, llvm);
      assert.ok(rustEntry.libclang_dir);
      assert.deepEqual(result.missing, [
        { family: 'zephyr_sdk', path: path.join(h.root, 'not-an-sdk'), reason: 'not_a_toolchain' },
        { family: 'arm_gnu', path: path.join(h.root, 'gone'), reason: 'folder_gone' },
      ]);
      assert.match(result.next, /remove_or_delete what "toolchain"/);
    });

    it('adds the applications using each toolchain with include usage', async () => {
      const sdk = makeSdk(path.join(h.root, 'sdk'), '0.17.4', []);
      const arm = makeArmGnu(path.join(h.root, 'arm'));
      h.lists.listSDKs = [sdk];
      h.lists.listArmGnuToolchains = [{ toolchainPath: arm, targetTriple: 'arm-none-eabi' }];
      h.apps = [
        { appRootPath: '/apps/a', isGlobalSdk: false, zephyrSdkPath: sdk, toolchainVariant: 'zephyr' },
        { appRootPath: '/apps/b', isGlobalSdk: false, zephyrSdkPath: '', toolchainVariant: 'gnuarmemb', selectedArmGnuToolchainInstallation: { toolchainPath: arm } },
      ];
      const result = await list({ include: ['usage'] });
      assert.deepEqual(result.zephyr_sdks.find((entry: any) => entry.path === sdk).used_by, ['/apps/a']);
      assert.deepEqual(result.arm_gnu[0].used_by, ['/apps/b']);
    });

    it('says a blocked tool needs the user to allow it', async () => {
      const blocked = ['manage_toolchain', 'remove_or_delete'];
      h.served = new Set(TOOL_CATALOG.filter(tool => !blocked.includes(tool.name)).map(tool => tool.name));
      h.lists.listArmGnuToolchains = [{ toolchainPath: path.join(h.root, 'gone') }];
      const result = await list();
      assert.match(result.next, /manage_toolchain, if the user allows it in the AI Manager/);
      assert.match(result.next, /remove_or_delete, if the user allows it in the AI Manager/);
    });

    it('lists the releases of a family, and the toolchains of one SDK version', async function () {
      if (!getSdkHostTarget()) {
        this.skip();
      }
      const result = await list({ available: 'zephyr_sdk', version: 'v1.0.0' });
      assert.deepEqual(result.versions, ['1.0.0', '0.17.4']);
      assert.deepEqual(result.version, { version: '1.0.0', toolchains: ['arm-zephyr-eabi', 'riscv64-zephyr-elf', 'x86_64-zephyr-elf'], llvm_available: true });
      assert.equal(result.global_install_bases[0].path, process.env.HOME);
      assert.equal(await codeOf(list({ available: 'zephyr_sdk', version: '9.9.9' })), 'INVALID_ARGUMENT');
      const rust = await list({ available: 'rust' });
      assert.deepEqual(rust.standalone_versions, ['1.87.0', '1.86.0']);
      assert.deepEqual(rust.presets.minimal, ['thumbv7em-none-eabi', 'thumbv7em-none-eabihf', 'thumbv8m.main-none-eabi', 'thumbv8m.main-none-eabihf']);
    });

    it('refuses arguments that do not go with what is asked', async () => {
      assert.equal(await codeOf(list({ version: '1.0.0' })), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(list({ available: 'rust', include: ['usage'] })), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(list({ available: 'llvm', version: '20.1.8' })), 'INVALID_ARGUMENT');
    });
  });

  describe('manage_toolchain install', () => {
    const sdkInstall = (extra: Record<string, unknown> = {}) => ({
      action: 'install', family: 'zephyr_sdk', version: '0.17.4', sdk_type: 'minimal', toolchains: ['arm'],
      parent_path: path.join(h.root, 'dest'), ...extra,
    });

    beforeEach(() => fs.mkdirSync(path.join(h.root, 'dest')));

    it('reports what it would download, and from where, without asking or writing', async function () {
      if (!getSdkHostTarget()) {
        this.skip();
      }
      const result = await manage(sdkInstall({ dry_run: true }));
      assert.equal(result.dry_run, true);
      assert.equal(result.install_path, path.join(h.root, 'dest', 'zephyr-sdk-0.17.4'));
      assert.deepEqual(result.toolchains, ['arm-zephyr-eabi']);
      assert.equal(result.downloads.length, 2);
      for (const download of result.downloads) {
        assert.match(download.url, /^https:\/\/github\.com\/zephyrproject-rtos\/sdk-ng\/releases\/download\/v0\.17\.4\//);
      }
      assert.equal(result.confirmation_required, true);
      assert.deepEqual(h.asked, []);
      assert.deepEqual(fs.readdirSync(path.join(h.root, 'dest')), []);
    });

    it('checks every value against the release lists and the destination before asking', async function () {
      if (!getSdkHostTarget()) {
        this.skip();
      }
      assert.equal(await codeOf(manage(sdkInstall({ version: '0.99.0' }))), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(manage(sdkInstall({ toolchains: ['sparc'] }))), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(manage(sdkInstall({ toolchains: ['arm;id'] }))), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(manage(sdkInstall({ llvm: true }))), 'INVALID_ARGUMENT', 'LLVM only from SDK 1.0');
      assert.equal(await codeOf(manage(sdkInstall({ sdk_type: 'full' }))), 'INVALID_ARGUMENT', 'a full SDK takes no toolchains');
      assert.equal(await codeOf(manage(sdkInstall({ parent_path: path.join(h.root, 'dest with space') }))), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(manage(sdkInstall({ parent_path: 'relative/dest' }))), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(manage(sdkInstall({ install_base: '/opt' }))), 'INVALID_ARGUMENT', 'install_base belongs to destination global');
      fs.mkdirSync(path.join(h.root, 'dest', 'zephyr-sdk-0.17.4'));
      const existing = await errorOf(manage(sdkInstall()));
      assert.equal(existing.code, 'INVALID_ARGUMENT');
      assert.match(existing.message, /already exists/);
      assert.deepEqual(h.asked, []);
    });

    it('refuses up front a destination a registration left behind still points at or into, and never asks', async function () {
      if (!getSdkHostTarget() || !getArmGnuHostTarget() || !getRustHostTriple()) {
        this.skip();
      }
      const dest = path.join(h.root, 'dest');
      // Registrations whose folders the user deleted by hand during the session.
      const staleSdk = path.join(dest, 'zephyr-sdk-0.17.4');
      const staleArm = path.join(dest, 'arm14', 'arm-gnu-toolchain-14.2.rel1-x86_64-arm-none-eabi');
      const staleRust = path.join(dest, 'rust-1.87.0-llvm-20.1.8');
      const sdk = makeSdk(path.join(h.root, 'sdk'), '0.17.4', ['arm-zephyr-eabi']);
      h.lists.listSDKs = [staleSdk, sdk];
      h.lists.listArmGnuToolchains = [{ toolchainPath: staleArm, targetTriple: 'arm-none-eabi', version: '14.2.rel1' }];
      h.lists.listRustToolchains = [{ toolchainPath: staleRust, version: '1.87.0' }];
      const catalog = toolchainDiscovery.armGnuCatalog;
      Object.assign(toolchainDiscovery, {
        armGnuCatalog: async () => ({ releases: [{ version: '14.2.rel1', displayVersion: '14.2.Rel1' }], assets: [] }),
      });
      try {
        const cases: Array<[Record<string, unknown>, string, string]> = [
          [sdkInstall(), staleSdk, 'zephyr_sdk'],
          [{ action: 'install', family: 'arm_gnu', version: '14.2.rel1', parent_path: dest, folder_name: 'arm14' }, staleArm, 'arm_gnu'],
          [{ action: 'install', family: 'rust', method: 'standalone', version: '1.87.0', parent_path: dest, c_toolchain: { family: 'zephyr_sdk', path: sdk } }, staleRust, 'rust'],
        ];
        for (const [args, stale, family] of cases) {
          const refused = await errorOf(manage(args));
          assert.equal(refused.code, 'INVALID_ARGUMENT', family);
          assert.match(refused.hint ?? '', /remove_or_delete what "toolchain"/);
          assert.deepEqual(refused.details?.registrations, [{ family, path: stale }]);
        }
      } finally {
        Object.assign(toolchainDiscovery, { armGnuCatalog: catalog });
      }
      assert.deepEqual(h.asked, []);
    });

    it('after a failed install, keeps a folder something got registered in, and deletes one nothing did', async () => {
      const installPath = path.join(h.root, 'dest', 'arm14');
      // An Arm GNU root is the archive's own folder inside the install folder.
      const root = makeArmGnu(path.join(installPath, 'arm-gnu-toolchain-14.2.rel1-x86_64-arm-none-eabi'));
      h.lists.listArmGnuToolchains = [{ toolchainPath: root, targetTriple: 'arm-none-eabi' }];
      assert.deepEqual(await removeUnregisteredFolder(installPath, () => undefined), {});
      assert.ok(fs.existsSync(root), 'a registered toolchain is never deleted');
      h.lists.listArmGnuToolchains = [];
      assert.deepEqual(await removeUnregisteredFolder(installPath, () => undefined), { removed_partial_folder: installPath });
      assert.ok(!fs.existsSync(installPath));
    });

    it('asks under install for actions on toolchains, then runs a job that refreshes the Toolchains view', async function () {
      if (!getSdkHostTarget()) {
        this.skip();
      }
      h.answer('allow');
      const ctx = h.ctx('manage_toolchain');
      const view = await manageToolchain(sdkInstall(), ctx) as any;
      assert.equal(h.asked.length, 1);
      assert.match(h.asked[0], /download Zephyr SDK 0\.17\.4 \(minimal\) and install it into/);
      assert.equal(ctx.audit.confirmCategory, 'install');
      assert.equal(view.kind, 'install');
      assert.deepEqual(view.confirmation, { category: 'install', outcome: 'allowed' });
      // No file downloader here, so the job fails at its first download, and says so.
      await h.jobs.wait(h.jobs.get(view.job_id) as never, 10000);
      const done = h.jobs.view(h.jobs.get(view.job_id) as never);
      assert.equal(done.status, 'failed');
      assert.ok(done.result?.error);
      assert.doesNotMatch(String(done.result?.error), /downloads nothing|not an official/);
      assert.match(done.log.tail, /Download https:\/\/github\.com\/zephyrproject-rtos\/sdk-ng\//);
      assert.ok(!fs.existsSync(path.join(h.root, 'dest', 'zephyr-sdk-0.17.4')));
      assert.deepEqual(h.refreshed.at(-1), ['toolchains']);
      assert.deepEqual(h.lists.listSDKs, []);
    });

    it('refuses a second install while one runs in this window', async function () {
      if (!getSdkHostTarget()) {
        this.skip();
      }
      let release: () => void = () => undefined;
      h.jobs.start({
        kind: 'install', lockKey: TOOLCHAIN_DOWNLOAD_LOCK, requestKey: 'other', command: 'another install',
        run: () => new Promise(resolve => { release = () => resolve({ exitCode: 0 }); }),
      });
      try {
        const busy = await errorOf(manage(sdkInstall()));
        assert.equal(busy.code, 'BUSY');
        assert.match(busy.hint ?? '', /job \{"action": "status"/);
        assert.deepEqual(h.asked, []);
      } finally {
        release();
      }
    });

    it('stops the setup script of a reused global SDK when the job is cancelled', async function () {
      if (process.platform === 'win32' || !getSdkHostTarget()) {
        this.skip();
      }
      this.timeout(40000);
      const home = process.env.HOME!;
      const sdk = makeSdk(path.join(home, 'zephyr-sdk-0.17.4'), '0.17.4', []);
      // The sleep stands in for the toolchain downloads of the real script.
      fs.writeFileSync(path.join(sdk, 'setup.sh'), '#!/bin/sh\necho "setup $*"\nsleep 30\n', { mode: 0o755 });
      // The west a global install needs; reusing the SDK runs its own script instead.
      write(path.join(home, '.zinstaller', '.venv', 'bin', 'west'));
      h.confirmActions = [];
      const args = { action: 'install', family: 'zephyr_sdk', destination: 'global', version: '0.17.4', sdk_type: 'minimal', toolchains: ['arm'] };
      assert.equal((await manage({ ...args, dry_run: true })).reuses_existing, sdk);
      const view = await manage({ ...args, wait_sec: 0 });
      const job = h.jobs.get(view.job_id) as never;
      assert.ok(await until(() => /setup -c/.test(h.jobs.view(job).log.tail), 10000), 'the setup script started');
      h.jobs.cancel(view.job_id);
      // Long before the 30 s sleep would end on its own, the SIGKILL escalation included.
      assert.ok(await until(() => !isWorking(job), 15000), 'the job ended with its script');
      assert.equal(h.jobs.view(job).status, 'cancelled');
    });

    it('joins a running standalone Rust install only for the very same request, not one linked to another C toolchain', async function () {
      if (!getRustHostTriple()) {
        this.skip();
      }
      const sdkA = makeSdk(path.join(h.root, 'sdk-a'), '0.17.4', ['arm-zephyr-eabi']);
      const sdkB = makeSdk(path.join(h.root, 'sdk-b'), '0.17.4', ['arm-zephyr-eabi']);
      h.lists.listSDKs = [sdkA, sdkB];
      h.confirmActions = [];
      const install = (cToolchain: string) => manage({
        action: 'install', family: 'rust', method: 'standalone', version: '1.87.0', parent_path: path.join(h.root, 'dest'),
        c_toolchain: { family: 'zephyr_sdk', path: cToolchain }, wait_sec: 0,
      });
      // The first install waits before its step, so its folder stays empty meanwhile.
      const run = toolchainSteps.run;
      let release: () => void = () => undefined;
      const gate = new Promise<void>(resolve => { release = resolve; });
      toolchainSteps.run = (async (...stepArgs: Parameters<typeof run>) => {
        await gate;
        return run(...stepArgs);
      }) as typeof run;
      let first: any;
      try {
        first = await install(sdkA);
        assert.equal((await install(sdkA)).job_id, first.job_id, 'the same request joins the running install');
        const other = await errorOf(install(sdkB));
        assert.equal(other.code, 'BUSY');
        assert.equal(other.details?.job_id, first.job_id);
      } finally {
        release();
        toolchainSteps.run = run;
      }
      await h.jobs.wait(h.jobs.get(first.job_id) as never, 10000);
    });

    it('never installs an IAR toolchain, and needs rustup for a Rust toolchain', async () => {
      assert.equal(await codeOf(manage({ action: 'install', family: 'iar' })), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(manage({ action: 'install' })), 'INVALID_ARGUMENT');
    });

    it('reports a managed rustup already installed without asking', async () => {
      const rustup = path.join(process.env.HOME!, '.zinstaller', 'tools', 'rustup', 'cargo-home', 'bin', process.platform === 'win32' ? 'rustup.exe' : 'rustup');
      write(rustup);
      const result = await manage({ action: 'install', family: 'rustup' });
      assert.equal(result.already_installed, true);
      assert.equal(result.rustup_path, rustup);
      assert.deepEqual(h.asked, []);
    });
  });

  describe('manage_toolchain add_components', () => {
    it('reports what is already installed and does nothing without asking', async () => {
      const sdk = makeSdk(path.join(h.root, 'sdk'), '0.17.4', ['arm-zephyr-eabi']);
      h.lists.listSDKs = [sdk];
      const result = await manage({ action: 'add_components', sdk_path: sdk, toolchains: ['arm'] });
      assert.deepEqual(result.already_installed, ['arm-zephyr-eabi']);
      assert.deepEqual(result.added, []);
      assert.deepEqual(h.asked, []);
    });

    it('refuses LLVM before SDK 1.0, and an SDK list_toolchains does not list', async () => {
      const sdk = makeSdk(path.join(h.root, 'sdk'), '0.17.4', []);
      h.lists.listSDKs = [sdk];
      assert.match((await errorOf(manage({ action: 'add_components', sdk_path: sdk, llvm: true }))).message, /only available for Zephyr SDK 1\.0 or later \(this SDK is 0\.17\.4\)/);
      assert.equal(await codeOf(manage({ action: 'add_components', sdk_path: path.join(h.root, 'other'), toolchains: ['arm'] })), 'INVALID_ARGUMENT');
    });

    it('fails with a permission error on an SDK the user cannot write to, never asking for more rights', async function () {
      if (process.platform === 'win32' || process.getuid?.() === 0 || !getSdkHostTarget()) {
        this.skip();
      }
      const sdk = makeSdk(path.join(h.root, 'readonly-sdk'), '0.17.4', []);
      h.lists.listSDKs = [sdk];
      fs.chmodSync(sdk, 0o555);
      try {
        const denied = await errorOf(manage({ action: 'add_components', sdk_path: sdk, toolchains: ['riscv64'] }));
        assert.match(denied.message, /permission to write/);
        assert.match(denied.hint ?? '', /never asks for administrator rights/);
      } finally {
        fs.chmodSync(sdk, 0o755);
      }
    });
  });

  describe('manage_toolchain register and link', () => {
    it('registers an SDK under the settings confirmation, and again is a no-op that asks nothing', async () => {
      const sdk = makeSdk(path.join(h.root, 'sdk'), '0.17.4', []);
      h.answer('allow');
      const ctx = h.ctx('manage_toolchain');
      const result = await manageToolchain({ action: 'register', family: 'zephyr_sdk', path: sdk }, ctx) as any;
      assert.equal(ctx.audit.confirmCategory, 'settings');
      assert.deepEqual(h.lists.listSDKs, [sdk]);
      assert.equal(result.version, '0.17.4');
      assert.deepEqual(h.refreshed, [['toolchains']]);
      const again = await manage({ action: 'register', family: 'zephyr_sdk', path: sdk });
      assert.equal(again.already_registered, true);
      assert.equal(h.asked.length, 1);
    });

    it('registers an IAR toolchain with an empty token and hands the token to the wizard', async () => {
      const sdk = makeSdk(path.join(h.root, 'sdk'), '0.17.4', []);
      const iar = makeIar(path.join(h.root, 'iar'));
      h.lists.listSDKs = [sdk];
      h.confirmActions = [];
      const result = await manage({ action: 'register', family: 'iar', path: iar, zephyr_sdk_path: sdk });
      assert.deepEqual(h.lists.listIARs, [{ zephyrSdkPath: sdk, iarPath: iar, token: '' }]);
      assert.equal(result.has_token, false);
      assert.match(result.next, /open_in_workbench target "add_toolchain"/);
      assert.equal(await codeOf(manage({ action: 'register', family: 'iar', path: iar, zephyr_sdk_path: sdk, token: 'x' })), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(manage({ action: 'register', family: 'iar', path: iar, zephyr_sdk_path: path.join(h.root, 'nope') })), 'INVALID_ARGUMENT');
    });

    it('registers an Arm GNU Toolchain picked by its bin folder', async () => {
      const arm = makeArmGnu(path.join(h.root, 'arm-gnu-toolchain-13.3.rel1-x86_64-arm-none-eabi'));
      h.confirmActions = [];
      const result = await manage({ action: 'register', family: 'arm_gnu', path: path.join(arm, 'bin') });
      assert.equal(result.path, arm);
      assert.deepEqual(h.lists.listArmGnuToolchains, [{ toolchainPath: arm, targetTriple: 'arm-none-eabi', version: '13.3.rel1' }]);
      assert.equal(await codeOf(manage({ action: 'register', family: 'arm_gnu', path: h.root })), 'INVALID_ARGUMENT');
    });

    it('links a Rust toolchain to another C toolchain and LLVM, and unlinks the LLVM', async () => {
      const sdk = makeSdk(path.join(h.root, 'sdk'), '0.17.4', []);
      const rust = makeRust(path.join(h.root, 'rust'));
      const llvm = makeLlvm(path.join(h.root, 'llvm'));
      h.lists.listSDKs = [sdk];
      h.lists.listRustToolchains = [{ toolchainPath: rust, version: '1.87.0' }];
      h.confirmActions = [];
      const dry = await manage({ action: 'link', rust_path: rust, c_toolchain: { family: 'zephyr_sdk', path: sdk }, dry_run: true });
      assert.equal(dry.dry_run, true);
      assert.equal(h.lists.listRustToolchains[0].cToolchainPath, undefined);
      await manage({ action: 'link', rust_path: rust, c_toolchain: { family: 'zephyr_sdk', path: sdk }, llvm_path: path.join(llvm, 'lib') });
      assert.deepEqual(h.lists.listRustToolchains[0], { toolchainPath: rust, version: '1.87.0', cToolchainType: 'zephyr-sdk', cToolchainPath: sdk, llvmPath: llvm });
      await manage({ action: 'link', rust_path: rust, unlink_llvm: true });
      assert.equal(h.lists.listRustToolchains[0].llvmPath, undefined);
      assert.equal(await codeOf(manage({ action: 'link', rust_path: rust, llvm_path: h.root })), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(manage({ action: 'link', rust_path: rust })), 'INVALID_ARGUMENT');
    });
  });

  describe('remove_or_delete toolchain and toolchain_files', () => {
    it('refuses while applications use the toolchain, unless forced', async () => {
      const arm = makeArmGnu(path.join(h.root, 'arm'));
      h.lists.listArmGnuToolchains = [{ toolchainPath: arm, targetTriple: 'arm-none-eabi' }];
      h.apps = [{ appRootPath: '/apps/b', toolchainVariant: 'gnuarmemb', selectedArmGnuToolchainInstallation: { toolchainPath: arm } }];
      const refused = await errorOf(remove({ what: 'toolchain', path: arm }));
      assert.equal(refused.code, 'INVALID_ARGUMENT');
      assert.deepEqual(refused.details?.used_by, ['/apps/b']);
      h.answer('allow');
      const ctx = h.ctx('remove_or_delete');
      const result = await removeOrDelete({ what: 'toolchain', path: arm, force: true }, ctx) as any;
      assert.equal(ctx.audit.confirmCategory, 'delete');
      assert.equal(result.unregistered, true);
      assert.deepEqual(h.lists.listArmGnuToolchains, []);
      assert.ok(fs.existsSync(arm), 'unregistering keeps the files');
    });

    it('reports a toolchain unregistered elsewhere while the user was asked, instead of failing', async () => {
      const arm = makeArmGnu(path.join(h.root, 'arm'));
      const sdk = makeSdk(path.join(h.root, 'sdk'), '0.17.4', []);
      h.lists.listArmGnuToolchains = [{ toolchainPath: arm, targetTriple: 'arm-none-eabi' }];
      h.lists.listSDKs = [sdk];
      // Another window removes it from its Toolchains view meanwhile.
      h.onAsk = () => {
        h.lists.listArmGnuToolchains = [];
        h.lists.listSDKs = [];
      };
      for (const target of [arm, sdk]) {
        h.answer('allow');
        const result = await remove({ what: 'toolchain', path: target });
        assert.equal(result.unregistered, false);
        assert.equal(result.already_unregistered, true);
        h.lists.listArmGnuToolchains = [{ toolchainPath: arm, targetTriple: 'arm-none-eabi' }];
        h.lists.listSDKs = [sdk];
      }
      assert.equal(h.asked.length, 2);
      assert.ok(fs.existsSync(arm) && fs.existsSync(sdk));
    });

    it('warns in a dry run that unregistering an IAR toolchain loses its token', async () => {
      const sdk = makeSdk(path.join(h.root, 'sdk'), '0.17.4', []);
      const iar = makeIar(path.join(h.root, 'iar'));
      h.lists.listSDKs = [sdk];
      h.lists.listIARs = [{ iarPath: iar, zephyrSdkPath: sdk, token: IAR_TOKEN }];
      const dry = await remove({ what: 'toolchain', path: iar, dry_run: true });
      assert.equal(dry.has_token, true);
      assert.equal(dry.token_lost, true);
      assert.ok(!JSON.stringify(dry).includes(IAR_TOKEN));
      assert.equal(h.lists.listIARs.length, 1);
    });

    it('never deletes IAR files or the SDK of the host tools, and never unregisters that SDK', async () => {
      const iar = makeIar(path.join(h.root, 'iar'));
      h.lists.listIARs = [{ iarPath: iar, zephyrSdkPath: '/sdk', token: '' }];
      assert.match((await errorOf(remove({ what: 'toolchain_files', path: iar }))).message, /never deleted from disk/);
      const internal = makeSdk(path.join(process.env.HOME!, '.zinstaller', 'zephyr-sdk-0.17.4'), '0.17.4', []);
      fs.mkdirSync(path.join(process.env.HOME!, '.zinstaller', 'tools'), { recursive: true });
      h.lists.listSDKs = [internal];
      assert.match((await errorOf(remove({ what: 'toolchain_files', path: internal }))).message, /host tools/);
      assert.match((await errorOf(remove({ what: 'toolchain', path: internal }))).message, /host tools/);
      assert.ok(fs.existsSync(iar) && fs.existsSync(internal));
    });

    it('unregisters a registration whose folder is gone, but will not delete it', async () => {
      const gone = path.join(h.root, 'gone-rust');
      h.lists.listRustToolchains = [{ toolchainPath: gone }];
      assert.match((await errorOf(remove({ what: 'toolchain_files', path: gone }))).message, /already gone/);
      h.confirmActions = [];
      const result = await remove({ what: 'toolchain', path: gone });
      assert.equal(result.unregistered, true);
      assert.deepEqual(h.lists.listRustToolchains, []);
    });

    it('says a global SDK has no registration to remove', async () => {
      const globalSdk = makeSdk(path.join(process.env.HOME!, 'zephyr-sdk-0.17.4'), '0.17.4', []);
      await refreshGlobalSdkDetection();
      const refused = await errorOf(remove({ what: 'toolchain', path: globalSdk }));
      assert.match(refused.message, /not registered/);
      assert.match(refused.hint ?? '', /toolchain_files/);
    });

    it('unregisters an SDK that stays globally discoverable, which then shows as global', async () => {
      const sdk = makeSdk(path.join(process.env.HOME!, 'zephyr-sdk-0.17.4'), '0.17.4', []);
      h.lists.listSDKs = [sdk];
      h.confirmActions = [];
      const result = await remove({ what: 'toolchain', path: sdk });
      assert.equal(result.still_listed_as_global, true);
      const listed = await list();
      assert.equal(listed.zephyr_sdks.find((entry: any) => entry.path === sdk).global, true);
    });

    it('deletes an Arm GNU Toolchain from disk as a job and unregisters it', async () => {
      const arm = makeArmGnu(path.join(h.root, 'arm'));
      h.lists.listArmGnuToolchains = [{ toolchainPath: arm, targetTriple: 'arm-none-eabi' }];
      const dry = await remove({ what: 'toolchain_files', path: arm, dry_run: true });
      assert.equal(dry.would_delete, arm);
      assert.ok(fs.existsSync(arm));
      h.confirmActions = [];
      const result = await remove({ what: 'toolchain_files', path: arm });
      assert.equal(result.kind, 'clean');
      assert.equal(result.status, 'succeeded');
      assert.equal(result.result.deleted, arm);
      assert.equal(result.result.unregistered, true);
      assert.equal(result.result.already_unregistered, undefined);
      assert.ok(!fs.existsSync(arm));
      assert.deepEqual(h.lists.listArmGnuToolchains, []);
      assert.deepEqual(h.refreshed.at(-1), ['toolchains']);
    });

    it('still deletes a toolchain unregistered elsewhere while the user was asked, and says so instead of failing', async () => {
      const sdk = makeSdk(path.join(h.root, 'sdk'), '0.17.4', []);
      const arm = makeArmGnu(path.join(h.root, 'arm'));
      const rust = makeRust(path.join(h.root, 'rust'));
      // Another window removes it from its Toolchains view meanwhile.
      h.onAsk = () => {
        h.lists.listSDKs = [];
        h.lists.listArmGnuToolchains = [];
        h.lists.listRustToolchains = [];
      };
      for (const target of [sdk, arm, rust]) {
        h.lists.listSDKs = [sdk];
        h.lists.listArmGnuToolchains = [{ toolchainPath: arm, targetTriple: 'arm-none-eabi' }];
        h.lists.listRustToolchains = [{ toolchainPath: rust, version: '1.87.0' }];
        h.answer('allow');
        const result = await remove({ what: 'toolchain_files', path: target });
        assert.equal(result.status, 'succeeded', JSON.stringify(result.result));
        assert.equal(result.result.deleted, target);
        assert.equal(result.result.unregistered, false);
        assert.equal(result.result.already_unregistered, true);
        assert.ok(!fs.existsSync(target), `${target} is deleted`);
      }
      assert.equal(h.asked.length, 3);
    });

    it('takes any listed path, parentheses included, since it only picks a listed toolchain', async () => {
      // Where the Arm installer puts it on Windows; the wizard registers it as it is.
      const arm = makeArmGnu(path.join(h.root, 'Program Files (x86)', 'Arm GNU Toolchain arm-none-eabi', '13.2 Rel1'));
      h.lists.listArmGnuToolchains = [{ toolchainPath: arm, targetTriple: 'arm-none-eabi' }];
      assert.equal((await remove({ what: 'toolchain_files', path: arm, dry_run: true })).would_delete, arm);
      h.confirmActions = [];
      assert.equal((await remove({ what: 'toolchain', path: arm })).unregistered, true);
      assert.deepEqual(h.lists.listArmGnuToolchains, []);
      assert.ok(fs.existsSync(arm));
      assert.equal(await codeOf(remove({ what: 'toolchain', path: 'relative (x86)/arm' })), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(remove({ what: 'toolchain', path: `${arm}\nsecond line` })), 'INVALID_ARGUMENT');
    });

    it('refuses a path that is not listed', async () => {
      assert.equal(await codeOf(remove({ what: 'toolchain', path: path.join(h.root, 'nothing') })), 'INVALID_ARGUMENT');
    });
  });

  describe('toolchain jobs', () => {
    it('turns the job signal into the cancellation token the downloads listen to', () => {
      const controller = new AbortController();
      const token = cancellationTokenFor(controller.signal);
      let fired = 0;
      const subscription = token.onCancellationRequested(() => { fired++; });
      assert.equal(token.isCancellationRequested, false);
      controller.abort();
      assert.equal(token.isCancellationRequested, true);
      assert.equal(fired, 1);
      subscription.dispose();
    });

    it('logs each progress message once and a percentage once per tenth', () => {
      const lines: string[] = [];
      const reporter = jobReporter(text => lines.push(text.trim()), []);
      for (const message of ['Download x', 'Download x', 'Downloading... 1%', 'Downloading... 5%', 'Downloading... 12%', 'Downloading... 100%', 'Extracting y']) {
        reporter.report({ message });
      }
      assert.deepEqual(lines, ['Download x', 'Downloading... 1%', 'Downloading... 12%', 'Downloading... 100%', 'Extracting y']);
    });

    it('deletes only its own downloads, whatever happens, and never the rest of the download folder', async () => {
      const folder = path.join(h.root, 'downloads');
      const mine = path.join(folder, 'mine.tar.xz');
      const other = path.join(folder, 'other-install.tar.xz');
      write(mine);
      write(other);
      const view = await runToolchainJob(h.ctx('manage_toolchain'), {
        kind: 'install', lockKey: TOOLCHAIN_DOWNLOAD_LOCK, requestKey: 'test', command: 'test install', step: 'Test',
        run: async ({ ictx }) => {
          ictx.hooks?.onDownloaded?.(mine);
          throw new Error('extraction failed');
        },
        next: () => 'next',
      }, 10) as any;
      assert.equal(view.status, 'failed');
      assert.equal(view.result.error, 'extraction failed');
      assert.ok(!fs.existsSync(mine));
      assert.ok(fs.existsSync(other));
    });

    it('refuses a download from anywhere but the official sources', async () => {
      const view = await runToolchainJob(h.ctx('manage_toolchain'), {
        kind: 'install', lockKey: TOOLCHAIN_DOWNLOAD_LOCK, requestKey: 'test-url', command: 'test', step: 'Test',
        downloads: { sources: [{ hosts: ['github.com'], pathPrefixes: ['/zephyrproject-rtos/sdk-ng/releases/download/'] }], archive: true },
        run: async ({ ictx }) => {
          ictx.hooks?.beforeDownload?.('https://example.com/zephyr-sdk.tar.xz');
          return {};
        },
        next: () => 'next',
      }, 10) as any;
      assert.equal(view.status, 'failed');
      assert.equal(view.result.error_code, 'INVALID_ARGUMENT');
    });
  });
});
