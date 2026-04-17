import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

export interface ZephyrBuildArtifactSummary {
	key: string;
	label: string;
	present: boolean;
	path?: string;
	sizeBytes?: number;
	mtimeMs?: number;
}

export interface ZephyrBuildMemoryCapacitySummary {
	name: string;
	originBytes: number;
	totalBytes: number;
	attributes: string;
}

export interface ZephyrBuildImageSummary {
	binSizeBytes?: number;
	entryPoint?: string;
	textBytes?: number;
	rodataBytes?: number;
	dataBytes?: number;
	bssBytes?: number;
}

export interface ZephyrBuildTargetSummary {
	applicationName?: string;
	applicationPath?: string;
	boardName?: string;
	boardQualifiers?: string;
	boardRevision?: string;
	boardTarget?: string;
	socPartNumber?: string;
	socFamily?: string;
	cpu?: string;
	arch?: string;
	zephyrVersion?: string;
	zephyrBase?: string;
	zephyrRevision?: string;
	zephyrTag?: string;
	workspaceDirty?: boolean;
}

export interface ZephyrBuildToolchainSummary {
	variant?: string;
	name?: string;
	path?: string;
	sdkName?: string;
	sdkVersion?: string;
	generator?: string;
	westVersion?: string;
	westCommand?: string;
	xip?: boolean;
}

export interface ZephyrBuildSourceFileSummary {
	label: string;
	path?: string;
}

export interface ZephyrBuildSourcesSummary {
	kconfigUserFiles: ZephyrBuildSourceFileSummary[];
	kconfigDefaultFiles: ZephyrBuildSourceFileSummary[];
	dtsUserFiles: ZephyrBuildSourceFileSummary[];
	dtsDefaultFiles: ZephyrBuildSourceFileSummary[];
}

export interface ZephyrBuildSummary {
	buildDir: string;
	lastBuildTimeMs?: number;
	artifacts: ZephyrBuildArtifactSummary[];
	memoryCapacities: ZephyrBuildMemoryCapacitySummary[];
	image: ZephyrBuildImageSummary;
	target: ZephyrBuildTargetSummary;
	toolchain: ZephyrBuildToolchainSummary;
	sources: ZephyrBuildSourcesSummary;
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
	buildInfoPath?: string;
	metaPath?: string;
	statPath?: string;
}

interface ZephyrStatSection {
	name: string;
	type: string;
	sizeBytes: number;
	flags: string;
}

interface ZephyrStatSummary {
	entryPoint?: string;
	sections: ZephyrStatSection[];
}

const buildSummaryCache = new Map<string, { fingerprint: string; summary: ZephyrBuildSummary }>();

