// The analyze tool with a real job manager and every host dependency faked:
// the workbench tasks are stood in for (analysisTasks), so a test decides
// what each step prints and returns, and checks what the job reports, what it
// refuses up front, and what it deletes.

import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findTool } from '../../../mcp/core/catalog';
import { McpToolError } from '../../../mcp/core/errors';
import { ToolContext } from '../../../mcp/core/toolSpec';
import { analysisTasks, analyze } from '../../../mcp/host/handlers/analysis';
import type { HostDeps } from '../../../mcp/host/handlers/deps';
import { JobManager } from '../../../mcp/jobs/jobManager';
import { local_checkout_revs, resolve_ref_to_rev } from '../../../panels/EclairManagerPanel/repo_manage';
import { useUiGuard } from './uiGuard';

const stub = require('vscode') as Record<string, any>;

const HARDENCONFIG_OUTPUT = [
  '+----------------------+-----------+---------------+----------------+',
  '| Name                 | Current   | Recommended   | Check result   |',
  '+======================+===========+===============+================+',
  '| CONFIG_BOOT_BANNER   | y         | n             | FAIL           |',
  '+----------------------+-----------+---------------+----------------+',
  '',
].join('\n');

const DT_DOCTOR_OUTPUT = [
  "src/main.c:12:1: error: '__device_dts_ord_42' undeclared here (not in a function)",
  '+------------------------------------------------------------------+',
  '| DT Doctor                                                        |',
  '+==================================================================+',
  "| 'uart1: /soc/serial@40011000' is disabled in /z/boards/b.dts:123 |",
  '+------------------------------------------------------------------+',
  '',
].join('\n');

interface FakeTask { name: string; definition: Record<string, unknown>; execution: { commandLine: string }; spec?: unknown; shell?: unknown }

interface World {
  root: string;
  appRoot: string;
  buildDir: string;
  kernel: string;
  westRoot: string;
  zephyrVersion: string;
  supportsSpdx3: boolean;
  /** What each task prints and the code it ends with, by task name. */
  behave: (task: FakeTask) => { output?: string; exitCode?: number; effect?: () => void };
  ran: FakeTask[];
  closed: string[];
  editors: { buildDir: string; configName: string; dirty: boolean }[];
  jobs: JobManager;
  resolved: number;
}

const saved: { tasks?: typeof analysisTasks; uri?: unknown; env: Record<string, string | undefined> } = { env: {} };

function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved.env)) {
    saved.env[key] = process.env[key];
  }
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function makeWorld(): World {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zwb-analyze-')));
  const westRoot = path.join(root, 'ws');
  const kernel = path.join(westRoot, 'zephyr');
  const appRoot = path.join(root, 'app');
  const buildDir = path.join(appRoot, 'build', 'primary');
  fs.mkdirSync(path.join(westRoot, '.west'), { recursive: true });
  fs.mkdirSync(kernel, { recursive: true });
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'CMakeCache.txt'), 'CMAKE_HOME_DIRECTORY:INTERNAL=/nowhere\n');
  const w: World = {
    root, appRoot, buildDir, kernel, westRoot, zephyrVersion: '4.2.0', supportsSpdx3: false,
    behave: () => ({ exitCode: 0 }), ran: [], closed: [], editors: [], resolved: 0,
    jobs: new JobManager({ logPathFor: id => path.join(root, 'logs', `${id}.log`) }),
  };
  fs.mkdirSync(path.join(root, 'logs'));
  return w;
}

function fakeTask(name: string, commandLine: string, extra: Partial<FakeTask> = {}): FakeTask {
  return { name, definition: {}, execution: { commandLine }, ...extra };
}

