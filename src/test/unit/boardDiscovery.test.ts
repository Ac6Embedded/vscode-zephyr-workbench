// Board discovery: the board roots an application's build adds, the labels of
// the targets `west boards` lists, and the fallback when two roots define the
// same board. Roots and labels come from files only, so they are tested on
// real folders; `west boards` itself is replaced where it would run.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { WestBoardInfo, WestCommandError } from '../../commands/WestCommands';
import { matchTwisterIdentifier, ZephyrBoard } from '../../models/ZephyrBoard';
import { WestWorkspace } from '../../models/WestWorkspace';
import { ZephyrApplication } from '../../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../../models/ZephyrBuildConfig';
import { collectBoardRoots, describeWestBoards, getSupportedBoards } from '../../utils/zephyr/boardDiscovery';
import { readCMakeListsPaths, readModuleBoardRoot } from '../../utils/zephyr/catalogFiles';

let tmp: string;

function write(relative: string, content: string): string {
  const file = path.join(tmp, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** A folder holding `boards/acme/<board>/board.yml`, which is what makes it a board root. */
function boardRoot(relative: string, board: string): string {
  write(path.join(relative, 'boards', 'acme', board, 'board.yml'), `board:\n  name: ${board}\n  vendor: acme\n  socs:\n    - name: stm32f401xe\n`);
  return path.join(tmp, relative);
}

/** A Zephyr module declaring a board root, in zephyr/module.yml or module.yaml. */
function zephyrModule(relative: string, board: string, options: { file?: string; boardRoot?: string } = {}): string {
  const setting = options.boardRoot ?? '.';
  write(path.join(relative, 'zephyr', options.file ?? 'module.yml'), `name: ${path.basename(relative)}\nbuild:\n  settings:\n    board_root: ${setting}\n`);
  boardRoot(path.join(relative, setting), board);
  return path.join(tmp, relative);
}

const resolved = (roots: string[]) => roots.map(root => path.resolve(root));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-board-discovery-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('matchTwisterIdentifier', () => {
  const ids = (...identifiers: string[]) => new Set(identifiers);

  it('is the file of the exact target, never the file of another one', () => {
    assert.equal(matchTwisterIdentifier('mps2/an385', ids('mps2/an383', 'mps2/an385')), 'mps2/an385');
    assert.equal(matchTwisterIdentifier('mps2/an386', ids('mps2/an383', 'mps2/an385')), undefined);
    assert.equal(matchTwisterIdentifier('nrf5340dk/nrf5340/cpunet', ids('nrf5340dk', 'nrf5340dk/nrf5340/cpuapp')), undefined);
  });

  it('leaves the revision out, as twister identifiers have none', () => {
    assert.equal(matchTwisterIdentifier('nrf9160dk@0.14.0/nrf9160', ids('nrf9160dk/nrf9160')), 'nrf9160dk/nrf9160');
    assert.equal(matchTwisterIdentifier('board@A', ids('board')), 'board');
  });

  it('matches either spelling of the target of a board with a single SoC', () => {
    assert.equal(matchTwisterIdentifier('we_proteus2ev', ids('we_proteus2ev/nrf52832')), 'we_proteus2ev/nrf52832');
    assert.equal(matchTwisterIdentifier('xenvm/xenvm', ids('xenvm', 'xenvm/xenvm/gicv3')), 'xenvm');
    assert.equal(matchTwisterIdentifier('duo', ids('duo/soc_a', 'duo/soc_b')), undefined, 'a board with two SoCs has no bare target');
  });
});

describe('ZephyrBoard read from its board folder', () => {
  function mps2Folder(): string {
    write('mps2/mps2_an383.yaml', 'identifier: mps2/an383\nname: ARM V2M MPS2-an383\narch: arm\n');
    write('mps2/mps2_an385.yaml', 'identifier: mps2/an385\nname: ARM V2M MPS2\narch: arm\n');
    return path.join(tmp, 'mps2');
  }

  it('takes name and arch from the file of its own target', () => {
    const board = new ZephyrBoard(vscode.Uri.file(mps2Folder()), 'mps2/an385');
    assert.equal(board.name, 'ARM V2M MPS2');
    assert.equal(board.identifier, 'mps2/an385');
  });

  it('has no name or arch rather than those of another target', () => {
    const board = new ZephyrBoard(vscode.Uri.file(mps2Folder()), 'mps2/an386');
    assert.equal(board.name, undefined);
    assert.equal(board.arch, undefined);
    assert.equal(board.identifier, 'mps2/an386');
  });

  it('takes the first file of the folder when no target is given', () => {
    assert.equal(new ZephyrBoard(vscode.Uri.file(mps2Folder())).name, 'ARM V2M MPS2-an383');
  });
});

describe('collectBoardRoots for an application', () => {
  let ws: string;
  let appRoot: string;
  let workspace: WestWorkspace;
  let app: ZephyrApplication;

  beforeEach(() => {
    ws = path.join(tmp, 'ws');
    appRoot = path.join(ws, 'app');
    fs.mkdirSync(appRoot, { recursive: true });
    workspace = {
      rootUri: { fsPath: ws },
      kernelUri: { fsPath: path.join(ws, 'zephyr') },
      envVars: { BOARD_ROOT: [] },
    } as unknown as WestWorkspace;
    app = { appRootPath: appRoot } as ZephyrApplication;
  });

  function config(options: { westArgs?: string; westFlagsD?: string[]; extraModules?: string[]; buildDir?: string } = {}): ZephyrBuildConfig {
    return {
      westArgs: options.westArgs ?? '',
      westFlagsD: options.westFlagsD ?? [],
      envVars: { EXTRA_ZEPHYR_MODULES: options.extraModules ?? [] },
      getBuildArtifactPath: (_app: unknown, ...segments: string[]) => {
        const candidate = options.buildDir ? path.join(options.buildDir, ...segments) : '';
        return candidate && fs.existsSync(candidate) ? candidate : undefined;
      },
    } as unknown as ZephyrBuildConfig;
  }

  const cmakeLists = (body: string) => fs.writeFileSync(path.join(appRoot, 'CMakeLists.txt'),
    `cmake_minimum_required(VERSION 3.20.0)\n${body}\nfind_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})\nproject(app)\n`);

  it('adds nothing for an application that sets no board root', () => {
    cmakeLists('');
    assert.deepEqual(resolved(collectBoardRoots(workspace, app, config())), [ws]);
  });

  it('adds the application folder its CMakeLists.txt appends, as the Zephyr docs show', () => {
    boardRoot('ws/app', 'app_board');
    cmakeLists('list(APPEND BOARD_ROOT ${CMAKE_CURRENT_SOURCE_DIR})');
    assert.deepEqual(resolved(collectBoardRoots(workspace, app, config())), [ws, appRoot]);
  });

  it('adds BOARD_ROOT from a -D flag, a relative path being relative to the application', () => {
    const folder = boardRoot('custom-boards', 'folder_board');
    assert.deepEqual(resolved(collectBoardRoots(workspace, app, config({ westFlagsD: ['BOARD_ROOT=../../custom-boards'] }))), [ws, folder]);
  });

  it('reads -D definitions in the west arguments, typed and as a CMake list', () => {
    const first = boardRoot('first', 'first_board');
    const second = boardRoot('second root', 'second_board');
    const westArgs = `-p always -- -DBOARD_ROOT:PATH="${first};${second}"`;
    assert.deepEqual(resolved(collectBoardRoots(workspace, app, config({ westArgs }))), [ws, first, second]);
  });

  it('adds the board_root of EXTRA_ZEPHYR_MODULES from the setting, a -D flag and CMakeLists.txt', () => {
    const fromSetting = zephyrModule('mod-setting', 'setting_board');
    const fromFlag = zephyrModule('mod-flag', 'flag_board', { file: 'module.yaml', boardRoot: 'hw' });
    const fromCMake = zephyrModule('mod-cmake', 'cmake_board');
    write('mod-none/zephyr/module.yml', 'name: mod-none\n');
    cmakeLists(`set(EXTRA_ZEPHYR_MODULES "${fromCMake.replace(/\\/g, '/')};${path.join(tmp, 'mod-none').replace(/\\/g, '/')}")`);
    const roots = collectBoardRoots(workspace, app, config({ extraModules: [fromSetting], westFlagsD: [`EXTRA_ZEPHYR_MODULES=${fromFlag}`] }));
    assert.deepEqual(resolved(roots), [ws, fromSetting, path.join(fromFlag, 'hw'), fromCMake]);
  });

  it('keeps every BOARD_ROOT an existing build recorded, one per module', () => {
    const buildDir = path.join(appRoot, 'build', 'primary');
    const first = boardRoot('recorded-a', 'a_board');
    const second = boardRoot('recorded-b', 'b_board');
    write('ws/app/build/primary/zephyr_settings.txt',
      `# generated\n"DTS_ROOT":"/somewhere"\n"BOARD_ROOT":"${first.replace(/\\/g, '/')}"\n"BOARD_ROOT":"${second.replace(/\\/g, '/')}"\n`);
    assert.deepEqual(resolved(collectBoardRoots(workspace, app, config({ buildDir }))), [ws, first, second]);
  });

  it('leaves out a folder that holds no boards/ folder, as Zephyr warns about it', () => {
    fs.mkdirSync(path.join(tmp, 'empty'));
    cmakeLists('list(APPEND BOARD_ROOT ${CMAKE_CURRENT_SOURCE_DIR})');
    const roots = collectBoardRoots(workspace, app, config({ westFlagsD: [`BOARD_ROOT=${path.join(tmp, 'empty')}`] }));
    assert.deepEqual(resolved(roots), [ws]);
  });

  it('lists each folder once, however many settings name it and however they spell it', () => {
    const folder = boardRoot('shared', 'shared_board');
    const moduleDir = zephyrModule('mod', 'mod_board');
    (workspace.envVars as { BOARD_ROOT: string[] }).BOARD_ROOT = [folder];
    const spelledAgain = process.platform === 'win32' ? `${folder.toUpperCase()}\\` : `${folder}/`;
    cmakeLists(`list(APPEND BOARD_ROOT ${folder.replace(/\\/g, '/')})\nlist(APPEND EXTRA_ZEPHYR_MODULES ${moduleDir.replace(/\\/g, '/')})`);
    const roots = collectBoardRoots(workspace, app, config({
      westFlagsD: [`BOARD_ROOT=${spelledAgain}`, `BOARD_ROOT=${moduleDir}`],
      extraModules: [moduleDir],
    }));
    assert.deepEqual(resolved(roots), [ws, folder, moduleDir]);
  });
});

describe('readCMakeListsPaths', () => {
  it('understands set(), list(APPEND), quotes and $ENV{ZEPHYR_BASE}, and skips what it cannot resolve', () => {
    const appRoot = path.join(tmp, 'app');
    const zephyrBase = path.join(tmp, 'zephyr');
    write('app/CMakeLists.txt', [
      '# list(APPEND BOARD_ROOT /commented/out)',
      'set(BOARD_ROOT "${CMAKE_CURRENT_LIST_DIR}/../shared" $ENV{ZEPHYR_BASE}/../vendor)',
      'list(APPEND BOARD_ROOT ${MY_BOARDS} relative/boards)',
      'list(REMOVE_ITEM BOARD_ROOT /removed)',
      'set(board_root /not/the/same/variable)',
      'LIST(PREPEND BOARD_ROOT ${CMAKE_CURRENT_SOURCE_DIR})',
      '',
    ].join('\n'));
    const found = readCMakeListsPaths(appRoot, 'BOARD_ROOT', {
      CMAKE_CURRENT_SOURCE_DIR: appRoot,
      CMAKE_CURRENT_LIST_DIR: appRoot,
      'ENV{ZEPHYR_BASE}': zephyrBase,
    });
    assert.deepEqual(resolved(found), [path.join(tmp, 'shared'), path.join(tmp, 'vendor'), appRoot]);
  });

  it('finds nothing without a CMakeLists.txt', () => {
    assert.deepEqual(readCMakeListsPaths(path.join(tmp, 'none'), 'BOARD_ROOT', {}), []);
  });
});

describe('readModuleBoardRoot', () => {
  it('reads module.yml, else module.yaml, relative to the module', () => {
    assert.equal(readModuleBoardRoot(zephyrModule('a', 'a_board')), path.join(tmp, 'a'));
    assert.equal(readModuleBoardRoot(zephyrModule('b', 'b_board', { file: 'module.yaml', boardRoot: 'hw' })), path.join(tmp, 'b', 'hw'));
    write('c/zephyr/module.yml', 'name: c\nbuild:\n  cmake: .\n');
    assert.equal(readModuleBoardRoot(path.join(tmp, 'c')), undefined);
    assert.equal(readModuleBoardRoot(path.join(tmp, 'missing')), undefined);
  });
});

describe('describeWestBoards', () => {
  const row = (name: string, dir: string, over: Partial<WestBoardInfo> = {}): WestBoardInfo =>
    ({ name, dir: path.join(tmp, dir), qualifiers: [], revisions: [], ...over });
  const labels = (boards: ZephyrBoard[]) => boards.map(board => [board.identifier, board.name]);

  it('labels each target with its own twister file, else the board full_name', async () => {
    write('mps2/board.yml', 'board:\n  name: mps2\n  full_name: V2M MPS2\n  vendor: arm\n');
    write('mps2/mps2_an383.yaml', 'identifier: mps2/an383\nname: ARM V2M MPS2-an383\narch: arm\n');
    write('mps2/mps2_an385.yaml', 'identifier: mps2/an385\nname: ARM V2M MPS2\narch: arm\n');
    write('mps2/mps2_an386_adsp.yaml', 'identifier: mps2/an386/adsp\nname: ARM V2M MPS2-an386 DSP\narch: xtensa\n');
    const boards = await describeWestBoards([row('mps2', 'mps2', { qualifiers: ['an383', 'an385', 'an386/cpu', 'an386/adsp'] })]);
    assert.deepEqual(labels(boards), [
      ['mps2/an383', 'ARM V2M MPS2-an383'],
      ['mps2/an385', 'ARM V2M MPS2'],
      ['mps2/an386/cpu', 'V2M MPS2'],
      ['mps2/an386/adsp', 'ARM V2M MPS2-an386 DSP'],
    ]);
    assert.deepEqual(boards.map(board => board.arch), ['arm', 'arm', undefined, 'xtensa'], 'never the arch of another target');
    assert.equal(boards[2].vendor, 'arm', 'the vendor is the board\'s, from board.yml');
  });

  it('labels boards declared together under boards: without twister files by their full_name', async () => {
    write('evb/board.yml', [
      'boards:',
      '  - name: evb_lan9253',
      '    full_name: EVB-LAN9253',
      '    vendor: microchip',
      '  - name: evb_lan9255',
      '    full_name: EVB-LAN9255',
      '    vendor: microchip',
      '',
    ].join('\n'));
    const boards = await describeWestBoards([row('evb_lan9253', 'evb', { qualifiers: ['atsamd51j19a'] }), row('evb_lan9255', 'evb', { qualifiers: ['atsame53j20a'] })]);
    assert.deepEqual(labels(boards), [['evb_lan9253', 'EVB-LAN9253'], ['evb_lan9255', 'EVB-LAN9255']]);
  });

  it('falls back to the board name, never undefined, when board.yml has no full_name (Zephyr 3.7)', async () => {
    write('old/board.yml', 'board:\n  name: old_board\n  vendor: acme\n');
    const [board] = await describeWestBoards([row('old_board', 'old', { qualifiers: ['stm32f401xe'] })]);
    assert.equal(board.name, 'old_board');
  });

  it('matches the twister file of a single-SoC board picked by its bare name', async () => {
    write('proteus/we_proteus2ev.yaml', 'identifier: we_proteus2ev/nrf52832\nname: Wurth Proteus-II\narch: arm\n');
    const [board] = await describeWestBoards([row('we_proteus2ev', 'proteus', { qualifiers: ['nrf52832'] })]);
    assert.deepEqual([board.identifier, board.name, board.arch], ['we_proteus2ev', 'Wurth Proteus-II', 'arm']);
  });

  it('puts a name written over several lines on one line', async () => {
    write('radio/siwx917_rb4342a.yaml', 'identifier: siwx917_rb4342a\nname: |\n  SiWx917 Radio Board\n  (SLWRB4342A, BRD4342A)\narch: arm\n');
    const [board] = await describeWestBoards([row('siwx917_rb4342a', 'radio')]);
    assert.equal(board.name, 'SiWx917 Radio Board (SLWRB4342A, BRD4342A)');
  });

  it('gives each revision the label of its target', async () => {
    write('rev/board_x.yaml', 'identifier: board_x\nname: Board X\narch: arm\n');
    const boards = await describeWestBoards([row('board_x', 'rev', { revisions: ['A', 'B'] })]);
    assert.deepEqual(labels(boards), [['board_x', 'Board X'], ['board_x@A', 'Board X'], ['board_x@B', 'Board X']]);
  });

  it('lists once a board two roots define, which Zephyr 3.6 reports twice', async () => {
    write('app-copy/boards/arm/my_board/my_board.yaml', 'identifier: my_board\nname: My board (application copy)\narch: arm\n');
    write('zephyr/boards/arm/my_board/my_board.yaml', 'identifier: my_board\nname: My board\narch: arm\n');
    const boards = await describeWestBoards([
      row('my_board', 'app-copy/boards/arm/my_board'),
      row('my_board', 'zephyr/boards/arm/my_board'),
    ]);
    assert.deepEqual(labels(boards), [['my_board', 'My board (application copy)']]);
    assert.equal(boards[0].rootPath, path.join(tmp, 'app-copy', 'boards', 'arm', 'my_board'));
  });
});

describe('getSupportedBoards when two board roots define the same board', () => {
  const westCommands = require('../../commands/WestCommands') as Record<string, unknown>;
  let savedBoards: unknown;
  let listedRoots: string[][];
  let workspace: WestWorkspace;
  let app: ZephyrApplication;
  let buildConfig: ZephyrBuildConfig;

  beforeEach(() => {
    savedBoards = westCommands.getWestBoards;
    listedRoots = [];
    const ws = path.join(tmp, 'ws');
    const appRoot = path.join(ws, 'app');
    boardRoot('ws/app', 'nucleo_f401re');
    write('ws/app/CMakeLists.txt', 'list(APPEND BOARD_ROOT ${CMAKE_CURRENT_SOURCE_DIR})\n');
    workspace = { rootUri: { fsPath: ws }, kernelUri: { fsPath: path.join(ws, 'zephyr') }, envVars: { BOARD_ROOT: [] } } as unknown as WestWorkspace;
    app = { appRootPath: appRoot } as ZephyrApplication;
    buildConfig = { westArgs: '', westFlagsD: [], envVars: {}, getBuildArtifactPath: () => undefined } as unknown as ZephyrBuildConfig;
  });

  afterEach(() => {
    westCommands.getWestBoards = savedBoards;
  });

  it('lists the workspace boards again, without the roots the application added', async () => {
    westCommands.getWestBoards = async (_ws: unknown, roots: string[]) => {
      listedRoots.push(roots);
      if (roots.length > 1) {
        const stderr = "ERROR: Board(s): {'nucleo_f401re'}, defined multiple times.\nLast defined in /ws/app/boards/acme/nucleo_f401re/board.yml";
        throw new WestCommandError(stderr, stderr);
      }
      return [{ name: 'qemu_x86', dir: path.join(tmp, 'qemu_x86'), qualifiers: ['atom'], revisions: [] }];
    };
    const boards = await getSupportedBoards(workspace, app, buildConfig);
    assert.deepEqual(boards.map(board => board.identifier), ['qemu_x86']);
    assert.deepEqual(listedRoots.map(roots => roots.length), [2, 1], 'one retry over the workspace root only');
  });

  it('does not retry any other failure', async () => {
    westCommands.getWestBoards = async (_ws: unknown, roots: string[]) => {
      listedRoots.push(roots);
      throw new WestCommandError('west: unknown command "boards"', 'west: unknown command "boards"');
    };
    await assert.rejects(getSupportedBoards(workspace, app, buildConfig), /unknown command/);
    assert.equal(listedRoots.length, 1);
  });
});
