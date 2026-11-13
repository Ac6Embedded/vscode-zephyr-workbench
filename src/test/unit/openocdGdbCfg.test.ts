// The OpenOCD gdb.cfg (Ac6Embedded/vscode-zephyr-workbench#225): createOpenocdCfg
// writes it in the build configuration's .debug folder, and the argument
// passing it to `west debugserver` must name that file, for a freestanding app
// and for a West workspace application, whose ${workspaceFolder} is the west
// workspace rather than the app. It is passed as `--cmd-pre-init "source {...}"`,
// not as a `--config` file: west's OpenOCD runner fails on a --config file when
// the board has no `support` folder.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
// debugUtils first: loading a runner module first runs into the
// WestRunner -> ... -> debugUtils -> Linkserver -> WestRunner import cycle.
import { createOpenocdCfg, getWestDebugArgsForProject, syncLaunchConfigurationProjectPaths } from '../../utils/debugTools/debugUtils';
import { JLink } from '../../debug/runners/JLink';
import { Openocd } from '../../debug/runners/Openocd';
import { ZephyrApplication } from '../../models/ZephyrApplication';
import {
  FakeUri, FakeWindow, installFakeWindow, makeApplicationFolder, makeWestWorkspace, readSettingsFile, tempDir, writeFile, writeSettingsFile,
} from './appTestWorkspace';

const BUILD_CONFIGS = [{ name: 'primary', board: 'nucleo_f401re', active: 'true' }];
const LEGACY_GDB_CFG = '${workspaceFolder}/build/.debug/gdb.cfg';

// The value of `flag` in the args once VS Code expands ${workspaceFolder}.
function argValue(debugServerArgs: string, flag: string, workspaceFolder: string, suffix = ''): string | undefined {
  return [...debugServerArgs.matchAll(new RegExp(`${flag}\\s+("[^"]*"|\\S+)`, 'g'))]
    .map(match => match[1].replace(/^"(.*)"$/, '$1'))
    .find(value => value.endsWith(suffix))
    ?.split('${workspaceFolder}').join(workspaceFolder);
}

// The gdb.cfg the args source, with ${workspaceFolder} expanded.
const gdbCfgArg = (args: string, folder: string) =>
  argValue(args, '--cmd-pre-init', folder, 'gdb.cfg}')?.replace(/^source \{(.*)\}$/, '$1');

function openocdArgs(app: ZephyrApplication, domain?: string): string {
  return getWestDebugArgsForProject(new Openocd(), app, app.getBuildConfiguration('primary')!, domain);
}

