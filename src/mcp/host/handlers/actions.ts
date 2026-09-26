// Long actions. Each one starts a job, waits a bounded time, then hands back a
// handle, because every agent kills a tool call on a timeout of its own.

import * as vscode from 'vscode';
import { ZephyrApplication } from '../../../models/ZephyrApplication';
import { buildDirectTask, createCppPropertiesCompileCommandsRefresh } from '../../../providers/ZephyrTaskProvider';
import { getConfiguredVenvPath } from '../../../utils/execUtils';
import { syncIntellisenseAfterBuild } from '../../../utils/intellisense/intellisenseSync';
import { WestBuildState, writeWestBuildState } from '../../../utils/zephyr/westBuildState';
import { McpToolError, toToolError } from '../../core/errors';
import { redactCommandLine } from '../../core/redact';
import { ToolContext, ToolHandler } from '../../core/toolSpec';
import { findExternalRun } from '../buildConflicts';
import { runCapturedTask } from '../taskRunner';
import { HostDeps } from './deps';
import { progressWait } from './progress';

type Ctx = ToolContext<HostDeps>;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);

export const REVEAL: Record<string, vscode.TaskRevealKind> = {
  always: vscode.TaskRevealKind.Always,
  silent: vscode.TaskRevealKind.Silent,
  never: vscode.TaskRevealKind.Never,
};

/**
 * `executeTaskCollectExitCode` persists the west build state on task end, and
 * it does so whatever the exit code. The captured path does not go through that
 * helper, so it has to keep the same promise or the next UI build would
 * reconfigure for no reason.
 */
export function persistBuildState(definition: vscode.TaskDefinition): void {
  const statePath = (definition as Record<string, unknown>).__westBuildStatePath;
  const state = (definition as Record<string, unknown>).__westBuildState;
  if (typeof statePath === 'string' && typeof state === 'string') {
    try {
      writeWestBuildState(statePath, JSON.parse(state) as WestBuildState);
    } catch {
      // Malformed metadata must never fail the build that produced it.
    }
  }
}

/** Keep IntelliSense in step, exactly as a build from the Applications view does. */
async function afterBuild(
  app: ZephyrApplication, configName: string, boardIdentifier: string,
  refreshCppProperties: () => Promise<void>, sink: { onData(chunk: string): void },
): Promise<void> {
  try {
    await refreshCppProperties();
    await syncIntellisenseAfterBuild(app.appWorkspaceFolder, configName, boardIdentifier);
  } catch (error) {
    // IntelliSense is a convenience. It must never turn a good build into a failure.
    sink.onData(`\nIntelliSense was not refreshed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

export const buildApp: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const { services, jobs, defaultWaitSeconds } = ctx.deps;
  const { app, config, buildDir } = await services.resolveTarget(str(args.app_path), str(args.config_name));
  const pristine = str(args.pristine) === 'always';
  const cmakeOnly = bool(args.cmake_only) ?? false;
  const waitSec = num(args.wait_sec) ?? defaultWaitSeconds;

  const taskName = cmakeOnly ? 'Configure (CMake only)' : pristine ? 'West Rebuild' : 'West Build';

  let resolved: vscode.Task | undefined;
  try {
    resolved = buildDirectTask(app.appWorkspaceFolder, taskName, config.name, {}, app);
  } catch (error) {
    // `ZephyrTaskProvider.resolve` throws for a missing environment script and
    // for an unlinked west-workspace application, which map to real codes.
    throw toToolError(error);
  }
  if (!resolved) {
    throw new McpToolError('INVALID_ARGUMENT', `Cannot build "${config.name}" with task "${taskName}".`, {
      hint: 'Check that the configuration has a board set, and that the task is supported for this configuration.',
    });
  }
  const task = resolved;

  const external = findExternalRun(app.appRootPath, config.name);
  if (external) {
    throw new McpToolError('BUSY_EXTERNAL', `"${external.task.name}" is already running for ${config.name}, started from VS Code.`, {
      hint: 'Wait for it to finish in its terminal, then call build_app again.',
    });
  }
  // Deleting every build folder locks <app>/build, not the folder of each
  // configuration, so a deletion covering this one is looked for here.
  const deleting = jobs.runningOverlapping(buildDir).find(running => running.spec.kind === 'clean');
  if (deleting) {
    throw new McpToolError('BUSY', `The build folder of ${config.name} is being deleted (job_id "${deleting.id}").`, {
      hint: `Wait for it with job {"action": "status", "job_id": "${deleting.id}"}, then call build_app again.`,
      details: { job_id: deleting.id, kind: deleting.spec.kind },
    });
  }

  // The venv the build task activates, with the precedence ZephyrTaskProvider.resolve uses.
  const venvPath = app.venvPath ?? getConfiguredVenvPath(app.appWorkspaceFolder);
  const { job, attached } = jobs.start({
    kind: 'build',
    lockKey: buildDir,
    requestKey: `build:${buildDir}:${taskName}`,
    appPath: app.appRootPath,
    configName: config.name,
    buildDir,
    // Read for the whole build, so a west update or a venv rebuild waits for it.
    ...(app.westWorkspaceRootPath ? { westWorkspace: app.westWorkspaceRootPath } : {}),
    ...(venvPath ? { venvPath } : {}),
    command: redactCommandLine((task.execution as vscode.ShellExecution)?.commandLine ?? taskName),
    run: async (sink, signal) => {
      // Taken before the build: the refresher only acts when the build
      // creates compile_commands.json, which it detects by comparing.
      const refreshCppProperties = app.intellisenseProvider === 'clangd'
        ? async () => undefined
        : await createCppPropertiesCompileCommandsRefresh(app.appWorkspaceFolder).catch(() => async () => undefined);

      // A pristine build deletes the build folder first. An agent Kconfig
      // session working inside it would keep a file open there, which makes
      // the deletion fail halfway on Windows, so those sessions are stopped
      // and none may start there until the build has ended.
      const reopenKconfig = pristine ? await ctx.deps.kconfig.closeWithin(buildDir) : () => undefined;
      let run: { exitCode: number | undefined; started: boolean };
      try {
        run = await runCapturedTask(task, sink, signal, {
          reveal: REVEAL[ctx.deps.revealTerminal] ?? vscode.TaskRevealKind.Silent,
          header: `> [agent ${ctx.client.name ?? 'mcp'}] ${taskName} [${config.name}]`,
        });
      } finally {
        reopenKconfig();
      }
      const { exitCode, started } = run;
      // Only a build that really ran may be recorded: persisting the state of
      // one that never started would make the next build skip reconfiguring.
      if (started) {
        persistBuildState(task.definition);
        if (exitCode !== undefined) {
          await afterBuild(app, config.name, config.boardIdentifier, refreshCppProperties, sink);
        }
      }
      return { exitCode };
    },
  });

  await jobs.wait(job, waitSec * 1000, progressWait(ctx, jobs));
  return jobs.view(job, { attached });
};
