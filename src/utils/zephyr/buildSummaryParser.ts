import fs from 'fs';
import path from 'path';

export interface ZephyrBuildArtifactSummary {
	key: string;
	label: string;
	present: boolean;
	path?: string;
	sizeBytes?: number;
	mtimeMs?: number;
}

export interface ZephyrBuildMemoryRegionSummary {
	name: string;
	usedBytes: number;
	totalBytes: number;
	usedPercent: number;
}

export interface ZephyrBuildFeatureSummary {
	label: string;
	enabled: boolean;
}

export interface ZephyrBuildSummary {
	buildDir: string;
	lastBuildTimeMs?: number;
	arch?: string;
	soc?: string;
	toolchain?: string;
	generator?: string;
	artifacts: ZephyrBuildArtifactSummary[];
	memoryRegions: ZephyrBuildMemoryRegionSummary[];
	features: ZephyrBuildFeatureSummary[];
	presentArtifactCount: number;
}

export interface ZephyrBuildSummaryInput {
	buildDir: string;
	elfPath?: string;
	binPath?: string;
	hexPath?: string;
	mapPath?: string;
	dotConfigPath?: string;
	cmakeCachePath?: string;
}

const FEATURE_KEYS: Array<{ label: string; key: string }> = [
	{ label: 'Logging', key: 'CONFIG_LOG' },
	{ label: 'Shell', key: 'CONFIG_SHELL' },
	{ label: 'SMP', key: 'CONFIG_SMP' },
	{ label: 'Bluetooth', key: 'CONFIG_BT' },
	{ label: 'Networking', key: 'CONFIG_NETWORKING' },
	{ label: 'USB', key: 'CONFIG_USB_DEVICE_STACK' },
];

export function readZephyrBuildSummary(input: ZephyrBuildSummaryInput): ZephyrBuildSummary {
	const artifacts = [
		createArtifact('elf', 'ELF', input.elfPath),
		createArtifact('bin', 'BIN', input.binPath),
		createArtifact('hex', 'HEX', input.hexPath),
		createArtifact('map', 'MAP', input.mapPath),
	];

	const config = parseDotConfig(input.dotConfigPath);
	const cache = parseCMakeCache(input.cmakeCachePath);
	const memoryRegions = parseMemoryRegions(input.mapPath);
	const features = FEATURE_KEYS.map(feature => ({
		label: feature.label,
		enabled: config.get(feature.key) === 'y',
	}));

	const timestamps = [
		...artifacts.map(artifact => artifact.mtimeMs).filter((value): value is number => value !== undefined),
		statMtime(input.dotConfigPath),
		statMtime(input.cmakeCachePath),
	].filter((value): value is number => value !== undefined);

	return {
		buildDir: input.buildDir,
		lastBuildTimeMs: timestamps.length > 0 ? Math.max(...timestamps) : undefined,
		arch: readArch(config),
		soc: stripQuotes(config.get('CONFIG_SOC') ?? config.get('CONFIG_SOC_SERIES') ?? ''),
		toolchain: readToolchain(cache),
		generator: cache.get('CMAKE_GENERATOR') ?? cache.get('CMAKE_MAKE_PROGRAM'),
		artifacts,
		memoryRegions,
		features,
		presentArtifactCount: artifacts.filter(artifact => artifact.present).length,
	};
}

function createArtifact(key: string, label: string, filePath?: string): ZephyrBuildArtifactSummary {
	if (!filePath || !fs.existsSync(filePath)) {
		return {
			key,
			label,
			present: false,
		};
	}

	const stat = fs.statSync(filePath);
	return {
		key,
		label,
		present: true,
		path: filePath,
		sizeBytes: stat.size,
		mtimeMs: stat.mtimeMs,
	};
}

function statMtime(filePath?: string): number | undefined {
	if (!filePath || !fs.existsSync(filePath)) {
		return undefined;
	}

	return fs.statSync(filePath).mtimeMs;
}