describe('OpenOCD gdb.cfg', () => {
  let window: FakeWindow | undefined;
  afterEach(() => {
    window?.restore();
    window = undefined;
  });

  function workspaceApplication(): { ws: string; app: ZephyrApplication } {
    const ws = makeWestWorkspace(tempDir('zw-openocd-ws-'));
    writeSettingsFile(ws, {
      'zephyr-workbench.westWorkspace.applications': [{ path: 'zephyr/samples/hello_world', 'build.configurations': BUILD_CONFIGS }],
    });
    window = installFakeWindow([ws]);
    ZephyrApplication.clearApplicationWorkspaceCache();
    const entry = readSettingsFile(ws)['zephyr-workbench.westWorkspace.applications'][0];
    const folder = { uri: FakeUri.file(ws), name: path.basename(ws), index: 0 } as never;
    return { ws, app: new ZephyrApplication(folder, path.join(ws, 'zephyr', 'samples', 'hello_world'), { workspaceApplicationSettings: entry }) };
  }

  function freestandingApplication(): ZephyrApplication {
    const appDir = makeApplicationFolder(tempDir('zw-openocd-app-'));
    writeSettingsFile(appDir, { 'zephyr-workbench.build.configurations': BUILD_CONFIGS });
    window = installFakeWindow([appDir]);
    ZephyrApplication.clearApplicationWorkspaceCache();
    return new ZephyrApplication({ uri: FakeUri.file(appDir), name: 'app', index: 0 } as never, appDir);
  }

  it('passes a West workspace application the gdb.cfg in its build configuration', () => {
    const { ws, app } = workspaceApplication();
    const args = openocdArgs(app);
    createOpenocdCfg(app, 'primary');

    assert.ok(args.includes('--cmd-pre-init "source {${workspaceFolder}/zephyr/samples/hello_world/build/primary/.debug/gdb.cfg}"'), args);
    assert.ok(!/--config\s+"?[^\s"]*gdb\.cfg/.test(args), 'not a --config file');
    const cfg = gdbCfgArg(args, ws)!;
    assert.equal(path.normalize(cfg), path.join(app.getBuildConfiguration('primary')!.getInternalDebugDir(app), 'gdb.cfg'));
    assert.ok(fs.existsSync(cfg));
  });

  it('passes a freestanding app the gdb.cfg in its build configuration', () => {
    const app = freestandingApplication();
    const args = openocdArgs(app);
    createOpenocdCfg(app, 'primary');

    assert.ok(args.includes('--cmd-pre-init "source {${workspaceFolder}/build/primary/.debug/gdb.cfg}"'), args);
    assert.ok(fs.existsSync(gdbCfgArg(args, app.appRootPath)!));
  });

  it('keeps gdb.cfg in the debug folder of the --build-dir directory, sysbuild domains included', () => {
    const { ws, app } = workspaceApplication();
    for (const args of [openocdArgs(app), openocdArgs(app, 'mcuboot')]) {
      const buildDir = argValue(args, '--build-dir', ws)!;
      assert.equal(gdbCfgArg(args, ws), `${buildDir}/.debug/gdb.cfg`);
    }
    assert.ok(openocdArgs(app, 'mcuboot').includes('--domain mcuboot'));
  });

  it('writes nothing without a build configuration, and leaves an older per-app gdb.cfg in place', () => {
    const { app } = workspaceApplication();
    const legacy = writeFile(path.join(app.appRootPath, 'build', '.debug', 'gdb.cfg'), '# older version\n');
    createOpenocdCfg(app);
    createOpenocdCfg(app, 'missing');
    assert.ok(!fs.existsSync(path.join(app.appRootPath, 'build', 'primary', '.debug', 'gdb.cfg')));

    createOpenocdCfg(app, 'primary');
    assert.equal(fs.readFileSync(legacy, 'utf8'), '# older version\n');
  });

  it('does not read any generated gdb.cfg back as a user argument', () => {
    const { app } = workspaceApplication();
    for (const stored of [
      openocdArgs(app),
      `debugserver --runner openocd --config openocd.cfg --config ${LEGACY_GDB_CFG}`,
      `debugserver --runner openocd --config openocd.cfg --config ${path.join(app.appRootPath, 'build', 'primary', '.debug', 'gdb.cfg')}`,
      `debugserver --runner openocd --config openocd.cfg --cmd-pre-init "source {${LEGACY_GDB_CFG}}"`,
    ]) {
      const runner = new Openocd();
      runner.loadArgs(`${stored} --config board-extra.cfg`);
      assert.equal(runner.userArgs, '--config board-extra.cfg', stored);
    }
  });

  it('does not force --config openocd.cfg, so the board config from runners.yaml is used', () => {
    const { app } = workspaceApplication();
    assert.ok(!openocdArgs(app).includes('openocd.cfg'), openocdArgs(app));
    assert.ok(!new Openocd().autoArgs.includes('--config'));
    assert.ok(!new Openocd().getWestFlashArgs('primary').includes('openocd.cfg'));
  });

  it('keeps a --cmd-pre-init of the user, and reads only the one sourcing gdb.cfg as generated', () => {
    const { app } = workspaceApplication();
    const runner = new Openocd();
    runner.loadArgs(`${openocdArgs(app)} --cmd-pre-init "echo hello" --cmd-pre-init "source {/work/other.cfg}"`);
    assert.equal(runner.userArgs, '--cmd-pre-init "echo hello" --cmd-pre-init "source {/work/other.cfg}"');
  });

  it('leaves other runners without a gdb.cfg', () => {
    assert.ok(!new JLink().getWestDebugArgs('build/primary').includes('gdb.cfg'));
  });

  for (const type of ['cppdbg', 'zephyr-workbench']) {
    it(`re-targets a ${type} entry written with the older per-app gdb.cfg before launch`, () => {
      const { ws, app } = workspaceApplication();
      const config = {
        name: 'Zephyr Workbench Debug: zephyr/samples/hello_world [primary]',
        type,
        miDebuggerPath: '/usr/bin/gdb',
        debugServerArgs: `debugserver --build-dir "\${workspaceFolder}/zephyr/samples/hello_world/build/primary" --runner openocd `
          + `--config openocd.cfg --config ${LEGACY_GDB_CFG} --config board-extra.cfg`,
      };
      syncLaunchConfigurationProjectPaths(config, app, 'primary');

      // The older --config form is written again as the --cmd-pre-init one.
      assert.ok(config.debugServerArgs.endsWith(
        '--config openocd.cfg --cmd-pre-init "source {${workspaceFolder}/zephyr/samples/hello_world/build/primary/.debug/gdb.cfg}" '
        + '--config board-extra.cfg',
      ), config.debugServerArgs);
      assert.equal(gdbCfgArg(config.debugServerArgs, ws), `${argValue(config.debugServerArgs, '--build-dir', ws)}/.debug/gdb.cfg`);
    });
  }

  it('re-targets an entry that sources the older per-app gdb.cfg, and leaves the user\'s own --cmd-pre-init alone', () => {
    const { app } = workspaceApplication();
    const config = {
      name: 'Zephyr Workbench Debug: zephyr/samples/hello_world [primary]',
      type: 'zephyr-workbench',
      miDebuggerPath: '/usr/bin/gdb',
      debugServerArgs: 'debugserver --build-dir "${workspaceFolder}/zephyr/samples/hello_world/build/primary" --runner openocd '
        + `--cmd-pre-init "source {${LEGACY_GDB_CFG}}" --cmd-pre-init "echo hello"`,
    };
    syncLaunchConfigurationProjectPaths(config, app, 'primary');
    assert.ok(config.debugServerArgs.endsWith(
      '--cmd-pre-init "source {${workspaceFolder}/zephyr/samples/hello_world/build/primary/.debug/gdb.cfg}" --cmd-pre-init "echo hello"',
    ), config.debugServerArgs);

    const again = config.debugServerArgs;
    syncLaunchConfigurationProjectPaths(config, app, 'primary');
    assert.equal(config.debugServerArgs, again, 'writing it again changes nothing');
  });
});
