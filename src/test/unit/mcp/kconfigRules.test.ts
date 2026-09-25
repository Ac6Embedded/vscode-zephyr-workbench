import { strict as assert } from 'assert';
import * as path from 'path';
import { McpToolError } from '../../../mcp/core/errors';
import {
  evaluateAssignment, EvaluateInput, explainOutput, formatAssignment, howToChange, kconfigToolError,
  parseAssignments, sameValue, symbolName,
} from '../../../mcp/core/kconfigRules';
import type { KcExplainSymbol, KcMergeSymbol } from '../../../utils/kconfig/kconfigRpcTypes';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof McpToolError ? error.code : 'not-an-mcp-error';
  }
  return undefined;
}

function merge(over: Partial<KcMergeSymbol> = {}): KcMergeSymbol {
  return {
    userValue: 'y', value: 'y', took: true, failure: null, promptless: false, assignedAt: null,
    missingDeps: [], activeSelectors: [], activeRange: null, choice: null, ...over,
  };
}

const APP = path.resolve('/ws/app');
const BUILD = path.join(APP, 'build', 'primary');
const PRJ = path.join(APP, 'prj.conf');

function input(over: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    name: 'FOO', type: 'bool', unset: false, formatted: { line: 'CONFIG_FOO=y', value: 'y' },
    previous: 'n', merge: merge(), regionAlready: false, regionHadLine: false,
    targetPath: PRJ, buildDir: BUILD, appRoot: APP, ...over,
  };
}

function symbol(over: Partial<KcExplainSymbol> = {}): KcExplainSymbol {
  return {
    kind: 'symbol', name: 'FOO', type: 'bool', value: 'n', userValue: null, assignable: ['n', 'y'],
    visibility: 'y', promptless: false, prompts: ['Foo support'], helps: ['Enables foo.'],
    dependsOn: { value: 'y', terms: [] }, promptConditions: [], blockedBy: [],
    selectedBy: [], selectedByTotal: 0, impliedBy: [], impliedByTotal: 0, selects: [], implies: [],
    defaults: [], defaultsTotal: 0, ranges: [], activeRange: null, choice: null, definitions: [],
    configString: '# CONFIG_FOO is not set', ...over,
  };
}

