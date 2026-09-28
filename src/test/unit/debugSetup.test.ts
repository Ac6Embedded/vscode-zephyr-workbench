// The headless Apply of the Debug Manager (src/debug/debugSetup.ts): the form
// checks with the messages the panel shows, the entry of each backend, the
// files written, the hooks the panel and the MCP tool fill differently, the
// west wrapper of each shell, and the reading of an application's entries.
// Each test runs on a freestanding application whose build is on disk; no
// board, no west and no pyOCD run.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
// debugUtils first: loading a runner module first runs into the
// WestRunner -> ... -> debugUtils -> Linkserver -> WestRunner import cycle.
import {
  buildWestWrapperScript, createLaunchConfiguration, createOpenocdCfg, createWestWrapper, getDebugLaunchConfigurationName,
  getLaunchConfiguration, getRunner, getWestDebugArgsForProject, parseLaunchJsonText, pyocdLaunchJson,
  removeApplicationLaunchConfigurations, writeLaunchJson,
} from '../../utils/debugTools/debugUtils';
import {
  applyDebugSetup, checkPyOCDTargetSupport, debugEntryFields, DebugSetupHooks, DebugSetupInput, findApplicationDebugEntry,
  listApplicationDebugEntries, readLaunchJsonFile, runnerPathArg,
} from '../../debug/debugSetup';
import { getSetupCommands } from '../../debug/gdbUtils';
import { StlinkGdbserver } from '../../debug/runners/StlinkGdbserver';
import { buildCortexWestLaunchConfig } from '../../debug/backends/cortexWest';
import { buildCortexNativeLaunchConfig } from '../../debug/backends/cortexNative';
import { DebugBackendId, runnerNameToNativeServer } from '../../debug/backends/types';
import { ZephyrApplication } from '../../models/ZephyrApplication';
import { DebugFixture, makeDebugFixture } from './debugTestFixture';

const execUtils = require('../../utils/execUtils') as Record<string, unknown>;

const PROGRAM = '${workspaceFolder}/build/primary/zephyr/zephyr.elf';

function input(f: DebugFixture, app: ZephyrApplication, overrides: Partial<DebugSetupInput> = {}): DebugSetupInput {
  return {
    project: app,
    buildConfig: app.getBuildConfiguration('primary'),
    backend: 'cppdbg',
    runnerName: 'openocd',
    programPath: PROGRAM,
    svdPath: '',
    gdbPath: f.gdb,
    gdbAddress: 'localhost',
    gdbPort: '3333',
    gdbMode: 'program',
    runnerPath: '',
    runnerArgs: '',
    device: '',
    deviceInterface: 'swd',
    ...overrides,
  };
}

interface HookLog { cortex: number; pyocd: number }

function hooks(overrides: Partial<DebugSetupHooks> = {}): DebugSetupHooks & { log: HookLog } {
  const log: HookLog = { cortex: 0, pyocd: 0 };
  return {
    log,
    ensureCortexDebug: async () => { log.cortex++; return true; },
    preparePyOCDTarget: async () => { log.pyocd++; return true; },
    silent: true,
    ...overrides,
  };
}

const debugDir = (f: DebugFixture, config = 'primary') => path.join(f.appRoot, 'build', config, '.debug');
const wrapperName = process.platform === 'win32' ? 'west_wrapper.bat' : 'west_wrapper.sh';

