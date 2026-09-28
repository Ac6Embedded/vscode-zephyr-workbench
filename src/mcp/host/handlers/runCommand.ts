// run_command: run a command line in the Zephyr environment of an
// application or a west workspace, as a job in a terminal the user watches,
// or write a script that sets up that environment for the agent's own shell.
// Each action accepts only its own arguments, so a misplaced one is refused
// instead of silently ignored.

import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { classifyShell, getShellArgs, isCygwin, TerminalEnvGroup } from '../../../utils/execUtils';
import { isPosixShellKind, quoteLiteralForShell } from '../../../utils/shellQuoting';
import { normalizeForCompare } from '../../core/argSafety';
import { McpToolError } from '../../core/errors';
import { DIR_MODE } from '../../core/paths';
import { logSafe, redactCommandLine } from '../../core/redact';
import { quoteForDialog } from '../../core/serialArgs';
import {
  RUN_COMMAND_ACTIONS, RUN_COMMAND_SHELLS, RUN_COMMAND_TIMEOUT_DEFAULT_SEC, RUN_COMMAND_TIMEOUT_MAX_SEC, RunCommandAction, RunCommandShell,
} from '../../core/tools/runCommand';
import { confirmCategoryOf, ToolContext, ToolHandler } from '../../core/toolSpec';
import { conflictOf, JobClaim, JobResource, writesOf } from '../../jobs/jobConflicts';
import { isWorking, JobManager, JobView } from '../../jobs/jobManager';
import { VERBATIM_COMMAND_MARKER } from '../capturedTask';
import { checkCwd, commandHost, CommandTarget, flatEnv, groupsFor, requireEnvScript, resolveCommandTarget, ShellChoice } from '../commandEnv';
import { buildsInFolder, checkCommand, installsInVenv } from '../commandPolicy';
import { composeRunCommandLine, kindOfShell, renderEnvScript, runCommandEnv, shellOfKind } from '../commandScripts';
import { ConfirmSubject, DIALOG_LINE_CHARS } from '../confirmations';
import { REVEAL } from './actions';
import { HostDeps } from './deps';
import { progressWait, remainingWaitMs } from './progress';

type Ctx = ToolContext<HostDeps>;

/** How much of a command the confirmation dialog shows; the terminal shows it whole. */
export const DIALOG_COMMAND_CHARS = 300;

/** Owner only, as every MCP file, and runnable, since running it is the point. */
const SCRIPT_MODE = 0o700;

const TARGET_ARGS = ['app_path', 'config_name', 'west_workspace'];

const ROUTES: Readonly<Record<RunCommandAction, {
  args: readonly string[];
  run(args: Record<string, unknown>, ctx: Ctx): Promise<unknown>;
}>> = {
  run: { args: ['command', ...TARGET_ARGS, 'cwd', 'timeout_sec', 'wait_sec'], run: runAction },
  env: { args: [...TARGET_ARGS, 'shell'], run: envAction },
};

export const runCommand: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const action = typeof args.action === 'string' ? args.action : '';
  const route = Object.prototype.hasOwnProperty.call(ROUTES, action) ? ROUTES[action as RunCommandAction] : undefined;
  if (!route) {
    throw new McpToolError('INVALID_ARGUMENT', `action must be one of ${RUN_COMMAND_ACTIONS.join(', ')}, not "${logSafe(action, 40)}".`);
  }
  const accepted = new Set(['action', ...route.args]);
  const unexpected = Object.keys(args).filter(key => args[key] !== undefined && !accepted.has(key));
  if (unexpected.length > 0) {
    throw new McpToolError('INVALID_ARGUMENT', `action "${action}" does not take ${unexpected.join(', ')}.`, {
      details: { accepted: [...accepted] },
    });
  }
  return route.run(args, ctx);
};

// run

function timeoutOf(value: unknown): number {
  if (value === undefined) {
    return RUN_COMMAND_TIMEOUT_DEFAULT_SEC;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > RUN_COMMAND_TIMEOUT_MAX_SEC) {
    throw new McpToolError('INVALID_ARGUMENT', `timeout_sec must be a whole number of seconds from 1 to ${RUN_COMMAND_TIMEOUT_MAX_SEC}.`);
  }
  return value;
}

/** The command as the dialog shows it: quoted, control characters escaped, and cut when long. */
export function commandForDialog(command: string): string {
  return command.length > DIALOG_COMMAND_CHARS
    ? `${quoteForDialog(command.slice(0, DIALOG_COMMAND_CHARS))}... (${command.length} characters, shown whole below)`
    : quoteForDialog(command);
}

