// The parsers behind analyze's results and get_diagnostics source sca, on
// output captured from the real tools: tabulate grids as Zephyr's
// hardenconfig.py and dtdoctor_analyzer.py print them, and SARIF logs.

import { strict as assert } from 'assert';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { countByRule, filterFindings, readSarif, SarifError } from '../../../mcp/core/sarifReader';
import { matcherFor } from '../../../mcp/core/match';
import { parseDtDoctor } from '../../../mcp/jobs/dtdoctorParser';
import { parseGridTables } from '../../../mcp/jobs/gridTable';
import { parseHardenconfig } from '../../../mcp/jobs/hardenconfigParser';

// Printed by tabulate 0.9 with tablefmt="grid", as hardenconfig.py does.
const HARDENCONFIG_GRID = [
  '[0/1] cd /app/build/primary/zephyr/kconfig && /usr/bin/cmake -E env ZEPHYR_BASE=/z python3 /z/scripts/kconfig/hardenconfig.py /z/Kconfig',
  '+------------------------------+-----------+---------------+----------------+',
  '| Name                         | Current   | Recommended   | Check result   |',
  '+==============================+===========+===============+================+',
  '| CONFIG_BOOT_BANNER           | y         | n             | FAIL           |',
  '+------------------------------+-----------+---------------+----------------+',
  '| CONFIG_STACK_SENTINEL        | n         | y             | FAIL           |',
  '+------------------------------+-----------+---------------+----------------+',
  '| CONFIG_TEST_RANDOM_GENERATOR |           | n             | FAIL           |',
  '+------------------------------+-----------+---------------+----------------+',
  '',
].join('\r\n');

// The fixed-width list hardenconfig.py printed before it used tabulate.
const HARDENCONFIG_LEGACY = [
  '                       name                       |   current   |    recommended     ||        check result        ',
  '='.repeat(116),
  'CONFIG_BOOT_BANNER                                 |      y      |         n          ||            FAIL            ',
  'CONFIG_HW_STACK_PROTECTION                         |      n      |         y          ||            FAIL            ',
  '',
].join('\n');

// Printed by tabulate with tablefmt="grid", as dtdoctor_analyzer.py does, inside
// the failing compile's output and with the compiler's colours.
const DT_DOCTOR_OUTPUT = [
  'FAILED: CMakeFiles/app.dir/src/main.c.obj',
  '\u001b[01m\u001b[K/app/src/main.c:12:1:\u001b[m\u001b[K \u001b[01;31m\u001b[Kerror: \u001b[m\u001b[K\'__device_dts_ord_42\' undeclared here (not in a function)',
  '+-------------------------------------------------------------------------+',
  '| DT Doctor                                                               |',
  '+=========================================================================+',
  "| 'uart1: /soc/serial@40011000' is disabled in /z/boards/b.dts:123        |",
  '| The following nodes depend on it:                                       |',
  '|  - /soc/foo                                                             |',
  '|                                                                         |',
  "| It is referenced as a \"chosen\" in 'zephyr,console', 'zephyr,shell-uart' |",
  "| It is referenced by the following aliases: 'led0'                       |",
  '|                                                                         |',
  "| Try enabling the node by setting its 'status' property to 'okay'.       |",
  '+-------------------------------------------------------------------------+',
  '+------------------------------------------------------------------------------+',
  '| DT Doctor                                                                    |',
  '+==============================================================================+',
  "| '/soc/i2c@40005400' is enabled but no driver appears to be available for it. |",
  '|                                                                              |',
  '| Try enabling these Kconfig options:                                          |',
  '|                                                                              |',
  '|  - CONFIG_I2C=y                                                              |',
  '|  - CONFIG_I2C_STM32=y                                                        |',
  '+------------------------------------------------------------------------------+',
  'ninja: build stopped: subcommand failed.',
].join('\n');

describe('grid tables', () => {
  it('reads headers, rows and multi-line cells, and ignores the log around them', () => {
    const [table, ...rest] = parseGridTables(HARDENCONFIG_GRID);
    assert.equal(rest.length, 0);
    assert.deepEqual(table.headers, ['Name', 'Current', 'Recommended', 'Check result']);
    assert.deepEqual(table.rows[2], ['CONFIG_TEST_RANDOM_GENERATOR', '', 'n', 'FAIL']);
    const doctor = parseGridTables(DT_DOCTOR_OUTPUT);
    assert.equal(doctor.length, 2);
    assert.match(doctor[0].rows[0][0], /disabled in \/z\/boards\/b\.dts:123\nThe following nodes/);
  });
});

describe('hardenconfig parser', () => {
  it('reads the tabulate grid', () => {
    assert.deepEqual(parseHardenconfig(HARDENCONFIG_GRID), [
      { symbol: 'CONFIG_BOOT_BANNER', current: 'y', recommended: 'n' },
      { symbol: 'CONFIG_STACK_SENTINEL', current: 'n', recommended: 'y' },
      { symbol: 'CONFIG_TEST_RANDOM_GENERATOR', current: '', recommended: 'n' },
    ]);
  });

  it('reads the list older Zephyr versions print', () => {
    assert.deepEqual(parseHardenconfig(HARDENCONFIG_LEGACY), [
      { symbol: 'CONFIG_BOOT_BANNER', current: 'y', recommended: 'n' },
      { symbol: 'CONFIG_HW_STACK_PROTECTION', current: 'n', recommended: 'y' },
    ]);
  });

  it('returns nothing when every option passes, and ignores unrelated grids', () => {
    assert.deepEqual(parseHardenconfig('[1/1] hardenconfig\n\n'), []);
    assert.deepEqual(parseHardenconfig(DT_DOCTOR_OUTPUT), []);
  });
});

