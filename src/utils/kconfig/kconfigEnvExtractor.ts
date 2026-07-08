// Reproduces the exact environment Zephyr uses to run menuconfig/guiconfig, so an
// external Kconfig server can load the identical symbol tree without re-running CMake.
//
// The authoritative source is the `menuconfig` custom-command in the build's
// `build.ninja`: it embeds the full `cmake -E env KEY=VAL ... python .../menuconfig.py
// .../Kconfig` invocation verbatim. We parse that command back into an environment map,
// the interpreter, the Kconfig root file, and the working directory. When build.ninja is
// missing or unparseable we fall back to reconstructing the env from CMakeCache.txt plus
// the materialized module-dir env file and Zephyr's deterministic path layout.
//
// This module is intentionally free of any `vscode` dependency (fs/path/os only) so the
// parser can be unit-tested in isolation.

import * as fs from 'fs';
import * as path from 'path';

/** Everything needed to launch the Kconfig server against a build. */
export interface KconfigLaunchSpec {
  /** The env map to pass to the server process (the `cmake -E env` assignments). */
  env: Record<string, string>;
  /**
   * Interpreter extracted from build.ninja (the one that produced edt.pickle, so its
   * edtlib matches the pickle). Empty when unknown — the caller must supply a fallback.
   */
  python: string;
  /** Absolute path to the top-level Kconfig file (last argument of the command). */
  kconfigRoot: string;
  /** Working directory the command runs in (`<build>/zephyr/kconfig`). */
  cwd: string;
  /** Convenience copies pulled out of `env` (also present in `env`). */
  zephyrBase: string;
  configPath: string;
  edtPickle: string;
  /** Where the launch spec came from — surfaced in the UI when it is a fallback. */
  source: 'ninja' | 'fallback';
  /** The build directory actually used (handles the sysbuild app-name nesting). */
  buildDir: string;
}

export interface ParsedNinjaCommand {
  env: Record<string, string>;
  python: string;
  script: string;
  kconfigRoot: string;
  cwd: string;
}

export type ExtractError = { error: string; code: KconfigLaunchErrorCode };
export type KconfigLaunchErrorCode =
  | 'no-build-dir'
  | 'no-build-ninja'
  | 'no-menuconfig-rule'
  | 'parse-failed'
  | 'incomplete-env'
  | 'no-cmake-cache';

export function isExtractError(v: KconfigLaunchSpec | ExtractError): v is ExtractError {
  return (v as ExtractError).error !== undefined;
}

/** Artifacts the Kconfig server needs; produced by the CMake configure stage. */
export interface PreflightArtifacts {
  buildDir: string;
  buildNinja: { path: string; exists: boolean };
  dotConfig: { path: string; exists: boolean };
  edtPickle: { path: string; exists: boolean };
  /** True when every required artifact is present. */
  ready: boolean;
  /** Human-readable names of the missing artifacts (for messages). */
  missing: string[];
}

// ---------------------------------------------------------------------------
// Build-directory resolution
// ---------------------------------------------------------------------------

// Some layouts (notably sysbuild) place the real build under an extra
// application-name directory, while the top-level dir holds sysbuild's own build.ninja
// (which has no menuconfig rule and no zephyr/.config). Prefer the dir that actually
// contains the app's Kconfig artifacts, then fall back to wherever build.ninja lives.
export function resolveInnerBuildDir(buildDir: string, appName?: string): string {
  const nested = appName ? path.join(buildDir, appName) : undefined;

  // First choice: the dir holding the app's merged config (definitive for sysbuild).
  if (fs.existsSync(path.join(buildDir, 'zephyr', '.config'))) { return buildDir; }
  if (nested && fs.existsSync(path.join(nested, 'zephyr', '.config'))) { return nested; }

  // Not configured yet: fall back to where a build.ninja already exists.
  if (fs.existsSync(path.join(buildDir, 'build.ninja'))) { return buildDir; }
  if (nested && fs.existsSync(path.join(nested, 'build.ninja'))) { return nested; }

  // Nothing yet (unconfigured); keep the flat dir so callers can still report
  // deterministic artifact paths and trigger a configure.
  return buildDir;
}