function ctxFor(w: World): ToolContext<HostDeps> {
  const config = { name: 'primary', boardIdentifier: 'b', westArgs: '', active: true, getBuildDir: () => w.buildDir };
  const app = {
    appRootPath: w.appRoot, appName: 'app', westWorkspaceRootPath: w.westRoot, venvPath: undefined, zephyrSdkPath: '',
    appWorkspaceFolder: { uri: { fsPath: w.appRoot, toString: () => `file://${w.appRoot}` } },
    buildConfigs: [config],
  };
  const workspace = {
    version: w.zephyrVersion,
    get supportsSpdx3() { return w.supportsSpdx3; },
    kernelUri: { fsPath: w.kernel },
    rootUri: { fsPath: w.westRoot },
  };
  const deps = {
    services: {
      resolveTarget: async () => { w.resolved++; return { app, config, buildDir: w.buildDir }; },
      resolveWestWorkspace: async () => ({ workspace, app }),
      knownRoots: async () => [w.appRoot, w.westRoot],
      kconfigEditors: () => w.editors,
    },
    jobs: w.jobs,
    defaultWaitSeconds: 5,
    revealTerminal: 'never',
    kconfig: {
      closeWithin: async (folder: string) => { w.closed.push(folder); return () => undefined; },
      inUseWithin: () => [],
    },
  };
  return {
    signal: new AbortController().signal,
    progress: () => undefined,
    client: { name: 'test' },
    deps: deps as unknown as HostDeps,
    tool: findTool('analyze')!,
    startedAt: Date.now(),
    audit: {},
  };
}

