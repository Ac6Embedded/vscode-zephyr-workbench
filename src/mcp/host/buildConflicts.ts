// Keeps an agent build and a build the user started from writing one build
// directory at the same time, in both directions, and keeps the user's tasks
// out of a build folder an agent is deleting.
//
// Agent second: build_app refuses with BUSY_EXTERNAL while a matching VS Code
// task runs (findExternalRun). User second: every workbench launch path asks
// before starting (guardTaskLaunches), and a task started some other way, such
// as Ctrl+Shift+B or the Run Task picker, is caught as it starts
// (watchBuildConflicts). Both cover agent deletions too: a workbench task
// launched while an agent deletes its build folder waits for the deletion to
// end, and one started some other way gets a warning, since a deletion cannot
// be stopped halfway. An agent changing a west workspace (west update, a
// deletion) is treated the same way for every task that works in it.

import * as vscode from 'vscode';
import { ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY } from '../../constants';
import { taskAppRootPath, ZephyrTaskProvider } from '../../providers/ZephyrTaskProvider';
import { getConfiguredWorkbenchPath, setTaskLaunchGuard } from '../../utils/execUtils';
import { isInside, normalizeForCompare } from '../core/argSafety';
import { isTerminal, isWorking, JobManager, JobState } from '../jobs/jobManager';
import { CAPTURED_TASK_MARKER } from './capturedTask';

/** True when `task` is a workbench task on this application and configuration. */
export function taskTouchesConfig(task: vscode.Task, appRootPath: string, configName: string): boolean {
  const { definition, scope, group } = task;
  if (definition.type !== ZephyrTaskProvider.ZephyrType || definition[CAPTURED_TASK_MARKER]) {
    return false;
  }
  const folder = typeof scope === 'object' ? scope : undefined;
  const owner = taskAppRootPath(definition, folder) ?? folder?.uri.fsPath;
  if (!owner || normalizeForCompare(owner) !== normalizeForCompare(appRootPath)) {
    return false;
  }
  // A tasks.json entry with no configuration counts only when it is a build.
  return typeof definition.config === 'string'
    ? definition.config === configName
    : group?.id === vscode.TaskGroup.Build.id;
}

/** A task the user started on this application and configuration, if one runs. */
export function findExternalRun(appRootPath: string, configName: string): vscode.TaskExecution | undefined {
  return vscode.tasks.taskExecutions.find(execution => taskTouchesConfig(execution.task, appRootPath, configName));
}

/** An agent build, or an analysis or other task run in a build folder, on this task's configuration. */
function runningAgentBuildFor(jobs: JobManager, task: vscode.Task) {
  return jobs.list().find(job =>
    job.status === 'running' && (job.spec.kind === 'build' || job.spec.kind === 'task')
    && job.spec.appPath && job.spec.configName
    && taskTouchesConfig(task, job.spec.appPath, job.spec.configName));
}

/** A folder a user task works in, as far as west workspaces go. */
export interface TaskWestWorkspace {
  path: string;
  /**
   * True for a folder a shell task is given, which puts the task in a west
   * workspace only from inside it: Create Venv and the host and debug tools
   * installs run from the home folder, which holds west workspaces without
   * using them.
   */
  insideOnly: boolean;
}

/** The option the venv installers (install.sh, install-mac.sh, install.ps1) take the venv to create with. */
const INSTALLER_VENV_PATH = /(?:^|\s)(?:--venv-path|-VenvPath)\s+(?:"([^"]+)"|'([^']+)'|([^\s"']+))/;

/**
 * The folders a workbench shell task is given: its working folder (west
 * update, blobs and the like run there), the Zephyr tree it reads
 * (ZEPHYR_BASE) and the venv an installer creates. Create Venv runs from the
 * home folder, so only the last two tie it to the west workspace whose
 * requirements it installs or which holds the venv it writes.
 */
function shellTaskFolders(execution: vscode.ShellExecution | undefined): string[] {
  const commandLine = execution?.commandLine;
  const venv = typeof commandLine === 'string' ? INSTALLER_VENV_PATH.exec(commandLine) : null;
  return [execution?.options?.cwd, execution?.options?.env?.ZEPHYR_BASE, venv?.[1] ?? venv?.[2] ?? venv?.[3]]
    .filter((folder): folder is string => typeof folder === 'string' && folder !== '' && !folder.includes('${'));
}

