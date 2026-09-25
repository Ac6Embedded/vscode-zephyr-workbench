// How a toolchain install or deletion runs for an agent: as a job, one at a
// time per window, in a terminal the user can watch and stop, cancellable
// through the job, deleting only the files it downloaded (a view install may be
// downloading next to it), and refreshing the Toolchains view when it ends.

import * as vscode from 'vscode';
import { cleanupDownloadFiles } from '../../../utils/installUtils';
import { removeDirectory } from '../../../utils/utils';
import { refreshGlobalSdkDetection } from '../../../utils/zephyr/globalSdkService';
import { ToolchainInstallContext, ToolchainInstallReporter } from '../../../utils/zephyr/toolchainInstall';
import { WestSdkErrorKind, WestSdkInstallError } from '../../../utils/zephyr/westSdkRunner';
import { normalizeForCompare } from '../../core/argSafety';
import { assertDownloadUrl, DownloadSource } from '../../core/downloadArgs';
import { McpErrorCode, McpToolError } from '../../core/errors';
import { ToolContext } from '../../core/toolSpec';
import { isWorking, JobKind, JobManager, JobView } from '../../jobs/jobManager';
import { runLoggedStep } from '../taskRunner';
import { HostDeps } from './deps';
import { progressWait, remainingWaitMs } from './progress';

type Ctx = ToolContext<HostDeps>;

/** Every agent install and component download of a window holds this lock. */
export const TOOLCHAIN_DOWNLOAD_LOCK = 'toolchain-downloads';
const TOOLCHAIN_FILES_LOCK_PREFIX = 'toolchain-files:';

/** The lock of a deletion of the toolchain at `root`. */
export function toolchainFilesLock(root: string): string {
  return `${TOOLCHAIN_FILES_LOCK_PREFIX}${normalizeForCompare(root)}`;
}

/**
 * The step runner, on an object so a test with no VS Code terminal can stand
 * in for it. Production always runs runLoggedStep.
 */
export const toolchainSteps = { run: runLoggedStep };

