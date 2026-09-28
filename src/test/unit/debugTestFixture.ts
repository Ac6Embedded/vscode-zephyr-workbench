// A freestanding application with finished builds, for the debug setup tests:
// a west workspace, a board folder, a gdb, the environment script, and build
// folders holding what a real build leaves (CMakeCache.txt, zephyr.elf,
// .config, runners.yaml, and domains.yaml for the sysbuild one). Nothing runs.

import * as fs from 'fs';
import * as path from 'path';
import { ZephyrApplication } from '../../models/ZephyrApplication';
import {
  FakeUri, FakeWindow, installFakeWindow, makeApplicationFolder, makeWestWorkspace, tempDir, writeFile, writeSettingsFile,
} from './appTestWorkspace';

export const BOARD = 'nrf52840dk/nrf52840';

export interface DebugFixture {
  root: string;
  appRoot: string;
  ws: string;
  gdb: string;
  envScript: string;
  venv: string;
  boardDir: string;
  window: FakeWindow;
  launchJsonPath: string;
  /** A fresh model of the application, read from its settings as the workbench does. */
  app(): ZephyrApplication;
  readLaunchJson(): any;
  writeLaunchJson(value: unknown): void;
  restore(): void;
}

export interface BuildOptions {
  runners?: string[];
  debugRunner?: string;
  threadInfo?: boolean;
  pyocdTarget?: string | null;
  /** No runners.yaml and no .config: a build that was only configured. */
  configuredOnly?: boolean;
}

function runnersYaml(dir: string, fixture: { boardDir: string; gdb: string }, options: BuildOptions): string {
  const runners = options.runners ?? ['nrfjprog', 'nrfutil', 'jlink', 'pyocd', 'openocd'];
  const pyocdTarget = options.pyocdTarget === undefined ? 'nrf52840' : options.pyocdTarget;
  return [
    'flash-runner: nrfutil',
    `debug-runner: ${options.debugRunner ?? 'jlink'}`,
    'runners:',
    ...runners.map(runner => `  - ${runner}`),
    'config:',
    `  board_dir: ${JSON.stringify(fixture.boardDir)}`,
    `  elf_file: ${JSON.stringify(path.join(dir, 'zephyr', 'zephyr.elf'))}`,
    `  gdb: ${JSON.stringify(fixture.gdb)}`,
    'args:',
    '  jlink:',
    '    - --dt-flash=y',
    '    - --device=nRF52840_xxAA',
    '    - --speed=4000',
    '  pyocd:',
    '    - --dt-flash=y',
    ...(pyocdTarget ? [`    - --target=${pyocdTarget}`] : []),
    '',
  ].join('\n');
}

/** The files a build leaves in `dir` (a build folder, or the folder of a sysbuild domain). */
export function writeBuild(dir: string, fixture: { boardDir: string; gdb: string }, options: BuildOptions = {}): void {
  writeFile(path.join(dir, 'CMakeCache.txt'), `CMAKE_GDB:FILEPATH=${fixture.gdb}\n`);
  if (options.configuredOnly) {
    return;
  }
  writeFile(path.join(dir, 'zephyr', 'zephyr.elf'), 'ELF');
  writeFile(path.join(dir, 'zephyr', '.config'), [
    'CONFIG_ARCH="arm"',
    options.threadInfo ? 'CONFIG_DEBUG_THREAD_INFO=y' : '# CONFIG_DEBUG_THREAD_INFO is not set',
    '',
  ].join('\n'));
  writeFile(path.join(dir, 'zephyr', 'runners.yaml'), runnersYaml(dir, fixture, options));
}

export function makeDebugFixture(options: { primary?: BuildOptions; withSysbuild?: boolean; builtPrimary?: boolean } = {}): DebugFixture {
  const root = tempDir('zw-debug-');
  const ws = makeWestWorkspace(path.join(root, 'ws'));
  const appRoot = makeApplicationFolder(path.join(root, 'app'));
  const boardDir = path.join(root, 'boards', 'nordic', 'nrf52840dk');
  writeFile(path.join(boardDir, 'nrf52840dk_nrf52840.yaml'), [
    `identifier: ${BOARD}`, 'name: nRF52840-DK', 'type: mcu', 'arch: arm', 'vendor: nordic', '',
  ].join('\n'));
  writeFile(path.join(boardDir, 'board.yml'), 'board:\n  name: nrf52840dk\n  vendor: nordic\n  socs:\n    - name: nrf52840\n');
  const gdb = writeFile(path.join(root, 'toolchain', 'bin', process.platform === 'win32' ? 'arm-zephyr-eabi-gdb.exe' : 'arm-zephyr-eabi-gdb'));
  const envScript = writeFile(path.join(root, 'tools', process.platform === 'win32' ? 'env.bat' : 'env.sh'), '');
  const venv = path.join(root, 'venv');
  fs.mkdirSync(venv, { recursive: true });

  const configs: Record<string, unknown>[] = [{ name: 'primary', board: BOARD, active: 'true' }];
  if (options.withSysbuild) {
    configs.push({ name: 'sys', board: BOARD, active: 'false', sysbuild: 'true' });
  }
  writeSettingsFile(appRoot, {
    'zephyr-workbench.westWorkspace': ws,
    'zephyr-workbench.toolchain': 'zephyr',
    'zephyr-workbench.build.configurations': configs,
  });
  const window = installFakeWindow([appRoot]);
  window.user['zephyr-workbench.pathToEnvScript'] = envScript;
  window.user['zephyr-workbench.venv.path'] = venv;

  const fixture = { boardDir, gdb };
  if (options.builtPrimary !== false) {
    writeBuild(path.join(appRoot, 'build', 'primary'), fixture, options.primary);
  }
  if (options.withSysbuild) {
    const sysDir = path.join(appRoot, 'build', 'sys');
    writeFile(path.join(sysDir, 'CMakeCache.txt'), '');
    writeFile(path.join(sysDir, 'domains.yaml'), [
      'default: app',
      `build_dir: ${JSON.stringify(sysDir)}`,
      'domains:',
      '  - name: mcuboot',
      `    build_dir: ${JSON.stringify(path.join(sysDir, 'mcuboot'))}`,
      '  - name: app',
      `    build_dir: ${JSON.stringify(path.join(sysDir, 'app'))}`,
      'flash_order:',
      '  - mcuboot',
      '  - app',
      '',
    ].join('\n'));
    writeBuild(path.join(sysDir, 'app'), fixture);
    writeBuild(path.join(sysDir, 'mcuboot'), fixture);
  }

  const launchJsonPath = path.join(appRoot, '.vscode', 'launch.json');
  return {
    root, appRoot, ws, gdb, envScript, venv, boardDir, window, launchJsonPath,
    app: () => {
      ZephyrApplication.clearApplicationWorkspaceCache();
      return new ZephyrApplication({ uri: FakeUri.file(appRoot), name: 'app', index: 0 } as never, appRoot);
    },
    readLaunchJson: () => JSON.parse(fs.readFileSync(launchJsonPath, 'utf8')),
    writeLaunchJson: value => writeFile(launchJsonPath, typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
    restore: () => window.restore(),
  };
}
