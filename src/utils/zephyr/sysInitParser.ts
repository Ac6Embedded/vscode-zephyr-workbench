import fs from 'fs';

export const SYS_INIT_LEVELS = ['EARLY', 'PRE_KERNEL_1', 'PRE_KERNEL_2', 'POST_KERNEL', 'APPLICATION', 'SMP'] as const;

export type SysInitLevel = typeof SYS_INIT_LEVELS[number];

export interface ZephyrSysInitEntry {
	level: SysInitLevel;
	priority: number;
	address: number;
	addressHex: string;
	initObject: string;
	initFunction: string;
	argumentSymbol: string;
	call: string;
	kind: 'device' | 'system';
	deviceOrdinal?: number;
	devicePath?: string;
}

export interface ZephyrSysInitLevelReport {
	level: SysInitLevel;
	entries: ZephyrSysInitEntry[];
}

export interface ZephyrSysInitReport {
	buildDir: string;
	elfPath: string;
	devicetreeHeaderPath?: string;
	totalEntries: number;
	totalDeviceEntries: number;
	mappedDevicePaths: number;
	levels: ZephyrSysInitLevelReport[];
}

export interface ZephyrSysInitInput {
	buildDir: string;
	elfPath: string;
	devicetreeHeaderPath?: string;
}

const DEVICE_ORD_PREFIX = '__device_dts_ord_';
const DEVICE_INIT_OFFSET = 5;
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46];
const EI_CLASS = 4;
const EI_DATA = 5;
const ELFCLASS32 = 1;
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const ELFDATA2MSB = 2;
const SHT_SYMTAB = 2;
const SHT_DYNSYM = 11;
const STT_OBJECT = 1;
const STT_FUNC = 2;

interface ElfSection {
	index: number;
	name: string;
	type: number;
	addr: number;
	offset: number;
	size: number;
	link: number;
	entsize: number;
}

interface RawElfSection extends Omit<ElfSection, 'name'> {
	nameOffset: number;
}

interface ElfSymbol {
	name: string;
	value: number;
	size: number;
	shndx: number;
	type: number;
}

interface ElfObjectRecord {
	name: string;
	size: number;
	shndx: number;
}

const sysInitCache = new Map<string, { fingerprint: string; report: ZephyrSysInitReport }>();

export function readZephyrSysInitReport(input: ZephyrSysInitInput): ZephyrSysInitReport {
	const fingerprint = createFingerprint(input.elfPath, input.devicetreeHeaderPath);
	const cached = sysInitCache.get(input.elfPath);
	if (cached && cached.fingerprint === fingerprint) {
		return cached.report;
	}

	const parser = new ElfParser(input.elfPath);
	const ordinalPaths = parseOrdinalPaths(input.devicetreeHeaderPath);
	const symbols = parser.symbols;
	const objectsByAddr = new Map<number, ElfObjectRecord>();
	const objectAddrByName = new Map<string, number>();
	const initLevelAddr = new Map<SysInitLevel, number>();
	let initEnd = 0;

	for (const symbol of symbols) {
		if (symbol.name === '__init_end') {
			initEnd = symbol.value;
		}

		for (const level of SYS_INIT_LEVELS) {
			if (symbol.name === `__init_${level}_start`) {
				initLevelAddr.set(level, symbol.value);
			}
		}

		if (
			symbol.name.length > 0 &&
			symbol.size > 0 &&
			(symbol.type === STT_OBJECT || symbol.type === STT_FUNC)
		) {
			objectsByAddr.set(symbol.value, {
				name: symbol.name,
				size: symbol.size,
				shndx: symbol.shndx,
			});
			objectAddrByName.set(symbol.name, symbol.value);
		}
	}

	if (initLevelAddr.size !== SYS_INIT_LEVELS.length) {
		throw new Error(`Missing init level symbols in ${input.elfPath}`);
	}
	if (initEnd === 0) {
		throw new Error(`Missing __init_end symbol in ${input.elfPath}`);
	}

	const levels: ZephyrSysInitLevelReport[] = [];
	let totalEntries = 0;
	let totalDeviceEntries = 0;
	let mappedDevicePaths = 0;

	for (let levelIndex = 0; levelIndex < SYS_INIT_LEVELS.length; levelIndex++) {
		const level = SYS_INIT_LEVELS[levelIndex];
		const start = initLevelAddr.get(level)!;
		const stop = levelIndex + 1 === SYS_INIT_LEVELS.length
			? initEnd
			: initLevelAddr.get(SYS_INIT_LEVELS[levelIndex + 1])!;

		const entries: ZephyrSysInitEntry[] = [];
		let priority = 0;
		let addr = start;

		while (addr < stop) {
			const initObject = objectsByAddr.get(addr);
			if (!initObject) {
				throw new Error(`No init object found at ${formatHex(addr)} while parsing ${level}`);
			}

			const arg0Ptr = parser.readPointer(initObject.shndx, addr, 0);
			const arg1Ptr = parser.readPointer(initObject.shndx, addr, 1);
			let initFunction = objectName(arg0Ptr, objectsByAddr);
			const argumentSymbol = objectName(arg1Ptr, objectsByAddr);

			const deviceOrdinal = parseDeviceOrdinal(argumentSymbol);
			let devicePath: string | undefined;
			if (deviceOrdinal !== undefined) {
				const deviceAddr = objectAddrByName.get(argumentSymbol);
				if (deviceAddr !== undefined) {
					const deviceObject = objectsByAddr.get(deviceAddr);
					if (deviceObject) {
						const deviceInitPtr = parser.readPointer(deviceObject.shndx, deviceAddr, DEVICE_INIT_OFFSET);
						initFunction = objectName(deviceInitPtr, objectsByAddr);
					}
				}
				devicePath = ordinalPaths.get(deviceOrdinal);
				totalDeviceEntries++;
				if (devicePath) {
					mappedDevicePaths++;
				}
			}

			entries.push({
				level,
				priority,
				address: addr,
				addressHex: formatHex(addr),
				initObject: initObject.name,
				initFunction,
				argumentSymbol,
				call: `${initObject.name}: ${initFunction}(${argumentSymbol})`,
				kind: deviceOrdinal !== undefined ? 'device' : 'system',
				deviceOrdinal,
				devicePath,
			});

			totalEntries++;
			addr += initObject.size;
			priority++;
		}

		levels.push({ level, entries });
	}

	const report: ZephyrSysInitReport = {
		buildDir: input.buildDir,
		elfPath: input.elfPath,
		devicetreeHeaderPath: input.devicetreeHeaderPath && fs.existsSync(input.devicetreeHeaderPath)
			? input.devicetreeHeaderPath
			: undefined,
		totalEntries,
		totalDeviceEntries,
		mappedDevicePaths,
		levels,
	};

	sysInitCache.set(input.elfPath, { fingerprint, report });
	return report;
}

