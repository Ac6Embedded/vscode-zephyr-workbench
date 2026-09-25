// The west listing helpers behind board, shield and snippet discovery. The
// parsers are pure; the run tests drive the real execWestCommandWithEnv with a
// throwaway environment script and a fake `west` on PATH, so the timeout,
// cancel and probing paths are exercised against real processes.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  execWestCommandWithEnv, getSnippetRoots, getSupportedSnippets, getWestBoards, getWestShields, parseWestShieldList,
  WestBoardInfo, WestCommandError,
} from '../../commands/WestCommands';
import { WestWorkspace } from '../../models/WestWorkspace';
import { ZephyrApplication } from '../../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../../models/ZephyrBuildConfig';
import { collectBoardRootsReadOnly, selectableBoardIdentifiers } from '../../utils/zephyr/boardDiscovery';
import { zephyrSearchesAppSnippets } from '../../utils/zephyr/catalogFiles';
import { isWestMissing } from '../../utils/zephyr/westFailures';
import { BoardEntry, ShieldEntry, SnippetEntry } from '../../mcp/core/catalogSearch';
import { McpToolError, toToolError } from '../../mcp/core/errors';
import { CatalogSources, shellSafeRoots } from '../../mcp/host/catalogSources';

describe('parseWestShieldList', () => {
  const RICH = '{name}|{dir}|{vendor}|{full_name}';

  it('reads every field, treating "None" as absent', () => {
    const shields = parseWestShieldList([
      'adafruit_2_8_tft_touch_v2|/z/boards/shields/adafruit_2_8_tft_touch_v2|adafruit|Adafruit 2.8" TFT Touch Shield v2',
      'tcan4550evm|/z/boards/shields/tcan4550evm|None|None',
    ].join('\n'), RICH);
    assert.deepEqual(shields, [
      {
        name: 'adafruit_2_8_tft_touch_v2',
        dir: '/z/boards/shields/adafruit_2_8_tft_touch_v2',
        vendor: 'adafruit',
        fullName: 'Adafruit 2.8" TFT Touch Shield v2',
      },
      // A name without an underscore is kept: the old heuristic dropped it.
      { name: 'tcan4550evm', dir: '/z/boards/shields/tcan4550evm' },
    ]);
  });

  it('gives the rest of the line to the last field', () => {
    const [shield] = parseWestShieldList('x_board|/d|acme|Name | with a bar', RICH);
    assert.equal(shield.fullName, 'Name | with a bar');
  });

  it('strips quotes a shell echoed around the whole line', () => {
    const [shield] = parseWestShieldList('"x_board|/d"', '{name}|{dir}');
    assert.deepEqual(shield, { name: 'x_board', dir: '/d' });
  });

  it('drops a full name that only repeats the shield name', () => {
    // west falls back to the name when a shield defines no full name.
    const [shield] = parseWestShieldList('x_board|/d|None|x_board', RICH);
    assert.deepEqual(shield, { name: 'x_board', dir: '/d' });
  });

  it('skips warnings, banners and duplicates', () => {
    const shields = parseWestShieldList([
      'WARNING: something odd happened',
      '',
      'x_nucleo_iks01a3',
      'x_nucleo_iks01a3',
      'rk055hdmipi4m',
    ].join('\n'), '{name}');
    assert.deepEqual(shields.map(s => s.name), ['x_nucleo_iks01a3', 'rk055hdmipi4m']);
  });
});

describe('selectableBoardIdentifiers', () => {
  const board = (over: Partial<WestBoardInfo>): WestBoardInfo => ({ name: 'b', dir: '/d', qualifiers: [], revisions: [], ...over });

  it('is the bare name for a board without qualifiers', () => {
    assert.deepEqual(selectableBoardIdentifiers(board({ name: 'qemu_x86' })), ['qemu_x86']);
  });

  it('is the bare name for a single-SoC board, as west build -b accepts it', () => {
    assert.deepEqual(selectableBoardIdentifiers(board({ name: 'nrf52840dk', qualifiers: ['nrf52840'] })), ['nrf52840dk']);
  });

  it('lists each qualifier target of a multi-core board', () => {
    assert.deepEqual(
      selectableBoardIdentifiers(board({ name: 'nrf5340dk', qualifiers: ['nrf5340/cpuapp', 'nrf5340/cpunet'] })),
      ['nrf5340dk/nrf5340/cpuapp', 'nrf5340dk/nrf5340/cpunet'],
    );
  });

  it('follows each target with its revision-pinned forms', () => {
    assert.deepEqual(
      selectableBoardIdentifiers(board({ name: 'intel_btl_s_crb', qualifiers: ['raptor_lake'], revisions: ['H', 'P'] })),
      ['intel_btl_s_crb', 'intel_btl_s_crb@H', 'intel_btl_s_crb@P'],
    );
  });
});

