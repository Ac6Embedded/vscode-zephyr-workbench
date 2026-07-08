import fs from 'fs';
import path from 'path';

import { parseDotConfig } from './buildSummaryParser';

const KCONFIG_DOC_BASE = 'https://docs.zephyrproject.org/latest/kconfig.html';

export type KconfigSource = 'unset' | 'default' | 'assign' | 'select' | 'imply' | 'config';

export interface ZephyrKconfigSymbol {
	name: string;
	type?: string;
	value?: string;
	isSet: boolean;
	visible: boolean;
	source: KconfigSource;
	locDisplay?: string;
	locPath?: string;
	locLine?: number;
	docHref?: string;
}

export interface ZephyrKconfigReport {
	configPath?: string;
	source: 'trace' | 'config';
	symbols: ZephyrKconfigSymbol[];
	totalCount: number;
	setCount: number;
	hiddenCount: number;
}

export interface ZephyrKconfigInput {
	traceJsonPath?: string;
	dotConfigPath?: string;
	zephyrBase?: string;
	westWorkspaceRoot?: string;
}

type TraceEntry = [
	name: string,
	visible: string,
	symType: string,
	value: string | null,
	src: string,
	loc: unknown,
];

const reportCache = new Map<string, { fingerprint: string; report: ZephyrKconfigReport }>();

export function readZephyrKconfigReport(input: ZephyrKconfigInput): ZephyrKconfigReport | undefined {
	const cacheKey = input.traceJsonPath ?? input.dotConfigPath;
	if (!cacheKey) {
		return undefined;
	}

	const sourcePath = fileExists(input.traceJsonPath) ? input.traceJsonPath! : input.dotConfigPath;
	if (!sourcePath || !fs.existsSync(sourcePath)) {
		return undefined;
	}

	const fingerprint = createFingerprint(sourcePath);
	const cached = reportCache.get(cacheKey);
	if (cached && cached.fingerprint === fingerprint) {
		return cached.report;
	}

	const report = fileExists(input.traceJsonPath)
		? parseTrace(input)
		: parseConfigFallback(input);

	if (report) {
		reportCache.set(cacheKey, { fingerprint, report });
	}
	return report;
}

function createFingerprint(filePath: string): string {
	const stat = fs.statSync(filePath);
	return `${filePath}:${stat.size}:${stat.mtimeMs}`;
}

function fileExists(filePath?: string): boolean {
	return !!filePath && fs.existsSync(filePath);
}

function parseTrace(input: ZephyrKconfigInput): ZephyrKconfigReport | undefined {
	const raw = fs.readFileSync(input.traceJsonPath!, 'utf8');
	let entries: TraceEntry[];
	try {
		entries = JSON.parse(raw) as TraceEntry[];
	} catch {
		return undefined;
	}
	if (!Array.isArray(entries)) {
		return undefined;
	}

	const displayMemo = new Map<string, string>();
	const existsMemo = new Map<string, boolean>();

	const symbols: ZephyrKconfigSymbol[] = entries
		.filter(entry => Array.isArray(entry) && typeof entry[0] === 'string')
		.map(entry => {
			const [name, visible, symType, value, src, loc] = entry;
			const source = normalizeSource(src);
			const isSet = source !== 'unset';
			const symbol: ZephyrKconfigSymbol = {
				name,
				type: symType || undefined,
				isSet,
				visible: visible === 'y',
				source,
				value: isSet && value !== null && value !== undefined ? formatValue(symType, value) : undefined,
				docHref: name.startsWith('CONFIG_DT_HAS_') ? undefined : `${KCONFIG_DOC_BASE}#${name}`,
			};
			applyLocation(symbol, source, loc, input, displayMemo, existsMemo);
			return symbol;
		});

	symbols.sort((a, b) => a.name.localeCompare(b.name));

	return {
		configPath: input.dotConfigPath,
		source: 'trace',
		symbols,
		totalCount: symbols.length,
		setCount: symbols.filter(symbol => symbol.isSet).length,
		hiddenCount: symbols.filter(symbol => !symbol.visible).length,
	};
}

function parseConfigFallback(input: ZephyrKconfigInput): ZephyrKconfigReport | undefined {
	const config = parseDotConfig(input.dotConfigPath);
	if (config.size === 0) {
		return undefined;
	}

	const symbols: ZephyrKconfigSymbol[] = [...config.entries()].map(([name, value]) => ({
		name,
		value: formatValue(undefined, value),
		isSet: true,
		visible: true,
		source: 'config' as KconfigSource,
		docHref: name.startsWith('CONFIG_DT_HAS_') ? undefined : `${KCONFIG_DOC_BASE}#${name}`,
	}));

	symbols.sort((a, b) => a.name.localeCompare(b.name));

	return {
		configPath: input.dotConfigPath,
		source: 'config',
		symbols,
		totalCount: symbols.length,
		setCount: symbols.length,
		hiddenCount: 0,
	};
}

function normalizeSource(src: string): KconfigSource {
	switch (src) {
		case 'unset':
		case 'default':
		case 'assign':
		case 'select':
		case 'imply':
			return src;
		default:
			return 'default';
	}
}

function formatValue(symType: string | undefined, value: string): string {
	if (symType === 'string') {
		return `"${value}"`;
	}
	return value;
}

function applyLocation(
	symbol: ZephyrKconfigSymbol,
	source: KconfigSource,
	loc: unknown,
	input: ZephyrKconfigInput,
	displayMemo: Map<string, string>,
	existsMemo: Map<string, boolean>,
): void {
	if (source === 'select' || source === 'imply') {
		if (Array.isArray(loc) && loc.length > 0) {
			symbol.locDisplay = loc.map(expr => String(expr)).join(' || ');
		}
		return;
	}

	if (source === 'default' && (loc === null || loc === undefined)) {
		symbol.locDisplay = '(implicit)';
		return;
	}

	if (Array.isArray(loc) && loc.length >= 2 && typeof loc[0] === 'string') {
		const file = loc[0];
		const line = Number(loc[1]) || undefined;
		symbol.locDisplay = `${relativizePath(file, input, displayMemo)}${line ? `:${line}` : ''}`;
		if (resolveExists(file, existsMemo)) {
			symbol.locPath = file;
			symbol.locLine = line;
		}
	}
}

function relativizePath(file: string, input: ZephyrKconfigInput, memo: Map<string, string>): string {
	const cached = memo.get(file);
	if (cached !== undefined) {
		return cached;
	}

	let display = file;
	const roots = [input.westWorkspaceRoot, input.zephyrBase].filter((root): root is string => !!root);
	for (const root of roots) {
		const relative = path.relative(root, file);
		if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
			display = relative.split(path.sep).join('/');
			break;
		}
	}

	memo.set(file, display);
	return display;
}

function resolveExists(file: string, memo: Map<string, boolean>): boolean {
	const cached = memo.get(file);
	if (cached !== undefined) {
		return cached;
	}
	const exists = fs.existsSync(file);
	memo.set(file, exists);
	return exists;
}