/** The line the dialog shows the whole command on, when the summary cuts it. */
const commandLineOfDialog = (command: string) => `Command: ${quoteForDialog(command)}`;

/**
 * Refuse a command the dialog could not show whole, before asking: the user
 * must never approve a part they could not read. The dialog escapes every
 * character beyond ASCII in six, so this depends on more than the length.
 */
function checkDialogFits(command: string, ctx: Ctx, args: Record<string, unknown>): void {
  const asked = !!confirmCategoryOf(ctx.tool, args) && ctx.deps.permissionOf(ctx.tool) === 'ask';
  const shown = commandLineOfDialog(command).length;
  if (asked && command.length > DIALOG_COMMAND_CHARS && shown > DIALOG_LINE_CHARS) {
    throw new McpToolError('INVALID_ARGUMENT', `command is too long to show whole in the confirmation dialog the user approves it in (${shown} characters as shown, more than ${DIALOG_LINE_CHARS}).`, {
      hint: 'Put the commands in a script file inside the application and run the script.',
    });
  }
}

const RESOURCE_NOUN: Record<JobResource | 'lock', string> = {
  build_dir: 'build folder',
  west_workspace: 'west workspace',
  venv: 'Python environment',
  lock: 'resource',
};

/**
 * Refuse before asking the user when a job writes what the command reads,
 * such as a west update of its west workspace, or uses the build folder the
 * command builds in or the venv it installs into. The job manager would
 * refuse it too, but only after the user said yes.
 */
function refuseConflicts(jobs: JobManager, claim: JobClaim): void {
  for (const holder of jobs.list()) {
    const shared = isWorking(holder) ? conflictOf(claim, holder.spec) : undefined;
    if (shared) {
      const what = shared === 'build_dir'
        ? 'is using the build folder this command builds in'
        : shared !== 'lock' && !writesOf(holder.spec).has(shared)
          ? `is using the ${RESOURCE_NOUN[shared]} this command changes`
          : `is changing the ${RESOURCE_NOUN[shared]} this command uses`;
      throw new McpToolError('BUSY', `A ${holder.spec.kind} job (job_id "${holder.id}") ${what}.`, {
        hint: `Wait for it with job {"action": "status", "job_id": "${holder.id}"}, then run the command again.`,
        details: { job_id: holder.id, kind: holder.spec.kind, status: holder.status },
      });
    }
  }
}

/**
 * The task a run starts: the agent's command behind the environment script,
 * in the terminal shell, with the variables of the Zephyr terminal. The
 * definition is unique, so VS Code never offers to restart one command for
 * another of the same name.
 */
export function commandTask(options: {
  name: string; commandLine: string; shell: ShellChoice; kind: string; cwd: string;
  env: Record<string, string>; scope?: vscode.WorkspaceFolder; id: string;
}): vscode.Task {
  // As ZephyrTaskProvider starts its tasks: Cygwin's bash needs a login shell.
  const shellArgs = isCygwin(options.shell.path) ? ['--login', '-i', ...getShellArgs(options.kind)] : getShellArgs(options.kind);
  const execution = new vscode.ShellExecution(options.commandLine, {
    executable: options.shell.path, shellArgs, cwd: options.cwd, env: options.env,
  });
  return new vscode.Task(
    // Verbatim: ${env:PATH} in the agent's command is the shell's to expand, as the dialog shows it.
    { type: 'zephyr-workbench-shell', label: options.name, __commandId: options.id, [VERBATIM_COMMAND_MARKER]: true },
    options.scope ?? vscode.TaskScope.Workspace,
    options.name,
    'Zephyr Workbench',
    execution,
  );
}