/**
 * The shared stub's Uri is a plain object, but the settings helpers test
 * `scope instanceof vscode.Uri`, so these suites swap in a class for their
 * duration. The stub module object is patched, not the import wrapper.
 */
function useClassUri(): void {
  const stub = require('vscode') as { Uri: unknown };
  const original = stub.Uri;
  class TestUri {
    constructor(readonly fsPath: string) {}
    static file(fsPath: string) { return new TestUri(fsPath); }
    static joinPath(base: { fsPath: string }, ...parts: string[]) { return new TestUri(path.join(base.fsPath, ...parts)); }
  }
  before(() => { stub.Uri = TestUri; });
  after(() => { stub.Uri = original; });
}

describe('execWestCommandWithEnv', () => {
  useClassUri();

  it('names the env script setting as the cause when the script is not set', () => {
    const workspace = { rootUri: vscode.Uri.file('/nowhere'), buildEnv: {} } as unknown as WestWorkspace;
    assert.throws(() => execWestCommandWithEnv('west boards', workspace), (error: unknown) => {
      assert.equal(toToolError(error).code, 'ENV_NOT_READY', 'a missing env script is a setup gap, not a crash');
      // The Create Application panel recognises this failure by its text.
      assert.match((error as Error).message.toLowerCase(), /missing zephyr env script/);
      return true;
    });
  });
});

