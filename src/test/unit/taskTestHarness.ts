// Shared by the task builder tests: the pre-split task-building code, kept
// only as the reference the builders are compared against, and a harness that
// records the tasks a command runs. Not a *.test.ts file, so mocha only loads
// it through the tests that import it.

import * as path from 'path';
import * as vscode from 'vscode';
import { buildEnvSourcedShellCommand, getProfileEnv, getShellExe } from '../../utils/execUtils';

type Settings = Record<string, unknown>;
// The raw stub module, whose exports are swapped for the tests' duration.
const stub = require('vscode') as Record<string, any>;

/** The body of execShellCommand before the split, minus running the task. */
export function legacyShellTask(cmdName: string, cmd: string, options: vscode.ShellExecutionOptions): vscode.Task {
  if (!cmd) {
    throw new Error('Missing command to execute');
  }
  const shExec = new vscode.ShellExecution(cmd, options);
  const task = new vscode.Task(
    { label: cmdName, type: 'zephyr-workbench-shell' },
    vscode.TaskScope.Workspace,
    cmdName,
    'Zephyr Workbench',
    shExec
  );
  task.presentationOptions.echo = true;
  return task;
}

/** The body of execShellCommandWithEnv before the split, minus running the task. */
export function legacyEnvSourcedShellTask(
  cmdName: string,
  cmd: string,
  options: vscode.ShellExecutionOptions,
  executableOverride?: string,
): vscode.Task {
  const prepared = buildEnvSourcedShellCommand(cmd, options.cwd, executableOverride ?? getShellExe());
  options.executable = prepared.executable;
  options.shellArgs = prepared.shellArgs;

  options.env = {
    ...(prepared.needsChere ? { CHERE_INVOKING: '1' } : {}),
    ...getProfileEnv(),
    ...options.env,
    ...(prepared.venvPath ? { PYTHON_VENV_PATH: prepared.venvPath } : {})
  };
  return legacyShellTask(cmdName, prepared.command, options);
}

/** Everything VS Code reads from a shell task, as plain data. */
export function describeTask(task: vscode.Task) {
  const execution = task.execution as vscode.ShellExecution;
  return {
    definition: task.definition,
    scope: task.scope,
    name: task.name,
    source: task.source,
    problemMatchers: task.problemMatchers,
    presentationOptions: task.presentationOptions,
    commandLine: execution.commandLine,
    options: execution.options,
  };
}

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

class TestUri {
  constructor(readonly fsPath: string) {}
  static file(fsPath: string) { return new TestUri(fsPath); }
  static joinPath(base: { fsPath: string }, ...parts: string[]) { return new TestUri(path.join(base.fsPath, ...parts)); }
  toString(): string { return `file://${this.fsPath}`; }
}

export interface TaskHarness {
  /** Replaces the settings every getConfiguration(section) reads, keyed "section.key". */
  set(next: Settings): void;
  /** The tasks started through vscode.tasks.executeTask, in order. */
  launched: vscode.Task[];
}

/**
 * For the enclosing describe: settings, a class Uri (the settings reader tests
 * `instanceof vscode.Uri`), and a task API that records each task and ends it
 * at once. The user's shell (vscode.env.shell) is restored afterwards.
 */
export function useTaskHarness(): TaskHarness {
  let settings: Settings = {};
  const launched: vscode.Task[] = [];
  const saved: Record<string, unknown> = {};
  before(() => {
    saved.Uri = stub.Uri;
    saved.getConfiguration = stub.workspace.getConfiguration;
    saved.tasks = stub.tasks;
    saved.shell = stub.env.shell;
    stub.Uri = TestUri;
    stub.workspace.getConfiguration = (section?: string) => ({
      get: (key: string, fallback?: unknown) => settings[section ? `${section}.${key}` : key] ?? fallback,
      update: async () => undefined,
    });
    stub.tasks = {
      ...(saved.tasks as object),
      executeTask: async (task: vscode.Task) => {
        launched.push(task);
        return { task };
      },
      onDidEndTask: (listener: (event: unknown) => void) => {
        setImmediate(() => listener({ execution: { task: launched[launched.length - 1] } }));
        return { dispose() {} };
      },
    };
  });
  after(() => {
    stub.Uri = saved.Uri;
    stub.workspace.getConfiguration = saved.getConfiguration;
    stub.tasks = saved.tasks;
    stub.env.shell = saved.shell;
  });
  beforeEach(() => {
    launched.length = 0;
    settings = {};
  });
  return { set: next => { settings = next; }, launched };
}

/**
 * Runs `work` with process.platform reading `platform`, so the Windows
 * terminal-profile shell resolution can be exercised on any host.
 */
export async function withPlatform<T>(platform: NodeJS.Platform, work: () => T | Promise<T>): Promise<T> {
  const saved = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await work();
  } finally {
    if (saved) {
      Object.defineProperty(process, 'platform', saved);
    }
  }
}
