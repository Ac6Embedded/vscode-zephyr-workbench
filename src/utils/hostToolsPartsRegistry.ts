/**
 * Single per-OS registry of the host-tools parts: the Advanced panel rows, the
 * --tools/-Tools whitelist and the presence probes all read this one
 * structure, so they can no longer drift apart (a drift here is exactly the
 * bug class where a part shown in the UI was silently stripped from the
 * command line).
 *
 * Pure data and pure functions: no vscode import, platform passed as a
 * parameter, so everything is unit-testable.
 *
 * The `id` strings are a contract with the install scripts: they must match
 * the selectable step names in install.ps1 ($script:SelectableSteps),
 * install.sh and install-mac.sh (SELECTABLE_STEPS).
 */

export type HostToolsOs = 'win32' | 'linux' | 'darwin';

export interface HostToolsPartDef {
  /** Step id passed to -Tools/--tools; must match the installer's step names. */
  id: string;
  /** Row label in the Advanced panel. */
  label: string;
  /** Smaller second line under the label (package/formula list of a batch row). */
  detail?: string;
  /** Provider column text ('download', 'brew', 'brew bundle', 'distro packages'). Unset on win32. */
  provider?: string;
  /** Requires root: renders the [sudo] badge and gates the linux --only-root invocation. */
  sudo?: boolean;
  /** Key in the --only-check version map. */
  versionKey?: string;
  /** Key in tools.yml for the target version. Unset -> Available cell shows availableText. */
  targetKey?: string;
  /** Static Available-cell text when there is no targetKey ('brew', 'distro'). */
  availableText?: string;
  /** Rendered as a checklist row (python/venv are not rows). */
  row: boolean;
  /** Accepted by the --tools whitelist. */
  selectable: boolean;
  probe: {
    /** fs presence, relative to the .zinstaller dir. */
    artifact?: string;
    /**
     * Directory scan fallback for artifacts whose folder name embeds a
     * version (linux cmake): any folder under <dir> starting with <prefix>
     * and containing <suffix> counts, so a tools.yml version bump keeps the
     * Status column truthful for an older install.
     */
    artifactPrefixScan?: { dir: string; prefix: string; suffix: string };
    /** Command(s) that must all resolve on PATH (or under the brew prefix on darwin). */
    cmds?: string[];
    /** Presence derived from --only-check: all these versionKeys detected. */
    versionKeysAllOf?: string[];
  };
}

/** Must reproduce the pre-registry win32 behavior exactly. */
const WIN32_PARTS: HostToolsPartDef[] = [
  { id: 'cmake', label: 'CMake', versionKey: 'cmake', targetKey: 'cmake', row: true, selectable: true,
    probe: { artifact: 'tools/cmake/bin/cmake.exe' } },
  { id: 'ninja', label: 'Ninja', versionKey: 'ninja', targetKey: 'ninja', row: true, selectable: true,
    probe: { artifact: 'tools/ninja/ninja.exe' } },
  { id: 'gperf', label: 'gperf', versionKey: 'gperf', targetKey: 'gperf', row: true, selectable: true,
    probe: { artifact: 'tools/gperf/bin/gperf.exe' } },
  { id: 'dtc', label: 'Device Tree Compiler', versionKey: 'dtc', targetKey: 'dtc', row: true, selectable: true,
    probe: { artifact: 'tools/dtc/usr/bin/dtc.exe' } },
  { id: 'git', label: 'Git', versionKey: 'git', targetKey: 'git', row: true, selectable: true,
    probe: { artifact: 'tools/git/bin/git.exe' } },
  { id: 'wget', label: 'wget', versionKey: 'wget', targetKey: 'wget', row: true, selectable: true,
    probe: { artifact: 'tools/wget/wget.exe' } },
  { id: 'python', label: 'Python', versionKey: 'python', targetKey: 'python_portable', row: false, selectable: true,
    probe: { artifact: 'tools/python/python/python.exe' } },
  { id: 'venv', label: 'Python virtual environment', row: false, selectable: true,
    probe: { artifact: '.venv/Scripts/Activate.ps1' } },
];