describe('snippet discovery for a workspace', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-snippets-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function workspaceAt(snippetRoots: string[]): WestWorkspace {
    return {
      kernelUri: { fsPath: path.join(tmp, 'zephyr') },
      envVars: { SNIPPET_ROOT: snippetRoots },
    } as unknown as WestWorkspace;
  }

  /** Zephyr's snippets.cmake, as before 4.4 (adds the application folder) or after. */
  function writeSnippetsCmake(addsAppDir: boolean): void {
    const modules = path.join(tmp, 'zephyr', 'cmake', 'modules');
    fs.mkdirSync(modules, { recursive: true });
    fs.writeFileSync(path.join(modules, 'snippets.cmake'), addsAppDir
      ? 'zephyr_get(SNIPPET_ROOT MERGE SYSBUILD GLOBAL)\nset_ifndef(SNIPPET_APP_DIR "${APPLICATION_SOURCE_DIR}")\nlist(APPEND SNIPPET_ROOT ${SNIPPET_APP_DIR})\n'
      : 'zephyr_get(SNIPPET_ROOT MERGE SYSBUILD GLOBAL)\nlist(APPEND SNIPPET_ROOT ${ZEPHYR_BASE})\n');
  }

  it('searches Zephyr, the absolute SNIPPET_ROOT settings and the application on a Zephyr that adds it', () => {
    writeSnippetsCmake(true);
    const roots = getSnippetRoots(workspaceAt(['/abs/root', 'relative/root']), { appRootPath: '/app' } as ZephyrApplication);
    assert.deepEqual(roots, [path.join(tmp, 'zephyr'), '/abs/root', '/app']);
  });

  it('leaves the application out on a Zephyr that no longer searches it (4.4 and later)', () => {
    writeSnippetsCmake(false);
    const roots = getSnippetRoots(workspaceAt(['/abs/root']), { appRootPath: '/app' } as ZephyrApplication);
    assert.deepEqual(roots, [path.join(tmp, 'zephyr'), '/abs/root'], 'west build -S would not find its snippets');
  });

  it('reads an unreadable snippets.cmake as the newer behaviour', () => {
    assert.equal(zephyrSearchesAppSnippets(path.join(tmp, 'zephyr')), false);
    writeSnippetsCmake(true);
    assert.equal(zephyrSearchesAppSnippets(path.join(tmp, 'zephyr')), true);
  });

  it('lists application snippets for the agent tool, flagged when the application must add its folder', async () => {
    const zephyr = path.join(tmp, 'zephyr');
    fs.mkdirSync(path.join(zephyr, 'snippets', 'cdc-acm-console'), { recursive: true });
    fs.writeFileSync(path.join(zephyr, 'snippets', 'cdc-acm-console', 'snippet.yml'), 'name: cdc-acm-console\n');
    const appRoot = path.join(tmp, 'app');
    fs.mkdirSync(path.join(appRoot, 'snippets', 'foo'), { recursive: true });
    fs.writeFileSync(path.join(appRoot, 'snippets', 'foo', 'snippet.yml'), 'name: foo\n');
    const workspace = {
      ...workspaceAt([]),
      rootUri: { fsPath: tmp },
      westConfUri: { fsPath: path.join(tmp, '.west', 'config') },
      version: '4.4.99',
    } as unknown as WestWorkspace;
    const app = { appRootPath: appRoot } as ZephyrApplication;
    const snippets = async () => (await new CatalogSources().list('snippet', workspace, app, false)).entries as SnippetEntry[];

    writeSnippetsCmake(false);
    const newer = await snippets();
    assert.deepEqual(newer.map(s => [s.name, s.needs_snippet_root ?? false]), [['cdc-acm-console', false], ['foo', true]]);

    writeSnippetsCmake(true);
    const older = await snippets();
    assert.deepEqual(older.map(s => [s.name, s.needs_snippet_root ?? false]), [['cdc-acm-console', false], ['foo', false]]);
  });

  it('lists again after the cache of that workspace is invalidated', async () => {
    const zephyr = path.join(tmp, 'zephyr');
    const addSnippet = (name: string) => {
      fs.mkdirSync(path.join(zephyr, 'snippets', name), { recursive: true });
      fs.writeFileSync(path.join(zephyr, 'snippets', name, 'snippet.yml'), `name: ${name}\n`);
    };
    addSnippet('first');
    const workspace = {
      ...workspaceAt([]),
      rootUri: { fsPath: tmp },
      westConfUri: { fsPath: path.join(tmp, '.west', 'config') },
      version: '4.2.0',
    } as unknown as WestWorkspace;
    const sources = new CatalogSources();
    const names = async () => ((await sources.list('snippet', workspace, undefined, false)).entries as SnippetEntry[]).map(s => s.name);
    assert.deepEqual(await names(), ['first']);
    addSnippet('second');
    assert.deepEqual(await names(), ['first'], 'served from the cache');
    sources.invalidate(path.join(tmp, 'elsewhere'));
    assert.deepEqual(await names(), ['first'], 'another workspace was invalidated');
    sources.invalidate(tmp);
    assert.deepEqual(await names(), ['first', 'second']);
  });

  it('lists nested snippets by name for the snippet picker, not their grouping folders', async () => {
    const zephyr = path.join(tmp, 'zephyr');
    fs.mkdirSync(path.join(zephyr, 'snippets', 'espressif', 'flash-2M'), { recursive: true });
    fs.writeFileSync(path.join(zephyr, 'snippets', 'espressif', 'flash-2M', 'snippet.yml'), 'name: espressif-flash-2M\n');
    fs.mkdirSync(path.join(zephyr, 'snippets', 'cdc-acm-console'), { recursive: true });
    fs.writeFileSync(path.join(zephyr, 'snippets', 'cdc-acm-console', 'snippet.yml'), 'name: cdc-acm-console\n');
    const extra = path.join(tmp, 'extra');
    fs.mkdirSync(path.join(extra, 'snippets', 'mine'), { recursive: true });
    fs.writeFileSync(path.join(extra, 'snippets', 'mine', 'snippet.yml'), 'name: my-snippet\n');

    assert.deepEqual(await getSupportedSnippets(workspaceAt([extra])), ['cdc-acm-console', 'espressif-flash-2M', 'my-snippet']);
  });

  it('still fails as before when Zephyr has no snippets folder', async () => {
    await assert.rejects(getSupportedSnippets(workspaceAt([])), /No snippets found/);
  });
});