export function preflight(buildDir: string, appName?: string): PreflightArtifacts {
  const inner = resolveInnerBuildDir(buildDir, appName);
  const buildNinja = path.join(inner, 'build.ninja');
  const dotConfig = path.join(inner, 'zephyr', '.config');
  const edtPickle = path.join(inner, 'zephyr', 'edt.pickle');

  const a: PreflightArtifacts = {
    buildDir: inner,
    buildNinja: { path: buildNinja, exists: fs.existsSync(buildNinja) },
    dotConfig: { path: dotConfig, exists: fs.existsSync(dotConfig) },
    edtPickle: { path: edtPickle, exists: fs.existsSync(edtPickle) },
    ready: false,
    missing: [],
  };
  if (!a.buildNinja.exists) { a.missing.push('build.ninja'); }
  if (!a.dotConfig.exists) { a.missing.push('.config'); }
  if (!a.edtPickle.exists) { a.missing.push('edt.pickle'); }
  a.ready = a.missing.length === 0;
  return a;
}

// ---------------------------------------------------------------------------
// build.ninja parsing
// ---------------------------------------------------------------------------

// Undo ninja's escaping inside a rule/command value: `$\n`+indent is a line
// continuation, `$:`/`$ ` are literal colon/space, `$$` is a literal dollar.
function ninjaUnescape(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '$' && i + 1 < raw.length) {
      const n = raw[i + 1];
      if (n === '\n') {
        i++;
        // Skip the leading whitespace of the continuation line.
        while (i + 1 < raw.length && (raw[i + 1] === ' ' || raw[i + 1] === '\t')) { i++; }
        continue;
      }
      if (n === ':' || n === ' ' || n === '$') {
        out += n;
        i++;
        continue;
      }
    }
    out += c;
  }
  return out;
}

/**
 * Pull the `COMMAND = ...` line of the menuconfig (or guiconfig) custom command out of a
 * build.ninja text, joining ninja line-continuations. Returns the ninja-unescaped command.
 */
export function readMenuconfigCommandFromNinja(ninjaText: string): string | undefined {
  const lines = ninjaText.split('\n');
  const isTargetHeader = (l: string, tool: string) =>
    /^build\b/.test(l) && l.includes(`CMakeFiles/${tool}`) && /:\s*CUSTOM_COMMAND\b/.test(l);

  const findFor = (tool: string): string | undefined => {
    for (let i = 0; i < lines.length; i++) {
      if (!isTargetHeader(lines[i], tool)) { continue; }
      // Scan the rule body for the COMMAND binding.
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        // Rule bodies are indented; a non-indented, non-empty line ends the block.
        if (line.length > 0 && !/^\s/.test(line)) { break; }
        const m = /^\s*COMMAND\s*=\s*(.*)$/.exec(line);
        if (m) {
          // Collect ninja line-continuations (physical line ends with an odd `$`).
          let raw = m[1];
          let k = j;
          while (/\$$/.test(raw) && k + 1 < lines.length) {
            raw = raw.slice(0, -1) + '\n' + lines[k + 1];
            k++;
          }
          return ninjaUnescape(raw);
        }
      }
    }
    return undefined;
  };

  return findFor('menuconfig') ?? findFor('guiconfig');
}

// Shell-like tokenizer: splits on unquoted whitespace, honors '...' and "..." spans,
// and strips the quote characters so `KEY="a b"` -> `KEY=a b` and `SHIELD_AS_LIST=''`
// -> `SHIELD_AS_LIST=`. No variable expansion or backslash processing (kconfig.cmake
// only ever single-quotes list values, whose `\;` we normalize afterwards).
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false; // distinguishes an empty quoted token ('') from whitespace
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) { quote = null; } else { cur += c; }
      continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (started) { tokens.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) { tokens.push(cur); }
  return tokens;
}

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Parse a full `cd <dir> && cmake -E env KEY=VAL ... python .../menuconfig.py .../Kconfig`
 * command into its parts. Returns undefined when it does not have the expected shape.
 */
