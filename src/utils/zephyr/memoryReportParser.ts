import fs from 'fs';

const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46];
const EI_CLASS = 4;
const EI_DATA = 5;
const ELFCLASS32 = 1;
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const ELFDATA2MSB = 2;

const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_NOBITS = 8;
const SHT_DYNSYM = 11;

const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const SHF_EXEC = 0x4;
const SHF_TLS = 0x400;
const SHF_ALLOC_EXEC = SHF_ALLOC | SHF_EXEC;
const SHF_WRITE_ALLOC = SHF_WRITE | SHF_ALLOC;

const STT_OBJECT = 1;
const STT_FUNC = 2;

const SECTION_GROUP_PARENTS = ['.text', '.rodata', '.data', '.bss'];

export type ZephyrMemoryCategory = 'text' | 'rodata' | 'data' | 'bss' | 'tls' | 'other';

export interface ZephyrMemorySymbol {
	name: string;
	address: number;
	addressHex: string;
	size: number;
	sectionName: string;
}

export interface ZephyrMemorySection {
	name: string;
	address: number;
	addressHex: string;
	size: number;
	category: ZephyrMemoryCategory;
	symbols: ZephyrMemorySymbol[];
	symbolsBytes: number;
}

export interface ZephyrMemoryBucketReport {
	totalBytes: number;
	sections: ZephyrMemorySection[];
}

export interface ZephyrMemoryReport {
	elfPath: string;
	xip: boolean;
	rom: ZephyrMemoryBucketReport;
	ram: ZephyrMemoryBucketReport;
}

interface ElfSection {
	index: number;
	name: string;
	type: number;
	flags: number;
	address: number;
	offset: number;
	size: number;
	link: number;
	entsize: number;
}

interface ElfSymbol {
	name: string;
	value: number;
	size: number;
	shndx: number;
	type: number;
}

const memoryCache = new Map<string, { fingerprint: string; report: ZephyrMemoryReport }>();

export function readZephyrMemoryReport(elfPath: string): ZephyrMemoryReport {
	const fingerprint = createFingerprint(elfPath);
	const cached = memoryCache.get(elfPath);
	if (cached && cached.fingerprint === fingerprint) {
		return cached.report;
	}

	const report = parseElfToMemoryReport(elfPath);
	memoryCache.set(elfPath, { fingerprint, report });
	return report;
}

function createFingerprint(elfPath: string): string {
	const stat = fs.statSync(elfPath);
	return `${elfPath}:${stat.size}:${stat.mtimeMs}`;
}

