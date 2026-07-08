import { strict as assert } from 'assert';

import fs from 'fs';
import os from 'os';
import path from 'path';

import { readZephyrStatFile } from '../../utils/zephyr/buildSummaryParser';

describe('readZephyrStatFile', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zwb-stat-'));
	});

	afterEach(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it('returns undefined when the file is missing', () => {
		assert.equal(readZephyrStatFile(path.join(tmpDir, 'zephyr.stat')), undefined);
		assert.equal(readZephyrStatFile(undefined), undefined);
	});

	it('reads the raw text verbatim', () => {
		const statPath = path.join(tmpDir, 'zephyr.stat');
		const body = 'ELF Header:\n  Class: ELF32\n';
		fs.writeFileSync(statPath, body, 'utf8');

		const content = readZephyrStatFile(statPath);
		assert.ok(content);
		assert.equal(content?.text, body);
		assert.equal(content?.truncated, false);
		assert.equal(content?.sizeBytes, Buffer.byteLength(body));
		assert.equal(content?.path, statPath);
	});
});
