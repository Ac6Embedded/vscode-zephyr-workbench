// The OpenOCD gdb.cfg (Ac6Embedded/vscode-zephyr-workbench#225): createOpenocdCfg
// writes it in the build configuration's .debug folder, and the `--config`
// passing it to `west debugserver` must name that file, for a freestanding app
// and for a West workspace application, whose ${workspaceFolder} is the west
// workspace rather than the app.

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

const gdbCfgArg = (args: string, folder: string) => argValue(args, '--config', folder, 'gdb.cfg');

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

    assert.ok(args.includes('--config "${workspaceFolder}/zephyr/samples/hello_world/build/primary/.debug/gdb.cfg"'), args);
    const cfg = gdbCfgArg(args, ws)!;
    assert.equal(path.normalize(cfg), path.join(app.getBuildConfiguration('primary')!.getInternalDebugDir(app), 'gdb.cfg'));
    assert.ok(fs.existsSync(cfg));
  });

  it('passes a freestanding app the gdb.cfg in its build configuration', () => {
    const app = freestandingApplication();
    const args = openocdArgs(app);
    createOpenocdCfg(app, 'primary');

    assert.ok(args.includes('--config openocd.cfg --config "${workspaceFolder}/build/primary/.debug/gdb.cfg"'), args);
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
    ]) {
      const runner = new Openocd();
      runner.loadArgs(`${stored} --config board-extra.cfg`);
      assert.equal(runner.userArgs, '--config board-extra.cfg', stored);
    }
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

      assert.ok(config.debugServerArgs.endsWith(
        '--config openocd.cfg --config "${workspaceFolder}/zephyr/samples/hello_world/build/primary/.debug/gdb.cfg" --config board-extra.cfg',
      ), config.debugServerArgs);
      assert.equal(gdbCfgArg(config.debugServerArgs, ws), `${argValue(config.debugServerArgs, '--build-dir', ws)}/.debug/gdb.cfg`);
    });
  }
});
