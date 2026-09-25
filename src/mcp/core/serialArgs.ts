// Limits and argument checks of the serial actions of the hardware tool. The
// catalog schema states the same limits; they are checked again here because
// a handler never trusts that the client validated anything.

import { McpToolError } from './errors';

export const BAUD_MIN = 300;
export const BAUD_MAX = 4_000_000;
/** Used when neither the argument nor the build's devicetree gives a speed. */
export const DEFAULT_BAUD = 115200;

export const DURATION_DEFAULT_SEC = 600;
export const DURATION_MAX_SEC = 3600;

export const SEND_MAX_CHARS = 1024;
export const READ_DEFAULT_CHARS = 8000;
export const READ_MAX_CHARS = 40000;
/** Longest port name accepted before it is even compared with the listed ones. */
export const PORT_MAX_CHARS = 256;

export const LINE_ENDINGS = ['crlf', 'lf', 'cr', 'none'] as const;
export type LineEnding = typeof LINE_ENDINGS[number];
/**
 * Zephyr's shell runs a command on the first \r or \n and ignores the other
 * half of a \r\n pair (process_nl in subsys/shell/shell.c), and its console
 * getline does the same, so \r\n works there and with line-based firmware too.
 */
export const DEFAULT_LINE_ENDING: LineEnding = 'crlf';

function invalid(message: string, hint?: string): McpToolError {
  return new McpToolError('INVALID_ARGUMENT', message, hint ? { hint } : {});
}

function integerIn(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

export function assertBaudRate(value: unknown): number {
  return integerIn(value, 'baud_rate', BAUD_MIN, BAUD_MAX);
}

export function assertDuration(value: unknown): number {
  return integerIn(value, 'duration_sec', 1, DURATION_MAX_SEC);
}

export function assertMaxChars(value: unknown): number {
  return integerIn(value, 'max_chars', 1, READ_MAX_CHARS);
}

export function assertOffset(value: unknown): number {
  return integerIn(value, 'offset', 0, Number.MAX_SAFE_INTEGER);
}

/** A port as list_ports returns it: plain text, no control character. */
export function assertPortArgument(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid('port must be a device name such as /dev/ttyACM0 or COM3.');
  }
  if (value.length > PORT_MAX_CHARS || /[\u0000-\u001f\u007f]/.test(value)) {
    throw invalid('port must be a device name exactly as list_ports returns it.');
  }
  return value.trim();
}

export function assertLineEnding(value: unknown): LineEnding {
  if (value === undefined) {
    return DEFAULT_LINE_ENDING;
  }
  if (typeof value !== 'string' || !(LINE_ENDINGS as readonly string[]).includes(value)) {
    throw invalid(`line_ending must be one of ${LINE_ENDINGS.join(', ')}.`);
  }
  return value as LineEnding;
}

/**
 * The text of serial_send: printable, one line, at most SEND_MAX_CHARS. A
 * control character could drive the device's line editor (Ctrl+C, escape
 * sequences) in ways the user never saw in the confirmation, so only tab is
 * allowed. Invisible format characters are refused for the same reason: a
 * right-to-left override makes the dialog draw "reboot" as "toober", and a
 * shell that drops the bytes it cannot print then runs "reboot". Empty text
 * sends just the line ending, like pressing Enter.
 */
export function assertSendText(value: unknown, lineEnding: LineEnding): string {
  if (typeof value !== 'string') {
    throw invalid('serial_send needs text, the line to send.');
  }
  if (value.length > SEND_MAX_CHARS) {
    throw invalid(`text is ${value.length} characters long; at most ${SEND_MAX_CHARS} are sent at once.`,
      'Split it into several serial_send calls.');
  }
  if (/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/.test(value)) {
    throw invalid('text may not contain control characters other than tab. The line ending is added by line_ending.');
  }
  // With the u flag, \p{Cs} matches only half of a surrogate pair, which has
  // no UTF-8 form: the helper could not write it.
  if (/\p{Cs}/u.test(value)) {
    throw invalid('text is not valid Unicode: it holds half of a UTF-16 surrogate pair.');
  }
  // Bidirectional overrides and isolates, zero-width characters, the byte
  // order mark, soft hyphens and the line and paragraph separators.
  if (/[\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
    throw invalid('text may not contain invisible formatting characters (such as U+202E or U+200B): the confirmation would show a different text from what the board receives.');
  }
  if (value.length === 0 && lineEnding === 'none') {
    throw invalid('text is empty and line_ending is "none", so there is nothing to send.');
  }
  return value;
}

/**
 * The text as the confirmation dialog quotes it: JSON, with every character
 * beyond printable ASCII written as a \u escape. Whatever the dialog's
 * renderer does with a character, the user reads what is sent; and the Zephyr
 * shell drops the bytes it cannot print, so an escape is closer to what runs
 * there than the glyph.
 */
export function quoteForDialog(text: string): string {
  return JSON.stringify(text).replace(/[^\x20-\x7e]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
