import fs from 'fs';

// A focused DWARF reader that maps memory addresses to their source file, the
// way Zephyr's size_report does (via DW_AT_decl_file on subprogram/variable
// DIEs). It parses just enough of .debug_abbrev/.debug_info/.debug_line to
// build an address -> absolute-source-path map. DWARF 32-bit, versions 2-5.

interface Reader {
	buf: Buffer;
	pos: number;
}

interface AbbrevAttr {
	name: number;
	form: number;
	implicitConst?: number;
}

interface AbbrevDecl {
	tag: number;
	hasChildren: boolean;
	attrs: AbbrevAttr[];
}

type AbbrevTable = Map<number, AbbrevDecl>;

interface LineFiles {
	// Resolved absolute (or best-effort) path per file index, already normalized
	// to how the DIE's DW_AT_decl_file indexes it (version-aware).
	pathForIndex: (index: number) => string | undefined;
}

// DWARF constants (only the ones this reader needs).
const DW_TAG_compile_unit = 0x11;
const DW_TAG_subprogram = 0x2e;
const DW_TAG_variable = 0x34;

const DW_AT_low_pc = 0x11;
const DW_AT_high_pc = 0x12;
const DW_AT_location = 0x02;
const DW_AT_comp_dir = 0x1b;
const DW_AT_stmt_list = 0x10;
const DW_AT_decl_file = 0x3a;
const DW_AT_abstract_origin = 0x31;
const DW_AT_specification = 0x47;
const DW_AT_str_offsets_base = 0x72;
const DW_AT_addr_base = 0x73;

const DW_OP_addr = 0x03;

export interface DwarfAddressFile {
	// address -> absolute source file path (as encoded in DWARF, without the
	// symbol name component). Only directly-mapped DIEs are recorded.
	exact: Map<number, string>;
	// [low, high) ranges for subprograms, for range-based fallback matching.
	ranges: Array<{ low: number; high: number; path: string }>;
}

const cache = new Map<string, { fingerprint: string; result: DwarfAddressFile }>();

export function buildAddressFileMap(elfPath: string): DwarfAddressFile {
	const stat = fs.statSync(elfPath);
	const fingerprint = `${elfPath}:${stat.size}:${stat.mtimeMs}`;
	const cached = cache.get(elfPath);
	if (cached && cached.fingerprint === fingerprint) {
		return cached.result;
	}

	let result: DwarfAddressFile;
	try {
		result = parse(elfPath);
	} catch {
		result = { exact: new Map(), ranges: [] };
	}

	cache.set(elfPath, { fingerprint, result });
	return result;
}

function parse(elfPath: string): DwarfAddressFile {
	const buf = fs.readFileSync(elfPath);
	const elf = readElf(buf);
	const info = elf.sections.get('.debug_info');
	const abbrevSec = elf.sections.get('.debug_abbrev');
	const lineSec = elf.sections.get('.debug_line');
	if (!info || !abbrevSec) {
		return { exact: new Map(), ranges: [] };
	}

	const strSec = elf.sections.get('.debug_str');
	const lineStrSec = elf.sections.get('.debug_line_str');
	const strOffsetsSec = elf.sections.get('.debug_str_offsets');
	const addrSec = elf.sections.get('.debug_addr');

	const ctx: ParseCtx = {
		info,
		abbrev: abbrevSec,
		line: lineSec,
		str: strSec,
		lineStr: lineStrSec,
		strOffsets: strOffsetsSec,
		addr: addrSec,
		exact: new Map(),
		ranges: [],
	};

	const r: Reader = { buf: info, pos: 0 };
	while (r.pos < info.length) {
		const cuStart = r.pos;
		try {
			parseCompilationUnit(ctx, r, cuStart);
		} catch {
			break; // stop on the first malformed CU rather than throw everything away
		}
	}

	return { exact: ctx.exact, ranges: ctx.ranges };
}

interface ParseCtx {
	info: Buffer;
	abbrev: Buffer;
	line?: Buffer;
	str?: Buffer;
	lineStr?: Buffer;
	strOffsets?: Buffer;
	addr?: Buffer;
	exact: Map<number, string>;
	ranges: Array<{ low: number; high: number; path: string }>;
}

