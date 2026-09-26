// manage_app, configure target "app" action "update" and remove_or_delete
// what "application" / "application_files", run against real folders in a VS
// Code window whose folder settings live in each folder's .vscode. The
// services, settings writers, confirmation gate, job manager and fences are
// the production code; only the board and sample listings, the folder
// scheduler and the venv installer are stood in for.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { findTool, TOOL_CATALOG } from '../../../mcp/core/catalog';
import { McpToolError } from '../../../mcp/core/errors';
import { ConfirmCategory, permissionForCategories, ToolContext } from '../../../mcp/core/toolSpec';
import { AskAnswer, Confirmations } from '../../../mcp/host/confirmations';
import { FolderChange, folderChangeRestartsHost } from '../../../mcp/host/folderChanges';
import { manageApp } from '../../../mcp/host/handlers/apps';
import { configure } from '../../../mcp/host/handlers/buildConfigs';
import { HostDeps } from '../../../mcp/host/handlers/deps';
import { removeOrDelete } from '../../../mcp/host/handlers/removals';
import { HostServices } from '../../../mcp/host/services';
import { JobManager, JobSpec } from '../../../mcp/jobs/jobManager';
import { ZephyrApplication } from '../../../models/ZephyrApplication';
import { KconfigSessionPool } from '../../../utils/kconfig/kconfigSessionPool';
import {
  FakeUri, FakeWindow, installFakeWindow, makeApplicationFolder, makeArmGnu, makeSdk, makeWestWorkspace, readSettingsFile, tempDir,
  writeFile, writeSettingsFile,
} from '../appTestWorkspace';
import { useUiGuard } from './uiGuard';

const installUtils = require('../../../utils/installUtils') as Record<string, unknown>;

const ALL: ConfirmCategory[] = ['hardware', 'delete', 'workspace', 'install', 'settings'];

interface Harness {
  root: string;
  ws: string;
  sdk: string;
  sample: string;
  boardDir: string;
  window: FakeWindow;
  services: HostServices;
  jobs: JobManager;
  deps: HostDeps;
  asked: string[];
  confirmActions: ConfirmCategory[];
  folderCalls: Array<FolderChange & { reason: string }>;
  refreshed: string[][];
  served: Set<string>;
  /** Asked before each job starts, as the folder scheduler is in the extension; throws to refuse it. */
  admit?(spec: JobSpec): void;
  ctx(tool: string): ToolContext<HostDeps>;
  answer(value: AskAnswer): void;
}

