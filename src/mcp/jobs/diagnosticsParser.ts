// Turns raw west/ninja/CMake output into structured diagnostics.
//
// This is the whole value of a build tool call: an agent that gets a file, a
// line and a message fixes the code, while an agent that gets 4,000 lines of
// log guesses. Direct workbench builds do not populate the Problems panel
// (`buildDirectTask` creates tasks without problem matchers), so this parser is
// the only structured source for both the agent and any future
// DiagnosticCollection.
//
// vscode-free on purpose: unit tested with fixtures and reusable in the bridge.

import * as path from 'path';

export type DiagnosticSeverity = 'error' | 'warning' | 'note';
export type DiagnosticTool = 'gcc' | 'clang' | 'ld' | 'cmake' | 'kconfig' | 'devicetree' | 'west' | 'ninja';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  tool: DiagnosticTool;
  file?: string;
  line?: number;
  column?: number;
  message: string;
  /** Compiler flag that produced a warning, for example -Wunused-variable. */
  code?: string;
  /** Compiler notes that followed this diagnostic. */
  related?: Diagnostic[];
}

export interface MemoryRegion {
  region: string;
  used_bytes: number;
  total_bytes: number;
  percent: number;
}

export interface ParsedBuildOutput {
  diagnostics: Diagnostic[];
  memory: MemoryRegion[];
  errors: number;
  warnings: number;
  /** True when diagnostics were dropped to respect the cap. */
  truncated: boolean;
}

// file:line:col: severity: message [-Wflag]
const COMPILER = /^(.+?):(\d+)(?::(\d+))?:\s*(fatal error|error|warning|note):\s*(.*?)\s*(?:\[(-W[^\]]+)\])?$/;
// dtc reports a range: file:line.col-line.col message
const DTC = /^(?:Error:\s*)?(.+?\.(?:dts|dtsi|overlay)):(\d+)\.(\d+)(?:-[\d.]+)?\s+(.*)$/;
const CMAKE = /^CMake (Error|Warning)(?: \(dev\))? at (.+?):(\d+) \((.+?)\):\s*$/;
const LD_REGION = /region [`'"]?([A-Za-z0-9_]+)[`'"]? overflowed by (\d+) bytes?/;
// ld, ld.bfd or ld.lld, with the .exe of a Windows toolchain.
const LD_GENERIC = /(?:^|[\/\\])ld(?:\.bfd|\.lld)?(?:\.exe)?:\s*(.*)$/;
const UNDEFINED_REF = /undefined reference to [`'"](.+?)[`'"]/;
// `file:line:`, `file:line:(.text+0x8):` or `file:(.text+0x8):` in front of a linker message.
const LD_LOCATED = /^(.+?):(?:(\d+)(?::\([^)]*\))?|\([^)]*\)):\s*((?:multiple definition of|undefined reference to) .*)$/;
// A link-time warning or error with a location: `file:line:(.text+0x8): warning: ...`.
const LD_SECTION = /^(.+?):(\d+):\([^)]*\):\s*(warning|error):\s*(.*)$/;
// `ld: main.o: in function `main':`, context for the line that follows.
const LD_CONTEXT = /:\s*in function [`'"].*[`'"]:\s*$/;
// Printed by Zephyr at the start of every image's CMake run, sysbuild included.
const CMAKE_APPLICATION = /^-- Application:\s*(.+?)\s*$/;
const KCONFIG_ASSIGNED = /^warning:\s+(\w+)\s+\(defined at (.+?):(\d+)\)\s+(was assigned the value.*)$/;
const KCONFIG_ABORT = /^error:\s*(Aborting due to Kconfig warnings.*)$/;
const DEVICETREE = /^devicetree error:\s*(.*)$/;
const WEST_FATAL = /^(?:FATAL ERROR|ERROR):\s*(.*)$/;
const NINJA_FAILED = /^FAILED:\s*(.*)$/;
const NINJA_STOPPED = /^ninja: build stopped:\s*(.*)$/;
const MEMORY_HEADER = /^Memory region\s+Used Size\s+Region Size\s+%age Used/;
const MEMORY_ROW = /^\s*(\S+):\s+([\d.]+)\s*([KMG]?B)\s+([\d.]+)\s*([KMG]?B)\s+([\d.]+)%/;
// Noise that would otherwise be read as a diagnostic location.
const INCLUDED_FROM = /^\s*(?:In file included from|\s+from)\s/;

const UNIT: Record<string, number> = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };

function toBytes(value: string, unit: string): number {
  return Math.round(parseFloat(value) * (UNIT[unit] ?? 1));
}