function parseCompilationUnit(ctx: ParseCtx, r: Reader, cuStart: number): void {
	let unitLength = readU32(r);
	let is64 = false;
	if (unitLength === 0xffffffff) {
		is64 = true;
		unitLength = Number(readU64(r));
	}
	const cuEnd = r.pos + unitLength;
	const offsetSize = is64 ? 8 : 4;

	const version = readU16(r);
	let addrSize: number;
	let abbrevOffset: number;
	if (version >= 5) {
		readU8(r); // unit_type
		addrSize = readU8(r);
		abbrevOffset = is64 ? Number(readU64(r)) : readU32(r);
	} else {
		abbrevOffset = is64 ? Number(readU64(r)) : readU32(r);
		addrSize = readU8(r);
	}

	const abbrevTable = parseAbbrev(ctx.abbrev, abbrevOffset);

	// First DIE must be the compile unit; read it to get comp_dir/stmt_list and
	// the string/addr bases, then walk the rest of the DIEs.
	const cu: CuState = {
		version,
		addrSize,
		offsetSize,
		is64,
		compDir: undefined,
		lineFiles: undefined,
		strOffsetsBase: is64 ? 16 : 8,
		addrBase: 8,
		offsetToPath: new Map(),
	};

	// Two-pass within a CU: first collect DIEs (offset -> parsed fields), then
	// resolve decl_file possibly via abstract_origin/specification.
	const dies: DieRecord[] = [];
	const byOffset = new Map<number, DieRecord>();

	// Depth tracking to consume children null-terminators.
	while (r.pos < cuEnd) {
		const dieOffset = r.pos;
		const code = readULEB(r);
		if (code === 0) {
			continue; // end-of-children marker
		}
		const decl = abbrevTable.get(code);
		if (!decl) {
			break;
		}

		const rec: DieRecord = { tag: decl.tag, offset: dieOffset };
		for (const attr of decl.attrs) {
			const value = readForm(ctx, cu, r, attr.form, attr.implicitConst, cuStart);
			switch (attr.name) {
				case DW_AT_low_pc: rec.lowPc = numFrom(value); break;
				case DW_AT_high_pc: rec.highPc = numFrom(value); rec.highPcForm = attr.form; break;
				case DW_AT_decl_file: rec.declFile = numFrom(value); break;
				case DW_AT_location: rec.location = value instanceof Uint8Array ? value : undefined; break;
				case DW_AT_abstract_origin: rec.originOffset = numFrom(value); break;
				case DW_AT_specification: rec.originOffset = numFrom(value); break;
				case DW_AT_comp_dir: if (rec.tag === DW_TAG_compile_unit) { cu.compDir = strFrom(value); } break;
				case DW_AT_stmt_list: if (rec.tag === DW_TAG_compile_unit) { rec.stmtList = numFrom(value); } break;
				case DW_AT_str_offsets_base: cu.strOffsetsBase = numFrom(value) ?? cu.strOffsetsBase; break;
				case DW_AT_addr_base: cu.addrBase = numFrom(value) ?? cu.addrBase; break;
				default: break;
			}
		}

		if (rec.tag === DW_TAG_compile_unit && rec.stmtList !== undefined && ctx.line) {
			cu.lineFiles = parseLineFiles(ctx, cu, rec.stmtList);
		}

		if (rec.tag === DW_TAG_subprogram || rec.tag === DW_TAG_variable) {
			dies.push(rec);
			byOffset.set(dieOffset - cuStart, rec);
		}
	}

	if (!cu.lineFiles) {
		return; // no file table means nothing we can resolve
	}

	for (const rec of dies) {
		let declFile = rec.declFile;
		let hops = 0;
		let ptr: DieRecord | undefined = rec;
		while (declFile === undefined && ptr && ptr.originOffset !== undefined && hops < 8) {
			ptr = byOffset.get(ptr.originOffset);
			declFile = ptr?.declFile;
			hops += 1;
		}
		if (declFile === undefined) {
			continue;
		}
		const path = cu.lineFiles.pathForIndex(declFile);
		if (!path) {
			continue;
		}

		if (rec.tag === DW_TAG_subprogram) {
			if (rec.lowPc === undefined || rec.lowPc === 0) {
				continue;
			}
			const high = resolveHighPc(rec);
			ctx.exact.set(rec.lowPc, path);
			if (high !== undefined && high > rec.lowPc) {
				ctx.ranges.push({ low: rec.lowPc, high, path });
			}
		} else {
			const addr = addressFromLocation(rec.location, cu.addrSize);
			if (addr !== undefined) {
				ctx.exact.set(addr, path);
			}
		}
	}
}