function parseElfToMemoryReport(elfPath: string): ZephyrMemoryReport {
	const buffer = fs.readFileSync(elfPath);
	assertElfMagic(buffer);

	const elfClass = buffer[EI_CLASS];
	if (elfClass !== ELFCLASS32 && elfClass !== ELFCLASS64) {
		throw new Error(`Unsupported ELF class ${elfClass} in ${elfPath}`);
	}
	const is64Bit = elfClass === ELFCLASS64;

	const elfData = buffer[EI_DATA];
	if (elfData !== ELFDATA2LSB && elfData !== ELFDATA2MSB) {
		throw new Error(`Unsupported ELF endianness ${elfData} in ${elfPath}`);
	}
	const littleEndian = elfData === ELFDATA2LSB;

	const sections = parseSections(buffer, is64Bit, littleEndian);
	const symbols = parseSymbols(buffer, sections, is64Bit, littleEndian);
	const xip = symbols.some(sym => sym.name === 'CONFIG_XIP');

	// Bucket symbols by their section index, deduping by address so aliased
	// symbols (same address, same size — e.g. weak/strong pairs) don't
	// double-count bytes and inflate the per-symbol and unattributed %.
	const symbolsBySection = new Map<number, ZephyrMemorySymbol[]>();
	const seenAddrBySection = new Map<number, Set<number>>();
	for (const sym of symbols) {
		if (sym.size === 0) {
			continue;
		}
		if (sym.type !== STT_OBJECT && sym.type !== STT_FUNC) {
			continue;
		}
		const section = sections[sym.shndx];
		if (!section) {
			continue;
		}
		let seen = seenAddrBySection.get(sym.shndx);
		if (!seen) {
			seen = new Set();
			seenAddrBySection.set(sym.shndx, seen);
		}
		if (seen.has(sym.value)) {
			continue;
		}
		seen.add(sym.value);

		const list = symbolsBySection.get(sym.shndx) ?? [];
		list.push({
			name: sym.name,
			address: sym.value,
			addressHex: formatHex(sym.value),
			size: sym.size,
			sectionName: section.name,
		});
		symbolsBySection.set(sym.shndx, list);
	}

	interface WorkingSection {
		name: string;
		address: number;
		size: number;
		category: ZephyrMemoryCategory;
		symbols: ZephyrMemorySymbol[];
	}

	const aggRom = new Map<string, WorkingSection>();
	const aggRam = new Map<string, WorkingSection>();
	let romTotal = 0;
	let ramTotal = 0;

	for (let i = 0; i < sections.length; i++) {
		const section = sections[i];
		if (section.size === 0) {
			continue;
		}
		const cls = classifySection(section, xip);
		if (!cls.inRom && !cls.inRam) {
			continue;
		}

		const groupName = getSectionGroup(section.name);
		const sectionSymbols = symbolsBySection.get(i) ?? [];

		const addToBucket = (map: Map<string, WorkingSection>): void => {
			let existing = map.get(groupName);
			if (!existing) {
				existing = {
					name: groupName,
					address: section.address,
					size: 0,
					category: cls.category,
					symbols: [],
				};
				map.set(groupName, existing);
			} else if (section.address > 0 && (existing.address === 0 || section.address < existing.address)) {
				existing.address = section.address;
			}
			existing.size += section.size;
			for (const sym of sectionSymbols) {
				existing.symbols.push(sym);
			}
		};

		if (cls.inRom) {
			addToBucket(aggRom);
			romTotal += section.size;
		}
		if (cls.inRam) {
			addToBucket(aggRam);
			ramTotal += section.size;
		}
	}

	const finalize = (agg: Map<string, WorkingSection>): ZephyrMemorySection[] => {
		const result: ZephyrMemorySection[] = [];
		for (const ws of agg.values()) {
			const sortedSymbols = ws.symbols.slice().sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
			const symbolsBytes = sortedSymbols.reduce((sum, s) => sum + s.size, 0);
			result.push({
				name: ws.name,
				address: ws.address,
				addressHex: formatHex(ws.address),
				size: ws.size,
				category: ws.category,
				symbols: sortedSymbols,
				symbolsBytes,
			});
		}
		result.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
		return result;
	};

	return {
		elfPath,
		xip,
		rom: { totalBytes: romTotal, sections: finalize(aggRom) },
		ram: { totalBytes: ramTotal, sections: finalize(aggRam) },
	};
}

function getSectionGroup(name: string): string {
	for (const parent of SECTION_GROUP_PARENTS) {
		if (name === parent || name.startsWith(parent + '.')) {
			return parent;
		}
	}
	return name;
}

function classifySection(
	section: ElfSection,
	xip: boolean,
): { inRom: boolean; inRam: boolean; category: ZephyrMemoryCategory } {
	const { flags, type } = section;

	if (type === SHT_NOBITS) {
		return {
			inRom: false,
			inRam: true,
			category: (flags & SHF_TLS) ? 'tls' : 'bss',
		};
	}

	if (type === SHT_PROGBITS) {
		if ((flags & SHF_ALLOC_EXEC) === SHF_ALLOC_EXEC) {
			return { inRom: true, inRam: false, category: 'text' };
		}
		if ((flags & SHF_WRITE_ALLOC) === SHF_WRITE_ALLOC) {
			return {
				inRom: xip,
				inRam: true,
				category: (flags & SHF_TLS) ? 'tls' : 'data',
			};
		}
		if ((flags & SHF_ALLOC) === SHF_ALLOC) {
			return { inRom: true, inRam: false, category: 'rodata' };
		}
	}

	return { inRom: false, inRam: false, category: 'other' };
}

