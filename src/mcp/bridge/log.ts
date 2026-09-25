// The bridge logs to stderr, and to a rotating file when asked, because a user
// debugging a connection has no other window into this process.

import * as fs from 'fs';
import * as path from 'path';

const MAX_BYTES = 1024 * 1024;

export class BridgeLog {
  private readonly verbose = process.env.ZW_MCP_DEBUG === '1';

  constructor(private readonly file?: string) {}

  info(line: string): void {
    this.write('info', line);
  }

  debug(line: string): void {
    if (this.verbose) {
      this.write('debug', line);
    }
  }

  error(line: string): void {
    this.write('error', line);
  }

  private write(level: string, line: string): void {
    const text = `[zephyr-workbench-mcp] ${level} ${line}`;
    try {
      process.stderr.write(`${text}\n`);
    } catch {
      // stderr can be closed by the host; the file below may still work.
    }
    if (!this.file) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_BYTES) {
        fs.renameSync(this.file, `${this.file}.1`);
      }
      fs.appendFileSync(this.file, `${new Date().toISOString()} ${text}\n`, { mode: 0o600 });
    } catch {
      // File logging is best effort.
    }
  }
}