interface CuState {
	version: number;
	addrSize: number;
	offsetSize: number;
	is64: boolean;
	compDir?: string;
	lineFiles?: LineFiles;
	strOffsetsBase: number;
	addrBase: number;
	offsetToPath: Map<number, string>;
}

interface DieRecord {
	tag: number;
	offset: number;
	lowPc?: number;
	highPc?: number;
	highPcForm?: number;
	declFile?: number;
	location?: Uint8Array;
	originOffset?: number;
	stmtList?: number;
}

function resolveHighPc(rec: DieRecord): number | undefined {
	if (rec.highPc === undefined || rec.lowPc === undefined) {
		return undefined;
	}
	// DW_AT_high_pc is an address form (addr/addrx) or a constant offset.
	if (rec.highPcForm === 0x01 /* DW_FORM_addr */) {
		return rec.highPc;
	}
	return rec.lowPc + rec.highPc;
}

function addressFromLocation(location: Uint8Array | undefined, addrSize: number): number | undefined {
	if (!location || location.length < 1 + addrSize || location[0] !== DW_OP_addr) {
		return undefined;
	}
	let addr = 0;
	for (let i = 0; i < addrSize; i += 1) {
		addr += location[1 + i] * 2 ** (8 * i);
	}
	return addr;
}

// ---- Abbrev ---------------------------------------------------------------

const abbrevCache = new WeakMap<Buffer, Map<number, AbbrevTable>>();

function parseAbbrev(sec: Buffer, offset: number): AbbrevTable {
	let perSection = abbrevCache.get(sec);
	if (!perSection) {
		perSection = new Map();
		abbrevCache.set(sec, perSection);
	}
	const existing = perSection.get(offset);
	if (existing) {
		return existing;
	}

	const table: AbbrevTable = new Map();
	const r: Reader = { buf: sec, pos: offset };
	while (r.pos < sec.length) {
		const code = readULEB(r);
		if (code === 0) {
			break;
		}
		const tag = readULEB(r);
		const hasChildren = readU8(r) !== 0;
		const attrs: AbbrevAttr[] = [];
		for (;;) {
			const name = readULEB(r);
			const form = readULEB(r);
			let implicitConst: number | undefined;
			if (form === 0x21 /* DW_FORM_implicit_const */) {
				implicitConst = readSLEB(r);
			}
			if (name === 0 && form === 0) {
				break;
			}
			attrs.push({ name, form, implicitConst });
		}
		table.set(code, { tag, hasChildren, attrs });
	}

	perSection.set(offset, table);
	return table;
}

// ---- Line program file table ----------------------------------------------

function parseLineFiles(ctx: ParseCtx, cu: CuState, stmtOffset: number): LineFiles | undefined {
	const sec = ctx.line;
	if (!sec) {
		return undefined;
	}
	const r: Reader = { buf: sec, pos: stmtOffset };

	let unitLength = readU32(r);
	let is64 = false;
	if (unitLength === 0xffffffff) {
		is64 = true;
		unitLength = Number(readU64(r));
	}
	const version = readU16(r);
	if (version >= 5) {
		readU8(r); // address_size
		readU8(r); // segment_selector_size
	}
	// header_length
	if (is64) {
		readU64(r);
	} else {
		readU32(r);
	}
	readU8(r); // minimum_instruction_length
	if (version >= 4) {
		readU8(r); // maximum_operations_per_instruction
	}
	readU8(r); // default_is_stmt
	readS8(r); // line_base
	readU8(r); // line_range
	readU8(r); // opcode_base
	const opcodeBase = sec[r.pos - 1];
	for (let i = 1; i < opcodeBase; i += 1) {
		readULEB(r); // standard_opcode_lengths
	}

	if (version >= 5) {
		return parseLineFilesV5(ctx, cu, r, is64);
	}
	return parseLineFilesLegacy(cu, r);
}

