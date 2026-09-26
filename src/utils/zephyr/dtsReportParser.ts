import fs from 'fs';
import path from 'path';

const RAW_TEXT_LIMIT = 1_500_000;

export interface ZephyrDeviceTreeNode {
	path: string;
	name: string;
	depth: number;
	labels: string[];
	/** The first compatible string, which the dashboard shows. */
	compatible?: string;
	/** Every compatible string, most specific first. */
	compatibles?: string[];
	status?: string;
	sourceDisplay?: string;
	sourcePath?: string;
	sourceLine?: number;
	/** First and last line of the node in zephyr.dts, zero based. */
	bodyStart?: number;
	bodyEnd?: number;
}

export interface ZephyrDeviceTreeReport {
	dtsPath: string;
	nodes: ZephyrDeviceTreeNode[];
	totalNodes: number;
	okayCount: number;
	disabledCount: number;
	rawText: string;
	rawTruncated: boolean;
}

export interface ZephyrDeviceTreeInput {
	dtsPath: string;
	westWorkspaceRoot?: string;
	appRootPath?: string;
}

interface PendingOrigin {
	nodePath: string;
	file: string;
	line: number;
}

const ORIGIN_RE = /^\s*\/\*\s*node\s+'([^']+)'\s+defined in\s+(.+?):(\d+)\s*\*\/\s*$/;
const NODE_OPEN_RE = /^((?:[A-Za-z_][A-Za-z0-9_-]*:\s*)*)(\/|[^\s{]+)?\s*\{$/;
const COMPATIBLE_RE = /^\s*compatible\s*=\s*"([^"]*)"/;
const STATUS_RE = /^\s*status\s*=\s*"([^"]*)"/;

const reportCache = new Map<string, { fingerprint: string; report: ZephyrDeviceTreeReport }>();

export function readZephyrDeviceTreeReport(input: ZephyrDeviceTreeInput): ZephyrDeviceTreeReport {
	const fingerprint = createFingerprint(input.dtsPath);
	const cached = reportCache.get(input.dtsPath);
	if (cached && cached.fingerprint === fingerprint) {
		return cached.report;
	}

	const report = parseDeviceTree(input);
	reportCache.set(input.dtsPath, { fingerprint, report });
	return report;
}

function createFingerprint(dtsPath: string): string {
	const stat = fs.statSync(dtsPath);
	return `${dtsPath}:${stat.size}:${stat.mtimeMs}`;
}

function parseDeviceTree(input: ZephyrDeviceTreeInput): ZephyrDeviceTreeReport {
	const content = fs.readFileSync(input.dtsPath, 'utf8');
	const lines = content.split(/\r?\n/);

	const nodes: ZephyrDeviceTreeNode[] = [];
	const stack: ZephyrDeviceTreeNode[] = [];
	const sourceMemo = new Map<string, string | undefined>();
	let pendingOrigin: PendingOrigin | undefined;
	// A compatible list can continue over several lines until its ';'.
	let collecting: ZephyrDeviceTreeNode | undefined;

	for (let index = 0; index < lines.length; index++) {
		const rawLine = lines[index];
		if (collecting) {
			collecting.compatibles?.push(...quotedStrings(rawLine));
			if (rawLine.includes(';')) {
				collecting = undefined;
			}
			continue;
		}
		const originMatch = rawLine.match(ORIGIN_RE);
		if (originMatch) {
			pendingOrigin = {
				nodePath: originMatch[1],
				file: originMatch[2].trim(),
				line: Number(originMatch[3]),
			};
			continue;
		}

		const trimmed = rawLine.trim();
		if (trimmed.length === 0) {
			continue;
		}

		// Node close: a lone '};' (or '}') pops the innermost node. Clamp at an
		// empty stack so an unexpected brace can never desync the walk.
		if (trimmed === '};' || trimmed === '}') {
			const closed = stack.pop();
			if (closed) {
				closed.bodyEnd = index;
			}
			pendingOrigin = undefined;
			continue;
		}

		if (trimmed.endsWith('{')) {
			const openMatch = trimmed.match(NODE_OPEN_RE);
			if (openMatch) {
				const labels = openMatch[1]
					? openMatch[1].split(':').map(label => label.trim()).filter(Boolean)
					: [];
				const parent = stack.length > 0 ? stack[stack.length - 1] : undefined;
				const rawName = openMatch[2] ?? '';
				const name = rawName === '/' ? '/' : rawName;
				const nodePath = pendingOrigin?.nodePath ?? buildPath(parent, name);

				const node: ZephyrDeviceTreeNode = {
					path: nodePath,
					name: name || nodePath,
					depth: stack.length,
					labels,
					bodyStart: index,
				};

				if (pendingOrigin) {
					applySource(node, pendingOrigin, input, sourceMemo);
				}

				nodes.push(node);
				stack.push(node);
			}
			pendingOrigin = undefined;
			continue;
		}

		// Property lines only matter for the innermost open node.
		const current = stack.length > 0 ? stack[stack.length - 1] : undefined;
		if (!current) {
			continue;
		}
		if (current.compatible === undefined) {
			const compatibleMatch = rawLine.match(COMPATIBLE_RE);
			if (compatibleMatch) {
				current.compatible = compatibleMatch[1];
				current.compatibles = quotedStrings(rawLine.slice(rawLine.indexOf('=') + 1));
				if (!rawLine.includes(';')) {
					collecting = current;
				}
			}
		}
		if (current.status === undefined) {
			const statusMatch = rawLine.match(STATUS_RE);
			if (statusMatch) {
				current.status = statusMatch[1];
			}
		}
	}

	const disabledCount = nodes.filter(node => node.status === 'disabled').length;

	return {
		dtsPath: input.dtsPath,
		nodes,
		totalNodes: nodes.length,
		okayCount: nodes.length - disabledCount,
		disabledCount,
		rawText: content.length > RAW_TEXT_LIMIT ? content.slice(0, RAW_TEXT_LIMIT) : content,
		rawTruncated: content.length > RAW_TEXT_LIMIT,
	};
}

function quotedStrings(text: string): string[] {
	return [...text.matchAll(/"([^"]*)"/g)].map(match => match[1]);
}

function buildPath(parent: ZephyrDeviceTreeNode | undefined, name: string): string {
	if (!parent) {
		return name || '/';
	}
	if (parent.path === '/') {
		return `/${name}`;
	}
	return `${parent.path}/${name}`;
}

function applySource(
	node: ZephyrDeviceTreeNode,
	origin: PendingOrigin,
	input: ZephyrDeviceTreeInput,
	memo: Map<string, string | undefined>,
): void {
	node.sourceDisplay = `${origin.file}:${origin.line}`;
	node.sourceLine = origin.line;

	if (memo.has(origin.file)) {
		node.sourcePath = memo.get(origin.file);
		return;
	}

	const resolved = resolveSourceFile(origin.file, input);
	memo.set(origin.file, resolved);
	node.sourcePath = resolved;
}

function resolveSourceFile(file: string, input: ZephyrDeviceTreeInput): string | undefined {
	if (path.isAbsolute(file)) {
		return fs.existsSync(file) ? file : undefined;
	}

	const roots = [input.westWorkspaceRoot, input.appRootPath].filter((root): root is string => !!root);
	for (const root of roots) {
		const candidate = path.join(root, file);
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}
