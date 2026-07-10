import { strict as assert } from 'assert';

import { SbomTotalClient, SbomTotalError } from '../../sbomtotal/sbomTotalClient';

// Build a streamed Response whose body yields the given chunks in order, so the
// SSE reader is exercised across arbitrary frame boundaries.
function streamResponse(chunks: string[], init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, ...init });
}

const RESULT = { hash: 'abc123', verdict: 'review', score: 74, triage: { actionable: 1, review: 2, noise: 0, total: 3 } };

describe('SbomTotalClient.scanSbomStream', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('parses SSE frames split across chunk boundaries and returns the result', async () => {
    // A frame deliberately split mid-way to test buffering.
    globalThis.fetch = (async () =>
      streamResponse([
        'event: pending\ndata: {"engines":[{"name":"grype"},{"name":"osv"}]}\n\n',
        'event: engine\nda',
        'ta: {"name":"grype","detections":1}\n\nevent: engine\ndata: {"name":"osv","detections":0}\n\n',
        `event: result\ndata: ${JSON.stringify(RESULT)}\n\n`,
      ])) as typeof fetch;

    const client = new SbomTotalClient({ baseUrl: 'https://example.test' });
    const engines: string[] = [];
    let pending = 0;
    const result = await client.scanSbomStream(new Uint8Array([1, 2, 3]), 'x.spdx', {
      onPending: names => { pending = names.length; },
      onEngine: e => { engines.push(e.name ?? ''); },
    });

    assert.equal(pending, 2);
    assert.deepEqual(engines, ['grype', 'osv']);
    assert.equal(result.hash, 'abc123');
    assert.equal(result.verdict, 'review');
  });

  it('maps a pre-stream 422 to an unparseable error', async () => {
    globalThis.fetch = (async () =>
      new Response('{"detail":"Unsupported SBOM format"}', { status: 422 })) as typeof fetch;
    const client = new SbomTotalClient({ baseUrl: 'https://example.test' });
    await assert.rejects(
      client.scanSbomStream(new Uint8Array([1]), 'x.spdx3.json'),
      (err: unknown) => err instanceof SbomTotalError && err.kind === 'unparseable',
    );
  });

  it('surfaces a mid-stream error frame as a server error', async () => {
    globalThis.fetch = (async () =>
      streamResponse([
        'event: pending\ndata: {"engines":[]}\n\n',
        'event: error\ndata: {"detail":"engine exploded"}\n\n',
      ])) as typeof fetch;
    const client = new SbomTotalClient({ baseUrl: 'https://example.test' });
    await assert.rejects(
      client.scanSbomStream(new Uint8Array([1]), 'x.spdx'),
      (err: unknown) => err instanceof SbomTotalError && err.kind === 'server' && /engine exploded/.test(err.message),
    );
  });

  it('retries anonymously when the built-in token is rejected', async () => {
    const authHeaders: (string | null)[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      authHeaders.push(headers.get('authorization'));
      if (authHeaders.length === 1) {
        return new Response('forbidden', { status: 403 });
      }
      return streamResponse([`event: result\ndata: ${JSON.stringify(RESULT)}\n\n`]);
    }) as unknown as typeof fetch;

    const client = new SbomTotalClient({ baseUrl: 'https://example.test', token: 'sct_builtin', anonymousFallback: true });
    const result = await client.scanSbomStream(new Uint8Array([1]), 'x.spdx');

    assert.equal(result.hash, 'abc123');
    assert.equal(authHeaders.length, 2);
    assert.equal(authHeaders[0], 'Bearer sct_builtin');
    assert.equal(authHeaders[1], null); // retried without the token
  });

  it('errors when the stream ends without a result', async () => {
    globalThis.fetch = (async () =>
      streamResponse(['event: pending\ndata: {"engines":[]}\n\n'])) as typeof fetch;
    const client = new SbomTotalClient({ baseUrl: 'https://example.test' });
    await assert.rejects(
      client.scanSbomStream(new Uint8Array([1]), 'x.spdx'),
      (err: unknown) => err instanceof SbomTotalError && err.kind === 'unexpected',
    );
  });
});
