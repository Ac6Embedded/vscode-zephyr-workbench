import { strict as assert } from 'assert';

import fs from 'fs';
import os from 'os';
import path from 'path';

import { readZephyrDeviceTreeReport } from '../../utils/zephyr/dtsReportParser';

describe('dtsReportParser', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zwb-dts-'));
	});

	afterEach(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	function writeDts(content: string): string {
		const dtsPath = path.join(tmpDir, 'zephyr.dts');
		fs.writeFileSync(dtsPath, content, 'utf8');
		return dtsPath;
	}

	it('parses nested nodes, labels, compatible and status', () => {
		const dts = [
			'/dts-v1/;',
			'',
			"/* node '/' defined in dts/common/skeleton.dtsi:9 */",
			'/ {',
			'\tmodel = "Test Board";',
			'\tcompatible = "vendor,test-board";',
			'',
			"\t/* node '/soc' defined in dts/test/soc.dtsi:3 */",
			'\tsoc {',
			'\t\t#address-cells = < 0x1 >;',
			'',
			"\t\t/* node '/soc/serial@40000000' defined in dts/test/soc.dtsi:10 */",
			'\t\tlpuart1: arduino_serial: serial@40000000 {',
			'\t\t\tcompatible = "vendor,uart", "vendor,uart-v2";',
			'\t\t\tstatus = "okay";',
			'\t\t};',
			'',
			"\t\t/* node '/soc/serial@40001000' defined in dts/test/soc.dtsi:20 */",
			'\t\tusart2: serial@40001000 {',
			'\t\t\tcompatible = "vendor,uart";',
			'\t\t\tstatus = "disabled";',
			'\t\t};',
			'\t};',
			'};',
			'',
		].join('\n');

		const report = readZephyrDeviceTreeReport({
			dtsPath: writeDts(dts),
			westWorkspaceRoot: tmpDir,
		});

		assert.equal(report.totalNodes, 4);
		assert.equal(report.disabledCount, 1);
		assert.equal(report.okayCount, 3);

		const root = report.nodes[0];
		assert.equal(root.path, '/');
		assert.equal(root.name, '/');
		assert.equal(root.depth, 0);
		assert.equal(root.compatible, 'vendor,test-board');

		const serial = report.nodes.find(node => node.path === '/soc/serial@40000000');
		assert.ok(serial);
		assert.deepEqual(serial?.labels, ['lpuart1', 'arduino_serial']);
		assert.equal(serial?.compatible, 'vendor,uart');
		assert.equal(serial?.status, 'okay');
		assert.equal(serial?.depth, 2);

		const disabled = report.nodes.find(node => node.path === '/soc/serial@40001000');
		assert.equal(disabled?.status, 'disabled');
	});

	it('counts nodes without a status property as enabled', () => {
		const dts = [
			"/* node '/' defined in a.dtsi:1 */",
			'/ {',
			"\t/* node '/gpio' defined in a.dtsi:2 */",
			'\tgpio {',
			'\t\tcompatible = "vendor,gpio";',
			'\t};',
			'};',
		].join('\n');

		const report = readZephyrDeviceTreeReport({ dtsPath: writeDts(dts) });
		assert.equal(report.totalNodes, 2);
		assert.equal(report.disabledCount, 0);
		assert.equal(report.okayCount, 2);
	});

	it('keeps sourceDisplay but leaves sourcePath undefined when the file cannot be resolved', () => {
		const dts = [
			"/* node '/' defined in does/not/exist.dtsi:42 */",
			'/ {',
			'};',
		].join('\n');

		const report = readZephyrDeviceTreeReport({
			dtsPath: writeDts(dts),
			westWorkspaceRoot: tmpDir,
		});

		const root = report.nodes[0];
		assert.equal(root.sourceDisplay, 'does/not/exist.dtsi:42');
		assert.equal(root.sourceLine, 42);
		assert.equal(root.sourcePath, undefined);
	});

	it('resolves a relative source path against the west workspace root', () => {
		const nested = path.join(tmpDir, 'dts', 'test');
		fs.mkdirSync(nested, { recursive: true });
		fs.writeFileSync(path.join(nested, 'soc.dtsi'), '// binding\n', 'utf8');

		const dts = [
			"/* node '/' defined in dts/test/soc.dtsi:5 */",
			'/ {',
			'};',
		].join('\n');

		const report = readZephyrDeviceTreeReport({
			dtsPath: writeDts(dts),
			westWorkspaceRoot: tmpDir,
		});

		assert.equal(report.nodes[0].sourcePath, path.join(tmpDir, 'dts', 'test', 'soc.dtsi'));
	});

	it('does not desync on an unexpected closing brace', () => {
		const dts = [
			'};',
			"/* node '/' defined in a.dtsi:1 */",
			'/ {',
			"\t/* node '/child' defined in a.dtsi:2 */",
			'\tchild {',
			'\t};',
			'};',
		].join('\n');

		const report = readZephyrDeviceTreeReport({ dtsPath: writeDts(dts) });
		assert.equal(report.totalNodes, 2);
		assert.equal(report.nodes[1].path, '/child');
		assert.equal(report.nodes[1].depth, 1);
	});
});
