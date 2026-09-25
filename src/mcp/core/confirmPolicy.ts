// The memory behind confirmations, kept free of `vscode` so it is unit tested.
//
// Three kinds of memory, all in-process and lost when the server stops:
// - a session approval: "Allow for This Session" for one agent session, one
//   category and one application;
// - a late approval: a dialog answered after the call had already timed out
//   is honoured once, for the identical call, for a few minutes;
// - a late denial: the identical call is refused for a minute without asking
//   again, so an agent retrying in a loop cannot pile up dialogs.
//
// "The identical call" is whatever key the caller builds; Confirmations puts
// the agent session in it, so late answers never pass from one agent to another.

import { ConfirmCategory } from './toolSpec';

export const LATE_ALLOW_TTL_MS = 5 * 60_000;
export const LATE_DENY_TTL_MS = 60_000;

/** Stable text for a value, with object keys sorted. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort()
      .filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Identifies "the same call": the tool, its category and what it would act on. */
export function fingerprint(tool: string, category: ConfirmCategory, subject: unknown): string {
  return `${tool}\u0000${category}\u0000${canonicalJson(subject)}`;
}

export interface SessionGrant {
  agent: string;
  category: ConfirmCategory;
  scope: string;
  grantedAt: number;
}

export class ConfirmPolicy {
  private generation = 0;
  private readonly lateAllows = new Map<string, number>();
  private readonly lateDenies = new Map<string, number>();
  private readonly grants = new Map<string, SessionGrant>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Bumped on every clear, so an answer to a dialog opened before it is ignored. */
  get currentGeneration(): number {
    return this.generation;
  }

  private grantKey(agent: string, category: ConfirmCategory, scope: string): string {
    return `${agent}\u0000${category}\u0000${scope}`;
  }

  hasSessionGrant(agent: string | undefined, category: ConfirmCategory, scope: string): boolean {
    return !!agent && this.grants.has(this.grantKey(agent, category, scope));
  }

  grantSession(agent: string, category: ConfirmCategory, scope: string, generation: number): boolean {
    if (generation !== this.generation) {
      return false;
    }
    this.grants.set(this.grantKey(agent, category, scope), { agent, category, scope, grantedAt: this.now() });
    return true;
  }

  sessionGrants(): SessionGrant[] {
    return [...this.grants.values()];
  }

  /** False when nothing was kept, because the dialog was opened before a clear. */
  rememberLateAllow(key: string, generation: number): boolean {
    if (generation !== this.generation) {
      return false;
    }
    this.lateAllows.set(key, this.now() + LATE_ALLOW_TTL_MS);
    this.lateDenies.delete(key);
    return true;
  }

  /** False when nothing was kept, because the dialog was opened before a clear. */
  rememberDeny(key: string, generation: number): boolean {
    if (generation !== this.generation) {
      return false;
    }
    this.lateDenies.set(key, this.now() + LATE_DENY_TTL_MS);
    this.lateAllows.delete(key);
    return true;
  }

  /** A late approval, used up by the first identical call that finds it. */
  takeLateAllow(key: string): boolean {
    const until = this.lateAllows.get(key);
    this.lateAllows.delete(key);
    return until !== undefined && until > this.now();
  }

  isRecentlyDenied(key: string): boolean {
    const until = this.lateDenies.get(key);
    if (until === undefined) {
      return false;
    }
    if (until <= this.now()) {
      this.lateDenies.delete(key);
      return false;
    }
    return true;
  }

  /** Forget everything, for example when the server stops or the setting changes. */
  clear(): void {
    this.generation++;
    this.lateAllows.clear();
    this.lateDenies.clear();
    this.grants.clear();
  }
}