async function runAction(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  const { services, jobs } = ctx.deps;
  const shell = commandHost.terminalShell();
  const kind = classifyShell(shell.path);
  const shellName = shellOfKind(kind);
  const command = checkCommand(args.command, kind);
  checkDialogFits(command, ctx, args);
  const timeoutSec = timeoutOf(args.timeout_sec);
  const waitSec = typeof args.wait_sec === 'number' ? args.wait_sec : ctx.deps.defaultWaitSeconds;

  const target = await resolveCommandTarget(services, args);
  const envScript = requireEnvScript(target, kind);
  const cwd = args.cwd === undefined ? target.cwdDefault : await checkCwd(services, String(args.cwd));
  const groups = groupsFor(target, shell);

  const id = randomBytes(6).toString('hex');
  // Only read: a west update of the workspace or a rebuild of the venv and
  // the command wait for each other, while a build goes on beside it. A build
  // writes its folder, so naming the build folder here would make every
  // command wait for every build of the configuration. A command that builds
  // writes it too, so it names it, and waits for and blocks the jobs on it.
  // A pip install or uninstall writes the venv in the same way, and may
  // replace a package a build or another install is importing.
  // The key is unique, so two commands never share a job.
  const builds = target.buildDir !== undefined && buildsInFolder(command);
  const installs = target.venvPath !== undefined && installsInVenv(command);
  const writes: JobResource[] = [...(builds ? ['build_dir' as const] : []), ...(installs ? ['venv' as const] : [])];
  const claim: JobClaim = {
    kind: 'run',
    lockKey: `command:${id}`,
    ...(target.westWorkspace ? { westWorkspace: target.westWorkspace } : {}),
    ...(target.venvPath ? { venvPath: target.venvPath } : {}),
    ...(builds ? { buildDir: target.buildDir } : {}),
    ...(writes.length > 0 ? { writes } : {}),
  };
  refuseConflicts(jobs, claim);
  // As build_app does: a task the user runs on the configuration keeps a build out.
  const refuseExternal = () => {
    const external = builds && target.appPath && target.configName ? services.externalRun(target.appPath, target.configName) : undefined;
    if (external) {
      throw new McpToolError('BUSY_EXTERNAL', `"${external.task.name}" is running for ${target.configName}, started from VS Code.`, {
        hint: 'Wait for it to finish in its terminal, then run the command again.',
      });
    }
  };
  refuseExternal();

  const task = commandTask({
    name: `${target.label} Command`,
    commandLine: composeRunCommandLine(kind, envScript, command),
    shell, kind, cwd, env: { ...flatEnv(groups), ...runCommandEnv(kind, command) }, scope: target.taskScope, id,
  });

  // The whole command is part of the subject, so an answer given late to one
  // command is never taken for another; Allow for This Session covers the
  // commands of this application or west workspace.
  const subject: ConfirmSubject & { command: string; cwd: string } = {
    summary: `run ${commandForDialog(command)} in ${logSafe(cwd, 300)}`,
    ...(target.appPath ? { appPath: target.appPath } : {}),
    ...(target.configName ? { configName: target.configName } : {}),
    ...(target.board ? { board: target.board } : {}),
    folder: cwd,
    scope: target.scope,
    scopeLabel: target.scopeLabel,
    // The summary shortens a long command; the dialog still shows all of it,
    // since checkDialogFits refused one too long for this line.
    ...(command.length > DIALOG_COMMAND_CHARS ? { lines: [commandLineOfDialog(command)] } : {}),
    command,
    cwd,
  };
  const outcome = await ctx.deps.confirmations.require(ctx, args, subject);
  // Read again: the dialog may have stayed open for a while.
  refuseExternal();

  const { job } = jobs.start({
    ...claim,
    requestKey: `command:${id}`,
    ...(target.appPath ? { appPath: target.appPath } : {}),
    ...(target.configName ? { configName: target.configName } : {}),
    parse: false,
    command: redactCommandLine(command),
    run: async (sink, signal) => {
      // A job cancel and the timeout both stop the command with its process
      // tree, as the terminal's trash icon does on its own.
      const controller = new AbortController();
      const stop = () => controller.abort();
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) {
        stop();
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        sink.onData(`\nStopped after ${timeoutSec} seconds, the timeout_sec of this command.\n`);
        controller.abort();
      }, timeoutSec * 1000);
      try {
        const { exitCode } = await commandHost.runTask(task, sink, controller.signal, {
          reveal: REVEAL[ctx.deps.revealTerminal] ?? vscode.TaskRevealKind.Silent,
          header: `> [agent ${ctx.client.name ?? 'mcp'}] ${logSafe(command, 1000)}`,
        });
        return { exitCode, extra: { shell: shellName, cwd, timed_out: timedOut } };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
      }
    },
    next: (view: JobView) => (view.result?.timed_out === true
      ? `Stopped after ${timeoutSec} seconds by timeout_sec. Read the whole output with job {"action": "log", "job_id": "${view.job_id}"}, and pass a larger timeout_sec if the command needs longer.`
      : view.next),
  });
  ctx.audit.jobId = job.id;

  await jobs.wait(job, remainingWaitMs(ctx, waitSec), progressWait(ctx, jobs));
  const view = jobs.view(job);
  return {
    ...view,
    // Named while the job still runs too, when it has no result of its own yet.
    result: { shell: shellName, cwd, timed_out: false, ...view.result },
    ...(outcome === 'not-required' || outcome === 'not-asked' ? {} : { confirmation: { category: ctx.audit.confirmCategory, outcome } }),
  };
}