function parseSections(buffer: Buffer, is64Bit: boolean, littleEndian: boolean): ElfSection[] {
	const shoffOffset = is64Bit ? 40 : 32;
	const shentsizeOffset = is64Bit ? 58 : 46;
	const shnumOffset = is64Bit ? 60 : 48;
	const shstrndxOffset = is64Bit ? 62 : 50;
	const addrWidth = is64Bit ? 8 : 4;

	const sectionHeaderOffset = readInt(buffer, shoffOffset, addrWidth, littleEndian);
	const sectionHeaderEntrySize = readInt(buffer, shentsizeOffset, 2, littleEndian);
	const sectionHeaderCount = readInt(buffer, shnumOffset, 2, littleEndian);
	const shstrndx = readInt(buffer, shstrndxOffset, 2, littleEndian);

	interface RawSection extends Omit<ElfSection, 'name'> {
		nameOffset: number;
	}

	const rawSections: RawSection[] = [];
	for (let i = 0; i < sectionHeaderCount; i++) {
		const base = sectionHeaderOffset + i * sectionHeaderEntrySize;
		const nameOffset = readInt(buffer, base, 4, littleEndian);
		const type = readInt(buffer, base + 4, 4, littleEndian);
		const flags = readInt(buffer, base + 8, addrWidth, littleEndian);
		const address = readInt(buffer, base + (is64Bit ? 16 : 12), addrWidth, littleEndian);
		const offset = readInt(buffer, base + (is64Bit ? 24 : 16), addrWidth, littleEndian);
		const size = readInt(buffer, base + (is64Bit ? 32 : 20), addrWidth, littleEndian);
		const link = readInt(buffer, base + (is64Bit ? 40 : 24), 4, littleEndian);
		const entsize = readInt(buffer, base + (is64Bit ? 56 : 36), addrWidth, littleEndian);

		rawSections.push({
			index: i,
			nameOffset,
			type,
			flags,
			address,
			offset,
			size,
			link,
			entsize,
		});
	}

	const nameTable = rawSections[shstrndx];
	if (!nameTable) {
		throw new Error('ELF section name string table is missing');
	}
	const strTable = buffer.subarray(nameTable.offset, nameTable.offset + nameTable.size);

	return rawSections.map(sec => {
		const { nameOffset, ...rest } = sec;
		return { ...rest, name: readString(strTable, nameOffset) };
	});
}

function parseSymbols(buffer: Buffer, sections: ElfSection[], is64Bit: boolean, littleEndian: boolean): ElfSymbol[] {
	const symbols: ElfSymbol[] = [];

	for (const section of sections) {
		if ((section.type !== SHT_SYMTAB && section.type !== SHT_DYNSYM) || section.entsize === 0) {
			continue;
		}

		const strTableSection = sections[section.link];
		if (!strTableSection) {
			continue;
		}
		const strTable = buffer.subarray(strTableSection.offset, strTableSection.offset + strTableSection.size);

		const entryCount = Math.floor(section.size / section.entsize);
		for (let i = 0; i < entryCount; i++) {
			const base = section.offset + i * section.entsize;
			const nameOffset = readInt(buffer, base, 4, littleEndian);
			const info = is64Bit ? readInt(buffer, base + 4, 1, littleEndian) : readInt(buffer, base + 12, 1, littleEndian);
			const shndx = is64Bit ? readInt(buffer, base + 6, 2, littleEndian) : readInt(buffer, base + 14, 2, littleEndian);
			const value = is64Bit ? readInt(buffer, base + 8, 8, littleEndian) : readInt(buffer, base + 4, 4, littleEndian);
			const size = is64Bit ? readInt(buffer, base + 16, 8, littleEndian) : readInt(buffer, base + 8, 4, littleEndian);

			symbols.push({
				name: readString(strTable, nameOffset),
				value,
				size,
				shndx,
				type: info & 0x0f,
			});
		}
	}

	return symbols;
}

function readInt(buffer: Buffer, offset: number, width: number, littleEndian: boolean): number {
	if (offset < 0 || offset + width > buffer.length) {
		throw new Error(`ELF read outside file bounds at ${offset}`);
	}

	switch (width) {
		case 1:
			return buffer.readUInt8(offset);
		case 2:
			return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
		case 4:
			return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
		case 8:
			return Number(littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset));
		default:
			throw new Error(`Unsupported integer width ${width}`);
	}
}

function assertElfMagic(buffer: Buffer): void {
	for (let i = 0; i < ELF_MAGIC.length; i++) {
		if (buffer[i] !== ELF_MAGIC[i]) {
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

function formatHex(value: number): string {
	return `0x${value.toString(16)}`;
}
