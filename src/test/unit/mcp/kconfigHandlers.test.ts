// set_kconfig and query_kconfig's explain mode, with every host dependency faked:
// the application, the jobs, the confirmation and the Kconfig session. The fake
// session answers check_merge by reading the fragments it is given, so these tests
// see exactly what the handler would hand the real kconfig_server.py.

import { strict as assert } from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { findTool, TOOL_CATALOG } from '../../../mcp/core/catalog';
import { McpToolError } from '../../../mcp/core/errors';
import { ToolContext } from '../../../mcp/core/toolSpec';
import { queryKconfig } from '../../../mcp/host/handlers/artifacts';
import type { HostDeps } from '../../../mcp/host/handlers/deps';
import { setKconfig } from '../../../mcp/host/handlers/kconfig';
import { findFragmentAssignments } from '../../../utils/kconfig/fragmentStaleness';
import type { KcCheckMergeResult, KcDriftEntry, KcExplainSymbol, KcMergeSymbol } from '../../../utils/kconfig/kconfigRpcTypes';
import { BEGIN, END } from '../../../utils/kconfig/prjConfWriter';
import { useUiGuard } from './uiGuard';

interface SymbolDef {
  type: string;
  kind?: 'symbol' | 'choice';
  promptless?: boolean;
  /** The value in the loaded .config and after merging today's fragments. */
  current: string;
  /** Given the assigned value, what the symbol ends up as; the value takes when omitted. */
  resolve?: (assigned: string) => { value: string; missingDeps?: { expr: string; value: 'n' | 'm' | 'y' }[] };
}

const SYMBOLS: Record<string, SymbolDef> = {
  GPIO: { type: 'bool', current: 'y' },
  LOG: { type: 'bool', current: 'n' },
  MAIN_STACK_SIZE: { type: 'int', current: '1024' },
  BANNER: { type: 'string', current: 'hi' },
  NEEDS_ACPI: {
    type: 'bool', current: 'n',
    resolve: () => ({ value: 'n', missingDeps: [{ expr: 'ACPI [=n]', value: 'n' }] }),
  },
  DT_HAS_FOO: { type: 'bool', current: 'y', promptless: true },
  FP: { type: 'bool', kind: 'choice', current: 'y' },
};

function unquote(raw: string): string {
  return raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1).replace(/\\(["\\])/g, '$1') : raw;
}

class FakeClient {
  recentStderr: string[] = [];
  state = 'ready';
  calls: { method: string; params: any }[] = [];
  extra: Partial<Extract<KcCheckMergeResult, { ok: true }>> = {};
  /** The temporary values get_drift reports. */
  drift: KcDriftEntry[] = [];
  /** What write_min_config writes. */
  minConfig = 'CONFIG_LOG=y\n# CONFIG_GPIO is not set\n';

  async call<T>(method: string, params: any): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'find') {
      const found: Record<string, unknown> = {};
      const unknown: Record<string, string[]> = {};
      for (const name of params.names as string[]) {
        const def = SYMBOLS[name];
        if (def) {
          found[name] = { kind: def.kind ?? 'symbol', id: 1, type: def.type, hasPrompt: !def.promptless, choice: null, value: def.current, nodeIds: [1] };
        } else {
          unknown[name] = Object.keys(SYMBOLS).filter(candidate => candidate.includes(name.slice(0, 3)));
        }
      }
      return { found, unknown } as T;
    }
    if (method === 'check_merge') {
      const names = params.names as string[];
      const sites = findFragmentAssignments(params.fragments, names);
      const symbols: Record<string, KcMergeSymbol> = {};
      for (const name of names) {
        const def = SYMBOLS[name];
        const winner = sites.get(name)?.slice(-1)[0];
        const assigned = winner ? unquote(winner.value) : null;
        const resolved = assigned !== null && def.resolve ? def.resolve(assigned) : { value: assigned ?? def.current };
        const took = assigned === null || (!def.promptless && resolved.value === assigned);
        symbols[name] = {
          userValue: assigned, value: resolved.value, took,
          failure: def.promptless && assigned !== null ? 'has no prompt, so a configuration file cannot assign it' : null,
          promptless: !!def.promptless,
          assignedAt: winner ? { file: winner.file, line: winner.line } : null,
          missingDeps: resolved.missingDeps ?? [], activeSelectors: [], activeRange: null, choice: null,
        };
      }
      const current = Object.fromEntries(names.map(name => [name, SYMBOLS[name].current]));
      return {
        ok: true, symbols, current, before: current, newFailures: {}, existingFailures: {}, existingFailuresTotal: 0,
        newWarnings: [], sideEffects: [], sideEffectsTotal: 0, discarded: [], discardedTotal: 0, missingFragments: [],
        ...this.extra,
      } as T;
    }
    if (method === 'get_drift') {
      return { ok: true, drift: this.drift.map(entry => ({ ...entry })), missingFragments: [] } as T;
    }
    if (method === 'write_min_config') {
      fs.writeFileSync(params.path, this.minConfig);
      return { message: `Minimal configuration saved to '${params.path}'` } as T;
    }
    if (method === 'explain') {
      const symbols: KcExplainSymbol[] = [];
      const unknown: Record<string, string[]> = {};
      for (const name of params.names as string[]) {
        if (!SYMBOLS[name]) {
          unknown[name] = ['GPIO'];
          continue;
        }
        symbols.push({
          kind: 'symbol', name, type: 'bool', value: SYMBOLS[name].current, userValue: null, assignable: ['n', 'y'],
          visibility: 'y', promptless: false, prompts: [name], helps: [], dependsOn: { value: 'y', terms: [] },
          promptConditions: [], blockedBy: [], selectedBy: [], selectedByTotal: 0, impliedBy: [], impliedByTotal: 0,
          selects: [], implies: [], defaults: [], defaultsTotal: 0, ranges: [], activeRange: null, choice: null,
          definitions: [{ file: 'drivers/Kconfig', line: 7, menuPath: '(Top) > Drivers', active: true }],
          configString: `CONFIG_${name}=y`,
        });
      }
      return { symbols, unknown } as T;
    }
    throw new Error(`unexpected ${method}`);
  }
}

