// Runs a workbench task so the user sees it live in a VS Code terminal and the
// agent gets the exit code and the output.
//
// VS Code has no stable API to read a ShellExecution task's output, so the task
// is re-expressed as a CustomExecution whose Pseudoterminal spawns the process
// itself. This is not a new idea here: `createWestUpdateTask`
// (src/commands/WestCommands.ts:162) already ships exactly this shape, and
// `runWestUpdateWithProgress` already reads the exit code back through
// `onDidEndTaskProcess`, which proves the mechanism on every supported
// platform.

import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { toTerminalText } from '../core/ansi';
import { getProfileEnv, killProcessTree } from '../../utils/execUtils';

/**
 * Set on the definition of every task an agent runs, so the check for a build
 * the user started by hand never mistakes an agent's own build for one.
 */
export const CAPTURED_TASK_MARKER = '__zwMcpCaptured';

export interface CaptureSink {
  onData(chunk: string): void;
}

export interface CapturedRun {
  /** The task to hand to vscode.tasks.executeTask. */
  task: vscode.Task;
  /**
   * Resolves with the process exit code. Undefined means the job was
   * cancelled. A process killed by a signal it was not sent by us is reported
   * as a non-zero code, never as success.
   */
  completed: Promise<number | undefined>;
  /** Resolves once VS Code has opened the terminal and the process started. */
  opened: Promise<void>;
  /**
   * True once the process really started. A run that was abandoned, cancelled
   * before VS Code opened the terminal, or failed to spawn never touched the
   * build directory, so nothing may be recorded about it.
   */
  started(): boolean;
  cancel(): void;
  /** Settle as failed without VS Code ever opening the terminal. */
  abandon(reason: string): void;
}

/**
 * Resolve the variables VS Code itself expands in terminal.integrated.env.
 * Copying the raw value would turn the common `"PATH": "${env:PATH}:/opt/x"`
 * into a literal "${env:PATH}", which breaks every tool lookup in the build.
 */
export function resolveTerminalEnv(
  configured: Record<string, string | null>, base: NodeJS.ProcessEnv, folder?: string,
): { set: Record<string, string>; unset: string[] } {
  const set: Record<string, string> = {};
  const unset: string[] = [];
  for (const [name, value] of Object.entries(configured)) {
    if (value === null) {
      // VS Code treats null as "remove this variable".
      unset.push(name);
      continue;
    }
    if (typeof value !== 'string') {
      continue;
    }
    set[name] = value
      .replace(/\$\{env:([^}]+)\}/g, (_m, key: string) => base[key] ?? '')
      .replace(/\$\{workspaceFolder\}/g, folder ?? '')
      .replace(/\$\{pathSeparator\}/g, process.platform === 'win32' ? '\\' : '/');
  }
  return { set, unset };
}

/** Environment VS Code would add for an integrated terminal, which a raw spawn misses. */
function terminalEnvironment(scope?: vscode.WorkspaceFolder): { set: Record<string, string>; unset: string[] } {
  const key = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
  const configured = vscode.workspace
    .getConfiguration('terminal.integrated.env', scope)
    .get<Record<string, string | null>>(key) ?? {};
  return resolveTerminalEnv(configured, process.env, scope?.uri.fsPath);
}

