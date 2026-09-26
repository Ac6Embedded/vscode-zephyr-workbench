// Which jobs may not run side by side. A build reads the west workspace and the
// Python environment it was configured with, so a `west update` or a venv
// rebuild under it breaks it halfway, just as a second build in its folder
// would. Readers never conflict with each other; a writer conflicts with
// every job that touches what it writes.

import { isInside, normalizeForCompare } from '../core/argSafety';
import type { JobKind } from './jobManager';

export type JobResource = 'build_dir' | 'west_workspace' | 'venv';

/** The part of a job spec that says what it touches. */
export interface JobClaim {
  kind: JobKind;
  lockKey: string;
  buildDir?: string;
  westWorkspace?: string;
  venvPath?: string;
  writes?: ReadonlyArray<JobResource>;
}

/** What a job writes. A build or a deletion writes its build folder without saying so. */
export function writesOf(claim: JobClaim): ReadonlySet<JobResource> {
  const writes = new Set<JobResource>(claim.writes ?? []);
  if (claim.buildDir && (claim.kind === 'build' || claim.kind === 'clean')) {
    writes.add('build_dir');
  }
  return writes;
}

const samePath = (a: string | undefined, b: string | undefined): boolean =>
  !!a && !!b && normalizeForCompare(a) === normalizeForCompare(b);

/**
 * The resource two jobs would fight over, or undefined when they can run side
 * by side. 'lock' means they hold the same lock key, which always conflicts.
 * Build folders conflict when one contains the other, because deleting
 * <app>/build removes <app>/build/primary.
 */
export function conflictOf(a: JobClaim, b: JobClaim): JobResource | 'lock' | undefined {
  if (a.lockKey === b.lockKey) {
    return 'lock';
  }
  const aWrites = writesOf(a);
  const bWrites = writesOf(b);
  const written = (resource: JobResource) => aWrites.has(resource) || bWrites.has(resource);
  if (a.buildDir && b.buildDir && (isInside(a.buildDir, b.buildDir) || isInside(b.buildDir, a.buildDir))
    && written('build_dir')) {
    return 'build_dir';
  }
  if (samePath(a.westWorkspace, b.westWorkspace) && written('west_workspace')) {
    return 'west_workspace';
  }
  if (samePath(a.venvPath, b.venvPath) && written('venv')) {
    return 'venv';
  }
  return undefined;
}

/** True when two working jobs may not run at the same time. */
export function conflictsWith(a: JobClaim, b: JobClaim): boolean {
  return conflictOf(a, b) !== undefined;
}
