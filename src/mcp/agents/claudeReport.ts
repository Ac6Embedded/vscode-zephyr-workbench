// Claude Code knows more than its files say. `claude mcp list` also reports the
// servers of scopes no file read here holds, such as its private per-folder
// scope, the connectors of the user's claude.ai account, and whether each
// server answers or still needs a sign-in. The AI Manager applies that answer
// to the rows it read from files, so a server added to the account does not
// read as "not connected".

import type { ClaudeServerStatus } from './claudeCli';
import { AgentScope, reachesUrl, WiringState } from './index';

export type ServerHealth = ClaudeServerStatus['health'];

/** What is known of Claude Code's own answer. */
export interface ClaudeCheck {
  /** A check is running. The rows keep the last answer meanwhile. */
  checking: boolean;
  /** The last answer. */
  servers?: ClaudeServerStatus[];
  /** Why the last check failed. */
  error?: string;
  /** The claude.ai connectors Claude Code recorded, by name: only a hint, for when there is no answer. */
  recorded?: string[];
}

/** The server the rows are about. */
export interface ReportTarget {
  name: string;
  url: string;
  /** Matches the name a connector for this server is likely to have, for the recorded names. */
  hint: RegExp;
}

export interface ReportedRow {
  id: string;
  label: string;
  detected: boolean;
  /** `other` is an entry Claude Code reports that no file read here holds; `account` the claude.ai account. */
  scope: AgentScope | 'other' | 'account';
  state: WiringState;
  alias?: string;
  health?: ServerHealth;
  checking?: boolean;
  /** Only a recorded name suggests it: Claude Code could not confirm it. */
  unverified?: boolean;
  check_error?: string;
  /** Where the entry lives when it is not a file. */
  source?: string;
}

const ACCOUNT_PREFIX = 'claude.ai ';

/**
 * The rows of Claude Code for one server, with Claude Code's answer applied:
 * the health of the entries found in files, a row for an entry only Claude
 * Code knows of, and a row for the claude.ai account once it can be told.
 */
export function applyClaudeCheck<T extends ReportedRow>(
  rows: readonly T[], server: ReportTarget, check: ClaudeCheck,
): (T | ReportedRow)[] {
  const first = rows[0];
  if (!first) {
    return [...rows];
  }
  const base = { id: first.id, label: first.label, detected: first.detected };
  const listed = check.servers ?? [];
  const checking = check.checking || undefined;

  // The health of each entry a file holds, found under the name Claude Code knows it by.
  const result: (T | ReportedRow)[] = rows.map(row => {
    const found = row.state === 'configured'
      ? listed.find(item => !item.account && item.name === (row.alias ?? server.name))
      : undefined;
    return found ? { ...row, health: found.health } : row;
  });

  const inFiles = new Set(rows.filter(row => row.state !== 'not-configured').map(row => row.alias ?? server.name));
  for (const item of listed) {
    if (!item.account && !inFiles.has(item.name) && reachesUrl(item.target, server.url)) {
      // Such as `claude mcp add` run without a scope, which keeps the entry for one folder.
      result.push({
        ...base, scope: 'other', state: 'configured', alias: item.name, health: item.health,
        source: `Claude Code entry ${item.name}`,
      });
    }
  }

  const connector = listed.find(item => item.account && reachesUrl(item.target, server.url));
  if (connector) {
    const name = connector.name.slice(ACCOUNT_PREFIX.length);
    result.push({
      ...base, scope: 'account', state: 'configured', alias: name, health: connector.health, checking,
      source: `claude.ai connector ${name}`,
    });
    return result;
  }
  if (check.servers) {
    // Asked, and the account has no connector for this server.
    result.push({ ...base, scope: 'account', state: 'not-configured', checking, source: 'claude.ai connectors' });
    return result;
  }
  const hinted = check.recorded
    ?.filter(name => name.startsWith(ACCOUNT_PREFIX))
    .map(name => name.slice(ACCOUNT_PREFIX.length))
    .find(name => server.hint.test(name));
  if (hinted) {
    result.push({
      ...base, scope: 'account', state: 'configured', alias: hinted, unverified: true, checking,
      ...(check.error ? { check_error: check.error } : {}), source: `claude.ai connector ${hinted}`,
    });
  } else if (checking || check.error) {
    result.push({
      ...base, scope: 'account', state: 'not-configured', checking,
      ...(check.error ? { check_error: check.error } : {}), source: 'claude.ai connectors',
    });
  }
  return result;
}
