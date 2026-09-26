// Terminal output cleanup shared by the job log and the bridge.
// Deliberately free of any `vscode` dependency so it can be unit tested and
// bundled into the stdio bridge.

// SGR/CSI sequences, OSC sequences (terminated by BEL or ST), and single-char
// escapes. Kept as one pass so a long build log is cheap to clean.
const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/** Remove ANSI escape sequences. Zephyr builds pass -fdiagnostics-color=always. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * Collapse carriage-return progress rewrites to the final state of each line.
 * ninja and west both repaint a line with \r; keeping every repaint would make
 * the captured log many times larger than what the user saw.
 */
export function collapseCarriageReturns(text: string): string {
  return text
    .split('\n')
    .map(line => {
      if (!line.includes('\r')) {
        return line;
      }
      const segments = line.split('\r');
      // The last non-empty segment is what remained on screen.
      for (let i = segments.length - 1; i >= 0; i--) {
        if (segments[i].length > 0) {
          return segments[i];
        }
      }
      return '';
    })
    .join('\n');
}

/** Normalize CRLF to LF. Applied after collapsing, never before. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** The full pipeline used when appending to a job log. */
export function cleanForLog(text: string): string {
  return collapseCarriageReturns(normalizeNewlines(stripAnsi(text)));
}

/** Convert LF to CRLF for a Pseudoterminal, which needs explicit carriage returns. */
export function toTerminalText(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}