function parseLineFilesLegacy(cu: CuState, r: Reader): LineFiles {
	// include_directories: sequence of null-terminated strings, ended by empty.
	const dirs: string[] = [];
	for (;;) {
		const s = readCString(r);
		if (s.length === 0) {
			break;
		}
		dirs.push(s);
	}
	// file_names: name, dir_index (uleb), mtime (uleb), size (uleb); ended by empty name.
	const files: Array<{ name: string; dir: number }> = [];
	for (;;) {
		const name = readCString(r);
		if (name.length === 0) {
			break;
		}
		const dir = readULEB(r);
		readULEB(r); // mtime
		readULEB(r); // size
		files.push({ name, dir });
	}

	return {
		pathForIndex: (index: number) => {
			// DWARF <= 4: DW_AT_decl_file is 1-based into file_names.
			const fe = files[index - 1];
			if (!fe) {
				return undefined;
			}
			return resolvePath(cu, dirs, fe.dir, fe.name, false);
		},
	};
}

function parseLineFilesV5(ctx: ParseCtx, cu: CuState, r: Reader, is64: boolean): LineFiles {
	const dirs = readV5Entries(ctx, cu, r, is64);
	const files = readV5Entries(ctx, cu, r, is64);

	return {
		pathForIndex: (index: number) => {
			// DWARF 5: DW_AT_decl_file is 0-based into file_names.
			const fe = files[index];
			if (!fe) {
				return undefined;
			}
			return resolvePath(cu, dirs.map(d => d.path), fe.dir, fe.path, true);
		},
	};
}

function readV5Entries(ctx: ParseCtx, cu: CuState, r: Reader, is64: boolean): Array<{ path: string; dir: number }> {
	const formatCount = readU8(r);
	const formats: Array<{ contentType: number; form: number }> = [];
	for (let i = 0; i < formatCount; i += 1) {
		formats.push({ contentType: readULEB(r), form: readULEB(r) });
	}
	const count = readULEB(r);
	const entries: Array<{ path: string; dir: number }> = [];
	for (let i = 0; i < count; i += 1) {
		let path = '';
		let dir = 0;
		for (const fmt of formats) {
			const value = readForm(ctx, { ...cu, is64, offsetSize: is64 ? 8 : 4 } as CuState, r, fmt.form, undefined, 0);
			if (fmt.contentType === 0x1 /* DW_LNCT_path */) {
				path = strFrom(value) ?? '';
			} else if (fmt.contentType === 0x2 /* DW_LNCT_directory_index */) {
				dir = numFrom(value) ?? 0;
			}
		}
		entries.push({ path, dir });
	}
	return entries;
}

function resolvePath(cu: CuState, dirs: string[], dirIndex: number, name: string, isV5: boolean): string {
	if (isAbsolute(name)) {
		return name;
	}
	// Legacy: dir_index 0 => file has no directory (kept relative like size_report).
	// V5: dir_index 0 is the compilation directory.
	let directory: string | undefined;
	if (isV5) {
		directory = dirs[dirIndex];
	} else if (dirIndex > 0) {
		directory = dirs[dirIndex - 1];
	}
	if (!directory) {
		return name;
	}
	if (isAbsolute(directory)) {
		return joinPath(directory, name);
	}
	if (cu.compDir) {
		return joinPath(joinPath(cu.compDir, directory), name);
	}
	return joinPath(directory, name);
}

// ---- Form reader ----------------------------------------------------------