export interface TaskVariableContext {
  /** The task's scope folder, for ${workspaceFolder} and ${workspaceFolderBasename}. */
  folder?: string;
  userHome: string;
  /** Where ${env:NAME} is looked up. */
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (env[name] !== undefined || platform !== 'win32') {
    return env[name];
  }
  // Windows variable names ignore case, and a copied env loses that.
  const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/**
 * Resolve the variables a ShellExecution resolves before it spawns:
 * ${userHome}, ${workspaceFolder}, ${workspaceFolderBasename}, ${env:NAME}
 * (empty when unset, as VS Code does) and ${pathSeparator} or ${/}. Anything
 * else is left as it is: a shell expands ${HOME} itself, and a folder
 * variable with no folder stays visible instead of turning into nothing.
 */
export function resolveTaskVariables(value: string, context: TaskVariableContext): string {
  const platform = context.platform ?? process.platform;
  return value.replace(/\$\{([^}]+)\}/g, (match, name: string) => {
    if (name === 'userHome') {
      return context.userHome;
    }
    if (name === 'workspaceFolder') {
      return context.folder ?? match;
    }
    if (name === 'workspaceFolderBasename') {
      return context.folder ? path.basename(context.folder) : match;
    }
    if (name === 'pathSeparator' || name === '/') {
      return platform === 'win32' ? '\\' : '/';
    }
    if (name.startsWith('env:')) {
      return envValue(context.env, name.slice('env:'.length), platform) ?? '';
    }
    return match;
  });
}

/**
 * The environment a captured task runs with, layered as VS Code layers a task
 * terminal's: the extension host's own, terminal.integrated.env (whose null
 * entries remove a variable), the terminal profile's, then the task's. Then
 * the settings that keep a run from ever waiting on input nobody can type.
 */
export function capturedTaskEnv(layers: {
  base: NodeJS.ProcessEnv;
  terminal: { set: Record<string, string>; unset: string[] };
  profile?: Record<string, string>;
  task?: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = { ...(layers.base as Record<string, string>), ...layers.terminal.set };
  for (const name of layers.terminal.unset) {
    delete env[name];
  }
  Object.assign(env, layers.profile ?? {}, layers.task ?? {}, {
    // Unbuffered and UTF-8 so python-driven steps stream and decode cleanly.
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    // A build must never stop waiting for git credentials no one will type,
    // nor for the Git Credential Manager's sign-in window.
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  });
  // Nor for an SSH passphrase or host key prompt. A command the user set,
  // including the older GIT_SSH that GIT_SSH_COMMAND would override, is kept.
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) {
    env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  }
  return env;
}

/** How an agent's terminal shows: its own panel, never taking the focus. */
export function agentTaskPresentation(reveal?: vscode.TaskRevealKind): vscode.TaskPresentationOptions {
  return {
    echo: true,
    reveal: reveal ?? vscode.TaskRevealKind.Silent,
    focus: false,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
  };
}

/**
 * Re-express a resolved task as a captured one.
 *
 * The task keeps its definition, scope, name, source and problem matchers. The
 * definition matters: `ZephyrTaskProvider.resolve` stashes
 * `__westBuildStatePath` and `__westBuildState` on it, and
 * `executeTaskCollectExitCode` reads them back to persist the build state.
 * The name matters too, because `executeTask` matches its end event by name.
 */
