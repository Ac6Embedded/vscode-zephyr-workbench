// Reading a capture's job log for serial_read and serial_send: byte-exact
// slices, the device lines a grep keeps, and waiting for a line that matches.
// The log file is the record, so a capture that has ended, or one only known
// from its job record after a restart, reads the same way as a running one.

import * as fs from 'fs';
import { isStatusLine, LineHit, scanDeviceLines, utf8Boundary } from '../../core/serialStream';
import { SerialCapture } from './captures';

/** Bytes read from the log at a time while scanning it. */
const SCAN_CHUNK_BYTES = 64 * 1024;
const MAX_GREP_LINE = 4000;
const HEARTBEAT_MS = 5000;

export interface LogSlice {
  text: string;
  offset: number;
  /** Where the next read starts: pass it as offset. */
  next_offset: number;
  total_bytes: number;
  /** More output is already in the log after next_offset. */
  more: boolean;
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function readBytes(file: string, offset: number, length: number): Buffer {
  if (length <= 0) {
    return Buffer.alloc(0);
  }
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return Buffer.alloc(0);
  }
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, offset);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/** Up to `maxBytes` of the log from `offset`, ending on a whole character. */
export function readSlice(file: string, offset: number, maxBytes: number): LogSlice {
  const total = sizeOf(file);
  const start = Math.min(Math.max(0, offset), total);
  const buffer = readBytes(file, start, Math.min(maxBytes, total - start));
  // A slice too short to hold one whole character still moves forward.
  const length = utf8Boundary(buffer) || buffer.length;
  return {
    text: buffer.toString('utf8', 0, length),
    offset: start,
    next_offset: start + length,
    total_bytes: total,
    more: start + length < total,
  };
}

/**
 * The complete device lines from `offset` that `matches` keeps, up to
 * `maxChars` characters. next_offset follows the last line looked at, so a
 * line still being received is looked at again by the next call. `more` is
 * true only when the result was cut short: a partial last line, such as a
 * shell prompt, is not a line yet, and a call made now would find nothing.
 */
export function grepSlice(file: string, offset: number, matches: (line: string) => boolean, maxChars: number):
  LogSlice & { matched_lines: number } {
  const total = sizeOf(file);
  let cursor = Math.min(Math.max(0, offset), total);
  const start = cursor;
  const kept: string[] = [];
  let used = 0;
  let full = false;
  while (cursor < total && !full) {
    const chunk = readBytes(file, cursor, Math.min(SCAN_CHUNK_BYTES, total - cursor));
    let lineStart = 0;
    for (let newline = chunk.indexOf(0x0a); newline !== -1; newline = chunk.indexOf(0x0a, lineStart)) {
      const line = chunk.toString('utf8', lineStart, newline);
      if (!isStatusLine(line) && matches(line.length > MAX_GREP_LINE ? line.slice(0, MAX_GREP_LINE) : line)) {
        if (used + line.length + 1 > maxChars && kept.length > 0) {
          full = true;
          break;
        }
        kept.push(line);
        used += line.length + 1;
      }
      lineStart = newline + 1;
    }
    if (lineStart === 0 && !full) {
      // No complete line in this chunk: the rest is still being received,
      // or one line is longer than a chunk and is passed over.
      if (cursor + chunk.length >= total) {
        break;
      }
      lineStart = chunk.length;
    }
    cursor += lineStart;
  }
  return {
    text: kept.join('\n'),
    offset: start,
    next_offset: cursor,
    total_bytes: total,
    more: full,
    matched_lines: kept.length,
  };
}

export interface WaitResult {
  hit?: LineHit;
  /** Where the scan stopped: the offset a later wait for the same line resumes from. */
  resumeAt: number;
  /** The capture ended without a match. */
  ended: boolean;
}

/**
 * Wait for a device line matching `matches` in the output after `from`: until
 * one is logged, the capture ends, `deadline` passes, or the call is dropped.
 * A capture that has already ended is searched once, as it is.
 */
export async function waitForDeviceLine(options: {
  file: string;
  from: number;
  matches: (line: string) => boolean;
  capture?: SerialCapture;
  deadline: number;
  signal: AbortSignal;
  /** Every few seconds while waiting, to keep the agent's call alive. */
  tick?(): void;
}): Promise<WaitResult> {
  const { file, matches, capture, signal } = options;
  let cursor = Math.max(0, options.from);
  let dirty = false;
  let wake: (() => void) | undefined;
  // Subscribed before the first scan, so output logged meanwhile is never missed.
  const subscription = capture?.onChange(() => {
    dirty = true;
    wake?.();
  });
  const pulse = options.tick ? setInterval(options.tick, HEARTBEAT_MS) : undefined;
  try {
    for (;;) {
      dirty = false;
      // Read before scanning: once a capture has ended, all of its output is in the log.
      const ended = !capture || capture.ended;
      const total = sizeOf(file);
      while (cursor < total) {
        const chunk = readBytes(file, cursor, Math.min(SCAN_CHUNK_BYTES, total - cursor));
        const atEnd = cursor + chunk.length >= total;
        const scan = scanDeviceLines(chunk, cursor, matches, atEnd);
        if (scan.hit) {
          return { hit: scan.hit, resumeAt: scan.resumeAt, ended: false };
        }
        if (scan.resumeAt === cursor || chunk.length === 0) {
          break; // Only the line still being received is left.
        }
        cursor = scan.resumeAt;
      }
      const remaining = options.deadline - Date.now();
      if (ended || remaining <= 0 || signal.aborted) {
        return { resumeAt: cursor, ended };
      }
      if (!dirty) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(done, remaining);
          signal.addEventListener('abort', done, { once: true });
          wake = done;
          function done() {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            wake = undefined;
            resolve();
          }
        });
      }
    }
  } finally {
    subscription?.dispose();
    if (pulse) {
      clearInterval(pulse);
    }
  }
}

/**
 * Wait until the log holds more than `offset` bytes, the capture ends, or
 * `deadline` passes: serial_read's long poll without a pattern.
 */
export async function waitForOutput(file: string, offset: number, capture: SerialCapture | undefined, deadline: number, signal: AbortSignal): Promise<void> {
  await waitForDeviceLine({
    file, from: offset, matches: () => true, capture, deadline, signal,
  });
}