/**
 * The west workspace folders a user task works in: the folders a workbench
 * shell task is given, or for a Zephyr task the west workspace its
 * application builds with, which for an application of the workspace is its
 * folder and for a freestanding one is its setting.
 */
export function westWorkspacesOfTask(task: vscode.Task): TaskWestWorkspace[] {
  const { definition } = task;
  if (definition[CAPTURED_TASK_MARKER]) {
    return [];
  }
  const folder = typeof task.scope === 'object' ? (task.scope as vscode.WorkspaceFolder) : undefined;
  if (definition.type === 'zephyr-workbench-shell') {
    return shellTaskFolders(task.execution as vscode.ShellExecution | undefined)
      .map(folderPath => ({ path: folderPath, insideOnly: true }));
  }
  if (definition.type !== ZephyrTaskProvider.ZephyrType || !folder) {
    return [];
  }
  let configured: string | undefined;
  try {
    configured = getConfiguredWorkbenchPath(ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY, folder);
  } catch {
    configured = undefined;
  }
  return [{ path: configured ?? folder.uri.fsPath, insideOnly: false }];
}

/**
 * An agent job changing the west workspace this task works in, such as west
 * update rewriting its modules or a deletion removing it. A user build started
 * meanwhile would compile half-updated sources.
 */
function runningAgentWestWorkFor(jobs: JobManager, task: vscode.Task) {
  const used = westWorkspacesOfTask(task);
  if (used.length === 0) {
    return undefined;
  }
  return jobs.list().find(job => {
    const root = job.spec.westWorkspace;
    return isWorking(job) && !!root && (job.spec.writes ?? []).includes('west_workspace')
      && used.some(folder => isInside(folder.path, root) || (!folder.insideOnly && isInside(root, folder.path)));
  });
}

/**
 * An agent deleting a build folder this task uses, if one is. A cancelled
 * deletion counts until it has really ended: removing files cannot be aborted,
 * so the job is marked cancelled while they are still being removed.
 */
function runningAgentDeletionFor(jobs: JobManager, task: vscode.Task) {
  return jobs.list().find(job => {
    const working = !isTerminal(job.status) || job.endedAt === undefined;
    if (!working || job.spec.kind !== 'clean' || !job.spec.appPath) {
      return false;
    }
    // Deleting every build folder names no configuration, so it covers
    // whichever one the task uses.
    const configName = job.spec.configName
      ?? (typeof task.definition.config === 'string' ? task.definition.config : '');
    return taskTouchesConfig(task, job.spec.appPath, configName);
  });
}

/**
 * Wait until a deletion has really ended, showing a notification the user can
 * cancel. There is no time limit: the user asked for the task to run, so it
 * runs once the folder is gone, unless the user stops waiting. jobs.wait does
 * not fit: it returns at once for a cancelled job whose files are still being
 * removed.
 */
async function waitForDeletion(deleting: JobState): Promise<boolean> {
  return waitForJobEnd(deleting, `Waiting for the AI agent to finish deleting ${deleting.spec.buildDir}`);
}

/**
 * Wait until a job's process has really exited, not merely been told to stop:
 * a cancelled build keeps writing its folder until then. The user can stop
 * waiting, which leaves their task unstarted.
 */
async function waitForJobEnd(job: JobState, title: string): Promise<boolean> {
  const deleting = job;
  if (deleting.endedAt !== undefined) {
    return true;
  }
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title,
    cancellable: true,
  }, async (_progress, token) => {
    let listener: vscode.Disposable | undefined;
    const stopped = new Promise<void>(resolve => {
      listener = token.onCancellationRequested(() => resolve());
      if (token.isCancellationRequested) {
        resolve();
      }
    });
    try {
      await Promise.race([deleting.done, stopped]);
    } finally {
      listener?.dispose();
    }
    // Stopping the wait leaves the task unstarted, as declining the dialog does.
    return deleting.endedAt !== undefined;
  });
}