async function errorOf(promise: Promise<unknown>): Promise<McpToolError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof McpToolError, `expected a tool error, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the call to fail');
}

describe('analyze', () => {
  useUiGuard();

  let w: World;
  const call = (args: Record<string, unknown>) => analyze({ wait_sec: 5, ...args }, ctxFor(w)) as Promise<any>;

  beforeEach(() => {
    w = makeWorld();
    saved.tasks = { ...analysisTasks };
    analysisTasks.direct = ((_app: unknown, _config: unknown, name: string) => fakeTask(name, `west build ${name}`)) as never;
    analysisTasks.project = ((_app: unknown, spec: { name: string }) => fakeTask(spec.name, `west ${spec.name}`, { spec })) as never;
    analysisTasks.shell = ((name: string, command: string, options: unknown) => fakeTask(name, command, { shell: options })) as never;
    analysisTasks.run = (async (task: FakeTask, sink: { onData(chunk: string): void }) => {
      w.ran.push(task);
      const { output, exitCode, effect } = w.behave(task);
      effect?.();
      if (output) {
        sink.onData(output);
      }
      return { exitCode: exitCode ?? 0, started: true };
    }) as never;
    // The settings readers test `instanceof vscode.Uri`, which needs a constructor.
    saved.uri = stub.Uri;
    stub.Uri = Object.assign(function Uri() { /* never constructed */ }, stub.Uri);
    // No ECLAIR unless a test installs one, and nothing of the real machine.
    setEnv('VSCODE_PORTABLE', w.root);
    setEnv('PATH', path.join(w.root, 'empty-path'));
    setEnv('TMPDIR', path.join(w.root, 'tmp'));
    fs.mkdirSync(path.join(w.root, 'tmp'));
  });

  afterEach(() => {
    Object.assign(analysisTasks, saved.tasks);
    stub.Uri = saved.uri;
    for (const [key, value] of Object.entries(saved.env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    saved.env = {};
    fs.rmSync(w.root, { recursive: true, force: true });
  });

  describe('arguments', () => {
    it('refuses what belongs to another analysis before resolving anything', async () => {
      const cases: Record<string, unknown>[] = [
        { analysis: 'dt_doctor', spdx_version: '2.3' },
        { analysis: 'hardenconfig', ruleset: 'ECLAIR_RULESET_STU' },
        { analysis: 'spdx', sca_config: 'x' },
        { analysis: 'eclair', include_sdk: true },
        { analysis: 'eclair', sca_config: 'x', ruleset: 'ECLAIR_RULESET_STU' },
        { analysis: 'eclair', sca_config: 'x', reports: ['ECLAIR_SUMMARY_TXT'] },
        { analysis: 'eclair', ruleset: 'ECLAIR_RULESET_NOPE' },
        { analysis: 'eclair', ruleset: 'ECLAIR_RULESET_STU', reports: ['ECLAIR_NOPE'] },
        { analysis: 'spdx', spdx_version: '4.0' },
        { analysis: 'lint' },
      ];
      for (const args of cases) {
        assert.equal((await errorOf(call(args))).code, 'INVALID_ARGUMENT', JSON.stringify(args));
      }
      assert.equal(w.resolved, 0);
    });

    it('asks for sca_config or ruleset for eclair', async () => {
      const error = await errorOf(call({ analysis: 'eclair' }));
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.ok(Array.isArray((error.details as any).rulesets));
    });
  });

  describe('refuses while something else uses the build folder', () => {
    it('a task the user started on the configuration', async () => {
      const savedTasks = stub.tasks;
      stub.tasks = {
        ...savedTasks,
        taskExecutions: [{ task: { name: 'West Build [primary]', definition: { type: 'zephyr-workbench', config: 'primary' }, scope: { uri: { fsPath: w.appRoot } } } }],
      };
      try {
        assert.equal((await errorOf(call({ analysis: 'hardenconfig' }))).code, 'BUSY_EXTERNAL');
      } finally {
        stub.tasks = savedTasks;
      }
      assert.equal(w.ran.length, 0);
    });

    it('an agent deleting the build folders', async () => {
      let release: () => void = () => undefined;
      const { job } = w.jobs.start({
        kind: 'clean', lockKey: path.join(w.appRoot, 'build'), requestKey: 'clean', appPath: w.appRoot, buildDir: path.join(w.appRoot, 'build'),
        command: 'delete', run: () => new Promise(resolve => { release = () => resolve({ exitCode: 0 }); }),
      });
      const error = await errorOf(call({ analysis: 'hardenconfig' }));
      assert.equal(error.code, 'BUSY');
      assert.equal((error.details as any).job_id, job.id);
      release();
    });
  });

  it('runs hardenconfig as a build job and returns the options that differ', async () => {
    w.behave = () => ({ output: HARDENCONFIG_OUTPUT, exitCode: 0 });
    const view = await call({ analysis: 'hardenconfig' });
    assert.equal(view.kind, 'build');
    assert.equal(view.status, 'succeeded');
    assert.equal(view.build_dir, w.buildDir);
    assert.equal(view.command, 'west build Harden Config');
    assert.deepEqual(view.result, { analysis: 'hardenconfig', differing: 1, rows: [{ symbol: 'CONFIG_BOOT_BANNER', current: 'y', recommended: 'n' }] });
    assert.match(view.next, /set_kconfig/);
    assert.deepEqual(w.ran.map(task => task.name), ['Harden Config']);
  });

  describe('dt_doctor', () => {
    it('refuses a Zephyr without DT Doctor, naming its version', async () => {
      w.zephyrVersion = '3.7.0';
      const error = await errorOf(call({ analysis: 'dt_doctor' }));
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.match(error.message, /Zephyr 3\.7\.0/);
      assert.equal(w.ran.length, 0);
    });

    it('returns the findings and records the west build state of the run', async () => {
      fs.mkdirSync(path.join(w.kernel, 'cmake', 'sca', 'dtdoctor'), { recursive: true });
      const statePath = path.join(w.buildDir, 'west-build-state.json');
      analysisTasks.direct = ((_a: unknown, _c: unknown, name: string) => fakeTask(name, 'west build -- -DZEPHYR_SCA_VARIANT=dtdoctor', {
        definition: { __westBuildStatePath: statePath, __westBuildState: JSON.stringify({ board: 'b' }) },
      })) as never;
      w.behave = () => ({ output: DT_DOCTOR_OUTPUT, exitCode: 1 });
      const view = await call({ analysis: 'dt_doctor' });
      assert.equal(view.status, 'failed');
      assert.equal(view.result.findings_count, 1);
      assert.equal(view.result.findings[0].node, '/soc/serial@40011000');
      assert.equal(view.result.sca_variant, 'dtdoctor');
      assert.match(view.next, /pristine "always"/);
      assert.ok(view.diagnostics.errors >= 1, 'the compiler error is parsed as for any build');
      assert.ok(fs.existsSync(statePath), 'the west build state is recorded as build_app does');
    });
  });

  describe('spdx', () => {
    it('refuses SPDX 3.0 on a Zephyr that lacks it, naming the version', async () => {
      const error = await errorOf(call({ analysis: 'spdx', spdx_version: '3.0' }));
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.match(error.message, /Zephyr 4\.2\.0/);
      assert.ok(fs.existsSync(path.join(w.buildDir, 'CMakeCache.txt')), 'nothing was deleted');
    });

    it('refuses while the Kconfig Manager runs inside the folder it deletes', async () => {
      w.editors = [{ buildDir: w.buildDir, configName: 'primary', dirty: false }];
      assert.equal((await errorOf(call({ analysis: 'spdx' }))).code, 'BUSY_EXTERNAL');
    });

    it('deletes only the configuration folder, runs the steps, and lists the documents', async () => {
      w.supportsSpdx3 = true;
      const other = path.join(w.appRoot, 'build', 'debug');
      fs.mkdirSync(other, { recursive: true });
      const marker = path.join(w.buildDir, 'old.txt');
      fs.writeFileSync(marker, 'stale');
      let markerGoneAtInit = false;
      w.behave = task => {
        if (task.name === 'SPDX init') {
          markerGoneAtInit = !fs.existsSync(marker);
        }
        if (task.name.startsWith('SPDX generate')) {
          return {
            exitCode: 0,
            effect: () => {
              fs.mkdirSync(path.join(w.buildDir, 'spdx'), { recursive: true });
              fs.writeFileSync(path.join(w.buildDir, 'spdx', 'app.spdx.json'), '{}');
            },
          };
        }
        return { exitCode: 0 };
      };
      const view = await call({ analysis: 'spdx', include_sdk: true });
      assert.equal(view.status, 'succeeded');
      assert.ok(markerGoneAtInit, 'the folder is deleted before the first step');
      assert.ok(fs.existsSync(other), 'another configuration keeps its folder');
      assert.deepEqual(w.closed, [w.buildDir]);
      assert.deepEqual(w.ran.map(task => task.name), ['SPDX init', 'West Build', 'SPDX generate 3.0']);
      assert.deepEqual((w.ran[2].spec as any).options, { extraArgs: ['--include-sdk'] });
      assert.deepEqual((w.ran[1].spec as any).options, { rawWestArgsOverride: '-- -DCONFIG_BUILD_OUTPUT_META=y' });
      assert.equal(view.result.spdx_version, '3.0');
      assert.equal(view.result.spdx_dir, path.join(w.buildDir, 'spdx'));
      assert.deepEqual(view.result.documents.map((d: any) => d.name), ['app.spdx.json']);
    });

    it('stops at a failed build with its exit code', async () => {
      w.behave = task => ({ exitCode: task.name === 'West Build' ? 2 : 0 });
      const view = await call({ analysis: 'spdx', spdx_version: '2.3' });
      assert.equal(view.status, 'failed');
      assert.equal(view.exit_code, 2);
      assert.equal(view.result.failed_step, 'build');
      assert.deepEqual(w.ran.map(task => task.name), ['SPDX init', 'West Build']);
    });
  });

  describe('eclair', () => {
    const installEclair = (programs = ['eclair', 'eclair_env', 'eclair_report']) => {
      const dir = path.join(w.root, 'eclair', 'bin');
      fs.mkdirSync(dir, { recursive: true });
      for (const name of programs) {
        fs.writeFileSync(path.join(dir, process.platform === 'win32' ? `${name}.exe` : name), '');
      }
      fs.mkdirSync(path.join(w.root, '.zinstaller'), { recursive: true });
      fs.writeFileSync(path.join(w.root, '.zinstaller', 'env.yml'), `other:\n  EXTRA_TOOLS:\n    path:\n      - ${dir}\n`);
      return dir;
    };

    it('reports ECLAIR missing instead of running', async () => {
      const error = await errorOf(call({ analysis: 'eclair', ruleset: 'ECLAIR_RULESET_STU' }));
      assert.equal(error.code, 'DEPENDENCY_MISSING');
      assert.ok(!fs.existsSync(path.join(w.root, '.zinstaller', 'env.yml')), 'env.yml is never written');
    });

    it('says what is missing from an incomplete install', async () => {
      installEclair(['eclair']);
      const error = await errorOf(call({ analysis: 'eclair', ruleset: 'ECLAIR_RULESET_STU' }));
      assert.equal(error.code, 'ENV_NOT_READY');
      assert.match(error.message, /eclair_env or eclair_report/);
    });

    it('lists the saved configurations when sca_config names none of them', async () => {
      installEclair();
      const savedFs = stub.workspace.fs;
      stub.workspace.fs = { readFile: async () => Buffer.from(JSON.stringify({ configs: [{ name: 'MISRA', main_config: { type: 'zephyr-ruleset', ruleset: 'ECLAIR_RULESET_STU' } }] })) };
      try {
        const error = await errorOf(call({ analysis: 'eclair', sca_config: 'misra' }));
        assert.equal(error.code, 'INVALID_ARGUMENT');
        assert.deepEqual((error.details as any).saved, ['MISRA']);
      } finally {
        stub.workspace.fs = savedFs;
      }
    });

    it('runs a ruleset in the west workspace, always with SARIF, and summarises the findings', async () => {
      const eclairDir = installEclair();
      const envYml = fs.readFileSync(path.join(w.root, '.zinstaller', 'env.yml'), 'utf8');
      const scaDir = path.join(w.buildDir, 'sca', 'eclair');
      w.behave = () => ({
        exitCode: 0,
        effect: () => {
          fs.mkdirSync(scaDir, { recursive: true });
          fs.writeFileSync(path.join(scaDir, 'summary_overall.txt'), 'Total: 2 violations\n');
          fs.writeFileSync(path.join(scaDir, 'reports.sarif'), JSON.stringify({
            runs: [{ tool: { driver: { name: 'ECLAIR' } }, results: [
              { ruleId: 'MC3R1.R10.1', level: 'error', message: { text: 'a' } },
              { ruleId: 'MC3R1.R10.1', level: 'warning', message: { text: 'b' } },
            ] }],
          }));
        },
      });
      const view = await call({ analysis: 'eclair', ruleset: 'ECLAIR_RULESET_STU', reports: ['ECLAIR_SUMMARY_TXT'] });
      assert.equal(view.status, 'succeeded');
      const [task] = w.ran;
      assert.equal(task.name, 'ECLAIR Analysis');
      assert.match(task.execution.commandLine, /--pristine .*-DECLAIR_RULESET_STU=ON .*-DECLAIR_SUMMARY_TXT=ON -DECLAIR_REPORTS_SARIF=ON$/);
      const shell = task.shell as { cwd: string; env: Record<string, string> };
      assert.equal(shell.cwd, w.westRoot);
      assert.equal(shell.env.CCACHE_DISABLE, '1');
      assert.ok(shell.env.PATH.split(path.delimiter).includes(eclairDir));
      // Its generated files go to a folder of this build's own, not the shared temporary folder.
      assert.ok(!fs.existsSync(path.join(w.root, 'tmp', 'eclair_wrapper.cmake')));
      const options = /-DECLAIR_OPTIONS_FILE=(\S+)/.exec(task.execution.commandLine)![1];
      assert.ok(fs.existsSync(options) && options.includes('zephyr-workbench-eclair'));
      assert.deepEqual(w.closed, [w.buildDir]);
      assert.equal(view.result.sca_dir, scaDir);
      assert.equal(view.result.sarif_path, path.join(scaDir, 'reports.sarif'));
      assert.equal(view.result.summary, 'Total: 2 violations');
      assert.deepEqual(view.result.findings.by_rule, [{ rule: 'MC3R1.R10.1', count: 2, errors: 1, warnings: 1 }]);
      assert.match(view.next, /get_diagnostics with source "sca"/);
      assert.equal(fs.readFileSync(path.join(w.root, '.zinstaller', 'env.yml'), 'utf8'), envYml, 'env.yml is left as it was');
    });

    it('leaves the files an earlier analysis of the build uses alone when the call is refused', async () => {
      installEclair();
      const extra = (name: string) => {
        const file = path.join(w.appRoot, `${name}.ecl`);
        fs.writeFileSync(file, '');
        return file;
      };
      const configs = [
        { name: 'A', main_config: { type: 'zephyr-ruleset', ruleset: 'ECLAIR_RULESET_STU' }, extra_config: extra('a') },
        { name: 'B', main_config: { type: 'zephyr-ruleset', ruleset: 'ECLAIR_RULESET_STU' }, extra_config: extra('b') },
      ];
      const savedFs = stub.workspace.fs;
      stub.workspace.fs = { readFile: async () => Buffer.from(JSON.stringify({ configs })) };
      let release: () => void = () => undefined;
      try {
        assert.equal((await call({ analysis: 'eclair', sca_config: 'A' })).status, 'succeeded');
        // The CMake cache of the build keeps naming this file for later reconfigures.
        const options = /-DECLAIR_OPTIONS_FILE=(\S+)/.exec(w.ran[0].execution.commandLine)![1];
        const written = fs.readFileSync(options, 'utf8');
        assert.match(written, /a\.ecl/);

        // A west update of the workspace the analysis builds with refuses the next one.
        w.jobs.start({
          kind: 'west', lockKey: `west:${w.westRoot}`, requestKey: 'update', westWorkspace: w.westRoot, writes: ['west_workspace'],
          command: 'west update', run: () => new Promise(resolve => { release = () => resolve({ exitCode: 0 }); }),
        });
        assert.equal((await errorOf(call({ analysis: 'eclair', sca_config: 'B' }))).code, 'BUSY');
        assert.equal(fs.readFileSync(options, 'utf8'), written, 'the refused call left the options file as it was');
        assert.equal(w.ran.length, 1);
      } finally {
        release();
        stub.workspace.fs = savedFs;
      }
    });

    describe('preset repositories', () => {
      const origin = 'https://example.com/presets.git';
      const V1 = '1'.repeat(40);
      const MAIN = '2'.repeat(40);
      /** A checkout as the ECLAIR Manager leaves it, folder named after its revision. */
      const checkout = (rev: string, gitFiles: Record<string, string>, fetchedAt: number, from = origin) => {
        const hash = createHash('sha256').update(from).digest('hex').slice(0, 12);
        const dir = path.join(w.root, '.zinstaller', 'tools', 'sca', 'eclair', 'repos', 'checkouts', hash, rev);
        fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'rulesets'));
        fs.writeFileSync(path.join(dir, 'rulesets', 'misra.ecl'), '```ECL:\ntitle: MISRA\nkind: ruleset\ndescription: MISRA rules\n```\n');
        for (const [name, content] of Object.entries(gitFiles)) {
          fs.writeFileSync(path.join(dir, '.git', name), content);
          fs.utimesSync(path.join(dir, '.git', name), fetchedAt, fetchedAt);
        }
        fs.utimesSync(dir, fetchedAt, fetchedAt);
        return dir;
      };
      const useConfig = (ref: string, from = origin) => {
        stub.workspace.fs = {
          readFile: async () => Buffer.from(JSON.stringify({
            configs: [{
              name: 'MISRA',
              main_config: { type: 'preset', rulesets: [{ source: { type: 'repo-path', repo: 'presets', path: 'rulesets/misra.ecl' } }], variants: [], tailorings: [] },
            }],
            repos: { presets: { origin: from, ref } },
          })),
        };
      };
      let savedFs: unknown;
      beforeEach(() => { savedFs = stub.workspace.fs; });
      afterEach(() => { stub.workspace.fs = savedFs; });

      it('reads the presets from the checkout of the branch or tag the configuration names, not the newest one', async () => {
        installEclair();
        const now = Date.now() / 1000;
        const v1 = checkout(V1, { FETCH_HEAD: `${'9'.repeat(40)}\t\ttag 'v1.0' of ${origin}\n` }, now - 86400);
        checkout(MAIN, { FETCH_HEAD: `${MAIN}\t\tbranch 'main' of ${origin}\n` }, now);
        useConfig('v1.0');
        const view = await call({ analysis: 'eclair', sca_config: 'MISRA' });
        assert.equal(view.status, 'succeeded');
        assert.deepEqual(view.result.preset_revisions, { presets: V1 });
        const rulesetDir = /-DECLAIR_USER_RULESET_PATH="([^"]+)"/.exec(w.ran[0].execution.commandLine)![1];
        assert.ok(fs.readFileSync(path.join(rulesetDir, 'analysis_dummy.ecl'), 'utf8').includes(path.join(v1, 'rulesets', 'misra.ecl')));
      });

      it('refuses a ref no checkout was made for instead of taking another one', async () => {
        installEclair();
        checkout(MAIN, { FETCH_HEAD: `${MAIN}\t\tbranch 'main' of ${origin}\n` }, Date.now() / 1000);
        useConfig('v2.0');
        const error = await errorOf(call({ analysis: 'eclair', sca_config: 'MISRA' }));
        assert.equal(error.code, 'ENV_NOT_READY');
        assert.match(error.hint ?? '', /open_in_workbench with target "eclair_manager"/);
        assert.equal(w.ran.length, 0);
      });

      it('finds the checkouts of a ref by what git recorded, newest fetch first, also in a full clone', () => {
        const now = Date.now() / 1000;
        checkout(MAIN, { FETCH_HEAD: `${MAIN}\t\tbranch 'main' of ${origin}\n` }, now - 60);
        const newer = '3'.repeat(40);
        checkout(newer, { FETCH_HEAD: `${newer}\t\tbranch 'main' of ${origin}\n` }, now);
        // A clone lists its refs in packed-refs; an annotated tag is followed by the commit it names.
        checkout(V1, {
          'packed-refs': `# pack-refs with: peeled fully-peeled sorted\n${newer} refs/remotes/origin/main\n${'9'.repeat(40)} refs/tags/v1.0\n^${V1}\n`,
        }, now - 120);
        assert.deepEqual(local_checkout_revs(origin, 'main'), [newer, MAIN]);
        assert.deepEqual(local_checkout_revs(origin, 'refs/tags/v1.0'), [V1]);
        assert.deepEqual(local_checkout_revs(origin, 'develop'), []);
        assert.deepEqual(local_checkout_revs('https://example.com/other.git', 'main'), []);
      });

      it('reads the presets of HEAD or a pull request ref from the checkout git fetched it into', async () => {
        installEclair();
        const now = Date.now() / 1000;
        const PULL = '3'.repeat(40);
        // git records a fetch of HEAD by the origin alone, and any other ref by its full name.
        checkout(MAIN, { FETCH_HEAD: `${MAIN}\t\t${origin}\n` }, now - 60);
        checkout(PULL, { FETCH_HEAD: `${PULL}\t\t'refs/pull/1/head' of ${origin}\n` }, now);
        assert.deepEqual(local_checkout_revs(origin, 'HEAD'), [MAIN]);
        assert.deepEqual(local_checkout_revs(origin, 'refs/pull/1/head'), [PULL]);
        useConfig('HEAD');
        const view = await call({ analysis: 'eclair', sca_config: 'MISRA' });
        assert.equal(view.status, 'succeeded');
        assert.deepEqual(view.result.preset_revisions, { presets: MAIN });
      });

      it('reads the presets of a ref from the checkout the ECLAIR Manager last resolved it to, even one fetched for another ref', async () => {
        installEclair();
        // A preset repository whose main branch and v1.0 tag name one commit.
        const repo = path.join(w.root, 'presets-repo');
        fs.mkdirSync(repo);
        const emptyPath = process.env.PATH;
        process.env.PATH = saved.env.PATH;
        const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
        git('init', '-q');
        git('-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-q', '--allow-empty', '-m', 'presets');
        git('tag', 'v1.0');
        const rev = git('rev-parse', 'HEAD');
        // The ECLAIR Manager fetched it for main, then reused that checkout for
        // v1.0; an older checkout was fetched for v1.0 before the tag moved.
        const now = Date.now() / 1000;
        checkout(rev, { FETCH_HEAD: `${rev}\t\tbranch 'main' of ${repo}\n` }, now - 60, repo);
        checkout(V1, { FETCH_HEAD: `${'9'.repeat(40)}\t\ttag 'v1.0' of ${repo}\n` }, now - 30, repo);
        assert.deepEqual(local_checkout_revs(repo, 'v1.0'), [V1]);
        try {
          assert.equal(await resolve_ref_to_rev(repo, 'v1.0'), rev);
        } finally {
          process.env.PATH = emptyPath;
        }
        assert.deepEqual(local_checkout_revs(repo, 'v1.0'), [rev, V1]);
        useConfig('v1.0', repo);
        const view = await call({ analysis: 'eclair', sca_config: 'MISRA' });
        assert.equal(view.status, 'succeeded');
        assert.deepEqual(view.result.preset_revisions, { presets: rev });
      });
    });
  });
});