function createFingerprint(elfPath: string, headerPath?: string): string {
	const elfStat = fs.statSync(elfPath);
	const parts = [`${elfPath}:${elfStat.size}:${elfStat.mtimeMs}`];
	if (headerPath && fs.existsSync(headerPath)) {
		const headerStat = fs.statSync(headerPath);
		parts.push(`${headerPath}:${headerStat.size}:${headerStat.mtimeMs}`);
	}
	return parts.join('|');
}

function parseOrdinalPaths(headerPath?: string): Map<number, string> {
	const ordinalPaths = new Map<number, string>();
	if (!headerPath || !fs.existsSync(headerPath)) {
		return ordinalPaths;
	}

	const content = fs.readFileSync(headerPath, 'utf8');
	const lines = content.split(/\r?\n/);
	let inOrdinalBlock = false;

	for (const line of lines) {
		if (line.includes('Node dependency ordering (ordinal and path):')) {
			inOrdinalBlock = true;
			continue;
		}

		if (!inOrdinalBlock) {
			continue;
		}

		if (line.includes('Definitions derived from these nodes in dependency order are next')) {
			break;
		}

		const match = line.match(/^\s*\*\s+(\d+)\s+(\/.*)\s*$/);
		if (!match) {
			continue;
		}

		ordinalPaths.set(Number(match[1]), match[2].trim());
	}

	return ordinalPaths;
}

function parseDeviceOrdinal(symbolName: string): number | undefined {
	if (!symbolName.startsWith(DEVICE_ORD_PREFIX)) {
		return undefined;
	}

	const value = Number(symbolName.slice(DEVICE_ORD_PREFIX.length));
	return Number.isNaN(value) ? undefined : value;
}

function objectName(address: number, objectsByAddr: Map<number, ElfObjectRecord>): string {
	if (address === 0) {
		return 'NULL';
	}

	return objectsByAddr.get(address)?.name ?? `unknown@${formatHex(address)}`;
}

function formatHex(value: number): string {
	return `0x${value.toString(16)}`;
}

class ElfParser {
	public readonly symbols: ElfSymbol[];

	private readonly buffer: Buffer;
	private readonly is64Bit: boolean;
	private readonly littleEndian: boolean;
	private readonly pointerSize: number;
	private readonly sections: ElfSection[];

	constructor(filePath: string) {
		this.buffer = fs.readFileSync(filePath);
		assertElfMagic(this.buffer);

		const elfClass = this.buffer[EI_CLASS];
		if (elfClass === ELFCLASS32) {
			this.is64Bit = false;
			this.pointerSize = 4;
		} else if (elfClass === ELFCLASS64) {
			this.is64Bit = true;
			this.pointerSize = 8;
		} else {
			throw new Error(`Unsupported ELF class ${elfClass} in ${filePath}`);
		}

		const elfData = this.buffer[EI_DATA];
		if (elfData === ELFDATA2LSB) {
			this.littleEndian = true;
		} else if (elfData === ELFDATA2MSB) {
			this.littleEndian = false;
		} else {
			throw new Error(`Unsupported ELF endianness ${elfData} in ${filePath}`);
		}

		this.sections = this.parseSections();
		this.symbols = this.parseSymbols();
	}