describe('DT Doctor parser', () => {
  it('reads each diagnosis into a finding', () => {
    const [disabled, noDriver, ...rest] = parseDtDoctor(DT_DOCTOR_OUTPUT);
    assert.equal(rest.length, 0);
    assert.equal(disabled.kind, 'disabled_node');
    assert.equal(disabled.node, '/soc/serial@40011000');
    assert.equal(disabled.label, 'uart1');
    assert.deepEqual(disabled.status_set_at, { file: '/z/boards/b.dts', line: 123 });
    assert.deepEqual(disabled.required_by, ['/soc/foo']);
    assert.deepEqual(disabled.chosen, ['zephyr,console', 'zephyr,shell-uart']);
    assert.deepEqual(disabled.aliases, ['led0']);
    assert.match(disabled.advice ?? '', /status/);
    assert.equal(noDriver.kind, 'no_driver');
    assert.equal(noDriver.node, '/soc/i2c@40005400');
    assert.equal(noDriver.label, undefined);
    assert.deepEqual(noDriver.kconfig_options, ['CONFIG_I2C=y', 'CONFIG_I2C_STM32=y']);
  });

  it('reports a node diagnosed by several compiles once', () => {
    assert.equal(parseDtDoctor(`${DT_DOCTOR_OUTPUT}\n${DT_DOCTOR_OUTPUT}`).length, 2);
  });

  it('keeps a Windows path with a drive letter', () => {
    const grid = [
      '+--------------------------------------------------------------+',
      '| DT Doctor                                                    |',
      '+==============================================================+',
      "| '/soc/spi@1' is disabled in C:\\z\\boards\\b.dts:7             |",
      '+--------------------------------------------------------------+',
    ].join('\r\n');
    assert.deepEqual(parseDtDoctor(grid)[0].status_set_at, { file: 'C:\\z\\boards\\b.dts', line: 7 });
  });

  it('finds nothing in a build without DT Doctor output', () => {
    assert.deepEqual(parseDtDoctor(HARDENCONFIG_GRID), []);
  });
});

describe('SARIF reader', () => {
  const root = path.resolve('/work/app');
  const main = path.join(root, 'src', 'main.c');
  const sarif = JSON.stringify({
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'ECLAIR', rules: [
        { id: 'MC3R1.R10.1', shortDescription: { text: 'Operands shall not be of an inappropriate essential type' } },
        { id: 'MC3R1.R8.4', fullDescription: { text: 'A compatible declaration shall be visible' }, messageStrings: { m: { text: 'object {0} has no declaration' } } },
      ] } },
      originalUriBaseIds: { SRCROOT: { uri: pathToFileURL(root + path.sep).href } },
      results: [
        { ruleId: 'MC3R1.R10.1', level: 'error', message: { text: 'essential type mismatch' },
          locations: [{ physicalLocation: { artifactLocation: { uri: pathToFileURL(main).href }, region: { startLine: 12, startColumn: 3 } } }] },
        { ruleIndex: 1, message: { id: 'm', arguments: ['counter'] },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'src/util.c', uriBaseId: 'SRCROOT' }, region: { startLine: 4 } } }] },
        { ruleId: 'MC3R1.R10.1', level: 'note', message: { text: 'caution' },
          locations: [{ physicalLocation: { artifactLocation: { uri: '/zephyr/kernel/sched.c' } } }] },
        { ruleId: 'MC3R1.R8.4', kind: 'pass', message: { markdown: 'passes' } },
      ],
    }],
  });

  it('reads rule, severity, message and location of every result', () => {
    const log = readSarif(sarif);
    assert.deepEqual(log.tools, ['ECLAIR']);
    assert.equal(log.findings.length, 4);
    assert.deepEqual(log.findings[0], { rule: 'MC3R1.R10.1', severity: 'error', level: 'error', message: 'essential type mismatch', file: main, line: 12, column: 3 });
    // No level means warning; a message template is filled; a base id is resolved.
    assert.deepEqual(log.findings[1], { rule: 'MC3R1.R8.4', severity: 'warning', level: 'warning', message: 'object counter has no declaration', file: path.join(root, 'src', 'util.c'), line: 4 });
    assert.equal(log.findings[2].severity, 'info');
    // A result that is not a failure has level none.
    assert.equal(log.findings[3].level, 'none');
    assert.equal(log.findings[3].message, 'passes');
    assert.equal(log.rules['MC3R1.R8.4'], 'A compatible declaration shall be visible');
  });

  it('filters by rule, severity and path, and counts per rule', () => {
    const { findings } = readSarif(sarif);
    assert.equal(filterFindings(findings, { rule: matcherFor('mc3r1.r10*') }).length, 2);
    assert.equal(filterFindings(findings, { severity: 'error' }).length, 1);
    assert.equal(filterFindings(findings, { pathPrefix: root }).length, 2);
    assert.equal(filterFindings(findings, { pathPrefix: 'kernel/sched' }).length, 1);
    assert.deepEqual(countByRule(findings)[0], { rule: 'MC3R1.R10.1', count: 2, errors: 1, warnings: 0 });
  });

  it('refuses text that is not a SARIF log', () => {
    assert.throws(() => readSarif('{'), SarifError);
    assert.throws(() => readSarif('{"version": "2.1.0"}'), SarifError);
    assert.deepEqual(readSarif('{"runs": []}').findings, []);
  });
});
