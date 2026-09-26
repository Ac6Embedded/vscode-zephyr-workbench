// Secret redaction applied to everything an agent or the audit log can see.
// The workbench holds at least one real credential (the IAR bearer token in
// `listIARs`), so redaction is a rule rather than a precaution.

/**
 * Matched per name SEGMENT, not as a substring. A plain substring test looks
 * safe but over-redacts real fields: `monkey_patch` contains "key" and
 * `keywords` contains "key", and silently blanking those makes results
 * confusing to read and hard to debug.
 */
const SECRET_SEGMENT = /^(?:token|secret|password|passwd|key|auth|credential)s?$/i;

/** Split camelCase, snake_case, kebab-case and SCREAMING_CASE into segments. */
function segments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+|\s+/)
    .filter(Boolean);
}

/** True when a key name looks like it holds a credential. */
export function isSecretKey(key: string): boolean {
  return segments(key).some(segment => SECRET_SEGMENT.test(segment));
}

export const REDACTED = '<redacted>';

/**
 * Redact secret-looking values anywhere in a JSON-able structure.
 * Keys are matched by name, so this survives shapes we have not seen yet.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 12 || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => redactValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) && inner !== undefined && inner !== null && inner !== ''
        ? REDACTED
        : redactValue(inner, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Redact credentials that appear inline in a command line or log line, where
 * there is no key to match on: `--token abc`, `--token=abc`, `Bearer abc`.
 */
export function redactCommandLine(command: string): string {
  return command
    .replace(/(Bearer\s+)[\w.\-~+/]+=*/gi, `$1${REDACTED}`)
    .replace(/(--?[\w-]*(?:token|secret|password|key|auth|credential)[\w-]*[=\s]+)("[^"]*"|'[^']*'|\S+)/gi,
      `$1${REDACTED}`);
}

/** Truncate a value for the audit log so one huge argument cannot flood it. */
export function truncateForAudit(value: unknown, maxChars = 300): string {
  const text = typeof value === 'string' ? value : JSON.stringify(redactValue(value));
  if (text === undefined) {
    return '';
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}... (${text.length} chars)` : text;
}

/**
 * Make untrusted text safe for a one-line log entry. Agent arguments, error
 * messages and request headers can carry newlines and control characters,
 * which would otherwise let a caller forge whole log lines.
 */
export function logSafe(value: unknown, maxLength = 500): string {
  const text = typeof value === 'string' ? value : String(value);
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}...` : flat;
}