describe('debug setup: the Debug Manager Apply without its panel', () => {
  let f: DebugFixture;
  afterEach(() => f?.restore());

  describe('form checks, with the messages the Debug Manager shows', () => {
    const cases: Array<[string, Partial<DebugSetupInput>, string, RegExp]> = [
      ['no runner', { runnerName: '' }, 'no-runner', /^Debug manager: No debug runner selected!$/],
      ['an unknown runner', { runnerName: 'bogus' }, 'no-runner', /No debug runner selected/],
      ['no program', { programPath: '' }, 'no-program', /^Debug manager: Program path is required\./],
      ['no gdb', { gdbPath: '' }, 'no-gdb', /^Debug manager: GDB path is required\./],
      ['no gdb address', { gdbAddress: '' }, 'no-gdb-address', /^Debug manager: GDB address is required/],
      ['no gdb port', { gdbPort: '' }, 'no-gdb-port', /^Debug manager: GDB port is required/],
      ['a J-Link without device on cortex-native', { backend: 'cortex-native', runnerName: 'jlink', device: '' }, 'no-device', /Device name is required for J-Link/],
    ];
    for (const [label, overrides, failure, message] of cases) {
      it(`refuses ${label} and writes nothing`, async () => {
        f = makeDebugFixture();
        const app = f.app();
        const h = hooks();
        const result = await applyDebugSetup(input(f, app, overrides), h);
        assert.equal(result.ok, false);
        assert.equal(!result.ok && result.failure, failure);
        assert.match((!result.ok && result.message) || '', message);
        assert.ok(!fs.existsSync(f.launchJsonPath));
        assert.ok(!fs.existsSync(debugDir(f)));
        assert.deepEqual(h.log, { cortex: 0, pyocd: 0 });
      });
    }

    it('writes nothing, and says nothing, without a build configuration', async () => {
      f = makeDebugFixture();
      const app = f.app();
      const result = await applyDebugSetup(input(f, app, { buildConfig: undefined }), hooks());
      assert.deepEqual(result, { ok: false, failure: 'no-build-config' });
      assert.ok(!fs.existsSync(f.launchJsonPath));
    });

    it('stops before reading launch.json when Cortex-Debug is not available, and leaves the message to the hook', async () => {
      f = makeDebugFixture();
      const app = f.app();
      let loaded = false;
      const result = await applyDebugSetup(input(f, app, { backend: 'cortex-west', runnerName: 'jlink' }), hooks({
        ensureCortexDebug: async () => false,
        load: async () => { loaded = true; return [{ configurations: [] }, undefined]; },
      }));
      assert.deepEqual(result, { ok: false, failure: 'no-cortex-debug' });
      assert.equal(loaded, false);
      assert.ok(!fs.existsSync(f.launchJsonPath));
    });

    it('never asks for Cortex-Debug for the cppdbg backend', async () => {
      f = makeDebugFixture();
      const h = hooks({ ensureCortexDebug: async () => { throw new Error('asked'); } });
      const result = await applyDebugSetup(input(f, f.app()), h);
      assert.ok(result.ok);
    });
  });

  describe('cppdbg', () => {
    it('writes the entry, the west wrapper and the OpenOCD gdb.cfg, in that order before launch.json', async () => {
      f = makeDebugFixture();
      const app = f.app();
      const result = await applyDebugSetup(input(f, app), hooks());
      assert.ok(result.ok && result.written);
      const { entry, files } = result.plan;
      assert.deepEqual(files, [
        path.join(debugDir(f), wrapperName), path.join(debugDir(f), 'gdb.cfg'), f.launchJsonPath,
      ]);
      for (const file of files) {
        assert.ok(fs.existsSync(file), file);
      }
      assert.equal(entry.name, 'Zephyr Workbench Debug [primary]');
      assert.equal(entry.type, 'cppdbg');
      assert.equal(entry.program, PROGRAM);
      assert.equal(entry.miDebuggerPath, f.gdb);
      assert.equal(entry.debugServerPath, `\${workspaceFolder}/build/primary/.debug/${wrapperName}`);
      assert.equal(entry.debugServerArgs,
        'debugserver --build-dir "${workspaceFolder}/build/primary" --runner openocd --gdb-port 3333 --config openocd.cfg --config "${workspaceFolder}/build/primary/.debug/gdb.cfg"');
      assert.equal(entry.serverStarted, 'halted due to debug-request, current mode: Thread');
      assert.ok(entry.setupCommands.some((c: { text: string }) => c.text === '-target-select remote localhost:3333'));
      assert.ok(entry.setupCommands.some((c: { text: string }) => c.text === '-target-download'));
      assert.deepEqual(f.readLaunchJson().configurations, [entry]);
    });

    it('attaches without flashing in attach mode', async () => {
      f = makeDebugFixture();
      const result = await applyDebugSetup(input(f, f.app(), { gdbMode: 'attach', runnerName: 'jlink', gdbPort: '2331' }), hooks());
      assert.ok(result.ok);
      const texts = result.plan.entry.setupCommands.map((c: { text: string }) => c.text);
      assert.ok(texts.includes('-target-select remote localhost:2331'));
      assert.ok(!texts.includes('-target-download'));
      assert.equal(debugEntryFields(result.plan.entry).mode, 'attach');
    });

    it('passes the J-Link path as --gdbserver, quoted when it has a space, and keeps the extra arguments', async () => {
      f = makeDebugFixture();
      const result = await applyDebugSetup(input(f, f.app(), {
        runnerName: 'jlink', gdbPort: '2331', runnerPath: '/opt/SEGGER JLink/JLinkGDBServerCL', runnerArgs: '--tool-opt="-speed 4000"',
      }), hooks());
      assert.ok(result.ok);
      assert.equal(result.plan.entry.debugServerArgs,
        'debugserver --build-dir "${workspaceFolder}/build/primary" --runner jlink --gdb-port 2331 --gdbserver "/opt/SEGGER JLink/JLinkGDBServerCL" --tool-opt="-speed 4000"');
      assert.deepEqual(
        { runner: debugEntryFields(result.plan.entry).runner, path: debugEntryFields(result.plan.entry).runner_path, args: debugEntryFields(result.plan.entry).runner_args },
        { runner: 'jlink', path: '/opt/SEGGER JLink/JLinkGDBServerCL', args: '--tool-opt="-speed 4000"' },
      );
      // No gdb.cfg for a runner other than OpenOCD.
      assert.ok(!fs.existsSync(path.join(debugDir(f), 'gdb.cfg')));
    });

    it('passes the OpenOCD and pyOCD paths once, as one argument', async () => {
      f = makeDebugFixture();
      const openocd = await applyDebugSetup(input(f, f.app(), { runnerPath: '/opt/open ocd/bin/openocd' }), hooks());
      assert.ok(openocd.ok);
      assert.match(openocd.plan.entry.debugServerArgs, /--runner openocd --openocd "\/opt\/open ocd\/bin\/openocd" --gdb-port 3333 --config openocd\.cfg --config "[^"]+gdb\.cfg"$/);
      const pyocd = await applyDebugSetup(input(f, f.app(), { runnerName: 'pyocd', runnerPath: '/opt/py ocd/pyocd' }), hooks());
      assert.ok(pyocd.ok);
      assert.match(pyocd.plan.entry.debugServerArgs, /--runner pyocd --gdb-port 3333 --pyocd "\/opt\/py ocd\/pyocd"$/);
      assert.equal(debugEntryFields(pyocd.plan.entry).runner_path, '/opt/py ocd/pyocd');
    });

    it('sets up pyOCD through the hook first, and writes nothing when the target is not supported', async () => {
      f = makeDebugFixture();
      const h = hooks({ preparePyOCDTarget: async () => false });
      const result = await applyDebugSetup(input(f, f.app(), { runnerName: 'pyocd' }), h);
      assert.deepEqual(result, { ok: false, failure: 'pyocd-target' });
      assert.ok(!fs.existsSync(f.launchJsonPath));
      assert.ok(!fs.existsSync(debugDir(f)), 'no wrapper is left behind');
    });

    it('writes the pyOCD entry with its own setup commands', async () => {
      f = makeDebugFixture();
      const h = hooks();
      const result = await applyDebugSetup(input(f, f.app(), { runnerName: 'pyocd' }), h);
      assert.ok(result.ok);
      assert.equal(h.log.pyocd, 1);
      assert.equal(result.plan.entry.miDebuggerServerAddress, 'localhost:3333');
      assert.equal(result.plan.entry.setupCommands[1].text, 'monitor reset halt');
    });

    it('rebuilds a Cortex-Debug entry as cppdbg in place, keeping the other entries', async () => {
      f = makeDebugFixture();
      const other = { name: 'My own launch', type: 'node', request: 'launch' };
      f.writeLaunchJson({
        version: '0.2.0',
        configurations: [
          { name: 'Zephyr Workbench Debug [primary]', type: 'cortex-debug', servertype: 'jlink', executable: PROGRAM, device: 'X' },
          other,
        ],
      });
      const result = await applyDebugSetup(input(f, f.app()), hooks());
      assert.ok(result.ok);
      const written = f.readLaunchJson().configurations;
      assert.equal(written.length, 2);
      assert.equal(written[0].type, 'cppdbg');
      assert.equal(written[0].servertype, undefined);
      assert.deepEqual(written[1], other);
    });
  });

  describe('Cortex-Debug with west (cortex-west)', () => {
    it('writes a zephyr-workbench entry and no wrapper', async () => {
      f = makeDebugFixture();
      const h = hooks();
      const result = await applyDebugSetup(input(f, f.app(), { backend: 'cortex-west', runnerName: 'jlink', gdbPort: '2331' }), h);
      assert.ok(result.ok);
      assert.equal(h.log.cortex, 1);
      assert.deepEqual(result.plan.entry, {
        name: 'Zephyr Workbench Debug [primary]',
        type: 'zephyr-workbench',
        request: 'launch',
        cwd: '${workspaceFolder}',
        program: PROGRAM,
        svdPath: '',
        miDebuggerPath: f.gdb,
        debugServerArgs: 'debugserver --build-dir "${workspaceFolder}/build/primary" --runner jlink --gdb-port 2331',
        gdbTarget: 'localhost:2331',
        gdbMode: 'program',
      });
      assert.deepEqual(result.plan.files, [f.launchJsonPath]);
      assert.ok(!fs.existsSync(debugDir(f)));
    });

    it('writes the gdb.cfg OpenOCD is given', async () => {
      f = makeDebugFixture();
      const result = await applyDebugSetup(input(f, f.app(), { backend: 'cortex-west' }), hooks());
      assert.ok(result.ok);
      assert.deepEqual(result.plan.files, [path.join(debugDir(f), 'gdb.cfg'), f.launchJsonPath]);
      assert.ok(fs.existsSync(path.join(debugDir(f), 'gdb.cfg')));
    });

    it('refuses QEMU for a board that is not ARM', async () => {
      f = makeDebugFixture();
      const result = await applyDebugSetup(input(f, f.app(), { backend: 'cortex-west', runnerName: 'qemu', targetArch: 'riscv' }), hooks());
      assert.equal(!result.ok && result.failure, 'qemu-not-arm');
      assert.match((!result.ok && result.message) || '', /only supported for ARM boards/);
      assert.ok(!fs.existsSync(f.launchJsonPath));
    });
  });

  describe('Cortex-Debug starting the server (cortex-native)', () => {
    it('writes a J-Link entry with the device, and turns the Zephyr thread view on when the build keeps thread information', async () => {
      f = makeDebugFixture({ primary: { threadInfo: true } });
      const result = await applyDebugSetup(input(f, f.app(), {
        backend: 'cortex-native', runnerName: 'jlink', device: 'nRF52840_xxAA', runnerArgs: '-speed 4000',
      }), hooks());
      assert.ok(result.ok);
      const entry = result.plan.entry;
      assert.equal(entry.type, 'cortex-debug');
      assert.equal(entry.servertype, 'jlink');
      assert.equal(entry.device, 'nRF52840_xxAA');
      assert.equal(entry.interface, 'swd');
      assert.equal(entry.executable, PROGRAM);
      assert.equal(entry.gdbPath, f.gdb);
      assert.equal(entry.runToEntryPoint, 'main');
      assert.deepEqual(entry.serverArgs, ['-speed', '4000']);
      assert.equal(entry.rtos, 'Zephyr');
      assert.deepEqual(result.plan.files, [f.launchJsonPath]);
      assert.equal(debugEntryFields(entry).rtos, 'Zephyr');
    });

    it('leaves the thread view off without CONFIG_DEBUG_THREAD_INFO', async () => {
      f = makeDebugFixture();
      const result = await applyDebugSetup(input(f, f.app(), { backend: 'cortex-native', runnerName: 'jlink', device: 'nRF52840_xxAA' }), hooks());
      assert.ok(result.ok);
      assert.equal(result.plan.entry.rtos, undefined);
    });

    it('refuses a runner it cannot start', async () => {
      f = makeDebugFixture();
      const result = await applyDebugSetup(input(f, f.app(), { backend: 'cortex-native', runnerName: 'openocd' }), hooks());
      assert.equal(!result.ok && result.failure, 'not-native-runner');
      assert.match((!result.ok && result.message) || '', /J-Link or ST-LINK GDB Server/);
    });

    it('never asks pyOCD or writes a wrapper', async () => {
      f = makeDebugFixture();
      const h = hooks();
      const result = await applyDebugSetup(input(f, f.app(), { backend: 'cortex-native', runnerName: 'stlink_gdbserver' }), h);
      assert.ok(result.ok);
      assert.equal(h.log.pyocd, 0);
      assert.equal(result.plan.entry.servertype, 'stlink');
      assert.ok(!fs.existsSync(debugDir(f)));
    });
  });

  describe('hooks', () => {
    it('hands beforeWrite the plan and writes nothing when it says no', async () => {
      f = makeDebugFixture();
      let seen: string[] = [];
      const result = await applyDebugSetup(input(f, f.app()), hooks({
        beforeWrite: async plan => { seen = plan.files; return false; },
      }));
      assert.ok(result.ok && !result.written);
      assert.equal(seen.length, 3);
      assert.ok(!fs.existsSync(f.launchJsonPath));
      assert.ok(!fs.existsSync(debugDir(f)));
    });

    it('builds on the launch.json load returns instead of reading the file', async () => {
      f = makeDebugFixture();
      const app = f.app();
      const launchJson = { version: '0.2.0', configurations: [{ name: 'kept', type: 'node' }] };
      const found = await createLaunchConfiguration(app, 'primary', undefined, undefined, { silent: true });
      launchJson.configurations.push(found);
      const result = await applyDebugSetup(input(f, app), hooks({ load: async () => [launchJson, found] }));
      assert.ok(result.ok);
      assert.equal(result.plan.launchJson, launchJson);
      assert.deepEqual(f.readLaunchJson().configurations.map((c: { name: string }) => c.name), ['kept', 'Zephyr Workbench Debug [primary]']);
    });
  });

  describe('the launch.json the Debug Manager reads itself', () => {
    const commented = '{\n  // Use IntelliSense to learn about possible attributes.\n  "version": "0.2.0",\n  "configurations": [{ "name": "Mine", "type": "node", },],\n}\n';

    for (const [label, text] of [['comments and trailing commas', commented], ['a UTF-8 BOM', `﻿${JSON.stringify({ version: '0.2.0', configurations: [{ name: 'Mine', type: 'node' }] })}`]]) {
      it(`keeps the other entries of a file with ${label}`, async () => {
        f = makeDebugFixture();
        f.writeLaunchJson(text);
        const result = await applyDebugSetup(input(f, f.app()), hooks());
        assert.ok(result.ok && result.written);
        assert.deepEqual(f.readLaunchJson().configurations.map((c: { name: string }) => c.name), ['Mine', 'Zephyr Workbench Debug [primary]']);
      });
    }

    it('refuses a file that is not JSON, and leaves it as it is', async () => {
      f = makeDebugFixture();
      f.writeLaunchJson('{ "configurations": [ oops');
      const result = await applyDebugSetup(input(f, f.app()), hooks());
      assert.equal(!result.ok && result.failure, 'launch-json-unreadable');
      assert.match((!result.ok && result.message) || '', /^Debug manager: .*launch\.json is not valid JSON/);
      assert.equal(fs.readFileSync(f.launchJsonPath, 'utf8'), '{ "configurations": [ oops');
      assert.ok(!fs.existsSync(debugDir(f)));
    });
  });

  describe('the Debug Manager writes what it wrote before the move', () => {
    // The Apply of DebugManagerPanel.ts as it was before it moved to
    // debugSetup.ts, without its toasts: the reference the setup must match.
    async function legacyApply(app: ZephyrApplication, message: Record<string, any>): Promise<boolean> {
      const buildConfigName = message.buildConfig;
      const buildConfig = app.getBuildConfiguration(buildConfigName)!;
      const runner = getRunner(message.runner)!;
      const backend: DebugBackendId = message.backend;
      const domainName = message.domain;
      if (backend !== 'cppdbg') {
        const [launchJson, existing] = await getLaunchConfiguration(app, buildConfigName, false, undefined, domainName);
        const existingIndex = launchJson.configurations.indexOf(existing);
        const configName = typeof existing?.name === 'string' && existing.name.length > 0
          ? existing.name : getDebugLaunchConfigurationName(app, buildConfigName, domainName);
        const cwd = typeof existing?.cwd === 'string' && existing.cwd.length > 0 ? existing.cwd : '${workspaceFolder}';
        let freshConfig: any;
        if (backend === 'cortex-west') {
          runner.loadArgs(message.runnerArgs);
          runner.serverPath = message.runnerPath;
          runner.serverAddress = message.gdbAddress;
          runner.serverPort = message.gdbPort;
          let debugServerArgs = getWestDebugArgsForProject(runner, app, buildConfig, domainName);
          debugServerArgs = runnerPathArg(debugServerArgs, runner.name, message.runnerPath);
          freshConfig = buildCortexWestLaunchConfig({
            name: configName, cwd, programPath: message.programPath, svdPath: message.svdPath, gdbPath: message.gdbPath,
            gdbMode: message.gdbMode, gdbAddress: message.gdbAddress, gdbPort: message.gdbPort,
          }, debugServerArgs);
        } else {
          const nativeServer = runnerNameToNativeServer(message.runner)!;
          let serverPath = typeof message.runnerPath === 'string' ? message.runnerPath.trim() : '';
          let stm32CubeProgrammerDir: string | undefined;
          if (nativeServer === 'stlink') {
            const stlinkRunner = new StlinkGdbserver();
            await stlinkRunner.loadInternalArgs();
            serverPath = serverPath || (stlinkRunner.serverPath ?? '');
            stm32CubeProgrammerDir = stlinkRunner.findCubeCltFile('STM32CubeProgrammer', 'bin');
          }
          freshConfig = buildCortexNativeLaunchConfig({
            name: configName, cwd, programPath: message.programPath, svdPath: message.svdPath, gdbPath: message.gdbPath,
            gdbMode: message.gdbMode, server: nativeServer, device: message.device, interface: message.deviceInterface,
            serverPath, serverArgs: message.runnerArgs, stm32CubeProgrammerDir,
          });
        }
        if (existingIndex >= 0) {
          launchJson.configurations[existingIndex] = freshConfig;
        } else {
          launchJson.configurations.push(freshConfig);
        }
        if (backend === 'cortex-west' && runner.name === 'openocd') {
          createOpenocdCfg(app, buildConfigName);
        }
        writeLaunchJson(launchJson, app);
        return true;
      }
      let [launchJson, config] = await getLaunchConfiguration(app, buildConfigName, false, undefined, domainName);
      if (config?.type && config.type !== 'cppdbg') {
        const configIndex = launchJson.configurations.indexOf(config);
        config = await createLaunchConfiguration(app, buildConfigName, undefined, domainName);
        launchJson.configurations[configIndex] = config;
      }
      config.program = message.programPath;
      config.svdPath = message.svdPath ? message.svdPath : '';
      config.miDebuggerPath = message.gdbPath;
      runner.loadArgs(message.runnerArgs);
      runner.serverPath = message.runnerPath;
      runner.serverAddress = message.gdbAddress;
      runner.serverPort = message.gdbPort;
      config.serverStarted = runner.serverStartedPattern;
      config.debugServerArgs = runnerPathArg(getWestDebugArgsForProject(runner, app, buildConfig, domainName), runner.name, message.runnerPath);
      config.setupCommands = [...getSetupCommands(message.programPath, runner.serverAddress, runner.serverPort, message.gdbMode, runner.name)];
      if (runner.name === 'pyocd' && runner.serverAddress && runner.serverPort) {
        const configIndex = launchJson.configurations.indexOf(config);
        config = pyocdLaunchJson(config, runner.serverAddress, runner.serverPort);
        launchJson.configurations[configIndex] = config;
      }
      createWestWrapper(app, buildConfigName);
      if (runner.name === 'openocd') {
        createOpenocdCfg(app, buildConfigName);
      }
      writeLaunchJson(launchJson, app);
      return true;
    }

    const forms: Array<[string, Record<string, string>]> = [
      ['cppdbg with OpenOCD, a runner path and extra arguments', {
        backend: 'cppdbg', runner: 'openocd', gdbPort: '3333', runnerPath: '/opt/openocd/bin/openocd', runnerArgs: '--cmd-pre-init "adapter speed 1000"',
      }],
      ['cppdbg with pyOCD in attach mode', { backend: 'cppdbg', runner: 'pyocd', gdbPort: '3333', gdbMode: 'attach' }],
      ['cortex-west with J-Link', { backend: 'cortex-west', runner: 'jlink', gdbPort: '2331' }],
      ['cortex-native with J-Link', { backend: 'cortex-native', runner: 'jlink', device: 'nRF52840_xxAA', runnerArgs: '-speed 4000' }],
    ];
    for (const [label, form] of forms) {
      it(`for ${label}`, async () => {
        const message: Record<string, string> = {
          buildConfig: 'primary', programPath: PROGRAM, svdPath: '', gdbAddress: 'localhost', gdbMode: 'program',
          runnerPath: '', runnerArgs: '', device: '', deviceInterface: 'swd', ...form,
        };
        f = makeDebugFixture();
        message.gdbPath = f.gdb;
        const existing = { version: '0.2.0', configurations: [{ name: 'Other', type: 'node', request: 'launch' }] };
        f.writeLaunchJson(existing);
        const app = f.app();
        assert.ok(await legacyApply(app, message));
        const before = { launch: fs.readFileSync(f.launchJsonPath, 'utf8'), wrapper: readIfAny(path.join(debugDir(f), wrapperName)) };

        fs.rmSync(debugDir(f), { recursive: true, force: true });
        f.writeLaunchJson(existing);
        const result = await applyDebugSetup({
          project: app, buildConfig: app.getBuildConfiguration('primary'), backend: message.backend as DebugBackendId,
          runnerName: message.runner, programPath: message.programPath, svdPath: message.svdPath, gdbPath: message.gdbPath,
          gdbAddress: message.gdbAddress, gdbPort: message.gdbPort ?? '', gdbMode: message.gdbMode as 'program' | 'attach',
          runnerPath: message.runnerPath, runnerArgs: message.runnerArgs, device: message.device, deviceInterface: 'swd',
        }, { ensureCortexDebug: async () => true, preparePyOCDTarget: async () => true });
        assert.ok(result.ok);
        assert.equal(fs.readFileSync(f.launchJsonPath, 'utf8'), before.launch);
        assert.equal(readIfAny(path.join(debugDir(f), wrapperName)), before.wrapper);
      });
    }
  });
});

