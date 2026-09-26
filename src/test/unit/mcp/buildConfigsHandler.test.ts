// The configure and remove_or_delete (build output) handlers, run against a freestanding
// application whose settings live in memory. The settings writers, the
// confirmation gate, the job manager and the build folder fence are the
// production code; only VS Code's settings store and the application list
// are stood in for.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { findTool, TOOL_CATALOG } from '../../../mcp/core/catalog';
import { McpToolError } from '../../../mcp/core/errors';
import { ConfirmCategory, permissionForCategories, ToolContext } from '../../../mcp/core/toolSpec';
import { AskAnswer, Confirmations } from '../../../mcp/host/confirmations';
import { configure, deleteBuild } from '../../../mcp/host/handlers/buildConfigs';
import { HostDeps } from '../../../mcp/host/handlers/deps';
import { HostServices } from '../../../mcp/host/services';
import { JobManager, JobSpec } from '../../../mcp/jobs/jobManager';
import { ZephyrApplication } from '../../../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../../../models/ZephyrBuildConfig';
import type { KconfigLaunchSpec } from '../../../utils/kconfig/kconfigEnvExtractor';
import { KconfigSessionPool } from '../../../utils/kconfig/kconfigSessionPool';
import { useUiGuard } from './uiGuard';

const vscodeStub = require('vscode') as Record<string, any>;

type Stored = Record<string, any>;

// The settings code checks `scope instanceof vscode.Uri`, which needs a class.
class FakeUri {
  constructor(readonly fsPath: string) {}
  static file(fsPath: string): FakeUri { return new FakeUri(fsPath); }
  static parse(value: string): FakeUri { return new FakeUri(value.replace(/^file:\/\//, '')); }
  static joinPath(base: FakeUri, ...parts: string[]): FakeUri { return new FakeUri(path.join(base.fsPath, ...parts)); }
  toString(): string { return `file://${this.fsPath}`; }
}

/** A pooled Kconfig server: it notes whether its build folder still existed when it was stopped. */
class FakeKconfigClient {
  state = 'ready';
  recentStderr: string[] = [];
  stoppedWhileFolderExisted?: boolean;
  constructor(readonly dir: string) {}
  async call(): Promise<any> { return {}; }
  async dispose(): Promise<void> {
    this.stoppedWhileFolderExisted = fs.existsSync(this.dir);
    this.state = 'disposed';
  }
}

interface Harness {
  app: string;
  /** Every Kconfig server the pool started, oldest first. */
  kconfigClients: FakeKconfigClient[];
  settings: { configs: Stored[]; writes: number };
  asked: string[];
  jobs: JobManager;
  services: HostServices;
  deps: HostDeps;
  ctx(tool: string): ToolContext<HostDeps>;
  /** Answer the next dialog; `before` runs while the dialog is open. */
  answer(value: AskAnswer, before?: () => void): void;
  confirmActions: ConfirmCategory[];
  external?: { task: { name: string } };
}

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

function harness(configs: Stored[], confirmActions: ConfirmCategory[] = ['delete']): Harness {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-configure-')));
  const app = path.join(root, 'blinky');
  fs.mkdirSync(app);
  const folder = { uri: FakeUri.file(app), name: 'blinky', index: 0 };
  const settings = { configs: clone(configs), writes: 0 };

  vscodeStub.workspace.getConfiguration = () => ({
    get: (key: string, fallback?: unknown) => (key === 'build.configurations' ? clone(settings.configs) : fallback),
    update: async (key: string, value: unknown) => {
      if (key === 'build.configurations') {
        settings.configs = clone(value) as Stored[];
        settings.writes++;
      }
    },
    has: () => false,
    inspect: () => undefined,
  });

  const hydrate = (): ZephyrApplication => {
    const buildConfigs = settings.configs.map(raw => {
      const config = new ZephyrBuildConfig(raw.name);
      config.parseSettings(raw, folder as never);
      return config;
    });
    return {
      appRootPath: app, appName: 'blinky', appWorkspaceFolder: folder, isWestWorkspaceApplication: false,
      buildConfigs, intellisenseProvider: 'cpptools',
    } as unknown as ZephyrApplication;
  };

  const h = {} as Harness;
  // The extension folder only matters to the environment probes, which these tests never reach.
  const services = new HostServices(vscode.Uri.file(os.tmpdir()));
  services.listApplications = async () => [hydrate()];
  services.knownRoots = async () => [root];
  services.externalRun = () => h.external as never;

  const jobs = new JobManager({ logPathFor: id => path.join(root, `${id}.log`) });
  const asked: string[] = [];
  const answers: Array<{ value: AskAnswer; before?: () => void }> = [];
  const confirmations = new Confirmations({
    permission: tool => permissionForCategories(tool, h.confirmActions),
    waitMs: () => 2000,
    log: { recordConfirmation: () => undefined },
    ask: async message => {
      asked.push(message);
      const next = answers.shift() ?? { value: undefined };
      next.before?.();
      return next.value;
    },
  });
  const kconfigClients: FakeKconfigClient[] = [];
  const deps: HostDeps = {
    services, jobs, confirmations,
    defaultWaitSeconds: 10,
    revealTerminal: 'never',
    permissionOf: tool => permissionForCategories(tool, h.confirmActions),
    // remove_or_delete stops the agent Kconfig sessions of a folder before deleting it.
    kconfig: new KconfigSessionPool({
      serverScriptPath: 'kconfig_server.py',
      start: async o => {
        const client = new FakeKconfigClient(o.buildDir);
        kconfigClients.push(client);
        return { client, spec: { configPath: path.join(o.buildDir, 'zephyr', '.config') } as KconfigLaunchSpec };
      },
    }),
    extensionContext: {} as HostDeps['extensionContext'],
    folders: {} as HostDeps['folders'],
    refreshViews: async () => undefined,
    servedTools: () => new Set(TOOL_CATALOG.map(tool => tool.name)),
  };
  Object.assign(h, {
    app, settings, asked, jobs, services, deps, confirmActions, kconfigClients,
    ctx: (tool: string) => ({
      signal: new AbortController().signal,
      progress: () => undefined,
      client: { name: 'test-agent', version: '1', instance: 'session-1' },
      deps,
      tool: findTool(tool)!,
      startedAt: Date.now(),
      audit: {},
    }),
    answer: (value: AskAnswer, before?: () => void) => answers.push({ value, before }),
  });
  return h;
}

function write(file: string, text = ''): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as McpToolError).code;
  }
}