export function parseNinjaMenuconfigCommand(command: string): ParsedNinjaCommand | undefined {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) { return undefined; }

  let idx = 0;
  let cwd = '';

  // Optional leading `cd [/D] <dir> &&`.
  if (tokens[idx] === 'cd') {
    idx++;
    if (tokens[idx] === '/D' || tokens[idx] === '/d') { idx++; } // Windows generator
    cwd = tokens[idx] ?? '';
    idx++;
    if (tokens[idx] === '&&') { idx++; } else { return undefined; }
  }

  // Skip forward to the `env` token of `cmake -E env`.
  const envIdx = tokens.indexOf('env', idx);
  if (envIdx < 0) { return undefined; }
  let p = envIdx + 1;

  // Collect leading KEY=VALUE assignments.
  const env: Record<string, string> = {};
  while (p < tokens.length && ENV_ASSIGN_RE.test(tokens[p])) {
    const eq = tokens[p].indexOf('=');
    const key = tokens[p].slice(0, eq);
    let value = tokens[p].slice(eq + 1);
    if (key === 'SHIELD_AS_LIST') {
      value = value.replace(/\\;/g, ';');
    }
    env[key] = value;
    p++;
  }

  // The command tail is `[ptyWrapper] python <script>.py <Kconfig>`. Anchor on the
  // `.py` script; the interpreter is the token immediately before it, and the Kconfig
  // root is the final token. Anything between the env block and python (a PTY wrapper)
  // is irrelevant to us — we drive our own server with our own stdio.
  let scriptIdx = -1;
  for (let q = tokens.length - 1; q >= p; q--) {
    if (/\.py$/.test(tokens[q])) { scriptIdx = q; break; }
  }
  if (scriptIdx < 0 || scriptIdx - 1 < p || scriptIdx + 1 > tokens.length - 1) {
    return undefined;
  }
  const python = tokens[scriptIdx - 1];
  const script = tokens[scriptIdx];
  const kconfigRoot = tokens[tokens.length - 1];
  if (kconfigRoot === script) { return undefined; }

  return { env, python, script, kconfigRoot, cwd };
}

// ---------------------------------------------------------------------------
// Public extraction entry points
// ---------------------------------------------------------------------------

const REQUIRED_ENV_KEYS = ['srctree', 'KCONFIG_CONFIG', 'CONFIG_'];

/** Primary path: derive the launch spec from build.ninja. */
export function extractFromNinja(buildDir: string, appName?: string): KconfigLaunchSpec | ExtractError {
  const inner = resolveInnerBuildDir(buildDir, appName);
  const ninjaPath = path.join(inner, 'build.ninja');
  if (!fs.existsSync(ninjaPath)) {
    return { error: `build.ninja not found in ${inner}`, code: 'no-build-ninja' };
  }
  let ninjaText: string;
  try {
    ninjaText = fs.readFileSync(ninjaPath, 'utf8');
  } catch (e) {
    return { error: `Could not read build.ninja: ${String(e)}`, code: 'no-build-ninja' };
  }
  const command = readMenuconfigCommandFromNinja(ninjaText);
  if (!command) {
    return { error: 'No menuconfig/guiconfig custom command in build.ninja', code: 'no-menuconfig-rule' };
  }
  const parsed = parseNinjaMenuconfigCommand(command);
  if (!parsed) {
    return { error: 'Could not parse the menuconfig command from build.ninja', code: 'parse-failed' };
  }
  for (const key of REQUIRED_ENV_KEYS) {
    if (!(key in parsed.env)) {
      return { error: `Reproduced Kconfig env is missing ${key}`, code: 'incomplete-env' };
    }
  }
  return {
    env: parsed.env,
    python: parsed.python,
    kconfigRoot: parsed.kconfigRoot,
    cwd: parsed.cwd || path.join(inner, 'zephyr', 'kconfig'),
    zephyrBase: parsed.env['ZEPHYR_BASE'] ?? parsed.env['srctree'],
    configPath: parsed.env['KCONFIG_CONFIG'],
    edtPickle: parsed.env['EDT_PICKLE'] ?? path.join(inner, 'zephyr', 'edt.pickle'),
    source: 'ninja',
    buildDir: inner,
  };
}