describe('collectBoardRootsReadOnly', () => {
  let tmp: string;
  const workspace = {
    rootUri: { fsPath: '/ws' },
    envVars: { BOARD_ROOT: ['/ws/extra-boards'] },
  } as unknown as WestWorkspace;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-board-roots-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function configBuiltIn(buildDir: string): ZephyrBuildConfig {
    return {
      getBuildArtifactPath: (_app: unknown, ...segments: string[]) => {
        const candidate = path.join(buildDir, ...segments);
        return fs.existsSync(candidate) ? candidate : undefined;
      },
      getBuildDir: () => buildDir,
    } as unknown as ZephyrBuildConfig;
  }

  it('is the workspace root plus its BOARD_ROOT setting without an application', () => {
    assert.deepEqual(collectBoardRootsReadOnly(workspace), ['/ws', '/ws/extra-boards']);
  });

  it('adds the BOARD_ROOT an existing build recorded', () => {
    const buildDir = path.join(tmp, 'app', 'build', 'primary');
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, 'zephyr_settings.txt'), '# generated\n"BOARD_ROOT":"/modules/acme"\n');
    const app = { appRootPath: path.join(tmp, 'app') } as ZephyrApplication;
    assert.deepEqual(collectBoardRootsReadOnly(workspace, app, configBuiltIn(buildDir)), ['/ws', '/ws/extra-boards', '/modules/acme']);
  });

  it('never configures a build that does not exist yet', () => {
    const appRoot = path.join(tmp, 'app');
    fs.mkdirSync(appRoot);
    const app = { appRootPath: appRoot } as ZephyrApplication;
    const roots = collectBoardRootsReadOnly(workspace, app, configBuiltIn(path.join(appRoot, 'build', 'primary')));
    assert.deepEqual(roots, ['/ws', '/ws/extra-boards']);
    assert.deepEqual(fs.readdirSync(appRoot), [], 'nothing is written into the application, not even .tmp');
  });
});

describe('board roots the agent tools pass to west', () => {
  it('keeps plain absolute roots, spaces and non-ASCII letters included', () => {
    const roots = ['/home/dev/zephyrproject', '/opt/my boards', '/home/zoë/boards'];
    assert.deepEqual(shellSafeRoots(roots), { safe: roots, skipped: [] });
  });

  it('leaves out a root that expands, globs or splits on its way to the shell', () => {
    const unsafe = [
      // Rewritten to ${IFS} for bash, which splits it into --soc-root and more.
      '/opt/b%IFS%--soc-root%IFS%/tmp/x',
      // Unquoted, bash expands it to one argument per matching file.
      '/opt/g/a*',
      // cmd.exe's escape character.
      '/opt/boards^&calc',
      '/opt/b$HOME', 'relative/boards',
    ];
    assert.deepEqual(shellSafeRoots(['/ok', ...unsafe]), { safe: ['/ok'], skipped: unsafe });
  });
});

