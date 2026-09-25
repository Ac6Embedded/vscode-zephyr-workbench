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
import { openInWorkbench, workbenchViews } from '../../../mcp/host/handlers/openInWorkbench';
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
    app = { appRootPath: appRoot, appName: 'app', appWorkspaceFolder: { uri: { fsPath: appRoot } }, buildConfigs: [primary, debug] };
    saved.views = { ...workbenchViews };
    const record = (view: string, value?: unknown) => (...args: unknown[]) => { calls.push({ view, args }); return value; };
    Object.assign(workbenchViews, {
      file: record('file', Promise.resolve()),
      dashboard: record('dashboard', Promise.resolve(true)),
      kconfigManager: record('kconfigManager', Promise.resolve()),
      // Like the real tool, it only ends when the user closes it.
      westConfig: record('westConfig', new Promise(() => undefined)),
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
          const config = configName === 'debug' ? debug : primary;
          return { app, config, buildDir: path.join(appRoot, 'build', config.name) };
        },
        resolveApp: async () => app,
        resolveWestWorkspace: async () => ({ workspace: workspace() }),
        knownRoots: async () => [appRoot, westRoot],
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