// Parse a CMakeCache.txt into a plain key->value map (ignoring the :TYPE part).
function parseCMakeCache(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) { continue; }
    const m = /^([^:=]+):[^=]*=(.*)$/.exec(t);
    if (m) { out[m[1].trim()] = m[2]; }
  }
  return out;
}

// Parse a plain `KEY=VALUE` env file (kconfig_module_dirs.env).
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) { continue; }
    const eq = t.indexOf('=');
    if (eq > 0) { out[t.slice(0, eq)] = t.slice(eq + 1); }
  }
  return out;
}

/**
 * Fallback path: reconstruct the launch spec from CMakeCache.txt + the materialized
 * module-dir env file + Zephyr's deterministic path layout. Flagged `source:'fallback'`
 * so the UI can warn that the reproduction is best-effort.
 */
export function extractFromFallback(buildDir: string, appName?: string): KconfigLaunchSpec | ExtractError {
  const inner = resolveInnerBuildDir(buildDir, appName);
  const cachePath = path.join(inner, 'CMakeCache.txt');
  if (!fs.existsSync(cachePath)) {
    return { error: `CMakeCache.txt not found in ${inner}`, code: 'no-cmake-cache' };
  }
  const cache = parseCMakeCache(fs.readFileSync(cachePath, 'utf8'));
  const zephyrBase = cache['ZEPHYR_BASE'] || cache['ZEPHYR_BASE_CACHED'] || '';
  const appDir = cache['APPLICATION_SOURCE_DIR'] || '';
  const board = cache['CACHED_BOARD'] || cache['BOARD'] || '';
  if (!zephyrBase) {
    return { error: 'CMakeCache.txt has no ZEPHYR_BASE', code: 'incomplete-env' };
  }

  const zephyrOut = path.join(inner, 'zephyr');
  const kconfigDir = path.join(inner, 'Kconfig');
  const env: Record<string, string> = {
    ZEPHYR_BASE: zephyrBase,
    srctree: zephyrBase,
    CONFIG_: 'CONFIG_',
    KCONFIG_CONFIG: path.join(zephyrOut, '.config'),
    EDT_PICKLE: path.join(zephyrOut, 'edt.pickle'),
    KCONFIG_BINARY_DIR: kconfigDir,
    KCONFIG_BOARD_DIR: path.join(kconfigDir, 'boards'),
    ARCH: '*',
    ARCH_DIR: path.join(zephyrBase, 'arch'),
    HWM_SCHEME: 'v2',
  };
  if (appDir) {
    env.APPLICATION_SOURCE_DIR = appDir;
    env.APP_DIR = appDir;
  }
  if (board) { env.BOARD = board; }

  // Fold in the materialized per-module ZEPHYR_<NAME>_MODULE_DIR / _KCONFIG vars.
  const moduleEnvPath = path.join(kconfigDir, 'kconfig_module_dirs.env');
  if (fs.existsSync(moduleEnvPath)) {
    Object.assign(env, parseEnvFile(fs.readFileSync(moduleEnvPath, 'utf8')));
  }

  const python = cache['WEST_PYTHON'] || cache['PYTHON_EXECUTABLE'] || '';

  return {
    env,
    python,
    kconfigRoot: path.join(zephyrBase, 'Kconfig'),
    cwd: path.join(zephyrOut, 'kconfig'),
    zephyrBase,
    configPath: env.KCONFIG_CONFIG,
    edtPickle: env.EDT_PICKLE,
    source: 'fallback',
    buildDir: inner,
  };
}

/** Try build.ninja first, then the CMakeCache fallback. */
export function extractKconfigLaunchSpec(buildDir: string, appName?: string): KconfigLaunchSpec | ExtractError {
  if (!fs.existsSync(buildDir)) {
    return { error: `Build directory not found: ${buildDir}`, code: 'no-build-dir' };
  }
  const primary = extractFromNinja(buildDir, appName);
  if (!isExtractError(primary)) { return primary; }
  const fallback = extractFromFallback(buildDir, appName);
  if (!isExtractError(fallback)) { return fallback; }
  // Prefer the primary error message (more actionable) unless it was just "no ninja".
  return primary.code === 'no-build-ninja' ? fallback : primary;
}