const REVEAL: Record<string, vscode.TaskRevealKind> = {
  always: vscode.TaskRevealKind.Always,
  silent: vscode.TaskRevealKind.Silent,
  never: vscode.TaskRevealKind.Never,
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Refuse while another agent toolchain job works: installs share the download
 * folder and the toolchain lists, and a deletion must not race an install that
 * may be writing into the same toolchain.
 */
export function assertNoToolchainJob(jobs: JobManager): void {
  const running = jobs.list().find(job => isWorking(job)
    && (job.spec.lockKey === TOOLCHAIN_DOWNLOAD_LOCK || job.spec.lockKey.startsWith(TOOLCHAIN_FILES_LOCK_PREFIX)));
  if (running) {
    const what = running.spec.kind === 'clean' ? 'deletion' : 'install';
    throw new McpToolError('BUSY', `A toolchain ${what} is already running in this window (job_id "${running.id}"): ${running.spec.command}.`, {
      hint: `Wait for it with job {"action": "status", "job_id": "${running.id}"}, then retry.`,
      details: { job_id: running.id, kind: running.spec.kind, status: running.status },
    });
  }
}

/** A running job for exactly this request, which a repeated call joins instead of asking again. */
export function runningToolchainJob(jobs: JobManager, lockKey: string, requestKey: string) {
  return jobs.findAttachable({ kind: 'install', lockKey, requestKey, command: '', run: async () => ({}) });
}

/** A VS Code cancellation token that follows an abort signal, for the download and rustup helpers. */
export function cancellationTokenFor(signal: AbortSignal): vscode.CancellationToken {
  return {
    get isCancellationRequested() {
      return signal.aborted;
    },
    onCancellationRequested: (listener: (e: unknown) => unknown, thisArgs?: unknown, disposables?: vscode.Disposable[]) => {
      const fire = () => listener.call(thisArgs, undefined);
      if (signal.aborted) {
        queueMicrotask(fire);
      }
      signal.addEventListener('abort', fire, { once: true });
      const disposable = { dispose: () => signal.removeEventListener('abort', fire) };
      disposables?.push(disposable as vscode.Disposable);
      return disposable as vscode.Disposable;
    },
  } as vscode.CancellationToken;
}

/**
 * Progress into the job log: each message once, and a percentage only when it
 * reaches the next tenth, so a large download does not flood the log.
 */
export function jobReporter(log: (text: string) => void, warnings: string[]): ToolchainInstallReporter {
  let last = '';
  let lastTenth = -1;
  let lastPrefix = '';
  return {
    report: ({ message }) => {
      if (!message || message === last) {
        return;
      }
      const percent = /^(.*?)(\d{1,3})%\s*$/.exec(message);
      if (percent) {
        const tenth = Math.floor(Number(percent[2]) / 10);
        if (percent[1] === lastPrefix && tenth === lastTenth) {
          return;
        }
        lastPrefix = percent[1];
        lastTenth = tenth;
      } else {
        lastPrefix = '';
        lastTenth = -1;
      }
      last = message;
      log(`${message}\n`);
    },
    warn: message => {
      warnings.push(message);
      log(`Warning: ${message}\n`);
    },
  };
}

/** How each west sdk install failure reads for an agent. */
const WEST_SDK_ERRORS: Record<WestSdkErrorKind, { code: McpErrorCode; hint?: string }> = {
  'west-missing': { code: 'ENV_NOT_READY', hint: 'Call check_environment: west comes with the host tools, which the user installs from Zephyr Workbench.' },
  'python-deps': { code: 'ENV_NOT_READY', hint: 'Call check_environment: the Python packages of west sdk come with the host tools.' },
  'extractor': { code: 'ENV_NOT_READY', hint: 'Call check_environment: the archive extractor comes with the host tools.' },
  'permission': { code: 'INVALID_ARGUMENT', hint: 'Choose an install_base the user can write to; the workbench never asks for administrator rights.' },
  'rate-limit': { code: 'BUSY', hint: 'GitHub refused more requests for now. Retry later.' },
  'network': { code: 'TIMEOUT', hint: 'Check the network connection of this machine, then retry.' },
  'checksum': { code: 'INTERNAL', hint: 'Retry: the download was damaged.' },
  'bad-request': { code: 'INVALID_ARGUMENT', hint: 'Call list_toolchains with available "zephyr_sdk" to see the versions and toolchains offered.' },
  'setup-failed': { code: 'INTERNAL' },
  'cancelled': { code: 'INTERNAL' },
  'unknown': { code: 'INTERNAL' },
};

/** What a job result says about a failure, beyond its message. */
function failureFields(error: unknown): Record<string, unknown> {
  if (error instanceof WestSdkInstallError) {
    const mapped = WEST_SDK_ERRORS[error.kind];
    return { error_kind: error.kind, error_code: mapped.code, ...(mapped.hint ? { hint: mapped.hint } : {}) };
  }
  if (error instanceof McpToolError) {
    return { error_code: error.code, ...(error.hint ? { hint: error.hint } : {}) };
  }
  return {};
}

export interface ToolchainJobWork {
  /** The install context of this job: its log, its token, its own downloads and the settings lock. */
  ictx: ToolchainInstallContext;
  log(text: string): void;
  signal: AbortSignal;
  /** Warnings the result carries. */
  warnings: string[];
}

export interface ToolchainJobPlan {
  kind: Extract<JobKind, 'install' | 'clean'>;
  lockKey: string;
  requestKey: string;
  /** What the job does, for the job view and the user. */
  command: string;
  /** The title of its terminal. */
  step: string;
  /** Where its downloads may come from; a job without it downloads nothing. */
  downloads?: { sources: readonly DownloadSource[]; archive: boolean };
  run(work: ToolchainJobWork): Promise<Record<string, unknown>>;
  /** Clean up after a failure, and say what is left for the agent to know. */
  onFailure?(work: Pick<ToolchainJobWork, 'log'>): Promise<Record<string, unknown>>;
  next(view: JobView): string;
}

/** Start a toolchain job, wait the call's budget for it, and return its view. */
export async function runToolchainJob(
  ctx: Ctx, plan: ToolchainJobPlan, waitSec: number, extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { jobs } = ctx.deps;
  const header = `> [agent ${ctx.client.name ?? 'mcp'}] ${plan.step}`;
  const { job, attached } = jobs.start({
    kind: plan.kind,
    lockKey: plan.lockKey,
    requestKey: plan.requestKey,
    command: plan.command,
    parse: false,
    run: async (sink, signal) => {
      const downloaded: string[] = [];
      const warnings: string[] = [];
      try {
        const result = await toolchainSteps.run(plan.step, sink, signal, async (stepLog, stepSignal) => {
          const ictx: ToolchainInstallContext = {
            context: ctx.deps.extensionContext,
            reporter: jobReporter(stepLog, warnings),
            token: cancellationTokenFor(stepSignal),
            hooks: {
              beforeDownload: url => {
                if (!plan.downloads) {
                  throw new Error(`This job downloads nothing, but was about to fetch ${url}.`);
                }
                assertDownloadUrl(url, plan.downloads.sources, { archive: plan.downloads.archive });
              },
              onDownloaded: file => { downloaded.push(file); },
            },
            // Only this job's files: a view install may be downloading next to it.
            cleanupDownloads: () => cleanupDownloadFiles(downloaded).catch(error => {
              stepLog(`Some downloaded files were not deleted: ${messageOf(error)}\n`);
            }),
            removeFolder: dir => removeDirectory(dir),
            withRegistration: work => ctx.deps.services.withToolchainSettingsLock(work),
          };
          return plan.run({ ictx, log: stepLog, signal: stepSignal, warnings });
        }, { reveal: REVEAL[ctx.deps.revealTerminal] ?? vscode.TaskRevealKind.Silent, header });
        return { exitCode: 0, extra: { ...result, ...(warnings.length > 0 ? { warnings } : {}) } };
      } catch (error) {
        const message = messageOf(error);
        sink.onData(`\n${message}\n`);
        let left: Record<string, unknown> = {};
        try {
          left = (await plan.onFailure?.({ log: text => sink.onData(text) })) ?? {};
        } catch (cleanupError) {
          sink.onData(`Cleaning up after the failure did not complete: ${messageOf(cleanupError)}\n`);
        }
        return {
          exitCode: signal.aborted ? undefined : 1,
          extra: { error: message, ...failureFields(error), ...left, ...(warnings.length > 0 ? { warnings } : {}) },
        };
      } finally {
        // The step's terminal has closed by now: this goes to the job log only.
        await cleanupDownloadFiles(downloaded).catch(error => {
          sink.onData(`Some downloaded files were not deleted: ${messageOf(error)}\n`);
        });
        // Nothing here may fail the job: it has already done its work.
        await refreshGlobalSdkDetection().catch(() => undefined);
        await ctx.deps.refreshViews(['toolchains']);
      }
    },
    next: view => plan.next(view),
  });
  ctx.audit.jobId = job.id;
  await jobs.wait(job, remainingWaitMs(ctx, waitSec), progressWait(ctx, jobs));
  return { ...jobs.view(job, { attached }), ...extra };
}