function readIfAny(file: string): string | undefined {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
}

describe('debug setup: runnerPathArg', () => {
  it('replaces a path already given, inserts after --runner, and appends otherwise', () => {
    assert.equal(runnerPathArg('debugserver --runner openocd --openocd /old', 'openocd', '/new'), 'debugserver --runner openocd --openocd /new');
    assert.equal(runnerPathArg('debugserver --runner linkserver --gdb-port 3333', 'linkserver', '/p/LinkServer'), 'debugserver --runner linkserver --linkserver /p/LinkServer --gdb-port 3333');
    assert.equal(runnerPathArg('debugserver', 'linkserver', '/a b/LinkServer'), 'debugserver --linkserver "/a b/LinkServer"');
    assert.equal(runnerPathArg('', 'pyocd', '/bin/pyocd'), '--pyocd /bin/pyocd');
  });

  it('never gives ST-LINK, QEMU or J-Link a path flag, and leaves the arguments without a path', () => {
    // west's jlink runner has no --jlink option: J-Link passes its path as --gdbserver itself.
    assert.equal(runnerPathArg('debugserver --runner jlink --gdbserver /p/JLinkGDBServerCL', 'jlink', '/p/JLinkGDBServerCL'), 'debugserver --runner jlink --gdbserver /p/JLinkGDBServerCL');
    assert.equal(runnerPathArg(' debugserver --runner stlink_gdbserver ', 'stlink_gdbserver', '/x/ST-LINK_gdbserver'), 'debugserver --runner stlink_gdbserver');
    assert.equal(runnerPathArg('build -t debugserver_qemu', 'qemu', '/usr/bin/qemu'), 'build -t debugserver_qemu');
    assert.equal(runnerPathArg('debugserver --runner jlink', 'jlink', '  '), 'debugserver --runner jlink');
  });
});

