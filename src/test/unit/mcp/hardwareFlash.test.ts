// The flash action of the hardware tool on the host side: the real job
// manager, confirmation gate, conflict checks, runners.yaml and domains.yaml
// reading, and the real composition of the west flash arguments. Only the
// terminal that would run west flash is stood in for, so no board, probe or
// west workspace is needed.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { resetDebugSessionTrackingForTests, trackDebugSessionForTests } from '../../../debug/sessionTracker';
import { findTool, TOOL_CATALOG } from '../../../mcp/core/catalog';
import { McpToolError } from '../../../mcp/core/errors';
import {
  checkRunnerArgs, devIdArgs, devIdOption, flashFailureHint, noRebuildFlag, reservedRunnerOptions, splitWords, ZephyrVersion,
} from '../../../mcp/core/flashArgs';
import { ConfirmCategory, permissionForCategories, ToolContext } from '../../../mcp/core/toolSpec';
import { AskAnswer, Confirmations } from '../../../mcp/host/confirmations';
import { HostDeps } from '../../../mcp/host/handlers/deps';
import { hardware } from '../../../mcp/host/handlers/hardware';
import { flashHost } from '../../../mcp/host/handlers/hardwareFlash';
import { SerialCapture, serialCaptures } from '../../../mcp/host/serial/captures';
import { HostServices } from '../../../mcp/host/services';
import { JobManager, JobState } from '../../../mcp/jobs/jobManager';
import { BuildDirectTaskOptions, directTaskArgs, taskTemplate } from '../../../providers/ZephyrTaskProvider';
import { useUiGuard } from './uiGuard';

const vscodeStub = require('vscode') as Record<string, any>;

const BOARD = 'nrf52840dk/nrf52840';

const RUNNERS_YAML = [
  'flash-runner: nrfjprog',
  'debug-runner: jlink',
  'runners:',
  '- nrfjprog',
  '- nrfutil',
  '- jlink',
  '- pyocd',
  '- openocd',
  '- linkserver',
  '- esp32',
  '',
].join('\n');

interface FakeConfig {
  name: string;
  active: boolean;
  boardIdentifier: string;
  sysbuild?: string;
  defaultRunner?: string;
  customArgs?: string;
  getBuildDir(): string;
  getBuildArtifactPath(app: unknown, ...segments: string[]): string | undefined;
}

interface Harness {
  root: string;
  appRoot: string;
  buildDir: string;
  app: Record<string, unknown>;
  config: FakeConfig;
  jobs: JobManager;
  deps: HostDeps;
  asked: string[];
  /** The detail of each dialog, in the same order as asked. */
  details: string[];
  answers: AskAnswer[];
  confirmActions: ConfirmCategory[];
  /** What the handler asked buildDirectTask for, in order. */
  built: BuildDirectTaskOptions[];
  /** Command lines that reached the terminal. */
  ran: string[];
  /** What the fake west flash prints and how it ends. */
  output: string;
  exitCode: number | undefined;
  /** When set, the fake flash runs until this resolves. */
  hold?: Promise<void>;
  /** Printed into a capture while the fake flash runs, as the board boots; the sink takes west's own output. */
  onRun?: (sink: { onData(text: string): void }) => void;
  version?: ZephyrVersion;
  releases: Array<() => void>;
}

let current: Harness;

function makeApp(root: string, name = 'app'): { appRoot: string; buildDir: string; app: Record<string, unknown>; config: FakeConfig } {
  const appRoot = path.join(root, name);
  const buildDir = path.join(appRoot, 'build', 'primary');
  fs.mkdirSync(path.join(buildDir, 'zephyr'), { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'CMakeCache.txt'), 'CMAKE_HOME_DIRECTORY:INTERNAL=x\n');
  fs.writeFileSync(path.join(buildDir, 'zephyr', 'zephyr.elf'), '');
  fs.writeFileSync(path.join(buildDir, 'zephyr', 'runners.yaml'), RUNNERS_YAML);
  const config: FakeConfig = {
    name: 'primary', active: true, boardIdentifier: BOARD, sysbuild: 'false',
    getBuildDir: () => buildDir,
    getBuildArtifactPath: (_app, ...segments) => [path.join(buildDir, name, ...segments), path.join(buildDir, ...segments)]
      .find(candidate => fs.existsSync(candidate)),
  };
  const app = {
    appRootPath: appRoot, appName: name, isWestWorkspaceApplication: false, westWorkspaceRootPath: '',
    appWorkspaceFolder: { uri: { fsPath: appRoot }, name, index: 0 },
    buildConfigs: [config],
  };
  return { appRoot, buildDir, app, config };
}

/** Turn the build into a sysbuild one with an app and an mcuboot domain, each with its runners.yaml. */
function makeSysbuild(h: Harness, mcubootRunners = RUNNERS_YAML): void {
  const domains = ['app', 'mcuboot'];
  for (const domain of domains) {
    fs.mkdirSync(path.join(h.buildDir, domain, 'zephyr'), { recursive: true });
    fs.writeFileSync(path.join(h.buildDir, domain, 'zephyr', 'runners.yaml'), domain === 'mcuboot' ? mcubootRunners : RUNNERS_YAML);
  }
  fs.writeFileSync(path.join(h.buildDir, 'domains.yaml'), [
    'default: app',
    `build_dir: ${JSON.stringify(h.buildDir)}`,
    'domains:',
    ...domains.flatMap(domain => [`- name: ${domain}`, `  build_dir: ${JSON.stringify(path.join(h.buildDir, domain))}`]),
    'flash_order:',
    '- mcuboot',
    '- app',
    '',
  ].join('\n'));
  h.config.sysbuild = 'true';
}

function harness(): Harness {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-flash-')));
  const made = makeApp(root);
  const services = new HostServices(vscode.Uri.file(os.tmpdir()));
  const h = {
    root, ...made, asked: [], details: [], answers: [], confirmActions: ['hardware'], built: [], ran: [],
    output: 'Flashing file: zephyr.hex\nBoard reset.\n', exitCode: 0, releases: [],
  } as unknown as Harness;
  services.listApplications = async () => [h.app] as never;
  services.knownRoots = async () => [root];
  h.jobs = new JobManager({ logPathFor: id => path.join(root, 'jobs', `${id}.log`) });
  const confirmations = new Confirmations({
    permission: tool => permissionForCategories(tool, h.confirmActions),
    waitMs: () => 2000,
    log: { recordConfirmation: () => undefined },
    ask: async (message, detail) => {
      h.asked.push(message);
      h.details.push(detail);
      return h.answers.shift();
    },
  });
  h.deps = {
    services, jobs: h.jobs, confirmations,
    defaultWaitSeconds: 5,
    revealTerminal: 'never',
    permissionOf: tool => permissionForCategories(tool, h.confirmActions),
    kconfig: {} as HostDeps['kconfig'],
    extensionContext: {} as HostDeps['extensionContext'],
    folders: {} as HostDeps['folders'],
    refreshViews: async () => undefined,
    servedTools: () => new Set(TOOL_CATALOG.map(tool => tool.name)),
  };
  current = h;
  return h;
}

