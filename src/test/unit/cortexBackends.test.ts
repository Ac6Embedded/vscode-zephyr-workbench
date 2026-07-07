import { strict as assert } from 'assert';

import {
  assembleCortexDebugBaseConfig,
  deriveToolchainFromGdbPath,
} from '../../debug/backends/cortexCommon';
import {
  buildCortexWestLaunchConfig,
  getExternalLaunchOverrides,
  transformToExternalCortexConfig,
} from '../../debug/backends/cortexWest';
import {
  buildCortexNativeLaunchConfig,
  extractJlinkDeviceFromBoardCmakeText,
  extractJlinkDeviceFromRunnersYaml,
} from '../../debug/backends/cortexNative';
import { getDefaultGdbPort, runnerNameToNativeServer } from '../../debug/backends/types';
import { parseRunnersYamlText } from '../../utils/zephyr/runnersYamlUtils';

describe('cortex backends', () => {
  describe('deriveToolchainFromGdbPath', () => {
    it('derives the Zephyr SDK prefix from a posix path', () => {
      assert.deepEqual(
        deriveToolchainFromGdbPath('/opt/zephyr-sdk/arm-zephyr-eabi/bin/arm-zephyr-eabi-gdb'),
        { armToolchainPath: '/opt/zephyr-sdk/arm-zephyr-eabi/bin', toolchainPrefix: 'arm-zephyr-eabi' },
      );
    });

    it('handles windows paths and .exe', () => {
      assert.deepEqual(
        deriveToolchainFromGdbPath('C:\\zephyr-sdk\\arm-zephyr-eabi\\bin\\arm-zephyr-eabi-gdb.exe'),
        { armToolchainPath: 'C:\\zephyr-sdk\\arm-zephyr-eabi\\bin', toolchainPrefix: 'arm-zephyr-eabi' },
      );
    });

    it('keeps ${config:...} tokens intact', () => {
      assert.deepEqual(
        deriveToolchainFromGdbPath('${config:zephyr-workbench.sdk}/arm-zephyr-eabi/bin/arm-zephyr-eabi-gdb'),
        {
          armToolchainPath: '${config:zephyr-workbench.sdk}/arm-zephyr-eabi/bin',
          toolchainPrefix: 'arm-zephyr-eabi',
        },
      );
    });

    it('handles gdb-py variants', () => {
      assert.equal(
        deriveToolchainFromGdbPath('/sdk/bin/arm-none-eabi-gdb-py').toolchainPrefix,
        'arm-none-eabi',
      );
    });

    it('returns nothing for a prefix-less gdb', () => {
      assert.deepEqual(deriveToolchainFromGdbPath('/usr/bin/gdb'), {});
    });
  });

  describe('assembleCortexDebugBaseConfig', () => {
    it('maps program mode to launch + runToEntryPoint', () => {
      const config = assembleCortexDebugBaseConfig({
        name: 'Zephyr Workbench Debug [primary]',
        cwd: '${workspaceFolder}',
        programPath: '${workspaceFolder}/build/primary/zephyr/zephyr.elf',
        gdbMode: 'program',
      });
      assert.equal(config.type, 'cortex-debug');
      assert.equal(config.request, 'launch');
      assert.equal(config.runToEntryPoint, 'main');
      assert.ok(!('svdFile' in config));
      assert.ok(!('gdbPath' in config));
    });

    it('maps attach mode and omits runToEntryPoint', () => {
      const config = assembleCortexDebugBaseConfig({
        name: 'n', cwd: 'c', programPath: 'p', gdbMode: 'attach',
      });
      assert.equal(config.request, 'attach');
      assert.ok(!('runToEntryPoint' in config));
    });
  });

  describe('getExternalLaunchOverrides', () => {
    it('leaves openocd/pyocd on cortex-debug defaults', () => {
      assert.deepEqual(getExternalLaunchOverrides('openocd', 'program'), {});
      assert.deepEqual(getExternalLaunchOverrides('pyocd', 'program'), {});
    });

    it('overrides the jlink launch sequence', () => {
      assert.deepEqual(getExternalLaunchOverrides('jlink', 'program'), {
        overrideLaunchCommands: ['monitor halt', 'load', 'monitor reset'],
        overrideRestartCommands: ['monitor reset'],
      });
    });

    it('never overrides attach', () => {
      assert.deepEqual(getExternalLaunchOverrides('jlink', 'attach'), {});
      assert.deepEqual(getExternalLaunchOverrides('stlink_gdbserver', 'attach'), {});
    });
  });

  describe('buildCortexWestLaunchConfig + transformToExternalCortexConfig', () => {
    const stored = buildCortexWestLaunchConfig({
      name: 'Zephyr Workbench Debug [primary]',
      cwd: '${workspaceFolder}',
      programPath: '${workspaceFolder}/build/primary/zephyr/zephyr.elf',
      svdPath: '',
      gdbPath: '${config:zephyr-workbench.sdk}/arm-zephyr-eabi/bin/arm-zephyr-eabi-gdb',
      gdbMode: 'program',
      gdbAddress: 'localhost',
      gdbPort: '2331',
    }, 'debugserver --build-dir "${workspaceFolder}/build/primary" --runner jlink --gdb-port 2331');

    it('persists a zephyr-workbench entry with no cppdbg keys', () => {
      assert.equal(stored.type, 'zephyr-workbench');
      assert.equal(stored.gdbTarget, 'localhost:2331');
      assert.equal(stored.gdbMode, 'program');
      for (const key of ['setupCommands', 'debugServerPath', 'serverStarted', 'MIMode', 'servertype', 'device']) {
        assert.ok(!(key in stored), `unexpected key ${key}`);
      }
    });

    it('transforms to a cortex-debug external config with the server token', () => {
      const runtime = transformToExternalCortexConfig(stored, {
        program: '/abs/app/build/primary/zephyr/zephyr.elf',
        cwd: '/abs/app',
        gdbTarget: 'localhost:2331',
        runnerName: 'jlink',
        serverToken: 'token-1',
      });
      assert.equal(runtime.type, 'cortex-debug');
      assert.equal(runtime.servertype, 'external');
      assert.equal(runtime.gdbTarget, 'localhost:2331');
      assert.equal(runtime.executable, '/abs/app/build/primary/zephyr/zephyr.elf');
      assert.equal(runtime.toolchainPrefix, 'arm-zephyr-eabi');
      assert.deepEqual(runtime.overrideLaunchCommands, ['monitor halt', 'load', 'monitor reset']);
      assert.equal(runtime.__zwServerToken, 'token-1');
    });

    it('attach transform has no overrides and request attach', () => {
      const attachStored = { ...stored, gdbMode: 'attach' };
      const runtime = transformToExternalCortexConfig(attachStored, {
        program: 'p', cwd: 'c', gdbTarget: 'localhost:2331', runnerName: 'jlink',
      });
      assert.equal(runtime.request, 'attach');
      assert.ok(!('overrideLaunchCommands' in runtime));
      assert.ok(!('runToEntryPoint' in runtime));
      assert.ok(!('__zwServerToken' in runtime));
    });
  });

  describe('buildCortexNativeLaunchConfig', () => {
    it('builds a jlink config with device/interface/serverArgs', () => {
      const config = buildCortexNativeLaunchConfig({
        name: 'Zephyr Workbench Debug [primary]',
        cwd: '${workspaceFolder}',
        programPath: '${workspaceFolder}/build/primary/zephyr/zephyr.elf',
        svdPath: '',
        gdbPath: '/sdk/bin/arm-zephyr-eabi-gdb',
        gdbMode: 'program',
        server: 'jlink',
        device: 'EFR32MG24BxxxF1536',
        interface: 'swd',
        serverPath: '/Applications/SEGGER/JLink/JLinkGDBServerCLExe',
        serverArgs: '-speed 4000 "-jlinkscript with space.script"',
      });
      assert.equal(config.servertype, 'jlink');
      assert.equal(config.device, 'EFR32MG24BxxxF1536');
      assert.equal(config.interface, 'swd');
      assert.equal(config.serverpath, '/Applications/SEGGER/JLink/JLinkGDBServerCLExe');
      assert.deepEqual(config.serverArgs, ['-speed', '4000', '-jlinkscript with space.script']);
      for (const key of ['debugServerArgs', 'gdbTarget', 'miDebuggerPath', 'program', 'stm32cubeprogrammer']) {
        assert.ok(!(key in config), `unexpected key ${key}`);
      }
    });

    it('keeps an empty device key for jlink but omits it for stlink', () => {
      const jlink = buildCortexNativeLaunchConfig({
        name: 'n', cwd: 'c', programPath: 'p', gdbMode: 'program', server: 'jlink',
      });
      assert.equal(jlink.device, '');

      const stlink = buildCortexNativeLaunchConfig({
        name: 'n', cwd: 'c', programPath: 'p', gdbMode: 'attach', server: 'stlink',
        stm32CubeProgrammerDir: '/opt/st/stm32cubeclt/STM32CubeProgrammer/bin',
      });
      assert.ok(!('device' in stlink));
      assert.equal(stlink.servertype, 'stlink');
      assert.equal(stlink.stm32cubeprogrammer, '/opt/st/stm32cubeclt/STM32CubeProgrammer/bin');
      assert.equal(stlink.request, 'attach');
    });
  });

  describe('J-Link device detection sources', () => {
    it('reads --device=X from runners.yaml args', () => {
      const runnersYaml = parseRunnersYamlText([
        'runners:',
        '- jlink',
        'debug-runner: jlink',
        'args:',
        '  jlink:',
        '  - --device=EFR32MG24BxxxF1536',
        '  - --speed=4000',
      ].join('\n'));
      assert.equal(extractJlinkDeviceFromRunnersYaml(runnersYaml), 'EFR32MG24BxxxF1536');
    });

    it('reads the two-token --device X form', () => {
      const runnersYaml = parseRunnersYamlText([
        'runners:',
        '- jlink',
        'args:',
        '  jlink:',
        '  - --device',
        '  - nRF52840_xxAA',
      ].join('\n'));
      assert.equal(extractJlinkDeviceFromRunnersYaml(runnersYaml), 'nRF52840_xxAA');
    });

    it('returns undefined when args.jlink is missing', () => {
      const runnersYaml = parseRunnersYamlText('runners:\n- openocd\n');
      assert.equal(extractJlinkDeviceFromRunnersYaml(runnersYaml), undefined);
    });

    it('parses the literal board.cmake idiom', () => {
      const text = [
        'board_runner_args(stm32cubeprogrammer "--port=swd" "--reset-mode=hw")',
        'board_runner_args(jlink "--device=STM32F429ZI" "--speed=4000")',
        'include(${ZEPHYR_BASE}/boards/common/jlink.board.cmake)',
      ].join('\n');
      assert.equal(extractJlinkDeviceFromBoardCmakeText(text), 'STM32F429ZI');
    });

    it('returns undefined when board.cmake has no jlink args', () => {
      assert.equal(
        extractJlinkDeviceFromBoardCmakeText('include(${ZEPHYR_BASE}/boards/common/openocd.board.cmake)'),
        undefined,
      );
    });
  });

  describe('runner defaults', () => {
    it('maps default GDB ports per runner', () => {
      assert.equal(getDefaultGdbPort('jlink'), '2331');
      assert.equal(getDefaultGdbPort('openocd'), '3333');
      assert.equal(getDefaultGdbPort('stlink_gdbserver'), '61234');
      assert.equal(getDefaultGdbPort(undefined), '3333');
    });

    it('maps native runner names to servertypes', () => {
      assert.equal(runnerNameToNativeServer('jlink'), 'jlink');
      assert.equal(runnerNameToNativeServer('stlink_gdbserver'), 'stlink');
      assert.equal(runnerNameToNativeServer('openocd'), undefined);
    });
  });
});