describe('debug setup: the west wrapper', () => {
  const env = {
    ZEPHYR_BASE: '/w s/zephyr',
    QUOTE: `it's "quoted" $HOME 100%`,
    EXTRA_CONF_FILE: ['a.conf', 'b.conf'],
    EMPTY: '',
    NONE: [],
    'BAD-NAME': 'x',
    MULTI: 'one\ntwo',
  };

  it('writes cmd assignments that keep the value literal, % included', () => {
    const wrapper = buildWestWrapperScript('cmd.exe', 'C:\\tools\\env.bat', env)!;
    assert.equal(wrapper.fileName, 'west_wrapper.bat');
    assert.ok(wrapper.content.startsWith('@echo off\r\n') || wrapper.content.startsWith('@echo off\n'));
    assert.ok(wrapper.content.includes('set "ZEPHYR_BASE=/w s/zephyr"\n'));
    assert.ok(wrapper.content.includes(`set "QUOTE=it's "quoted" $HOME 100%%"\n`));
    assert.ok(wrapper.content.includes('set "EXTRA_CONF_FILE=a.conf;b.conf"\n'));
    assert.ok(wrapper.content.includes('call C:\\tools\\env.bat && west %*'));
  });

  it('writes bash exports in single quotes, whatever POSIX shell the user has', () => {
    for (const shell of ['bash', 'zsh', 'dash', 'fish']) {
      const wrapper = buildWestWrapperScript(shell, '/home/u/.zinstaller/env.sh', env)!;
      assert.equal(wrapper.fileName, 'west_wrapper.sh');
      assert.ok(wrapper.content.startsWith('#!/bin/bash\n'));
      assert.ok(wrapper.content.includes(`export ZEPHYR_BASE='/w s/zephyr'\n`), shell);
      assert.ok(wrapper.content.includes(`export QUOTE='it'\\''s "quoted" $HOME 100%'\n`), shell);
      assert.ok(wrapper.content.includes(`export EXTRA_CONF_FILE='a.conf;b.conf'\n`), shell);
      assert.ok(wrapper.content.includes('. /home/u/.zinstaller/env.sh && west "$@"'), shell);
    }
  });

  it('writes PowerShell assignments in single quotes, for both PowerShells', () => {
    for (const shell of ['powershell.exe', 'pwsh.exe']) {
      const wrapper = buildWestWrapperScript(shell, 'C:\\z\\env.ps1', env)!;
      assert.equal(wrapper.fileName, 'west_wrapper.ps1');
      assert.ok(wrapper.content.includes(`$env:QUOTE = 'it''s "quoted" $HOME 100%'\n`), shell);
      assert.ok(wrapper.content.includes(`$env:ZEPHYR_BASE = '/w s/zephyr'\n`), shell);
      assert.ok(wrapper.content.includes('. C:\\z\\env.ps1 ; west $args'), shell);
    }
  });

  it('leaves out empty values, names that are not identifiers and values on several lines', () => {
    for (const shell of ['cmd.exe', 'bash', 'pwsh.exe']) {
      const content = buildWestWrapperScript(shell, 'env', env)!.content;
      for (const left of ['EMPTY', 'NONE', 'BAD-NAME', 'MULTI']) {
        assert.ok(!content.includes(left), `${shell} keeps ${left}`);
      }
    }
  });

  it('writes no wrapper for a shell it does not know', () => {
    assert.equal(buildWestWrapperScript('tcsh', 'env', env), undefined);
  });

  it('exports PYTHON_VENV_PATH and quotes the paths of the application it writes for', () => {
    const f = makeDebugFixture();
    try {
      const file = createWestWrapper(f.app(), 'primary')!;
      assert.equal(file, path.join(f.appRoot, 'build', 'primary', '.debug', wrapperName));
      const content = fs.readFileSync(file, 'utf8');
      const expected = process.platform === 'win32' ? `set "PYTHON_VENV_PATH=${f.venv}"` : `export PYTHON_VENV_PATH='${f.venv}'`;
      assert.ok(content.includes(expected), content);
      assert.ok(content.includes(process.platform === 'win32' ? `set "ZEPHYR_BASE=${path.join(f.ws, 'zephyr')}"` : `export ZEPHYR_BASE='${path.join(f.ws, 'zephyr')}'`), content);
      assert.equal(createWestWrapper(f.app(), 'missing'), undefined);
    } finally {
      f.restore();
    }
  });

  it('refuses to write one without the environment script', () => {
    const f = makeDebugFixture();
    try {
      delete f.window.user['zephyr-workbench.pathToEnvScript'];
      assert.throws(() => createWestWrapper(f.app(), 'primary'), (error: Error) => String((error as { cause?: unknown }).cause).includes('pathToEnvScript'));
    } finally {
      f.restore();
    }
  });
});