describe('west listings with a fake west', function () {
  this.timeout(20000);
  useClassUri();

  const configuration = vscode.workspace.getConfiguration;
  let tmp: string;
  let workspace: WestWorkspace;
  let callsFile: string;

  before(function () {
    if (process.platform === 'win32') {
      this.skip();
    }
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-fake-west-'));
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    callsFile = path.join(tmp, 'calls.txt');
    // The fake west records its arguments and pid, then behaves as
    // FAKE_WEST_MODE says: by default like a Zephyr with board qualifiers and
    // shield vendors but no board revisions, with "old" like one from before
    // qualifiers and vendors. It prints only the fields its --format ($3)
    // asks for, and a field it lacks fails as west's KeyError does. It is
    // sourced through a real env script.
    fs.writeFileSync(path.join(bin, 'west'), [
      '#!/bin/sh',
      `echo "$$ $*" >> "${callsFile}"`,
      'case "$FAKE_WEST_MODE" in',
      // west is Python and starts children of its own; the sleep stands in for them.
      `  sleep) sleep 30 & echo "$!" > "${callsFile}.child"; wait ;;`,
      '  unknown) echo "west: unknown command \\"$1\\"" >&2; exit 1 ;;',
      '  *)',
      '    case "$3" in',
      '      *revisions*) echo "KeyError: \'revisions\'" >&2; exit 1 ;;',
      '    esac',
      '    if [ "$FAKE_WEST_MODE" = old ]; then',
      '      case "$3" in',
      '        *qualifiers*) echo "KeyError: \'qualifiers\'" >&2; exit 1 ;;',
      '        *vendor*) echo "KeyError: \'vendor\'" >&2; exit 1 ;;',
      '      esac',
      '    fi',
      '    if [ "$1" = boards ]; then',
      '      case "$3" in',
      '        *qualifiers*) echo "qemu_x86|/z/boards/qemu/x86|atom"; echo "nrf5340dk|/z/boards/nordic/nrf5340dk|nrf5340/cpuapp,nrf5340/cpunet" ;;',
      '        *) echo "qemu_x86|/z/boards/qemu/x86"; echo "nrf5340dk|/z/boards/nordic/nrf5340dk" ;;',
      '      esac',
      '    fi',
      '    if [ "$1" = shields ]; then',
      '      case "$3" in',
      '        *vendor*) echo "x_shield|/z/boards/shields/x_shield|acme|X Shield" ;;',
      '        *) echo "x_shield|/z/boards/shields/x_shield" ;;',
      '      esac',
      '    fi',
      '    ;;',
      'esac',
      '',
    ].join('\n'), { mode: 0o755 });
    const envScript = path.join(tmp, 'env.sh');
    // Each sourcing is counted, and FAKE_NO_WEST leaves no west on PATH at all,
    // as a Python environment without west does.
    fs.writeFileSync(envScript, [
      `echo sourced >> "${callsFile}.env"`,
      `if [ "$FAKE_NO_WEST" = 1 ]; then export PATH=/usr/bin:/bin; else export PATH="${bin}:$PATH"; fi`,
      '',
    ].join('\n'));
    (vscode.workspace as { getConfiguration: unknown }).getConfiguration = () => ({
      get: (key: string) => (key === 'zephyr-workbench.pathToEnvScript' ? envScript : undefined),
      update: async () => undefined,
    });
    workspace = { rootUri: vscode.Uri.file(tmp), buildEnv: {} } as unknown as WestWorkspace;
  });

  afterEach(() => {
    (vscode.workspace as { getConfiguration: unknown }).getConfiguration = configuration;
    delete process.env.FAKE_WEST_MODE;
    delete process.env.FAKE_NO_WEST;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const calls = () => (fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n') : []);
  const shellRuns = () => (fs.existsSync(`${callsFile}.env`) ? fs.readFileSync(`${callsFile}.env`, 'utf8').trim().split('\n').length : 0);

  /**
   * A real WestWorkspace over the temporary folder, which the --format memory
   * keys on, with a Zephyr holding the boards.py and shields.py west
   * extensions. Built without its constructor, which reads settings.
   */
  function realWorkspace(boardRoots: string[] = []): WestWorkspace {
    const extensions = path.join(tmp, 'zephyr', 'scripts', 'west_commands');
    fs.mkdirSync(extensions, { recursive: true });
    fs.writeFileSync(path.join(extensions, 'boards.py'), '# west boards\n');
    fs.writeFileSync(path.join(extensions, 'shields.py'), '# west shields\n');
    return Object.assign(Object.create(WestWorkspace.prototype) as WestWorkspace, {
      name: 'ws',
      rootUri: vscode.Uri.file(tmp),
      zephyrBase: 'zephyr',
      versionArray: {},
      envVars: { BOARD_ROOT: boardRoots, DTS_ROOT: [], SOC_ROOT: [], ARCH_ROOT: [], SNIPPET_ROOT: [] },
    });
  }

  it('probes the richer formats again once west update brings a Zephyr that has them', async () => {
    const ws = realWorkspace();
    process.env.FAKE_WEST_MODE = 'old';
    const before = await getWestBoards(ws);
    assert.deepEqual(before.map(b => b.qualifiers), [[], []]);
    const probed = calls().length;
    await getWestBoards(ws);
    assert.equal(calls().length, probed + 1, 'the format that worked is tried first, so probing is paid once');

    // west update brings a Zephyr whose west boards knows {qualifiers}, and
    // the extension that formats the listing changes on disk with it.
    delete process.env.FAKE_WEST_MODE;
    fs.writeFileSync(path.join(tmp, 'zephyr', 'scripts', 'west_commands', 'boards.py'), '# west boards, with qualifiers\n');
    const after = await getWestBoards(ws);
    assert.deepEqual(after.map(b => [b.name, b.qualifiers]), [
      ['qemu_x86', ['atom']],
      ['nrf5340dk', ['nrf5340/cpuapp', 'nrf5340/cpunet']],
    ]);
    assert.deepEqual(selectableBoardIdentifiers(after[1]), ['nrf5340dk/nrf5340/cpuapp', 'nrf5340dk/nrf5340/cpunet'],
      'the bare name would not be accepted by west build -b');
  });

  it('probes every format again on request, even when the extension did not change', async () => {
    const ws = realWorkspace();
    process.env.FAKE_WEST_MODE = 'old';
    await getWestShields(ws);
    delete process.env.FAKE_WEST_MODE;
    assert.deepEqual(await getWestShields(ws), [{ name: 'x_shield', dir: '/z/boards/shields/x_shield' }],
      'without a request the remembered format is kept');
    assert.deepEqual(await getWestShields(ws, [], { reprobe: true }), [
      { name: 'x_shield', dir: '/z/boards/shields/x_shield', vendor: 'acme', fullName: 'X Shield' },
    ]);
  });

  it('has a catalog refresh probe the formats again', async () => {
    const ws = realWorkspace();
    const sources = new CatalogSources();
    process.env.FAKE_WEST_MODE = 'old';
    const first = await sources.list('shield', ws, undefined, false);
    assert.equal((first.entries as ShieldEntry[])[0].vendor, undefined);
    delete process.env.FAKE_WEST_MODE;
    const refreshed = await sources.list('shield', ws, undefined, true);
    assert.equal((refreshed.entries as ShieldEntry[])[0].vendor, 'acme', 'so the vendor filter finds the shield');
  });

  it('stops probing formats when there is no west to run', async () => {
    process.env.FAKE_NO_WEST = '1';
    await assert.rejects(getWestBoards(workspace), (error: unknown) => {
      assert.ok(error instanceof WestCommandError);
      assert.ok(isWestMissing(error.stderr), `the shell's own wording is recognised: ${error.stderr}`);
      return true;
    });
    assert.equal(shellRuns(), 1, 'every format would fail the same way');
    await assert.rejects(new CatalogSources().list('board', realWorkspace(), undefined, false), (error: unknown) => {
      assert.ok(error instanceof McpToolError);
      assert.equal(error.code, 'ENV_NOT_READY');
      return true;
    });
  });

  it('never hands west a board root that the shell would split', async () => {
    const splitting = '/opt/b%IFS%--soc-root%IFS%/tmp/x';
    const result = await new CatalogSources().list('board', realWorkspace([splitting]), undefined, false);
    assert.deepEqual(result.skippedRoots, [splitting]);
    assert.ok(calls().every(call => !call.includes('--soc-root')), calls().join('\n'));
    assert.deepEqual((result.entries as BoardEntry[]).map(b => b.name), ['nrf5340dk', 'qemu_x86']);
  });

  it('falls back to an older --format and passes board roots', async () => {
    const boards = await getWestBoards(workspace, ['/extra/root']);
    assert.deepEqual(boards.map(b => [b.name, b.qualifiers]), [
      ['qemu_x86', ['atom']],
      ['nrf5340dk', ['nrf5340/cpuapp', 'nrf5340/cpunet']],
    ]);
    const made = calls();
    assert.equal(made.length, 2, 'the richest format fails, the next one works');
    assert.match(made[1], /--board-root \/extra\/root/);
  });

  it('parses west shields with vendor and full name', async () => {
    const shields = await getWestShields(workspace);
    assert.deepEqual(shields, [{ name: 'x_shield', dir: '/z/boards/shields/x_shield', vendor: 'acme', fullName: 'X Shield' }]);
  });

  it('stops probing formats when west does not know the command', async () => {
    process.env.FAKE_WEST_MODE = 'unknown';
    await assert.rejects(getWestShields(workspace), (error: unknown) => {
      assert.ok(error instanceof WestCommandError);
      assert.match(error.stderr, /unknown command/);
      return true;
    });
    assert.equal(calls().length, 1, 'every format would fail the same way');
  });

  it('kills west itself, not only the shell, when the timeout passes', async () => {
    process.env.FAKE_WEST_MODE = 'sleep';
    const started = Date.now();
    await assert.rejects(getWestBoards(workspace, [], { timeoutMs: 800 }), (error: unknown) => {
      assert.ok(error instanceof WestCommandError);
      assert.equal(error.stopped, 'timeout');
      return true;
    });
    assert.ok(Date.now() - started < 8000, 'the timeout must end the call, not the 30 second sleep');
    assert.equal(calls().length, 1, 'a timeout is not retried with another format');
    const pids = [Number(calls()[0].split(' ')[0]), Number(fs.readFileSync(`${callsFile}.child`, 'utf8').trim())];
    const alive = () => pids.some(pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    // Reaping an orphan takes a moment, so poll briefly rather than race it.
    for (let waited = 0; alive() && waited < 3000; waited += 100) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(!alive(), 'west and its children must be gone, not orphaned');
  });

  it('stops west when the caller aborts', async () => {
    process.env.FAKE_WEST_MODE = 'sleep';
    const controller = new AbortController();
    const pending = getWestShields(workspace, [], { signal: controller.signal });
    setTimeout(() => controller.abort(), 500);
    await assert.rejects(pending, (error: unknown) => error instanceof WestCommandError && error.stopped === 'aborted');
  });
});