interface World {
  root: string;
  appRoot: string;
  zephyr: string;
  buildDir: string;
  prj: string;
  board: string;
  client: FakeClient;
  editor?: { open: boolean; dirty: boolean };
  /** Every Kconfig Manager tab, as services.kconfigEditors() lists them. */
  editors: { buildDir: string; imageDir: string; configName: string; open: boolean; dirty: boolean }[];
  externalTask?: string;
  jobs: any[];
  confirms: number;
  /** The summary of every confirmation asked, in order. */
  summaries: string[];
  onConfirm?: () => void;
  registered: string[];
  sysbuild: boolean;
  envVars: Record<string, unknown>;
}

function writeBuildInfo(w: World, files: string[], userFiles: string[], extraUserFiles: string[] = []): void {
  const list = (items: string[]) => items.map(item => `     - '${item}'`).join('\n');
  fs.writeFileSync(path.join(w.buildDir, 'build_info.yml'), [
    'cmake:',
    '  kconfig:',
    '    files:',
    list(files),
    ...(userFiles.length ? ['    user-files:', list(userFiles)] : []),
    ...(extraUserFiles.length ? ['    extra-user-files:', list(extraUserFiles)] : []),
    '',
  ].join('\n'));
}

/**
 * Record the fragments as configured, as kconfig.cmake's checksum does, so the build is
 * not stale until one of them changes.
 */
function markConfigured(w: World, files: string[]): void {
  const md5 = (file: string) => crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
  fs.mkdirSync(path.join(w.buildDir, 'zephyr', 'kconfig'), { recursive: true });
  fs.writeFileSync(path.join(w.buildDir, 'zephyr', '.cmake.dotconfig.checksum'), files.map(md5).join(''));
  fs.writeFileSync(path.join(w.buildDir, 'zephyr', 'kconfig', 'sources.txt'), '');
}

function makeWorld(): World {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zwb-kset-')));
  const appRoot = path.join(root, 'app');
  const zephyr = path.join(root, 'zephyr');
  const buildDir = path.join(appRoot, 'build', 'primary');
  fs.mkdirSync(path.join(buildDir, 'zephyr', 'misc', 'generated'), { recursive: true });
  fs.mkdirSync(path.join(zephyr, 'drivers'), { recursive: true });
  fs.writeFileSync(path.join(zephyr, 'drivers', 'Kconfig'), '');
  const board = path.join(zephyr, 'b_defconfig');
  fs.writeFileSync(board, 'CONFIG_GPIO=y\n');
  const prj = path.join(appRoot, 'prj.conf');
  fs.writeFileSync(prj, 'CONFIG_GPIO=y\n');
  for (const file of ['build.ninja', path.join('zephyr', '.config'), path.join('zephyr', 'edt.pickle')]) {
    fs.writeFileSync(path.join(buildDir, file), 'CONFIG_GPIO=y\n');
  }
  const generated = path.join(buildDir, 'zephyr', 'misc', 'generated', 'extra_kconfig_options.conf');
  fs.writeFileSync(generated, '');
  const w: World = {
    root, appRoot, zephyr, buildDir, prj, board, client: new FakeClient(), jobs: [], confirms: 0, summaries: [], registered: [],
    sysbuild: false, envVars: { EXTRA_CONF_FILE: [] }, editors: [],
  };
  writeBuildInfo(w, [board, prj, generated], [prj]);
  return w;
}

