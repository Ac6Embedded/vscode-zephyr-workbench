// Notices when a window stops answering in the middle of a call.
//
// Once a call has sent progress, the window's answer arrives on a server-sent
// event stream. If that window reloads or crashes, the stream just ends, and
// the MCP SDK does not fail the pending request: the agent would wait for the
// full request timeout. This wraps the transport's fetch, reads the events as
// they pass, and reports a stream that ends before carrying the answer.

/** `_meta` key that ties a tools/call request to the caller waiting on it. */
export const CALL_ID_META_KEY = 'com.ac6.zephyr-workbench/call';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface Watched {
  callId: string;
  requestId: string | number;
}

function watchedRequest(body: unknown): Watched | undefined {
  if (typeof body !== 'string') {
    return undefined;
  }
  try {
    const message = JSON.parse(body) as { id?: unknown; method?: unknown; params?: { _meta?: Record<string, unknown> } };
    const callId = message.params?._meta?.[CALL_ID_META_KEY];
    const id = message.id;
    if (typeof callId === 'string' && (typeof id === 'string' || typeof id === 'number')) {
      return { callId, requestId: id };
    }
  } catch {
    // Not a single JSON-RPC request: nothing to watch.
  }
  return undefined;
}

/** True when one SSE event carries the result or error for `requestId`. */
export function eventAnswers(event: string, requestId: string | number): boolean {
  const data = event
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) {
    return false;
  }
  try {
    const message = JSON.parse(data) as { id?: unknown; result?: unknown; error?: unknown };
    return message.id === requestId && ('result' in message || 'error' in message);
  } catch {
    return false;
  }
}

export class StreamWatch {
  private readonly listeners = new Map<string, () => void>();

  /** Call `onLost` if the answer stream for this call ends without the answer. */
  watch(callId: string, onLost: () => void): () => void {
    this.listeners.set(callId, onLost);
    return () => {
      this.listeners.delete(callId);
    };
  }

  wrap(base: Fetch): Fetch {
    return async (input, init) => {
      const response = await base(input, init);
      const watched = watchedRequest(init?.body);
      const type = response.headers.get('content-type') ?? '';
      if (!watched || !response.body || !type.includes('text/event-stream')) {
        return response;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let answered = false;
      const inspect = (text: string, final: boolean) => {
        if (answered) {
          return;
        }
        pending += text;
        const events = pending.split(/\r?\n\r?\n/);
        pending = final ? '' : events.pop() ?? '';
        if (events.some(event => eventAnswers(event, watched.requestId))) {
          answered = true;
          pending = '';
        }
      };
      const lost = () => {
        // An aborted request was ended on purpose, by the SDK's own timer, the
        // agent cancelling, or the transport closing: that is not a window
        // going away, and its own error says what happened.
        if (!answered && init?.signal?.aborted !== true) {
          this.listeners.get(watched.callId)?.();
        }
      };
      const body = new ReadableStream<Uint8Array>({
        pull: async controller => {
          try {
            const { done, value } = await reader.read();
            if (done) {
              inspect(decoder.decode(), true);
              lost();
              controller.close();
              return;
            }
            inspect(decoder.decode(value, { stream: true }), false);
            controller.enqueue(value);
          } catch (error) {
            lost();
            controller.error(error);
          }
        },
        // The SDK cancels once it has what it needs, or when the agent gave up.
        cancel: reason => reader.cancel(reason),
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
  }
}

/** Abort when any of the signals aborts. AbortSignal.any needs Node 20.3. */
export function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) {
      continue;
    }
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
