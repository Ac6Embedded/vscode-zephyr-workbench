import { strict as assert } from 'assert';
import * as path from 'path';
import {
  assertNewConfigName, assertWestArgs, ConfigValues, editFieldsIn, emptyConfigValues, findReservedWestArg, parseWestFlag,
  planConfigEdit, PlanOptions, toEnvList,
} from '../../../mcp/core/buildConfigEdit';
import { McpToolError } from '../../../mcp/core/errors';

const APP = path.join(path.sep, 'ws', 'app');

function options(over: Partial<PlanOptions> = {}): PlanOptions {
  return {
    absolutePath: value => path.resolve(APP, value),
    assertAllowedPath: (absolute, label) => {
      if (!absolute.startsWith(path.join(path.sep, 'ws'))) {
        throw new McpToolError('PATH_OUTSIDE_WORKSPACE', `${label} is outside`);
      }
    },
    staticRunners: ['jlink', 'openocd'],
    exists: () => true,
    samePath: (a, b) => a === b,
    ...over,
  };
}

function values(over: Partial<ConfigValues> = {}): ConfigValues {
  return { ...emptyConfigValues(), board: 'nrf52840dk/nrf52840', ...over };
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as McpToolError).code;
  }
}

describe('mcp/core/buildConfigEdit', () => {
  describe('new configuration names', () => {
    it('accepts a fresh name and refuses a taken one with the existing names', () => {
      assert.equal(assertNewConfigName('debug', ['primary'], 'config_name'), 'debug');
      try {
        assertNewConfigName('Primary', ['primary'], 'config_name');
        assert.fail('expected a refusal');
      } catch (error) {
        assert.equal((error as McpToolError).code, 'INVALID_ARGUMENT');
        assert.deepEqual((error as McpToolError).details, { existing: ['primary'] });
      }
    });

    it('is stricter than a lookup: no dot, so the name can be typed in the Applications view', () => {
      assert.equal(codeOf(() => assertNewConfigName('v1.2', [], 'new_name')), 'INVALID_ARGUMENT');
    });
  });

  describe('west_args', () => {
    it('allows options no other field owns', () => {
      assert.equal(findReservedWestArg('-o=-j4 --domain app -s ../src --cmake'), undefined);
      assert.equal(assertWestArgs('-o=-j4'), '-o=-j4');
    });

    it('refuses options another field owns, in every spelling argparse accepts', () => {
      const cases: Array<[string, RegExp]> = [
        ['-b nrf52840dk/nrf52840', /board/],
        ['--board=qemu_x86', /board/],
        ['--boa qemu_x86', /board/],
        ['-bqemu_x86', /board/],
        ['-cb qemu_x86', /board/],
        ['-d build/other', /config_name/],
        ['--sysbuild', /sysbuild/],
        ['--no-sysbuild', /sysbuild/],
        ['-S cdc-acm-console', /SNIPPETS/],
        ['--shield x', /SHIELD/],
        ['-p always', /pristine/],
        ['-t menuconfig', /target/],
        ['--cmake-only', /cmake_only/],
        ['-- -DCONFIG_FOO=y', /west_flags/],
      ];
      for (const [args, field] of cases) {
        const found = findReservedWestArg(args);
        assert.ok(found, args);
        assert.match(found.field, field, args);
        assert.equal(codeOf(() => assertWestArgs(args)), 'INVALID_ARGUMENT', args);
      }
    });

    it('refuses shell metacharacters before anything else', () => {
      assert.throws(() => assertWestArgs('-o=-j4; rm -rf /'), /";"/);
    });
  });

  describe('-D flags', () => {
    it('normalizes a leading -D and keeps NAME or NAME=VALUE', () => {
      assert.equal(parseWestFlag('-DCONFIG_DEBUG=y'), 'CONFIG_DEBUG=y');
      assert.equal(parseWestFlag('-- -DFOO'), 'FOO');
      assert.equal(parseWestFlag('MY_OPT:STRING=a b'), 'MY_OPT:STRING=a b');
    });

    it('refuses a name the formatter would pass unquoted to a shell', () => {
      for (const bad of ['A B=1', '1A=2', 'A$(x)=1', '=1', '']) {
        assert.equal(codeOf(() => parseWestFlag(bad)), 'INVALID_ARGUMENT', bad);
      }
    });

    it('explains that a CMake list belongs in a list field', () => {
      try {
        parseWestFlag('EXTRA_CONF_FILE=a.conf;b.conf');
        assert.fail('expected a refusal');
      } catch (error) {
        assert.match((error as McpToolError).hint ?? '', /env\.EXTRA_CONF_FILE/);
      }
    });
  });

  describe('planConfigEdit', () => {
    it('reports only the fields whose value changes', () => {
      const plan = planConfigEdit(values(), { board: 'nrf52840dk/nrf52840', sysbuild: false, west_args: '' }, options());
      assert.deepEqual(plan.changed, []);
      assert.deepEqual(plan.settings, {});
    });

    it('marks a board or sysbuild change, which may need a pristine build', () => {
      const plan = planConfigEdit(values(), { board: 'qemu_x86', sysbuild: true }, options());
      assert.deepEqual(plan.changed, ['board', 'sysbuild']);
      assert.deepEqual(plan.settings, { board: 'qemu_x86', sysbuild: 'true' });
      assert.equal(plan.boardChanged, true);
      assert.equal(plan.sysbuildChanged, true);
    });

    it('refuses an empty or unsafe board', () => {
      assert.equal(codeOf(() => planConfigEdit(values(), { board: ' ' }, options())), 'INVALID_ARGUMENT');
      assert.equal(codeOf(() => planConfigEdit(values(), { board: 'x;y' }, options())), 'INVALID_ARGUMENT');
      assert.equal(codeOf(() => planConfigEdit(values(), { board: 'b'.repeat(129) }, options())), 'INVALID_ARGUMENT');
    });

    it('clears west_args with an empty string', () => {
      const plan = planConfigEdit(values({ westArgs: '-o=-j4' }), { west_args: '' }, options());
      assert.deepEqual(plan.settings, { 'west-args': undefined });
      assert.deepEqual(plan.changed, ['west_args']);
    });

    describe('west_flags', () => {
      it('replaces a flag of the same name on add, and removes by bare name whatever the value', () => {
        const plan = planConfigEdit(values({ westFlags: ['A=1', 'B=2'] }),
          { west_flags: { add: ['-DA=3', 'C'], remove: ['B'] } }, options());
        assert.deepEqual(plan.settings['west-flags'], ['A=3', 'C']);
      });

      it('warns about a removal that matched nothing', () => {
        const plan = planConfigEdit(values({ westFlags: ['A=1'] }), { west_flags: { remove: ['Z'] } }, options());
        assert.deepEqual(plan.changed, []);
        assert.match(plan.warnings.join(' '), /"Z" was not in the list/);
      });

      it('replaces the whole list with set, refusing a name given twice', () => {
        const plan = planConfigEdit(values({ westFlags: ['A=1'] }), { west_flags: { set: ['B=1'] } }, options());
        assert.deepEqual(plan.settings['west-flags'], ['B=1']);
        assert.equal(codeOf(() => planConfigEdit(values(), { west_flags: { set: ['B=1', 'B=2'] } }, options())), 'INVALID_ARGUMENT');
      });

      it('removes the stored key when the list becomes empty', () => {
        const plan = planConfigEdit(values({ westFlags: ['A=1'] }), { west_flags: { set: [] } }, options());
        assert.ok('west-flags' in plan.settings);
        assert.equal(plan.settings['west-flags'], undefined);
      });

      it('refuses set together with add or remove, and an edit with none of them', () => {
        assert.equal(codeOf(() => planConfigEdit(values(), { west_flags: { set: ['A'], add: ['B'] } }, options())), 'INVALID_ARGUMENT');
        assert.equal(codeOf(() => planConfigEdit(values(), { west_flags: {} }, options())), 'INVALID_ARGUMENT');
        assert.equal(codeOf(() => planConfigEdit(values(), { west_flags: { add: Array(33).fill('A') } }, options())), 'INVALID_ARGUMENT');
      });
    });

    describe('runner and runner arguments', () => {
      it('needs a runner for runner_args, stored or given in the same call', () => {
        assert.equal(codeOf(() => planConfigEdit(values(), { runner_args: '--erase' }, options())), 'INVALID_ARGUMENT');
        const plan = planConfigEdit(values(), { default_runner: 'jlink', runner_args: '--erase' }, options());
        assert.deepEqual(plan.settings, { 'default-runner': 'jlink', 'custom-args': '--erase' });
        const kept = planConfigEdit(values({ defaultRunner: 'jlink' }), { runner_args: '--erase' }, options());
        assert.deepEqual(kept.settings, { 'custom-args': '--erase' });
      });

      it('clears the runner arguments together with the runner', () => {
        const plan = planConfigEdit(values({ defaultRunner: 'jlink', runnerArgs: '--erase' }), { default_runner: '' }, options());
        assert.deepEqual(plan.settings, { 'default-runner': undefined, 'custom-args': undefined });
        assert.deepEqual(plan.changed, ['default_runner', 'runner_args']);
      });

      it('fails with RUNNER_UNKNOWN when the build lists runners and this is not one', () => {
        try {
          planConfigEdit(values(), { default_runner: 'pyocd' }, options({ buildRunners: ['jlink', 'nrfjprog'] }));
          assert.fail('expected a refusal');
        } catch (error) {
          assert.equal((error as McpToolError).code, 'RUNNER_UNKNOWN');
          assert.deepEqual((error as McpToolError).details, { available: ['jlink', 'nrfjprog'] });
        }
      });

      it('only warns about an unknown runner when there is no build to check against', () => {
        const plan = planConfigEdit(values(), { default_runner: 'vendor_tool' }, options());
        assert.deepEqual(plan.settings, { 'default-runner': 'vendor_tool' });
        assert.match(plan.warnings.join(' '), /not a runner the workbench knows/);
      });

      it('refuses shell metacharacters in the runner and its arguments', () => {
        assert.equal(codeOf(() => planConfigEdit(values(), { default_runner: 'j link' }, options())), 'INVALID_ARGUMENT');
        assert.equal(codeOf(() => planConfigEdit(values({ defaultRunner: 'jlink' }), { runner_args: '--x `id`' }, options())), 'INVALID_ARGUMENT');
      });
    });

    describe('env lists', () => {
      it('makes relative paths absolute from the application and warns about a missing file', () => {
        const plan = planConfigEdit(values(), { env: { EXTRA_CONF_FILE: { add: ['debug.conf'] } } },
          options({ exists: () => false }));
        assert.deepEqual(plan.env.EXTRA_CONF_FILE, [path.join(APP, 'debug.conf')]);
        assert.deepEqual(plan.changed, ['env.EXTRA_CONF_FILE']);
        assert.match(plan.warnings.join(' '), /does not exist yet/);
      });

      it('refuses a path outside the known folders, and a quote or a ";" in an entry', () => {
        assert.equal(codeOf(() => planConfigEdit(values(), { env: { EXTRA_DTC_OVERLAY_FILE: { add: ['/etc/x.overlay'] } } }, options())),
          'PATH_OUTSIDE_WORKSPACE');
        assert.equal(codeOf(() => planConfigEdit(values(), { env: { EXTRA_CONF_FILE: { add: ['a;b.conf'] } } }, options())), 'INVALID_ARGUMENT');
        assert.equal(codeOf(() => planConfigEdit(values(), { env: { EXTRA_CONF_FILE: { add: ['"a.conf"'] } } }, options())), 'INVALID_ARGUMENT');
      });

      it('removes an entry given relative or absolute, and stores an emptied list as []', () => {
        const current = values({ env: { EXTRA_CONF_FILE: [path.join(APP, 'debug.conf')] } });
        const plan = planConfigEdit(current, { env: { EXTRA_CONF_FILE: { remove: ['debug.conf'] } } }, options());
        assert.deepEqual(plan.env.EXTRA_CONF_FILE, []);
      });

      it('never adds a duplicate', () => {
        const current = values({ env: { SHIELD: ['x_nucleo_iks01a3'] } });
        const plan = planConfigEdit(current, { env: { SHIELD: { add: ['x_nucleo_iks01a3'] } } }, options());
        assert.deepEqual(plan.changed, []);
      });

      it('checks shield and snippet names, which reach the command line unquoted', () => {
        const plan = planConfigEdit(values(), { env: { SNIPPETS: { set: ['cdc-acm-console'] } } }, options());
        assert.deepEqual(plan.env.SNIPPETS, ['cdc-acm-console']);
        assert.equal(codeOf(() => planConfigEdit(values(), { env: { SNIPPETS: { add: ['-x'] } } }, options())), 'INVALID_ARGUMENT');
        assert.equal(codeOf(() => planConfigEdit(values(), { env: { SHIELD: { add: ['a b'] } } }, options())), 'INVALID_ARGUMENT');
      });

      it('refuses a variable the build never reads back', () => {
        const edit = { env: { BOARD_ROOT: { add: ['x'] } } } as unknown as Parameters<typeof planConfigEdit>[1];
        assert.equal(codeOf(() => planConfigEdit(values(), edit, options())), 'INVALID_ARGUMENT');
      });
    });
  });

  it('reads a stored env value as a list whatever its shape', () => {
    assert.deepEqual(toEnvList(['a', '', 3, 'b']), ['a', 'b']);
    assert.deepEqual(toEnvList('a'), ['a']);
    assert.deepEqual(toEnvList(''), []);
    assert.deepEqual(toEnvList(undefined), []);
  });

  it('lists the fields of a call that change a configuration', () => {
    assert.deepEqual(editFieldsIn({ board: 'x', config_name: 'a', env: {} }), ['board', 'env']);
  });
});
