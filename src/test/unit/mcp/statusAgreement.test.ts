import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'yaml';
import { TOOL_CATALOG } from '../../../mcp/core/catalog';
import { AuditBag, ToolContext } from '../../../mcp/core/toolSpec';
import { HostDeps } from '../../../mcp/host/handlers/deps';
import { checkEnvironment } from '../../../mcp/host/handlers/environment';
import { getStatus, listApps } from '../../../mcp/host/handlers/queries';
import { HostServices } from '../../../mcp/host/services';
import { ZephyrApplication } from '../../../models/ZephyrApplication';
import type { DebugToolsManifest } from '../../../utils/debugTools/debugToolVersionUtils';
import type { HostToolsStatus } from '../../../utils/hostToolsStatusCollector';
import {
  FakeUri, FakeWindow, installFakeWindow, makeApplicationFolder, makeSdk, makeWestWorkspace, readSettingsFile, tempDir, writeFile,
  writeSettingsFile,
} from '../appTestWorkspace';

// get_status and check_environment run against the same window: stub
// services, the vscode stub with its env script setting pointed at a real
// file, and a host tools folder under VSCODE_PORTABLE. Their `ready` must
// always match, because the server instructions send the agent from one to
// the other.

const REPO = path.resolve(__dirname, '../../../..');
const MANIFEST: DebugToolsManifest = yaml.parse(fs.readFileSync(path.join(REPO, 'scripts/runners/debug-tools.yml'), 'utf8'));

type Stub = { Uri: unknown; workspace: { getConfiguration: unknown } };
// The raw stub module, whose exports can be swapped for this file's tests.
const stub = require('vscode') as Stub;

interface FakeApp {
  appRootPath: string;
  appName: string;
  toolchainVariant: string;
  selectedArmGnuToolchainInstallation?: object;
  westWorkspaceRootPath: string;
  zephyrSdkPath: string;
  isGlobalSdk: boolean;
  venvPath?: string;
  buildConfigs: object[];
}

function fakeApp(over: Partial<FakeApp> = {}): FakeApp {
  const buildDir = path.join(os.tmpdir(), 'zw-never-built');
  return {
    appRootPath: '/ws/app',
    appName: 'app',
    toolchainVariant: 'zephyr',
    westWorkspaceRootPath: '',
    zephyrSdkPath: '',
    isGlobalSdk: false,
    buildConfigs: [{
      name: 'primary',
      active: true,
      boardIdentifier: 'nucleo_f401re',
      defaultRunner: '',
      getBuildDir: () => buildDir,
      getBuildArtifactPath: () => undefined,
    }],
    ...over,
  };
}

function hostStatus(internalDir: string): HostToolsStatus {
  return {
    internalDir,
    installed: true,
    complete: true,
    envFile: { path: path.join(internalDir, 'env.sh'), exists: true },
    stamp: { path: path.join(internalDir, 'zinstaller_version'), exists: true },
    zinstaller: { installedVersion: '2.1', minimum: '2.0', upToDate: true },
    parts: [],
    presence: {},
    undetermined: [],
    missing: [],
    versionCheck: { ran: false },
    errors: [],
  };
}

function contexts(apps: FakeApp[], sdkCount: number, internalDir: string) {
  const sdks = Array.from({ length: sdkCount }, (_, i) => ({ rootUri: { fsPath: `/sdk${i}` }, version: '0.17.0' }));
  const services = {
    debugToolsManifest: () => MANIFEST,
    listApplications: async () => apps,
    listWestWorkspaces: () => [{ rootUri: { fsPath: '/ws' }, version: '4.2.0', kernelUri: { fsPath: '/ws/zephyr' } }],
    listSdks: async () => sdks,
    resolveApp: async () => apps[0],
    resolveConfig: (app: FakeApp) => app.buildConfigs[0],
    hostToolsStatus: async () => hostStatus(internalDir),
    debugToolsStatus: async () => [],
    findUnregisteredCandidates: async () => [],
    isBuilt: () => false,
  };
  const deps = {
    services: services as unknown as HostServices,
    jobs: { list: () => [] },
    confirmActions: [],
  } as unknown as HostDeps;
  const ctx = (name: string): ToolContext<HostDeps> => ({
    signal: new AbortController().signal,
    progress: () => undefined,
    client: { name: 'test' },
    deps,
    tool: TOOL_CATALOG.find(tool => tool.name === name)!,
    startedAt: Date.now(),
    audit: {} as AuditBag,
  });
  return { status: ctx('get_status'), check: ctx('check_environment') };
}

