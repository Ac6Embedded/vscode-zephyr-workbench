// The record of a finished job, kept next to its log in the window's job folder.
//
// A reload, or adding a workspace folder, restarts the extension host and
// empties the job manager, while the agent still holds the job id. The record
// answers it afterwards, from this window or from a bridge once the window is
// gone. The file holds exactly the job's JobView as JSON and nothing else:
// that is the contract a bridge reads.

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DIR_MODE, FILE_MODE } from '../core/paths';
import type { JobView } from './jobManager';

/** Records kept per window folder, newest first. */
export const MAX_JOB_RECORDS = 200;
/** Records and logs older than this are dropped when a window starts. */
export const JOB_RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `<windowId>.<kind>-<n>-<hex>`, or the bare form without a window. Checked
 * before a job id reaches a path, because it comes from the agent.
 */
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64})?$/;

const STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);

export function isJobId(value: string): boolean {
  return JOB_ID_PATTERN.test(value);
}

/** Write atomically: a reader must never see half a record. */
export function writeJobRecord(target: string, view: JobView): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: DIR_MODE });
  const tmp = `${target}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(view), { mode: FILE_MODE });
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Left for the next prune.
    }
    throw error;
  }
}

/** The view stored for `jobId`, or undefined when there is none or it is not a job record. */
export function readJobRecord(file: string, jobId: string): JobView | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  const r = parsed as Partial<JobView> | null;
  const valid = !!r && typeof r === 'object'
    && r.job_id === jobId
    && typeof r.kind === 'string'
    && typeof r.status === 'string' && STATUSES.has(r.status)
    && typeof r.command === 'string'
    && typeof r.started_at === 'string'
    && typeof r.duration_ms === 'number'
    && typeof r.next === 'string'
    && !!r.log && typeof r.log === 'object' && typeof r.log.path === 'string';
  return valid ? r as JobView : undefined;
}

/**
 * Keep the newest MAX_JOB_RECORDS records of a window folder and drop any older
 * than the age limit, each with its log. Logs older than the limit go too,
 * including those of jobs that never got a record. Leftover temporary files
 * from an interrupted write are removed.
 */
export function pruneJobRecords(dir: string, now: number, options: { keep?: number; maxAgeMs?: number } = {}): void {
  const keep = options.keep ?? MAX_JOB_RECORDS;
  const cutoff = now - (options.maxAgeMs ?? JOB_RECORD_MAX_AGE_MS);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const mtime = (name: string): number | undefined => {
    try {
      return fs.statSync(path.join(dir, name)).mtimeMs;
    } catch {
      return undefined;
    }
  };
  const remove = (name: string) => {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // In use or already gone: the next start tries again.
    }
  };

  const records = names
    .filter(name => name.endsWith('.json'))
    .map(name => ({ name, at: mtime(name) }))
    .filter((entry): entry is { name: string; at: number } => entry.at !== undefined)
    .sort((a, b) => b.at - a.at);
  records.forEach((record, index) => {
    if (index >= keep || record.at < cutoff) {
      remove(record.name);
      remove(`${record.name.slice(0, -'.json'.length)}.log`);
    }
  });
  for (const name of names) {
    const at = (name.endsWith('.log') || name.endsWith('.tmp')) ? mtime(name) : undefined;
    // A temporary file only lives for the length of one write.
    if (at !== undefined && (at < cutoff || (name.endsWith('.tmp') && at < now - 60_000))) {
      remove(name);
    }
  }
}
