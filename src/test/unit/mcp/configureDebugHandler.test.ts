// configure_debug and remove_or_delete what "debug_config" on the host side:
// the real handlers, confirmation gate, job manager and debug setup, on a
// freestanding application whose builds are on disk. Only the application
// list, the runner tool status, pyOCD's answer and the installed extensions
// are stood in for; no board, west, pyOCD or VS Code task ever runs.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { WestCommandError } from '../../../commands/WestCommands';
import { findTool, TOOL_CATALOG } from '../../../mcp/core/catalog';
import { McpToolError } from '../../../mcp/core/errors';
import { ConfirmCategory, permissionForCategories, ToolContext } from '../../../mcp/core/toolSpec';
import { AskAnswer, Confirmations } from '../../../mcp/host/confirmations';
import { configureDebug, debugRunnerNames, removeDebugConfig } from '../../../mcp/host/handlers/configureDebug';
import { HostDeps } from '../../../mcp/host/handlers/deps';
import { removeOrDelete } from '../../../mcp/host/handlers/removals';
import { HostServices } from '../../../mcp/host/services';
import { JobManager } from '../../../mcp/jobs/jobManager';
import { DebugToolStatus } from '../../../utils/debugTools/debugToolStatusUtils';
import { DebugFixture, makeDebugFixture, BuildOptions } from '../debugTestFixture';
import { useUiGuard } from './uiGuard';

const vscodeStub = require('vscode') as Record<string, any>;
const execUtils = require('../../../utils/execUtils') as Record<string, unknown>;

const PROGRAM = '${workspaceFolder}/build/primary/zephyr/zephyr.elf';
const PRIMARY = 'Zephyr Workbench Debug [primary]';
const wrapperName = process.platform === 'win32' ? 'west_wrapper.bat' : 'west_wrapper.sh';

const MANIFEST = {
  debug_tools: [
    { tool: 'jlink', name: 'J-Link', runners: ['jlink'] },
    { tool: 'openocd-zephyr', name: 'OpenOCD', runners: ['openocd'] },
    { tool: 'pyocd', name: 'pyOCD', runners: ['pyocd'] },
  ],
};

interface Harness {
  f: DebugFixture;
  deps: HostDeps;
  jobs: JobManager;
  services: HostServices;
  asked: string[];
  answers: AskAnswer[];
  confirmActions: ConfirmCategory[];
  /** Installed state per manifest tool id, for the runner tool warning. */
  tools: Record<string, boolean | null>;
  /** pyOCD's answer: installed, not installed, or a failure to run. */
  pyocd: boolean | Error;
  cortexDebug: boolean;
  /** Runs while the dialog is open, as the user could. */
  onAsk?: () => void;
  tasksStarted: number;
}

let h: Harness;

function harness(options: { primary?: BuildOptions; withSysbuild?: boolean; builtPrimary?: boolean } = {}): Harness {
  const f = makeDebugFixture(options);
  const services = new HostServices(vscode.Uri.file(os.tmpdir()));
  services.listApplications = async () => [f.app()];
  services.knownRoots = async () => [f.root];
  services.debugToolsManifest = () => MANIFEST as never;
  services.debugToolsStatus = async (_depth, opts = {}) => (opts.toolIds ?? []).map(id => ({
    id, isAlias: false, installableHere: true, updateAvailable: false, installed: h.tools[id] ?? true,
  }) as DebugToolStatus);
  const jobs = new JobManager({ logPathFor: id => path.join(f.root, `${id}.log`) });
  const state = {
    f, jobs, services, asked: [], answers: [], confirmActions: [], tools: {}, pyocd: true, cortexDebug: false, tasksStarted: 0,
  } as unknown as Harness;
  state.deps = {
    services, jobs,
    confirmations: new Confirmations({
      permission: tool => permissionForCategories(tool, state.confirmActions),
      waitMs: () => 2000,
      log: { recordConfirmation: () => undefined },
      ask: async message => {
        state.asked.push(message);
        state.onAsk?.();
        return state.answers.shift();
      },
    }),
    defaultWaitSeconds: 5,
    revealTerminal: 'never',
    permissionOf: tool => permissionForCategories(tool, state.confirmActions),
    kconfig: {} as HostDeps['kconfig'],
    extensionContext: {} as HostDeps['extensionContext'],
    folders: {} as HostDeps['folders'],
    refreshViews: async () => undefined,
    servedTools: () => new Set(TOOL_CATALOG.map(tool => tool.name)),
  };
  h = state;
  return state;
}

function ctx(tool: string): ToolContext<HostDeps> {
  return {
    signal: new AbortController().signal,
    progress: () => undefined,
    client: { name: 'test-agent', version: '1', instance: 'agent-1' },
    deps: h.deps,
    tool: findTool(tool)!,
    startedAt: Date.now(),
    audit: {},
  };
}

const call = (args: Record<string, unknown>) => configureDebug(args, ctx('configure_debug')) as Promise<any>;
const remove = (args: Record<string, unknown>) => removeOrDelete({ what: 'debug_config', ...args }, ctx('remove_or_delete')) as Promise<any>;

async function errorOf(promise: Promise<unknown>): Promise<McpToolError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof McpToolError, `expected an McpToolError, got ${String(error)}`);
    return error;
  }
  throw new Error('expected the call to fail');
}

const debugDir = (config = 'primary') => path.join(h.f.appRoot, 'build', config, '.debug');