function harness(options: { open?: string[]; multiRoot?: boolean } = {}): Harness {
  const root = tempDir('zw-manage-app-');
  const ws = makeWestWorkspace(path.join(root, 'ws'));
  const sdk = makeSdk(path.join(root, 'zephyr-sdk-0.17.0'), '0.17.0');
  const sample = path.join(ws, 'zephyr', 'samples', 'hello_world');
  const boardDir = path.join(ws, 'zephyr', 'boards', 'nordic', 'nrf52840dk');
  writeFile(path.join(boardDir, 'nrf52840dk_nrf52840.yaml'), 'identifier: nrf52840dk\narch: arm\n');
  const window = installFakeWindow(options.open ?? [ws]);
  window.workspaceFile = options.multiRoot === false ? undefined : path.join(root, 'test.code-workspace');
  window.user['zephyr-workbench.listSDKs'] = [sdk];
  ZephyrApplication.clearApplicationWorkspaceCache();

  const h = { root, ws, sdk, sample, boardDir, window } as Harness;
  const services = new HostServices(FakeUri.file(root) as never);
  services.catalog.list = (async (kind: string) => ({
    source: kind === 'board' ? 'west boards' : 'filesystem',
    entries: kind === 'board'
      ? [{ name: 'nrf52840dk', identifiers: ['nrf52840dk/nrf52840'], qualifiers: ['nrf52840'], revisions: [], dir: boardDir }]
      : [{ name: 'hello_world', kind: 'sample', path: sample, display_path: 'zephyr/samples/hello_world', source: 'zephyr' }],
    skippedRoots: [],
    cached: true,
    listedAt: Date.now(),
  })) as never;
  const jobs = new JobManager({ logPathFor: id => path.join(root, `${id}.log`), admit: spec => h.admit?.(spec) });
  const asked: string[] = [];
  const answers: AskAnswer[] = [];
  h.confirmActions = [...ALL];
  const confirmations = new Confirmations({
    permission: tool => permissionForCategories(tool, h.confirmActions),
    waitMs: () => 2000,
    log: { recordConfirmation: () => undefined },
    ask: async message => {
      asked.push(message);
      return answers.length > 0 ? answers.shift() : 'allow';
    },
  });
  h.folderCalls = [];
  h.refreshed = [];
  h.served = new Set(TOOL_CATALOG.map(tool => tool.name));
  const deps: HostDeps = {
    services, jobs, confirmations,
    defaultWaitSeconds: 5,
    revealTerminal: 'never',
    permissionOf: tool => permissionForCategories(tool, h.confirmActions),
    kconfig: new KconfigSessionPool({
      serverScriptPath: 'kconfig_server.py',
      start: async () => { throw new Error('no Kconfig server in these tests'); },
    }),
    extensionContext: { extensionUri: FakeUri.file(root) } as never,
    folders: {
      apply: async (change: FolderChange, opts: { reason: string }) => {
        h.folderCalls.push({ ...change, reason: opts.reason });
        if (folderChangeRestartsHost(change, { workspaceFile: !!window.workspaceFile, folders: [...window.folders] })) {
          return { applied: false, restart_pending: true };
        }
        for (const folder of change.remove ?? []) {
          window.folders.splice(window.folders.indexOf(folder), 1);
        }
        window.folders.push(...(change.add ?? []));
        return { applied: true, restart_pending: false };
      },
      pending: () => [],
      restartNotice: () => undefined,
    } as never,
    refreshViews: async views => { h.refreshed.push([...views]); },
    servedTools: () => h.served,
  };
  Object.assign(h, {
    services, jobs, deps, asked,
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
  return h;
}

async function errorOf(promise: Promise<unknown>): Promise<McpToolError> {
  try {
    await promise;
  } catch (error) {
    return error as McpToolError;
  }
  assert.fail('expected the call to be refused');
}

/** A freestanding application folder with its settings, linked to the harness west workspace. */
function freestandingApp(h: Harness, name: string, extra: Record<string, unknown> = {}): string {
  const app = makeApplicationFolder(path.join(h.root, 'apps', name));
  writeSettingsFile(app, {
    'zephyr-workbench.westWorkspace': h.ws,
    'zephyr-workbench.toolchain': 'zephyr',
    'zephyr-workbench.sdk': h.sdk,
    'zephyr-workbench.build.configurations': [{ name: 'primary', board: 'nrf52840dk/nrf52840', active: 'true' }],
    ...extra,
  });
  return app;
}

/** A job holding an application's build folder until the test lets it go. */
function holdBuild(jobs: JobManager, app: string): () => void {
  let release: () => void = () => undefined;
  const buildDir = path.join(app, 'build', 'primary');
  const spec: JobSpec = {
    kind: 'build', lockKey: buildDir, requestKey: `build:${buildDir}`, appPath: app, buildDir, command: 'west build',
    run: () => new Promise(resolve => { release = () => resolve({ exitCode: 0 }); }),
  };
  jobs.start(spec);
  return () => release();
}

describe('mcp/host/handlers/apps', () => {
  useUiGuard();

  let h: Harness;
  afterEach(() => h?.window.restore());

  describe('manage_app create', () => {
    it('plans a workspace application without asking or writing anything', async () => {
      h = harness();
      const settingsBefore = readSettingsFile(h.ws);
      const result = await manageApp({
        action: 'create', template: h.sample, board: 'nrf52840dk/nrf52840', name: 'hello', dry_run: true,
      }, h.ctx('manage_app')) as Record<string, any>;

      const app = path.join(h.ws, 'applications', 'hello');
      assert.equal(result.dry_run, true);
      assert.equal(result.app_path, app);
      assert.deepEqual(result.toolchain, { family: 'zephyr_sdk', path: h.sdk, variant: 'gnu', sdk_version: '0.17.0', defaulted: true });
      assert.equal(result.sdk_compat.zephyr_version, '4.1.0');
      assert.equal(result.settings.setting, 'zephyr-workbench.westWorkspace.applications');
      assert.equal(result.settings.entry.path, 'applications/hello');
      assert.deepEqual(result.settings.entry['build.configurations'], [{ name: 'primary', board: 'nrf52840dk/nrf52840', active: 'true' }]);
      assert.deepEqual(result.files, [app, path.join(app, 'prj.conf'), path.join(h.ws, '.vscode', 'settings.json'), path.join(h.ws, '.vscode', 'c_cpp_properties.json')]);
      assert.equal(result.confirmation_required, true);
      assert.equal(h.asked.length, 0);
      assert.ok(!fs.existsSync(app));
      assert.deepEqual(readSettingsFile(h.ws), settingsBefore);
    });

    it('creates a workspace application after asking under "workspace", and returns it as list_apps reports it', async () => {
      h = harness();
      const ctx = h.ctx('manage_app');
      const result = await manageApp({
        action: 'create', template: h.sample, board: 'nrf52840dk/nrf52840', name: 'hello', applications_subfolder: 'apps',
      }, ctx) as Record<string, any>;

      const app = path.join(h.ws, 'apps', 'hello');
      assert.equal(h.asked.length, 1);
      assert.equal(ctx.audit.confirmCategory, 'workspace');
      assert.deepEqual(result.confirmation, { category: 'workspace', outcome: 'allowed' });
      assert.equal(result.restart_pending, false);
      assert.deepEqual(h.folderCalls, [], 'a workspace application needs no new folder');
      assert.deepEqual(result.app, h.services.toAppDto(await h.services.resolveApp(app)));
      assert.equal(result.app.kind, 'workspace');
      assert.equal(result.app.configs[0].board, 'nrf52840dk/nrf52840');
      assert.match(fs.readFileSync(path.join(app, 'prj.conf'), 'utf8'), /CONFIG_DEBUG_OPTIMIZATIONS=y/, 'the debug preset is on by default');
      const debugPreset = (findTool('manage_app')!.inputSchema.shape as Record<string, { description?: string }>).debug_preset.description ?? '';
      assert.match(debugPreset, /prj\.conf/, 'debug_preset says what it writes');
      assert.doesNotMatch(debugPreset, /launch/, 'debug_preset writes no launch configuration');
      assert.ok(result.files_written.includes(path.join(h.ws, '.vscode', 'c_cpp_properties.json')));
      assert.deepEqual(h.refreshed, [['apps', 'westWorkspaces']]);
      assert.match(result.next, /build_app/);
    });

    it('refuses a template the catalog does not list, a taken destination and a west workspace that is not open', async () => {
      h = harness();
      const elsewhere = makeApplicationFolder(path.join(h.root, 'elsewhere'));
      const refused = await errorOf(manageApp({ action: 'create', template: elsewhere, board: 'nrf52840dk/nrf52840' }, h.ctx('manage_app')));
      assert.equal(refused.code, 'INVALID_ARGUMENT');
      assert.match(refused.hint ?? '', /search_zephyr_catalog/);

      makeApplicationFolder(path.join(h.ws, 'applications', 'hello_world'));
      assert.equal((await errorOf(manageApp({ action: 'create', template: h.sample, board: 'nrf52840dk/nrf52840' }, h.ctx('manage_app')))).code,
        'INVALID_ARGUMENT');

      h.window.restore();
      // Registered through a freestanding application only, not open as a folder.
      h = harness({ open: [] });
      const linked = freestandingApp(h, 'linked');
      h.window.folders.push(linked);
      const notOpen = await errorOf(manageApp({ action: 'create', template: h.sample, board: 'nrf52840dk/nrf52840' }, h.ctx('manage_app')));
      assert.match(notOpen.message, /not open as a VS Code folder/);
      assert.match(notOpen.hint ?? '', /manage_west_workspace/);
      assert.equal(h.asked.length, 0);
    });

    it('creates a freestanding application in a single-folder window and defers adding its folder, describing it from its settings', async () => {
      // Adding a second folder turns the window into a workspace, which restarts the extensions.
      h = harness({ multiRoot: false });
      const parent = path.join(h.root, 'apps');
      fs.mkdirSync(parent);
      const result = await manageApp({
        action: 'create', kind: 'freestanding', template: h.sample, board: 'nrf52840dk/nrf52840', name: 'blinky', parent_dir: parent,
        toolchain: { family: 'zephyr_sdk', path: h.sdk }, debug_preset: false, intellisense_provider: 'clangd',
      }, h.ctx('manage_app')) as Record<string, any>;

      const app = path.join(parent, 'blinky');
      assert.equal(result.restart_pending, true);
      assert.deepEqual(h.folderCalls.map(call => call.add), [[app]]);
      assert.deepEqual(h.window.folders, [h.ws], 'the folder is added only after the answer');
      assert.equal(result.app.app_path, app);
      assert.equal(result.app.kind, 'freestanding');
      assert.equal(result.app.west_workspace, h.ws);
      assert.deepEqual(result.app.toolchain, { family: 'zephyr_sdk', path: h.sdk, variant: 'gnu', global_sdk: false, sdk_version: '0.17.0' });
      assert.deepEqual(result.app.intellisense_provider, { name: 'clangd', installed: false });
      assert.deepEqual(result.app.configs.map((config: { name: string; board: string }) => [config.name, config.board]), [['primary', 'nrf52840dk/nrf52840']]);
      assert.equal(readSettingsFile(app)['zephyr-workbench.intellisense.provider'], 'clangd');
      assert.doesNotMatch(fs.readFileSync(path.join(app, 'prj.conf'), 'utf8'), /DEBUG PRESET/);
      assert.match(result.next, /get_status/);

      // Once VS Code has the folder, list_apps reports the same application.
      h.window.folders.push(app);
      ZephyrApplication.clearApplicationWorkspaceCache();
      assert.deepEqual(h.services.toAppDto(await h.services.resolveApp(app)), result.app);
    });

    it('validates names, folders, boards and toolchains before anything else', async () => {
      h = harness();
      const create = (extra: Record<string, unknown>) => errorOf(manageApp({
        action: 'create', template: h.sample, board: 'nrf52840dk/nrf52840', ...extra,
      }, h.ctx('manage_app')));
      assert.equal((await create({ name: 'my app' })).code, 'INVALID_ARGUMENT');
      assert.equal((await create({ applications_subfolder: '../outside' })).code, 'INVALID_ARGUMENT');
      assert.equal((await create({ parent_dir: h.root })).code, 'INVALID_ARGUMENT', 'parent_dir is for freestanding only');
      assert.equal((await create({ kind: 'freestanding' })).code, 'INVALID_ARGUMENT', 'freestanding needs parent_dir');
      assert.equal((await create({ board: 'nrf;reboot' })).code, 'INVALID_ARGUMENT');
      assert.equal((await create({ toolchain: { family: 'zephyr_sdk', path: path.join(h.root, 'nope') } })).code, 'INVALID_ARGUMENT');
      assert.equal((await create({ toolchain: { family: 'zephyr_sdk', path: h.sdk, variant: 'llvm' } })).code, 'INVALID_ARGUMENT',
        'this SDK has no LLVM');
      assert.equal((await create({ path: h.root })).code, 'INVALID_ARGUMENT', 'path is for import');
      assert.equal(h.asked.length, 0);
    });

    it('asks for a toolchain when no installed SDK suits the Zephyr version, naming the one it recommends', async () => {
      h = harness();
      h.window.user['zephyr-workbench.listSDKs'] = [makeSdk(path.join(h.root, 'zephyr-sdk-1.0.0'), '1.0.0')];
      const refused = await errorOf(manageApp({ action: 'create', template: h.sample, board: 'nrf52840dk/nrf52840', dry_run: true }, h.ctx('manage_app')));
      assert.equal(refused.code, 'INVALID_ARGUMENT');
      assert.match(refused.message, /No installed Zephyr SDK suits Zephyr 4\.1\.0\S* \(it recommends SDK 0\.17\.0\)/);
      assert.match(refused.hint ?? '', /list_toolchains/);

      h.served.delete('manage_toolchain');
      const core = await errorOf(manageApp({ action: 'create', template: h.sample, board: 'nrf52840dk/nrf52840', dry_run: true }, h.ctx('manage_app')));
      assert.match(core.hint ?? '', /"Add Toolchain" \(manage_toolchain does it too, if the user allows it in the AI Manager\)/);
    });

    it('warns about a board missing from the board list instead of refusing it', async () => {
      h = harness();
      const result = await manageApp({ action: 'create', template: h.sample, board: 'custom_board', dry_run: true }, h.ctx('manage_app')) as Record<string, any>;
      assert.match(result.warnings.join(' '), /"custom_board" is not in the board list/);
    });
  });

  describe('manage_app import', () => {
    it('names what a first freestanding import is missing', async () => {
      h = harness();
      const plain = makeApplicationFolder(path.join(h.root, 'plain'));
      const incomplete = await errorOf(manageApp({ action: 'import', path: plain }, h.ctx('manage_app')));
      assert.equal(incomplete.code, 'INVALID_ARGUMENT');
      assert.deepEqual(incomplete.details, { missing: ['board'] });

      h.window.folders.push(makeWestWorkspace(path.join(h.root, 'ws2')));
      const two = await errorOf(manageApp({ action: 'import', path: plain, board: 'nrf52840dk/nrf52840' }, h.ctx('manage_app')));
      assert.deepEqual(two.details, { missing: ['west_workspace'] }, 'two west workspaces: the call must say which');
      assert.equal(h.asked.length, 0);
    });

    it('registers a freestanding folder with its settings and adds it to the window', async () => {
      h = harness();
      const plain = makeApplicationFolder(path.join(h.root, 'plain'));
      const ctx = h.ctx('manage_app');
      const result = await manageApp({ action: 'import', path: plain, board: 'nrf52840dk/nrf52840' }, ctx) as Record<string, any>;
      assert.equal(ctx.audit.confirmCategory, 'workspace');
      assert.equal(result.outcome, 'registered');
      assert.equal(result.restart_pending, false);
      assert.deepEqual(h.window.folders, [h.ws, plain]);
      assert.deepEqual(result.app, h.services.toAppDto(await h.services.resolveApp(plain)));
      assert.equal(readSettingsFile(plain)['zephyr-workbench.westWorkspace'], '${workspaceFolder}/../ws');
    });

    it('brings back a folder that already has its settings, and refuses to relink it', async () => {
      h = harness();
      const app = freestandingApp(h, 'back');
      const relink = await errorOf(manageApp({ action: 'import', path: app, board: 'qemu_x86' }, h.ctx('manage_app')));
      assert.match(relink.message, /already has its workbench settings/);

      const result = await manageApp({ action: 'import', path: app }, h.ctx('manage_app')) as Record<string, any>;
      assert.equal(result.outcome, 'reopened');
      assert.deepEqual(h.window.folders, [h.ws, app]);
      assert.equal(result.app.configs[0].board, 'nrf52840dk/nrf52840', 'the existing settings are kept');

      const again = await manageApp({ action: 'import', path: app }, h.ctx('manage_app')) as Record<string, any>;
      assert.equal(again.changed, false);
      assert.equal(h.folderCalls.length, 1);
    });

    it('links a folder of an open west workspace, then selects it, and refuses to link it twice', async () => {
      h = harness();
      const inside = makeApplicationFolder(path.join(h.ws, 'applications', 'mine'));
      const first = await errorOf(manageApp({ action: 'import', path: inside }, h.ctx('manage_app')));
      assert.deepEqual(first.details, { missing: ['board'] });

      const linked = await manageApp({ action: 'import', path: inside, board: 'nrf52840dk/nrf52840' }, h.ctx('manage_app')) as Record<string, any>;
      assert.equal(linked.outcome, 'linked');
      assert.equal(linked.app.kind, 'workspace');
      assert.equal(readSettingsFile(h.ws)['zephyr-workbench.westWorkspace.applications'][0].path, 'applications/mine');

      const selected = await manageApp({ action: 'import', path: inside }, h.ctx('manage_app')) as Record<string, any>;
      assert.equal(selected.outcome, 'selected');
      assert.equal(selected.app.app_path, inside);

      const twice = await errorOf(manageApp({ action: 'import', path: inside, board: 'qemu_x86' }, h.ctx('manage_app')));
      assert.match(twice.message, /already declares/);
    });

    it('refuses a folder inside a linked west workspace that is not open, before planning or asking', async () => {
      h = harness();
      const closed = makeWestWorkspace(path.join(h.root, 'closed-ws'));
      h.window.folders.push(freestandingApp(h, 'linked', { 'zephyr-workbench.westWorkspace': closed }));
      const inside = makeApplicationFolder(path.join(closed, 'applications', 'foo'));
      for (const dryRun of [true, false]) {
        const refused = await errorOf(manageApp({
          action: 'import', path: inside, west_workspace: closed, board: 'nrf52840dk/nrf52840', dry_run: dryRun,
        }, h.ctx('manage_app')));
        assert.equal(refused.code, 'INVALID_ARGUMENT');
        assert.match(refused.message, /not open in VS Code/);
        assert.match(refused.hint ?? '', /call manage_west_workspace with action import and path/);
      }
      assert.equal(h.asked.length, 0);
      assert.deepEqual(h.folderCalls, []);
      assert.ok(!fs.existsSync(path.join(inside, '.vscode')));
      assert.ok(!fs.existsSync(path.join(closed, '.vscode')));
    });
  });

  describe('manage_app create_venv', () => {
    let saved: unknown;
    beforeEach(() => { saved = installUtils.createLocalVenv; });
    afterEach(() => { installUtils.createLocalVenv = saved; });

    it('needs the host tools environment script, and plans without asking', async () => {
      h = harness();
      const app = freestandingApp(h, 'venv');
      h.window.folders.push(app);
      assert.equal((await errorOf(manageApp({ action: 'create_venv', app_path: app }, h.ctx('manage_app')))).code, 'ENV_NOT_READY');

      h.window.user['zephyr-workbench.pathToEnvScript'] = writeFile(path.join(h.root, 'env.sh'));
      const plan = await manageApp({ action: 'create_venv', app_path: app, dry_run: true }, h.ctx('manage_app')) as Record<string, any>;
      assert.deepEqual([plan.venv_path, plan.reuses_existing], [path.join(app, '.venv'), false]);
      assert.match(plan.note, /pyOCD/);

      // An existing venv is reused, but the installer still installs the requirements into it.
      writeFile(path.join(app, '.venv', ...(process.platform === 'win32' ? ['Scripts', 'activate.bat'] : ['bin', 'activate'])));
      const reuse = await manageApp({ action: 'create_venv', app_path: app, dry_run: true }, h.ctx('manage_app')) as Record<string, any>;
      assert.equal(reuse.reuses_existing, true);
      assert.match(reuse.note, /installs or upgrades Zephyr's Python requirements in it/);
      assert.match(reuse.note, /pyOCD.*PyPI/);
      assert.equal(h.asked.length, 0);
    });

    it('creates the venv as an install job, then points the application at it', async () => {
      h = harness();
      h.window.user['zephyr-workbench.pathToEnvScript'] = writeFile(path.join(h.root, 'env.sh'));
      const app = freestandingApp(h, 'venv');
      h.window.folders.push(app);
      const calls: unknown[] = [];
      installUtils.createLocalVenv = async (_context: unknown, folder: { uri: { fsPath: string } }, westRoot: string, base: string | undefined,
        runner: { nonInteractive: boolean; onOutput(chunk: string): void }) => {
        calls.push([folder.uri.fsPath, westRoot, base, runner.nonInteractive]);
        runner.onOutput('pip install west\n');
        return '${workspaceFolder}/.venv';
      };
      const ctx = h.ctx('manage_app');
      const view = await manageApp({ action: 'create_venv', app_path: app }, ctx) as Record<string, any>;
      assert.equal(ctx.audit.confirmCategory, 'install');
      assert.equal(view.kind, 'install');
      assert.equal(view.status, 'succeeded');
      assert.deepEqual(calls, [[app, h.ws, undefined, true]]);
      assert.equal(view.result.venv_path, path.join(app, '.venv'));
      assert.match(view.result.note, /pyOCD/);
      assert.match(view.log.tail, /pip install west/);
      assert.equal(readSettingsFile(app)['zephyr-workbench.venv.path'], '${workspaceFolder}/.venv');
      assert.match(view.next, /pristine/);
    });

    it('declares the linked west workspace, so a job writing it is refused while the venv installs', async () => {
      h = harness();
      h.window.user['zephyr-workbench.pathToEnvScript'] = writeFile(path.join(h.root, 'env.sh'));
      const app = freestandingApp(h, 'venv');
      h.window.folders.push(app);
      let release: () => void = () => undefined;
      installUtils.createLocalVenv = () => new Promise(resolve => { release = () => resolve('${workspaceFolder}/.venv'); });
      const view = await manageApp({ action: 'create_venv', app_path: app, wait_sec: 0 }, h.ctx('manage_app')) as Record<string, any>;
      assert.equal(view.status, 'running');

      const westUpdate: JobSpec = {
        kind: 'west', lockKey: h.ws, requestKey: `west update:${h.ws}`, westWorkspace: h.ws, writes: ['west_workspace'],
        command: 'west update', run: async () => ({ exitCode: 0 }),
      };
      const busy = (() => {
        try {
          h.jobs.start(westUpdate);
        } catch (error) {
          return error as McpToolError;
        }
        return undefined;
      })();
      assert.equal(busy?.code, 'BUSY', 'west update must wait for the venv install that reads the workspace');
      assert.equal(busy?.details?.job_id, view.job_id);

      release();
      const job = h.jobs.list().find(candidate => candidate.id === view.job_id)!;
      await h.jobs.wait(job, 5000);
      assert.equal(job.status, 'succeeded');
    });

    it('refuses in the dry run and before asking while a job writes the linked west workspace, and checks again after', async () => {
      h = harness();
      h.window.user['zephyr-workbench.pathToEnvScript'] = writeFile(path.join(h.root, 'env.sh'));
      const app = freestandingApp(h, 'venv');
      h.window.folders.push(app);
      let installs = 0;
      let finishInstall: () => void = () => undefined;
      installUtils.createLocalVenv = () => {
        installs++;
        return new Promise(resolve => { finishInstall = () => resolve('${workspaceFolder}/.venv'); });
      };
      let finishUpdate: () => void = () => undefined;
      const westUpdate: JobSpec = {
        kind: 'west', lockKey: h.ws, requestKey: `west update:${h.ws}`, westWorkspace: h.ws, writes: ['west_workspace'],
        command: 'west update', run: () => new Promise(resolve => { finishUpdate = () => resolve({ exitCode: 0 }); }),
      };
      const update = h.jobs.start(westUpdate).job;

      const planned = await errorOf(manageApp({ action: 'create_venv', app_path: app, dry_run: true }, h.ctx('manage_app')));
      assert.equal(planned.code, 'BUSY', 'the dry run says it would be refused');
      assert.equal(planned.details?.job_id, update.id);
      const refused = await errorOf(manageApp({ action: 'create_venv', app_path: app }, h.ctx('manage_app')));
      assert.equal(refused.code, 'BUSY');
      assert.match(refused.message, /west workspace/);
      assert.equal(h.asked.length, 0, 'refused before the user is asked');
      finishUpdate();
      await h.jobs.wait(update, 5000);

      // A west update started while the dialog was open.
      const require = h.deps.confirmations.require.bind(h.deps.confirmations);
      h.deps.confirmations.require = async (...args: Parameters<typeof require>) => {
        const outcome = await require(...args);
        h.jobs.start(westUpdate);
        return outcome;
      };
      const late = await errorOf(manageApp({ action: 'create_venv', app_path: app }, h.ctx('manage_app')));
      assert.equal(late.code, 'BUSY');
      assert.match(late.message, /west workspace/);
      assert.equal(installs, 0);
      finishUpdate();
      for (const job of h.jobs.list()) {
        await h.jobs.wait(job, 5000);
      }

      // The same request still running attaches instead.
      h.deps.confirmations.require = require;
      const first = await manageApp({ action: 'create_venv', app_path: app, wait_sec: 0 }, h.ctx('manage_app')) as Record<string, any>;
      const again = await manageApp({ action: 'create_venv', app_path: app, wait_sec: 0 }, h.ctx('manage_app')) as Record<string, any>;
      assert.deepEqual([again.job_id, again.attached], [first.job_id, true]);
      finishInstall();
      const job = h.jobs.list().find(candidate => candidate.id === first.job_id)!;
      await h.jobs.wait(job, 5000);
      assert.equal(job.status, 'succeeded');
      assert.equal(installs, 1);
    });

    it('reports a failed installer with its code and leaves the settings alone', async () => {
      h = harness();
      h.window.user['zephyr-workbench.pathToEnvScript'] = writeFile(path.join(h.root, 'env.sh'));
      const app = freestandingApp(h, 'venv');
      h.window.folders.push(app);
      const { VenvSetupError } = require('../../../utils/installUtils');
      installUtils.createLocalVenv = async () => { throw new VenvSetupError('EXECUTION_POLICY', 'PowerShell scripts are disabled.'); };
      const view = await manageApp({ action: 'create_venv', app_path: app }, h.ctx('manage_app')) as Record<string, any>;
      assert.equal(view.status, 'failed');
      assert.equal(view.result.error_code, 'EXECUTION_POLICY');
      assert.match(view.next, /Set-ExecutionPolicy/);
      assert.equal(readSettingsFile(app)['zephyr-workbench.venv.path'], undefined);
    });
  });

  describe('configure target app action update', () => {
    it('refuses a toolchain the workbench does not offer, listing the choices, and asks nothing', async () => {
      h = harness();
      const app = freestandingApp(h, 'tc');
      h.window.folders.push(app);
      const unregistered = makeArmGnu(path.join(h.root, 'arm-gnu'));
      const refused = await errorOf(configure({
        target: 'app', action: 'update', app_path: app, toolchain: { family: 'arm_gnu', path: unregistered },
      }, h.ctx('configure')));
      assert.equal(refused.code, 'INVALID_ARGUMENT');
      assert.deepEqual(refused.details, { available: [{ family: 'zephyr_sdk', path: h.sdk }] });
      assert.equal((await errorOf(configure({ target: 'app', action: 'update', app_path: app, board: 'qemu_x86' }, h.ctx('configure')))).code,
        'INVALID_ARGUMENT');
      assert.equal((await errorOf(configure({ target: 'app', action: 'update', app_path: app }, h.ctx('configure')))).code, 'INVALID_ARGUMENT');
      assert.equal(h.asked.length, 0);
    });

    it('switches the toolchain, reports which configurations need a pristine build, and refreshes the view', async () => {
      h = harness();
      const armGnu = makeArmGnu(path.join(h.root, 'arm-gnu'));
      h.window.user['zephyr-workbench.listArmGnuToolchains'] = [{ toolchainPath: armGnu, targetTriple: 'arm-none-eabi' }];
      const app = freestandingApp(h, 'tc', {
        'zephyr-workbench.build.configurations': [
          { name: 'primary', board: 'nrf52840dk/nrf52840', active: 'true' }, { name: 'other', board: 'qemu_x86' },
        ],
      });
      writeFile(path.join(app, 'build', 'primary', 'CMakeCache.txt'));
      h.window.folders.push(app);

      const plan = await configure({
        target: 'app', action: 'update', app_path: app, toolchain: { family: 'arm_gnu', path: armGnu }, dry_run: true,
      }, h.ctx('configure')) as Record<string, any>;
      assert.deepEqual(plan.changed, ['toolchain']);
      assert.deepEqual(plan.needs_pristine, { primary: true, other: false });
      assert.equal(readSettingsFile(app)['zephyr-workbench.toolchain'], 'zephyr', 'a dry run writes nothing');

      const ctx = h.ctx('configure');
      const result = await configure({
        target: 'app', action: 'update', app_path: app, toolchain: { family: 'arm_gnu', path: armGnu },
      }, ctx) as Record<string, any>;
      assert.equal(ctx.audit.confirmCategory, 'settings');
      assert.deepEqual(result.changed, ['toolchain']);
      assert.deepEqual(result.needs_pristine, { primary: true, other: false });
      assert.deepEqual(result.app.toolchain, { family: 'arm_gnu', path: armGnu, global_sdk: false });
      assert.equal(result.launch_configs_removed, 0);
      assert.equal(readSettingsFile(app)['zephyr-workbench.gnuarmemb'], armGnu);
      assert.deepEqual(h.refreshed, [['apps']]);
      assert.match(result.next, /pristine "always" for primary/);

      const same = await configure({
        target: 'app', action: 'update', app_path: app, toolchain: { family: 'arm_gnu', path: armGnu },
      }, h.ctx('configure')) as Record<string, any>;
      assert.deepEqual(same.changed, []);
    });

    it('sets and clears the application venv, refusing a folder that is not one', async () => {
      h = harness();
      const app = freestandingApp(h, 'venvs');
      h.window.folders.push(app);
      const notVenv = await errorOf(configure({
        target: 'app', action: 'update', app_path: app, venv: { mode: 'path', path: h.root },
      }, h.ctx('configure')));
      assert.match(notVenv.message, /not a usable virtual environment/);

      const venv = path.join(h.root, 'venv');
      writeFile(path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
      const set = await configure({ target: 'app', action: 'update', app_path: app, venv: { mode: 'path', path: venv } }, h.ctx('configure')) as Record<string, any>;
      assert.deepEqual(set.venv, { path: venv, source: 'app' });
      assert.equal(readSettingsFile(app)['zephyr-workbench.venv.path'], venv);

      const cleared = await configure({ target: 'app', action: 'update', app_path: app, venv: { mode: 'inherit' } }, h.ctx('configure')) as Record<string, any>;
      assert.deepEqual(cleared.changed, ['venv']);
      assert.notEqual(cleared.venv.source, 'app');
      assert.equal(readSettingsFile(app)['zephyr-workbench.venv.path'], undefined);
    });

    it('reports the venv builds use: a user level venv.path goes before the west workspace .venv', async () => {
      h = harness();
      const userVenv = path.join(h.root, 'user-venv');
      fs.mkdirSync(userVenv);
      const workspaceVenv = path.join(h.ws, '.venv');
      fs.mkdirSync(workspaceVenv);
      h.window.user['zephyr-workbench.venv.path'] = userVenv;
      const free = freestandingApp(h, 'free');
      h.window.folders.push(free);
      await manageApp({ action: 'create', template: h.sample, board: 'nrf52840dk/nrf52840', name: 'hello' }, h.ctx('manage_app'));
      const inWorkspace = path.join(h.ws, 'applications', 'hello');

      for (const appPath of [free, inWorkspace]) {
        const app = await h.services.resolveApp(appPath);
        assert.equal(app.venvPath, userVenv, 'the venv the build exports');
        assert.deepEqual(h.services.toAppDto(app).venv, { path: userVenv, source: 'global' }, appPath);
      }
      const updated = await configure({
        target: 'app', action: 'update', app_path: free, intellisense_provider: 'clangd',
      }, h.ctx('configure')) as Record<string, any>;
      assert.deepEqual(updated.venv, { path: userVenv, source: 'global' });

      // The workspace's own venv.path wins for its applications, not for a freestanding one.
      writeSettingsFile(h.ws, { ...readSettingsFile(h.ws), 'zephyr-workbench.venv.path': workspaceVenv });
      assert.deepEqual(h.services.toAppDto(await h.services.resolveApp(inWorkspace)).venv, { path: workspaceVenv, source: 'west_workspace' });
      assert.deepEqual(h.services.toAppDto(await h.services.resolveApp(free)).venv, { path: userVenv, source: 'global' });

      const { ['zephyr-workbench.venv.path']: _dropped, ...rest } = readSettingsFile(h.ws);
      writeSettingsFile(h.ws, rest);
      delete h.window.user['zephyr-workbench.venv.path'];
      for (const appPath of [free, inWorkspace]) {
        const app = await h.services.resolveApp(appPath);
        assert.equal(app.venvPath, workspaceVenv);
        assert.deepEqual(h.services.toAppDto(app).venv, { path: workspaceVenv, source: 'west_workspace' }, appPath);
      }
    });

    it('reports the same venv for a freestanding application whose folder is not open yet', async () => {
      h = harness({ multiRoot: false });
      const userVenv = path.join(h.root, 'user-venv');
      fs.mkdirSync(userVenv);
      fs.mkdirSync(path.join(h.ws, '.venv'));
      h.window.user['zephyr-workbench.venv.path'] = userVenv;
      const parent = path.join(h.root, 'apps');
      fs.mkdirSync(parent);
      const result = await manageApp({
        action: 'create', kind: 'freestanding', template: h.sample, board: 'nrf52840dk/nrf52840', name: 'later', parent_dir: parent,
      }, h.ctx('manage_app')) as Record<string, any>;
      assert.equal(result.restart_pending, true);
      assert.deepEqual(result.app.venv, { path: userVenv, source: 'global' });

      const app = path.join(parent, 'later');
      h.window.folders.push(app);
      ZephyrApplication.clearApplicationWorkspaceCache();
      assert.deepEqual(h.services.toAppDto(await h.services.resolveApp(app)).venv, result.app.venv);
    });

    it('changes the IntelliSense provider and says when its extension is missing', async () => {
      h = harness();
      const app = freestandingApp(h, 'ide');
      h.window.folders.push(app);
      const result = await configure({
        target: 'app', action: 'update', app_path: app, intellisense_provider: 'clangd',
      }, h.ctx('configure')) as Record<string, any>;
      assert.deepEqual(result.changed, ['intellisense_provider']);
      assert.deepEqual(result.app.intellisense_provider, { name: 'clangd', installed: false });
      assert.match(result.warnings.join(' '), /not installed/);
      assert.deepEqual(result.needs_pristine, { primary: false });
    });

    it('refuses to relink a workspace application, and any change while one of its builds runs', async () => {
      h = harness();
      await manageApp({ action: 'create', template: h.sample, board: 'nrf52840dk/nrf52840', name: 'hello' }, h.ctx('manage_app'));
      const app = path.join(h.ws, 'applications', 'hello');
      assert.match((await errorOf(configure({ target: 'app', action: 'update', app_path: app, west_workspace: h.ws }, h.ctx('configure')))).message,
        /cannot change/);
      const release = holdBuild(h.jobs, app);
      assert.equal((await errorOf(configure({ target: 'app', action: 'update', app_path: app, intellisense_provider: 'clangd' }, h.ctx('configure')))).code,
        'BUSY');
      release();
    });
  });

  describe('remove_or_delete application', () => {
    it('removes a workspace application from its workspace and keeps its files', async () => {
      h = harness();
      await manageApp({ action: 'create', template: h.sample, board: 'nrf52840dk/nrf52840', name: 'hello' }, h.ctx('manage_app'));
      const app = path.join(h.ws, 'applications', 'hello');
      const plan = await removeOrDelete({ what: 'application', app_path: app, dry_run: true }, h.ctx('remove_or_delete')) as Record<string, any>;
      assert.deepEqual(plan.would_unregister, { from: path.join(h.ws, '.vscode', 'settings.json'), configurations: ['primary'] });

      const ctx = h.ctx('remove_or_delete');
      const result = await removeOrDelete({ what: 'application', app_path: app, force: true }, ctx) as Record<string, any>;
      assert.equal(ctx.audit.confirmCategory, 'delete');
      assert.deepEqual(result.removed_configurations, ['primary']);
      assert.equal(result.kept_files, true);
      assert.ok(fs.existsSync(path.join(app, 'prj.conf')));
      assert.equal(readSettingsFile(h.ws)['zephyr-workbench.westWorkspace.applications'], undefined);
      assert.ok(!fs.existsSync(path.join(h.ws, '.vscode', 'c_cpp_properties.json')), 'the last application takes its generated configuration along');
      assert.match(result.next, /manage_app/);
    });

    it('takes a freestanding application out of the window, deferring the removal of the only folder', async () => {
      h = harness({ open: [], multiRoot: false });
      const app = freestandingApp(h, 'solo');
      h.window.folders.push(app);
      const result = await removeOrDelete({ what: 'application', app_path: app }, h.ctx('remove_or_delete')) as Record<string, any>;
      assert.equal(result.restart_pending, true);
      assert.deepEqual(h.folderCalls.map(call => call.remove), [[app]]);
      assert.ok(fs.existsSync(path.join(app, '.vscode', 'settings.json')), 'its settings stay for a later import');
    });

    it('sizes the folder in a dry run, then deletes it behind the fence', async () => {
      h = harness();
      const app = freestandingApp(h, 'gone');
      // Twister metadata for its own CI does not make an application of the user's a sample.
      writeFile(path.join(app, 'sample.yaml'), 'sample:\n  name: gone\n');
      h.window.folders.push(app);
      const plan = await removeOrDelete({ what: 'application_files', app_path: app, dry_run: true }, h.ctx('remove_or_delete')) as Record<string, any>;
      assert.equal(plan.would_delete[0].path, app);
      assert.ok(plan.would_delete[0].size_bytes > 0);
      assert.equal(h.asked.length, 0);
      assert.ok(fs.existsSync(app));

      const result = await removeOrDelete({ what: 'application_files', app_path: app }, h.ctx('remove_or_delete')) as Record<string, any>;
      assert.deepEqual(result.deleted, [app]);
      assert.ok(!fs.existsSync(app));
      assert.deepEqual(h.window.folders, [h.ws]);
    });

    it('starts the deletion before unregistering, so a refused job start leaves the application registered', async () => {
      h = harness();
      await manageApp({ action: 'create', template: h.sample, board: 'nrf52840dk/nrf52840', name: 'hello' }, h.ctx('manage_app'));
      const inWorkspace = path.join(h.ws, 'applications', 'hello');
      const free = freestandingApp(h, 'kept');
      h.window.folders.push(free);
      const settingsBefore = readSettingsFile(h.ws);
      const askedBefore = h.asked.length;
      // Another call's folder change starts restarting the window while the dialog is open.
      h.admit = () => {
        throw new McpToolError('BUSY', 'This VS Code window is applying a folder change that restarts its extensions.', { hint: 'Retry in a few seconds.' });
      };
      for (const app of [inWorkspace, free]) {
        const refused = await errorOf(removeOrDelete({ what: 'application_files', app_path: app }, h.ctx('remove_or_delete')));
        assert.equal(refused.code, 'BUSY', app);
        assert.ok(fs.existsSync(path.join(app, 'CMakeLists.txt')), app);
        assert.equal((await h.services.resolveApp(app)).appRootPath, app, 'still registered, so the retry finds it');
      }
      assert.equal(h.asked.length - askedBefore, 2, 'refused only once the user had answered');
      assert.deepEqual(readSettingsFile(h.ws), settingsBefore);
      assert.deepEqual(h.folderCalls, []);
      assert.deepEqual(h.window.folders, [h.ws, free]);

      h.admit = undefined;
      const retried = await removeOrDelete({ what: 'application_files', app_path: free }, h.ctx('remove_or_delete')) as Record<string, any>;
      assert.deepEqual(retried.deleted, [free]);
    });

    it('deletes nothing until the application is unregistered, and nothing when unregistering fails', async () => {
      h = harness();
      const app = freestandingApp(h, 'order');
      h.window.folders.push(app);
      const apply = h.deps.folders.apply.bind(h.deps.folders);
      const presentWhileLeaving: boolean[] = [];
      h.deps.folders.apply = async (change, opts) => {
        // VS Code takes its time to confirm the folder change.
        await new Promise(resolve => setTimeout(resolve, 50));
        presentWhileLeaving.push(fs.existsSync(path.join(app, 'CMakeLists.txt')));
        return apply(change, opts);
      };
      const result = await removeOrDelete({ what: 'application_files', app_path: app }, h.ctx('remove_or_delete')) as Record<string, any>;
      assert.deepEqual(presentWhileLeaving, [true]);
      assert.deepEqual(result.deleted, [app]);

      const stays = freestandingApp(h, 'stays');
      h.window.folders.push(stays);
      h.deps.folders.apply = async () => { throw new Error('VS Code refused the folder change.'); };
      assert.match((await errorOf(removeOrDelete({ what: 'application_files', app_path: stays }, h.ctx('remove_or_delete')))).message, /refused/);
      for (const job of h.jobs.list()) {
        await h.jobs.wait(job, 5000);
      }
      assert.ok(fs.existsSync(path.join(stays, 'CMakeLists.txt')), 'an application still registered keeps its files');
    });

    it('refuses a sample configured in place, a path inside the application, and an application at work', async () => {
      h = harness();
      await manageApp({ action: 'import', path: h.sample, board: 'nrf52840dk/nrf52840' }, h.ctx('manage_app'));
      assert.equal((await errorOf(removeOrDelete({ what: 'application_files', app_path: h.sample }, h.ctx('remove_or_delete')))).code,
        'PATH_OUTSIDE_WORKSPACE');
      assert.ok(fs.existsSync(h.sample));

      const ncsSample = makeApplicationFolder(path.join(h.ws, 'nrf', 'samples', 'bluetooth', 'peripheral_uart'));
      writeFile(path.join(ncsSample, 'sample.yaml'), 'sample:\n  name: NUS\n');
      await manageApp({ action: 'import', path: ncsSample, board: 'nrf52840dk/nrf52840' }, h.ctx('manage_app'));
      const outsideZephyr = await errorOf(removeOrDelete({ what: 'application_files', app_path: ncsSample }, h.ctx('remove_or_delete')));
      assert.equal(outsideZephyr.code, 'PATH_OUTSIDE_WORKSPACE', 'a sample of another west project is refused too');
      assert.ok(fs.existsSync(path.join(ncsSample, 'CMakeLists.txt')));

      const app = freestandingApp(h, 'busy');
      h.window.folders.push(app);
      assert.equal((await errorOf(removeOrDelete({ what: 'application_files', app_path: path.join(app, 'src') }, h.ctx('remove_or_delete')))).code,
        'INVALID_ARGUMENT');
      const release = holdBuild(h.jobs, app);
      assert.equal((await errorOf(removeOrDelete({ what: 'application', app_path: app }, h.ctx('remove_or_delete')))).code, 'BUSY');
      release();
      h.services.kconfigEditors = () => [{ buildDir: path.join(app, 'build', 'primary'), configName: 'primary', dirty: true } as never];
      assert.equal((await errorOf(removeOrDelete({ what: 'application_files', app_path: app }, h.ctx('remove_or_delete')))).code, 'BUSY_EXTERNAL');
      assert.ok(fs.existsSync(app));
    });
  });
});
