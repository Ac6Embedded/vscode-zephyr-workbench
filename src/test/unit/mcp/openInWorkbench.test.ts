// open_in_workbench with the views stood in for (workbenchViews): what each
// target opens and for which build, what it refuses up front and why, and
// that it never waits for the user. Also the dashboard's pinned reveal.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findTool } from '../../../mcp/core/catalog';
import { McpToolError } from '../../../mcp/core/errors';
import { ToolContext } from '../../../mcp/core/toolSpec';
import type { HostDeps } from '../../../mcp/host/handlers/deps';
import { isMachineScope } from '../../../mcp/core/toolSpec';
import {
  DEBUG_MANAGER_COMMAND, INSTALL_RUNNERS_COMMAND, openInWorkbench, PYOCD_MANAGER_COMMAND, SERVED_TASKS, workbenchViews,
} from '../../../mcp/host/handlers/openInWorkbench';
import { RUNNER_TOOLS_LOCK } from '../../../mcp/host/handlers/manageRunners';
import { JobManager } from '../../../mcp/jobs/jobManager';
import { ZephyrDashboardViewProvider } from '../../../panels/ZephyrDashboardViewProvider';
import { useUiGuard } from './uiGuard';

const stub = require('vscode') as Record<string, any>;

describe('open_in_workbench', () => {
  useUiGuard();

  let root: string;
  let appRoot: string;
  let buildDir: string;
  let westRoot: string;
  let jobs: JobManager;
  let calls: { view: string; args: unknown[] }[];
  const saved: { views?: typeof workbenchViews; env: Record<string, string | undefined> } = { env: {} };

  const primary = { name: 'primary', boardIdentifier: 'b', active: true };
  const debug = { name: 'debug', boardIdentifier: 'b2', active: false };
  const sysbuild = { name: 'sb', boardIdentifier: 'b3', active: false, sysbuild: 'true' };
  let built: boolean;
  let packIndex: boolean | undefined;
  let app: Record<string, unknown>;
  const workspace = () => ({ rootUri: { fsPath: westRoot }, name: 'ws' });

  const setEnv = (key: string, value: string | undefined) => {
    if (!(key in saved.env)) {
      saved.env[key] = process.env[key];
    }
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zwb-open-')));
    appRoot = path.join(root, 'app');
    westRoot = path.join(root, 'ws');
    buildDir = path.join(appRoot, 'build', 'debug');
    fs.mkdirSync(path.join(appRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(westRoot, '.west'), { recursive: true });
    fs.mkdirSync(path.join(root, 'logs'));
    jobs = new JobManager({ logPathFor: id => path.join(root, 'logs', `${id}.log`) });
    calls = [];
    app = {
      appRootPath: appRoot, appName: 'app', appWorkspaceFolder: { uri: { fsPath: appRoot } }, buildConfigs: [primary, debug, sysbuild],
      westWorkspaceRootPath: westRoot,
    };
    built = true;
    packIndex = true;
    saved.views = { ...workbenchViews };
    const record = (view: string, value?: unknown) => (...args: unknown[]) => { calls.push({ view, args }); return value; };
    Object.assign(workbenchViews, {
      file: record('file', Promise.resolve()),
      dashboard: record('dashboard', Promise.resolve(true)),
      kconfigManager: record('kconfigManager', Promise.resolve()),
      // Like the real tool, it only ends when the user closes it.
      westConfig: record('westConfig', new Promise(() => undefined)),
      // Still running when the call returns, as a Puncover server is.
      serveBuildTarget: record('serveBuildTarget', new Promise(() => undefined)),
      pyocdPackIndex: async () => packIndex,
      devicetreeManagerInstalled: () => false,
      devicetreeManager: record('devicetreeManager', Promise.resolve()),
      westManager: record('westManager'),
      eclairManager: record('eclairManager'),
      eclairReport: record('eclairReport', Promise.resolve({ terminal: 'ECLAIR Report Server', extension: 'missing' })),
      appTerminal: record('appTerminal', 'app (debug) Terminal'),
      westWorkspaceTerminal: record('westWorkspaceTerminal', 'ws Terminal'),
      westWorkspaceCount: () => 1,
      hostToolsReady: async () => true,
      addApplication: record('addApplication', Promise.resolve()),
      addWestWorkspace: record('addWestWorkspace'),
      addToolchain: record('addToolchain'),
    });
    setEnv('VSCODE_PORTABLE', root);
    setEnv('PATH', path.join(root, 'empty-path'));
  });

  afterEach(() => {
    Object.assign(workbenchViews, saved.views);
    for (const [key, value] of Object.entries(saved.env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    saved.env = {};
    fs.rmSync(root, { recursive: true, force: true });
  });

  function ctx(): ToolContext<HostDeps> {
    const deps = {
      services: {
        resolveTarget: async (_appPath?: string, configName?: string) => {
          const config = configName === 'debug' ? debug : configName === 'sb' ? sysbuild : primary;
          return { app, config, buildDir: path.join(appRoot, 'build', config.name) };
        },
        resolveApp: async () => app,
        resolveWestWorkspace: async () => ({ workspace: workspace() }),
        knownRoots: async () => [appRoot, westRoot],
        isBuilt: () => built,
      },
      jobs,
      extensionContext: { extensionUri: { fsPath: '/extension' } },
    };
    return {
      signal: new AbortController().signal, progress: () => undefined, client: { name: 'test' },
      deps: deps as unknown as HostDeps, tool: findTool('open_in_workbench')!, startedAt: Date.now(), audit: {},
    };
  }
  const open = (args: Record<string, unknown>) => openInWorkbench(args, ctx()) as Promise<any>;

  async function errorOf(promise: Promise<unknown>): Promise<McpToolError> {
    try {
      await promise;
    } catch (error) {
      assert.ok(error instanceof McpToolError, `expected a tool error, got ${String(error)}`);
      return error;
    }
    assert.fail('expected the call to fail');
  }

  it('refuses arguments the target does not take', async () => {
    const cases: Record<string, unknown>[] = [
      { target: 'dashboard', path: path.join(appRoot, 'src', 'main.c') },
      { target: 'file', path: path.join(appRoot, 'src', 'main.c'), app_path: appRoot },
      { target: 'eclair_manager', config_name: 'debug' },
      { target: 'add_toolchain', app_path: appRoot },
      { target: 'terminal', west_workspace: westRoot, app_path: appRoot },
      { target: 'file' },
      { target: 'file', path: 'src/main.c' },
      { target: 'file', path: path.join(appRoot, 'src', 'main.c'), column: 3 },
      { target: 'browser' },
      { target: 'install_runners', app_path: appRoot },
      { target: 'debug_manager', west_workspace: westRoot },
      { target: 'pyocd_manager', path: path.join(appRoot, 'src', 'main.c') },
      { target: 'ram_plot', west_workspace: westRoot },
      { target: 'west_dashboard', line: 3 },
    ];
    for (const args of cases) {
      assert.equal((await errorOf(open(args))).code, 'INVALID_ARGUMENT', JSON.stringify(args));
    }
    assert.deepEqual(calls, []);
  });

  describe('file', () => {
    it('opens a file of the window at a line and column', async () => {
      const file = path.join(appRoot, 'src', 'main.c');
      fs.writeFileSync(file, 'int main(void) {}\n');
      const result = await open({ target: 'file', path: file, line: 3, column: 5 });
      assert.deepEqual(result, { opened: 'file', path: file, line: 3, column: 5 });
      assert.deepEqual(calls, [{ view: 'file', args: [file, 3, 5] }]);
    });

    it('opens only existing files inside the folders of the window', async () => {
      const outside = path.join(root, 'outside.c');
      fs.writeFileSync(outside, '');
      assert.equal((await errorOf(open({ target: 'file', path: outside }))).code, 'PATH_OUTSIDE_WORKSPACE');
      assert.equal((await errorOf(open({ target: 'file', path: path.join(appRoot, 'missing.c') }))).code, 'INVALID_ARGUMENT');
      assert.equal((await errorOf(open({ target: 'file', path: path.join(appRoot, 'src') }))).code, 'INVALID_ARGUMENT');
      assert.deepEqual(calls, []);
    });
  });

  it('reveals the dashboard on the configuration asked for', async () => {
    const result = await open({ target: 'dashboard', config_name: 'debug' });
    assert.equal(result.config_name, 'debug');
    assert.deepEqual(calls, [{ view: 'dashboard', args: [app, 'debug'] }]);
  });

  describe('kconfig_manager', () => {
    it('opens the Kconfig Manager with the configuration, so it never asks which one', async () => {
      await open({ target: 'kconfig_manager', config_name: 'debug' });
      assert.deepEqual(calls, [{ view: 'kconfigManager', args: [{ fsPath: '/extension' }, app, debug] }]);
    });

    // The panel runs a CMake configure of a folder that is not configured yet, outside any job.
    it('is refused while an agent job holds the build folder', async () => {
      let release: () => void = () => undefined;
      const { job } = jobs.start({
        kind: 'task', lockKey: buildDir, requestKey: 'spdx', appPath: appRoot, configName: 'debug', buildDir,
        command: 'west spdx', run: () => new Promise(resolve => { release = () => resolve({ exitCode: 0 }); }),
      });
      const error = await errorOf(open({ target: 'kconfig_manager', config_name: 'debug' }));
      assert.equal(error.code, 'BUSY');
      assert.equal((error.details as any).job_id, job.id);
      assert.match(error.hint ?? '', /job \{"action": "status"/);
      assert.deepEqual(calls, []);
      release();
    });

    it('is refused while a task the user started works on the configuration', async () => {
      const savedTasks = stub.tasks;
      stub.tasks = {
        ...savedTasks,
        taskExecutions: [{ task: { name: 'West Build [debug]', definition: { type: 'zephyr-workbench', config: 'debug' }, scope: { uri: { fsPath: appRoot } } } }],
      };
      try {
        assert.equal((await errorOf(open({ target: 'kconfig_manager', config_name: 'debug' }))).code, 'BUSY_EXTERNAL');
        // Another configuration of the application is free.
        await open({ target: 'kconfig_manager', config_name: 'primary' });
      } finally {
        stub.tasks = savedTasks;
      }
      assert.deepEqual(calls, [{ view: 'kconfigManager', args: [{ fsPath: '/extension' }, app, primary] }]);
    });
  });

  describe('menuconfig and guiconfig', () => {
    it('run for the configuration asked for, not the active one, without waiting for the user', async () => {
      const result = await open({ target: 'guiconfig', config_name: 'debug' });
      assert.equal(result.opened, 'guiconfig');
      assert.deepEqual(calls, [{ view: 'westConfig', args: [app, debug, 'guiconfig'] }]);
      assert.match(result.note, /persist_temporary/);
    });

    it('are refused while an agent job holds the build folder', async () => {
      let release: () => void = () => undefined;
      const { job } = jobs.start({
        kind: 'build', lockKey: buildDir, requestKey: 'b', appPath: appRoot, configName: 'debug', buildDir,
        command: 'west build', run: () => new Promise(resolve => { release = () => resolve({ exitCode: 0 }); }),
      });
      const error = await errorOf(open({ target: 'menuconfig', config_name: 'debug' }));
      assert.equal(error.code, 'BUSY');
      assert.equal((error.details as any).job_id, job.id);
      assert.deepEqual(calls, []);
      release();
    });

    it('report a tool that cannot start', async () => {
      workbenchViews.westConfig = async () => { throw new Error('Missing Zephyr environment script.\nGo to File > Preferences'); };
      assert.equal((await errorOf(open({ target: 'menuconfig' }))).code, 'ENV_NOT_READY');
    });
  });

  describe('devicetree_manager', () => {
    it('reports the extension missing', async () => {
      const error = await errorOf(open({ target: 'devicetree_manager' }));
      assert.equal(error.code, 'DEPENDENCY_MISSING');
      assert.match(error.hint ?? '', /Ac6\.devicetree-manager-for-zephyr/);
    });

    it('opens it with the application and configuration names', async () => {
      workbenchViews.devicetreeManagerInstalled = () => true;
      await open({ target: 'devicetree_manager', config_name: 'debug' });
      assert.deepEqual(calls, [{ view: 'devicetreeManager', args: [appRoot, 'debug'] }]);
    });
  });

  it('opens the West Manager and the terminals', async () => {
    assert.equal((await open({ target: 'west_manager', west_workspace: westRoot })).west_workspace, westRoot);
    assert.equal((await open({ target: 'terminal', west_workspace: westRoot })).terminal, 'ws Terminal');
    assert.equal((await open({ target: 'terminal', config_name: 'debug' })).terminal, 'app (debug) Terminal');
    assert.deepEqual(calls.map(call => call.view), ['westManager', 'westWorkspaceTerminal', 'appTerminal']);
    assert.equal(calls[2].args[1], debug);
  });

  describe('ECLAIR', () => {
    const installEclair = (programs: string[], recorded: boolean) => {
      const dir = path.join(root, 'eclair', 'bin');
      fs.mkdirSync(dir, { recursive: true });
      for (const name of programs) {
        const file = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
        fs.writeFileSync(file, '#!/bin/sh\n');
        fs.chmodSync(file, 0o755);
      }
      fs.mkdirSync(path.join(root, '.zinstaller'), { recursive: true });
      fs.writeFileSync(path.join(root, '.zinstaller', 'env.yml'), recorded ? `other:\n  EXTRA_TOOLS:\n    path:\n      - ${dir}\n` : 'other: {}\n');
      if (!recorded) {
        setEnv('PATH', `${dir}${path.delimiter}/usr/bin${path.delimiter}/bin`);
      }
      return dir;
    };

    it('reports ECLAIR missing instead of opening its manager', async () => {
      assert.equal((await errorOf(open({ target: 'eclair_manager' }))).code, 'DEPENDENCY_MISSING');
      assert.deepEqual(calls, []);
    });

    it('does not open the ECLAIR Manager when that would record ECLAIR in env.yml', async function () {
      if (process.platform === 'win32') {
        this.skip();
      }
      installEclair(['eclair', 'eclair_env', 'eclair_report'], false);
      const before = fs.readFileSync(path.join(root, '.zinstaller', 'env.yml'), 'utf8');
      const error = await errorOf(open({ target: 'eclair_manager' }));
      assert.equal(error.code, 'ENV_NOT_READY');
      assert.equal(fs.readFileSync(path.join(root, '.zinstaller', 'env.yml'), 'utf8'), before);
      assert.deepEqual(calls, []);
    });

    it('opens the ECLAIR Manager once ECLAIR is recorded', async () => {
      installEclair(['eclair'], true);
      await open({ target: 'eclair_manager' });
      assert.deepEqual(calls, [{ view: 'eclairManager', args: [{ fsPath: '/extension' }, app] }]);
    });

    it('serves the report of the build, and needs eclair_report and a database', async () => {
      installEclair(['eclair'], true);
      assert.equal((await errorOf(open({ target: 'eclair_report', config_name: 'debug' }))).code, 'DEPENDENCY_MISSING');
      const dir = installEclair(['eclair', 'eclair_report'], true);
      const notBuilt = await errorOf(open({ target: 'eclair_report', config_name: 'debug' }));
      assert.equal(notBuilt.code, 'NOT_BUILT');
      assert.match(notBuilt.hint ?? '', /analyze with analysis "eclair"/);
      const database = path.join(buildDir, 'sca', 'eclair', 'PROJECT.ecd');
      fs.mkdirSync(path.dirname(database), { recursive: true });
      fs.writeFileSync(database, '');
      const result = await open({ target: 'eclair_report', config_name: 'debug' });
      assert.equal(result.database, database);
      const [command] = calls[0].args as string[];
      assert.ok(command.startsWith(`"${path.join(dir, process.platform === 'win32' ? 'eclair_report.exe' : 'eclair_report')}"`));
      assert.ok(command.includes(`-db="${database}" -browser -server=restart`));
    });
  });

  describe('debug and runner pages', () => {
    let commands: { id: string; args: unknown[] }[];
    let savedExecute: unknown;

    beforeEach(() => {
      commands = [];
      savedExecute = stub.commands.executeCommand;
      stub.commands.executeCommand = async (id: string, ...args: unknown[]) => {
        commands.push({ id, args });
        return undefined;
      };
    });
    afterEach(() => {
      stub.commands.executeCommand = savedExecute;
    });

    it('opens the Debug Manager with the application and configuration selected, as the explorer does', async () => {
      const result = await open({ target: 'debug_manager', app_path: appRoot, config_name: 'debug' });
      assert.deepEqual(commands, [{ id: DEBUG_MANAGER_COMMAND, args: [{ project: app, buildConfig: debug }] }]);
      assert.equal(commands[0].id, 'zephyr-workbench.debug-manager');
      assert.equal(result.opened, 'debug_manager');
      assert.equal(result.config_name, 'debug');
    });

    it('uses the active configuration when none is named', async () => {
      await open({ target: 'debug_manager' });
      assert.deepEqual(commands, [{ id: DEBUG_MANAGER_COMMAND, args: [{ project: app, buildConfig: primary }] }]);
    });

    // Without a build the panel runs a CMake configure into <app>/.tmp as it loads.
    it('refuses the Debug Manager for a configuration that is not built', async () => {
      built = false;
      const error = await errorOf(open({ target: 'debug_manager', config_name: 'debug' }));
      assert.equal(error.code, 'NOT_BUILT');
      assert.match(error.hint ?? '', /^Call build_app with config_name "debug"/);
      assert.deepEqual(commands, []);
    });

    it('opens the pyOCD Manager on its own, or with the build asked for', async () => {
      assert.deepEqual(await open({ target: 'pyocd_manager' }), { opened: 'pyocd_manager' });
      const result = await open({ target: 'pyocd_manager', config_name: 'debug' });
      assert.equal(result.config_name, 'debug');
      const withApp = await open({ target: 'pyocd_manager', app_path: appRoot });
      assert.equal(withApp.config_name, 'primary');
      assert.deepEqual(commands, [
        { id: PYOCD_MANAGER_COMMAND, args: [] },
        { id: PYOCD_MANAGER_COMMAND, args: [{ project: app, buildConfig: debug }] },
        { id: PYOCD_MANAGER_COMMAND, args: [{ project: app, buildConfig: primary }] },
      ]);
      assert.equal(PYOCD_MANAGER_COMMAND, 'zephyr-workbench.pyocd-manager');
    });

    // The panel resolves the pack of the board target, which downloads the missing index.
    it('does not open the pyOCD Manager of a build when pyOCD has no pack index', async () => {
      packIndex = false;
      const error = await errorOf(open({ target: 'pyocd_manager', app_path: appRoot }));
      assert.equal(error.code, 'DEPENDENCY_MISSING');
      assert.match(error.hint ?? '', /manage_runners with action "pyocd_update_index"/);
      assert.deepEqual(commands, []);
      // Without a build it resolves nothing, and never looks at the index.
      workbenchViews.pyocdPackIndex = async () => assert.fail('the index is not read without a build');
      assert.deepEqual(await open({ target: 'pyocd_manager' }), { opened: 'pyocd_manager' });
      // Unknown, as without pyocd: the panel reports that itself.
      workbenchViews.pyocdPackIndex = async () => undefined;
      await open({ target: 'pyocd_manager', config_name: 'debug' });
      assert.deepEqual(commands, [
        { id: PYOCD_MANAGER_COMMAND, args: [] },
        { id: PYOCD_MANAGER_COMMAND, args: [{ project: app, buildConfig: debug }] },
      ]);
    });

    it('does not open the pyOCD Manager of a build while a runner job works', async () => {
      let release: () => void = () => undefined;
      const { job } = jobs.start({
        kind: 'install', lockKey: RUNNER_TOOLS_LOCK, requestKey: 'runners:pyocd:update-index', command: 'pyocd pack update',
        run: () => new Promise(resolve => { release = () => resolve({ exitCode: 0 }); }),
      });
      const error = await errorOf(open({ target: 'pyocd_manager', app_path: appRoot }));
      assert.equal(error.code, 'BUSY');
      assert.equal((error.details as any).job_id, job.id);
      assert.deepEqual(commands, []);
      release();
      await job.done;
      await open({ target: 'pyocd_manager', app_path: appRoot });
      assert.equal(commands.length, 1);
    });

    it('opens the Install Runners page with no argument, from any window', async () => {
      assert.deepEqual(await open({ target: 'install_runners' }), { opened: 'install_runners' });
      assert.deepEqual(commands, [{ id: INSTALL_RUNNERS_COMMAND, args: [] }]);
      assert.equal(INSTALL_RUNNERS_COMMAND, 'zephyr-workbench.install-runners');
      const tool = findTool('open_in_workbench')!;
      assert.equal(isMachineScope(tool, { target: 'install_runners' }), true);
      assert.equal(isMachineScope(tool, { target: 'debug_manager' }), false);
      assert.equal(isMachineScope(tool, { target: 'pyocd_manager' }), true);
      assert.equal(isMachineScope(tool, { target: 'pyocd_manager', config_name: 'debug' }), false);
    });

    it('reports a page that fails to open', async () => {
      stub.commands.executeCommand = async () => { throw new Error('command not found'); };
      const error = await errorOf(open({ target: 'install_runners' }));
      assert.equal(error.code, 'INTERNAL');
      assert.match(error.message, /Install Runners page did not open: command not found/);
    });

    it('does not wait for a page that takes long to open', async function () {
      this.timeout(10000);
      stub.commands.executeCommand = () => new Promise(() => undefined);
      const started = Date.now();
      assert.equal((await open({ target: 'install_runners' })).opened, 'install_runners');
      assert.ok(Date.now() - started < 6000);
    });
  });

  describe('plots, Puncover and the West dashboard', () => {
    const served = ['ram_plot', 'rom_plot', 'puncover', 'west_dashboard'] as const;

    const holdJob = (spec: Record<string, unknown>) => {
      let release: () => void = () => undefined;
      const { job } = jobs.start({
        requestKey: String(spec.kind), command: 'west', ...spec,
        run: () => new Promise(resolve => { release = () => resolve({ exitCode: 0 }); }),
      } as any);
      return { job, release: () => release() };
    };

    it('run each west build target for the configuration asked for, without waiting for the task', async () => {
      for (const target of served) {
        const result = await open({ target, config_name: 'debug' });
        assert.equal(result.opened, target);
        assert.equal(result.config_name, 'debug');
        assert.equal(result.task, SERVED_TASKS[target].task);
        assert.match(result.note, new RegExp(`west build -t ${SERVED_TASKS[target].westTarget} in a VS Code terminal`));
        assert.match(result.note, /build_app answers BUSY_EXTERNAL for debug/);
      }
      assert.deepEqual(calls, served.map(target => ({ view: 'serveBuildTarget', args: [app, debug, target] })));
      assert.deepEqual(served.map(target => SERVED_TASKS[target].task), ['West RAM Plot', 'West ROM Plot', 'West Puncover', 'West Dashboard']);
    });

    // plot.py serves the page for one request and exits; Puncover is a server.
    it('say only Puncover keeps a server until the user stops it, that a plot ends once shown, and that the dashboard opens in the browser', async () => {
      for (const target of ['ram_plot', 'rom_plot']) {
        const plot = await open({ target });
        assert.match(plot.note, /opens it in the user's browser and then ends/, target);
        assert.doesNotMatch(plot.note, /until the user stops|keeps a server running/, target);
      }
      const puncover = await open({ target: 'puncover' });
      assert.match(puncover.note, /keeps a server running/);
      assert.match(puncover.note, /until the user stops the task in its terminal/);
      const dashboard = await open({ target: 'west_dashboard' });
      assert.match(dashboard.note, /opens the dashboard in the user's browser/);
    });

    // The task provider runs no plot there, and the top-level sysbuild folder defines none of the four targets.
    it('refuse every served target on a sysbuild configuration', async () => {
      for (const target of served) {
        const error = await errorOf(open({ target, config_name: 'sb' }));
        assert.equal(error.code, 'SYSBUILD_UNSUPPORTED', target);
        assert.match(error.hint ?? '', /^Call get_memory_report with config_name "sb"/);
      }
      assert.deepEqual(calls, []);
    });

    describe('with the targets build.ninja defines', () => {
      const ninja = (...targets: string[]) => {
        fs.mkdirSync(buildDir, { recursive: true });
        fs.writeFileSync(path.join(buildDir, 'build.ninja'),
          ['ninja_required_version = 1.5', ...targets.map(target => `build ${target}: phony zephyr/${target}`), 'build all: phony', ''].join('\n'));
      };

      it('refuse the plots and the dashboard where Zephyr predates them, as in a Zephyr 4.0 build', async () => {
        ninja('puncover', 'ram_report', 'rom_report');
        for (const target of ['ram_plot', 'rom_plot', 'west_dashboard'] as const) {
          const error = await errorOf(open({ target, config_name: 'debug' }));
          assert.equal(error.code, 'INVALID_ARGUMENT', target);
          assert.match(error.message, new RegExp(`no ${SERVED_TASKS[target].westTarget} target`), target);
        }
        const plot = await errorOf(open({ target: 'ram_plot', config_name: 'debug' }));
        assert.match(plot.hint ?? '', /^Call get_memory_report with config_name "debug"/);
        assert.deepEqual(calls, []);
        await open({ target: 'puncover', config_name: 'debug' });
        assert.deepEqual(calls, [{ view: 'serveBuildTarget', args: [app, debug, 'puncover'] }]);
      });

      it('report puncover missing when CMake did not find it', async () => {
        ninja('ram_report', 'rom_report', 'ram_plot', 'rom_plot', 'dashboard');
        const error = await errorOf(open({ target: 'puncover', config_name: 'debug' }));
        assert.equal(error.code, 'DEPENDENCY_MISSING');
        assert.match(error.hint ?? '', /pip install puncover/);
        assert.deepEqual(calls, []);
      });

      it('run every target a Zephyr 4.4 build defines', async () => {
        ninja('puncover', 'ram_report', 'rom_report', 'ram_plot', 'rom_plot', 'dashboard');
        for (const target of served) {
          await open({ target, config_name: 'debug' });
        }
        assert.deepEqual(calls.map(call => call.args[2]), [...served]);
      });
    });

    it('need a completed build', async () => {
      built = false;
      for (const target of served) {
        const error = await errorOf(open({ target, config_name: 'debug' }));
        assert.equal(error.code, 'NOT_BUILT', target);
        assert.match(error.hint ?? '', /^Call build_app with config_name "debug"/);
      }
      assert.deepEqual(calls, []);
    });

    it('need a board', async () => {
      const bare = { name: 'bare', active: false };
      const ctxWithBare = ctx();
      (ctxWithBare.deps.services as any).resolveTarget = async () => ({ app, config: bare, buildDir: path.join(appRoot, 'build', 'bare') });
      const error = await errorOf(openInWorkbench({ target: 'puncover' }, ctxWithBare));
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.deepEqual(calls, []);
    });

    it('are refused while an agent builds, flashes or deletes the build folder', async () => {
      for (const kind of ['build', 'flash', 'clean']) {
        const held = holdJob({ kind, lockKey: `${kind}:${buildDir}`, appPath: appRoot, configName: 'debug', buildDir });
        for (const target of served) {
          const error = await errorOf(open({ target, config_name: 'debug' }));
          assert.equal(error.code, 'BUSY', `${target} during ${kind}`);
          assert.equal((error.details as any).job_id, held.job.id);
          assert.match(error.hint ?? '', /job \{"action": "status"/);
        }
        held.release();
        await held.job.done;
      }
      assert.deepEqual(calls, []);
    });

    it('are refused while an agent deletes every build folder of the application', async () => {
      const all = path.join(appRoot, 'build');
      const held = holdJob({ kind: 'clean', lockKey: all, appPath: appRoot, buildDir: all });
      assert.equal((await errorOf(open({ target: 'ram_plot', config_name: 'debug' }))).code, 'BUSY');
      held.release();
      await held.job.done;
      assert.deepEqual(calls, []);
    });

    // The launch prompt would otherwise ask the user to wait for the agent.
    it('are refused while an agent changes the west workspace of the application', async () => {
      const held = holdJob({ kind: 'west', lockKey: westRoot, westWorkspace: westRoot, writes: ['west_workspace'] });
      const error = await errorOf(open({ target: 'puncover', config_name: 'debug' }));
      assert.equal(error.code, 'BUSY');
      assert.equal((error.details as any).job_id, held.job.id);
      // menuconfig meets the same launch prompt.
      assert.equal((await errorOf(open({ target: 'menuconfig', config_name: 'debug' }))).code, 'BUSY');
      held.release();
      await held.job.done;
      // A job that only reads the west workspace does not count.
      const reader = holdJob({ kind: 'build', lockKey: 'other', westWorkspace: westRoot, buildDir: path.join(root, 'other', 'build') });
      await open({ target: 'puncover', config_name: 'debug' });
      reader.release();
      await reader.job.done;
      assert.equal(calls.length, 1);
    });

    it('are refused while a task the user started works on the configuration, a running plot included', async () => {
      const savedTasks = stub.tasks;
      stub.tasks = {
        ...savedTasks,
        taskExecutions: [{ task: { name: 'West RAM Plot', definition: { type: 'zephyr-workbench', config: 'debug' }, scope: { uri: { fsPath: appRoot } } } }],
      };
      try {
        for (const target of served) {
          const error = await errorOf(open({ target, config_name: 'debug' }));
          assert.equal(error.code, 'BUSY_EXTERNAL', target);
          assert.match(error.hint ?? '', /for a server such as Puncover ask the user to stop it there/);
        }
        // Another configuration of the application is free.
        await open({ target: 'rom_plot', config_name: 'primary' });
      } finally {
        stub.tasks = savedTasks;
      }
      assert.deepEqual(calls, [{ view: 'serveBuildTarget', args: [app, primary, 'rom_plot'] }]);
    });

    it('report a task that cannot start', async () => {
      workbenchViews.serveBuildTarget = async () => { throw new Error('Missing Zephyr environment script.\nGo to File > Preferences'); };
      assert.equal((await errorOf(open({ target: 'ram_plot' }))).code, 'ENV_NOT_READY');
    });
  });

  describe('wizards', () => {
    it('open when what they need is there', async () => {
      await open({ target: 'add_application' });
      await open({ target: 'add_west_workspace' });
      await open({ target: 'add_toolchain' });
      assert.deepEqual(calls.map(call => call.view), ['addApplication', 'addWestWorkspace', 'addToolchain']);
    });

    it('say what is missing otherwise', async () => {
      workbenchViews.westWorkspaceCount = () => 0;
      workbenchViews.hostToolsReady = async () => false;
      assert.equal((await errorOf(open({ target: 'add_application' }))).code, 'INVALID_ARGUMENT');
      assert.equal((await errorOf(open({ target: 'add_west_workspace' }))).code, 'ENV_NOT_READY');
      assert.equal((await errorOf(open({ target: 'add_toolchain' }))).code, 'ENV_NOT_READY');
      assert.deepEqual(calls, []);
    });
  });
});

describe('dashboard reveal with a configuration', () => {
  const project = (root: string) => ({
    appRootPath: root, appWorkspaceFolder: { uri: { fsPath: root } },
    buildConfigs: [{ name: 'primary', active: true }, { name: 'debug', active: false }],
  });
  const a = project('/work/a');
  const b = project('/work/b');
  let savedEditor: unknown;

  beforeEach(() => {
    savedEditor = stub.window.activeTextEditor;
  });
  afterEach(() => {
    stub.window.activeTextEditor = savedEditor;
  });

  it('keeps the revealed application and configuration until the user switches editors', () => {
    const provider = new ZephyrDashboardViewProvider() as any;
    assert.equal(ZephyrDashboardViewProvider.current, provider);
    stub.window.activeTextEditor = { document: { uri: { fsPath: '/work/b/src/main.c', toString: () => 'file:///work/b/src/main.c' } } };
    provider._setTargetFromNode({ project: a }, { configName: 'debug', pin: true });
    assert.equal(provider._selectProject([a, b]), a);
    assert.equal(provider._selectConfig(a).name, 'debug');
    // Another editor: the dashboard follows the editor again, as before any reveal.
    stub.window.activeTextEditor = { document: { uri: { fsPath: '/work/c.txt', toString: () => 'file:///work/c.txt' } } };
    assert.equal(provider._selectProject([a, b]), undefined);
    assert.equal(provider._selectConfig(a).name, 'primary');
  });

  it('changes nothing for a reveal without options', () => {
    const provider = new ZephyrDashboardViewProvider() as any;
    provider._setTargetFromNode({ project: a }, { configName: 'debug', pin: true });
    provider._setTargetFromNode({ project: a });
    stub.window.activeTextEditor = undefined;
    assert.equal(provider._selectProject([a, b]), a);
    assert.equal(provider._selectConfig(a).name, 'primary');
  });
});