function readForm(ctx: ParseCtx, cu: CuState, r: Reader, form: number, implicitConst: number | undefined, cuStart: number): unknown {
	const offsetSize = cu.offsetSize;
	switch (form) {
		case 0x01: return readAddr(r, cu.addrSize); // addr
		case 0x03: return readBlock(r, readU16(r)); // block2
		case 0x04: return readBlock(r, readU32(r)); // block4
		case 0x05: return readU16(r); // data2
		case 0x06: return readU32(r); // data4
		case 0x07: return Number(readU64(r)); // data8
		case 0x08: return readCString(r); // string
		case 0x09: return readBlock(r, readULEB(r)); // block
		case 0x0a: return readBlock(r, readU8(r)); // block1
		case 0x0b: return readU8(r); // data1
		case 0x0c: return readU8(r); // flag
		case 0x0d: return readSLEB(r); // sdata
		case 0x0e: return readStrp(ctx.str, readOffset(r, offsetSize)); // strp
		case 0x0f: return readULEB(r); // udata
		case 0x10: return readOffset(r, offsetSize); // ref_addr
		case 0x11: return readU8(r) + cuStart; // ref1
		case 0x12: return readU16(r) + cuStart; // ref2
		case 0x13: return readU32(r) + cuStart; // ref4
		case 0x14: return Number(readU64(r)) + cuStart; // ref8
		case 0x15: return readULEB(r) + cuStart; // ref_udata
		case 0x16: return readForm(ctx, cu, r, readULEB(r), undefined, cuStart); // indirect
		case 0x17: return readOffset(r, offsetSize); // sec_offset
		case 0x18: return readBlock(r, readULEB(r)); // exprloc
		case 0x19: return 1; // flag_present
		case 0x1a: return readStrx(ctx, cu, readULEB(r)); // strx
		case 0x1b: return readAddrx(ctx, cu, readULEB(r)); // addrx
		case 0x1c: return readU32(r); // ref_sup4
		case 0x1d: return readOffset(r, offsetSize); // strp_sup
		case 0x1e: return readBlock(r, 16); // data16
		case 0x1f: return readStrp(ctx.lineStr, readOffset(r, offsetSize)); // line_strp
		case 0x20: return Number(readU64(r)); // ref_sig8
		case 0x21: return implicitConst; // implicit_const
		case 0x22: return readULEB(r); // loclistx
		case 0x23: return readULEB(r); // rnglistx
		case 0x24: return Number(readU64(r)); // ref_sup8
		case 0x25: return readStrx(ctx, cu, readU8(r)); // strx1
		case 0x26: return readStrx(ctx, cu, readU16(r)); // strx2
		case 0x27: return readStrx(ctx, cu, readU24(r)); // strx3
		case 0x28: return readStrx(ctx, cu, readU32(r)); // strx4
		case 0x29: return readAddrx(ctx, cu, readU8(r)); // addrx1
		case 0x2a: return readAddrx(ctx, cu, readU16(r)); // addrx2
		case 0x2b: return readAddrx(ctx, cu, readU24(r)); // addrx3
		case 0x2c: return readAddrx(ctx, cu, readU32(r)); // addrx4
		default:
			throw new Error(`Unknown DWARF form 0x${form.toString(16)}`);
	}
}

function readStrx(ctx: ParseCtx, cu: CuState, index: number): string | undefined {
	if (!ctx.strOffsets || !ctx.str) {
		return undefined;
	}
	const entryPos = cu.strOffsetsBase + index * cu.offsetSize;
	if (entryPos + cu.offsetSize > ctx.strOffsets.length) {
		return undefined;
	}
	const strOffset = cu.offsetSize === 8
		? Number(ctx.strOffsets.readBigUInt64LE(entryPos))
		: ctx.strOffsets.readUInt32LE(entryPos);
	return readStrp(ctx.str, strOffset);
}

function readAddrx(ctx: ParseCtx, cu: CuState, index: number): number | undefined {
	if (!ctx.addr) {
		return undefined;
	}
	const entryPos = cu.addrBase + index * cu.addrSize;
	if (entryPos + cu.addrSize > ctx.addr.length) {
		return undefined;
	}
	let value = 0;
	for (let i = 0; i < cu.addrSize; i += 1) {
		value += ctx.addr[entryPos + i] * 2 ** (8 * i);
	}
	return value;
}

// ---- Value helpers --------------------------------------------------------

function numFrom(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined;
}