describe('debug setup: reading launch.json', () => {
  it('reads JSON with comments and trailing commas as VS Code does, and says so', () => {
    assert.deepEqual(parseLaunchJsonText('{"version":"0.2.0","configurations":[]}'), { launchJson: { version: '0.2.0', configurations: [] }, strict: true });
    const commented = parseLaunchJsonText('{\n  // Use IntelliSense\n  "version": "0.2.0",\n  "configurations": [{"name": "a",},],\n}');
    assert.deepEqual(commented, { launchJson: { version: '0.2.0', configurations: [{ name: 'a' }] }, strict: false });
    assert.equal(parseLaunchJsonText('   '), undefined);
    assert.equal(parseLaunchJsonText('{ "version": '), undefined);
    assert.equal(parseLaunchJsonText('[1, 2]'), undefined);
  });

  it('skips a UTF-8 BOM, as VS Code does', () => {
    assert.deepEqual(parseLaunchJsonText('﻿{"version":"0.2.0","configurations":[]}'), { launchJson: { version: '0.2.0', configurations: [] }, strict: true });
    assert.deepEqual(parseLaunchJsonText('﻿// c\n{"configurations":[{"name":"a",},]}'), { launchJson: { configurations: [{ name: 'a' }] }, strict: false });
    assert.equal(parseLaunchJsonText('﻿  '), undefined);
    const f = makeDebugFixture();
    try {
      const text = '﻿{ "version": "0.2.0", "configurations": [{ "name": "Mine" }] }';
      f.writeLaunchJson(text);
      const file = readLaunchJsonFile(f.app());
      assert.equal(file.unreadable, false);
      assert.deepEqual(file.launchJson, { version: '0.2.0', configurations: [{ name: 'Mine' }] });
      // The text as read, to compare with the file again before writing.
      assert.equal(file.text, text);
    } finally {
      f.restore();
    }
  });

  it('leaves a commented file as it is when a toolchain change removes the entries of an application', async () => {
    const f = makeDebugFixture();
    try {
      const entries = [{ name: 'Mine', type: 'node' }, { name: 'Zephyr Workbench Debug [primary]', type: 'cppdbg' }];
      const commented = `// c\n${JSON.stringify({ version: '0.2.0', configurations: entries })}`;
      f.writeLaunchJson(commented);
      assert.equal(await removeApplicationLaunchConfigurations(f.app()), 0);
      assert.equal(fs.readFileSync(f.launchJsonPath, 'utf8'), commented);
      f.writeLaunchJson(`﻿${JSON.stringify({ version: '0.2.0', configurations: entries })}`);
      assert.equal(await removeApplicationLaunchConfigurations(f.app()), 1);
      assert.deepEqual(f.readLaunchJson().configurations, [entries[0]]);
    } finally {
      f.restore();
    }
  });

  it('tells a missing file, an empty one, an unreadable one and one without configurations apart', () => {
    const f = makeDebugFixture();
    try {
      const app = f.app();
      assert.deepEqual(readLaunchJsonFile(app), { path: f.launchJsonPath, exists: false, hasComments: false, unreadable: false });
      f.writeLaunchJson('');
      assert.equal(readLaunchJsonFile(app).launchJson, undefined);
      f.writeLaunchJson('{ nope');
      assert.equal(readLaunchJsonFile(app).unreadable, true);
      f.writeLaunchJson('{ "version": "0.2.0" }');
      assert.deepEqual(readLaunchJsonFile(app).launchJson, { version: '0.2.0', configurations: [] });
      f.writeLaunchJson('// c\n{ "configurations": [] }');
      assert.equal(readLaunchJsonFile(app).hasComments, true);
    } finally {
      f.restore();
    }
  });
});