function parseDotConfig(dotConfigPath?: string): Map<string, string> {
	const config = new Map<string, string>();
	if (!dotConfigPath || !fs.existsSync(dotConfigPath)) {
		return config;
	}

	const content = fs.readFileSync(dotConfigPath, 'utf8');
	for (const line of content.split(/\r?\n/)) {
		const disabledMatch = line.match(/^#\s+(CONFIG_[A-Z0-9_]+)\s+is not set$/);
		if (disabledMatch) {
			config.set(disabledMatch[1], 'n');
			continue;
		}

		const enabledMatch = line.match(/^(CONFIG_[A-Z0-9_]+)=(.*)$/);
		if (enabledMatch) {
			config.set(enabledMatch[1], enabledMatch[2]);
		}
	}

	return config;
}

function parseCMakeCache(cachePath?: string): Map<string, string> {
	const cache = new Map<string, string>();
	if (!cachePath || !fs.existsSync(cachePath)) {
		return cache;
	}

	const content = fs.readFileSync(cachePath, 'utf8');
	for (const line of content.split(/\r?\n/)) {
		if (line.length === 0 || line.startsWith('//') || line.startsWith('#')) {
			continue;
		}

		const match = line.match(/^([^:=]+)(?::[^=]+)?=(.*)$/);
		if (!match) {
			continue;
		}

		cache.set(match[1], match[2]);
	}

	return cache;
}

function parseMemoryRegions(mapPath?: string): ZephyrBuildMemoryRegionSummary[] {
	if (!mapPath || !fs.existsSync(mapPath)) {
		return [];
	}

	const content = fs.readFileSync(mapPath, 'utf8');
	const lines = content.split(/\r?\n/);
	const regions: ZephyrBuildMemoryRegionSummary[] = [];
	let inRegionTable = false;

	for (const line of lines) {
		if (line.includes('Memory region') && line.includes('Used Size') && line.includes('Region Size')) {
			inRegionTable = true;
			continue;
		}

		if (!inRegionTable) {
			continue;
		}

		if (line.trim().length === 0) {
			break;
		}

		const match = line.match(/^\s*([A-Za-z0-9_]+):?\s+([0-9.]+\s*[KMG]?B)\s+([0-9.]+\s*[KMG]?B)\s+([0-9.]+)%/i);
		if (!match) {
			continue;
		}

		regions.push({
			name: match[1],
			usedBytes: parseHumanBytes(match[2]),
			totalBytes: parseHumanBytes(match[3]),
			usedPercent: Number(match[4]),
		});
	}

	return regions;
}

function parseHumanBytes(input: string): number {
	const match = input.trim().match(/^([0-9.]+)\s*([KMG]?B)$/i);
	if (!match) {
		return 0;
	}

	const value = Number(match[1]);
	const unit = match[2].toUpperCase();
	switch (unit) {
		case 'KB':
			return Math.round(value * 1024);
		case 'MB':
			return Math.round(value * 1024 * 1024);
		case 'GB':
			return Math.round(value * 1024 * 1024 * 1024);
		default:
			return Math.round(value);
	}
}

function readArch(config: Map<string, string>): string | undefined {
	const configuredArch = stripQuotes(config.get('CONFIG_ARCH') ?? '');
	if (configuredArch) {
		return configuredArch;
	}

	const inferred = [
		['CONFIG_ARM', 'arm'],
		['CONFIG_ARM64', 'arm64'],
		['CONFIG_RISCV', 'riscv'],
		['CONFIG_X86', 'x86'],
		['CONFIG_ARC', 'arc'],
		['CONFIG_XTENSA', 'xtensa'],
		['CONFIG_NIOS2', 'nios2'],
	].find(([key]) => config.get(key) === 'y');

	return inferred?.[1];
}

function readToolchain(cache: Map<string, string>): string | undefined {
	const variant = cache.get('ZEPHYR_TOOLCHAIN_VARIANT');
	if (variant) {
		return variant;
	}

	const compiler = cache.get('CMAKE_C_COMPILER');
	if (!compiler) {
		return undefined;
	}

	return path.basename(compiler);
}

function stripQuotes(value: string): string | undefined {
	if (!value) {
		return undefined;
	}

	return value.replace(/^"(.*)"$/, '$1');
}