function strFrom(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function readAddr(r: Reader, size: number): number {
	let value = 0;
	for (let i = 0; i < size; i += 1) {
		value += r.buf[r.pos + i] * 2 ** (8 * i);
	}
	r.pos += size;
	return value;
}

function readBlock(r: Reader, length: number): Uint8Array {
	const slice = r.buf.subarray(r.pos, r.pos + length);
	r.pos += length;
	return slice;
}

function readStrp(sec: Buffer | undefined, offset: number): string | undefined {
	if (!sec || offset >= sec.length) {
		return undefined;
	}
	let end = offset;
	while (end < sec.length && sec[end] !== 0) {
		end += 1;
	}
	return sec.toString('utf8', offset, end);
}

function readOffset(r: Reader, offsetSize: number): number {
	return offsetSize === 8 ? Number(readU64(r)) : readU32(r);
}

// ---- Primitive readers ----------------------------------------------------

function readU8(r: Reader): number {
	return r.buf[r.pos++];
}

function readS8(r: Reader): number {
	const v = r.buf.readInt8(r.pos);
	r.pos += 1;
	return v;
}

function readU16(r: Reader): number {
	const v = r.buf.readUInt16LE(r.pos);
	r.pos += 2;
	return v;
}

function readU24(r: Reader): number {
	const v = r.buf[r.pos] + (r.buf[r.pos + 1] << 8) + (r.buf[r.pos + 2] << 16);
	r.pos += 3;
	return v;
}

function readU32(r: Reader): number {
	const v = r.buf.readUInt32LE(r.pos);
	r.pos += 4;
	return v;
}

function readU64(r: Reader): bigint {
	const v = r.buf.readBigUInt64LE(r.pos);
	r.pos += 8;
	return v;
}

function readULEB(r: Reader): number {
	let result = 0;
	let shift = 0;
	for (;;) {
		const byte = r.buf[r.pos++];
		result += (byte & 0x7f) * 2 ** shift;
		if ((byte & 0x80) === 0) {
			break;
		}
		shift += 7;
	}
	return result;
}

function readSLEB(r: Reader): number {
	let result = 0;
	let shift = 0;
	let byte = 0;
	do {
		byte = r.buf[r.pos++];
		result += (byte & 0x7f) * 2 ** shift;
		shift += 7;
	} while (byte & 0x80);
	if (shift < 53 && (byte & 0x40)) {
		result -= 2 ** shift;
	}
	return result;
}

function readCString(r: Reader): string {
	const start = r.pos;
	while (r.pos < r.buf.length && r.buf[r.pos] !== 0) {
		r.pos += 1;
	}
	const s = r.buf.toString('utf8', start, r.pos);
	r.pos += 1; // skip null
	return s;
}

// ---- Minimal ELF section reader -------------------------------------------

interface ElfSections {
	sections: Map<string, Buffer>;
}

function readElf(buf: Buffer): ElfSections {
	if (buf.length < 64 || buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
		throw new Error('Not an ELF file');
	}
	const is64 = buf[4] === 2;
	const little = buf[5] === 1;
	if (!little) {
		throw new Error('Big-endian ELF not supported');
	}

	const shoff = is64 ? Number(buf.readBigUInt64LE(0x28)) : buf.readUInt32LE(0x20);
	const shentsize = buf.readUInt16LE(is64 ? 0x3a : 0x2e);
	const shnum = buf.readUInt16LE(is64 ? 0x3c : 0x30);
	const shstrndx = buf.readUInt16LE(is64 ? 0x3e : 0x32);

	const readSh = (index: number) => {
		const base = shoff + index * shentsize;
		if (is64) {
			return {
				nameOff: buf.readUInt32LE(base),
				offset: Number(buf.readBigUInt64LE(base + 0x18)),
				size: Number(buf.readBigUInt64LE(base + 0x20)),
			};
		}
		return {
			nameOff: buf.readUInt32LE(base),
			offset: buf.readUInt32LE(base + 0x10),
			size: buf.readUInt32LE(base + 0x14),
		};
	};

	const strHeader = readSh(shstrndx);
	const sections = new Map<string, Buffer>();
	for (let i = 0; i < shnum; i += 1) {
		const sh = readSh(i);
		let end = strHeader.offset + sh.nameOff;
		while (end < buf.length && buf[end] !== 0) {
			end += 1;
		}
		const name = buf.toString('utf8', strHeader.offset + sh.nameOff, end);
		if (name.startsWith('.debug_')) {
			sections.set(name, buf.subarray(sh.offset, sh.offset + sh.size));
		}
	}
	return { sections };
}

// ---- Path helpers (POSIX-style, DWARF paths are '/'-separated) -------------

function isAbsolute(p: string): boolean {
	return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

function joinPath(a: string, b: string): string {
	if (a.endsWith('/')) {
		return a + b;
	}
	return a + '/' + b;
}
