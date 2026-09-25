// Answers for a job whose window can no longer give them.
//
// A window keeps its jobs in memory, so a reload, a restart of its extensions
// (adding the first folder does that) or a close forgets them. Each window
// writes a finished job's result next to its log, and the bridge reads it
// back from there when the window that ran the job cannot answer.

import * as fs from 'fs';
import { McpToolError } from '../core/errors';
import { PatternError } from '../core/match';
import { McpPaths } from '../core/paths';
import { WINDOW_ID_PATTERN } from '../core/registry';
import { JobLog } from '../jobs/jobLog';

/**
 * `<windowId>.<kind>-<counter>-<random>`. Checked before the id becomes a file
 * name: it comes from the agent, and "w.x/../../y" must not leave the jobs folder.
 */
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{1,128}$/;

/** The window a job id names, or undefined for anything that is not a safe job id. */
function safeJobWindow(jobId: unknown): string | undefined {
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    return undefined;
  }
  const windowId = jobId.slice(0, jobId.indexOf('.'));
  return WINDOW_ID_PATTERN.test(windowId) ? windowId : undefined;
}

/** The finished job's result as its window wrote it, or undefined when there is none. */
export function readPersistedJob(paths: McpPaths, jobId: string): Record<string, unknown> | undefined {
  const windowId = safeJobWindow(jobId);
  if (!windowId) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(paths.jobRecord(windowId, jobId), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    // A record that names another job is not this job's record.
    return (parsed as { job_id?: unknown }).job_id === jobId ? parsed as Record<string, unknown> : undefined;
  } catch {
    // Missing or unreadable: the window left nothing to answer from.
    return undefined;
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

/**
 * Answer a job call from disk, the way the window would have: status returns
 * the result, log pages or filters the log, and cancel returns the result
 * untouched because the job has already finished. Undefined when the window
 * left no result for this job. Throws INVALID_ARGUMENT for a grep pattern the
 * matcher refuses.
 */
export function answerFromPersistedJob(
  paths: McpPaths, jobId: string, args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const record = readPersistedJob(paths, jobId);
  const windowId = safeJobWindow(jobId);
  if (!record || !windowId) {
    return undefined;
  }
  if (str(args.action) !== 'log') {
    return { ...record, persisted: true };
  }
  const log = new JobLog(paths.jobLog(windowId, jobId));
  const maxChars = num(args.max_chars) ?? 8000;
  const grep = str(args.grep);
  if (grep) {
    let text: string;
    try {
      text = log.grep(grep, num(args.context_lines) ?? 0, maxChars);
    } catch (error) {
      if (error instanceof PatternError) {
        throw new McpToolError('INVALID_ARGUMENT', `grep ${error.message}`);
      }
      throw error;
    }
    return { job_id: jobId, path: log.filePath, grep, text, persisted: true };
  }
  return { job_id: jobId, ...log.read(num(args.offset) ?? 0, maxChars), persisted: true };
}

/** The error code of a failed tool result, whether the window or the bridge produced it. */
export function errorCodeOf(result: unknown): string | undefined {
  const value = result as { isError?: boolean; content?: { type?: string; text?: string }[] } | undefined;
  if (!value?.isError) {
    return undefined;
  }
  const text = value.content?.find(item => item.type === 'text')?.text;
  try {
    const code = text ? (JSON.parse(text) as { error?: { code?: unknown } }).error?.code : undefined;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A job call the window that ran the job could not answer, because it closed,
 * reloaded or restarted its extensions: answered from the saved result when
 * there is one. Any other result, and a job with no saved result, is returned
 * as it is, so JOB_NOT_FOUND stays for a job that really is gone.
 */
export function orPersistedJob<R>(
  paths: McpPaths, args: Record<string, unknown>, result: R, log?: (line: string) => void,
): R | { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: true } {
  const code = errorCodeOf(result);
  if (code !== 'JOB_NOT_FOUND' && code !== 'WORKBENCH_NOT_RUNNING') {
    return result;
  }
  const jobId = String(args.job_id);
  try {
    const value = answerFromPersistedJob(paths, jobId, args);
    if (!value) {
      return result;
    }
    log?.(`answered ${jobId} from its saved result (the window said ${code})`);
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
  } catch (error) {
    const refusal = error instanceof McpToolError
      ? error
      : new McpToolError('INTERNAL', error instanceof Error ? error.message : String(error));
    return { content: [{ type: 'text', text: JSON.stringify({ error: refusal.toBody() }) }], isError: true };
  }
}
