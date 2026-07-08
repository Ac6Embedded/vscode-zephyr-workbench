import { strict as assert } from 'assert';

import { assembleMemoryTree, type MemoryTreeSymbol } from '../../utils/zephyr/memoryTreeParser';
import type { ZephyrMemoryTreeNode } from '../../utils/zephyr/memoryTreeParser';

const ZB = '/ws/deps/zephyr';

function child(node: ZephyrMemoryTreeNode | undefined, name: string): ZephyrMemoryTreeNode | undefined {
	return node?.children?.find(c => c.name === name);
}

describe('assembleMemoryTree', () => {
	it('buckets symbols by ZEPHYR_BASE, other absolute paths, and no-paths', () => {
		const symbols: MemoryTreeSymbol[] = [
			{ name: 'printk', size: 100, address: 0x10, section: 'text', file: `${ZB}/lib/os/printk.c` },
			{ name: 'z_thread', size: 60, address: 0x20, section: 'text', file: `${ZB}/kernel/thread.c` },
			{ name: 'main', size: 40, address: 0x30, section: 'text', file: '/ws/app/src/main.c' },
			{ name: '__aeabi_x', size: 30, address: 0x40, section: 'text', file: null },
		];
		// total is larger than the mapped 230 so there is a hidden remainder.
		const tree = assembleMemoryTree(symbols, 250, ZB);

		assert.equal(tree.total, 250);
		const top = tree.root.children!.map(c => c.name);
		assert.ok(top.includes('ZEPHYR_BASE'));
		assert.ok(top.includes('/'));
		assert.ok(top.includes('(no paths)'));
		assert.ok(top.includes('(hidden)'));

		const zephyr = child(tree.root, 'ZEPHYR_BASE');
		assert.equal(zephyr?.size, 160); // 100 + 60
		assert.equal(child(child(zephyr, 'lib'), 'os')?.size, 100);
		assert.equal(child(child(child(child(zephyr, 'lib'), 'os'), 'printk.c'), 'printk')?.size, 100);

		const others = child(tree.root, '/');
		assert.equal(others?.size, 40);

		const noPaths = child(tree.root, '(no paths)');
		assert.equal(noPaths?.size, 30);
		assert.equal(child(noPaths, '__aeabi_x')?.size, 30);

		const hidden = child(tree.root, '(hidden)');
		assert.equal(hidden?.size, 20); // 250 - 230
		assert.equal(hidden?.children, undefined); // leaf, no drilldown
	});

	it('records address and section on leaf nodes only', () => {
		const tree = assembleMemoryTree(
			[{ name: 'foo', size: 10, address: 0x1234, section: 'bss', file: `${ZB}/kernel/k.c` }],
			10,
			ZB,
		);
		const leaf = child(child(child(tree.root, 'ZEPHYR_BASE'), 'kernel'), 'k.c');
		const symbol = child(leaf, 'foo');
		assert.equal(symbol?.address, 0x1234);
		assert.equal(symbol?.section, 'bss');
		assert.equal(leaf?.address, undefined); // intermediate file node has no address
	});

	it('flattens the ZEPHYR_BASE level when the common prefix is exactly the base', () => {
		// Files span two subdirs of the base, so the common prefix equals the
		// base and the ZEPHYR_BASE wrapper is dropped (mirrors size_report).
		const tree = assembleMemoryTree(
			[
				{ name: 'a', size: 10, address: 0x1, section: 'text', file: `${ZB}/kernel/a.c` },
				{ name: 'b', size: 20, address: 0x2, section: 'text', file: `${ZB}/lib/b.c` },
			],
			30,
			ZB,
		);
		assert.ok(child(tree.root, 'kernel'));
		assert.ok(child(tree.root, 'lib'));
		assert.equal(child(tree.root, 'ZEPHYR_BASE'), undefined);
		assert.equal(child(tree.root, 'kernel')?.size, 10);
	});

	it('sorts children by size descending', () => {
		const tree = assembleMemoryTree(
			[
				{ name: 'small', size: 10, address: 0x1, section: 'text', file: `${ZB}/a/small.c` },
				{ name: 'big', size: 90, address: 0x2, section: 'text', file: `${ZB}/a/big.c` },
			],
			100,
			ZB,
		);
		// Common prefix is .../a (not the base), so a ZEPHYR_BASE wrapper exists.
		const dir = child(child(tree.root, 'ZEPHYR_BASE'), 'a');
		assert.deepEqual(dir?.children?.map(c => c.name), ['big.c', 'small.c']);
	});
});