describe('debug setup: the entries of an application', () => {
  let f: DebugFixture;
  afterEach(() => f?.restore());

  it('lists its Workbench entries, marks stale ones and the sysbuild entries saved without a domain', () => {
    f = makeDebugFixture({ withSysbuild: true });
    const app = f.app();
    const launchJson = {
      configurations: [
        { name: 'Zephyr Workbench Debug [primary]', type: 'cppdbg', program: PROGRAM, setupCommands: [{ text: '-target-download', description: 'flash target' }], debugServerArgs: 'debugserver --runner jlink --gdb-port 2331' },
        { name: 'Zephyr Workbench Debug [gone]', type: 'zephyr-workbench', program: 'x', debugServerArgs: 'debugserver --runner openocd', gdbTarget: 'localhost:3333' },
        { name: 'Zephyr Workbench Debug [sys]', type: 'cortex-debug', servertype: 'jlink', executable: 'e', request: 'attach' },
        { name: 'Zephyr Workbench Debug [sys] (mcuboot)', type: 'cppdbg', program: 'm' },
        { name: 'Unrelated', type: 'node' },
        'not an object',
      ],
    };
    const entries = listApplicationDebugEntries(app, launchJson);
    assert.deepEqual(entries.map(e => ({
      name: e.name, index: e.index, backend: e.backend, config: e.configName, domain: e.domain, runner: e.runner, mode: e.mode, port: e.gdbPort, stale: e.stale, legacy: e.legacy,
    })), [
      { name: 'Zephyr Workbench Debug [primary]', index: 0, backend: 'cppdbg', config: 'primary', domain: undefined, runner: 'jlink', mode: 'program', port: '3333', stale: false, legacy: undefined },
      { name: 'Zephyr Workbench Debug [gone]', index: 1, backend: 'cortex-west', config: 'gone', domain: undefined, runner: 'openocd', mode: 'program', port: '3333', stale: true, legacy: undefined },
      { name: 'Zephyr Workbench Debug [sys]', index: 2, backend: 'cortex-native', config: 'sys', domain: 'app', runner: 'jlink', mode: 'attach', port: undefined, stale: false, legacy: 'no-domain' },
      { name: 'Zephyr Workbench Debug [sys] (mcuboot)', index: 3, backend: 'cppdbg', config: 'sys', domain: 'mcuboot', runner: undefined, mode: 'attach', port: '3333', stale: false, legacy: undefined },
    ]);
    const sys = app.getBuildConfiguration('sys')!;
    assert.equal(findApplicationDebugEntry(app, entries, sys, 'app')?.name, 'Zephyr Workbench Debug [sys]');
    assert.equal(findApplicationDebugEntry(app, entries, sys, 'mcuboot')?.index, 3);
    assert.equal(findApplicationDebugEntry(app, entries, app.getBuildConfiguration('primary')!)?.index, 0);
  });

  it('keeps a west workspace application to its own entries, and adopts the freestanding names of its configurations', () => {
    f = makeDebugFixture();
    const real = f.app();
    const folder = { uri: { fsPath: f.root }, name: 'ws', index: 0 };
    const app = {
      isWestWorkspaceApplication: true,
      appName: 'app',
      appRootPath: f.appRoot,
      appWorkspaceFolder: folder,
      buildConfigs: real.buildConfigs,
      getBuildConfiguration: (name: string) => real.buildConfigs.find(config => config.name === name),
    } as unknown as ZephyrApplication;
    const entries = listApplicationDebugEntries(app, {
      configurations: [
        { name: 'Zephyr Workbench Debug: app [primary]', type: 'cppdbg' },
        { name: 'Zephyr Workbench Debug: other/app [primary]', type: 'cppdbg' },
        { name: 'Zephyr Workbench Debug [primary]', type: 'cppdbg' },
        { name: 'Zephyr Workbench Debug [elsewhere]', type: 'cppdbg' },
      ],
    });
    assert.deepEqual(entries.map(e => [e.name, e.legacy]), [
      ['Zephyr Workbench Debug: app [primary]', undefined],
      ['Zephyr Workbench Debug [primary]', 'freestanding-name'],
    ]);
    assert.equal(findApplicationDebugEntry(app, entries.slice(1), real.getBuildConfiguration('primary')!)?.name, 'Zephyr Workbench Debug [primary]');
  });
});