export function readZephyrBuildSummary(input: ZephyrBuildSummaryInput): ZephyrBuildSummary {
	const fingerprint = createFingerprint(input);
	const cached = buildSummaryCache.get(input.buildDir);
	if (cached && cached.fingerprint === fingerprint) {
		return cached.summary;
	}

	const artifacts = [
		createArtifact('elf', 'ELF', input.elfPath),
		createArtifact('bin', 'BIN', input.binPath),
		createArtifact('hex', 'HEX', input.hexPath),
		createArtifact('map', 'MAP', input.mapPath),
	];

	const config = parseDotConfig(input.dotConfigPath);
	const cmakeCache = parseCMakeCache(input.cmakeCachePath);
	const buildInfo = parseYamlFile(input.buildInfoPath);
	const meta = parseYamlFile(input.metaPath);
	const stat = parseZephyrStat(input.statPath);
	const memoryCapacities = parseMemoryConfiguration(input.mapPath);
	const appConfigDir = asString(buildInfo?.cmake?.application?.['configuration-dir']);

	const summary: ZephyrBuildSummary = {
		buildDir: input.buildDir,
		lastBuildTimeMs: getLastBuildTimestamp([
			...artifacts.map(artifact => artifact.path),
			input.buildInfoPath,
			input.metaPath,
			input.statPath,
			input.dotConfigPath,
			input.cmakeCachePath,
		]),
		artifacts,
		memoryCapacities,
		image: buildImageSummary(artifacts, stat),
		target: {
			applicationName: appConfigDir ? path.basename(appConfigDir) : undefined,
			applicationPath: appConfigDir,
			boardName: asString(buildInfo?.cmake?.board?.name),
			boardQualifiers: asString(buildInfo?.cmake?.board?.qualifiers),
			boardRevision: asString(buildInfo?.cmake?.board?.revision),
			boardTarget: stripQuotes(config.get('CONFIG_BOARD_TARGET')),
			socPartNumber: stripQuotes(config.get('CONFIG_SOC_PART_NUMBER')),
			socFamily: stripQuotes(config.get('CONFIG_SOC_FAMILY') ?? config.get('CONFIG_SOC_SERIES')),
			cpu: readCpuLabel(config),
			arch: readArch(config),
			zephyrVersion: asString(buildInfo?.cmake?.zephyr?.version),
			zephyrBase: asString(buildInfo?.cmake?.zephyr?.['zephyr-base']),
			zephyrRevision: asString(meta?.zephyr?.revision),
			zephyrTag: firstString(meta?.zephyr?.tags),
			workspaceDirty: typeof meta?.workspace?.dirty === 'boolean' ? meta.workspace.dirty : undefined,
		},
		toolchain: {
			variant: asString(cmakeCache.get('ZEPHYR_TOOLCHAIN_VARIANT')) ?? asString(buildInfo?.cmake?.toolchain?.name),
			name: asString(buildInfo?.cmake?.toolchain?.name),
			path: asString(buildInfo?.cmake?.toolchain?.path),
			sdkName: readSdkName(asString(buildInfo?.cmake?.toolchain?.path)),
			sdkVersion: readSdkVersion(asString(buildInfo?.cmake?.toolchain?.path)),
			generator: asString(cmakeCache.get('CMAKE_GENERATOR')),
			westVersion: asString(buildInfo?.west?.version),
			westCommand: asString(buildInfo?.west?.command),
			xip: config.get('CONFIG_XIP') === 'y',
		},
		sources: buildSourcesSummary(buildInfo, appConfigDir),
		presentArtifactCount: artifacts.filter(artifact => artifact.present).length,
	};

	buildSummaryCache.set(input.buildDir, { fingerprint, summary });
	return summary;
}

function createFingerprint(input: ZephyrBuildSummaryInput): string {
	const files = [
		input.elfPath,
		input.binPath,
		input.hexPath,
		input.mapPath,
		input.dotConfigPath,
		input.cmakeCachePath,
		input.buildInfoPath,
		input.metaPath,
		input.statPath,
	];

	return files
		.map(filePath => {
			if (!filePath || !fs.existsSync(filePath)) {
				return `${filePath ?? ''}:missing`;
			}

			const stat = fs.statSync(filePath);
			return `${filePath}:${stat.size}:${stat.mtimeMs}`;
		})
		.join('|');
}

function createArtifact(key: string, label: string, filePath?: string): ZephyrBuildArtifactSummary {
	if (!filePath || !fs.existsSync(filePath)) {
		return { key, label, present: false };
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

function getLastBuildTimestamp(filePaths: Array<string | undefined>): number | undefined {
	const timestamps = filePaths
		.filter((filePath): filePath is string => !!filePath && fs.existsSync(filePath))
		.map(filePath => fs.statSync(filePath).mtimeMs);

	return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
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
		if (line.length === 0 || line.startsWith('#') || line.startsWith('//')) {
			continue;
		}

		const match = line.match(/^([^:=]+)(?::[^=]+)?=(.*)$/);
		if (match) {
			cache.set(match[1], match[2]);
		}
	}

	return cache;
}

function parseYamlFile(filePath?: string): any {
	if (!filePath || !fs.existsSync(filePath)) {
		return undefined;
	}

	try {
		return yaml.parse(fs.readFileSync(filePath, 'utf8'));
	} catch {
		return undefined;
	}
}

function parseMemoryConfiguration(mapPath?: string): ZephyrBuildMemoryCapacitySummary[] {
	if (!mapPath || !fs.existsSync(mapPath)) {
		return [];
	}

	const content = fs.readFileSync(mapPath, 'utf8');
	const lines = content.split(/\r?\n/);
	const regions: ZephyrBuildMemoryCapacitySummary[] = [];
	let inBlock = false;
	let headerSeen = false;

	for (const line of lines) {
		if (!inBlock) {
			if (line.trim() === 'Memory Configuration') {
				inBlock = true;
			}
			continue;
		}

		if (!headerSeen) {
			if (line.includes('Name') && line.includes('Origin') && line.includes('Length')) {
				headerSeen = true;
			}
			continue;
		}

		if (line.trim().length === 0) {
			break;
		}

		const match = line.match(/^\s*([^\s]+)\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s*([rwx]*)/);
		if (!match || match[1] === '*default*') {
			continue;
		}

		regions.push({
			name: match[1],
			originBytes: Number.parseInt(match[2], 16),
			totalBytes: Number.parseInt(match[3], 16),
			attributes: match[4] ?? '',
		});
	}

	return regions;
}

function parseZephyrStat(statPath?: string): ZephyrStatSummary | undefined {
	if (!statPath || !fs.existsSync(statPath)) {
		return undefined;
	}

	const content = fs.readFileSync(statPath, 'utf8');
	const lines = content.split(/\r?\n/);
	const sections: ZephyrStatSection[] = [];
	let entryPoint: string | undefined;

	for (const line of lines) {
		if (!entryPoint) {
			const entryMatch = line.match(/Entry point address:\s+(.+)$/);
			if (entryMatch) {
				entryPoint = entryMatch[1].trim();
				continue;
			}
		}

		const sectionMatch = line.match(/^\s*\[\s*\d+\]\s+(\S+)\s+(\S+)\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]+\s+([0-9A-Fa-f]+)\s+\S+\s+([A-Z]*)/);
		if (!sectionMatch) {
			continue;
		}

		sections.push({
			name: sectionMatch[1],
			type: sectionMatch[2],
			sizeBytes: Number.parseInt(sectionMatch[3], 16),
			flags: sectionMatch[4],
		});
	}

	return {
		entryPoint,
		sections,
	};
}

