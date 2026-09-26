// The agent methods of scripts/kconfig/kconfig_server.py (find, explain, check_merge)
// and set_kconfig end to end, against the real server and Zephyr's own kconfiglib, on a
// small Kconfig tree written here so every expected value is known.
//
// Needs a Python 3 and a Zephyr tree for kconfiglib: set ZEPHYR_BASE (or
// ZW_TEST_ZEPHYR_BASE) and optionally ZW_TEST_PYTHON. Skipped when either is missing.

import { strict as assert } from 'assert';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { findTool } from '../../../mcp/core/catalog';
import { ToolContext } from '../../../mcp/core/toolSpec';
import { queryKconfig } from '../../../mcp/host/handlers/artifacts';
import type { HostDeps } from '../../../mcp/host/handlers/deps';
import { setKconfig } from '../../../mcp/host/handlers/kconfig';
import type { KconfigLaunchSpec } from '../../../utils/kconfig/kconfigEnvExtractor';
import type { KcCheckMergeResult, KcExplainResult, KcExplainSymbol, KcFindResult } from '../../../utils/kconfig/kconfigRpcTypes';
import { KconfigServerClient } from '../../../utils/kconfig/kconfigServerClient';
import { KconfigSessionPool } from '../../../utils/kconfig/kconfigSessionPool';
import { BEGIN, END, readPrjConfManagedRegion, upsertPrjConfManagedRegion } from '../../../utils/kconfig/prjConfWriter';
import { driftExportEdits } from '../../../utils/kconfig/driftExport';
import type { KcDriftEntry } from '../../../utils/kconfig/kconfigRpcTypes';

const SERVER = path.resolve(__dirname, '../../../../scripts/kconfig/kconfig_server.py');

function findPython(): string | undefined {
  for (const candidate of [process.env.ZW_TEST_PYTHON, 'python3', 'python']) {
    if (!candidate) { continue; }
    const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim() === '3') { return candidate; }
  }
  return undefined;
}

function findKconfiglib(): string | undefined {
  for (const base of [process.env.ZW_TEST_ZEPHYR_BASE, process.env.ZEPHYR_BASE]) {
    const file = base ? path.join(base, 'scripts', 'kconfig', 'kconfiglib.py') : undefined;
    if (file && fs.existsSync(file)) { return file; }
  }
  return undefined;
}

const KCONFIG = `mainmenu "Workbench test"

config GPIO
	bool "GPIO drivers"

config LOG
	bool "Logging"

config LOG_LEVEL
	int "Default log level"
	depends on LOG
	range 0 4
	default 3

config LOG_BACKEND
	bool "Log backend"
	depends on LOG
	default y

config ACPI
	bool

config NEEDS_ACPI
	bool "Needs ACPI"
	depends on ACPI

config SELECTOR
	bool "Selector"
	select FORCED

config FORCED
	bool "Forced on by SELECTOR"

config DT_HAS_FOO
	bool
	default y

config BANNER
	string "Boot banner"
	default "hello"

choice FP_FORMAT
	prompt "FP format"
	default FP_A

config FP_A
	bool "Format A"

config FP_B
	bool "Format B"

endchoice

menu "Extras"
	visible if LOG

config HIDDEN_OPT
	bool "Shown only with logging"

endmenu
`;

