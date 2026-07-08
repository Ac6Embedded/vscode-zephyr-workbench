import { strict as assert } from 'assert';

import fs from 'fs';
import os from 'os';
import path from 'path';

import { readZephyrKconfigReport } from '../../utils/zephyr/kconfigReportParser';

describe('kconfigReportParser', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zwb-kconfig-'));
	});

	afterEach(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	function writeTrace(entries: unknown[]): string {
		const tracePath = path.join(tmpDir, '.config-trace.json');
		fs.writeFileSync(tracePath, JSON.stringify(entries), 'utf8');
		return tracePath;
	}

	it('maps trace entries across every source kind', () => {
		const defconfig = path.join(tmpDir, 'boards', 'defconfig');
		fs.mkdirSync(path.dirname(defconfig), { recursive: true });
		fs.writeFileSync(defconfig, 'CONFIG_SERIAL=y\n', 'utf8');

		const tracePath = writeTrace([
			['CONFIG_SERIAL', 'y', 'bool', 'y', 'assign', [defconfig, 4]],
			['CONFIG_XIP', 'y', 'bool', 'y', 'imply', ['CPU_CORTEX_M && ARM']],
			['CONFIG_KERNEL_ENTRY', 'y', 'string', '__start', 'default', [defconfig, 10]],
			['CONFIG_INPUT', 'y', 'bool', null, 'unset', null],
			['CONFIG_IMPLICIT', 'y', 'bool', 'y', 'default', null],
			['CONFIG_DT_HAS_FOO_ENABLED', 'n', 'bool', 'y', 'default', [defconfig, 20]],
		]);

		const report = readZephyrKconfigReport({
			traceJsonPath: tracePath,
			dotConfigPath: path.join(tmpDir, '.config'),
			westWorkspaceRoot: tmpDir,
		});

		assert.ok(report);
		assert.equal(report?.source, 'trace');
		assert.equal(report?.totalCount, 6);
		assert.equal(report?.setCount, 5); // all but the unset symbol
		assert.equal(report?.hiddenCount, 1); // DT_HAS is not visible

		const symbols = report!.symbols;
		// Sorted by name.
		assert.deepEqual(symbols.map(s => s.name), [
			'CONFIG_DT_HAS_FOO_ENABLED',
			'CONFIG_IMPLICIT',
			'CONFIG_INPUT',
			'CONFIG_KERNEL_ENTRY',
			'CONFIG_SERIAL',
			'CONFIG_XIP',
		]);

		const serial = symbols.find(s => s.name === 'CONFIG_SERIAL');
		assert.equal(serial?.source, 'assign');
		assert.equal(serial?.locPath, defconfig);
		assert.equal(serial?.locLine, 4);
		assert.equal(serial?.locDisplay, 'boards/defconfig:4');

		const xip = symbols.find(s => s.name === 'CONFIG_XIP');
		assert.equal(xip?.source, 'imply');
		assert.equal(xip?.locDisplay, 'CPU_CORTEX_M && ARM');
		assert.equal(xip?.locPath, undefined);

		const entry = symbols.find(s => s.name === 'CONFIG_KERNEL_ENTRY');
		assert.equal(entry?.value, '"__start"'); // string values are quoted

		const input = symbols.find(s => s.name === 'CONFIG_INPUT');
		assert.equal(input?.isSet, false);
		assert.equal(input?.value, undefined);

		const implicit = symbols.find(s => s.name === 'CONFIG_IMPLICIT');
		assert.equal(implicit?.locDisplay, '(implicit)');

		const dtHas = symbols.find(s => s.name === 'CONFIG_DT_HAS_FOO_ENABLED');
		assert.equal(dtHas?.docHref, undefined); // suppressed for DT_HAS symbols
		assert.equal(dtHas?.visible, false);
	});

	it('joins multiple select expressions', () => {
		const tracePath = writeTrace([
			['CONFIG_HAS_CMSIS', 'n', 'bool', 'y', 'select', ['HAS_STM32CUBE && SOC', 'CPU_CORTEX_M && ARM']],
		]);

		const report = readZephyrKconfigReport({ traceJsonPath: tracePath });
		assert.equal(report?.symbols[0].locDisplay, 'HAS_STM32CUBE && SOC || CPU_CORTEX_M && ARM');
	});

	it('falls back to .config when no trace file exists', () => {
		const configPath = path.join(tmpDir, '.config');
		fs.writeFileSync(configPath, [
			'CONFIG_SERIAL=y',
			'# CONFIG_INPUT is not set',
			'CONFIG_MAIN_STACK_SIZE=1024',
			'',
		].join('\n'), 'utf8');

		const report = readZephyrKconfigReport({ dotConfigPath: configPath });
		assert.ok(report);
		assert.equal(report?.source, 'config');
		assert.equal(report?.totalCount, 3);
		assert.equal(report?.setCount, 3);
		assert.equal(report?.symbols.every(s => s.source === 'config'), true);
		const stack = report?.symbols.find(s => s.name === 'CONFIG_MAIN_STACK_SIZE');
		assert.equal(stack?.value, '1024');
	});

	it('returns undefined when neither source is available', () => {
		const report = readZephyrKconfigReport({
			traceJsonPath: path.join(tmpDir, 'missing.json'),
			dotConfigPath: path.join(tmpDir, 'missing.config'),
		});
		assert.equal(report, undefined);
	});
});