const LINUX_PARTS: HostToolsPartDef[] = [
  { id: 'cmake', label: 'CMake', provider: 'download', versionKey: 'cmake', targetKey: 'cmake', row: true, selectable: true,
    probe: { artifactPrefixScan: { dir: 'tools', prefix: 'cmake-', suffix: 'bin/cmake' } } },
  { id: 'ninja', label: 'Ninja', provider: 'download', versionKey: 'ninja', targetKey: 'ninja', row: true, selectable: true,
    probe: { artifact: 'tools/ninja/ninja' } },
  { id: 'system', label: 'System packages', provider: 'distro packages', sudo: true, availableText: 'distro',
    detail: 'git, gperf, dtc, gcc, make, ccache, dfu-util, wget, xz, file, SDL2, hidapi, libmagic, unzip, python3 support packages',
    row: true, selectable: true,
    probe: { versionKeysAllOf: ['git', 'gperf', 'dtc'] } },
  { id: 'python', label: 'Python', versionKey: 'python', targetKey: 'python_portable', row: false, selectable: true,
    probe: { artifact: 'tools/python/python.AppImage' } },
  { id: 'venv', label: 'Python virtual environment', row: false, selectable: true,
    probe: { artifact: '.venv/bin/activate' } },
];

const DARWIN_PARTS: HostToolsPartDef[] = [
  { id: 'cmake', label: 'CMake', provider: 'brew', versionKey: 'cmake', availableText: 'brew', row: true, selectable: true,
    probe: { cmds: ['cmake'] } },
  { id: 'ninja', label: 'Ninja', provider: 'brew', versionKey: 'ninja', availableText: 'brew', row: true, selectable: true,
    probe: { cmds: ['ninja'] } },
  { id: 'gperf', label: 'gperf', provider: 'brew', versionKey: 'gperf', availableText: 'brew', row: true, selectable: true,
    probe: { cmds: ['gperf'] } },
  { id: 'dtc', label: 'Device Tree Compiler', provider: 'brew', versionKey: 'dtc', availableText: 'brew', row: true, selectable: true,
    probe: { cmds: ['dtc'] } },
  { id: 'git', label: 'Git', provider: 'brew', versionKey: 'git', availableText: 'brew', row: true, selectable: true,
    probe: { cmds: ['git'] } },
  { id: 'utilities', label: 'Utilities', provider: 'brew bundle', availableText: 'brew',
    detail: 'ccache, libmagic, wget, yq, xz, dfu-util, libftdi, hidapi',
    row: true, selectable: true,
    // The binary-bearing subset: libmagic/libftdi/hidapi are libraries with
    // no probeable executable.
    probe: { cmds: ['ccache', 'wget', 'xz', 'dfu-util'] } },
  { id: 'python', label: 'Python', versionKey: 'python', row: false, selectable: true,
    probe: { cmds: ['python3'] } },
  { id: 'venv', label: 'Python virtual environment', row: false, selectable: true,
    probe: { artifact: '.venv/bin/activate' } },
];

function toHostToolsOs(platform: NodeJS.Platform): HostToolsOs {
  if (platform === 'win32' || platform === 'darwin') {
    return platform;
  }
  return 'linux';
}

const PARTS_BY_OS: Record<HostToolsOs, HostToolsPartDef[]> = {
  win32: WIN32_PARTS,
  linux: LINUX_PARTS,
  darwin: DARWIN_PARTS,
};

export function getHostToolsParts(platform: NodeJS.Platform = process.platform): HostToolsPartDef[] {
  return PARTS_BY_OS[toHostToolsOs(platform)];
}

/** Checklist rows of the Advanced panel (python/venv are not rows). */
export function getAdvancedRowParts(platform: NodeJS.Platform = process.platform): HostToolsPartDef[] {
  return getHostToolsParts(platform).filter(p => p.row);
}

/** Whitelist for -Tools/--tools values before they enter a shell command line. */
export function getSelectablePartIds(platform: NodeJS.Platform = process.platform): string[] {
  return getHostToolsParts(platform).filter(p => p.selectable).map(p => p.id);
}

/** Parts with a plain filesystem artifact probe. */
export function getArtifactParts(platform: NodeJS.Platform = process.platform): HostToolsPartDef[] {
  return getHostToolsParts(platform).filter(p => typeof p.probe.artifact === 'string');
}

/** Whether the Advanced panel renders the Provider column on this platform. */
export function hasProviderColumn(platform: NodeJS.Platform = process.platform): boolean {
  return getAdvancedRowParts(platform).some(p => typeof p.provider === 'string');
}
