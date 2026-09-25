// Progress while a tool call waits on a job.

import { JobManager, WaitOptions } from '../../jobs/jobManager';
import { ToolContext } from '../../core/toolSpec';

const HEARTBEAT_MS = 5000;

/**
 * Wait options that emit a progress notification every few seconds. Several
 * clients reset their idle timeout on progress, so a long build keeps its call
 * alive, and the message shows the user what the build is doing right now.
 * Progress is elapsed seconds, because the spec requires it to only increase
 * and ninja's own [n/m] restarts for every sysbuild domain.
 */
export function progressWait(ctx: ToolContext<unknown>, jobs: JobManager): WaitOptions {
  // The call's own start, so a confirmation wait and a job wait in one call
  // report progress on one clock, which must only ever increase.
  const started = ctx.startedAt;
  return {
    signal: ctx.signal,
    everyMs: HEARTBEAT_MS,
    tick: job => {
      const message = jobs.lastLine(job);
      ctx.progress({
        progress: Math.round((Date.now() - started) / 1000),
        ...(message ? { message } : {}),
      });
    },
  };
}

/**
 * Milliseconds left of a call's wait budget. Time spent earlier in the call,
 * such as on a confirmation dialog, comes out of it, so the whole call stays
 * within the time the agent allows.
 */
export function remainingWaitMs(ctx: ToolContext<unknown>, waitSec: number): number {
  return Math.max(0, waitSec * 1000 - (Date.now() - ctx.startedAt));
}
