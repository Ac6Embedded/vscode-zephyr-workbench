import * as vscode from 'vscode';
import * as fs from 'fs';
import * as net from 'net';
import { ChildProcess, spawn } from 'child_process';

import {
  ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY,
  ZEPHYR_WORKBENCH_SETTING_SECTION_KEY,
} from '../../constants';
import {
  classifyShell,
  concatCommands,
  expandEnvVariables,
  getConfiguredVenvPath,
  getConfiguredWorkbenchPath,
  getShellArgs,
  getShellExe,
  getShellNullRedirect,
  getShellSourceCommand,
  normalizePathForShell,
} from '../../utils/execUtils';
import { prependRustBinPath } from '../../models/ToolchainInstallations';
import { ZephyrApplication } from '../../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../../models/ZephyrBuildConfig';
import { getWestWorkspace, tryGetZephyrSdkInstallation } from '../../utils/utils';

const OUTPUT_TAIL_MAX_LINES = 60;

let serverOutputChannel: vscode.OutputChannel | undefined;

export function getDebugServerOutputChannel(): vscode.OutputChannel {
  if (!serverOutputChannel) {
    serverOutputChannel = vscode.window.createOutputChannel('Zephyr Workbench: Debug Server');
  }
  return serverOutputChannel;
}

export interface ManagedServerProcess {
  child: ChildProcess;
  /** Resolves with the exit code once the process ends (never rejects). */
  exited: Promise<number | null>;
  hasExited(): boolean;
  /** Last lines of combined stdout/stderr, for error surfaces. */
  outputTail(): string;
  /** Subscribe to output lines; returns an unsubscribe function. */
  onOutputLine(listener: (line: string) => void): () => void;
  /** Kill the whole process tree. */
  dispose(): Promise<void>;
}

/**
 * Spawn `west <westArgs>` directly with the same environment the historical
 * west wrapper script bakes in (env script sourcing + west workspace, toolchain
 * and build-config env vars) — no wrapper file involved.
 *
 * On Windows the spawn is forced through cmd.exe with the `.bat` env script,
 * mirroring `createWestWrapper`, so it does not depend on the user's terminal
 * profile (PowerShell execution policies, custom args, ...). On POSIX the
 * process is detached into its own process group so the whole tree
 * (shell -> west/python -> GDB server) can be killed together.
 */
