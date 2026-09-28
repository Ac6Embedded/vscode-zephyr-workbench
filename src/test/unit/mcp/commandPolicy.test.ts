// The commands run_command refuses before asking the user, and the ones it
// lets through: the match is on words, so a mention inside a quoted argument
// or a file name is not a command.

import { strict as assert } from 'assert';
import { McpToolError } from '../../../mcp/core/errors';
import { RUN_COMMAND_MAX_CHARS } from '../../../mcp/core/tools/runCommand';
import { buildsInFolder, checkCommand, commandWords, installsInVenv } from '../../../mcp/host/commandPolicy';

function refusal(command: unknown, kind = 'bash'): McpToolError {
  try {
    checkCommand(command, kind);
  } catch (error) {
    assert.ok(error instanceof McpToolError, String(error));
    return error;
  }
  throw new Error(`"${String(command)}" was not refused`);
}

describe('mcp/host/commandPolicy', () => {
  describe('commandWords', () => {
    it('splits a line into simple commands on the separators of bash, PowerShell and cmd', () => {
      assert.deepEqual(commandWords('cd build && west boards; echo done | tee x & y'), [
        ['cd', 'build'], ['west', 'boards'], ['echo', 'done'], ['tee', 'x'], ['y'],
      ]);
      assert.deepEqual(commandWords('echo $(west flash)'), [['echo', '$'], ['west', 'flash']]);
      assert.deepEqual(commandWords('& { west flash }'), [['west', 'flash']]);
      assert.deepEqual(commandWords('a\nb\r\nc'), [['a'], ['b'], ['c']]);
    });

    it('keeps quoted text and ${NAME} whole', () => {
      assert.deepEqual(commandWords('echo "a; b" \'c && d\''), [['echo', 'a; b', 'c && d']]);
      assert.deepEqual(commandWords('west build -d ${BUILD_DIR} -t menuconfig'), [['west', 'build', '-d', '${BUILD_DIR}', '-t', 'menuconfig']]);
      assert.deepEqual(commandWords('echo ""'), [['echo', '']]);
    });
  });

  describe('checkCommand', () => {
    it('passes what no other tool covers, trimmed', () => {
      for (const command of [
        'west boards', 'west build -t rom_report', 'python scripts/gen.py', 'nrfutil device list',
        'grep -r menuconfig .', 'echo "west flash"', 'west blobs list', 'west update-notes', 'cmake --build build -t ram_report',
        'west build -p always -b nrf52840dk/nrf52840', 'ls ./menuconfig.log',
      ]) {
        assert.equal(checkCommand(`  ${command}\n`, 'bash'), command, command);
      }
    });

    it('allows shell operators, since this is a shell', () => {
      assert.equal(checkCommand('west boards | grep nrf > boards.txt && cat boards.txt', 'bash'), 'west boards | grep nrf > boards.txt && cat boards.txt');
    });

    it('refuses menuconfig and guiconfig however they are started, pointing at open_in_workbench', () => {
      for (const command of [
        'menuconfig', 'guiconfig', 'MenuConfig', 'west build -t menuconfig', 'west build -tguiconfig', 'west build --target=menuconfig',
        'west build --target guiconfig', 'west -v build -d build/primary -t menuconfig', 'ninja -C build menuconfig', 'make menuconfig',
        'cmake --build build --target menuconfig', 'cd build && ninja guiconfig', 'python -m west build -t menuconfig',
        'C:\\tools\\west.exe build -t menuconfig', 'west build -d ${BUILD_DIR} -t menuconfig',
      ]) {
        const error = refusal(command);
        assert.equal(error.code, 'INTERACTIVE_UNSUPPORTED', command);
        assert.match(error.hint ?? '', /open_in_workbench with target "menuconfig"/, command);
      }
    });

    it('refuses west debug, attach and rtt as interactive, pointing at debug_app', () => {
      for (const command of ['west debug', 'west attach --runner jlink', 'WEST RTT', 'west -z /opt/zephyr debug']) {
        const error = refusal(command);
        assert.equal(error.code, 'INTERACTIVE_UNSUPPORTED', command);
        assert.match(error.hint ?? '', /debug_app/, command);
      }
    });

    it('sends west debugserver to debug_app and west flash to the hardware tool', () => {
      const server = refusal('west debugserver');
      assert.equal(server.code, 'INVALID_ARGUMENT');
      assert.match(server.hint ?? '', /debug_app/);
      for (const command of ['west flash', 'west flash --runner jlink', 'west.exe Flash', 'west build && west flash', 'call west flash', 'FOO=1 west flash', 'env -i PATH=/bin west flash']) {
        const error = refusal(command);
        assert.equal(error.code, 'INVALID_ARGUMENT', command);
        assert.match(error.hint ?? '', /hardware with action "flash"/, command);
      }
    });

    it('refuses the flash and debug build targets as it refuses the west commands they run', () => {
      for (const command of [
        'west build -t flash', 'west build --target=flash', 'ninja flash', 'ninja -C build flash', 'make flash', 'make -j flash',
        'cmake --build build -t flash', 'python -u -m west flash', 'py -3 -m west flash', 'py -3.12 -m west flash', 'python -X utf8 -m west flash',
        'python3 -mwest flash',
      ]) {
        const error = refusal(command);
        assert.equal(error.code, 'INVALID_ARGUMENT', command);
        assert.match(error.hint ?? '', /hardware with action "flash"/, command);
      }
      assert.match(refusal('ninja -C build flash').message, /^ninja flash is not run through run_command/);
      for (const command of ['cmake --build . -t debugserver', 'ninja debugserver']) {
        const error = refusal(command);
        assert.equal(error.code, 'INVALID_ARGUMENT', command);
        assert.match(error.hint ?? '', /debug_app/, command);
      }
      for (const command of ['west build -t debug', 'west build -t attach', 'ninja rtt']) {
        const error = refusal(command);
        assert.equal(error.code, 'INTERACTIVE_UNSUPPORTED', command);
        assert.match(error.hint ?? '', /debug_app/, command);
      }
    });

    it('passes help, and a folder or a module that only shares a name with a target', () => {
      for (const command of [
        'west flash --help', 'west flash -h', 'west flash -H -r jlink', 'west debug --help', 'west update --help', 'west blobs fetch --help',
        'ninja -C flash', 'cmake -S . -B flash', 'make -f flash', 'python -m pip install west', 'python -c "import west" flash',
      ]) {
        assert.equal(checkCommand(command, 'bash'), command, command);
      }
    });

    it('sends west update and west blobs fetch to manage_west_workspace', () => {
      for (const command of ['west update', 'west update hal_nordic', 'python3 -m west update']) {
        const error = refusal(command);
        assert.equal(error.code, 'INVALID_ARGUMENT', command);
        assert.match(error.hint ?? '', /manage_west_workspace with action "update"/, command);
      }
      const blobs = refusal('west blobs fetch hal_espressif');
      assert.equal(blobs.code, 'INVALID_ARGUMENT');
      assert.match(blobs.hint ?? '', /manage_west_workspace with action "fetch_blobs"/);
    });

    it('looks inside the command line a shell is given', () => {
      for (const command of ['bash -c "west flash"', 'sh -lc \'west update\'', 'cmd /c west flash', 'powershell -Command "west flash"', 'pwsh -c west debug']) {
        assert.ok(['INVALID_ARGUMENT', 'INTERACTIVE_UNSUPPORTED'].includes(refusal(command).code), command);
      }
      assert.equal(checkCommand('bash -c "west boards"', 'bash'), 'bash -c "west boards"');
    });

    it('refuses an empty, missing or over-long command', () => {
      for (const command of [undefined, '', '   \n', 42]) {
        assert.equal(refusal(command).code, 'INVALID_ARGUMENT', String(command));
      }
      const long = refusal(`echo ${'x'.repeat(RUN_COMMAND_MAX_CHARS)}`);
      assert.equal(long.code, 'INVALID_ARGUMENT');
      assert.match(long.message, /more than the 4000 allowed/);
      assert.equal(refusal('echo a\u0000b').code, 'INVALID_ARGUMENT');
    });

    it('refuses a command of several lines only for cmd, which would drop all but the first', () => {
      assert.equal(checkCommand('west boards\nwest list', 'bash'), 'west boards\nwest list');
      assert.equal(checkCommand('west boards\nwest list', 'powershell.exe'), 'west boards\nwest list');
      const error = refusal('west boards\nwest list', 'cmd.exe');
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.match(error.hint ?? '', /run_command once for each/);
    });
  });

  describe('buildsInFolder', () => {
    it('finds a command that writes a build folder, however it is started', () => {
      for (const command of [
        'west build -p always -b nrf52840dk/nrf52840', 'west build -t rom_report', 'python -m west build', 'ninja -C build',
        'ninja rom_report', 'make', 'cmake --build build', 'cd build && cmake --build .', 'bash -c "west build"', 'cmd /c west build',
      ]) {
        assert.equal(buildsInFolder(command), true, command);
      }
    });

    it('passes a command that only reads', () => {
      for (const command of ['west boards', 'cmake -B x -S .', 'echo west build', 'python gen.py', 'west list', 'grep ninja build.ninja']) {
        assert.equal(buildsInFolder(command), false, command);
      }
    });
  });

  describe('installsInVenv', () => {
    it('finds a pip install or uninstall, however it is started', () => {
      for (const command of [
        'pip install -U pyocd', 'pip3 install pyocd', 'pip3.12 uninstall -y pyocd', 'python -m pip install pyocd', 'py -3 -m pip install pyocd',
        'python3 -mpip install -r requirements.txt', 'C:\\venv\\Scripts\\pip.exe install pyocd', 'cd x && pip install .', 'bash -c "pip install pyocd"',
        'python3.12 -m pip install pyocd', 'west packages pip --install', 'python -m west packages pip --install',
        'uv pip install pyocd', 'uv pip sync requirements.txt',
      ]) {
        assert.equal(installsInVenv(command), true, command);
      }
    });

    it('passes pip that only reads, and a command that only names pip', () => {
      for (const command of ['pip list', 'pip show pyocd', 'python -m pip freeze', 'echo pip install', 'python install.py', 'west packages pip']) {
        assert.equal(installsInVenv(command), false, command);
      }
    });
  });
});