export function toCapturedTask(resolved: vscode.Task, sink: CaptureSink, options: {
  reveal?: vscode.TaskRevealKind;
  header?: string;
} = {}): CapturedRun {
  const execution = resolved.execution;
  if (!(execution instanceof vscode.ShellExecution) || !execution.commandLine) {
    throw new Error('Only a resolved ShellExecution task can be captured.');
  }
  const shellOptions = execution.options ?? {};
  const scope = typeof resolved.scope === 'object' ? (resolved.scope as vscode.WorkspaceFolder) : undefined;
  // A ShellExecution gets its variables resolved by VS Code; a raw spawn has
  // to do it, or `cwd: "${userHome}"` (west init) would not even start.
  const variables: TaskVariableContext = { folder: scope?.uri.fsPath, userHome: os.homedir(), env: process.env };
  const commandLine = resolveTaskVariables(execution.commandLine, variables);
  const cwd = shellOptions.cwd === undefined ? scope?.uri.fsPath : resolveTaskVariables(shellOptions.cwd, variables);
  if (cwd?.includes('${')) {
    throw new Error(`"${resolved.name}" was not started: its working folder "${cwd}" uses a variable that only VS Code's own task runner can resolve.`);
  }
  const taskEnv = Object.fromEntries(Object.entries(shellOptions.env ?? {})
    .map(([name, value]) => [name, resolveTaskVariables(String(value), variables)]));

  const writeEmitter = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<number>();
  let child: ReturnType<typeof spawn> | undefined;
  let spawned = false;
  let closed = false;
  let cancelled = false;
  let settle: (code: number | undefined) => void = () => undefined;
  const completed = new Promise<number | undefined>(resolve => { settle = resolve; });
  let markOpened: () => void = () => undefined;
  const opened = new Promise<void>(resolve => { markOpened = resolve; });

  const finish = (code: number | undefined) => {
    if (closed) {
      return;
    }
    closed = true;
    closeEmitter.fire(code ?? 1);
    settle(cancelled ? undefined : code);
  };

  const cancel = () => {
    if (closed) {
      return;
    }
    cancelled = true;
    if (child && !child.killed) {
      killProcessTree(child);
      return;
    }
    finish(undefined);
  };

  const pty: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open: () => {
      markOpened();
      if (closed) {
        // The job was abandoned before VS Code got round to opening the
        // terminal. Starting the build now would run it with no lock held.
        writeEmitter.fire(toTerminalText('This agent task was abandoned before it started.\n'));
        closeEmitter.fire(1);
        return;
      }
      if (options.header) {
        writeEmitter.fire(toTerminalText(`${options.header}\n`));
      }
      writeEmitter.fire(toTerminalText(`${commandLine}\n\n`));

      const env = capturedTaskEnv({
        base: process.env,
        terminal: terminalEnvironment(scope),
        profile: getProfileEnv(),
        task: taskEnv,
      });

      try {
        child = spawn(shellOptions.executable ?? '/bin/sh', [...(shellOptions.shellArgs ?? []), commandLine], {
          cwd,
          env,
          // A process group is what makes killProcessTree work on POSIX.
          detached: process.platform !== 'win32',
          windowsVerbatimArguments: /cmd\.exe$/i.test(shellOptions.executable ?? ''),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        const message = `Failed to start: ${error instanceof Error ? error.message : String(error)}\n`;
        writeEmitter.fire(toTerminalText(message));
        sink.onData(message);
        finish(1);
        return;
      }

      // 'spawn' rather than spawn() returning: a missing shell or cwd still
      // returns a ChildProcess, which then only emits 'error'.
      child.on('spawn', () => { spawned = true; });

      const forward = (data: Buffer) => {
        const text = data.toString();
        writeEmitter.fire(toTerminalText(text));
        sink.onData(text);
      };
      child.stdout?.on('data', forward);
      child.stderr?.on('data', forward);
      child.on('error', error => {
        const message = `${error}\n`;
        writeEmitter.fire(toTerminalText(message));
        sink.onData(message);
        finish(1);
      });
      // A null code means the process died from a signal. Unless we sent it,
      // that is a failure: the OOM killer or a stray `kill` must never turn a
      // half-built tree into a reported success.
      child.on('close', (code, signal) => {
        if (code === null && signal && !cancelled) {
          const message = `\nThe process was killed by ${signal}.\n`;
          writeEmitter.fire(toTerminalText(message));
          sink.onData(message);
        }
        finish(code ?? (cancelled ? undefined : 1));
      });
    },
    // The terminal's trash icon lands here, so the user can always stop an agent.
    close: cancel,
  };

  const task = new vscode.Task(
    { ...resolved.definition, [CAPTURED_TASK_MARKER]: true },
    resolved.scope ?? vscode.TaskScope.Workspace,
    resolved.name,
    resolved.source,
    new vscode.CustomExecution(async () => pty),
    resolved.problemMatchers,
  );
  task.group = resolved.group;
  task.detail = resolved.detail;
  task.presentationOptions = agentTaskPresentation(options.reveal);

  const abandon = (reason: string) => {
    if (closed) {
      return;
    }
    sink.onData(`\n${reason}\n`);
    closed = true;
    settle(1);
  };

  return { task, completed, opened, cancel, abandon, started: () => spawned };
}