function ctxFor(w: World, toolName: string): ToolContext<HostDeps> {
  const config = { name: 'primary', envVars: w.envVars, isSysbuild: () => w.sysbuild, boardIdentifier: 'b' };
  const app = { appRootPath: w.appRoot, appName: 'app', venvPath: undefined, westWorkspaceRootPath: undefined, buildConfigs: [config] };
  const deps = {
    services: {
      resolveTarget: async () => ({ app, config, buildDir: w.buildDir }),
      resolveApp: async () => app,
      resolveDomain: (_a: unknown, _c: unknown, domain?: string) => domain,
      kconfigEditorState: () => w.editor,
      kconfigEditors: () => w.editors,
      externalTaskName: () => w.externalTask,
      withSettingsLock: (_a: unknown, work: () => Promise<unknown>) => work(),
      addExtraConfFile: async (_a: unknown, _c: unknown, file: string) => { w.registered.push(file); return 'added'; },
    },
    jobs: { list: () => w.jobs },
    confirmations: {
      require: async (_ctx: unknown, _args: unknown, subject: { summary: string }) => {
        w.confirms++;
        w.summaries.push(subject.summary);
        w.onConfirm?.();
        return 'allowed';
      },
    },
    kconfig: {
      use: async (dir: string, _o: unknown, fn: (s: unknown) => Promise<unknown>) => fn({
        client: w.client,
        spec: { configPath: path.join(dir, 'zephyr', '.config'), zephyrBase: w.zephyr },
        cold: false,
      }),
    },
  };
  return {
    signal: new AbortController().signal,
    progress: () => undefined,
    client: { name: 'test' },
    deps: deps as unknown as HostDeps,
    tool: findTool(toolName)!,
    startedAt: Date.now(),
    audit: {},
  };
}

