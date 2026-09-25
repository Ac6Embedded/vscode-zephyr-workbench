// The Python helper behind the serial actions of the hardware tool
// (scripts/serial/serial_capture.py): which interpreter runs it, listing the
// ports, and who holds a busy port. The helper runs on the Python of the Zephyr
// virtual environment, whose requirements include pyserial, so nothing is
// installed for it and no native Node module ships with the extension.
//
// It is spawned directly with pipes, never through a shell or a VS Code task:
// a task's stdin is not writable, and a shell would parse the port name.

import { ChildProcess, execFile, spawn, SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ZephyrApplication } from '../../../models/ZephyrApplication';
import { resolveEffectiveVenv } from '../../../utils/env/venvResolution';
import { venvPythonPath } from '../../../utils/kconfig/kconfigSession';
import { McpToolError } from '../../core/errors';
import { ListedPort } from '../../core/serialPorts';
import { runLoggedStep } from '../taskRunner';

/** The interpreter and the script, the start of every helper command line. */
export interface HelperCommand {
  command: string;
  args: string[];
}

/** A status event of the helper, one JSON object per stderr line. */
export interface HelperEvent {
  event: string;
  code?: string;
  message?: string;
  port?: string;
  baud?: number;
  id?: number | null;
  bytes?: number;
  reason?: string;
}

/** Who holds a busy port, when the platform can tell. */
export interface PortHolder {
  pid: number;
  name?: string;
  /** This VS Code window's own extension host, where the Serial Monitor extension runs. */
  thisWindow?: boolean;
  /** A Zephyr Workbench capture, started from another VS Code window. */
  workbenchCapture?: boolean;
}

const LIST_TIMEOUT_MS = 15_000;
const HOLDER_TIMEOUT_MS = 3_000;
const PROBE_TIMEOUT_MS = 10_000;

/** Where the helper ships, inside the extension. */
export function helperScriptPath(extensionPath: string): string {
  return path.join(extensionPath, 'scripts', 'serial', 'serial_capture.py');
}

/**
 * The helper command for an application's environment, or the machine's
 * (the managed venv) without one: the same interpreter a build of it uses.
 */
export function resolveHelperCommand(extensionPath: string, app?: ZephyrApplication): HelperCommand {
  const venv = resolveEffectiveVenv(app, app?.appWorkspaceFolder, { followEnvScript: true });
  const python = venvPythonPath(venv.path);
  if (!python) {
    throw new McpToolError('ENV_NOT_READY', venv.path
      ? `The Python virtual environment "${venv.path}" has no Python interpreter.`
      : 'No Python virtual environment is set up, and the serial helper runs on its Python.', {
      hint: 'Call check_environment to see what is missing and which Zephyr Workbench command fixes it, then ask the user to run it.',
    });
  }
  return { command: python, args: [helperScriptPath(extensionPath)] };
}

/**
 * What the serial handlers reach the outside world through, on one object so
 * a test can stand in for the interpreter, the process, the terminal and the
 * holder lookup. Production uses these.
 */
export const serialHelper = {
  resolve: resolveHelperCommand,
  spawn: (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => spawn(command, args, options),
  runStep: runLoggedStep,
  findHolder: findPortHolder,
};

export function pyserialMissing(detail?: string): McpToolError {
  return new McpToolError('DEPENDENCY_MISSING',
    `pyserial is not installed in the Python environment the serial helper runs on${detail ? ` (${detail})` : ''}.`, {
      hint: 'The Zephyr Python requirements provide pyserial. Call check_environment to see which environment is used, then ask the user to reinstall the Zephyr requirements in it.',
    });
}

/** Parse one stderr line of the helper, or undefined when it is not an event (a Python traceback line). */
export function parseHelperEvent(line: string): HelperEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as HelperEvent;
    return parsed && typeof parsed.event === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Split a stream into lines, keeping the unfinished last one for the next chunk. */
export function lineSplitter(onLine: (line: string) => void): { push(chunk: string): void; end(): void } {
  let rest = '';
  return {
    push: chunk => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        onLine(line.replace(/\r$/, ''));
      }
    },
    end: () => {
      if (rest) {
        onLine(rest);
        rest = '';
      }
    },
  };
}

