// What a failed upstream call means, which decides whether the bridge may
// reconnect and try again.
//
// The distinction that matters is whether the window could have run the tool.
// A refused connection or a rejected token never reached a handler, so any tool
// may be retried on a fresh connection. A connection that broke mid-call may
// have started a build or a flash, so only a read-only tool is retried.

export type UpstreamFailure =
  /** Never reached a tool handler: safe to retry any tool. */
  | 'not-delivered'
  /** Broke during the call: the tool may have run. */
  | 'interrupted'
  /** The window does not offer this tool, usually because of its toolset setting. */
  | 'tool-missing'
  | 'timeout'
  | 'other';

interface ErrorLike {
  name?: string;
  code?: unknown;
  message?: string;
  data?: { status?: number };
  cause?: { code?: unknown };
}

// ProtocolError codes from the 1.x SDK line, kept for the documented fallback.
const CONNECTION_CLOSED = -32000;
const REQUEST_TIMEOUT = -32001;
const INVALID_PARAMS = -32602;

/** HTTP statuses the window's guards answer before any handler runs. */
const REJECTED_BEFORE_DISPATCH = new Set([401, 403, 404, 405, 421, 429]);

const REFUSED = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EADDRNOTAVAIL']);
const BROKEN = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);

export function classifyUpstreamError(error: unknown): UpstreamFailure {
  const e = (error ?? {}) as ErrorLike;
  const message = typeof e.message === 'string' ? e.message : String(error);

  if (e.name === 'ProtocolError') {
    if (e.code === INVALID_PARAMS && /\btool\b.*\b(not found|disabled)\b/i.test(message)) {
      return 'tool-missing';
    }
    if (e.code === REQUEST_TIMEOUT) {
      return 'timeout';
    }
    if (e.code === CONNECTION_CLOSED) {
      return 'interrupted';
    }
    return 'other';
  }
  if (e.name === 'UnauthorizedError') {
    return 'not-delivered';
  }
  if (e.name === 'SdkHttpError') {
    const status = e.data?.status;
    if (status === 499) {
      // The window's handler closed during dispatch: the tool may have run.
      return 'interrupted';
    }
    if (status !== undefined && REJECTED_BEFORE_DISPATCH.has(status)) {
      // 401: the window restarted with a new token. 404 or 405: another
      // process now owns the port. Neither ran anything.
      return 'not-delivered';
    }
    return status !== undefined && status >= 500 ? 'interrupted' : 'other';
  }
  if (e.name === 'SdkError') {
    switch (e.code) {
      case 'ERA_NEGOTIATION_FAILED':
        // Raised while connecting, before any tool call was sent.
        return 'not-delivered';
      case 'REQUEST_TIMEOUT':
        return 'timeout';
      case 'CONNECTION_CLOSED':
        return 'interrupted';
      default:
        return 'other';
    }
  }

  const code = e.cause?.code ?? e.code;
  if (typeof code === 'string' && REFUSED.has(code)) {
    return 'not-delivered';
  }
  if (typeof code === 'string' && BROKEN.has(code)) {
    return 'interrupted';
  }
  if (error instanceof TypeError && /fetch failed/i.test(message)) {
    // A network failure with no recognisable cause: assume the worst.
    return 'interrupted';
  }
  return 'other';
}
