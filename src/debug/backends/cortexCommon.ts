import { CortexConfigInput, GdbMode } from './types';

export function mapGdbModeToRequest(gdbMode: GdbMode): 'launch' | 'attach' {
  return gdbMode === 'attach' ? 'attach' : 'launch';
}

/**
 * Derive cortex-debug's `armToolchainPath` / `toolchainPrefix` from the GDB
 * executable. cortex-debug defaults to the `arm-none-eabi` prefix, but the
 * Zephyr SDK ships `arm-zephyr-eabi-*`; without the derived prefix it cannot
 * find objdump/nm next to the GDB and disassembly degrades silently.
 *
 * Works on plain paths and on `${config:...}`-prefixed ones (string-level
 * dirname/basename only). Returns nothing for a prefix-less `gdb` name.
 */
export function deriveToolchainFromGdbPath(gdbPath: string): { armToolchainPath?: string; toolchainPrefix?: string } {
  const trimmed = gdbPath.trim().replace(/^"(.*)"$/, '$1');
  if (!trimmed) {
    return {};
  }

  // Separator-agnostic basename: launch.json values may use Windows
  // backslashes even when the extension host runs on POSIX (and vice versa).
  const lastSeparatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const baseName = trimmed.slice(lastSeparatorIndex + 1).replace(/\.exe$/i, '');
  const prefixMatch = baseName.match(/^(.+)-gdb(?:-py)?$/);
  if (!prefixMatch) {
    return {};
  }

  if (lastSeparatorIndex <= 0) {
    return { toolchainPrefix: prefixMatch[1] };
  }

  return {
    armToolchainPath: trimmed.slice(0, lastSeparatorIndex).replace(/[\\/]+$/, '') || trimmed.slice(0, lastSeparatorIndex),
    toolchainPrefix: prefixMatch[1],
  };
}

/**
 * Keys shared by every cortex-debug configuration the backends emit. Backends
 * add their `servertype`-specific keys on top; entries are always rebuilt from
 * scratch (never mutated in place) so no stale keys survive a backend switch.
 */
export function assembleCortexDebugBaseConfig(input: CortexConfigInput): any {
  const config: any = {
    name: input.name,
    type: 'cortex-debug',
    request: mapGdbModeToRequest(input.gdbMode),
    cwd: input.cwd,
    executable: input.programPath,
  };

  const svdPath = input.svdPath?.trim();
  if (svdPath) {
    config.svdFile = svdPath;
  }

  const gdbPath = input.gdbPath?.trim();
  if (gdbPath) {
    config.gdbPath = gdbPath;
    Object.assign(config, deriveToolchainFromGdbPath(gdbPath));
  }

  if (input.gdbMode === 'program') {
    // Parity with the cppdbg pipeline's `tbreak main`.
    config.runToEntryPoint = 'main';
  }

  return config;
}