/** Make a compiler path absolute against the build directory when it is relative. */
function resolveFile(file: string, buildDir?: string): string {
  if (!buildDir || path.isAbsolute(file)) {
    return file;
  }
  return path.resolve(buildDir, file);
}

function dedupeKey(d: Diagnostic): string {
  return [d.tool, d.severity, d.file ?? '', d.line ?? '', d.column ?? '', d.message].join('|');
}

export interface ParseOptions {
  /** Resolve relative compiler, dtc and linker paths against this directory, where ninja runs. */
  buildDir?: string;
  /** The top CMake source directory, which CMake's own relative paths are based on. */
  sourceDir?: string;
  /** ZEPHYR_BASE, which Kconfig's relative "defined at" paths are based on. */
  zephyrBase?: string;
  /** Hard cap on returned diagnostics. Errors are kept before warnings. */
  maxDiagnostics?: number;
}

/**
 * Parse a full build log. Errors are returned before warnings, because a model
 * reads the first item and an error is always more actionable than a warning.
 */
export function parseBuildOutput(text: string, options: ParseOptions = {}): ParsedBuildOutput {
  const max = options.maxDiagnostics ?? 20;
  const collected: Diagnostic[] = [];
  const memory: MemoryRegion[] = [];
  let inMemoryTable = false;
  let cmakePending: Diagnostic | undefined;
  // CMake prints paths relative to the source directory of the run printing
  // them. With sysbuild each image runs CMake from its own source directory,
  // announced by "-- Application:", so the base follows those lines.
  let cmakeBase = options.sourceDir ?? options.buildDir;

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trimEnd();

    // A CMake message body is the indented block that follows its header.
    if (cmakePending) {
      if (line.startsWith('  ') && line.trim().length > 0) {
        const body = line.trim();
        cmakePending.message = cmakePending.message ? `${cmakePending.message} ${body}` : body;
        const dt = DEVICETREE.exec(body);
        if (dt) {
          cmakePending.tool = 'devicetree';
          cmakePending.message = dt[1];
        }
        continue;
      }
      collected.push(cmakePending);
      cmakePending = undefined;
    }

    if (MEMORY_HEADER.test(line)) {
      inMemoryTable = true;
      continue;
    }
    if (inMemoryTable) {
      const row = MEMORY_ROW.exec(line);
      if (row) {
        memory.push({
          region: row[1],
          used_bytes: toBytes(row[2], row[3]),
          total_bytes: toBytes(row[4], row[5]),
          percent: parseFloat(row[6]),
        });
        continue;
      }
      if (line.trim().length === 0) {
        continue;
      }
      inMemoryTable = false;
    }

    if (INCLUDED_FROM.test(line)) {
      continue;
    }

    const application = CMAKE_APPLICATION.exec(line);
    if (application) {
      cmakeBase = application[1];
      continue;
    }

    const cmake = CMAKE.exec(line);
    if (cmake) {
      cmakePending = {
        severity: cmake[1].toLowerCase() === 'error' ? 'error' : 'warning',
        tool: 'cmake',
        file: resolveFile(cmake[2], cmakeBase),
        line: Number(cmake[3]),
        message: '',
      };
      continue;
    }

    const kconfigAssigned = KCONFIG_ASSIGNED.exec(line);
    if (kconfigAssigned) {
      collected.push({
        severity: 'warning',
        tool: 'kconfig',
        file: resolveFile(kconfigAssigned[2], options.zephyrBase),
        line: Number(kconfigAssigned[3]),
        message: `${kconfigAssigned[1]} ${kconfigAssigned[4]}`,
        code: kconfigAssigned[1],
      });
      continue;
    }
    const kconfigAbort = KCONFIG_ABORT.exec(line);
    if (kconfigAbort) {
      collected.push({ severity: 'error', tool: 'kconfig', message: kconfigAbort[1] });
      continue;
    }

    const devicetree = DEVICETREE.exec(line);
    if (devicetree) {
      collected.push({ severity: 'error', tool: 'devicetree', message: devicetree[1] });
      continue;
    }

    const ldRegion = LD_REGION.exec(line);
    if (ldRegion) {
      collected.push({
        severity: 'error',
        tool: 'ld',
        message: `region ${ldRegion[1]} overflowed by ${ldRegion[2]} bytes`,
        code: ldRegion[1],
      });
      continue;
    }

    const compiler = COMPILER.exec(line);
    if (compiler && !line.startsWith('CMake')) {
      const severity: DiagnosticSeverity =
        compiler[4] === 'note' ? 'note' : compiler[4] === 'warning' ? 'warning' : 'error';
      const diagnostic: Diagnostic = {
        severity,
        tool: /clang/i.test(line) ? 'clang' : 'gcc',
        file: resolveFile(compiler[1], options.buildDir),
        line: Number(compiler[2]),
        ...(compiler[3] ? { column: Number(compiler[3]) } : {}),
        message: compiler[5],
        ...(compiler[6] ? { code: compiler[6] } : {}),
      };
      const dtc = DTC.exec(line);
      if (dtc) {
        diagnostic.tool = 'devicetree';
      }
      // A note explains the diagnostic above it rather than standing alone.
      const previous = collected[collected.length - 1];
      if (severity === 'note' && previous && previous.severity !== 'note') {
        (previous.related ??= []).push(diagnostic);
      } else {
        collected.push(diagnostic);
      }
      continue;
    }

    const dtcOnly = DTC.exec(line);
    if (dtcOnly) {
      collected.push({
        severity: 'error',
        tool: 'devicetree',
        file: resolveFile(dtcOnly[1], options.buildDir),
        line: Number(dtcOnly[2]),
        column: Number(dtcOnly[3]),
        message: dtcOnly[4],
      });
      continue;
    }

    const section = LD_SECTION.exec(line);
    if (section) {
      collected.push({
        severity: section[3] === 'warning' ? 'warning' : 'error',
        tool: 'ld',
        file: resolveFile(section[1], options.buildDir),
        line: Number(section[2]),
        message: section[4],
      });
      continue;
    }
    const located = LD_LOCATED.exec(line);
    if (located) {
      // A file is kept only with a line number or as an absolute path: a bare
      // object name such as `main.c:(.text+0x8)` is not a file to open.
      const keepFile = located[2] !== undefined || path.isAbsolute(located[1]);
      collected.push({
        severity: 'error',
        tool: 'ld',
        ...(keepFile ? { file: resolveFile(located[1], options.buildDir) } : {}),
        ...(located[2] ? { line: Number(located[2]) } : {}),
        message: located[3],
      });
      continue;
    }
    const undefinedRef = UNDEFINED_REF.exec(line);
    if (undefinedRef) {
      collected.push({ severity: 'error', tool: 'ld', message: `undefined reference to ${undefinedRef[1]}` });
      continue;
    }
    const ldGeneric = LD_GENERIC.exec(line);
    if (ldGeneric && LD_CONTEXT.test(line)) {
      // Only says which function the next message is about.
      continue;
    }
    if (ldGeneric) {
      // The linker says itself whether it is a warning, such as an orphan
      // section, which must not turn a good build into a failed one.
      const warning = /^warning:\s*/i.exec(ldGeneric[1]);
      collected.push({
        severity: warning ? 'warning' : 'error',
        tool: 'ld',
        message: warning ? ldGeneric[1].slice(warning[0].length) : ldGeneric[1].replace(/^error:\s*/i, ''),
      });
      continue;
    }

    const westFatal = WEST_FATAL.exec(line);
    if (westFatal) {
      collected.push({ severity: 'error', tool: 'west', message: westFatal[1] });
      continue;
    }

    const ninjaFailed = NINJA_FAILED.exec(line);
    if (ninjaFailed) {
      collected.push({ severity: 'error', tool: 'ninja', message: `FAILED: ${ninjaFailed[1]}` });
      continue;
    }
    const ninjaStopped = NINJA_STOPPED.exec(line);
    if (ninjaStopped) {
      collected.push({ severity: 'error', tool: 'ninja', message: `build stopped: ${ninjaStopped[1]}` });
      continue;
    }
  }
  if (cmakePending) {
    collected.push(cmakePending);
  }

  const seen = new Set<string>();
  const unique = collected.filter(d => {
    const key = dedupeKey(d);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  const errors = unique.filter(d => d.severity === 'error').length;
  const warnings = unique.filter(d => d.severity === 'warning').length;
  const severityRank = { error: 0, warning: 1, note: 2 } as const;
  // `FAILED: zephyr/zephyr.elf`, `ninja: build stopped` and west's
  // `command exited with status 1` are consequences of a real diagnostic, not
  // causes. An agent reads the first item, so the cause has to come first.
  const consequenceTools = new Set<DiagnosticTool>(['ninja', 'west']);
  const toolRank = (d: Diagnostic) => (consequenceTools.has(d.tool) ? 1 : 0);
  const ordered = unique
    .slice()
    .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || toolRank(a) - toolRank(b));

  return {
    diagnostics: ordered.slice(0, max),
    memory,
    errors,
    warnings,
    truncated: ordered.length > max,
  };
}
