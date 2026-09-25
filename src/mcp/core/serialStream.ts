// What a serial capture writes to its job log, and how that log is searched.
//
// The terminal shows the device's raw output, colours and all. The job log,
// which serial_read and job action log return, keeps clean lines instead:
// escape sequences removed, \r\n turned into \n, a line the device redraws
// with \r kept once, and a prompt with no newline flushed after a short idle so
// wait_for can match it. Status messages of the capture are lines of their own
// starting with STATUS_PREFIX, so they are told apart from what the device
// printed and are never matched by wait_for or grep.

/** Every status line of a capture starts with this. */
export const STATUS_PREFIX = '--- serial: ';

/** A pending line longer than this is written out even without its newline. */
const MAX_PENDING_CHARS = 16 * 1024;
/** Longest escape sequence followed before it is taken for plain text. */
const MAX_ESCAPE_CHARS = 512;
/** Each line is matched on a bounded prefix, as job action log's grep does. */
const MAX_MATCH_CHARS = 4000;

export function statusLine(message: string): string {
  return `${STATUS_PREFIX}${message} ---`;
}

export function isStatusLine(line: string): boolean {
  return line.startsWith(STATUS_PREFIX);
}

type EscapeState = 'none' | 'esc' | 'csi' | 'string' | 'string_esc' | 'charset';

/**
 * Turns the device's decoded output into job log text. Stateful across
 * chunks: an escape sequence or a \r\n pair split between two reads is still
 * handled as one.
 */
export class SerialLineAssembler {
  private escape: EscapeState = 'none';
  private escapeLength = 0;
  /** The line being received, not in the log yet. */
  private pending = '';
  /** A \r arrived; whether it ends the line or redraws it depends on what follows. */
  private carriageReturn = false;
  /** The log ends with a partial line, written out by flushPartial. */
  private partialWritten = false;

  /** Text for the log: whole lines, plus the line breaks a redraw needs. */
  push(text: string): string {
    let out = '';
    for (const ch of text) {
      if (this.escape !== 'none' && this.consumeEscape(ch)) {
        continue;
      }
      if (ch === '\u001b') {
        this.escape = 'esc';
        this.escapeLength = 0;
        continue;
      }
      if (this.carriageReturn) {
        this.carriageReturn = false;
        if (ch === '\n') {
          out += this.endLine();
          continue;
        }
        out += this.redraw();
      }
      if (ch === '\r') {
        this.carriageReturn = true;
      } else if (ch === '\n') {
        out += this.endLine();
      } else if (ch === '\b') {
        this.pending = [...this.pending].slice(0, -1).join('');
      } else if (ch === '\t' || !/[\u0000-\u001f\u007f-\u009f]/.test(ch)) {
        this.pending += ch;
        if (this.pending.length >= MAX_PENDING_CHARS) {
          out += this.flushPartial();
        }
      }
      // Any other control character (NUL, BEL...) has no place in a log.
    }
    return out;
  }

  /** True while part of a line waits for its end. */
  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  /**
   * Write out the line received so far, such as a shell prompt waiting for
   * input. What the device adds to that line later follows it in the log.
   */
  flushPartial(): string {
    if (!this.pending) {
      return '';
    }
    const text = this.pending;
    this.pending = '';
    this.partialWritten = true;
    return text;
  }

  /** A status line, on a line of its own. */
  status(message: string): string {
    const before = this.pending || this.partialWritten ? `${this.pending}\n` : '';
    this.pending = '';
    this.partialWritten = false;
    return `${before}${statusLine(message)}\n`;
  }

  private endLine(): string {
    const line = this.pending;
    this.pending = '';
    this.partialWritten = false;
    return `${line}\n`;
  }

  /**
   * A lone \r: the device redraws the line. A line already in the log keeps
   * what it had and the redrawn text starts a new line; a line not written
   * yet keeps only its final state, like a progress counter.
   */
  private redraw(): string {
    this.pending = '';
    if (this.partialWritten) {
      this.partialWritten = false;
      return '\n';
    }
    return '';
  }