describe('configure_debug', () => {
  useUiGuard();

  const saved: Record<string, unknown> = {};
  beforeEach(() => {
    saved.checkPyOCDTarget = execUtils.checkPyOCDTarget;
    saved.getExtension = vscodeStub.extensions.getExtension;
    saved.executeTask = vscodeStub.tasks.executeTask;
    execUtils.checkPyOCDTarget = async () => {
      if (h.pyocd instanceof Error) {
        throw h.pyocd;
      }
      return h.pyocd;
    };
    vscodeStub.extensions.getExtension = (id: string) => (id === 'marus25.cortex-debug' && h.cortexDebug ? { id } : undefined);
    vscodeStub.tasks.executeTask = async () => {
      h.tasksStarted++;
      throw new Error('no task may start');
    };
  });
  afterEach(() => {
    execUtils.checkPyOCDTarget = saved.checkPyOCDTarget;
    vscodeStub.extensions.getExtension = saved.getExtension;
    vscodeStub.tasks.executeTask = saved.executeTask;
    h?.f.restore();
  });

  describe('routing', () => {
    it('refuses an unknown action and an argument another action takes', async () => {
      harness();
      assert.equal((await errorOf(call({ action: 'delete' }))).code, 'INVALID_ARGUMENT');
      const misplaced = await errorOf(call({ action: 'list', runner: 'jlink' }));
      assert.equal(misplaced.code, 'INVALID_ARGUMENT');
      assert.match(misplaced.message, /does not take runner/);
      assert.equal((await errorOf(call({ action: 'get', dry_run: true }))).code, 'INVALID_ARGUMENT');
    });

    it('accepts only the Debug Manager runners, without the emulator', () => {
      assert.deepEqual(debugRunnerNames(), ['openocd', 'linkserver', 'jlink', 'pyocd', 'stlink_gdbserver']);
    });
  });

  describe('apply', () => {
    it('writes the Debug Manager defaults of a built configuration', async () => {
      harness();
      const result = await call({ action: 'apply' });
      assert.equal(result.name, PRIMARY);
      assert.equal(result.backend, 'cppdbg');
      // The debug-runner of runners.yaml.
      assert.equal(result.runner, 'jlink');
      assert.equal(result.created, true);
      assert.equal(result.config_name, 'primary');
      assert.equal(result.domain, undefined);
      assert.equal(result.launch_json, h.f.launchJsonPath);
      assert.deepEqual(result.files_written, [path.join(debugDir(), wrapperName), h.f.launchJsonPath]);
      assert.equal(result.entry.program, PROGRAM);
      assert.equal(result.entry.miDebuggerPath, h.f.gdb);
      assert.equal(result.fields.gdb_port, 3333);
      assert.equal(result.fields.mode, 'program');
      assert.match(result.entry.debugServerArgs, /--runner jlink --gdb-port 3333$/);
      assert.deepEqual(result.warnings, []);
      assert.equal(result.confirmation, undefined);
      assert.match(result.next, /debug_app with action "start" and name "Zephyr Workbench Debug \[primary\]"/);
      assert.deepEqual(h.f.readLaunchJson().configurations, [result.entry]);
      assert.ok(fs.readFileSync(path.join(debugDir(), wrapperName), 'utf8').includes('PYTHON_VENV_PATH'));
      assert.equal(h.tasksStarted, 0);
    });

    it('starts from the stored entry and puts the arguments on top', async () => {
      harness();
      await call({ action: 'apply', runner: 'openocd', gdb_port: 4444, mode: 'attach', runner_args: '--cmd-pre-init "adapter speed 1000"' });
      const again = await call({ action: 'apply', gdb_port: 5555 });
      assert.equal(again.created, false);
      assert.equal(again.runner, 'openocd');
      assert.equal(again.fields.gdb_port, 5555);
      assert.equal(again.fields.mode, 'attach');
      assert.equal(again.fields.runner_args, '--cmd-pre-init "adapter speed 1000"');
      assert.deepEqual(again.files_written, [path.join(debugDir(), wrapperName), path.join(debugDir(), 'gdb.cfg'), h.f.launchJsonPath]);
      // An empty string clears the arguments; another runner starts from its own defaults.
      const cleared = await call({ action: 'apply', runner_args: '' });
      assert.equal(cleared.fields.runner_args, undefined);
      const other = await call({ action: 'apply', runner: 'jlink' });
      assert.equal(other.fields.gdb_port, 3333);
      assert.equal(other.fields.mode, 'attach');
      assert.equal(h.f.readLaunchJson().configurations.length, 1);
    });

    it('keeps the runner arguments, path and port across cppdbg and cortex-west, which run the same west debugserver', async () => {
      harness();
      h.cortexDebug = true;
      await call({ action: 'apply', runner: 'openocd', runner_args: '--serial ABC123', gdb_port: 4444, runner_path: h.f.gdb });
      for (const backend of ['cortex-west', 'cppdbg']) {
        const switched = await call({ action: 'apply', backend });
        assert.equal(switched.backend, backend);
        assert.equal(switched.runner, 'openocd');
        assert.equal(switched.fields.runner_args, '--serial ABC123', backend);
        assert.equal(switched.fields.gdb_port, 4444, backend);
        assert.equal(switched.fields.runner_path, h.f.gdb, backend);
        assert.match(switched.entry.debugServerArgs, /--serial ABC123/);
        assert.match(switched.entry.debugServerArgs, /--gdb-port 4444/);
        assert.ok(!switched.warnings.some((w: string) => /not kept/.test(w)), backend);
      }
    });

    it('says which runner values a switch to or from cortex-native does not keep', async () => {
      harness();
      h.cortexDebug = true;
      await call({ action: 'apply', backend: 'cortex-native', runner: 'jlink', device: 'nRF52840_xxAA', runner_args: '-nogui' });
      const west = await call({ action: 'apply', backend: 'cortex-west' });
      assert.equal(west.runner, 'jlink');
      assert.equal(west.fields.runner_args, undefined);
      assert.ok(west.warnings.some((w: string) => /stored runner_args of jlink were not kept/.test(w) && /cortex-native and cortex-west/.test(w)));
      // Values given with the switch replace the stored ones, so nothing is reported.
      await call({ action: 'apply', runner_args: '--tool-opt=-nogui' });
      const given = await call({ action: 'apply', backend: 'cortex-native', runner_args: '-nogui' });
      assert.equal(given.fields.runner_args, '-nogui');
      assert.ok(!given.warnings.some((w: string) => /not kept/.test(w)));
    });

    it('keeps the other entries of launch.json as they are', async () => {
      harness();
      const mine = { name: 'My node app', type: 'node', request: 'launch', program: '${workspaceFolder}/x.js' };
      h.f.writeLaunchJson({ version: '0.2.0', configurations: [mine] });
      await call({ action: 'apply' });
      const written = h.f.readLaunchJson().configurations;
      assert.deepEqual(written[0], mine);
      assert.equal(written[1].name, PRIMARY);
    });

    it('skips a flash-only debug runner of runners.yaml for the first debug runner the board lists', async () => {
      harness({ primary: { debugRunner: 'nrfjprog' } });
      const result = await call({ action: 'apply', dry_run: true });
      assert.equal(result.runner, 'openocd');
    });

    for (const runner of ['nrfutil', 'nrfjprog', 'stm32cubeprogrammer', 'simplicity_commander', 'qemu']) {
      it(`refuses the ${runner} runner, listing the valid ones`, async () => {
        harness();
        const error = await errorOf(call({ action: 'apply', runner }));
        assert.equal(error.code, 'RUNNER_UNKNOWN');
        assert.deepEqual(error.details?.valid, debugRunnerNames());
        assert.ok(!fs.existsSync(h.f.launchJsonPath));
      });
    }

    it('refuses a build with no debug runner it can set up', async () => {
      harness({ primary: { runners: ['nrfutil'], debugRunner: 'nrfutil' } });
      const error = await errorOf(call({ action: 'apply' }));
      assert.equal(error.code, 'RUNNER_UNKNOWN');
      assert.match(error.hint ?? '', /Pass runner/);
    });

    it('warns when the runner is not one the board lists', async () => {
      harness();
      const result = await call({ action: 'apply', runner: 'linkserver', dry_run: true });
      assert.ok(result.warnings.some((w: string) => /does not list linkserver/.test(w)));
    });

    describe('a build that is missing', () => {
      it('is NOT_BUILT, and no task is started to configure it', async () => {
        harness({ builtPrimary: false });
        const error = await errorOf(call({ action: 'apply' }));
        assert.equal(error.code, 'NOT_BUILT');
        assert.match(error.hint ?? '', /Call build_app with config_name "primary"/);
        assert.equal(h.tasksStarted, 0);
        assert.ok(!fs.existsSync(h.f.launchJsonPath));
      });

      it('is NOT_BUILT for a build folder CMake never configured', async () => {
        harness({ builtPrimary: false });
        fs.mkdirSync(path.join(h.f.appRoot, 'build', 'primary', 'zephyr'), { recursive: true });
        assert.equal((await errorOf(call({ action: 'apply' }))).code, 'NOT_BUILT');
        assert.equal(h.tasksStarted, 0);
      });
    });

    describe('a board only west boards can find', () => {
      // The board folder runners.yaml names has board.yml only, as out-of-tree
      // boards often do, so the board comes from west boards.
      const westCommands = require('../../../commands/WestCommands') as Record<string, unknown>;
      let savedBoards: unknown;
      let seen: Array<{ signal?: AbortSignal; timeoutMs?: number } | undefined>;
      beforeEach(() => {
        savedBoards = westCommands.getWestBoards;
        seen = [];
      });
      afterEach(() => {
        westCommands.getWestBoards = savedBoards;
      });
      const withoutBoardYaml = (options: { primary?: BuildOptions } = {}) => {
        harness(options);
        fs.rmSync(path.join(h.f.boardDir, 'nrf52840dk_nrf52840.yaml'));
      };

      it('runs it under the call\'s signal and a timeout, stops with the call and frees launch.json', async () => {
        withoutBoardYaml();
        // As runWestCapture does: without a signal it would wait forever.
        westCommands.getWestBoards = (_ws: unknown, _roots: unknown, opts?: { signal?: AbortSignal; timeoutMs?: number }) => {
          seen.push(opts);
          if (!opts?.signal) {
            return Promise.reject(new Error('west boards runs unbounded'));
          }
          return new Promise((_resolve, reject) => opts.signal!.addEventListener('abort',
            () => reject(new WestCommandError('"west boards" was cancelled.', '', 'aborted')), { once: true }));
        };
        const controller = new AbortController();
        const pending = errorOf(configureDebug({ action: 'apply', dry_run: true }, { ...ctx('configure_debug'), signal: controller.signal }));
        await new Promise(resolve => setTimeout(resolve, 50));
        controller.abort();
        const cancelled = await pending;
        assert.equal(cancelled.code, 'TIMEOUT');
        assert.match(cancelled.message, /west boards was cancelled/);
        assert.equal(seen[0]?.signal, controller.signal);
        assert.ok((seen[0]?.timeoutMs ?? 0) > 0);

        westCommands.getWestBoards = async () => {
          throw new WestCommandError('"west boards" did not finish within 120 seconds and was stopped.', '', 'timeout');
        };
        const timedOut = await errorOf(call({ action: 'apply', dry_run: true }));
        assert.equal(timedOut.code, 'TIMEOUT');
        assert.doesNotMatch(timedOut.hint ?? '', /build_app/);
      });

      it('does not ask for a rebuild when west boards does not list the board of a complete build', async () => {
        withoutBoardYaml();
        westCommands.getWestBoards = async () => [];
        const error = await errorOf(call({ action: 'apply', dry_run: true }));
        assert.notEqual(error.code, 'NOT_BUILT');
        assert.doesNotMatch(error.hint ?? '', /build_app/);
        assert.match(error.hint ?? '', /BOARD_ROOT/);
        assert.match(error.message, /west boards does not list it/);
      });

      it('still asks for the build when it stopped before writing runners.yaml', async () => {
        withoutBoardYaml({ primary: { configuredOnly: true } });
        westCommands.getWestBoards = async () => [];
        const error = await errorOf(call({ action: 'apply', dry_run: true }));
        assert.equal(error.code, 'NOT_BUILT');
        assert.match(error.hint ?? '', /Call build_app with config_name "primary"/);
      });
    });

    it('warns when the ELF is not built yet', async () => {
      harness();
      fs.rmSync(path.join(h.f.appRoot, 'build', 'primary', 'zephyr', 'zephyr.elf'));
      const result = await call({ action: 'apply', dry_run: true });
      assert.ok(result.warnings.some((w: string) => /zephyr\.elf does not exist yet: call build_app/.test(w)));
    });

    it('warns when the host tool of the runner is not found, unless a runner path is given', async () => {
      harness();
      h.tools.jlink = false;
      const result = await call({ action: 'apply', dry_run: true });
      assert.ok(result.warnings.some((w: string) => /not found on this machine/.test(w) && /manage_runners/.test(w) && /list_runners/.test(w)));
      const withPath = await call({ action: 'apply', dry_run: true, runner_path: h.f.gdb });
      assert.ok(!withPath.warnings.some((w: string) => /not found on this machine/.test(w)));
      // A tool the filesystem cannot place is not reported missing.
      h.tools.jlink = null;
      assert.deepEqual((await call({ action: 'apply', dry_run: true })).warnings, []);
    });

    describe('arguments', () => {
      it('refuses paths that are relative or missing', async () => {
        harness();
        for (const key of ['program_path', 'gdb_path', 'svd_path', 'runner_path']) {
          assert.equal((await errorOf(call({ action: 'apply', [key]: 'relative/file' }))).code, 'INVALID_ARGUMENT', key);
          const missing = await errorOf(call({ action: 'apply', [key]: path.join(h.f.root, 'nope') }));
          assert.match(missing.message, /does not exist/, key);
        }
      });

      it('takes existing absolute paths as given', async () => {
        harness();
        const svd = path.join(h.f.root, 'chip.svd');
        fs.writeFileSync(svd, '<device/>');
        const elf = path.join(h.f.appRoot, 'build', 'primary', 'zephyr', 'zephyr.elf');
        const result = await call({ action: 'apply', svd_path: svd, program_path: elf, gdb_path: h.f.gdb });
        assert.equal(result.fields.svd_path, svd);
        assert.equal(result.fields.program_path, elf);
        assert.equal(result.fields.gdb_path, h.f.gdb);
      });

      it('refuses runner arguments a shell would read, and a runner path with shell characters', async () => {
        harness();
        for (const runnerArgs of ['--x; rm -rf /', '--x $(id)', '--x `id`', '--x | y', '--x "open', '--x %PATH%']) {
          assert.equal((await errorOf(call({ action: 'apply', runner_args: runnerArgs }))).code, 'INVALID_ARGUMENT', runnerArgs);
        }
        const odd = path.join(h.f.root, 'tool$x');
        fs.writeFileSync(odd, '');
        assert.match((await errorOf(call({ action: 'apply', runner_path: odd }))).message, /characters a shell would read/);
      });

      it('takes a host name or an IPv4 address only', async () => {
        harness();
        for (const address of ['a;b', 'host name', '-x', '[::1]']) {
          assert.equal((await errorOf(call({ action: 'apply', gdb_address: address }))).code, 'INVALID_ARGUMENT', address);
        }
        const result = await call({ action: 'apply', gdb_address: '192.168.1.20', dry_run: true });
        assert.equal(result.fields.gdb_address, '192.168.1.20');
      });

      it('refuses a bad backend, mode, interface or port', async () => {
        harness();
        for (const args of [{ backend: 'lldb' }, { mode: 'run' }, { gdb_port: 0 }, { gdb_port: 70000 }, { gdb_port: 3.5 }]) {
          assert.equal((await errorOf(call({ action: 'apply', ...args }))).code, 'INVALID_ARGUMENT', JSON.stringify(args));
        }
      });

      it('takes device and interface for cortex-native only', async () => {
        harness();
        assert.match((await errorOf(call({ action: 'apply', device: 'X' }))).message, /"cortex-native" only/);
        assert.match((await errorOf(call({ action: 'apply', interface: 'jtag' }))).message, /"cortex-native" only/);
      });
    });

    describe('the Cortex-Debug backends', () => {
      it('need the Cortex-Debug extension, and never offer to install it', async () => {
        harness();
        for (const backend of ['cortex-west', 'cortex-native']) {
          const error = await errorOf(call({ action: 'apply', backend }));
          assert.equal(error.code, 'DEPENDENCY_MISSING');
          assert.match(error.hint ?? '', /marus25\.cortex-debug/);
        }
        assert.ok(!fs.existsSync(h.f.launchJsonPath));
      });

      it('write a cortex-west entry with the runner\'s own port and no wrapper', async () => {
        harness();
        h.cortexDebug = true;
        const result = await call({ action: 'apply', backend: 'cortex-west' });
        assert.equal(result.entry.type, 'zephyr-workbench');
        assert.equal(result.entry.gdbTarget, 'localhost:2331');
        assert.deepEqual(result.files_written, [h.f.launchJsonPath]);
        assert.ok(!fs.existsSync(debugDir()));
      });

      it('write a cortex-native J-Link entry with the detected device and the Zephyr thread view', async () => {
        harness({ primary: { threadInfo: true } });
        h.cortexDebug = true;
        const result = await call({ action: 'apply', backend: 'cortex-native' });
        assert.equal(result.runner, 'jlink');
        assert.equal(result.entry.type, 'cortex-debug');
        assert.equal(result.entry.device, 'nRF52840_xxAA');
        assert.equal(result.entry.rtos, 'Zephyr');
        assert.equal(result.fields.interface, 'swd');
        assert.equal(result.fields.gdb_port, undefined);
        const jtag = await call({ action: 'apply', interface: 'jtag', device: 'nRF52833_xxAA' });
        assert.equal(jtag.backend, 'cortex-native');
        assert.equal(jtag.entry.interface, 'jtag');
        assert.equal(jtag.entry.device, 'nRF52833_xxAA');
      });

      it('refuse for cortex-native a runner it cannot start, and a gdb port', async () => {
        harness();
        h.cortexDebug = true;
        const runner = await errorOf(call({ action: 'apply', backend: 'cortex-native', runner: 'openocd' }));
        assert.equal(runner.code, 'INVALID_ARGUMENT');
        assert.deepEqual(runner.details?.valid, ['jlink', 'stlink_gdbserver']);
        assert.equal((await errorOf(call({ action: 'apply', backend: 'cortex-native', gdb_port: 2331 }))).code, 'INVALID_ARGUMENT');
        assert.equal((await errorOf(call({ action: 'apply', backend: 'cortex-native', gdb_address: 'localhost' }))).code, 'INVALID_ARGUMENT');
      });

      it('pick ST-LINK for cortex-native when the board lists it and not J-Link', async () => {
        harness({ primary: { runners: ['openocd', 'stlink_gdbserver'], debugRunner: 'openocd' } });
        h.cortexDebug = true;
        const result = await call({ action: 'apply', backend: 'cortex-native', dry_run: true });
        assert.equal(result.runner, 'stlink_gdbserver');
        assert.equal(result.entry.servertype, 'stlink');
      });
    });

    describe('pyOCD', () => {
      it('only checks the target support, and says how to install a missing pack', async () => {
        harness();
        h.pyocd = false;
        const result = await call({ action: 'apply', runner: 'pyocd' });
        assert.ok(result.warnings.some((w: string) => /call manage_runners with action "pyocd_install_pack" and pyocd_target "nrf52840"/.test(w)));
        assert.ok(fs.existsSync(h.f.launchJsonPath), 'the entry is written anyway');
      });

      it('says when pyOCD cannot be run to check', async () => {
        harness();
        h.pyocd = new Error('pyocd: not found');
        const result = await call({ action: 'apply', runner: 'pyocd', dry_run: true });
        assert.ok(result.warnings.some((w: string) => /could not be run/.test(w) && /pyocd: not found/.test(w)));
      });

      it('warns about nothing when the target is supported', async () => {
        harness();
        const result = await call({ action: 'apply', runner: 'pyocd', dry_run: true });
        assert.deepEqual(result.warnings, []);
        assert.equal(result.entry.miDebuggerServerAddress, 'localhost:3333');
      });

      it('refuses a build whose runners.yaml gives pyOCD no target', async () => {
        harness({ primary: { pyocdTarget: null } });
        const error = await errorOf(call({ action: 'apply', runner: 'pyocd' }));
        assert.equal(error.code, 'INVALID_ARGUMENT');
        assert.match(error.message, /no target/);
        assert.ok(!fs.existsSync(h.f.launchJsonPath));
      });
    });

    describe('dry run and confirmation', () => {
      it('writes nothing and asks nothing on a dry run, even when the tool asks', async () => {
        harness();
        h.confirmActions = ['settings'];
        const result = await call({ action: 'apply', dry_run: true });
        assert.equal(result.dry_run, true);
        assert.deepEqual(result.files_to_write, [path.join(debugDir(), wrapperName), h.f.launchJsonPath]);
        assert.equal(result.files_written, undefined);
        assert.deepEqual(h.asked, []);
        assert.ok(!fs.existsSync(h.f.launchJsonPath));
        assert.ok(!fs.existsSync(debugDir()));
        assert.match(result.next, /without dry_run/);
      });

      it('asks under Ask, naming the entry, the runner, the backend and the file', async () => {
        harness();
        h.confirmActions = ['settings'];
        h.answers.push('allow');
        const result = await call({ action: 'apply', runner_args: '--speed 4000' });
        assert.equal(h.asked.length, 1);
        assert.ok(h.asked[0].includes(`write the debug configuration "${PRIMARY}" (runner jlink, backend cppdbg, runner arguments --speed 4000) to ${h.f.launchJsonPath}`), h.asked[0]);
        assert.deepEqual(result.confirmation, { category: 'settings', outcome: 'allowed' });
        assert.ok(fs.existsSync(h.f.launchJsonPath));
      });

      it('writes nothing when the user declines', async () => {
        harness();
        h.confirmActions = ['settings'];
        h.answers.push(undefined);
        assert.equal((await errorOf(call({ action: 'apply' }))).code, 'USER_DENIED');
        assert.ok(!fs.existsSync(h.f.launchJsonPath));
        assert.ok(!fs.existsSync(debugDir()));
      });

      it('writes nothing when launch.json changed while the dialog was open', async () => {
        harness();
        h.confirmActions = ['settings'];
        h.answers.push('allow');
        h.onAsk = () => h.f.writeLaunchJson({ version: '0.2.0', configurations: [{ name: 'Added meanwhile', type: 'node' }] });
        const error = await errorOf(call({ action: 'apply' }));
        assert.equal(error.code, 'BUSY');
        assert.deepEqual(h.f.readLaunchJson().configurations, [{ name: 'Added meanwhile', type: 'node' }]);
        assert.ok(!fs.existsSync(debugDir()));
      });

      it('asks only after the checks that can refuse the call', async () => {
        harness();
        h.confirmActions = ['settings'];
        await errorOf(call({ action: 'apply', runner: 'nrfutil' }));
        await errorOf(call({ action: 'apply', backend: 'cortex-west' }));
        assert.deepEqual(h.asked, []);
      });
    });

    describe('launch.json', () => {
      it('never overwrites a launch.json that is not JSON', async () => {
        harness();
        h.f.writeLaunchJson('{ "configurations": [ oops');
        const error = await errorOf(call({ action: 'apply' }));
        assert.equal(error.code, 'INTERNAL');
        assert.match(error.hint ?? '', /Ask the user to fix/);
        assert.equal(fs.readFileSync(h.f.launchJsonPath, 'utf8'), '{ "configurations": [ oops');
      });

      it('reads a launch.json with comments, keeps its entries and warns that the comments go', async () => {
        harness();
        h.f.writeLaunchJson('{\n  // Use IntelliSense to learn about possible attributes.\n  "version": "0.2.0",\n  "configurations": [{ "name": "Mine", "type": "node", },],\n}\n');
        const result = await call({ action: 'apply' });
        assert.ok(result.warnings.some((w: string) => /comments/.test(w)));
        assert.deepEqual(h.f.readLaunchJson().configurations.map((c: { name: string }) => c.name), ['Mine', PRIMARY]);
      });
    });

    it('refuses while a build works in the build folder', async () => {
      harness();
      let release: () => void = () => undefined;
      const buildDir = path.join(h.f.appRoot, 'build', 'primary');
      const { job } = h.jobs.start({
        kind: 'build', lockKey: buildDir, requestKey: 'build', buildDir, command: 'west build',
        run: () => new Promise(resolve => { release = () => resolve({ exitCode: 0 }); }),
      });
      try {
        const error = await errorOf(call({ action: 'apply' }));
        assert.equal(error.code, 'BUSY');
        assert.equal(error.details?.job_id, job.id);
      } finally {
        release();
        await h.jobs.wait(job, 2000);
      }
      assert.equal((await call({ action: 'apply' })).name, PRIMARY);
    });

    it('needs the environment script for the cppdbg wrapper only', async () => {
      harness();
      h.cortexDebug = true;
      delete h.f.window.user['zephyr-workbench.pathToEnvScript'];
      const error = await errorOf(call({ action: 'apply' }));
      assert.equal(error.code, 'ENV_NOT_READY');
      assert.ok(!fs.existsSync(h.f.launchJsonPath));
      assert.equal((await call({ action: 'apply', backend: 'cortex-west' })).entry.type, 'zephyr-workbench');
    });

    describe('sysbuild', () => {
      it('debugs the default domain unless told otherwise, and names the domain in the entry', async () => {
        harness({ withSysbuild: true });
        const app = await call({ action: 'apply', config_name: 'sys', dry_run: true });
        assert.equal(app.domain, 'app');
        assert.equal(app.name, 'Zephyr Workbench Debug [sys] (app)');
        assert.equal(app.entry.program, '${workspaceFolder}/build/sys/app/zephyr/zephyr.elf');
        const mcuboot = await call({ action: 'apply', config_name: 'sys', domain: 'mcuboot' });
        assert.equal(mcuboot.name, 'Zephyr Workbench Debug [sys] (mcuboot)');
        assert.match(mcuboot.entry.debugServerArgs, /--build-dir "\$\{workspaceFolder\}\/build\/sys" --domain mcuboot/);
        assert.equal((await errorOf(call({ action: 'apply', config_name: 'sys', domain: 'nope' }))).code, 'INVALID_ARGUMENT');
      });

      it('renames an entry saved before domains were named, as the Debug Manager does', async () => {
        harness({ withSysbuild: true });
        h.f.writeLaunchJson({ version: '0.2.0', configurations: [{ name: 'Zephyr Workbench Debug [sys]', type: 'cppdbg', program: 'old', debugServerArgs: 'debugserver --runner openocd' }] });
        const result = await call({ action: 'apply', config_name: 'sys' });
        assert.equal(result.created, false);
        assert.equal(result.renamed_from, 'Zephyr Workbench Debug [sys]');
        assert.equal(result.runner, 'openocd');
        assert.deepEqual(h.f.readLaunchJson().configurations.map((c: { name: string }) => c.name), ['Zephyr Workbench Debug [sys] (app)']);
      });
    });
  });

  describe('list and get', () => {
    function seed(): void {
      h.f.writeLaunchJson({
        version: '0.2.0',
        configurations: [
          { name: 'Mine', type: 'node' },
          { name: PRIMARY, type: 'cppdbg', program: PROGRAM, debugServerArgs: 'debugserver --runner jlink --gdb-port 2331', setupCommands: [{ text: '-target-select remote localhost:2331', description: 'connect to target' }, { text: '-target-download', description: 'flash target' }] },
          { name: 'Zephyr Workbench Debug [gone]', type: 'zephyr-workbench', program: 'p', debugServerArgs: 'debugserver --runner openocd', gdbTarget: 'localhost:3333' },
          { name: 'Zephyr Workbench Debug [sys]', type: 'cortex-debug', servertype: 'jlink', executable: 'e', request: 'launch', device: 'D' },
        ],
      });
    }

    it('lists nothing, and says how to create one, without a launch.json', async () => {
      harness();
      const result = await call({ action: 'list' });
      assert.deepEqual(result.entries, []);
      assert.equal(result.exists, false);
      assert.match(result.next, /configure_debug with action "apply"/);
    });

    it('lists the Workbench entries with their backend, runner, port and staleness', async () => {
      harness({ withSysbuild: true });
      seed();
      const result = await call({ action: 'list' });
      assert.equal(result.launch_json, h.f.launchJsonPath);
      assert.deepEqual(result.entries, [
        { name: PRIMARY, backend: 'cppdbg', type: 'cppdbg', config_name: 'primary', runner: 'jlink', mode: 'program', gdb_port: 2331, program: PROGRAM, stale: false },
        { name: 'Zephyr Workbench Debug [gone]', backend: 'cortex-west', type: 'zephyr-workbench', config_name: 'gone', runner: 'openocd', mode: 'program', gdb_port: 3333, program: 'p', stale: true },
        { name: 'Zephyr Workbench Debug [sys]', backend: 'cortex-native', type: 'cortex-debug', config_name: 'sys', domain: 'app', runner: 'jlink', mode: 'program', program: 'e', stale: false, legacy: 'no-domain' },
      ]);
      assert.match(result.next, /1 stale entry belongs .* remove_or_delete and what "debug_config"/);
      assert.deepEqual((await call({ action: 'list', config_name: 'gone' })).entries.map((e: { name: string }) => e.name), ['Zephyr Workbench Debug [gone]']);
    });

    // The core preset, the default, does not serve remove_or_delete.
    it('sends the user to stale entries when the window does not serve remove_or_delete', async () => {
      harness({ withSysbuild: true });
      seed();
      h.deps.servedTools = () => new Set(TOOL_CATALOG.map(tool => tool.name).filter(name => name !== 'remove_or_delete'));
      const listed = await call({ action: 'list' });
      assert.match(listed.next, /1 stale entry belongs .*: ask the user to delete them from \.vscode\/launch\.json, or to allow remove_or_delete in the AI Manager\./);
      const stale = await call({ action: 'get', name: 'Zephyr Workbench Debug [gone]' });
      assert.equal(stale.next, 'Its build configuration no longer exists: ask the user to delete it from .vscode/launch.json, or to allow remove_or_delete in the AI Manager.');
    });

    it('refuses to read a launch.json that is not JSON', async () => {
      harness();
      h.f.writeLaunchJson('nope');
      assert.equal((await errorOf(call({ action: 'list' }))).code, 'INTERNAL');
    });

    it('reads a launch.json saved with a UTF-8 BOM, as VS Code does', async () => {
      harness();
      seed();
      h.f.writeLaunchJson(`﻿${fs.readFileSync(h.f.launchJsonPath, 'utf8')}`);
      assert.deepEqual((await call({ action: 'list' })).entries.map((e: { name: string }) => e.name).slice(0, 1), [PRIMARY]);
      const applied = await call({ action: 'apply' });
      assert.equal(applied.created, false);
      assert.equal(h.f.readLaunchJson().configurations[0].name, 'Mine');
    });

    it('gets an entry by name with its Debug Manager fields', async () => {
      harness({ withSysbuild: true });
      seed();
      const result = await call({ action: 'get', name: PRIMARY });
      assert.equal(result.name, PRIMARY);
      assert.equal(result.entry.type, 'cppdbg');
      assert.deepEqual(result.fields, {
        backend: 'cppdbg', runner: 'jlink', mode: 'program', program_path: PROGRAM, svd_path: '', gdb_path: '', gdb_address: 'localhost', gdb_port: 2331,
      });
      const native = await call({ action: 'get', name: 'Zephyr Workbench Debug [sys]' });
      assert.deepEqual(native.fields, {
        backend: 'cortex-native', runner: 'jlink', mode: 'program', program_path: 'e', svd_path: '', gdb_path: '', device: 'D', interface: 'swd',
      });
      const unknown = await errorOf(call({ action: 'get', name: 'Mine' }));
      assert.equal(unknown.code, 'INVALID_ARGUMENT');
      assert.deepEqual(unknown.details?.names, [PRIMARY, 'Zephyr Workbench Debug [gone]', 'Zephyr Workbench Debug [sys]']);
    });

    it('gets the entry of a configuration and domain, legacy names included', async () => {
      harness({ withSysbuild: true });
      seed();
      assert.equal((await call({ action: 'get' })).name, PRIMARY);
      const sys = await call({ action: 'get', config_name: 'sys' });
      assert.equal(sys.name, 'Zephyr Workbench Debug [sys]');
      assert.equal(sys.domain, 'app');
      const missing = await errorOf(call({ action: 'get', config_name: 'sys', domain: 'mcuboot' }));
      assert.equal(missing.code, 'CONFIG_NOT_FOUND');
      assert.match(missing.hint ?? '', /Call configure_debug with action "apply" and config_name "sys"/);
      assert.equal((await errorOf(call({ action: 'get', name: PRIMARY, config_name: 'primary' }))).code, 'INVALID_ARGUMENT');
    });
  });

  describe('remove_or_delete what "debug_config"', () => {
    function seed(): void {
      h.f.writeLaunchJson({
        version: '0.2.0',
        configurations: [
          { name: 'Mine', type: 'node' },
          { name: PRIMARY, type: 'cppdbg', program: PROGRAM },
          { name: 'Zephyr Workbench Debug [gone]', type: 'cppdbg', program: 'g' },
          { name: 'Zephyr Workbench Debug [old]', type: 'cppdbg', program: 'o' },
        ],
      });
    }
    const names = () => h.f.readLaunchJson().configurations.map((c: { name: string }) => c.name);

    it('removes one entry by name and keeps every other entry', async () => {
      harness();
      seed();
      const result = await remove({ name: PRIMARY });
      assert.deepEqual(result.removed, [PRIMARY]);
      assert.deepEqual(names(), ['Mine', 'Zephyr Workbench Debug [gone]', 'Zephyr Workbench Debug [old]']);
      assert.deepEqual(h.f.readLaunchJson().configurations[0], { name: 'Mine', type: 'node' });
    });

    it('refuses a name that is not one of the application\'s entries, listing them', async () => {
      harness();
      seed();
      const error = await errorOf(remove({ name: 'Mine' }));
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.deepEqual(error.details?.names, [PRIMARY, 'Zephyr Workbench Debug [gone]', 'Zephyr Workbench Debug [old]']);
    });

    it('removes every stale entry without a name, or those of one configuration', async () => {
      harness();
      seed();
      assert.deepEqual((await remove({ config_name: 'old' })).removed, ['Zephyr Workbench Debug [old]']);
      assert.deepEqual((await remove({})).removed, ['Zephyr Workbench Debug [gone]']);
      assert.deepEqual(names(), ['Mine', PRIMARY]);
      const none = await remove({});
      assert.deepEqual(none.removed, []);
      assert.match(none.note, /No debug configuration/);
    });

    it('does not take a configuration that still exists as stale', async () => {
      harness();
      seed();
      const result = await remove({ config_name: 'primary' });
      assert.deepEqual(result.removed, []);
      assert.match(result.note, /still exists/);
      assert.equal(names().length, 4);
    });

    it('lists what would go on a dry run, without asking or writing', async () => {
      harness();
      seed();
      h.confirmActions = ['delete'];
      const before = fs.readFileSync(h.f.launchJsonPath, 'utf8');
      const result = await remove({ dry_run: true });
      assert.deepEqual(result.would_remove, ['Zephyr Workbench Debug [gone]', 'Zephyr Workbench Debug [old]']);
      assert.deepEqual(h.asked, []);
      assert.equal(fs.readFileSync(h.f.launchJsonPath, 'utf8'), before);
    });

    it('asks under Ask as a deletion, and keeps the file when the user declines', async () => {
      harness();
      seed();
      h.confirmActions = ['delete'];
      const before = fs.readFileSync(h.f.launchJsonPath, 'utf8');
      h.answers.push(undefined);
      assert.equal((await errorOf(remove({}))).code, 'USER_DENIED');
      assert.equal(fs.readFileSync(h.f.launchJsonPath, 'utf8'), before);
      assert.match(h.asked[0], /remove 2 debug configurations of build configurations that no longer exist/);

      h.answers.push('allow');
      const result = await remove({ name: 'Zephyr Workbench Debug [gone]' });
      assert.deepEqual(result.confirmation, { category: 'delete', outcome: 'allowed' });
      assert.match(h.asked[1], /remove the debug configuration "Zephyr Workbench Debug \[gone\]"/);
    });

    it('refuses name with config_name, and the arguments of other removals', async () => {
      harness();
      seed();
      assert.equal((await errorOf(removeDebugConfig({ name: PRIMARY, config_name: 'gone' }, ctx('remove_or_delete')))).code, 'INVALID_ARGUMENT');
      assert.equal((await errorOf(remove({ force: true }))).code, 'INVALID_ARGUMENT');
    });

    it('has nothing to remove without a launch.json', async () => {
      harness();
      assert.deepEqual((await remove({})).removed, []);
      assert.ok(!fs.existsSync(h.f.launchJsonPath));
    });
  });
});