// env

const EXTENSION: Record<RunCommandShell, string> = { bash: 'sh', zsh: 'sh', powershell: 'ps1', cmd: 'bat' };

/**
 * Where the script of a target and shell lives: under the MCP home folder,
 * named after the target so a user can tell the files apart, with a hash so
 * the same target and shell always get the same file.
 */
export function envScriptPath(dir: string, target: CommandTarget, shell: RunCommandShell): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([target.kind, normalizeForCompare(target.scope), target.configName ?? '', shell]))
    .digest('hex')
    .slice(0, 12);
  const slug = target.label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'env';
  return path.join(dir, `${slug}-${hash}.${EXTENSION[shell]}`);
}

/** How to run the script, from any shell, for the result and the script's header. */
function usageOf(shell: RunCommandShell, file: string, terminalKind: string): string {
  const kind = kindOfShell(shell);
  if (isPosixShellKind(kind)) {
    const posix = file.replace(/\\/g, '/');
    return `${shell} ${quoteLiteralForShell(kind, posix) ?? `"${posix}"`} west boards`;
  }
  if (kind === 'cmd.exe') {
    return `"${file}" west boards`;
  }
  // Windows PowerShell is powershell; PowerShell 7 and every other system have pwsh.
  const exe = terminalKind === 'pwsh.exe' || process.platform !== 'win32' ? 'pwsh' : 'powershell';
  return `${exe} -NoProfile -ExecutionPolicy Bypass -File "${file}" west boards`;
}

/**
 * Write the script whole or not at all, and only when it changed. A new file
 * replaces the old one, which bash and PowerShell have read or keep open, but
 * cmd reopens a running batch file by name: renderEnvScript ends it so that
 * cmd reads nothing more once the command started.
 */
function writeScript(file: string, content: string): void {
  try {
    if (fs.readFileSync(file, 'utf8') === content) {
      return;
    }
  } catch {
    // Not written yet.
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: SCRIPT_MODE });
    fs.chmodSync(temporary, SCRIPT_MODE);
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw new McpToolError('INTERNAL', `Could not write the environment script ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const variableNames = (groups: TerminalEnvGroup[]) => [...new Set(groups.flatMap(group => Object.keys(group.env)))];

async function envAction(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  const requested = args.shell;
  if (requested !== undefined && !(RUN_COMMAND_SHELLS as readonly unknown[]).includes(requested)) {
    throw new McpToolError('INVALID_ARGUMENT', `shell must be one of ${RUN_COMMAND_SHELLS.join(', ')}.`);
  }
  const terminalKind = classifyShell(commandHost.terminalShell().path);
  const shell = (requested as RunCommandShell | undefined) ?? shellOfKind(terminalKind);
  const kind = kindOfShell(shell);

  const target = await resolveCommandTarget(ctx.deps.services, args);
  const envScript = requireEnvScript(target, kind);
  // The builders only look at the kind of shell, to write paths in its form.
  const groups = groupsFor(target, { path: kind });
  const file = envScriptPath(commandHost.envDir(), target, shell);
  const usage = usageOf(shell, file, terminalKind);
  writeScript(file, renderEnvScript(kind, {
    subject: target.label, groups, envScript, usage, basePath: process.env.PATH,
  }));
  ctx.audit.target = {
    ...(target.appPath ? { app_path: target.appPath } : {}),
    ...(target.configName ? { config_name: target.configName } : {}),
    folder: target.scope,
  };
  return {
    action: 'env',
    path: file,
    shell,
    usage,
    env_script: envScript,
    variables: variableNames(groups),
    cwd_default: target.cwdDefault,
    next: `Run a command from your own shell with: ${usage}.${shell === 'powershell'
      ? ' PowerShell passes -NAME:VALUE as two arguments, so write CMake options as -DNAME=value, not -DNAME:TYPE=value.'
      : ''} The script is rewritten by each env call, so call run_command with action "env" again after the build configuration or the west workspace changes.`,
  };
}