function buildImageSummary(
	artifacts: ZephyrBuildArtifactSummary[],
	stat: ZephyrStatSummary | undefined,
): ZephyrBuildImageSummary {
	const sections = stat?.sections ?? [];
	const binArtifact = artifacts.find(artifact => artifact.key === 'bin');

	return {
		binSizeBytes: binArtifact?.sizeBytes,
		entryPoint: stat?.entryPoint,
		textBytes: readSectionBytes(sections, ['text', '.text']) ?? sumSections(sections, section => isCodeSection(section)),
		rodataBytes: readSectionBytes(sections, ['rodata', '.rodata']) ?? sumSections(sections, section => isReadOnlySection(section)),
		dataBytes: readSectionBytes(sections, ['datas', 'data', '.data', '.datas'])
			?? sumSections(sections, section => isReadWriteSection(section)),
		bssBytes: readSectionBytes(sections, ['bss', '.bss']) ?? sumSections(sections, section => isBssSection(section)),
	};
}

function readSectionBytes(sections: ZephyrStatSection[], names: string[]): number | undefined {
	for (const name of names) {
		const section = sections.find(candidate => candidate.name === name);
		if (section) {
			return section.sizeBytes;
		}
	}

	return undefined;
}

function sumSections(sections: ZephyrStatSection[], predicate: (section: ZephyrStatSection) => boolean): number | undefined {
	let total = 0;
	let matched = false;

	for (const section of sections) {
		if (!predicate(section)) {
			continue;
		}

		total += section.sizeBytes;
		matched = true;
	}

	return matched ? total : undefined;
}

function isCodeSection(section: ZephyrStatSection): boolean {
	return section.name === 'text' || section.name === '.text';
}

function isReadOnlySection(section: ZephyrStatSection): boolean {
	return section.name === 'rodata' || section.name === '.rodata';
}

function isReadWriteSection(section: ZephyrStatSection): boolean {
	if (section.type === 'NOBITS') {
		return false;
	}
	if (!section.flags.includes('W')) {
		return false;
	}

	return !section.name.startsWith('.debug') && section.name !== '.comment';
}

function isBssSection(section: ZephyrStatSection): boolean {
	return section.name === 'bss' || section.name === '.bss';
}

function buildSourcesSummary(buildInfo: any, appConfigDir?: string): ZephyrBuildSourcesSummary {
	const kconfigFiles = toStringArray(buildInfo?.cmake?.kconfig?.files);
	const kconfigUserFiles = uniqueStrings([
		...toStringArray(buildInfo?.cmake?.kconfig?.['user-files']),
		...toStringArray(buildInfo?.cmake?.kconfig?.['extra-user-files']),
	]);
	const dtsFiles = toStringArray(buildInfo?.cmake?.devicetree?.files);
	const dtsUserFiles = uniqueStrings(toStringArray(buildInfo?.cmake?.devicetree?.['user-files']));

	return {
		kconfigUserFiles: kconfigUserFiles.map(filePath => toSourceFileSummary(filePath, appConfigDir)),
		kconfigDefaultFiles: diffPaths(kconfigFiles, kconfigUserFiles).map(filePath => toSourceFileSummary(filePath, appConfigDir, true)),
		dtsUserFiles: dtsUserFiles.map(filePath => toSourceFileSummary(filePath, appConfigDir)),
		dtsDefaultFiles: diffPaths(dtsFiles, dtsUserFiles).map(filePath => toSourceFileSummary(filePath, appConfigDir, true)),
	};
}