  /** Follow an escape sequence. False when `ch` turned out to be text, which the caller then handles. */
  private consumeEscape(ch: string): boolean {
    this.escapeLength++;
    const code = ch.codePointAt(0) ?? 0;
    switch (this.escape) {
      case 'esc':
        if (ch === '[') {
          this.escape = 'csi';
        } else if (ch === ']' || ch === 'P' || ch === 'X' || ch === '^' || ch === '_') {
          // OSC, DCS, SOS, PM and APC run until BEL or ST.
          this.escape = 'string';
        } else if (code >= 0x20 && code <= 0x2f) {
          // A character set designation such as ESC ( B takes one more character.
          this.escape = 'charset';
        } else {
          this.escape = 'none';
        }
        return true;
      case 'csi':
        if (code >= 0x40 && code <= 0x7e) {
          this.escape = 'none';
          return true;
        }
        if (code >= 0x20 && code <= 0x3f && this.escapeLength < MAX_ESCAPE_CHARS) {
          return true;
        }
        this.escape = 'none';
        return false;
      case 'string':
        if (ch === '\u0007') {
          this.escape = 'none';
        } else if (ch === '\u001b') {
          this.escape = 'string_esc';
        } else if (this.escapeLength >= MAX_ESCAPE_CHARS) {
          this.escape = 'none';
        }
        return true;
      case 'string_esc':
        this.escape = ch === '\\' ? 'none' : 'string';
        return true;
      default:
        this.escape = 'none';
        return true;
    }
  }
}

export interface LineHit {
  /** The matching line, as the log holds it. */
  line: string;
  /** Byte offset of the line (or of the part of it scanned) in the log. */
  offset: number;
}

/**
 * Look for a device line matching `matches` in `chunk`, which starts at byte
 * `base` of the log. `atEnd` says the chunk reaches the end of the log, so its
 * last line is tested even without a newline: a prompt has none. Status lines
 * never match. Without a hit, `resumeAt` is where the next scan starts: the
 * start of the line still being written, so it is tested again once complete.
 */
export function scanDeviceLines(chunk: Buffer, base: number, matches: (line: string) => boolean, atEnd: boolean):
  { hit?: LineHit; resumeAt: number } {
  const test = (line: string) => !isStatusLine(line) && matches(line.length > MAX_MATCH_CHARS ? line.slice(0, MAX_MATCH_CHARS) : line);
  let start = 0;
  for (let newline = chunk.indexOf(0x0a, start); newline !== -1; newline = chunk.indexOf(0x0a, start)) {
    const line = chunk.toString('utf8', start, newline);
    if (test(line)) {
      return { hit: { line, offset: base + start }, resumeAt: base + newline + 1 };
    }
    start = newline + 1;
  }
  if (start < chunk.length) {
    if (atEnd) {
      const line = chunk.toString('utf8', start);
      if (test(line)) {
        return { hit: { line, offset: base + start }, resumeAt: base + chunk.length };
      }
    } else if (start === 0) {
      // One line longer than the whole chunk: judged on what was read, then passed.
      const line = chunk.toString('utf8');
      return test(line) ? { hit: { line, offset: base }, resumeAt: base + chunk.length } : { resumeAt: base + chunk.length };
    }
  }
  return { resumeAt: base + start };
}

/**
 * The length of the longest prefix of `buf` that ends on a whole UTF-8
 * character, so a slice of the log never ends inside one and the next read
 * resumes exactly where this one stopped.
 */
export function utf8Boundary(buf: Buffer): number {
  const end = buf.length;
  for (let back = 1; back <= Math.min(4, end); back++) {
    const byte = buf[end - back];
    if ((byte & 0xc0) === 0x80) {
      continue; // A continuation byte: keep looking for the lead byte.
    }
    const size = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return size > back ? end - back : end;
  }
  return end;
}
