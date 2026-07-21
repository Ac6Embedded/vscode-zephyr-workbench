import { strict as assert } from 'assert';
import path from 'path';

// vscode imports in these modules resolve to the stub under
// src/test/unit/stubs (NODE_PATH), like the other unit tests.
import { Qemu } from '../../debug/runners/Qemu';
import { WestRunner } from '../../debug/runners/WestRunner';
import { getSetupCommands, getGdbMode } from '../../debug/gdbUtils';
import { getExternalLaunchOverrides } from '../../debug/backends/cortexWest';
import { ZephyrBoard } from '../../models/ZephyrBoard';

const BOARDS_FIXTURE_DIR = path.join(__dirname, 'fixtures', 'boards');

describe('QEMU debug runner', () => {
  describe('Qemu.getWestDebugArgs', () => {
    it('emits the debugserver_qemu CMake target with no --runner/--gdb-port', () => {
      const runner = new Qemu();
      assert.equal(
        runner.getWestDebugArgs('build/app'),
        'build -t debugserver_qemu --build-dir "${workspaceFolder}/build/app"',
      );
    });

    it('appends user args when present', () => {
      const runner = new Qemu();
      runner.userArgs = '--foo bar';
      assert.equal(
        runner.getWestDebugArgs('build/app'),
        'build -t debugserver_qemu --build-dir "${workspaceFolder}/build/app" --foo bar',
      );
    });

    it('exposes no autoArgs', () => {
      assert.equal(new Qemu().autoArgs, '');
    });
  });

  describe('loadArgs round trip', () => {
    it('produces empty userArgs from its own generated args', () => {
      const runner = new Qemu();
      const args = runner.getWestDebugArgs('build/app');
      const fresh = new Qemu();
      fresh.loadArgs(args);
      assert.equal(fresh.userArgs, '');
    });

    it('keeps unrecognized user flags', () => {
      const runner = new Qemu();
      runner.loadArgs('build -t debugserver_qemu --build-dir "x" extraflag');
      assert.equal(runner.userArgs, 'extraflag');
    });
  });

  describe('WestRunner.extractRunner', () => {
    it('recovers qemu from the debugserver_qemu target', () => {
      assert.equal(
        WestRunner.extractRunner('build -t debugserver_qemu --build-dir "x"'),
        'qemu',
      );
    });

    it('still recovers an explicit --runner (regression)', () => {
      assert.equal(
        WestRunner.extractRunner('debugserver --runner openocd --build-dir "x"'),
        'openocd',
      );
    });

    it('returns undefined for args with neither marker', () => {
      assert.equal(WestRunner.extractRunner('debugserver --build-dir "x"'), undefined);
    });
  });

  describe('getSetupCommands (qemu)', () => {
    it('program mode skips monitor reset and target download', () => {
      const commands = getSetupCommands('/b/zephyr/zephyr.elf', 'localhost', '1234', 'program', 'qemu');
      const texts = commands.map(c => c.text);
      assert.ok(!texts.some(t => t.includes('monitor reset')));
      assert.ok(!texts.includes('-target-download'));
      assert.ok(texts.includes('tbreak main'));
      assert.ok(texts.some(t => t.includes('-target-select remote localhost:1234')));
    });

    it('non-qemu program mode still flashes and resets', () => {
      const commands = getSetupCommands('/b/zephyr/zephyr.elf', 'localhost', '3333', 'program', 'openocd');
      const texts = commands.map(c => c.text);
      assert.ok(texts.some(t => t.includes('monitor reset')));
      assert.ok(texts.includes('-target-download'));
    });
  });

  describe('getGdbMode (qemu)', () => {
    it('reads qemu program mode from the tbreak-main marker', () => {
      const program = getSetupCommands('/b/zephyr/zephyr.elf', 'localhost', '1234', 'program', 'qemu');
      assert.equal(getGdbMode(program, 'qemu'), 'program');
    });

    it('reads qemu attach mode when tbreak main is absent', () => {
      const attach = getSetupCommands('/b/zephyr/zephyr.elf', 'localhost', '1234', 'attach', 'qemu');
      assert.equal(getGdbMode(attach, 'qemu'), 'attach');
    });
  });

  describe('getExternalLaunchOverrides (qemu)', () => {
    it('program mode issues no load/reset and restarts with system_reset', () => {
      assert.deepEqual(getExternalLaunchOverrides('qemu', 'program'), {
        overrideLaunchCommands: [],
        overrideRestartCommands: ['monitor system_reset'],
      });
    });

    it('attach mode has no overrides', () => {
      assert.deepEqual(getExternalLaunchOverrides('qemu', 'attach'), {});
    });
  });

  describe('ZephyrBoard.supportsQemu', () => {
    it('is true for a qemu_ prefixed board name', () => {
      assert.equal(ZephyrBoard.fromIdentifier('qemu_cortex_m3').supportsQemu(), true);
    });

    it('is false for a hardware board name with no emulator support', () => {
      assert.equal(ZephyrBoard.fromIdentifier('nrf52dk/nrf52832').supportsQemu(), false);
    });

    it('is true when board.cmake sets SUPPORTED_EMU_PLATFORMS qemu', () => {
      const board = new ZephyrBoard(
        (require('vscode').Uri.file(path.join(BOARDS_FIXTURE_DIR, 'qemu-emu'))),
        'my_board',
      );
      assert.equal(board.supportsQemu(), true);
      assert.ok(board.getCompatibleRunners().includes('qemu'));
    });

    it('is true when qemu is one of several emulator platforms', () => {
      const board = new ZephyrBoard(
        (require('vscode').Uri.file(path.join(BOARDS_FIXTURE_DIR, 'multi-emu'))),
        'my_board',
      );
      assert.equal(board.supportsQemu(), true);
    });

    it('is false for a hardware-only board.cmake', () => {
      const board = new ZephyrBoard(
        (require('vscode').Uri.file(path.join(BOARDS_FIXTURE_DIR, 'hw-only'))),
        'my_board',
      );
      assert.equal(board.supportsQemu(), false);
      const runners = board.getCompatibleRunners();
      assert.ok(runners.includes('openocd'));
      assert.ok(!runners.includes('qemu'));
    });
  });
});