	public readPointer(sectionIndex: number, address: number, pointerIndex: number): number {
		const section = this.sections[sectionIndex];
		if (!section) {
			throw new Error(`Missing ELF section ${sectionIndex}`);
		}

		const offsetInSection = address - section.addr;
		const byteOffset = section.offset + offsetInSection + pointerIndex * this.pointerSize;
		return this.readInteger(byteOffset, this.pointerSize as 4 | 8);
	}

	private parseSections(): ElfSection[] {
		const sectionHeaderOffset = this.readInteger(this.is64Bit ? 40 : 32, this.is64Bit ? 8 : 4);
		const sectionHeaderEntrySize = this.readInteger(this.is64Bit ? 58 : 46, 2);
		const sectionHeaderCount = this.readInteger(this.is64Bit ? 60 : 48, 2);
		const sectionNameStringTableIndex = this.readInteger(this.is64Bit ? 62 : 50, 2);
		const rawSections: RawElfSection[] = [];

		for (let index = 0; index < sectionHeaderCount; index++) {
			const base = sectionHeaderOffset + index * sectionHeaderEntrySize;
			const nameOffset = this.readInteger(base, 4);
			const type = this.readInteger(base + 4, 4);
			const addr = this.readInteger(base + (this.is64Bit ? 16 : 12), this.is64Bit ? 8 : 4);
			const offset = this.readInteger(base + (this.is64Bit ? 24 : 16), this.is64Bit ? 8 : 4);
			const size = this.readInteger(base + (this.is64Bit ? 32 : 20), this.is64Bit ? 8 : 4);
			const link = this.readInteger(base + (this.is64Bit ? 40 : 24), 4);
			const entsize = this.readInteger(base + (this.is64Bit ? 56 : 36), this.is64Bit ? 8 : 4);

			rawSections.push({
				index,
				nameOffset,
				type,
				addr,
				offset,
				size,
				link,
				entsize,
			});
		}

		const sectionNameTable = rawSections[sectionNameStringTableIndex];
		if (!sectionNameTable) {
			throw new Error('ELF section name string table is missing');
		}

		const stringTable = this.buffer.subarray(sectionNameTable.offset, sectionNameTable.offset + sectionNameTable.size);
		return rawSections.map(section => {
			const { nameOffset, ...rest } = section;
			return {
				...rest,
				name: readString(stringTable, nameOffset),
			};
		});
	}

	private parseSymbols(): ElfSymbol[] {
		const symbols: ElfSymbol[] = [];

		for (const section of this.sections) {
			if ((section.type !== SHT_SYMTAB && section.type !== SHT_DYNSYM) || section.entsize === 0) {
				continue;
			}

			const stringTable = this.sections[section.link];
			if (!stringTable) {
				continue;
			}

			const stringTableBuffer = this.buffer.subarray(stringTable.offset, stringTable.offset + stringTable.size);
			const entryCount = Math.floor(section.size / section.entsize);

			for (let index = 0; index < entryCount; index++) {
				const base = section.offset + index * section.entsize;
				const nameOffset = this.readInteger(base, 4);
				const info = this.is64Bit ? this.readInteger(base + 4, 1) : this.readInteger(base + 12, 1);
				const shndx = this.is64Bit ? this.readInteger(base + 6, 2) : this.readInteger(base + 14, 2);
				const value = this.is64Bit ? this.readInteger(base + 8, 8) : this.readInteger(base + 4, 4);
				const size = this.is64Bit ? this.readInteger(base + 16, 8) : this.readInteger(base + 8, 4);

				symbols.push({
					name: readString(stringTableBuffer, nameOffset),
					value,
					size,
					shndx,
					type: info & 0x0f,
				});
			}
		}

		return symbols;
	}

	private readInteger(offset: number, width: 1 | 2 | 4 | 8): number {
		if (offset < 0 || offset + width > this.buffer.length) {
			throw new Error(`ELF read outside file bounds at ${offset}`);
		}

		switch (width) {
			case 1:
				return this.buffer.readUInt8(offset);
			case 2:
				return this.littleEndian ? this.buffer.readUInt16LE(offset) : this.buffer.readUInt16BE(offset);
			case 4:
				return this.littleEndian ? this.buffer.readUInt32LE(offset) : this.buffer.readUInt32BE(offset);
			case 8:
				return Number(this.littleEndian ? this.buffer.readBigUInt64LE(offset) : this.buffer.readBigUInt64BE(offset));
			default:
				throw new Error(`Unsupported integer width ${width}`);
		}
	}
}

function assertElfMagic(buffer: Buffer): void {
	for (let index = 0; index < ELF_MAGIC.length; index++) {
		if (buffer[index] !== ELF_MAGIC[index]) {
			throw new Error('Not a valid ELF file');
		}
	}
}

function readString(buffer: Buffer, start: number): string {
	if (start < 0 || start >= buffer.length) {
		return '';
	}

	let end = start;
	while (end < buffer.length && buffer[end] !== 0) {
		end++;
	}

	return buffer.toString('utf8', start, end);
}