describe('mcp/core/kconfigRules', () => {
  describe('symbolName', () => {
    it('accepts a name with or without CONFIG_', () => {
      assert.equal(symbolName('CONFIG_GPIO'), 'GPIO');
      assert.equal(symbolName(' GPIO '), 'GPIO');
    });
    it('refuses anything that is not a symbol name', () => {
      assert.equal(code(() => symbolName('GPIO=y')), 'INVALID_ARGUMENT');
      assert.equal(code(() => symbolName('A;B')), 'INVALID_ARGUMENT');
      assert.equal(code(() => symbolName(42)), 'INVALID_ARGUMENT');
    });
  });

  describe('parseAssignments', () => {
    it('reads values and unsets', () => {
      assert.deepEqual(parseAssignments([
        { symbol: 'CONFIG_A', value: true }, { symbol: 'B', value: 'text' }, { symbol: 'C', value: 12 }, { symbol: 'D', unset: true },
      ]), [
        { name: 'A', unset: false, value: true }, { name: 'B', unset: false, value: 'text' },
        { name: 'C', unset: false, value: 12 }, { name: 'D', unset: true },
      ]);
    });
    it('needs one to fifty entries, each symbol once', () => {
      assert.equal(code(() => parseAssignments([])), 'INVALID_ARGUMENT');
      assert.equal(code(() => parseAssignments(undefined)), 'INVALID_ARGUMENT');
      const many = Array.from({ length: 51 }, (_, i) => ({ symbol: `S${i}`, value: 'y' }));
      assert.equal(code(() => parseAssignments(many)), 'INVALID_ARGUMENT');
      assert.equal(code(() => parseAssignments([{ symbol: 'A', value: 'y' }, { symbol: 'CONFIG_A', value: 'n' }])), 'INVALID_ARGUMENT');
    });
    it('needs exactly one of value or unset', () => {
      assert.equal(code(() => parseAssignments([{ symbol: 'A' }])), 'INVALID_ARGUMENT');
      assert.equal(code(() => parseAssignments([{ symbol: 'A', value: 'y', unset: true }])), 'INVALID_ARGUMENT');
    });
    it('refuses a string that would split the configuration line', () => {
      // A newline in a string value would inject a second CONFIG_ line into prj.conf.
      assert.equal(code(() => parseAssignments([{ symbol: 'BANNER', value: 'a"\nCONFIG_EVIL=y' }])), 'INVALID_ARGUMENT');
      assert.equal(code(() => parseAssignments([{ symbol: 'BANNER', value: 'tab\there' }])), 'INVALID_ARGUMENT');
      assert.equal(code(() => parseAssignments([{ symbol: 'BANNER', value: 'x'.repeat(1025) }])), 'INVALID_ARGUMENT');
    });
    it('refuses numbers that are not whole', () => {
      assert.equal(code(() => parseAssignments([{ symbol: 'A', value: 1.5 }])), 'INVALID_ARGUMENT');
      assert.equal(code(() => parseAssignments([{ symbol: 'A', value: { v: 1 } }])), 'INVALID_ARGUMENT');
    });
  });

  describe('formatAssignment', () => {
    it('writes bool and tristate values, accepting true and false', () => {
      assert.deepEqual(formatAssignment('A', 'bool', true), { line: 'CONFIG_A=y', value: 'y' });
      assert.deepEqual(formatAssignment('A', 'bool', ' N '), { line: 'CONFIG_A=n', value: 'n' });
      assert.deepEqual(formatAssignment('A', 'tristate', 'm'), { line: 'CONFIG_A=m', value: 'm' });
      assert.ok('error' in formatAssignment('A', 'bool', 'm'));
      assert.ok('error' in formatAssignment('A', 'bool', 1));
    });
    it('writes int values without leading zeros, which C would read as octal', () => {
      assert.deepEqual(formatAssignment('N', 'int', '0100'), { line: 'CONFIG_N=100', value: '100' });
      assert.deepEqual(formatAssignment('N', 'int', -5), { line: 'CONFIG_N=-5', value: '-5' });
      assert.ok('error' in formatAssignment('N', 'int', '0x10'));
      assert.ok('error' in formatAssignment('N', 'int', true));
    });
    it('writes hex values with 0x', () => {
      assert.deepEqual(formatAssignment('H', 'hex', '800'), { line: 'CONFIG_H=0x800', value: '0x800' });
      assert.deepEqual(formatAssignment('H', 'hex', '0X1F'), { line: 'CONFIG_H=0x1F', value: '0x1F' });
      assert.deepEqual(formatAssignment('H', 'hex', 4096), { line: 'CONFIG_H=0x1000', value: '0x1000' });
      assert.ok('error' in formatAssignment('H', 'hex', 'zz'));
      assert.ok('error' in formatAssignment('H', 'hex', -1));
    });
    it('quotes and escapes string values the way kconfiglib reads them back', () => {
      assert.deepEqual(formatAssignment('S', 'string', 'say "hi" \\o/'), {
        line: 'CONFIG_S="say \\"hi\\" \\\\o/"', value: 'say "hi" \\o/',
      });
      assert.deepEqual(formatAssignment('S', 'string', 42), { line: 'CONFIG_S="42"', value: '42' });
      assert.ok('error' in formatAssignment('S', 'string', 'a\nb'));
      assert.ok('error' in formatAssignment('S', 'string', false));
    });
    it('refuses a symbol without a type', () => {
      assert.ok('error' in formatAssignment('U', 'unknown', 'y'));
    });
  });

  describe('sameValue', () => {
    it('compares numbers by value', () => {
      assert.ok(sameValue('hex', '0x10', '0x010'));
      assert.ok(sameValue('hex', '10', '0x10'));
      assert.ok(sameValue('int', '10', '010'));
      assert.ok(!sameValue('int', '10', '11'));
      assert.ok(!sameValue('string', 'a', null));
      assert.ok(sameValue('string', null, null));
    });
  });

  describe('evaluateAssignment', () => {
    it('applies a value that takes, and reports it unchanged when the region already has it', () => {
      assert.equal(evaluateAssignment(input()).status, 'applied');
      assert.equal(evaluateAssignment(input({ regionAlready: true })).status, 'unchanged');
    });

    it('refuses a promptless symbol, which Zephyr rejects at configure time', () => {
      const result = evaluateAssignment(input({ merge: merge({ promptless: true, took: false }) }));
      assert.equal(result.status, 'rejected');
      assert.match(result.reason ?? '', /no prompt/);
      assert.match(result.hint ?? '', /query_kconfig with explain true/);
    });

    it('lists the unmet dependencies of a value that does not take', () => {
      const deps = [{ expr: 'ACPI [=n]', value: 'n' as const }];
      const result = evaluateAssignment(input({ merge: merge({ value: 'n', took: false, missingDeps: deps }) }));
      assert.equal(result.status, 'rejected');
      assert.deepEqual(result.blocked_by, deps);
      assert.equal(result.effective_after_merge, 'n');
    });

    it('names the symbols that force a value on', () => {
      const result = evaluateAssignment(input({
        formatted: { line: '# CONFIG_FOO is not set', value: 'n' },
        merge: merge({ userValue: 'n', value: 'y', took: false, activeSelectors: ['BAR'] }),
      }));
      assert.equal(result.status, 'rejected');
      assert.deepEqual(result.selected_by_active, ['CONFIG_BAR']);
    });

    it('explains that a member of a y-mode choice cannot simply be turned off', () => {
      const choice = { name: '<choice>', prompt: 'FP16 format', mode: 'y' as const, selected: 'FOO', members: [{ name: 'FOO', value: 'y' }, { name: 'ALT', value: 'n' }], optional: false };
      const result = evaluateAssignment(input({
        formatted: { line: '# CONFIG_FOO is not set', value: 'n' },
        merge: merge({ userValue: 'n', value: 'y', took: false, choice }),
      }));
      assert.equal(result.status, 'rejected');
      assert.match(result.hint ?? '', /CONFIG_ALT/);
    });

    it('reports a value outside the active range', () => {
      const result = evaluateAssignment(input({
        type: 'int', formatted: { line: 'CONFIG_FOO=9', value: '9' },
        merge: merge({ userValue: '9', value: '3', took: false, activeRange: { low: '0', high: '4' } }),
      }));
      assert.equal(result.status, 'rejected');
      assert.match(result.reason ?? '', /0 to 4/);
    });

    it('reports a later fragment in the application that wins, pointing at it', () => {
      const later = path.join(APP, 'debug.conf');
      const result = evaluateAssignment(input({ merge: merge({ userValue: 'n', value: 'n' }), winner: { file: later, line: 3 } }));
      assert.equal(result.status, 'overridden');
      assert.deepEqual(result.overridden_by, { file: later, line: 3 });
      assert.match(result.hint ?? '', /fragment_path/);
    });

    it('points a -D flag override at the build configuration', () => {
      const generated = path.join(BUILD, 'zephyr', 'misc', 'generated', 'extra_kconfig_options.conf');
      const result = evaluateAssignment(input({ merge: merge({ userValue: 'n', value: 'n' }), winner: { file: generated, line: 1 } }));
      assert.equal(result.status, 'overridden');
      assert.match(result.hint ?? '', /-DCONFIG_FOO/);
    });

    it('tells apart a line after the region of the same file', () => {
      const result = evaluateAssignment(input({ merge: merge({ userValue: 'n', value: 'n' }), winner: { file: PRJ, line: 30 } }));
      assert.equal(result.status, 'overridden');
      assert.match(result.hint ?? '', /after the managed region/);
    });

    it('treats 0x10 and 0x010 as the same assignment', () => {
      const result = evaluateAssignment(input({
        type: 'hex', formatted: { line: 'CONFIG_FOO=0x10', value: '0x10' },
        merge: merge({ userValue: '0x010', value: '0x010' }),
      }));
      assert.equal(result.status, 'applied');
    });

    it('removes a managed line, and says what decides the value afterwards', () => {
      const other = path.join(APP, 'boards', 'b.conf');
      const plain = evaluateAssignment(input({ unset: true, formatted: undefined, regionHadLine: true, merge: merge({ userValue: null }) }));
      assert.equal(plain.status, 'removed');
      assert.equal(plain.requested, null);
      const assigned = evaluateAssignment(input({ unset: true, formatted: undefined, regionHadLine: true, merge: merge(), winner: { file: other, line: 2 } }));
      assert.equal(assigned.status, 'removed');
      assert.match(assigned.reason ?? '', /b\.conf:2/);
      const nothing = evaluateAssignment(input({ unset: true, formatted: undefined, regionHadLine: false }));
      assert.equal(nothing.status, 'unchanged');
    });

    it('refuses an unset that would leave a failing assignment in charge', () => {
      const result = evaluateAssignment(input({
        unset: true, formatted: undefined, regionHadLine: true,
        merge: merge({ took: false, failure: "was assigned y but got n", missingDeps: [{ expr: 'ACPI [=n]', value: 'n' }] }),
      }));
      assert.equal(result.status, 'rejected');
      assert.ok(result.blocked_by);
    });

    it('refuses a symbol missing from the merge', () => {
      assert.equal(evaluateAssignment(input({ merge: undefined })).status, 'rejected');
    });
  });

  describe('howToChange', () => {
    it('sends a promptless symbol to what selects it', () => {
      const text = howToChange(symbol({
        promptless: true, selectedBy: [{ expr: 'BAR [=y]', active: true, name: 'BAR', value: 'y' }],
      }));
      assert.match(text, /no prompt/);
      assert.match(text, /CONFIG_BAR/);
    });
    it('names blocking dependencies first', () => {
      const text = howToChange(symbol({ blockedBy: [{ expr: 'ACPI [=n]', value: 'n', kind: 'depends_on' }], visibility: 'n' }));
      assert.match(text, /ACPI \[=n\]/);
      assert.match(text, /set_kconfig/);
    });
    it('gives the range of a number', () => {
      assert.match(howToChange(symbol({ type: 'int', value: '3', activeRange: { low: '0', high: '4' } })), /from 0 to 4/);
    });
    it('explains choices through their members', () => {
      const choice = { name: 'FP', prompt: 'FP format', mode: 'y' as const, selected: 'A', members: [{ name: 'A', value: 'y' }, { name: 'FOO', value: 'n' }], optional: false };
      assert.match(howToChange(symbol({ choice })), /deselects CONFIG_A/);
    });
  });

  describe('explainOutput', () => {
    it('prefixes names, resolves definition paths and keeps the definitions that apply first', () => {
      const definitions = Array.from({ length: 12 }, (_, i) => ({
        file: `soc/s${i}/Kconfig.defconfig`, line: i + 1, menuPath: '(Top)', active: i === 11,
      }));
      const out = explainOutput(symbol({
        definitions,
        selectedBy: [{ expr: 'BAR [=y]', active: true, name: 'BAR', value: 'y' }],
        selects: [{ name: 'BAZ', active: false }],
        defaults: [{ value: 'y', used: true, file: 'Kconfig', line: 4, condition: 'X [=y]', conditionValue: 'y' }],
      }), {
        resolveFile: file => path.join('/zephyr', file),
        origin: { kind: 'assign', file: PRJ, line: 2 },
        assignedIn: [{ file: PRJ, line: 2, value: 'y' }],
      });
      assert.equal(out.name, 'CONFIG_FOO');
      const sites = out.defined_at as { file: string; active: boolean }[];
      assert.equal(sites.length, 10);
      assert.equal(out.defined_at_total, 12);
      assert.equal(sites[0].file, path.join('/zephyr', 'soc/s11/Kconfig.defconfig'));
      assert.equal(sites[0].active, true);
      assert.deepEqual(out.selected_by, [{ name: 'CONFIG_BAR', value: 'y', active: true, expr: 'BAR [=y]' }]);
      assert.deepEqual(out.selects, ['CONFIG_BAZ']);
      assert.deepEqual(out.defaults, [{ value: 'y', used: true, condition: 'X [=y]', condition_value: 'y', file: path.join('/zephyr', 'Kconfig'), line: 4 }]);
      assert.deepEqual(out.origin, { kind: 'assign', file: PRJ, line: 2 });
      assert.equal(typeof out.how_to_change, 'string');
    });
  });

  describe('kconfigToolError', () => {
    it('maps server failures onto the tool error codes', () => {
      const err = (c: string) => Object.assign(new Error('boom'), { code: c });
      assert.equal(kconfigToolError(err('env-unavailable')).code, 'BUILD_NOT_CONFIGURED');
      assert.equal(kconfigToolError(err('fallback-env-failed')).code, 'BUILD_NOT_CONFIGURED');
      assert.equal(kconfigToolError(err('no-kconfiglib')).code, 'DEPENDENCY_MISSING');
      assert.equal(kconfigToolError(err('no-python')).code, 'DEPENDENCY_MISSING');
      assert.equal(kconfigToolError(err('timeout')).code, 'TIMEOUT');
      assert.equal(kconfigToolError(err('closing')).code, 'BUSY', 'a build folder being deleted');
      const crash = kconfigToolError(err('crashed'), ['Traceback', 'KeyError: x']);
      assert.equal(crash.code, 'INTERNAL');
      assert.match(String((crash.details as { server_output?: string }).server_output), /KeyError/);
    });
    it('passes a tool error through', () => {
      const original = new McpToolError('BUSY', 'busy');
      assert.equal(kconfigToolError(original), original);
    });
  });
});