/** A job that holds a build folder until the test lets it go. */
function holdFolder(jobs: JobManager, buildDir: string): () => void {
  let release: () => void = () => undefined;
  const spec: JobSpec = {
    kind: 'build', lockKey: buildDir, requestKey: `build:${buildDir}`, buildDir, command: 'west build',
    run: () => new Promise(resolve => { release = () => resolve({ exitCode: 0 }); }),
  };
  jobs.start(spec);
  return () => release();
}

const PRIMARY = { name: 'primary', board: 'nrf52840dk/nrf52840', active: 'true' };
const DEBUG = { name: 'debug', board: 'qemu_x86' };

describe('mcp/host/handlers/buildConfigs', () => {
  useUiGuard();

  let savedGetConfiguration: unknown;
  let savedUri: unknown;
  before(() => {
    savedGetConfiguration = vscodeStub.workspace.getConfiguration;
    savedUri = vscodeStub.Uri;
    vscodeStub.Uri = FakeUri;
  });
  after(() => {
    vscodeStub.workspace.getConfiguration = savedGetConfiguration;
    vscodeStub.Uri = savedUri;
  });

  describe('configure', () => {
    it('refuses a target and action that do not go together, and fields an action does not take', async () => {
      const h = harness([PRIMARY]);
      assert.equal(await codeOf(configure({ target: 'app', action: 'create' }, h.ctx('configure'))), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(configure({ target: 'build_config', action: 'delete', config_name: 'primary' }, h.ctx('configure'))),
        'INVALID_ARGUMENT');
      assert.equal(await codeOf(configure(
        { target: 'build_config', action: 'rename', config_name: 'primary', new_name: 'x', board: 'qemu_x86' }, h.ctx('configure'))),
      'INVALID_ARGUMENT');
      assert.equal(h.settings.writes, 0);
    });

    it('creates an inactive configuration in one write, with every field stored as the Applications view stores it', async () => {
      const h = harness([PRIMARY]);
      const ctx = h.ctx('configure');
      const result = await configure({
        target: 'build_config', action: 'create', config_name: 'debug', board: 'qemu_x86', sysbuild: true,
        west_flags: { add: ['-DCONFIG_DEBUG_OPTIMIZATIONS=y'] },
        env: { EXTRA_CONF_FILE: { add: ['debug.conf'] }, SNIPPETS: { add: ['cdc-acm-console'] } },
      }, ctx) as Record<string, any>;

      assert.equal(h.settings.writes, 1);
      assert.deepEqual(h.settings.configs, [PRIMARY, {
        name: 'debug', board: 'qemu_x86', sysbuild: 'true', 'west-flags': ['CONFIG_DEBUG_OPTIMIZATIONS=y'],
        'env.EXTRA_CONF_FILE': ['${workspaceFolder}/debug.conf'], 'env.SNIPPETS': ['cdc-acm-console'],
      }]);
      assert.equal(result.config.name, 'debug');
      assert.equal(result.config.active, false);
      assert.equal(result.active_config, 'primary');
      assert.deepEqual(result.changed, ['board', 'sysbuild', 'west_flags', 'env.EXTRA_CONF_FILE', 'env.SNIPPETS']);
      assert.match(result.warnings.join(' '), /does not exist yet/);
      assert.equal(result.storage.settings_file, path.join(h.app, '.vscode', 'settings.json'));
      // The user did not ask to approve settings changes, and the audit says so.
      assert.equal(h.asked.length, 0);
      assert.equal(ctx.audit.confirmation, 'not-asked');
    });

    it('names a new configuration setup_N by default and refuses a name taken in another case', async () => {
      const h = harness([PRIMARY]);
      const created = await configure({ target: 'build_config', action: 'create', board: 'qemu_x86' }, h.ctx('configure')) as Record<string, any>;
      assert.equal(created.config.name, 'setup_2');
      try {
        await configure({ target: 'build_config', action: 'create', config_name: 'PRIMARY', board: 'qemu_x86' }, h.ctx('configure'));
        assert.fail('expected a refusal');
      } catch (error) {
        assert.equal((error as McpToolError).code, 'INVALID_ARGUMENT');
        assert.deepEqual((error as McpToolError).details, { existing: ['primary', 'setup_2'] });
      }
      assert.equal(await codeOf(configure({ target: 'build_config', action: 'create', config_name: 'x' }, h.ctx('configure'))),
        'INVALID_ARGUMENT', 'a configuration needs a board');
    });

    it('copies a configuration as stored and can make the copy the only active one', async () => {
      const source = { ...PRIMARY, 'default-runner': 'jlink', 'custom-args': '--erase', 'env.SHIELD': ['x_nucleo_iks01a3'] };
      const h = harness([source]);
      const result = await configure({
        target: 'build_config', action: 'create', config_name: 'copy', copy_from: 'primary', activate: true, sysbuild: true,
      }, h.ctx('configure')) as Record<string, any>;
      assert.deepEqual(h.settings.configs[1], {
        name: 'copy', board: 'nrf52840dk/nrf52840', active: 'true', 'default-runner': 'jlink', 'custom-args': '--erase',
        'env.SHIELD': ['x_nucleo_iks01a3'], sysbuild: 'true',
      });
      assert.equal(h.settings.configs[0].active, undefined);
      assert.equal(result.active_config, 'copy');
      assert.equal(result.copied_from, 'primary');
    });

    it('asks first when the user opted in to settings approvals, and writes nothing when declined', async () => {
      const h = harness([PRIMARY], ['settings']);
      h.answer(undefined);
      assert.equal(await codeOf(configure({ target: 'build_config', action: 'update', board: 'qemu_x86' }, h.ctx('configure'))),
        'USER_DENIED');
      assert.equal(h.asked.length, 1);
      assert.match(h.asked[0], /change board of the build configuration "primary"/);
      assert.equal(h.settings.writes, 0);

      h.answer('allow');
      const ctx = h.ctx('configure');
      const result = await configure({ target: 'build_config', action: 'update', config_name: 'primary', board: 'nrf5340dk/nrf5340/cpuapp' }, ctx) as Record<string, any>;
      assert.deepEqual(result.confirmation, { category: 'settings', outcome: 'allowed' });
      assert.equal(h.settings.configs[0].board, 'nrf5340dk/nrf5340/cpuapp');
    });

    it('updates the active configuration by default and says when a pristine build is needed', async () => {
      const h = harness([PRIMARY, DEBUG]);
      write(path.join(h.app, 'build', 'primary', 'CMakeCache.txt'));
      const result = await configure({ target: 'build_config', action: 'update', board: 'qemu_x86', west_args: '-o=-j4' }, h.ctx('configure')) as Record<string, any>;
      assert.equal(result.config.name, 'primary');
      assert.equal(result.needs_pristine, true);
      assert.match(result.next, /pristine "always"/);
      assert.equal(h.settings.writes, 1);
      assert.deepEqual(h.settings.configs[0], { ...PRIMARY, board: 'qemu_x86', 'west-args': '-o=-j4' });
    });

    it('serializes concurrent changes to one settings file, so neither change is lost', async () => {
      const h = harness([PRIMARY]);
      await Promise.all([
        configure({ target: 'build_config', action: 'update', west_flags: { add: ['FIRST=1'] } }, h.ctx('configure')),
        configure({ target: 'build_config', action: 'update', west_flags: { add: ['SECOND=2'] } }, h.ctx('configure')),
      ]);
      assert.deepEqual([...h.settings.configs[0]['west-flags']].sort(), ['FIRST=1', 'SECOND=2']);
      assert.equal(h.settings.writes, 2);
    });

    it('writes nothing when the values are already stored', async () => {
      const h = harness([PRIMARY]);
      const result = await configure({ target: 'build_config', action: 'update', board: PRIMARY.board }, h.ctx('configure')) as Record<string, any>;
      assert.deepEqual(result.changed, []);
      assert.equal(h.settings.writes, 0);
      assert.equal(await codeOf(configure({ target: 'build_config', action: 'update' }, h.ctx('configure'))), 'INVALID_ARGUMENT');
    });

    it('refuses values a shell would misread before anything is written', async () => {
      const h = harness([PRIMARY]);
      for (const args of [
        { west_args: '-b qemu_x86' },
        { runner_args: '--erase' },
        { west_flags: { add: ['A=1;2'] } },
        { env: { SHIELD: { add: ['a b'] } } },
        { board: 'x$(id)' },
      ]) {
        assert.equal(await codeOf(configure({ target: 'build_config', action: 'update', ...args }, h.ctx('configure'))),
          'INVALID_ARGUMENT', JSON.stringify(args));
      }
      assert.equal(await codeOf(configure({
        target: 'build_config', action: 'update', env: { EXTRA_DTC_OVERLAY_FILE: { add: [path.join(path.sep, 'etc', 'x.overlay')] } },
      }, h.ctx('configure'))), 'PATH_OUTSIDE_WORKSPACE');
      assert.equal(h.settings.writes, 0);
    });

    it('refuses while an agent job or a task started from VS Code works on the configuration', async () => {
      const h = harness([PRIMARY]);
      const release = holdFolder(h.jobs, path.join(h.app, 'build', 'primary'));
      assert.equal(await codeOf(configure({ target: 'build_config', action: 'update', board: 'qemu_x86' }, h.ctx('configure'))), 'BUSY');
      release();
      await new Promise(resolve => setTimeout(resolve, 10));
      h.external = { task: { name: 'West Build' } };
      assert.equal(await codeOf(configure({ target: 'build_config', action: 'update', board: 'qemu_x86' }, h.ctx('configure'))), 'BUSY_EXTERNAL');
      assert.equal(h.settings.writes, 0);
    });

    it('renames a configuration and reports the build folder it leaves behind', async () => {
      const h = harness([PRIMARY, DEBUG]);
      write(path.join(h.app, 'build', 'primary', 'CMakeCache.txt'));
      const result = await configure({ target: 'build_config', action: 'rename', config_name: 'primary', new_name: 'release' }, h.ctx('configure')) as Record<string, any>;
      assert.deepEqual(h.settings.configs.map(config => config.name), ['release', 'debug']);
      assert.equal(h.settings.configs[0].active, 'true');
      assert.equal(result.previous_name, 'primary');
      assert.equal(result.orphaned_build_dir, path.join(h.app, 'build', 'primary'));
      assert.ok(fs.existsSync(path.join(h.app, 'build', 'primary')), 'the folder is never moved');

      assert.equal(await codeOf(configure({ target: 'build_config', action: 'rename', config_name: 'debug', new_name: 'RELEASE' }, h.ctx('configure'))),
        'INVALID_ARGUMENT');
      assert.equal(await codeOf(configure({ target: 'build_config', action: 'rename', config_name: 'debug', new_name: 'v1.2' }, h.ctx('configure'))),
        'INVALID_ARGUMENT');
      assert.equal(await codeOf(configure({ target: 'build_config', action: 'rename', new_name: 'x' }, h.ctx('configure'))),
        'INVALID_ARGUMENT', 'rename never defaults to the active configuration');
    });

    it('activates exactly one configuration', async () => {
      const h = harness([PRIMARY, { ...DEBUG, active: 'true' }]);
      const result = await configure({ target: 'build_config', action: 'activate', config_name: 'debug' }, h.ctx('configure')) as Record<string, any>;
      assert.deepEqual(h.settings.configs.map(config => config.active), [undefined, 'true']);
      assert.equal(result.active_config, 'debug');
      assert.equal(await codeOf(configure({ target: 'build_config', action: 'activate' }, h.ctx('configure'))), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(configure({ target: 'build_config', action: 'activate', config_name: 'nope' }, h.ctx('configure'))),
        'CONFIG_NOT_FOUND');
    });

    it('refuses to select a freestanding application, which no west workspace lists', async () => {
      const h = harness([PRIMARY]);
      assert.equal(await codeOf(configure({ target: 'app', action: 'select' }, h.ctx('configure'))), 'INVALID_ARGUMENT');
    });
  });

  describe('remove_or_delete (build output)', () => {
    it('never defaults a deletion to the active configuration', async () => {
      const h = harness([PRIMARY, DEBUG]);
      assert.equal(await codeOf(deleteBuild({ what: 'build_folder' }, h.ctx('remove_or_delete'))), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(deleteBuild({ what: 'configuration' }, h.ctx('remove_or_delete'))), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(deleteBuild({ what: 'all_build_folders', config_name: 'primary' }, h.ctx('remove_or_delete'))), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(deleteBuild({ what: 'build_folder', config_name: 'primary', delete_build_folder: true }, h.ctx('remove_or_delete'))),
        'INVALID_ARGUMENT');
    });

    it('reports a dry run without asking or deleting', async () => {
      const h = harness([PRIMARY]);
      const folder = path.join(h.app, 'build', 'primary');
      write(path.join(folder, 'CMakeCache.txt'));
      const result = await deleteBuild({ what: 'build_folder', config_name: 'primary', dry_run: true }, h.ctx('remove_or_delete')) as Record<string, any>;
      assert.deepEqual(result.would_delete, [{ path: folder, config_name: 'primary' }]);
      assert.equal(result.confirmation_required, true);
      assert.equal(h.asked.length, 0);
      assert.ok(fs.existsSync(folder));
    });

    it('deletes one build folder once the user allows it', async () => {
      const h = harness([PRIMARY, DEBUG]);
      const folder = path.join(h.app, 'build', 'primary');
      write(path.join(folder, 'CMakeCache.txt'));
      write(path.join(h.app, 'build', 'debug', 'CMakeCache.txt'));
      h.answer('allow');
      const ctx = h.ctx('remove_or_delete');
      const result = await deleteBuild({ what: 'build_folder', config_name: 'primary' }, ctx) as Record<string, any>;
      assert.deepEqual(result.deleted, [{ path: folder, config_name: 'primary' }]);
      assert.deepEqual(result.confirmation, { category: 'delete', outcome: 'allowed' });
      assert.ok(result.job_id);
      assert.equal(ctx.audit.jobId, result.job_id);
      assert.ok(!fs.existsSync(folder));
      assert.ok(fs.existsSync(path.join(h.app, 'build', 'debug')), 'other configurations keep their folder');
      assert.match(h.asked[0], /delete the build folder of "primary"/);
    });

    it('keeps the folder when the user declines', async () => {
      const h = harness([PRIMARY]);
      const folder = path.join(h.app, 'build', 'primary');
      write(path.join(folder, 'CMakeCache.txt'));
      h.answer(undefined);
      assert.equal(await codeOf(deleteBuild({ what: 'build_folder', config_name: 'primary' }, h.ctx('remove_or_delete'))), 'USER_DENIED');
      assert.ok(fs.existsSync(folder));
    });

    it('refuses a config_name that differs from a configuration only by case where the file system ignores case', async () => {
      const h = harness([{ ...PRIMARY, name: 'Primary' }]);
      const folder = path.join(h.app, 'build', 'Primary');
      write(path.join(folder, 'CMakeCache.txt'));
      if (process.platform === 'darwin' || process.platform === 'win32') {
        // build/primary is this folder, and a running "West Build [Primary]" would not count as busy.
        try {
          await deleteBuild({ what: 'build_folder', config_name: 'primary' }, h.ctx('remove_or_delete'));
          assert.fail('expected a refusal');
        } catch (error) {
          assert.equal((error as McpToolError).code, 'INVALID_ARGUMENT');
          assert.equal((error as McpToolError).hint, 'Pass config_name "Primary".');
        }
        assert.equal(h.asked.length, 0);
      } else {
        // On Linux build/primary is a folder of its own, and there is none.
        const result = await deleteBuild({ what: 'build_folder', config_name: 'primary' }, h.ctx('remove_or_delete')) as Record<string, any>;
        assert.equal(result.already_clean, true);
      }
      assert.ok(fs.existsSync(folder));
    });

    it('answers a missing folder as already clean, without asking', async () => {
      const h = harness([PRIMARY]);
      const result = await deleteBuild({ what: 'build_folder', config_name: 'primary' }, h.ctx('remove_or_delete')) as Record<string, any>;
      assert.equal(result.already_clean, true);
      assert.deepEqual(result.deleted, []);
      assert.equal(h.asked.length, 0);
    });

    it('deletes every build folder, and refuses a folder that does not hold build output', async () => {
      const h = harness([PRIMARY, DEBUG]);
      write(path.join(h.app, 'build', 'primary', 'CMakeCache.txt'));
      write(path.join(h.app, 'build', 'debug', 'build_info.yml'));
      h.answer('allow');
      await deleteBuild({ what: 'all_build_folders' }, h.ctx('remove_or_delete'));
      assert.ok(!fs.existsSync(path.join(h.app, 'build')));

      write(path.join(h.app, 'build', 'docs', 'notes.txt'));
      assert.equal(await codeOf(deleteBuild({ what: 'build_folder', config_name: 'docs' }, h.ctx('remove_or_delete'))), 'INVALID_ARGUMENT');
      assert.ok(fs.existsSync(path.join(h.app, 'build', 'docs', 'notes.txt')));
    });

    it('refuses a configuration name that would point outside the build folder', async () => {
      const h = harness([PRIMARY]);
      write(path.join(h.app, 'build', 'primary', 'CMakeCache.txt'));
      assert.equal(await codeOf(deleteBuild({ what: 'build_folder', config_name: '..' }, h.ctx('remove_or_delete'))), 'PATH_OUTSIDE_WORKSPACE');
      assert.equal(h.asked.length, 0);
      assert.ok(fs.existsSync(path.join(h.app, 'build', 'primary', 'CMakeCache.txt')));
    });

    it('refuses to delete every build folder while a build runs in one of them', async () => {
      const h = harness([PRIMARY, DEBUG]);
      const folder = path.join(h.app, 'build', 'primary');
      write(path.join(folder, 'CMakeCache.txt'));
      const release = holdFolder(h.jobs, folder);
      assert.equal(await codeOf(deleteBuild({ what: 'all_build_folders' }, h.ctx('remove_or_delete'))), 'BUSY');
      assert.equal(h.asked.length, 0);
      release();
      assert.ok(fs.existsSync(folder));
    });

    it('checks again after the dialog, because a build may have started while it was open', async () => {
      const h = harness([PRIMARY]);
      const folder = path.join(h.app, 'build', 'primary');
      write(path.join(folder, 'CMakeCache.txt'));
      h.answer('allow', () => { holdFolder(h.jobs, folder); });
      assert.equal(await codeOf(deleteBuild({ what: 'build_folder', config_name: 'primary' }, h.ctx('remove_or_delete'))), 'BUSY');
      assert.ok(fs.existsSync(folder));
    });

    it('keeps the last configuration of an application', async () => {
      const h = harness([PRIMARY]);
      assert.equal(await codeOf(deleteBuild({ what: 'configuration', config_name: 'primary' }, h.ctx('remove_or_delete'))), 'INVALID_ARGUMENT');
      assert.equal(h.asked.length, 0);
    });

    it('removes the active configuration with its folder and makes another one active', async () => {
      const h = harness([PRIMARY, DEBUG]);
      const folder = path.join(h.app, 'build', 'primary');
      write(path.join(folder, 'CMakeCache.txt'));
      h.answer('allow');
      const result = await deleteBuild({ what: 'configuration', config_name: 'primary', delete_build_folder: true }, h.ctx('remove_or_delete')) as Record<string, any>;
      assert.deepEqual(h.settings.configs, [{ ...DEBUG, active: 'true' }]);
      assert.equal(result.removed_configuration, 'primary');
      assert.equal(result.active_config, 'debug');
      assert.ok(!fs.existsSync(folder));
    });

    describe('with a Kconfig server running inside the folder', () => {
      it('stops the agent Kconfig sessions of the folder before deleting it, and lets them start again after', async () => {
        const h = harness([PRIMARY, DEBUG]);
        const primary = path.join(h.app, 'build', 'primary');
        const debugImage = path.join(h.app, 'build', 'debug', 'blinky');
        const elsewhere = path.join(h.app, '..', 'other', 'build', 'primary');
        write(path.join(primary, 'CMakeCache.txt'));
        write(path.join(debugImage, 'CMakeCache.txt'));
        write(path.join(elsewhere, 'CMakeCache.txt'));
        for (const dir of [primary, debugImage, elsewhere]) {
          await h.deps.kconfig.use(dir, {}, async () => undefined);
        }
        h.answer('allow');
        await deleteBuild({ what: 'all_build_folders' }, h.ctx('remove_or_delete'));
        assert.ok(!fs.existsSync(path.join(h.app, 'build')));
        const [primaryServer, debugServer, otherServer] = h.kconfigClients;
        assert.equal(primaryServer.stoppedWhileFolderExisted, true, 'stopped before the folder went');
        assert.equal(debugServer.stoppedWhileFolderExisted, true, 'a sysbuild image folder counts too');
        assert.equal(otherServer.state, 'ready', 'a session outside the folder is kept');
        assert.equal(h.deps.kconfig.size, 1);
        write(path.join(primary, 'CMakeCache.txt'));
        assert.equal(await h.deps.kconfig.use(primary, {}, async session => session.cold), true);
        await h.deps.kconfig.closeAll();
      });

      it('refuses while a Kconfig Manager tab is open on it, before asking', async () => {
        const h = harness([PRIMARY]);
        const folder = path.join(h.app, 'build', 'primary');
        write(path.join(folder, 'CMakeCache.txt'));
        h.services.kconfigEditors = () => [{ buildDir: folder, imageDir: folder, configName: 'primary', open: true, dirty: false }];
        try {
          await deleteBuild({ what: 'build_folder', config_name: 'primary' }, h.ctx('remove_or_delete'));
          assert.fail('expected a refusal');
        } catch (error) {
          assert.equal((error as McpToolError).code, 'BUSY_EXTERNAL');
          assert.match((error as McpToolError).hint ?? '', /close the Kconfig Manager tab of primary/);
        }
        assert.equal(h.asked.length, 0);
        assert.ok(fs.existsSync(folder));
      });

      it('refuses while an agent Kconfig query is answering from it', async () => {
        const h = harness([PRIMARY]);
        const folder = path.join(h.app, 'build', 'primary');
        write(path.join(folder, 'CMakeCache.txt'));
        let release!: () => void;
        const running = h.deps.kconfig.use(folder, {}, () => new Promise<void>(resolve => { release = resolve; }));
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(await codeOf(deleteBuild({ what: 'build_folder', config_name: 'primary' }, h.ctx('remove_or_delete'))), 'BUSY');
        release();
        await running;
        assert.ok(fs.existsSync(folder));
        await h.deps.kconfig.closeAll();
      });
    });

    it('keeps the build folder of a removed configuration unless asked, and says so', async () => {
      const h = harness([PRIMARY, DEBUG]);
      const folder = path.join(h.app, 'build', 'debug');
      write(path.join(folder, 'CMakeCache.txt'));
      h.answer('allow');
      const result = await deleteBuild({ what: 'configuration', config_name: 'debug' }, h.ctx('remove_or_delete')) as Record<string, any>;
      assert.deepEqual(h.settings.configs, [PRIMARY]);
      assert.equal(result.orphaned_build_dir, folder);
      assert.ok(fs.existsSync(folder));
    });
  });
});