function ctx(h: Harness, instance = 'agent-1'): ToolContext<HostDeps> {
  return {
    signal: new AbortController().signal,
    progress: () => undefined,
    client: { name: 'test-agent', version: '1', instance },
    deps: h.deps,
    tool: findTool('hardware')!,
    startedAt: Date.now(),
    audit: {},
  };
}

const call = (h: Harness, args: Record<string, unknown>) => hardware({ action: 'flash', ...args }, ctx(h)) as Promise<any>;

async function errorOf(promise: Promise<unknown>): Promise<McpToolError> {
  try {
    await promise;
  } catch (error) {
    return error as McpToolError;
  }
  throw new Error('expected the call to fail');
}

/** A running serial capture, as serial_start leaves one, with a way to print device output into it. */
function startCapture(h: Harness, port: string, appPath?: string, board = BOARD): { capture: SerialCapture; job: JobState; print(text: string): void } {
  const key = port.toLowerCase();
  const capture = new SerialCapture({
    port, key, baud: 115200, portSource: 'argument', baudSource: 'default', durationSec: 600,
    ...(appPath ? { appPath, configName: 'primary', board } : {}),
  });
  let sink: { onData(text: string): void } | undefined;
  const { job } = h.jobs.start({
    kind: 'serial', lockKey: `serial:${key}`, requestKey: `serial:${key}:115200`, parse: false, command: `serial capture of ${port}`,
    run: given => {
      sink = given;
      return new Promise(resolve => {
        h.releases.push(() => {
          capture.state = 'closed';
          resolve({ exitCode: 0 });
        });
      });
    },
  });
  capture.attachJob(job.id, () => job.log.size);
  capture.state = 'open';
  serialCaptures.add(capture);
  return { capture, job, print: text => sink?.onData(text) };
}