/** The ports the helper lists. Opens none of them. */
export async function listPorts(helper: HelperCommand, signal?: AbortSignal): Promise<ListedPort[]> {
  const child = serialHelper.spawn(helper.command, [...helper.args, '--list'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  const events: HelperEvent[] = [];
  const stderrLines: string[] = [];
  const stderr = lineSplitter(line => {
    const event = parseHelperEvent(line);
    if (event) {
      events.push(event);
    } else if (line.trim()) {
      stderrLines.push(line);
    }
  });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.on('data', (chunk: string) => stderr.push(chunk));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new McpToolError('TIMEOUT', `Listing the serial ports took longer than ${LIST_TIMEOUT_MS / 1000} seconds.`, {
        hint: 'Retry once. If it keeps timing out, a serial driver of this machine may be stuck; ask the user to reconnect the board.',
      }));
    }, LIST_TIMEOUT_MS);
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', error => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new McpToolError('ENV_NOT_READY', `The serial helper could not start: ${error.message}`, {
        hint: 'Call check_environment to check the Python environment, then retry.',
      }));
    });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      stderr.end();
      resolve(code);
    });
  });

  const missing = events.find(event => event.code === 'pyserial_missing');
  if (missing) {
    throw pyserialMissing(missing.message);
  }
  if (exitCode !== 0) {
    throw new McpToolError('INTERNAL', `The serial helper failed to list the ports (exit code ${exitCode}): ${stderrLines.slice(-3).join(' ') || 'no output'}`);
  }
  try {
    const parsed = JSON.parse(stdout) as ListedPort[];
    return Array.isArray(parsed) ? parsed.filter(entry => entry && typeof entry.port === 'string') : [];
  } catch {
    throw new McpToolError('INTERNAL', 'The serial helper printed a port list that is not JSON.');
  }
}

function run(command: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise(resolve => {
    try {
      execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
        // lsof exits 1 when nothing holds the file; its output is still right.
        resolve(error && !stdout ? undefined : String(stdout));
      });
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * The processes holding a device, through lsof on Linux and macOS. Windows
 * has no equivalent without admin rights, and lsof may be missing, so this
 * answers an empty list rather than failing the call it explains.
 */
export async function findPortHolder(port: string, exceptPid?: number): Promise<PortHolder[]> {
  if (process.platform === 'win32' || !port.startsWith('/dev/')) {
    return [];
  }
  const out = await run('lsof', ['-t', '--', port], HOLDER_TIMEOUT_MS);
  const pids = [...new Set((out ?? '').split(/\s+/).map(Number).filter(pid => Number.isInteger(pid) && pid > 0 && pid !== exceptPid))];
  const holders: PortHolder[] = [];
  for (const pid of pids.slice(0, 5)) {
    const name = (await run('ps', ['-o', 'comm=', '-p', String(pid)], HOLDER_TIMEOUT_MS))?.trim();
    // A capture helper of another VS Code window shows up as just "Python";
    // its command line says it is one, so the agent can find and stop it.
    const commandLine = (await run('ps', ['-o', 'args=', '-p', String(pid)], HOLDER_TIMEOUT_MS)) ?? '';
    holders.push({
      pid,
      ...(name ? { name: path.basename(name) } : {}),
      ...(pid === process.pid ? { thisWindow: true } : {}),
      ...(/serial[\\/]serial_capture\.py/.test(commandLine) ? { workbenchCapture: true } : {}),
    });
  }
  return holders;
}

/**
 * Whether pyserial imports in a virtual environment, and its version, for
 * check_environment. Runs only an interpreter the workbench resolved itself.
 */
export function probePyserial(venvPath: string): Promise<{ installed: boolean; version?: string } | undefined> {
  const python = venvPythonPath(venvPath);
  if (!python || !fs.existsSync(python)) {
    return Promise.resolve(undefined);
  }
  return new Promise(resolve => {
    execFile(python, ['-c', 'import serial;print(serial.__version__)'], { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      const version = String(stdout ?? '').trim();
      if (error?.killed) {
        resolve(undefined); // Timed out: unknown rather than missing.
        return;
      }
      resolve(error ? { installed: false } : { installed: true, ...(version ? { version } : {}) });
    });
  });
}