describe('debug setup: pyOCD target support, read only', () => {
  let saved: unknown;
  let f: DebugFixture;
  beforeEach(() => { saved = execUtils.checkPyOCDTarget; });
  afterEach(() => {
    execUtils.checkPyOCDTarget = saved;
    f?.restore();
  });

  it('asks pyOCD about the target of runners.yaml, in the venv of the application', async () => {
    f = makeDebugFixture();
    const calls: unknown[][] = [];
    execUtils.checkPyOCDTarget = async (...args: unknown[]) => { calls.push(args); return false; };
    const app = f.app();
    assert.deepEqual(await checkPyOCDTargetSupport(app, app.getBuildConfiguration('primary')!), { target: 'nrf52840', installed: false });
    assert.deepEqual(calls, [['nrf52840', f.venv]]);
    execUtils.checkPyOCDTarget = async () => true;
    assert.deepEqual(await checkPyOCDTargetSupport(app, app.getBuildConfiguration('primary')!), { target: 'nrf52840', installed: true });
  });

  it('reports a build without target, and a pyOCD that cannot run', async () => {
    f = makeDebugFixture({ primary: { pyocdTarget: null } });
    execUtils.checkPyOCDTarget = async () => { throw new Error('pyocd: command not found'); };
    const app = f.app();
    assert.deepEqual(await checkPyOCDTargetSupport(app, app.getBuildConfiguration('primary')!), {});
    f.restore();
    f = makeDebugFixture();
    const other = f.app();
    assert.deepEqual(await checkPyOCDTargetSupport(other, other.getBuildConfiguration('primary')!), { target: 'nrf52840', error: 'pyocd: command not found' });
  });
});
