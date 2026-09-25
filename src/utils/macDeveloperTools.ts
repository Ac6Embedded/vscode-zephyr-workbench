import { execFile } from 'child_process';
import fs from 'fs';

/*
 * The macOS Command Line Tools. Without them, /usr/bin/python3, git, make and
 * gperf are stubs: running one opens the system dialog that offers to install
 * the tools. `xcode-select -p` only prints the developer folder and never
 * opens that dialog, so it is how a caller that must not show one finds out
 * first. VS Code's own git extension asks it for the same reason.
 *
 * vscode-free, so it is unit tested.
 */

/** The /usr/bin commands the host tools checks run that are developer tools stubs on macOS. */
export const XCODE_STUB_COMMANDS: readonly string[] = ['python3', 'git', 'make', 'gperf'];

/**
 * Set for the installer's check mode when the developer tools are missing:
 * it then reports each stub as not installed instead of running it.
 */
export const DEVELOPER_TOOLS_MISSING_ENV = 'ZW_DEVELOPER_TOOLS_MISSING';

export interface XcodeSelectAnswer {
  /** null when xcode-select could not be run or was killed. */
  exitCode: number | null;
  stdout: string;
}

function runXcodeSelect(timeoutMs: number): Promise<XcodeSelectAnswer> {
  return new Promise(resolve => {
    try {
      execFile('/usr/bin/xcode-select', ['-p'], { timeout: timeoutMs }, (error, stdout) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({ exitCode: error ? (typeof code === 'number' ? code : null) : 0, stdout: String(stdout ?? '') });
      });
    } catch {
      resolve({ exitCode: null, stdout: '' });
    }
  });
}

/**
 * True only when the macOS developer tools are known to be missing:
 * xcode-select names no developer folder (it exits 2), or names one that is
 * gone, because a selection left on a deleted Xcode leaves the stubs just as
 * unable to run. False on other systems, and when xcode-select itself gave
 * no answer.
 */
export async function macDeveloperToolsMissing(opts: {
  platform?: NodeJS.Platform;
  run?: () => Promise<XcodeSelectAnswer>;
  exists?: (target: string) => boolean;
} = {}): Promise<boolean> {
  if ((opts.platform ?? process.platform) !== 'darwin') {
    return false;
  }
  const answer = await (opts.run ?? (() => runXcodeSelect(5000)))();
  if (answer.exitCode === null) {
    return false;
  }
  const developerDir = answer.stdout.split(/\r?\n/)[0]?.trim();
  if (answer.exitCode !== 0 || !developerDir) {
    return true;
  }
  return !(opts.exists ?? fs.existsSync)(developerDir);
}

function isExecutableFile(target: string): boolean {
  try {
    fs.accessSync(target, fs.constants.X_OK);
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** The first `name` on a macOS PATH, as a shell would find it, without running anything. */
export function findOnMacPath(
  name: string,
  pathEnv: string | undefined = process.env.PATH,
  isExecutable: (target: string) => boolean = isExecutableFile,
): string | undefined {
  for (const dir of (pathEnv ?? '').split(':')) {
    if (!dir) {
      continue;
    }
    const candidate = `${dir.replace(/\/+$/, '')}/${name}`;
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Whether a resolved command is one of the /usr/bin developer tools stubs. */
export function isXcodeStub(resolvedPath: string): boolean {
  const slash = resolvedPath.lastIndexOf('/');
  return resolvedPath.slice(0, slash) === '/usr/bin' && XCODE_STUB_COMMANDS.includes(resolvedPath.slice(slash + 1));
}

/**
 * The interpreters a system Python probe may run when the developer tools are
 * missing: each name as the shell would resolve it, by full path, minus any
 * that resolves to its /usr/bin stub. A python.org, Homebrew, pyenv or conda
 * Python found first on PATH needs no developer tools and is still probed.
 */
export function pythonCandidatesWithoutStubs(
  names: readonly string[],
  pathEnv: string | undefined = process.env.PATH,
  isExecutable: (target: string) => boolean = isExecutableFile,
): string[] {
  const candidates: string[] = [];
  for (const name of names) {
    const resolved = findOnMacPath(name, pathEnv, isExecutable);
    if (resolved && !isXcodeStub(resolved) && !candidates.includes(resolved)) {
      candidates.push(resolved);
    }
  }
  return candidates;
}
