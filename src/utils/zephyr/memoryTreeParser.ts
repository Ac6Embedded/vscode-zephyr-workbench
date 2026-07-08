import fs from 'fs';

import { readZephyrMemoryReport, type ZephyrMemoryBucketReport } from './memoryReportParser';
import { buildAddressFileMap, type DwarfAddressFile } from './dwarfLineInfo';

// Builds a hierarchical, source-path grouped memory tree for RAM and ROM, the
// same way Zephyr's size_report / dashboard plot groups symbols (Zephyr base,
// other absolute paths, and "(no paths)"), plus a "(hidden)" bucket for bytes
// not attributed to any symbol. Reuses the ELF section/symbol parsing from
// memoryReportParser and the DWARF address->file map from dwarfLineInfo, so no
// external tool or subprocess is needed.

export interface ZephyrMemoryTreeNode {
	name: string;
	size: number;
	children?: ZephyrMemoryTreeNode[];
	address?: number;
	section?: string;
}

export interface ZephyrMemoryTree {
	total: number;
	root: ZephyrMemoryTreeNode;
}

export interface ZephyrMemoryTreeReport {
	ram?: ZephyrMemoryTree;
	rom?: ZephyrMemoryTree;
	xip: boolean;
}

export interface ZephyrMemoryTreeInput {
	elfPath: string;
	zephyrBase?: string;
}

const NO_PATHS = '(no paths)';
const HIDDEN = '(hidden)';
const ZEPHYR_BASE_LABEL = 'ZEPHYR_BASE';
const OTHERS_LABEL = '/';

const cache = new Map<string, { fingerprint: string; report: ZephyrMemoryTreeReport }>();

export function readZephyrMemoryTreeReport(input: ZephyrMemoryTreeInput): ZephyrMemoryTreeReport {
	const stat = fs.statSync(input.elfPath);
	const fingerprint = `${input.elfPath}:${stat.size}:${stat.mtimeMs}:${input.zephyrBase ?? ''}`;
	const cached = cache.get(input.elfPath);
	if (cached && cached.fingerprint === fingerprint) {
		return cached.report;
	}

	const memory = readZephyrMemoryReport(input.elfPath);
	const addrFiles = buildAddressFileMap(input.elfPath);
	const zephyrBase = input.zephyrBase ? normalize(input.zephyrBase) : undefined;

	const report: ZephyrMemoryTreeReport = {
		xip: memory.xip,
		ram: buildTree(memory.ram, addrFiles, zephyrBase),
		rom: buildTree(memory.rom, addrFiles, zephyrBase),
	};

	cache.set(input.elfPath, { fingerprint, report });
	return report;
}

interface WorkNode extends ZephyrMemoryTreeNode {
	childMap?: Map<string, WorkNode>;
	children?: WorkNode[];
}

export interface MemoryTreeSymbol {
	name: string;
	size: number;
	address: number;
	section: string;
	file: string | null;
}

function buildTree(bucket: ZephyrMemoryBucketReport, addrFiles: DwarfAddressFile, zephyrBase?: string): ZephyrMemoryTree | undefined {
	if (!bucket || bucket.totalBytes <= 0) {
		return undefined;
	}

	// Collect every symbol with the file it maps to (absolute path or null).
	const mapped: MemoryTreeSymbol[] = [];
	for (const section of bucket.sections) {
		for (const sym of section.symbols) {
			mapped.push({
				name: sym.name,
				size: sym.size,
				address: sym.address,
				section: sym.sectionName,
				file: lookupFile(addrFiles, sym.address),
			});
		}
	}

	return assembleMemoryTree(mapped, bucket.totalBytes, zephyrBase);
}