export function spawnWestDebugServer(
  project: ZephyrApplication,
  buildConfig: ZephyrBuildConfig,
  westArgs: string,
): ManagedServerProcess {
  let envScript = getConfiguredWorkbenchPath(
    ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY,
    project.appWorkspaceFolder,
  );
  if (!envScript) {
    throw new Error(
      'Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Zephyr Workbench > Path To Env Script',
      { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` },
    );
  }
  envScript = expandEnvVariables(envScript);

  const isWindows = process.platform === 'win32';
  const shellExe = isWindows ? 'C:\\Windows\\System32\\cmd.exe' : getShellExe();
  const shellKind = classifyShell(shellExe);
  if (isWindows) {
    const batchEnvScript = envScript.replace(/\.(ps1|sh)$/i, '.bat');
    if (fs.existsSync(batchEnvScript)) {
      envScript = batchEnvScript;
    }
  }

  const westWorkspace = getWestWorkspace(project.westWorkspaceRootPath);
  const zephyrSdkInstallation = tryGetZephyrSdkInstallation(project.zephyrSdkPath);
  const env: NodeJS.ProcessEnv = prependRustBinPath({
    ...process.env,
    ...(zephyrSdkInstallation?.buildEnv ?? {}),
    ...westWorkspace.buildEnv,
    ...project.getToolchainEnv(),
    ...buildConfig.envVars,
  }, project.selectedRustToolchainInstallation?.binPath);

  const venvPath = project.venvPath ?? getConfiguredVenvPath(project.appWorkspaceFolder);
  if (venvPath) {
    env.PYTHON_VENV_PATH = venvPath;
  }

  const envScriptForShell = normalizePathForShell(shellKind, envScript);
  const sourceCmd = `${getShellSourceCommand(shellKind, envScriptForShell)} ${getShellNullRedirect(shellKind)}`;
  const script = concatCommands(shellKind, sourceCmd, `west ${westArgs}`);

  const outputChannel = getDebugServerOutputChannel();
  outputChannel.appendLine(`[${new Date().toISOString()}] west ${westArgs}`);

  // The composed script contains embedded quotes (--build-dir "..."). A plain
  // spawn would let libuv re-quote them into \" which cmd.exe does not
  // un-escape, so on Windows pass the script verbatim the same way Node's own
  // shell:true option invokes cmd.exe.
  const child = isWindows
    ? spawn(shellExe, ['/d', '/s', '/c', `"${script}"`], {
      cwd: project.appRootPath,
      env,
      windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    : spawn(shellExe, [...getShellArgs(shellKind), script], {
      cwd: project.appRootPath,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  const tail: string[] = [];
  const listeners = new Set<(line: string) => void>();
  let exited = false;

  const emitLine = (line: string, partial = false) => {
    if (line.trim().length === 0) {
      return;
    }
    if (!partial) {
      outputChannel.appendLine(line);
      tail.push(line);
      if (tail.length > OUTPUT_TAIL_MAX_LINES) {
        tail.shift();
      }
    }
    for (const listener of listeners) {
      listener(line);
    }
  };

  // GDB servers write block-buffered to pipes, so a banner line can be torn
  // across chunks or arrive without a trailing newline — keep a carry per
  // stream and also surface the unterminated remainder to pattern listeners.
  const makeStreamReader = () => {
    let carry = '';
    return (chunk: Buffer) => {
      const lines = (carry + chunk.toString()).split(/\r?\n/);
      carry = lines.pop() ?? '';
      for (const line of lines) {
        emitLine(line);
      }
      if (carry.trim().length > 0) {
        emitLine(carry, true);
      }
    };
  };
  child.stdout?.on('data', makeStreamReader());
  child.stderr?.on('data', makeStreamReader());

  const exitedPromise = new Promise<number | null>(resolve => {
    child.on('error', (error: Error) => {
      exited = true;
      outputChannel.appendLine(`[error] ${error.message}`);
      tail.push(error.message);
      resolve(null);
    });
    child.on('exit', code => {
      exited = true;
      outputChannel.appendLine(`[exit] west debug server exited with code ${code}`);
      resolve(code);
    });
  });

  const managed: ManagedServerProcess = {
    child,
    exited: exitedPromise,
    hasExited: () => exited,
    outputTail: () => tail.join('\n'),
    onOutputLine: (listener: (line: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => killProcessTree(child),
  };
  return managed;
}

/**
 * Whether a local TCP port is already bound, checked with a bind probe.
 * Never connects: `west debugserver` starts J-Link in single-run mode and
 * ST-LINK_gdbserver in single-connection mode, so a probe connection would be
 * consumed as the one allowed GDB client (or kill the server outright).
 */
export function probeTcpPortBusy(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code === 'EADDRINUSE' || error.code === 'EACCES');
    });
    probe.once('listening', () => {
      probe.close(() => resolve(false));
    });
    probe.listen(port, host);
  });
}

export interface ServerReadyOptions {
  port: number;
  /** Runner banner line marking readiness (WestRunner.serverStartedPattern). */
  startedPattern?: string;
  timeoutMs: number;
  cancellationTokens?: (vscode.CancellationToken | undefined)[];
}

/**
 * Wait until the spawned GDB server is ready to accept its client.
 * Readiness signals, in order of trust:
 *   1. the runner's known startup banner on stdout/stderr;
 *   2. the TCP port becoming bound (bind probe — advisory fallback for
 *      runners without a known banner).
 * Rejects when the server exits, a token cancels, or the timeout elapses.
 */
export function waitForWestDebugServerReady(
  proc: ManagedServerProcess,
  options: ServerReadyOptions,
): Promise<void> {
  const { port, startedPattern, timeoutMs } = options;
  const tokens = (options.cancellationTokens ?? []).filter(
    (token): token is vscode.CancellationToken => !!token,
  );

  return new Promise<void>((resolve, reject) => {
    const disposables: (() => void)[] = [];
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      for (const dispose of disposables) {
        try {
          dispose();
        } catch {
          // best effort cleanup
        }
      }
      error ? reject(error) : resolve();
    };

    if (startedPattern && proc.outputTail().includes(startedPattern)) {
      finish();
      return;
    }
    if (startedPattern) {
      disposables.push(proc.onOutputLine(line => {
        if (line.includes(startedPattern)) {
          finish();
        }
      }));
    }

    // The bind probe momentarily holds the port, so it can race the server's
    // own bind. When a startup banner is known, treat the probe as a late
    // fallback only; without a banner start probing right away.
    const probeStartDelayMs = startedPattern ? Math.min(3000, timeoutMs / 2) : 500;
    let probeTimer: NodeJS.Timeout | undefined;
    const probeStartTimer = setTimeout(() => {
      probeTimer = setInterval(() => {
        void probeTcpPortBusy(port).then(busy => {
          if (busy) {
            finish();
          }
        });
      }, 500);
    }, probeStartDelayMs);
    disposables.push(() => {
      clearTimeout(probeStartTimer);
      if (probeTimer) {
        clearInterval(probeTimer);
      }
    });

    const timeoutTimer = setTimeout(() => {
      finish(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the GDB server on port ${port}.`));
    }, timeoutMs);
    disposables.push(() => clearTimeout(timeoutTimer));

    for (const token of tokens) {
      if (token.isCancellationRequested) {
        finish(new Error('cancelled'));
        return;
      }
      const registration = token.onCancellationRequested(() => finish(new Error('cancelled')));
      disposables.push(() => registration.dispose());
    }

    void proc.exited.then(code => {
      finish(new Error(`west debugserver exited with code ${code} before the GDB server was ready.`));
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Kill a spawned server and all of its descendants. `child.kill()` alone would
 * only hit the wrapping shell and orphan west/python and the actual GDB server
 * (which keeps the debug probe locked for every following session).
 */
export async function killProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const taskkill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      taskkill.once('exit', () => resolve());
      taskkill.once('error', () => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        resolve();
      });
    });
    return;
  }

  // POSIX: the server was spawned detached, so it owns its process group.
  try {
    process.kill(-child.pid, 'SIGINT');
  } catch {
    try {
      child.kill('SIGINT');
    } catch {
      return;
    }
  }

  if (!(await waitForExit(child, 3000))) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}