/**
 * Before a workbench task starts on a configuration an agent is building, ask.
 * Stopping the agent build waits for it to end, so the two never overlap;
 * declining leaves the user's task unstarted.
 */
export function guardTaskLaunches(jobs: JobManager): vscode.Disposable {
  setTaskLaunchGuard(async task => {
    // A deletion cannot be stopped halfway, so the task can only wait for it.
    const deleting = runningAgentDeletionFor(jobs, task);
    if (deleting) {
      const wait = 'Wait and Run';
      const choice = await vscode.window.showWarningMessage(
        'An AI agent is deleting a build folder right now.',
        { modal: true, detail: `"${task.name}" uses ${deleting.spec.buildDir}, so it has to wait until the deletion ends.` },
        wait,
      );
      if (choice !== wait) {
        return false;
      }
      return waitForDeletion(deleting);
    }
    // A west workspace change cannot be stopped halfway either: an
    // interrupted west update leaves the modules half checked out.
    const westWork = runningAgentWestWorkFor(jobs, task);
    if (westWork) {
      const wait = 'Wait and Run';
      const choice = await vscode.window.showWarningMessage(
        `An AI agent is changing the west workspace ${westWork.spec.westWorkspace} right now.`,
        { modal: true, detail: `"${task.name}" uses that west workspace, so it has to wait until the agent is done.` },
        wait,
      );
      if (choice !== wait) {
        return false;
      }
      return waitForJobEnd(westWork, `Waiting for the AI agent to finish with ${westWork.spec.westWorkspace}`);
    }
    const running = runningAgentBuildFor(jobs, task);
    if (!running) {
      return true;
    }
    const stop = 'Stop Agent Build and Run';
    const choice = await vscode.window.showWarningMessage(
      `An AI agent is building ${running.spec.configName} right now.`,
      { modal: true, detail: `"${task.name}" uses the same build folder, so running both would break them.` },
      stop,
    );
    if (choice !== stop) {
      return false;
    }
    jobs.cancel(running.id);
    // jobs.wait returns as soon as the status says cancelled; the build
    // process may still be writing the folder, so wait for it to exit.
    return waitForJobEnd(running, `Stopping the AI agent build of ${running.spec.configName}`);
  });
  return { dispose: () => setTaskLaunchGuard(undefined) };
}

/** Warn when the user starts a task on a configuration an agent is building or deleting. */
export function watchBuildConflicts(jobs: JobManager): vscode.Disposable {
  return vscode.tasks.onDidStartTask(async event => {
    const stopMine = 'Stop My Task';
    // A deletion cannot be stopped halfway, so only the user's task can give way.
    const deleting = runningAgentDeletionFor(jobs, event.execution.task);
    if (deleting) {
      const choice = await vscode.window.showWarningMessage(
        `An AI agent is deleting ${deleting.spec.buildDir} right now. "${event.execution.task.name}" uses that folder, so it will likely fail.`,
        stopMine, 'Let It Run',
      );
      if (choice === stopMine) {
        event.execution.terminate();
      }
      return;
    }
    const westWork = runningAgentWestWorkFor(jobs, event.execution.task);
    if (westWork) {
      const choice = await vscode.window.showWarningMessage(
        `An AI agent is changing the west workspace ${westWork.spec.westWorkspace} right now. "${event.execution.task.name}" uses it, so it will likely fail.`,
        stopMine, 'Let It Run',
      );
      if (choice === stopMine) {
        event.execution.terminate();
      }
      return;
    }
    const running = runningAgentBuildFor(jobs, event.execution.task);
    if (!running) {
      return;
    }
    const stopAgent = 'Stop Agent Build';
    const choice = await vscode.window.showWarningMessage(
      `An AI agent is building ${running.spec.configName} right now. "${event.execution.task.name}" uses the same build folder, so the two can break each other.`,
      stopMine, stopAgent, 'Let Both Run',
    );
    if (choice === stopMine) {
      event.execution.terminate();
    } else if (choice === stopAgent) {
      jobs.cancel(running.id);
    }
  });
}