describe('mcp/host/handlers/hardware (flash)', function () {
  this.timeout(20000);
  useUiGuard();

  const saved = { ...flashHost };
  const savedExecutions = vscodeStub.tasks.taskExecutions;

  beforeEach(() => {
    flashHost.buildTask = (_app, config, options) => {
      current.built.push(options);
      // The real argument composition of buildDirectTask, for a POSIX shell.
      const args = directTaskArgs(taskTemplate('West Flash')!, 'West Flash', config.boardIdentifier, options, {
        buildDirVar: '${BUILD_DIR}', expand: { shellKind: 'bash', isWindows: false },
      });
      return new vscode.Task(
        { type: 'zephyr-workbench', command: 'west', args, config: config.name },
        current.app.appWorkspaceFolder as never, `West Flash [${config.name}]`, 'Zephyr Workbench',
        new vscode.ShellExecution(`west ${args.join(' ')}`),
      );
    };
    flashHost.run = (async (task: vscode.Task, sink: { onData(text: string): void }) => {
      current.ran.push((task.execution as vscode.ShellExecution).commandLine as string);
      current.onRun?.(sink);
      await current.hold;
      sink.onData(current.output);
      return { exitCode: current.exitCode, started: true };
    }) as never;
    flashHost.zephyrVersion = () => current.version;
  });

  afterEach(async () => {
    Object.assign(flashHost, saved);
    vscodeStub.tasks.taskExecutions = savedExecutions;
    resetDebugSessionTrackingForTests();
    for (const release of current?.releases ?? []) {
      release();
    }
    for (const capture of serialCaptures.list()) {
      serialCaptures.delete(capture);
    }
    await Promise.all((current?.jobs.list() ?? []).map(job => job.done));
    if (current) {
      fs.rmSync(current.root, { recursive: true, force: true });
    }
  });

  describe('the command', () => {
    it('runs west flash with the board default runner, and never passes --board, which west reads as --board-dir', async () => {
      const h = harness();
      const result = await call(h, { dry_run: true });
      assert.equal(result.dry_run, true);
      assert.equal(result.runner, 'nrfjprog');
      assert.equal(result.runner_source, 'board_default');
      assert.match(result.command, /^west flash --runner nrfjprog --build-dir "\$\{BUILD_DIR\}"$/);
      assert.doesNotMatch(result.command, /--board/);
      assert.deepEqual(result.flags, { erase: false, rebuild: true });
    });

    it('takes the runner from the argument, else the configuration default, else the board', async () => {
      const h = harness();
      h.config.defaultRunner = 'jlink';
      const fromArgument = await call(h, { runner: 'pyocd', dry_run: true });
      assert.deepEqual([fromArgument.runner, fromArgument.runner_source], ['pyocd', 'argument']);
      const fromConfig = await call(h, { dry_run: true });
      assert.deepEqual([fromConfig.runner, fromConfig.runner_source], ['jlink', 'config_default']);
      h.config.defaultRunner = '';
      const fromBoard = await call(h, { dry_run: true });
      assert.deepEqual([fromBoard.runner, fromBoard.runner_source], ['nrfjprog', 'board_default']);
      assert.deepEqual(h.built.map(options => options.flashRunner), ['pyocd', 'jlink', 'nrfjprog']);
    });

    it('refuses a runner the build does not list, naming the ones it has', async () => {
      const h = harness();
      const error = await errorOf(call(h, { runner: 'stm32cubeprogrammer', dry_run: true }));
      assert.equal(error.code, 'RUNNER_UNKNOWN');
      assert.match(error.message, /runners\.yaml lists nrfjprog, nrfutil, jlink/);
      assert.deepEqual((error.details as { runners: string[] }).runners.slice(0, 3), ['nrfjprog', 'nrfutil', 'jlink']);
      assert.match(error.hint ?? '', /list_runners/);

      h.config.defaultRunner = 'stlink_gdbserver';
      const stored = await errorOf(call(h, { dry_run: true }));
      assert.equal(stored.code, 'RUNNER_UNKNOWN', 'a stored default the board does not support is refused too');
      assert.match(stored.message, /the default runner of "primary"/);
    });

    it('refuses with the list when nothing names a runner', async () => {
      const h = harness();
      fs.writeFileSync(path.join(h.buildDir, 'zephyr', 'runners.yaml'), 'runners:\n- jlink\n- pyocd\n');
      const error = await errorOf(call(h, { dry_run: true }));
      assert.equal(error.code, 'RUNNER_UNKNOWN');
      assert.deepEqual((error.details as { runners: string[] }).runners, ['jlink', 'pyocd']);
      assert.match(error.hint ?? '', /Pass runner/);
    });

    it('refuses a runner that is not a runner name before looking at anything', async () => {
      const h = harness();
      for (const runner of ['JLink', 'jlink;reboot', '../openocd', '']) {
        const error = await errorOf(call(h, { runner, dry_run: true }));
        assert.equal(error.code, 'INVALID_ARGUMENT', runner);
      }
      assert.deepEqual(h.built, []);
    });

    it('adds the stored runner arguments only with the configuration default runner, then the call\'s own', async () => {
      const h = harness();
      h.config.defaultRunner = 'jlink';
      h.config.customArgs = '--speed 4000';
      const stored = await call(h, { runner_args: '--reset-after-load', dry_run: true });
      assert.match(stored.command, /--build-dir "\$\{BUILD_DIR\}" --speed 4000 --reset-after-load$/);
      assert.equal(stored.flags.stored_runner_args, '--speed 4000');
      const sameAsDefault = await call(h, { runner: 'jlink', dry_run: true });
      assert.match(sameAsDefault.command, /--speed 4000$/, 'the default runner named by the call still gets its stored arguments');
      const other = await call(h, { runner: 'pyocd', runner_args: '--frequency 1000000', dry_run: true });
      assert.doesNotMatch(other.command, /--speed/);
      assert.match(other.command, /--frequency 1000000$/);
    });

    it('refuses dev_id, domain or rebuild false that the stored runner arguments would override', async () => {
      const h = harness();
      h.config.defaultRunner = 'jlink';
      for (const stored of ['--dev-id 111', '-i 111', '--dev-id=111', '--id 111']) {
        h.config.customArgs = stored;
        const error = await errorOf(call(h, { dev_id: '222', dry_run: true }));
        assert.equal(error.code, 'INVALID_ARGUMENT', stored);
        assert.match(error.message, /runner arguments stored in "primary" hold .*and the call gives dev_id too/, stored);
        assert.match(error.hint ?? '', /Leave dev_id out of the call, or change the runner arguments of "primary" with configure/);
      }
      h.config.customArgs = '--domain mcuboot';
      makeSysbuild(h);
      assert.match((await errorOf(call(h, { domain: 'app', dry_run: true }))).message, /the call gives domain too/);
      h.config.customArgs = '--no-rebuild';
      assert.match((await errorOf(call(h, { rebuild: false, dry_run: true }))).message, /the call gives rebuild too/);
      for (const stored of ['-rpyocd', '--runner pyocd', '--build-dir /tmp/other', '--context']) {
        h.config.customArgs = stored;
        const error = await errorOf(call(h, { domain: 'app', dry_run: true }));
        assert.match(error.message, /west would not flash what this call names/, stored);
      }
      h.config.customArgs = '--speed 4000';
      assert.match((await call(h, { dev_id: '222', dry_run: true })).command, /--dev-id 222 .*--speed 4000$/);
      assert.ok((await call(h, { runner: 'pyocd', dev_id: '222', dry_run: true })).dry_run, 'another runner does not get them');
    });

    it('locks and reports the probe the stored runner arguments pin, when the call names none', async () => {
      const h = harness();
      h.confirmActions = [];
      h.config.defaultRunner = 'jlink';
      h.config.customArgs = '--dev-id 111 --erase';
      const dry = await call(h, { dry_run: true });
      assert.equal(dry.flags.dev_id, '111');
      assert.equal(dry.flags.dev_id_source, 'stored_runner_args');
      assert.equal(dry.flags.erase, true, 'the stored --erase is reported');
      const result = await call(h, { rebuild: false });
      assert.equal((h.jobs.get(result.job_id) as JobState).spec.lockKey, 'flash:probe:111');
    });

    it('refuses shell operators and the options the action has an argument for in runner_args', async () => {
      const h = harness();
      for (const runnerArgs of ['--speed 4000; reboot', '--x $(id)', '--x `id`', '--x | tee', '--x > out']) {
        const error = await errorOf(call(h, { runner_args: runnerArgs, dry_run: true }));
        assert.equal(error.code, 'INVALID_ARGUMENT', runnerArgs);
      }
      for (const runnerArgs of ['--runner openocd', '--run openocd', '-r openocd', '-ropenocd', '--erase', '--dev-id 123', '-i 123',
        '--domain mcuboot', '--build-dir /tmp/x', '--skip-rebuild', '--no-rebuild', '--context', '-O -rpyocd x', '--snr 683']) {
        const error = await errorOf(call(h, { runner_args: runnerArgs, dry_run: true }));
        assert.equal(error.code, 'INVALID_ARGUMENT', runnerArgs);
        assert.match(error.message, /runner_args may not contain/, runnerArgs);
      }
      assert.deepEqual(h.built, []);
    });

    it('maps dev_id to the option each runner selects its probe with', async () => {
      const h = harness();
      const expected: Record<string, string> = {
        jlink: '--dev-id 000683456789', nrfjprog: '--dev-id 000683456789', pyocd: '--dev-id 000683456789',
        openocd: '--serial 000683456789', linkserver: '--probe 000683456789',
      };
      for (const [runner, flag] of Object.entries(expected)) {
        const result = await call(h, { runner, dev_id: '000683456789', dry_run: true });
        assert.ok(result.command.includes(flag), `${runner}: ${result.command}`);
        assert.equal(result.flags.dev_id_option, flag.split(' ')[0]);
        assert.equal(result.command.includes('adapter serial'), runner === 'openocd', runner);
      }
      // Most board cfgs never read the --serial of openocd, so the adapter is picked before init too.
      const openocd = await call(h, { runner: 'openocd', dev_id: '066DFF', dry_run: true });
      assert.match(openocd.command, /--serial 066DFF --cmd-pre-init "adapter serial 066DFF" --build-dir/);
      for (const devId of ['/dev/ttyACM0', 'a b', 'x;y', '', '-H', '-rpyocd', '--skip-rebuild', '-']) {
        const error = await errorOf(call(h, { dev_id: devId, dry_run: true }));
        assert.equal(error.code, 'INVALID_ARGUMENT', devId);
      }
      assert.deepEqual(h.jobs.list(), []);
      for (const devId of ['000683123456', '0240000034544e45', 'E6614103E7176A23', 'a-b.c:1']) {
        assert.ok((await call(h, { runner: 'jlink', dev_id: devId, dry_run: true })).dry_run, devId);
      }
    });

    it('keeps west from rebuilding with the flag the Zephyr version understands', async () => {
      const h = harness();
      h.version = { major: 4, minor: 3 };
      assert.match((await call(h, { rebuild: false, dry_run: true })).command, / --no-rebuild /);
      h.version = { major: 4, minor: 1 };
      assert.match((await call(h, { rebuild: false, dry_run: true })).command, / --skip-rebuild /);
      h.version = undefined;
      const unknown = await call(h, { rebuild: false, dry_run: true });
      assert.match(unknown.command, / --skip-rebuild /);
      assert.equal(unknown.flags.rebuild_flag, '--skip-rebuild');
      assert.doesNotMatch((await call(h, { dry_run: true })).command, /rebuild/, 'rebuild is west\'s own default');
    });

    it('refuses to flash a configuration that was never built, and one without a finished build when rebuild is false', async () => {
      const h = harness();
      fs.rmSync(path.join(h.buildDir, 'zephyr', 'zephyr.elf'));
      const noElf = await errorOf(call(h, { rebuild: false, dry_run: true }));
      assert.equal(noElf.code, 'NOT_BUILT');
      assert.equal((await call(h, { dry_run: true })).dry_run, true, 'west rebuilds a configured folder itself');
      fs.rmSync(path.join(h.buildDir, 'CMakeCache.txt'));
      const never = await errorOf(call(h, { dry_run: true }));
      assert.equal(never.code, 'NOT_BUILT');
      assert.match(never.hint ?? '', /build_app/);
    });

    it('passes --domain, reads that domain\'s runners.yaml, and refuses erase on a sysbuild build without domain', async () => {
      const h = harness();
      makeSysbuild(h, 'flash-runner: openocd\nrunners:\n- openocd\n');
      const erase = await errorOf(call(h, { erase: true, dry_run: true }));
      assert.equal(erase.code, 'INVALID_ARGUMENT');
      assert.match(erase.hint ?? '', /Pass domain/);
      assert.deepEqual((erase.details as { domains: string[] }).domains, ['app', 'mcuboot']);

      const app = await call(h, { domain: 'app', erase: true, dry_run: true });
      assert.match(app.command, /^west flash --runner nrfjprog --domain app --erase --build-dir /);
      const mcuboot = await call(h, { domain: 'mcuboot', dry_run: true });
      assert.equal(mcuboot.runner, 'openocd', 'the runner comes from the runners.yaml of the domain');
      const unknown = await errorOf(call(h, { domain: 'tfm', dry_run: true }));
      assert.equal(unknown.code, 'INVALID_ARGUMENT');
      assert.ok((await call(h, { dry_run: true })).dry_run, 'every image is flashed without erase');
    });

    it('refuses erase on a configuration set to sysbuild even before its domains.yaml exists', async () => {
      const h = harness();
      h.config.sysbuild = 'true';
      const error = await errorOf(call(h, { erase: true, dry_run: true }));
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.match(error.message, /needs domain/);
      h.config.sysbuild = 'false';
      assert.match((await call(h, { erase: true, dry_run: true })).command, / --erase /, 'a single image may be erased');
    });

    it('takes only the arguments of flash, and the serial actions refuse the flash ones', async () => {
      const h = harness();
      const port = await errorOf(call(h, { port: 'COM3', dry_run: true }));
      assert.equal(port.code, 'INVALID_ARGUMENT');
      assert.match(port.message, /does not take port/);
      const serial = await errorOf(hardware({ action: 'serial_read', runner: 'jlink' }, ctx(h)));
      assert.equal(serial.code, 'INVALID_ARGUMENT');
      const erase = await errorOf(call(h, { erase: 'yes', dry_run: true }));
      assert.equal(erase.code, 'INVALID_ARGUMENT');
    });
  });

  describe('asking and running', () => {
    it('asks nothing on a dry run and starts nothing', async () => {
      const h = harness();
      const result = await call(h, { dry_run: true });
      assert.equal(result.confirmation_required, true);
      assert.deepEqual(h.asked, []);
      assert.deepEqual(h.ran, []);
      assert.equal(h.jobs.list().length, 0);
      h.confirmActions = [];
      assert.equal((await call(h, { dry_run: true })).confirmation_required, false);
    });

    it('asks under Ask, then runs a flash job the user can watch, locked on the probe', async () => {
      const h = harness();
      h.answers.push('allow');
      const result = await call(h, { runner: 'jlink', dev_id: '683456789' });
      assert.equal(h.asked.length, 1);
      assert.match(h.asked[0], /wants to flash the board nrf52840dk\/nrf52840 with jlink \(west flash\)/);
      // The user approves the command that runs, not only our summary of it.
      assert.match(h.details[0], /\nCommand: .*west flash --runner jlink .*--dev-id 683456789/);
      assert.deepEqual(result.confirmation, { category: 'hardware', outcome: 'allowed' });
      assert.equal(result.kind, 'flash');
      assert.equal(result.status, 'succeeded');
      assert.equal(result.action, 'flash');
      assert.equal(result.runner, 'jlink');
      assert.deepEqual(result.result, { runner: 'jlink', runner_source: 'argument', dev_id: '683456789' });
      assert.equal(h.ran.length, 1);
      assert.match(h.ran[0], /--runner jlink --dev-id 683456789 --build-dir/);
      assert.match(result.log.tail, /Board reset\./);
      assert.match(result.next, /Flashed nrf52840dk\/nrf52840 with jlink\. To see it boot, start a capture with hardware/);
      const job = h.jobs.get(result.job_id) as JobState;
      assert.equal(job.spec.lockKey, 'flash:probe:683456789');
      assert.deepEqual(job.spec.writes, ['build_dir'], 'west rebuilds the folder first');
      assert.equal(job.spec.parse, true);
    });

    it('does not claim the build folder, nor parse compiler output, when rebuild is false', async () => {
      const h = harness();
      h.confirmActions = [];
      const result = await call(h, { rebuild: false });
      const job = h.jobs.get(result.job_id) as JobState;
      assert.equal(job.spec.writes, undefined);
      assert.equal(job.spec.parse, false);
      assert.equal(job.spec.lockKey, 'flash:probe:default');
      assert.equal(result.confirmation, undefined, 'nothing was asked under Allow');
      assert.deepEqual(h.asked, []);
    });

    it('does nothing when the user declines', async () => {
      const h = harness();
      h.answers.push(undefined);
      const error = await errorOf(call(h, {}));
      assert.equal(error.code, 'USER_DENIED');
      assert.deepEqual(h.ran, []);
      assert.equal(h.jobs.list().length, 0);
    });

    it('refuses before asking a command too long for the dialog to show whole, and flashes it when nobody is asked', async () => {
      const h = harness();
      const long = `--tool-opt=${'x'.repeat(2100)}`;
      const error = await errorOf(call(h, { runner_args: long }));
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.match(error.message, /too long to show whole in the confirmation dialog/);
      assert.equal(error.hint, 'Shorten runner_args.');
      assert.equal((await errorOf(call(h, { runner_args: long, dry_run: true }))).code, 'INVALID_ARGUMENT', 'a dry run says so too');
      assert.deepEqual([h.asked, h.ran], [[], []]);

      // Stored arguments are part of the same command, so the hint names them and their length.
      h.config.defaultRunner = 'jlink';
      h.config.customArgs = long;
      const stored = await errorOf(call(h, {}));
      assert.match(stored.hint ?? '', /stored in the configuration \(configure runner_args\): both are part of the command/);
      assert.equal(stored.details?.stored_runner_args_chars, long.length);
      h.config.defaultRunner = undefined;
      h.config.customArgs = undefined;

      h.confirmActions = [];
      const flashed = await call(h, { runner_args: long });
      assert.equal(flashed.status, 'succeeded');
      assert.ok(flashed.command.endsWith(long));
    });

    it('scopes Allow for This Session to flashing this application, never to a serial send', async () => {
      const h = harness();
      h.answers.push('session');
      assert.equal((await call(h, {})).confirmation.outcome, 'allowed-session');
      const again = await call(h, { erase: true });
      assert.equal(again.confirmation.outcome, 'remembered', 'another flash of the application is covered');
      assert.equal(h.asked.length, 1);
      assert.match(h.details[0], /Allow for This Session stops asking this agent before flashing this application until the MCP server restarts\./);
      assert.doesNotMatch(h.details[0], /serial send/, 'the dialog promises only what the grant covers');

      h.answers.push('allow');
      const sendCtx = ctx(h);
      const outcome = await h.deps.confirmations.require(sendCtx, { action: 'serial_send' }, {
        summary: 'send "reboot" to the board on COM7', scope: 'serial:com7', scopeLabel: 'this serial port',
      });
      assert.equal(outcome, 'allowed');
      assert.equal(h.asked.length, 2, 'the flash approval does not cover a serial send');

      const other = makeApp(h.root, 'other');
      h.deps.services.listApplications = async () => [h.app, other.app] as never;
      h.answers.push('allow');
      await call(h, { app_path: other.appRoot });
      assert.equal(h.asked.length, 3, 'nor a flash of another application');
    });

    it('joins the identical flash already running without asking again, and refuses another one on the same probe', async () => {
      const h = harness();
      h.confirmActions = [];
      let release: () => void = () => undefined;
      h.hold = new Promise(resolve => { release = resolve; });
      const first = await call(h, { rebuild: false, wait_sec: 0 });
      assert.equal(first.status, 'running');
      const same = await call(h, { rebuild: false, wait_sec: 0 });
      assert.equal(same.job_id, first.job_id);
      assert.equal(same.attached, true);

      const busy = await errorOf(call(h, { rebuild: false, erase: true, wait_sec: 0 }));
      assert.equal(busy.code, 'BUSY');
      assert.match(busy.message, /A flash through the default probe is already running with nrfjprog/);
      assert.match(busy.hint ?? '', /pass dev_id/);

      // Another board, through its own probe: no lock is shared and neither writes the build folder.
      const other = await call(h, { rebuild: false, dev_id: '1234', wait_sec: 0 });
      assert.notEqual(other.job_id, first.job_id);
      const rebuilding = await errorOf(call(h, { dev_id: '5678', wait_sec: 0 }));
      assert.equal(rebuilding.code, 'BUSY', 'a flash that rebuilds writes the folder the others read');
      assert.match(rebuilding.message, /build folder of primary/);
      release();
      await (h.jobs.get(first.job_id) as JobState).done;
    });

    it('treats a probe as one whichever runner drives it', async () => {
      const h = harness();
      h.confirmActions = [];
      const other = makeApp(h.root, 'other');
      h.deps.services.listApplications = async () => [h.app, other.app] as never;
      let release: () => void = () => undefined;
      h.hold = new Promise(resolve => { release = resolve; });
      const first = await call(h, { app_path: h.appRoot, rebuild: false, wait_sec: 0 });
      assert.equal(first.status, 'running');

      // nrfjprog and jlink both drive the J-Link OB of an nRF DK.
      const busy = await errorOf(call(h, { app_path: other.appRoot, runner: 'jlink', rebuild: false, wait_sec: 0 }));
      assert.equal(busy.code, 'BUSY');
      assert.match(busy.message, /default probe is already running with nrfjprog \(job_id "/);

      const pinned = await call(h, { app_path: h.appRoot, runner: 'jlink', dev_id: '683', rebuild: false, wait_sec: 0 });
      assert.equal(pinned.status, 'running');
      const samePinned = await errorOf(call(h, { app_path: other.appRoot, runner: 'nrfjprog', dev_id: '683', rebuild: false, wait_sec: 0 }));
      assert.equal(samePinned.code, 'BUSY');
      assert.match(samePinned.message, /the probe 683 is already running with jlink/);

      const another = await call(h, { app_path: other.appRoot, runner: 'pyocd', dev_id: '999', rebuild: false, wait_sec: 0 });
      assert.equal(another.status, 'running', 'another probe still flashes in parallel');
      release();
      await Promise.all(h.jobs.list().map(job => job.done));
    });
  });

  describe('conflicts', () => {
    it('refuses while a Workbench debug session of the configuration runs, pointing at debug_app stop', async () => {
      const h = harness();
      trackDebugSessionForTests({
        id: 'session-1', type: 'cppdbg', name: 'Zephyr Workbench Debug [primary]',
        configuration: { name: 'Zephyr Workbench Debug [primary]' },
        workspaceFolder: { uri: { fsPath: h.appRoot } },
      } as unknown as vscode.DebugSession);
      const error = await errorOf(call(h, { dry_run: true }));
      assert.equal(error.code, 'BUSY');
      assert.match(error.message, /debug session of primary/);
      assert.match(error.hint ?? '', /debug_app \{"action":"stop"/);
      assert.deepEqual(h.asked, []);

      // Another configuration of the application on the same board: its gdb server holds the same probe.
      resetDebugSessionTrackingForTests();
      const secondary = { ...h.config, name: 'secondary', active: false };
      (h.app.buildConfigs as FakeConfig[]).push(secondary);
      trackDebugSessionForTests({
        id: 'session-2', type: 'cppdbg', name: 'Zephyr Workbench Debug [secondary]',
        configuration: { name: 'Zephyr Workbench Debug [secondary]' },
        workspaceFolder: { uri: { fsPath: h.appRoot } },
      } as unknown as vscode.DebugSession);
      const sameBoard = await errorOf(call(h, { dry_run: true }));
      assert.equal(sameBoard.code, 'BUSY');
      assert.match(sameBoard.message, /debug session of secondary is running/);
      assert.match(sameBoard.hint ?? '', /"config_name":"secondary"/);

      secondary.boardIdentifier = 'frdm_mcxn947/mcxn947/cpu0';
      assert.equal((await call(h, { dry_run: true })).dry_run, true, 'a session of a configuration on another board is not on this probe');

      // An application of the window that is not in the list: its session is not known to be on this board.
      resetDebugSessionTrackingForTests();
      trackDebugSessionForTests({
        id: 'session-3', type: 'cppdbg', name: 'Zephyr Workbench Debug [primary]',
        configuration: { name: 'Zephyr Workbench Debug [primary]' },
        workspaceFolder: { uri: { fsPath: path.join(h.root, 'unknown') } },
      } as unknown as vscode.DebugSession);
      assert.equal((await call(h, { dry_run: true })).dry_run, true);
    });

    it('refuses while another application on the same board is debugged', async () => {
      const h = harness();
      const other = makeApp(h.root, 'other');
      h.deps.services.listApplications = async () => [h.app, other.app] as never;
      trackDebugSessionForTests({
        id: 'session-o', type: 'cortex-debug', name: 'Zephyr Workbench Debug [primary]',
        configuration: { name: 'Zephyr Workbench Debug [primary]' },
        workspaceFolder: { uri: { fsPath: other.appRoot } },
      } as unknown as vscode.DebugSession);
      const error = await errorOf(call(h, { app_path: h.appRoot, dry_run: true }));
      assert.equal(error.code, 'BUSY');
      assert.match(error.message, /debug session of primary of other is running/);
      assert.ok((error.hint ?? '').includes(JSON.stringify({ action: 'stop', app_path: other.appRoot, config_name: 'primary' })));

      other.config.boardIdentifier = 'frdm_mcxn947/mcxn947/cpu0';
      assert.equal((await call(h, { app_path: h.appRoot, dry_run: true })).dry_run, true, 'nor one on another board');
    });

    it('refuses while a session launched from a legacy freestanding-named entry of its west workspace runs', async () => {
      const h = harness();
      // The application seen as one of a west workspace at the folder above.
      const app = h.app as unknown as { isWestWorkspaceApplication: boolean; appWorkspaceFolder: unknown };
      app.isWestWorkspaceApplication = true;
      app.appWorkspaceFolder = { uri: { fsPath: h.root }, name: 'ws', index: 0 };
      trackDebugSessionForTests({
        id: 'session-legacy', type: 'cppdbg', name: 'Zephyr Workbench Debug [primary]',
        configuration: { name: 'Zephyr Workbench Debug [primary]' },
        workspaceFolder: { uri: { fsPath: h.root } },
      } as unknown as vscode.DebugSession);
      const error = await errorOf(call(h, { dry_run: true }));
      assert.equal(error.code, 'BUSY');
      assert.match(error.message, /debug session of primary is running \("Zephyr Workbench Debug \[primary\]"\)/);
      assert.deepEqual(h.asked, []);
    });

    it('refuses a runner that flashes through a serial port while a capture holds one', async () => {
      const h = harness();
      const { job } = startCapture(h, 'COM7');
      const error = await errorOf(call(h, { runner: 'esp32', dry_run: true }));
      assert.equal(error.code, 'BUSY');
      assert.match(error.message, /esp32 runner flashes through a serial port/);
      assert.match(error.hint ?? '', new RegExp(`"action": "serial_stop", "job_id": "${job.id.replace(/[.]/g, '\\.')}"`));
      assert.match(error.hint ?? '', /serial_start/);
      assert.equal((await call(h, { runner: 'jlink', dry_run: true })).dry_run, true, 'a probe runner leaves the port alone');
    });

    it('refuses while the user runs a task on the configuration, or an agent deletes its build folder', async () => {
      const h = harness();
      vscodeStub.tasks.taskExecutions = [{
        task: {
          name: 'West Flash [primary]',
          definition: { type: 'zephyr-workbench', config: 'primary', __appRootPath: h.appRoot },
          scope: h.app.appWorkspaceFolder,
          group: undefined,
        },
      }];
      const external = await errorOf(call(h, { dry_run: true }));
      assert.equal(external.code, 'BUSY_EXTERNAL');
      vscodeStub.tasks.taskExecutions = [];

      let release: () => void = () => undefined;
      const { job } = h.jobs.start({
        kind: 'clean', lockKey: path.join(h.appRoot, 'build'), requestKey: 'clean', appPath: h.appRoot,
        buildDir: path.join(h.appRoot, 'build'), command: 'delete',
        run: () => new Promise(resolve => { release = () => resolve({ exitCode: 0 }); }),
      });
      const deleting = await errorOf(call(h, { dry_run: true }));
      assert.equal(deleting.code, 'BUSY');
      assert.match(deleting.message, /being deleted/);
      release();
      await job.done;
    });

    it('checks again after the user answered, since the dialog may stay open a while', async () => {
      const h = harness();
      h.answers.push('allow');
      const confirmations = h.deps.confirmations;
      const require = confirmations.require.bind(confirmations);
      confirmations.require = (async (...args: Parameters<typeof require>) => {
        const outcome = await require(...args);
        // The user started a debug session while the dialog was open.
        trackDebugSessionForTests({
          id: 'late', type: 'cortex-debug', name: 'Zephyr Workbench Debug [primary]',
          configuration: { name: 'Zephyr Workbench Debug [primary]' },
          workspaceFolder: { uri: { fsPath: h.appRoot } },
        } as unknown as vscode.DebugSession);
        return outcome;
      }) as typeof confirmations.require;
      const error = await errorOf(call(h, {}));
      assert.equal(error.code, 'BUSY');
      assert.deepEqual(h.ran, []);
    });
  });

  describe('after the flash', () => {
    it('waits for a boot line in the capture of the application, reading only what came after the flash', async () => {
      const h = harness();
      h.confirmActions = [];
      const { print, job } = startCapture(h, 'COM7', h.appRoot);
      print('*** Booting Zephyr OS build v4.1.0 ***\r\nold firmware\r\n');
      h.onRun = () => print('*** Booting Zephyr OS build v4.1.0 ***\r\nHello World! nrf52840dk\r\n');
      const result = await call(h, { wait_for: 'hello world*', wait_sec: 5 });
      assert.equal(result.status, 'succeeded');
      assert.equal(result.serial.job_id, job.id);
      assert.equal(result.serial.port, 'COM7');
      assert.equal(result.serial.matched, true);
      assert.equal(result.serial.line, 'Hello World! nrf52840dk');
      assert.doesNotMatch(result.serial.text, /old firmware/);
      assert.match(result.serial.text, /Hello World!/);
      assert.ok(result.serial.offset > 0, 'the output from before the flash is skipped');
      assert.match(result.next, /printed the line you waited for/);
    });

    it('never takes a line the old image printed while west rebuilt, for one the new image printed', async () => {
      const h = harness();
      h.confirmActions = [];
      const { print } = startCapture(h, 'COM7', h.appRoot);
      print('*** Booting Zephyr OS build v4.1.0 ***\r\nHello World! old 1\r\n');
      h.output = 'Board reset.\n';
      h.onRun = sink => {
        sink.onData('-- west flash: rebuilding\nninja: no work to do.\n');
        print('Hello World! old 2\r\n');
        // Colored as west prints it in a terminal, and split across two chunks.
        sink.onData('\x1b[1;32m-- west flash: using run');
        sink.onData('ner nrfjprog\x1b[0m\n-- runners.nrfjprog: Flashing file: zephyr.hex\n');
        print('*** Booting Zephyr OS build v4.1.0 ***\r\nHello World! new\r\n');
      };
      const result = await call(h, { wait_for: 'hello world*', wait_sec: 5 });
      assert.equal(result.serial.matched, true);
      assert.equal(result.serial.line, 'Hello World! new');
      assert.doesNotMatch(result.serial.text, /old/);
    });

    it('does not wait on the capture of another application on another board', async () => {
      const h = harness();
      h.confirmActions = [];
      const other = makeApp(h.root, 'other');
      const { job } = startCapture(h, 'COM9', other.appRoot, 'frdm_mcxn947/mcxn947/cpu0');
      const started = Date.now();
      const result = await call(h, { wait_for: 'Booting Zephyr', wait_sec: 10 });
      assert.ok(Date.now() - started < 5000, 'nothing is waited for');
      assert.equal(result.serial.waited, false);
      assert.match(result.serial.reason, /of another application on another board \(frdm_mcxn947/);
      assert.equal(result.serial.captures[0].job_id, job.id);
      assert.match(result.next, /serial_read/);

      const plain = await call(h, {});
      assert.match(plain.next, /start a capture with hardware \{"action":"serial_start"/, 'the success hint does not point at it either');
    });

    it('waits on the capture of another application on the same board', async () => {
      const h = harness();
      h.confirmActions = [];
      const other = makeApp(h.root, 'other');
      const { print, job } = startCapture(h, 'COM7', other.appRoot, 'nrf52840dk/nrf52840');
      h.onRun = () => print('*** Booting Zephyr OS build v4.1.0 ***\r\n');
      const result = await call(h, { wait_for: 'Booting Zephyr', wait_sec: 5 });
      assert.equal(result.serial.job_id, job.id);
      assert.equal(result.serial.matched, true);
    });

    it('says when no capture runs, and how to start one before flashing', async () => {
      const h = harness();
      h.confirmActions = [];
      const result = await call(h, { wait_for: 'Booting Zephyr', wait_sec: 2 });
      assert.equal(result.status, 'succeeded');
      assert.equal(result.serial.waited, false);
      assert.match(result.serial.reason, /No serial capture is running/);
      assert.match(result.next, /"action":"serial_start"/);
    });

    it('reports a line that never came within wait_sec', async () => {
      const h = harness();
      h.confirmActions = [];
      startCapture(h, 'COM7', h.appRoot);
      const result = await call(h, { wait_for: 'never printed', wait_sec: 1 });
      assert.equal(result.serial.matched, false);
      assert.match(result.next, /no line matched within wait_sec/);
    });

    it('turns the usual failures into the next call to make', async () => {
      const h = harness();
      h.confirmActions = [];
      h.exitCode = 1;
      const cases: Array<[string, RegExp]> = [
        ['FATAL ERROR: required program nrfjprog not found; install it or add its location to PATH\n', /manage_runners.*list_runners/],
        ['FATAL ERROR: refusing to guess which of 2 connected boards to use. (Interactive prompts disabled since standard input is not a terminal.)\n', /Pass dev_id.*list_ports/],
        ['FATAL ERROR: nrfjprog doesn\'t support --erase option\n', /does not support --erase\. Flash again without erase/],
      ];
      // West rebuilds by default, and its runner failures are FATAL ERROR lines as well.
      for (const args of [{}, { rebuild: false }]) {
        for (const [output, next] of cases) {
          h.output = `-- west flash: rebuilding\nninja: no work to do.\n-- west flash: using runner nrfjprog\n${output}`;
          const result = await call(h, args);
          assert.equal(result.status, 'failed');
          assert.match(result.next, next, `${JSON.stringify(args)} ${output}`);
        }
        h.output = 'something else went wrong\n';
        const generic = await call(h, args);
        assert.match(generic.next, /The flash failed with exit code 1\. Read the whole log with job/);
      }
    });

    it('says the rebuild failed only when it did', async () => {
      const h = harness();
      h.confirmActions = [];
      h.exitCode = 1;
      h.output = '-- west flash: rebuilding\n../src/main.c:3:1: error: expected \';\' before \'}\' token\nFAILED: zephyr/zephyr.elf\n'
        + `FATAL ERROR: re-build in ${h.buildDir} failed\n`;
      const failed = await call(h, {});
      assert.match(failed.next, /the build failed\. Fix the errors in diagnostics/);
      assert.ok(failed.diagnostics.errors > 0);
      h.output = '-- west flash: rebuilding\n../src/main.c:3:1: error: expected \';\'\nninja: build stopped: subcommand failed.\n';
      assert.match((await call(h, {})).next, /the build failed/, 'a compiler error says so without the re-build line too');
    });
  });
});

describe('mcp/core/flashArgs', () => {
  it('picks the rebuild flag by Zephyr version', () => {
    assert.equal(noRebuildFlag({ major: 4, minor: 4 }), '--no-rebuild');
    assert.equal(noRebuildFlag({ major: 5, minor: 0 }), '--no-rebuild');
    assert.equal(noRebuildFlag({ major: 4, minor: 2 }), '--skip-rebuild');
    assert.equal(noRebuildFlag({ major: 3, minor: 7 }), '--skip-rebuild');
    assert.equal(noRebuildFlag(undefined), '--skip-rebuild');
  });

  it('names the probe option of each runner', () => {
    assert.equal(devIdOption('jlink'), '--dev-id');
    assert.equal(devIdOption('stm32cubeprogrammer'), '--dev-id');
    assert.equal(devIdOption('openocd'), '--serial');
    assert.equal(devIdOption('linkserver'), '--probe');
  });

  it('splits runner arguments on spaces outside quotes', () => {
    assert.deepEqual(splitWords(' --a  "b c" --d=\'e f\' '), ['--a', 'b c', '--d=e f']);
    assert.deepEqual(splitWords('""'), ['']);
  });

  it('accepts ordinary runner options, including a tool option that looks like a reserved one', () => {
    assert.equal(checkRunnerArgs('--speed 4000 --reset-after-load', 'jlink'), '--speed 4000 --reset-after-load');
    assert.equal(checkRunnerArgs('-O --erase-all --tool-opt=--speed', 'pyocd'), '-O --erase-all --tool-opt=--speed');
    assert.equal(checkRunnerArgs('--esp-device COM3', 'esp32'), '--esp-device COM3');
    assert.throws(() => checkRunnerArgs('--serial 123', 'openocd'), /may not contain --serial/);
    assert.equal(checkRunnerArgs('--serial 123', 'jlink'), '--serial 123', '--serial is only openocd\'s probe option');
    assert.equal(checkRunnerArgs('-O x --tool-opt=-rpyocd', 'jlink'), '-O x --tool-opt=-rpyocd', 'west hands --tool-opt=... to the runner whole');
  });

  it('checks the word after -O and --tool-opt too, which west itself parses', () => {
    const cases: Array<[string, RegExp]> = [
      ['-O -rpyocd x', /\(--runner\)/], ['-O --runner=pyocd x', /\(--runner\)/], ['--tool-opt --run=pyocd x', /\(--runner\)/],
      ['-O -d/tmp/other x', /\(--build-dir\)/], ['-O --domain=mcuboot x', /\(--domain\)/], ['-O -H', /\(--context\)/],
      ['-O --dev-id=1', /\(--dev-id\)/],
    ];
    for (const [value, taken] of cases) {
      assert.throws(() => checkRunnerArgs(value, 'jlink'), taken, value);
    }
  });

  it('refuses the options of each runner that set its dev_id, and only those', () => {
    const cases: Array<[string, string]> = [
      ['--id 683', 'jlink'], ['--id=683', 'jlink'], ['--board-id 683', 'pyocd'], ['--snr 683', 'nrfjprog'], ['--snr 683', 'nrfutil'],
      ['--pid 1', 'rtsflash'], ['--node-id 5', 'canopen'], ['--cmd-pre-init "adapter serial 1"', 'openocd'],
    ];
    for (const [value, runner] of cases) {
      assert.throws(() => checkRunnerArgs(value, runner),
        (error: McpToolError) => /may not contain/.test(error.message) && /^Pass dev_id instead/.test(error.hint ?? ''), `${runner} ${value}`);
    }
    assert.equal(checkRunnerArgs('--board-id X', 'uf2'), '--board-id X', 'uf2 reads --board-id as its board, not a probe');
    assert.equal(checkRunnerArgs('--id 1', 'openocd'), '--id 1');
    assert.equal(checkRunnerArgs('--cmd-pre-init "adapter speed 4000"', 'openocd'), '--cmd-pre-init "adapter speed 4000"');
  });

  it('finds the probe the stored runner arguments select', () => {
    assert.deepEqual(reservedRunnerOptions('--speed 4000 --dev-id 111', 'jlink'), [{ word: '--dev-id', taken: '--dev-id', value: '111' }]);
    assert.deepEqual(reservedRunnerOptions('-i111', 'jlink'), [{ word: '-i111', taken: '--dev-id', value: '111' }]);
    assert.deepEqual(reservedRunnerOptions('--snr=5', 'nrfjprog'), [{ word: '--snr=5', taken: '--snr', value: '5' }]);
    assert.deepEqual(reservedRunnerOptions('--erase', 'jlink'), [{ word: '--erase', taken: '--erase' }]);
  });

  it('selects the probe of openocd with adapter serial too, and of the others with their own option', () => {
    assert.deepEqual(devIdArgs('openocd', 'ABC'), ['--serial ABC', '--cmd-pre-init "adapter serial ABC"']);
    assert.deepEqual(devIdArgs('linkserver', 'ABC'), ['--probe ABC']);
    assert.deepEqual(devIdArgs('jlink', 'ABC'), ['--dev-id ABC']);
  });

  it('reads the common failures of west flash', () => {
    const missing = flashFailureHint("FileNotFoundError: [Errno 2] No such file or directory: 'JLinkExe'", { runner: 'jlink', erase: false });
    assert.match(missing ?? '', /\(JLinkExe\) is not installed/);
    assert.match(flashFailureHint('/bin/sh: 1: nrfutil: not found', { runner: 'nrfutil', erase: false }) ?? '', /\(nrfutil\)/);
    assert.match(flashFailureHint("'STM32_Programmer_CLI' is not recognized as an internal or external command", { runner: 'stm32cubeprogrammer', erase: false }) ?? '', /STM32_Programmer_CLI/);
    assert.match(flashFailureHint('Error: More than a single probe detected. Use the --probe argument', { runner: 'probe_rs', erase: false }) ?? '', /Pass dev_id/);
    assert.match(flashFailureHint('refusing to guess', { runner: 'nrfutil', erase: false, devId: '12' }) ?? '', /did not take dev_id "12"/);
    assert.match(flashFailureHint("uf2 doesn't support --dev-id option", { runner: 'uf2', erase: false, devId: '1' }) ?? '', /without dev_id/);
    assert.match(flashFailureHint('Error: No connected debug probes', { runner: 'pyocd', erase: false }) ?? '', /No probe was found/);
    assert.equal(flashFailureHint('all went well', { runner: 'jlink', erase: false }), undefined);
  });
});
