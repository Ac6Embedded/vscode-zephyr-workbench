// The job tool: poll, read the log, or cancel. One tool with an action rather
// than three, because client tool budgets are tight.

import { McpToolError } from '../../core/errors';
import { ToolContext, ToolHandler } from '../../core/toolSpec';
import { isPersisted } from '../../jobs/jobManager';
import { HostDeps } from './deps';
import { progressWait } from './progress';

type Ctx = ToolContext<HostDeps>;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

export const job: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const { jobs, defaultWaitSeconds } = ctx.deps;
  const action = str(args.action) ?? 'status';
  const jobId = str(args.job_id);

  if (action === 'cancel') {
    if (!jobId) {
      throw new McpToolError('INVALID_ARGUMENT', 'action "cancel" needs a job_id.', {
        hint: 'Call job with action "status" and no job_id to list recent jobs.',
      });
    }
    return jobs.cancel(jobId);
  }

  if (action === 'log') {
    if (!jobId) {
      throw new McpToolError('INVALID_ARGUMENT', 'action "log" needs a job_id.');
    }
    // A job known only from its record still has its log on disk.
    const target = jobs.get(jobId);
    const persisted = isPersisted(target) ? { persisted: true } : {};
    const grep = str(args.grep);
    const maxChars = num(args.max_chars) ?? 8000;
    if (grep) {
      return {
        job_id: target.id,
        path: target.log.filePath,
        grep,
        text: target.log.grep(grep, num(args.context_lines) ?? 0, maxChars),
        ...persisted,
      };
    }
    return { job_id: target.id, ...target.log.read(num(args.offset) ?? 0, maxChars), ...persisted };
  }

  // action === 'status'
  if (!jobId) {
    return {
      jobs: jobs.list().slice(0, 20).map(j => ({
        job_id: j.id,
        kind: j.spec.kind,
        status: j.status,
        app_path: j.spec.appPath,
        config_name: j.spec.configName,
        started_at: new Date(j.startedAt).toISOString(),
        exit_code: j.exitCode,
      })),
    };
  }
  const target = jobs.get(jobId);
  if (isPersisted(target)) {
    // Recorded once it finished, so there is nothing to wait for.
    return target.view;
  }
  await jobs.wait(target, (num(args.wait_sec) ?? defaultWaitSeconds) * 1000, progressWait(ctx, jobs));
  return jobs.view(target);
};