describe('kconfig_server.py agent methods (integration)', function () {
  this.timeout(60000);

  let python: string | undefined;
  let root: string;
  let zbase: string;
  let appRoot: string;
  let buildDir: string;
  let configPath: string;
  let prj: string;
  let extra: string;
  let board: string;
  let spec: KconfigLaunchSpec;
  let pool: KconfigSessionPool;

  const rawClient = async () => {
    const client = new KconfigServerClient({ spec, serverScriptPath: SERVER });
    await client.start();
    await client.call('init', {}, 60000);
    return client;
  };

  before(async function () {
    python = findPython();
    const kconfiglib = findKconfiglib();
    if (!python || !kconfiglib) {
      this.skip();
    }
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zwb-kserver-')));
    // A minimal ZEPHYR_BASE: the server only needs kconfiglib from scripts/kconfig.
    zbase = path.join(root, 'zephyr');
    fs.mkdirSync(path.join(zbase, 'scripts', 'kconfig'), { recursive: true });
    fs.copyFileSync(kconfiglib as string, path.join(zbase, 'scripts', 'kconfig', 'kconfiglib.py'));
    fs.writeFileSync(path.join(zbase, 'Kconfig'), KCONFIG);
    board = path.join(zbase, 'test_defconfig');
    fs.writeFileSync(board, 'CONFIG_GPIO=y\nCONFIG_SELECTOR=y\n');

    appRoot = path.join(root, 'app');
    buildDir = path.join(appRoot, 'build', 'primary');
    fs.mkdirSync(path.join(buildDir, 'zephyr', 'kconfig'), { recursive: true });
    prj = path.join(appRoot, 'prj.conf');
    fs.writeFileSync(prj, 'CONFIG_GPIO=y\n');
    extra = path.join(appRoot, 'extra.conf');
    fs.writeFileSync(extra, 'CONFIG_BANNER="from extra"\n');
    fs.writeFileSync(path.join(buildDir, 'build.ninja'), '');
    fs.writeFileSync(path.join(buildDir, 'zephyr', 'edt.pickle'), '');
    fs.writeFileSync(path.join(buildDir, 'build_info.yml'), [
      'cmake:', '  kconfig:',
      '    files:', `     - '${board}'`, `     - '${prj}'`, `     - '${extra}'`,
      '    user-files:', `     - '${prj}'`,
      '    extra-user-files:', `     - '${extra}'`, '',
    ].join('\n'));

    configPath = path.join(buildDir, 'zephyr', '.config');
    spec = {
      env: { ZEPHYR_BASE: zbase, srctree: zbase, KCONFIG_CONFIG: configPath },
      python: python as string,
      kconfigRoot: path.join(zbase, 'Kconfig'),
      cwd: path.join(buildDir, 'zephyr', 'kconfig'),
      zephyrBase: zbase,
      configPath,
      edtPickle: path.join(buildDir, 'zephyr', 'edt.pickle'),
      source: 'ninja',
      buildDir,
    };

    // Produce .config the way a configure does: merge the fragments, write it out.
    const setup = await rawClient();
    await setup.call('load_config', { path: board, replace: true });
    await setup.call('load_config', { path: prj, replace: false });
    await setup.call('load_config', { path: extra, replace: false });
    await setup.call('write_config', { path: configPath });
    await setup.dispose();

    pool = new KconfigSessionPool({
      serverScriptPath: SERVER,
      start: async o => {
        const client = new KconfigServerClient({ spec, serverScriptPath: SERVER });
        o.onCreated?.(client, spec);
        await client.start();
        await client.call('init', {}, 60000);
        return { client, spec };
      },
    });
  });

  after(async () => {
    await pool?.closeAll();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const use = <T>(fn: (client: KconfigServerClient) => Promise<T>) =>
    pool.use(buildDir, {}, session => fn(session.client as KconfigServerClient));

  it('finds names without loading the whole tree, and suggests close ones', async () => {
    const found = await use(client => client.call<KcFindResult>('find', { names: ['GPIO', 'DT_HAS_FOO', 'FP_FORMAT', 'GPI'] }));
    assert.equal(found.found.GPIO.hasPrompt, true);
    assert.equal(found.found.GPIO.value, 'y');
    assert.equal(found.found.DT_HAS_FOO.hasPrompt, false);
    assert.equal(found.found.FP_FORMAT.kind, 'choice');
    assert.ok(found.unknown.GPI.includes('GPIO'));
  });

  it('explains what blocks, selects and hides a symbol', async () => {
    const result = await use(client => client.call<KcExplainResult>('explain', {
      names: ['NEEDS_ACPI', 'FORCED', 'HIDDEN_OPT', 'DT_HAS_FOO', 'FP_A'],
    }));
    const by = Object.fromEntries(result.symbols.map(s => [s.name, s as KcExplainSymbol]));
    assert.deepEqual(by.NEEDS_ACPI.blockedBy, [{ expr: 'ACPI [=n]', value: 'n', kind: 'depends_on' }]);
    assert.deepEqual(by.FORCED.selectedBy.map(s => [s.name, s.active]), [['SELECTOR', true]]);
    assert.equal(by.FORCED.value, 'y');
    assert.deepEqual(by.HIDDEN_OPT.blockedBy.map(t => [t.expr, t.kind]), [['LOG [=n]', 'visibility']]);
    assert.equal(by.DT_HAS_FOO.promptless, true);
    assert.equal(by.FP_A.choice?.selected, 'FP_A');
    assert.deepEqual(by.FP_A.choice?.members.map(m => m.name), ['FP_A', 'FP_B']);
    assert.equal(by.NEEDS_ACPI.definitions[0].file, path.join(zbase, 'Kconfig'));
  });

  it('merges proposed fragments the way the build will, then puts the loaded state back exactly', async () => {
    const before = fs.readFileSync(configPath);
    const standIn = path.join(root, 'standin.conf');
    fs.writeFileSync(standIn, [
      'CONFIG_GPIO=y', 'CONFIG_LOG=y', 'CONFIG_LOG_LEVEL=9', 'CONFIG_NEEDS_ACPI=y', 'CONFIG_DT_HAS_FOO=y',
      '# CONFIG_FP_A is not set', 'CONFIG_NOPE=y', '',
    ].join('\n'));
    const stateBefore = await use(client => client.call<{ needsSave: boolean }>('get_state', {}));
    const check = await use(client => client.call<KcCheckMergeResult>('check_merge', {
      fragments: [board, standIn, extra], compare: [board, prj, extra],
      names: ['LOG', 'LOG_LEVEL', 'NEEDS_ACPI', 'DT_HAS_FOO', 'FP_A', 'BANNER'],
    }));
    assert.ok(check.ok);
    if (!check.ok) { return; }
    assert.equal(check.symbols.LOG.took, true);
    assert.equal(check.symbols.LOG_LEVEL.took, false, '9 is outside 0 to 4');
    assert.deepEqual(check.symbols.LOG_LEVEL.activeRange, { low: '0', high: '4' });
    assert.equal(check.symbols.NEEDS_ACPI.took, false);
    assert.deepEqual(check.symbols.NEEDS_ACPI.missingDeps, [{ expr: 'ACPI [=n]', value: 'n' }]);
    assert.equal(check.symbols.DT_HAS_FOO.promptless, true);
    assert.equal(check.symbols.DT_HAS_FOO.took, false);
    assert.equal(check.symbols.FP_A.took, false, 'a y-mode choice keeps its default member');
    assert.equal(check.symbols.BANNER.userValue, 'from extra');
    assert.ok(check.newWarnings.some(w => w.includes('NOPE')), 'an undefined symbol aborts the configure');
    assert.deepEqual(check.sideEffects, [{ name: 'LOG_BACKEND', from: 'n', to: 'y' }]);
    assert.equal(check.current.LOG, 'n');

    // Nothing leaked: the file is untouched and the session still holds the loaded .config.
    assert.deepEqual(fs.readFileSync(configPath), before);
    const stateAfter = await use(client => client.call<{ needsSave: boolean }>('get_state', {}));
    assert.deepEqual(stateAfter, stateBefore);
    const log = await use(client => client.call<KcFindResult>('find', { names: ['LOG'] }));
    assert.equal(log.found.LOG.value, 'n');
  });

  describe('get_drift with the managed region of the export target', () => {
    let client: KconfigServerClient;
    let target: string;
    let later: string;

    before(async () => {
      target = path.join(root, 'drift', 'prj.conf');
      later = path.join(root, 'drift', 'later.conf');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `CONFIG_GPIO=y\n\n${BEGIN}\nCONFIG_LOG=y\nCONFIG_LOG_LEVEL=4\nCONFIG_GPIO=y\n${END}\n`);
      fs.writeFileSync(later, '# CONFIG_LOG is not set\n');
      // A build merged from [board, target], then the user set LOG back to n, its default.
      client = await rawClient();
      await client.call('load_config', { path: board, replace: true });
      await client.call('load_config', { path: target, replace: false });
      const found = await client.call<KcFindResult>('find', { names: ['LOG'] });
      await client.call('set_value', { id: found.found.LOG.nodeIds[0], value: 'n' });
    });
    after(async () => { await client?.dispose(); });

    const drift = async (fragments: string[], withRegion: boolean) => {
      const res = await client.call<{ ok: boolean; drift: KcDriftEntry[] }>('get_drift', {
        fragments, ...(withRegion ? { managed: { path: target, lines: readPrjConfManagedRegion(target) } } : {}),
      });
      assert.ok(res.ok);
      return res.drift;
    };
    const byName = (entries: KcDriftEntry[]) => Object.fromEntries(entries.map(entry => [entry.name, entry]));

    it('rewrites a pinned value set back to its default, and drops a pinned line that no longer applies', async () => {
      const plain = byName(await drift([board, target], false));
      assert.equal(plain.LOG, undefined, 'savedefconfig leaves out a value equal to its default');
      assert.equal(plain.LOG_LEVEL, undefined, 'and a symbol that cannot be set');

      const entries = await drift([board, target], true);
      const by = byName(entries);
      assert.deepEqual([by.LOG.managedLine, by.LOG.configString, by.LOG.baseline, by.LOG.current], ['update', '# CONFIG_LOG is not set', 'y', 'n']);
      assert.deepEqual([by.LOG_LEVEL.managedLine, by.LOG_LEVEL.configString], ['remove', '']);
      assert.equal(by.GPIO, undefined, 'a pinned line that still gives the current value stays');

      // Written the way the export writes, the next merge keeps the user's n.
      const edits = driftExportEdits(entries);
      upsertPrjConfManagedRegion(target, edits.lines, edits.remove.map(name => `CONFIG_${name}`));
      assert.deepEqual(readPrjConfManagedRegion(target), ['# CONFIG_LOG is not set', 'CONFIG_GPIO=y']);
      const merged = await rawClient();
      try {
        await merged.call('load_config', { path: board, replace: true });
        await merged.call('load_config', { path: target, replace: false });
        const log = await merged.call<KcFindResult>('find', { names: ['LOG'] });
        assert.equal(log.found.LOG.value, 'n');
      } finally {
        await merged.dispose();
      }
      fs.writeFileSync(target, `CONFIG_GPIO=y\n\n${BEGIN}\nCONFIG_LOG=y\nCONFIG_LOG_LEVEL=4\nCONFIG_GPIO=y\n${END}\n`);
    });

    it('leaves a pinned line alone when a later fragment already gives the current value', async () => {
      const by = byName(await drift([board, target, later], true));
      assert.equal(by.LOG, undefined);
      assert.equal(by.LOG_LEVEL, undefined);
    });

    it('compares with the pinned value itself when the target is not merged by the build', async () => {
      const by = byName(await drift([board], true));
      assert.equal(by.LOG.managedLine, 'update');
      assert.equal(by.LOG_LEVEL.managedLine, 'remove');
    });
  });

  describe('set_kconfig end to end', () => {
    const ctx = (tool: string): ToolContext<HostDeps> => {
      const app = { appRootPath: appRoot, appName: 'app', venvPath: undefined, westWorkspaceRootPath: undefined };
      const config = { name: 'primary', envVars: {}, isSysbuild: () => false, boardIdentifier: 'test' };
      return {
        signal: new AbortController().signal,
        progress: () => undefined,
        client: { name: 'test' },
        deps: {
          services: {
            resolveTarget: async () => ({ app, config, buildDir }),
            resolveDomain: () => undefined,
            kconfigEditorState: () => undefined,
            kconfigEditors: () => [],
            externalTaskName: () => undefined,
            addExtraConfFile: async () => undefined,
          },
          jobs: { list: () => [] },
          confirmations: { require: async () => 'not-asked' },
          kconfig: pool,
        } as unknown as HostDeps,
        tool: findTool(tool)!,
        startedAt: Date.now(),
        audit: {},
      };
    };
    const set = (args: Record<string, unknown>) => setKconfig(args, ctx('set_kconfig')) as Promise<any>;

    it('writes values that take into the managed region of prj.conf', async () => {
      const result = await set({ assignments: [{ symbol: 'LOG', value: true }, { symbol: 'CONFIG_LOG_LEVEL', value: 4 }] });
      assert.deepEqual(result.results.map((r: any) => r.status), ['applied', 'applied']);
      assert.equal(result.written, true);
      assert.equal(fs.readFileSync(prj, 'utf8'), `CONFIG_GPIO=y\n\n${BEGIN}\nCONFIG_LOG=y\nCONFIG_LOG_LEVEL=4\n${END}\n`);
      assert.deepEqual(result.side_effects, [{ symbol: 'CONFIG_LOG_BACKEND', from: 'n', to: 'y' }]);
    });

    it('refuses, and writes nothing for, values the build would drop or reject', async () => {
      const text = fs.readFileSync(prj, 'utf8');
      const result = await set({
        assignments: [
          { symbol: 'NEEDS_ACPI', value: 'y' }, { symbol: 'DT_HAS_FOO', value: 'y' },
          { symbol: 'FP_A', value: 'n' }, { symbol: 'FORCED', value: 'n' }, { symbol: 'LOG_LEVEL', value: 7 },
        ],
      });
      assert.equal(result.written, false);
      const by = Object.fromEntries(result.results.map((r: any) => [r.symbol, r]));
      assert.deepEqual(by.CONFIG_NEEDS_ACPI.blocked_by, [{ expr: 'ACPI [=n]', value: 'n' }]);
      assert.match(by.CONFIG_DT_HAS_FOO.reason, /no prompt/);
      assert.match(by.CONFIG_FP_A.hint, /CONFIG_FP_B/);
      assert.deepEqual(by.CONFIG_FORCED.selected_by_active, ['CONFIG_SELECTOR']);
      assert.match(by.CONFIG_LOG_LEVEL.reason, /range/);
      for (const r of result.results) {
        assert.equal(r.status, 'rejected', r.symbol);
      }
      assert.equal(fs.readFileSync(prj, 'utf8'), text);
    });

    it('names the later fragment that would win', async () => {
      const result = await set({ assignments: [{ symbol: 'BANNER', value: 'mine' }] });
      assert.equal(result.written, false);
      assert.equal(result.results[0].status, 'overridden');
      assert.deepEqual(result.results[0].overridden_by, { file: extra, line: 1 });
    });

    it('selects another choice member', async () => {
      const result = await set({ assignments: [{ symbol: 'FP_B', value: 'y' }], dry_run: true });
      assert.equal(result.results[0].status, 'applied');
      assert.equal(result.would_write, true);
    });

    it('explains through query_kconfig with absolute definition paths', async () => {
      const result = await queryKconfig({ explain: true, symbols: ['NEEDS_ACPI'] }, ctx('query_kconfig')) as any;
      const acpi = result.symbols[0];
      assert.equal(acpi.defined_at[0].file, path.join(zbase, 'Kconfig'));
      assert.deepEqual(acpi.blocked_by, [{ expr: 'ACPI [=n]', value: 'n', kind: 'depends_on' }]);
      assert.match(acpi.how_to_change, /ACPI/);
      // The prj.conf written above changed a fragment, so the build is stale until it runs.
      assert.ok(result.stale);
    });
  });
});
