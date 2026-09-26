// What the agent did, in a channel the user can read, plus a durable JSONL file.
// Arguments are redacted and truncated before they are written.

import * as fs from 'fs';
import * as vscode from 'vscode';
import { FILE_MODE, McpPaths } from '../core/paths';
import { logSafe, redactValue, truncateForAudit } from '../core/redact';

const MAX_AUDIT_BYTES = 1024 * 1024;

export interface AuditEntry {
  tool: string;
  client?: string;
  ok: boolean;
  ms: number;
  error?: string;
  args?: unknown;
  /** allowed, allowed-session, remembered, denied, timeout, cancelled, not-asked (the user opted out), not-required. */
  confirmation?: string;
  confirmCategory?: string;
  jobId?: string;
  target?: { app_path?: string; config_name?: string; folder?: string; runner?: string };
}

export class AuditLog implements vscode.Disposable {
  private readonly channel: vscode.LogOutputChannel;

  constructor(private readonly paths: McpPaths) {
    this.channel = vscode.window.createOutputChannel('Zephyr Workbench: MCP', { log: true });
  }

  info(line: string): void {
    this.channel.info(line);
  }

  warn(line: string): void {
    this.channel.warn(line);
  }

  show(): void {
    this.channel.show(true);
  }

  record(entry: AuditEntry): void {
    // Every field can carry text an agent chose, so each is flattened to one
    // line: a newline in an error message must not start a forged entry.
    const summary = [
      entry.ok ? 'ok' : 'error',
      logSafe(entry.tool, 64),
      entry.client ? `client=${logSafe(entry.client, 64)}` : '',
      `${entry.ms}ms`,
      entry.jobId ? `job=${logSafe(entry.jobId, 128)}` : '',
      entry.args !== undefined ? `args=${logSafe(truncateForAudit(entry.args))}` : '',
      entry.confirmation && entry.confirmation !== 'not-required'
        ? `confirmation=${logSafe(entry.confirmation, 32)}${entry.confirmCategory ? `(${logSafe(entry.confirmCategory, 16)})` : ''}`
        : '',
      entry.target?.app_path ? `app=${logSafe(entry.target.app_path, 200)}` : '',
      entry.target?.config_name ? `config=${logSafe(entry.target.config_name, 64)}` : '',
      entry.error ? `error=${logSafe(entry.error)}` : '',
    ].filter(Boolean).join(' ');
    if (entry.ok) {
      this.channel.info(summary);
    } else {
      this.channel.warn(summary);
    }
    this.append({ at: new Date().toISOString(), ...entry, args: redactValue(entry.args) });
  }

  /** A confirmation event outside any call: a late answer, a session approval given or forgotten. */
  recordConfirmation(event: { message: string; client?: string; tool?: string; category?: string; outcome?: string }): void {
    this.channel.info(`confirmation: ${logSafe(event.message)}`);
    this.append({ at: new Date().toISOString(), kind: 'confirmation', ...event });
  }

  private append(record: unknown): void {
    try {
      const stat = fs.existsSync(this.paths.audit) ? fs.statSync(this.paths.audit) : undefined;
      if (stat && stat.size > MAX_AUDIT_BYTES) {
        // Keep one previous generation, then start clean.
        fs.renameSync(this.paths.audit, `${this.paths.audit}.1`);
      }
      fs.appendFileSync(this.paths.audit, `${JSON.stringify(record)}\n`, { mode: FILE_MODE });
    } catch {
      // The channel already has the entry, so a file problem is not fatal.
    }
  }

  dispose(): void {
    this.channel.dispose();
  }
}