// Groups already-resolved symbols into the size_report tree shape. Exposed for
// unit testing with synthetic symbol lists.
export function assembleMemoryTree(mapped: MemoryTreeSymbol[], totalBytes: number, zephyrBase?: string): ZephyrMemoryTree {
	const base = zephyrBase ? normalize(zephyrBase) : undefined;
	let mappedBytes = 0;
	const filePaths: string[] = [];
	for (const entry of mapped) {
		mappedBytes += entry.size;
		if (entry.file) {
			filePaths.push(entry.file);
		}
	}

	// size_report flattens the tree (skips the ZEPHYR_BASE level) when every
	// mapped file lives under the Zephyr base.
	const commonPrefix = commonPathPrefix(filePaths);
	const flatten = !!base && !!commonPrefix && normalize(commonPrefix) === base;

	const root: WorkNode = { name: 'Root', size: 0 };
	const noPaths = childNode(root, NO_PATHS);
	const zephyrNode = flatten ? root : childNode(root, ZEPHYR_BASE_LABEL);
	let othersNode: WorkNode | undefined;

	for (const entry of mapped) {
		const file = entry.file ? normalize(entry.file) : null;
		if (!file) {
			insert(noPaths, [entry.name], entry);
			continue;
		}
		if (base && isUnder(file, base)) {
			insert(zephyrNode, [...relativeParts(file, base), entry.name], entry);
			continue;
		}
		if (isAbsolute(file)) {
			if (!othersNode) {
				othersNode = childNode(root, OTHERS_LABEL);
			}
			insert(othersNode, [...pathParts(file), entry.name], entry);
			continue;
		}
		insert(noPaths, [entry.name], entry);
	}

	// Bytes allocated in a section but not attributed to any symbol.
	const hiddenBytes = Math.max(0, totalBytes - mappedBytes);
	if (hiddenBytes > 0) {
		(root.children ||= []).push({ name: HIDDEN, size: hiddenBytes });
	}

	// Drop the empty "(no paths)" node so it does not clutter the chart.
	pruneEmpty(root);

	root.size = totalBytes;
	return { total: totalBytes, root: strip(root) };
}

function lookupFile(addrFiles: DwarfAddressFile, address: number): string | null {
	const exact = addrFiles.exact.get(address);
	if (exact) {
		return exact;
	}
	for (const range of addrFiles.ranges) {
		if (address >= range.low && address < range.high) {
			return range.path;
		}
	}
	return null;
}

function childNode(parent: WorkNode, name: string): WorkNode {
	if (!parent.childMap) {
		parent.childMap = new Map();
	}
	let node = parent.childMap.get(name);
	if (!node) {
		node = { name, size: 0 };
		parent.childMap.set(name, node);
		(parent.children ||= []).push(node);
	}
	return node;
}

function insert(root: WorkNode, parts: string[], entry: { size: number; address: number; section: string }): void {
	let node = root;
	root.size += entry.size;
	for (let i = 0; i < parts.length; i += 1) {
		const child = childNode(node, parts[i]);
		child.size += entry.size;
		if (i === parts.length - 1) {
			child.address = entry.address;
			child.section = entry.section;
		}
		node = child;
	}
}

function pruneEmpty(root: WorkNode): void {
	if (!root.children) {
		return;
	}
	root.children = root.children.filter(child => child.size > 0 || (child.children && child.children.length > 0));
}

function strip(node: WorkNode): ZephyrMemoryTreeNode {
	const out: ZephyrMemoryTreeNode = { name: node.name, size: node.size };
	if (node.address !== undefined) {
		out.address = node.address;
	}
	if (node.section !== undefined) {
		out.section = node.section;
	}
	if (node.children && node.children.length > 0) {
		out.children = node.children
			.sort((a, b) => b.size - a.size)
			.map(strip);
	}
	return out;
}

// ---- Path helpers (DWARF paths use POSIX separators) ----------------------

function normalize(p: string): string {
	let out = p.replace(/\\/g, '/');
	// Collapse duplicate slashes (size_report can emit '//' when joining) but
	// keep a single leading slash for absolute paths.
	out = out.replace(/\/{2,}/g, '/');
	if (out.length > 1 && out.endsWith('/')) {
		out = out.slice(0, -1);
	}
	return out;
}

function isAbsolute(p: string): boolean {
	return p.startsWith('/') || /^[A-Za-z]:\//.test(p);
}

function pathParts(p: string): string[] {
	return normalize(p).split('/').filter(part => part.length > 0);
}

function isUnder(file: string, base: string): boolean {
	return file === base || file.startsWith(base.endsWith('/') ? base : base + '/');
}

function relativeParts(file: string, base: string): string[] {
	const rel = file.slice(base.length);
	return rel.split('/').filter(part => part.length > 0);
}

function commonPathPrefix(paths: string[]): string | undefined {
	if (paths.length === 0) {
		return undefined;
	}
	let prefix = pathParts(paths[0]);
	for (let i = 1; i < paths.length; i += 1) {
		const parts = pathParts(paths[i]);
		let j = 0;
		while (j < prefix.length && j < parts.length && prefix[j] === parts[j]) {
			j += 1;
		}
		prefix = prefix.slice(0, j);
		if (prefix.length === 0) {
			return paths[0].startsWith('/') ? '/' : undefined;
		}
	}
	return (paths[0].startsWith('/') ? '/' : '') + prefix.join('/');
}