function diffPaths(allFiles: string[], selectedFiles: string[]): string[] {
	const normalized = new Set(selectedFiles.map(normalizePathValue));
	return allFiles.filter(filePath => !normalized.has(normalizePathValue(filePath)));
}

function normalizePathValue(value: string): string {
	return value.replace(/\\/g, '/').toLowerCase();
}

function toDisplayPath(filePath: string, appConfigDir?: string, preferBasename = false): string {
	if (!filePath) {
		return '';
	}

	if (!path.isAbsolute(filePath)) {
		return filePath.replace(/\\/g, '/');
	}

	if (!preferBasename && appConfigDir) {
		const relative = path.relative(appConfigDir, filePath);
		if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
			return relative.replace(/\\/g, '/');
		}
	}

	return path.basename(filePath);
}

function toSourceFileSummary(
	filePath: string,
	appConfigDir?: string,
	preferBasename = false,
): ZephyrBuildSourceFileSummary {
	const resolvedPath = resolveSourcePath(filePath, appConfigDir);
	return {
		label: toDisplayPath(filePath, appConfigDir, preferBasename),
		path: resolvedPath,
	};
}

function resolveSourcePath(filePath: string, appConfigDir?: string): string | undefined {
	if (!filePath) {
		return undefined;
	}

	if (path.isAbsolute(filePath)) {
		return filePath;
	}

	if (appConfigDir) {
		return path.join(appConfigDir, filePath);
	}

	return undefined;
}

function uniqueStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const value of values) {
		const normalized = normalizePathValue(value);
		if (seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		result.push(value);
	}

	return result;
}

function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.filter((entry): entry is string => typeof entry === 'string');
}

function readArch(config: Map<string, string>): string | undefined {
	const configuredArch = stripQuotes(config.get('CONFIG_ARCH') ?? '');
	if (configuredArch) {
		return configuredArch;
	}

	if (config.get('CONFIG_ARM') === 'y') {
		return 'arm';
	}
	if (config.get('CONFIG_ARM64') === 'y') {
		return 'arm64';
	}
	if (config.get('CONFIG_RISCV') === 'y') {
		return 'riscv';
	}
	if (config.get('CONFIG_X86') === 'y') {
		return 'x86';
	}
	if (config.get('CONFIG_XTENSA') === 'y') {
		return 'xtensa';
	}

	return undefined;
}

function readCpuLabel(config: Map<string, string>): string | undefined {
	for (const [key, value] of config) {
		if (value !== 'y' || !key.startsWith('CONFIG_CPU_')) {
			continue;
		}

		const raw = key.slice('CONFIG_CPU_'.length);
		if (raw === 'CORTEX_M') {
			continue;
		}
		if (raw.startsWith('CORTEX_M')) {
			return `Cortex-M${raw.slice('CORTEX_M'.length)}`;
		}
		if (raw.startsWith('CORTEX_A')) {
			return `Cortex-A${raw.slice('CORTEX_A'.length)}`;
		}

		return raw.replace(/_/g, ' ');
	}

	return undefined;
}

function readSdkName(toolchainPath?: string): string | undefined {
	if (!toolchainPath) {
		return undefined;
	}

	return path.basename(toolchainPath);
}

function readSdkVersion(toolchainPath?: string): string | undefined {
	if (!toolchainPath) {
		return undefined;
	}

	const basename = path.basename(toolchainPath);
	const match = basename.match(/zephyr-sdk-([0-9.]+)/i);
	return match?.[1];
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function firstString(value: unknown): string | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const first = value.find(entry => typeof entry === 'string' && entry.length > 0);
	return typeof first === 'string' ? first : undefined;
}

function stripQuotes(value?: string): string | undefined {
	if (!value) {
		return undefined;
	}

	return value.replace(/^"(.*)"$/, '$1');
}
