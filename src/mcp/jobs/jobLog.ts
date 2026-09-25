// Append-only log for one job, plus the paged reads the agent uses.
//
// The log lives under the stable MCP directory rather than inside the build
// directory, because a pristine build deletes the build directory and would
// take the log of the build that is writing it.

import * as fs from 'fs';
import * as path from 'path';
import { cleanForLog } from '../core/ansi';
import { compileMatcher } from '../core/match';
import { FILE_MODE } from '../core/paths';

const MAX_GREP_LINE = 4000;

export interface LogSlice {
  path: string;
  total_bytes: number;
  offset: number;
  next_offset: number;
  eof: boolean;
  text: string;
}

export class JobLog {
  private handle: number | undefined;
  private bytes = 0;

  constructor(readonly filePath: string) {}

  open(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.handle = fs.openSync(this.filePath, 'w', FILE_MODE);
    this.bytes = 0;
  }

  /** Append a raw chunk. ANSI and carriage-return repaints are removed first. */
  append(chunk: string): void {
    const cleaned = cleanForLog(chunk);
    if (!cleaned) {
      return;
    }
    const buffer = Buffer.from(cleaned, 'utf8');
    if (this.handle === undefined) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, buffer, { mode: FILE_MODE });
    } else {
      fs.writeSync(this.handle, buffer);
    }
    this.bytes += buffer.byteLength;
  }

  get size(): number {
    return this.bytes;
  }

  close(): void {
    if (this.handle !== undefined) {
      try {
        fs.closeSync(this.handle);
      } catch {
        // Already closed.
      }
      this.handle = undefined;
    }
  }

  /** Read from a byte offset. The agent pages with `next_offset`. */
  read(offset = 0, maxChars = 8000): LogSlice {
    const total = this.sizeOnDisk();
    const start = Math.max(0, Math.min(offset, total));
    const length = Math.max(0, Math.min(maxChars, total - start));
    let text = '';
    if (length > 0) {
      const fd = fs.openSync(this.filePath, 'r');
      try {
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, start);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    }
    return {
      path: this.filePath,
      total_bytes: total,
      offset: start,
      next_offset: start + Buffer.byteLength(text, 'utf8'),
      eof: start + Buffer.byteLength(text, 'utf8') >= total,
      text,
    };
  }

  /** Last N lines, capped by characters. This is what goes inline in a result. */
  tail(lines = 40, maxChars = 4000): string {
    const total = this.sizeOnDisk();
    if (total === 0) {
      return '';
    }
    const window = Math.min(total, Math.max(maxChars * 2, 8192));
    const fd = fs.openSync(this.filePath, 'r');
    let text: string;
    try {
      const buf = Buffer.alloc(window);
      fs.readSync(fd, buf, 0, window, total - window);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const all = text.split('\n');
    // A partial first line is an artifact of the read window, not real content.
    if (total > window && all.length > 1) {
      all.shift();
    }
    while (all.length > 0 && all[all.length - 1] === '') {
      all.pop();
    }
    let result = all.slice(-lines).join('\n');
    if (result.length > maxChars) {
      result = `... (truncated)\n${result.slice(result.length - maxChars)}`;
    }
    return result;
  }

  private sizeOnDisk(): number {
    try {
      return fs.statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }

  /**
   * Filter the log to matching lines, with optional surrounding context.
   * `pattern` is agent-supplied, so it goes through the safe matcher rather
   * than a RegExp: a backtracking pattern would freeze the extension host.
   * Throws PatternError for an empty or over-long pattern.
   */
  grep(pattern: string, contextLines = 0, maxChars = 8000): string {
    const matches = compileMatcher(pattern);
    let content: string;
    try {
      content = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return '';
    }
    const lines = content.split('\n');
    const keep = new Set<number>();
    lines.forEach((line, i) => {
      // A single pathological line (minified output, a binary blob) must not
      // dominate the scan, so each line is judged on a bounded prefix.
      if (matches(line.length > MAX_GREP_LINE ? line.slice(0, MAX_GREP_LINE) : line)) {
        for (let j = Math.max(0, i - contextLines); j <= Math.min(lines.length - 1, i + contextLines); j++) {
          keep.add(j);
        }
      }
    });
    const picked = [...keep].sort((a, b) => a - b).map(i => lines[i]).join('\n');
    return picked.length > maxChars ? picked.slice(0, maxChars) : picked;
  }
}