async function errorOf(promise: Promise<unknown>): Promise<McpToolError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof McpToolError, `expected a tool error, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the call to fail');
}

describe('set_kconfig', () => {
  useUiGuard();

  let w: World;
  beforeEach(() => { w = makeWorld(); });
  afterEach(() => { fs.rmSync(w.root, { recursive: true, force: true }); });

  const set = (args: Record<string, unknown>) => setKconfig(args, ctxFor(w, 'set_kconfig')) as Promise<any>;

  it('sits right after query_kconfig in the catalog, asks under settings, and is not read-only', () => {
    const names = TOOL_CATALOG.map(tool => tool.name);
    assert.equal(names.indexOf('set_kconfig'), names.indexOf('query_kconfig') + 1);
    const meta = findTool('set_kconfig')!;
    assert.equal(meta.confirm, 'settings');
    assert.deepEqual(meta.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.deepEqual(meta.toolsets, ['core']);
    assert.equal(findTool('query_kconfig')!.annotations.readOnlyHint, true, 'explain keeps query_kconfig read-only');
  });

  it('writes the managed region of prj.conf after the checks and the confirmation', async () => {
    const result = await set({ assignments: [{ symbol: 'CONFIG_LOG', value: true }, { symbol: 'MAIN_STACK_SIZE', value: 2048 }] });
    assert.equal(result.written, true);
    assert.equal(w.confirms, 1);
    assert.deepEqual(result.results.map((r: any) => [r.symbol, r.status]), [['CONFIG_LOG', 'applied'], ['CONFIG_MAIN_STACK_SIZE', 'applied']]);
    assert.equal(fs.readFileSync(w.prj, 'utf8'), `CONFIG_GPIO=y\n\n${BEGIN}\nCONFIG_LOG=y\nCONFIG_MAIN_STACK_SIZE=2048\n${END}\n`);
    assert.deepEqual(result.managed_region, { path: w.prj, lines: ['CONFIG_LOG=y', 'CONFIG_MAIN_STACK_SIZE=2048'] });
    assert.match(result.next, /build_app/);
    // The dialog reads "<agent> wants to <summary>.", so the summary starts with one verb.
    assert.deepEqual(w.summaries, [`change CONFIG_LOG, CONFIG_MAIN_STACK_SIZE in ${w.prj}`]);

    // The merge check saw the proposed text in place of prj.conf, not the file on disk.
    const check = w.client.calls.find(call => call.method === 'check_merge')!;
    assert.equal(check.params.fragments.length, 3);
    assert.notEqual(check.params.fragments[1], w.prj);
    assert.equal(check.params.compare[1], w.prj);
    assert.ok(!fs.existsSync(check.params.fragments[1]), 'the stand-in is removed afterwards');
  });

  it('writes the configuration file the build really merges, such as prj_debug.conf', async () => {
    const debug = path.join(w.appRoot, 'prj_debug.conf');
    fs.writeFileSync(debug, '');
    writeBuildInfo(w, [w.board, debug], [debug]);
    const result = await set({ assignments: [{ symbol: 'LOG', value: 'y' }] });
    assert.equal(result.target.path, debug);
    assert.match(fs.readFileSync(debug, 'utf8'), /CONFIG_LOG=y/);
    assert.equal(fs.readFileSync(w.prj, 'utf8'), 'CONFIG_GPIO=y\n', 'the unused prj.conf is left alone');
  });

  it('checks without writing or asking on a dry run', async () => {
    const result = await set({ assignments: [{ symbol: 'LOG', value: 'y' }], dry_run: true });
    assert.equal(result.dry_run, true);
    assert.equal(result.written, false);
    assert.equal(result.would_write, true);
    assert.deepEqual(result.proposed_region, ['CONFIG_LOG=y']);
    assert.equal(w.confirms, 0);
    assert.equal(fs.readFileSync(w.prj, 'utf8'), 'CONFIG_GPIO=y\n');
  });

  it('writes nothing when any assignment fails, and says why for each', async () => {
    const result = await set({ assignments: [{ symbol: 'LOG', value: 'y' }, { symbol: 'NEEDS_ACPI', value: 'y' }, { symbol: 'DT_HAS_FOO', value: 'y' }] });
    assert.equal(result.written, false);
    assert.equal(w.confirms, 0);
    const byName = Object.fromEntries(result.results.map((r: any) => [r.symbol, r]));
    assert.equal(byName.CONFIG_LOG.status, 'applied');
    assert.equal(byName.CONFIG_NEEDS_ACPI.status, 'rejected');
    assert.deepEqual(byName.CONFIG_NEEDS_ACPI.blocked_by, [{ expr: 'ACPI [=n]', value: 'n' }]);
    assert.equal(byName.CONFIG_DT_HAS_FOO.status, 'rejected');
    assert.match(result.note, /Nothing was written/);
    assert.equal(fs.readFileSync(w.prj, 'utf8'), 'CONFIG_GPIO=y\n');
  });

  it('reports a later fragment that overrides the value instead of writing a line that loses', async () => {
    const extra = path.join(w.appRoot, 'extra.conf');
    fs.writeFileSync(extra, '# CONFIG_LOG is not set\n');
    writeBuildInfo(w, [w.board, w.prj, extra], [w.prj], [extra]);
    const result = await set({ assignments: [{ symbol: 'LOG', value: 'y' }] });
    assert.equal(result.written, false);
    assert.equal(result.results[0].status, 'overridden');
    assert.deepEqual(result.results[0].overridden_by, { file: extra, line: 1 });
  });

  it('refuses a value that does not fit the type, before asking', async () => {
    const result = await set({ assignments: [{ symbol: 'MAIN_STACK_SIZE', value: 'big' }] });
    assert.equal(result.written, false);
    assert.equal(result.results[0].status, 'rejected');
    assert.match(result.results[0].reason, /int/);
  });

  it('removes a managed line with unset', async () => {
    fs.writeFileSync(w.prj, `CONFIG_GPIO=y\n\n${BEGIN}\nCONFIG_LOG=y\nCONFIG_BANNER="x"\n${END}\n`);
    const result = await set({ assignments: [{ symbol: 'LOG', unset: true }] });
    assert.equal(result.written, true);
    assert.equal(result.results[0].status, 'removed');
    assert.equal(fs.readFileSync(w.prj, 'utf8'), `CONFIG_GPIO=y\n\n${BEGIN}\nCONFIG_BANNER="x"\n${END}\n`);
  });

  it('writes nothing and asks nothing when every value is already set that way', async () => {
    fs.writeFileSync(w.prj, `${BEGIN}\nCONFIG_LOG=y\n${END}\n`);
    const result = await set({ assignments: [{ symbol: 'LOG', value: 'y' }] });
    assert.equal(result.written, false);
    assert.equal(result.results[0].status, 'unchanged');
    assert.equal(w.confirms, 0);
  });

  it('escapes a string value and refuses one that would add a line', async () => {
    const result = await set({ assignments: [{ symbol: 'BANNER', value: 'say "hi"' }] });
    assert.equal(result.written, true);
    assert.match(fs.readFileSync(w.prj, 'utf8'), /^CONFIG_BANNER="say \\"hi\\""$/m);
    const error = await errorOf(set({ assignments: [{ symbol: 'BANNER', value: 'x"\nCONFIG_EVIL=y' }] }));
    assert.equal(error.code, 'INVALID_ARGUMENT');
  });

  it('refuses an unknown symbol with suggestions, and a choice', async () => {
    const unknown = await errorOf(set({ assignments: [{ symbol: 'LOGGING', value: 'y' }] }));
    assert.equal(unknown.code, 'INVALID_ARGUMENT');
    assert.deepEqual((unknown.details as any).did_you_mean, { CONFIG_LOGGING: ['CONFIG_LOG'] });
    const choice = await errorOf(set({ assignments: [{ symbol: 'FP', value: 'y' }] }));
    assert.equal(choice.code, 'INVALID_ARGUMENT');
  });

  describe('refuses while something else owns the configuration', () => {
    it('unsaved Kconfig Manager edits', async () => {
      w.editor = { open: true, dirty: true };
      const error = await errorOf(set({ assignments: [{ symbol: 'LOG', value: 'y' }] }));
      assert.equal(error.code, 'BUSY_EXTERNAL');
      assert.equal((error.details as any).editor, 'kconfig_manager');
    });

    it('a clean Kconfig Manager tab is fine', async () => {
      w.editor = { open: true, dirty: false };
      assert.equal((await set({ assignments: [{ symbol: 'LOG', value: 'y' }] })).written, true);
    });

    describe('unsaved Kconfig Manager edits on another build that merges the file', () => {
      /** Another configuration of the application, whose build merges `files`. */
      const otherBuild = (name: string, files: string[]) => {
        const dir = path.join(w.appRoot, 'build', name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'build_info.yml'),
          ['cmake:', '  kconfig:', '    files:', ...files.map(file => `     - '${file}'`), ''].join('\n'));
        return dir;
      };

      it('refuse a change to prj.conf, which every configuration merges', async () => {
        const debug = otherBuild('debug', [w.board, w.prj]);
        w.editors = [{ buildDir: debug, imageDir: debug, configName: 'debug', open: true, dirty: true }];
        const error = await errorOf(set({ assignments: [{ symbol: 'LOG', value: 'y' }] }));
        assert.equal(error.code, 'BUSY_EXTERNAL');
        assert.equal((error.details as any).config_name, 'debug');
        assert.equal(fs.readFileSync(w.prj, 'utf8'), 'CONFIG_GPIO=y\n');
      });

      it('are checked again after the confirmation', async () => {
        const debug = otherBuild('debug', [w.board, w.prj]);
        w.onConfirm = () => { w.editors = [{ buildDir: debug, imageDir: debug, configName: 'debug', open: true, dirty: true }]; };
        const error = await errorOf(set({ assignments: [{ symbol: 'LOG', value: 'y' }] }));
        assert.equal(error.code, 'BUSY_EXTERNAL');
        assert.equal(fs.readFileSync(w.prj, 'utf8'), 'CONFIG_GPIO=y\n');
      });

      it('do not refuse a file that build does not merge, nor a clean tab', async () => {
        const other = path.join(w.appRoot, 'prj_other.conf');
        const debug = otherBuild('debug', [w.board, other]);
        const release = otherBuild('release', [w.board, w.prj]);
        w.editors = [
          { buildDir: debug, imageDir: debug, configName: 'debug', open: true, dirty: true },
          { buildDir: release, imageDir: release, configName: 'release', open: true, dirty: false },
        ];
        assert.equal((await set({ assignments: [{ symbol: 'LOG', value: 'y' }] })).written, true);
      });

      it('refuse when that build has no fragment list to tell', async () => {
        const debug = path.join(w.appRoot, 'build', 'debug');
        w.editors = [{ buildDir: debug, imageDir: debug, configName: 'debug', open: false, dirty: true }];
        assert.equal((await errorOf(set({ assignments: [{ symbol: 'LOG', value: 'y' }] }))).code, 'BUSY_EXTERNAL');
      });
    });

    it('an agent build in the same build directory', async () => {
      w.jobs = [{ id: 'j1', status: 'running', spec: { kind: 'build', lockKey: w.buildDir } }];
      const error = await errorOf(set({ assignments: [{ symbol: 'LOG', value: 'y' }] }));
      assert.equal(error.code, 'BUSY');
      assert.equal((error.details as any).job_id, 'j1');
    });

    it('a finished agent build does not count', async () => {
      w.jobs = [{ id: 'j1', status: 'succeeded', endedAt: 1, spec: { kind: 'build', lockKey: w.buildDir } }];
      assert.equal((await set({ assignments: [{ symbol: 'LOG', value: 'y' }] })).written, true);
    });

    it('a task the user started', async () => {
      w.externalTask = 'West Build';
      const error = await errorOf(set({ assignments: [{ symbol: 'LOG', value: 'y' }] }));
      assert.equal(error.code, 'BUSY_EXTERNAL');
    });

    it('a change to the file while the user was being asked', async () => {
      w.onConfirm = () => fs.appendFileSync(w.prj, 'CONFIG_X=y\n');
      const error = await errorOf(set({ assignments: [{ symbol: 'LOG', value: 'y' }] }));
      assert.equal(error.code, 'BUSY_EXTERNAL');
      assert.equal(fs.readFileSync(w.prj, 'utf8'), 'CONFIG_GPIO=y\nCONFIG_X=y\n');
    });

    it('a build that started while the user was being asked', async () => {
      w.onConfirm = () => { w.externalTask = 'West Build'; };
      const error = await errorOf(set({ assignments: [{ symbol: 'LOG', value: 'y' }] }));
      assert.equal(error.code, 'BUSY_EXTERNAL');
      assert.equal(fs.readFileSync(w.prj, 'utf8'), 'CONFIG_GPIO=y\n');
    });
  });

  it('writes nothing when the user declines', async () => {
    const ctx = ctxFor(w, 'set_kconfig');
    (ctx.deps.confirmations as any).require = async () => { throw new McpToolError('USER_DENIED', 'no'); };
    const error = await errorOf(setKconfig({ assignments: [{ symbol: 'LOG', value: 'y' }] }, ctx));
    assert.equal(error.code, 'USER_DENIED');
    assert.equal(fs.readFileSync(w.prj, 'utf8'), 'CONFIG_GPIO=y\n');
  });

  it('asks the user to configure first when the build is incomplete', async () => {
    fs.rmSync(path.join(w.buildDir, 'zephyr', 'edt.pickle'));
    const error = await errorOf(set({ assignments: [{ symbol: 'LOG', value: 'y' }] }));
    assert.equal(error.code, 'BUILD_NOT_CONFIGURED');
    assert.match(error.hint ?? '', /build_app with cmake_only true/);
  });

  describe('fragments', () => {
    it('validates fragment_path before anything else', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ target: 'fragment' }, 'INVALID_ARGUMENT'],
        [{ target: 'fragment', fragment_path: 'debug.conf' }, 'INVALID_ARGUMENT'],
        [{ target: 'fragment', fragment_path: path.join(w.appRoot, 'debug.txt') }, 'INVALID_ARGUMENT'],
        [{ target: 'fragment', fragment_path: path.join(w.appRoot, 'a;b.conf') }, 'INVALID_ARGUMENT'],
        [{ target: 'fragment', fragment_path: path.join(w.appRoot, '${workspaceFolder}.conf') }, 'INVALID_ARGUMENT'],
        [{ target: 'fragment', fragment_path: path.join(w.root, 'elsewhere.conf') }, 'PATH_OUTSIDE_WORKSPACE'],
        [{ target: 'fragment', fragment_path: path.join(w.buildDir, 'zephyr', 'misc', 'generated', 'extra_kconfig_options.conf') }, 'INVALID_ARGUMENT'],
        [{ fragment_path: path.join(w.appRoot, 'debug.conf') }, 'INVALID_ARGUMENT'],
        [{ register_fragment: true }, 'INVALID_ARGUMENT'],
      ];
      for (const [extra, expected] of cases) {
        const error = await errorOf(set({ assignments: [{ symbol: 'LOG', value: 'y' }], ...extra }));
        assert.equal(error.code, expected, JSON.stringify(extra));
      }
      assert.equal(w.client.calls.length, 0, 'no session is used for a bad argument');
    });

    it('refuses a link that leads out of the application', async function () {
      const outside = path.join(w.root, 'outside');
      fs.mkdirSync(outside);
      try {
        fs.symlinkSync(outside, path.join(w.appRoot, 'linked'));
      } catch {
        this.skip();
      }
      const error = await errorOf(set({
        assignments: [{ symbol: 'LOG', value: 'y' }], target: 'fragment', fragment_path: path.join(w.appRoot, 'linked', 'x.conf'),
      }));
      assert.equal(error.code, 'PATH_OUTSIDE_WORKSPACE');
    });

    it('creates a new fragment, and says it is not part of the build yet', async () => {
      const fragment = path.join(w.appRoot, 'conf', 'debug.conf');
      const result = await set({ assignments: [{ symbol: 'LOG', value: 'y' }], target: 'fragment', fragment_path: fragment });
      assert.equal(result.written, true);
      assert.deepEqual(result.target, { kind: 'fragment', path: fragment, in_build: false, registered: false });
      assert.match(result.in_build_note, /register_fragment/);
      assert.equal(fs.readFileSync(fragment, 'utf8'), `${BEGIN}\nCONFIG_LOG=y\n${END}\n`);
      assert.deepEqual(w.registered, []);
      // The check merged it where EXTRA_CONF_FILE entries go: before the generated file.
      const check = w.client.calls.find(call => call.method === 'check_merge')!;
      assert.equal(check.params.fragments.length, 4);
      assert.match(check.params.fragments[3], /extra_kconfig_options\.conf$/);
    });

    it('registers a new fragment in EXTRA_CONF_FILE when asked', async () => {
      const fragment = path.join(w.appRoot, 'debug.conf');
      const result = await set({ assignments: [{ symbol: 'LOG', value: 'y' }], target: 'fragment', fragment_path: fragment, register_fragment: true });
      assert.equal(result.written, true);
      assert.equal(result.target.registered, true);
      assert.deepEqual(w.registered, [fragment]);
      assert.equal(w.confirms, 1);
    });

    it('does not register again a fragment already listed', async () => {
      const fragment = path.join(w.appRoot, 'debug.conf');
      w.envVars.EXTRA_CONF_FILE = [fragment];
      const result = await set({ assignments: [{ symbol: 'LOG', value: 'y' }], target: 'fragment', fragment_path: fragment, register_fragment: true });
      assert.equal(result.target.registered, true);
      assert.deepEqual(w.registered, []);
    });

    it('refuses to register a fragment for sysbuild, whose builds never see EXTRA_CONF_FILE', async () => {
      w.sysbuild = true;
      const error = await errorOf(set({
        assignments: [{ symbol: 'LOG', value: 'y' }], target: 'fragment', fragment_path: path.join(w.appRoot, 'debug.conf'), register_fragment: true,
      }));
      assert.equal(error.code, 'INVALID_ARGUMENT');
      const result = await set({ assignments: [{ symbol: 'LOG', value: 'y' }], target: 'fragment', fragment_path: path.join(w.appRoot, 'debug.conf'), dry_run: true });
      assert.match(result.in_build_note, /prj_conf/);
      assert.doesNotMatch(result.in_build_note, /register_fragment/);
    });
  });
});

describe('query_kconfig with explain', () => {
  useUiGuard();

  let w: World;
  beforeEach(() => { w = makeWorld(); });
  afterEach(() => { fs.rmSync(w.root, { recursive: true, force: true }); });

  const explain = (args: Record<string, unknown>) => queryKconfig({ explain: true, ...args }, ctxFor(w, 'query_kconfig')) as Promise<any>;

  it('takes 1 to 10 names and no other filter', async () => {
    assert.equal((await errorOf(explain({ symbols: [] }))).code, 'INVALID_ARGUMENT');
    assert.equal((await errorOf(explain({ symbols: Array.from({ length: 11 }, (_, i) => `S${i}`) }))).code, 'INVALID_ARGUMENT');
    assert.equal((await errorOf(explain({ symbols: ['GPIO'], pattern: 'GP*' }))).code, 'INVALID_ARGUMENT');
    assert.equal((await errorOf(explain({ symbols: ['GPIO;x'] }))).code, 'INVALID_ARGUMENT');
  });

  it('explains from the live tree with absolute definition paths and the fragments that assign it', async () => {
    const result = await explain({ symbols: ['CONFIG_GPIO', 'GPIOO'] });
    assert.equal(result.config_path, path.join(w.buildDir, 'zephyr', '.config'));
    assert.equal(result.symbols.length, 1);
    const gpio = result.symbols[0];
    assert.equal(gpio.name, 'CONFIG_GPIO');
    assert.equal(gpio.defined_at[0].file, path.join(w.zephyr, 'drivers', 'Kconfig'));
    assert.deepEqual(gpio.assigned_in, [{ file: w.board, line: 1, value: 'y' }, { file: w.prj, line: 1, value: 'y' }]);
    assert.equal(typeof gpio.how_to_change, 'string');
    assert.deepEqual(result.not_found, [{ symbol: 'CONFIG_GPIOO', did_you_mean: ['CONFIG_GPIO'] }]);
    assert.equal(result.editor_unsaved, undefined);
    assert.deepEqual(w.client.calls.map(call => call.method), ['explain']);
  });

  it('says when the Kconfig Manager holds unsaved edits', async () => {
    w.editor = { open: true, dirty: true };
    const result = await explain({ symbols: ['GPIO'] });
    assert.equal(result.editor_unsaved, true);
    assert.match(result.note, /unsaved/);
  });
});

describe('set_kconfig with persist_temporary', () => {
  useUiGuard();

  let w: World;
  let generated: string;
  beforeEach(() => {
    w = makeWorld();
    generated = path.join(w.buildDir, 'zephyr', 'misc', 'generated', 'extra_kconfig_options.conf');
    markConfigured(w, [w.board, w.prj, generated]);
  });
  afterEach(() => { fs.rmSync(w.root, { recursive: true, force: true }); });

  const set = (args: Record<string, unknown>) => setKconfig(args, ctxFor(w, 'set_kconfig')) as Promise<any>;
  const drift = (name: string, current: string, baseline: string, configString: string, extra: Partial<KcDriftEntry> = {}): KcDriftEntry =>
    ({ name, current, baseline, configString, ...extra });

  it('needs assignments or persist_temporary', async () => {
    assert.equal((await errorOf(set({}))).code, 'INVALID_ARGUMENT');
    assert.equal((await errorOf(set({ persist_temporary: 'yes' }))).code, 'INVALID_ARGUMENT');
    assert.equal(w.client.calls.length, 0);
  });

  it('writes the temporary values into the managed region as the Kconfig Manager export does, after the merge check', async () => {
    w.client.drift = [drift('LOG', 'y', 'n', 'CONFIG_LOG=y'), drift('BANNER', 'hello "x"', 'hi', 'CONFIG_BANNER="hello \\"x\\""')];
    const result = await set({ persist_temporary: true });
    assert.equal(result.written, true);
    assert.equal(w.confirms, 1);
    assert.equal(fs.readFileSync(w.prj, 'utf8'), `CONFIG_GPIO=y\n\n${BEGIN}\nCONFIG_LOG=y\nCONFIG_BANNER="hello \\"x\\""\n${END}\n`);
    assert.deepEqual(w.summaries, [`save the temporary values of CONFIG_LOG, CONFIG_BANNER in ${w.prj}`]);
    assert.deepEqual(result.results.map((r: any) => [r.symbol, r.status, r.temporary]), [['CONFIG_LOG', 'applied', true], ['CONFIG_BANNER', 'applied', true]]);
    assert.deepEqual(result.temporary_values[0], { symbol: 'CONFIG_LOG', value: 'y', configuration_files_give: 'n', line: 'CONFIG_LOG=y' });
    // get_drift was asked with the build's fragments and the target's managed region.
    const asked = w.client.calls.find(call => call.method === 'get_drift')!;
    assert.deepEqual(asked.params, { fragments: [w.board, w.prj, generated], managed: { path: w.prj, lines: [] } });
    const check = w.client.calls.find(call => call.method === 'check_merge')!;
    assert.deepEqual(check.params.names, ['LOG', 'BANNER']);
  });

  it('lets an assignment of the same symbol win over its temporary value', async () => {
    w.client.drift = [drift('LOG', 'y', 'n', 'CONFIG_LOG=y'), drift('MAIN_STACK_SIZE', '4096', '1024', 'CONFIG_MAIN_STACK_SIZE=4096')];
    const result = await set({ assignments: [{ symbol: 'LOG', value: 'n' }], persist_temporary: true });
    assert.equal(result.written, true);
    assert.match(fs.readFileSync(w.prj, 'utf8'), /CONFIG_LOG=n\nCONFIG_MAIN_STACK_SIZE=4096/);
    assert.deepEqual(result.temporary_values.map((t: any) => t.symbol), ['CONFIG_MAIN_STACK_SIZE']);
    assert.deepEqual(w.summaries, [`change CONFIG_LOG and save the temporary value of CONFIG_MAIN_STACK_SIZE in ${w.prj}`]);
  });

  it('removes a managed line a configuration file can no longer assign', async () => {
    fs.writeFileSync(w.prj, `CONFIG_GPIO=y\n\n${BEGIN}\nCONFIG_LOG=y\nCONFIG_BANNER="x"\n${END}\n`);
    markConfigured(w, [w.board, w.prj, generated]);
    w.client.drift = [drift('LOG', 'n', 'y', '', { managedLine: 'remove' })];
    const result = await set({ persist_temporary: true });
    assert.equal(result.written, true);
    assert.equal(result.results[0].status, 'removed');
    assert.equal(result.temporary_values[0].action, 'remove_managed_line');
    assert.equal(fs.readFileSync(w.prj, 'utf8'), `CONFIG_GPIO=y\n\n${BEGIN}\nCONFIG_BANNER="x"\n${END}\n`);
    const asked = w.client.calls.find(call => call.method === 'get_drift')!;
    assert.deepEqual(asked.params.managed.lines, ['CONFIG_LOG=y', 'CONFIG_BANNER="x"']);
  });

  it('writes nothing when a later fragment overrides a temporary value, and says which', async () => {
    const extra = path.join(w.appRoot, 'extra.conf');
    fs.writeFileSync(extra, '# CONFIG_LOG is not set\n');
    writeBuildInfo(w, [w.board, w.prj, extra, generated], [w.prj], [extra]);
    markConfigured(w, [w.board, w.prj, extra, generated]);
    w.client.drift = [drift('LOG', 'y', 'n', 'CONFIG_LOG=y')];
    const result = await set({ persist_temporary: true });
    assert.equal(result.written, false);
    assert.equal(result.results[0].status, 'overridden');
    assert.equal(result.temporary_values[0].overridden_by, extra);
    assert.equal(w.confirms, 0);
  });

  it('asks nothing and writes nothing without temporary values', async () => {
    const result = await set({ persist_temporary: true });
    assert.equal(result.written, false);
    assert.deepEqual(result.temporary_values, []);
    assert.match(result.note, /no temporary values/);
    assert.equal(w.confirms, 0);
    assert.deepEqual(w.client.calls.map(call => call.method), ['get_drift']);
  });

  it('checks without writing on a dry run', async () => {
    w.client.drift = [drift('LOG', 'y', 'n', 'CONFIG_LOG=y')];
    const result = await set({ persist_temporary: true, dry_run: true });
    assert.equal(result.would_write, true);
    assert.deepEqual(result.proposed_region, ['CONFIG_LOG=y']);
    assert.equal(w.confirms, 0);
    assert.equal(fs.readFileSync(w.prj, 'utf8'), 'CONFIG_GPIO=y\n');
  });

  it('is refused while the Kconfig Manager of the build has unsaved edits', async () => {
    w.client.drift = [drift('LOG', 'y', 'n', 'CONFIG_LOG=y')];
    w.editor = { open: true, dirty: true };
    assert.equal((await errorOf(set({ persist_temporary: true }))).code, 'BUSY_EXTERNAL');
    assert.equal(w.client.calls.length, 0);
  });

  it('is refused once a configuration file changed since the last configure', async () => {
    w.client.drift = [drift('LOG', 'y', 'n', 'CONFIG_LOG=y')];
    fs.appendFileSync(w.prj, 'CONFIG_BANNER="edited"\n');
    const error = await errorOf(set({ persist_temporary: true }));
    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.match(error.message, /prj\.conf/);
    assert.equal(w.client.calls.length, 0);
  });
});

describe('query_kconfig with format defconfig', () => {
  useUiGuard();

  let w: World;
  beforeEach(() => { w = makeWorld(); });
  afterEach(() => { fs.rmSync(w.root, { recursive: true, force: true }); });

  const query = (args: Record<string, unknown>) => queryKconfig({ format: 'defconfig', ...args }, ctxFor(w, 'query_kconfig')) as Promise<any>;

  it('returns the minimal configuration through the build\'s Kconfig session and leaves no file behind', async () => {
    const result = await query({});
    assert.equal(result.format, 'defconfig');
    assert.equal(result.defconfig, 'CONFIG_LOG=y\n# CONFIG_GPIO is not set\n');
    assert.equal(result.options, 2);
    assert.equal(result.config_path, path.join(w.buildDir, 'zephyr', '.config'));
    const call = w.client.calls.find(entry => entry.method === 'write_min_config')!;
    assert.ok(path.isAbsolute(call.params.path));
    assert.ok(!fs.existsSync(call.params.path), 'the temporary file is deleted');
  });

  it('takes no other filter', async () => {
    for (const extra of [{ symbols: ['LOG'] }, { pattern: 'LOG' }, { only_set: true }, { limit: 5 }, { offset: 1 }, { explain: true }]) {
      assert.equal((await errorOf(query(extra))).code, 'INVALID_ARGUMENT', JSON.stringify(extra));
    }
    assert.equal((await errorOf(queryKconfig({ format: 'minimal' }, ctxFor(w, 'query_kconfig')))).code, 'INVALID_ARGUMENT');
    assert.equal(w.client.calls.length, 0);
  });

  it('says when the Kconfig Manager holds unsaved edits', async () => {
    w.editor = { open: true, dirty: true };
    assert.equal((await query({})).editor_unsaved, true);
  });
});