type Result = Record<string, any>;

describe('get_status and check_environment readiness', () => {
  let saved: string | undefined;
  let root: string;
  let internal: string;
  let savedUri: unknown;
  let savedGetConfiguration: unknown;

  /** A venv folder, with west in it when asked. */
  function venv(dir: string, withWest: boolean): string {
    const bin = path.join(dir, process.platform === 'win32' ? 'Scripts' : 'bin');
    fs.mkdirSync(bin, { recursive: true });
    if (withWest) {
      fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'west.exe' : 'west'), '');
    }
    return dir;
  }

  beforeEach(() => {
    saved = process.env.VSCODE_PORTABLE;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-agreement-'));
    process.env.VSCODE_PORTABLE = root;
    internal = path.join(root, '.zinstaller');
    fs.mkdirSync(internal, { recursive: true });
    const envScript = path.join(internal, process.platform === 'win32' ? 'env.ps1' : 'env.sh');
    fs.writeFileSync(envScript, '# env\n');

    savedUri = stub.Uri;
    savedGetConfiguration = stub.workspace.getConfiguration;
    // The settings reader tests `scope instanceof vscode.Uri`, which needs a constructor.
    stub.Uri = Object.assign(function Uri() { /* stub */ }, stub.Uri);
    stub.workspace.getConfiguration = () => ({
      get: (key: string) => (key === 'zephyr-workbench.pathToEnvScript' ? envScript : undefined),
      inspect: () => undefined,
      update: async () => undefined,
    });
  });
  afterEach(() => {
    stub.Uri = savedUri;
    stub.workspace.getConfiguration = savedGetConfiguration;
    if (saved === undefined) {
      delete process.env.VSCODE_PORTABLE;
    } else {
      process.env.VSCODE_PORTABLE = saved;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function both(apps: FakeApp[], sdkCount: number) {
    const { status, check } = contexts(apps, sdkCount, internal);
    const quick = await getStatus({}, status) as Result;
    const detailed = await checkEnvironment({ depth: 'quick' }, check) as Result;
    return { quick, detailed };
  }

  it('judges a single Arm GNU application without a Zephyr SDK the same way', async () => {
    venv(path.join(internal, '.venv'), true);
    const app = fakeApp({ toolchainVariant: 'gnuarmemb', selectedArmGnuToolchainInstallation: {} });
    const { quick, detailed } = await both([app], 0);
    assert.equal(detailed.ready, true, JSON.stringify(detailed.problems));
    assert.equal(quick.environment.ready, detailed.ready);
    assert.ok(!quick.next_steps.some((s: string) => /No Zephyr SDK/.test(s)), 'the application needs no Zephyr SDK');
  });

  it('judges a single application by the venv its builds use, not the global one', async () => {
    venv(path.join(internal, '.venv'), false);
    const app = fakeApp({ venvPath: venv(path.join(root, 'ws', '.venv'), true) });
    const { quick, detailed } = await both([app], 1);
    assert.equal(detailed.ready, true, JSON.stringify(detailed.problems));
    assert.equal(quick.environment.ready, detailed.ready);
    assert.equal(quick.environment.venv_ok, true);
  });

  it('agrees when the single application\'s toolchain is no longer registered', async () => {
    venv(path.join(internal, '.venv'), true);
    const app = fakeApp({ toolchainVariant: 'gnuarmemb' });
    const { quick, detailed } = await both([app], 1);
    assert.equal(detailed.ready, false);
    assert.equal(quick.environment.ready, detailed.ready);
    assert.ok(quick.next_steps.some((s: string) => /check_environment/.test(s)));
  });

  it('judges the machine alone when the window has several applications', async () => {
    venv(path.join(internal, '.venv'), true);
    const apps = [
      fakeApp({ appRootPath: '/ws/a', toolchainVariant: 'gnuarmemb', selectedArmGnuToolchainInstallation: {} }),
      fakeApp({ appRootPath: '/ws/b' }),
    ];
    const { quick, detailed } = await both(apps, 0);
    assert.equal(detailed.ready, false, 'no SDK, and no single application to excuse it');
    assert.equal(quick.environment.ready, detailed.ready);
    assert.ok(quick.next_steps.some((s: string) => /No Zephyr SDK/.test(s)));
  });
});

// list_apps describes each application's toolchain, SDK compatibility,
// IntelliSense provider and venv from the same model the views use, so the
// agent can pass them back to configure and manage_app as they are.
describe('list_apps application details', () => {
  let window: FakeWindow;
  let root: string;
  let ws: string;
  let sdk: string;
  beforeEach(() => {
    root = tempDir('zw-appdto-');
    ws = makeWestWorkspace(path.join(root, 'ws'));
    sdk = makeSdk(path.join(root, 'zephyr-sdk-0.17.0'), '0.17.0');
    window = installFakeWindow([ws]);
    window.workspaceFile = path.join(root, 'test.code-workspace');
    window.user['zephyr-workbench.listSDKs'] = [sdk];
    ZephyrApplication.clearApplicationWorkspaceCache();
  });
  afterEach(() => window.restore());

  const ctx = (services: HostServices): ToolContext<HostDeps> => ({
    signal: new AbortController().signal,
    progress: () => undefined,
    client: { name: 'test' },
    deps: { services } as unknown as HostDeps,
    tool: TOOL_CATALOG.find(tool => tool.name === 'list_apps')!,
    startedAt: Date.now(),
    audit: {} as AuditBag,
  });

  function freestanding(name: string, settings: Record<string, unknown>): string {
    const app = makeApplicationFolder(path.join(root, name));
    writeSettingsFile(app, {
      'zephyr-workbench.westWorkspace': ws,
      'zephyr-workbench.build.configurations': [{ name: 'primary', board: 'qemu_x86', active: 'true' }],
      ...settings,
    });
    window.folders.push(app);
    return app;
  }

  it('reports the Zephyr SDK, its compatibility, the provider and the venv the application builds with', async () => {
    fs.mkdirSync(path.join(ws, '.venv'));
    const app = freestanding('sdk-app', { 'zephyr-workbench.toolchain': 'zephyr', 'zephyr-workbench.sdk': sdk });
    const services = new HostServices(FakeUri.file(root) as never);
    const result = await listApps({ app_path: app }, ctx(services)) as Result;
    const dto = result.apps[0];
    assert.equal(dto.kind, 'freestanding');
    assert.equal(dto.west_workspace, ws);
    assert.deepEqual(dto.toolchain, { family: 'zephyr_sdk', path: sdk, variant: 'gnu', global_sdk: false, sdk_version: '0.17.0' });
    assert.deepEqual(dto.sdk_compat, { status: 'compatible', zephyr_version: '4.1.0', recommended_sdk: '0.17.0' });
    assert.deepEqual(dto.intellisense_provider, { name: 'cpptools', installed: false });
    assert.deepEqual(dto.venv, { path: path.join(ws, '.venv'), source: 'west_workspace' });

    const own = path.join(root, 'own-venv');
    writeSettingsFile(app, { ...readSettingsFile(app), 'zephyr-workbench.venv.path': own });
    assert.deepEqual((await listApps({ app_path: app }, ctx(services)) as Result).apps[0].venv, { path: own, source: 'app' });
  });

  it('names an IAR toolchain by its path and never carries its licence token', async () => {
    const iar = path.join(root, 'iar');
    writeFile(path.join(iar, 'bin', process.platform === 'win32' ? 'iccarm.exe' : 'iccarm'));
    window.user['zephyr-workbench.listIARs'] = [{ iarPath: iar, zephyrSdkPath: sdk, token: 'very-secret-token' }];
    const app = freestanding('iar-app', { 'zephyr-workbench.toolchain': 'iar', 'zephyr-workbench.iar': iar });
    const result = await listApps({ app_path: app }, ctx(new HostServices(FakeUri.file(root) as never))) as Result;
    assert.deepEqual(result.apps[0].toolchain, { family: 'iar', path: iar, global_sdk: false, sdk_version: '0.17.0' });
    assert.ok(!JSON.stringify(result).includes('very-secret-token'));
  });

  it('flags a toolchain the settings name that is not registered any more', async () => {
    const app = freestanding('gone-app', { 'zephyr-workbench.toolchain': 'zephyr', 'zephyr-workbench.sdk': path.join(root, 'deleted-sdk') });
    const dto = (await listApps({ app_path: app }, ctx(new HostServices(FakeUri.file(root) as never))) as Result).apps[0];
    assert.equal(dto.toolchain.missing, true);
    assert.equal(dto.sdk_compat, undefined);
  });
});
