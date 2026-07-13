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

  it('uploads directly without an authorization header', async () => {
    let authorization: string | null = 'not-called';
    let project: FormDataEntryValue | null = null;
    let label: FormDataEntryValue | null = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      authorization = new Headers(init.headers).get('authorization');
      const form = init.body as FormData;
      project = form.get('project');
      label = form.get('label');
      return streamResponse([`event: result\ndata: ${JSON.stringify(RESULT)}\n\n`]);
    }) as unknown as typeof fetch;

    const client = new SbomTotalClient({ baseUrl: 'https://example.test' });
    await client.scanSbomStream(new Uint8Array([1]), 'x.spdx', {
      projectId: 'proj_abc123',
      projectLabel: 'Full report - merged · nucleo_h563zi · primary',
    });

    assert.equal(authorization, null);
    assert.equal(project, 'proj_abc123');
    assert.equal(label, 'Full report - merged · nucleo_h563zi · primary');
  });

  it('creates an anonymous project and exposes its project URL', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(url);
      requestInit = init;
      return new Response(JSON.stringify({ projectId: 'proj_created123', name: 'hello_world', owner: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const client = new SbomTotalClient({ baseUrl: 'https://example.test/' });
    const projectResult = await client.createProject('hello_world');

    assert.equal(requestUrl, 'https://example.test/api/v1/projects');
    assert.equal(requestInit?.method, 'POST');
    assert.equal(new Headers(requestInit?.headers).get('authorization'), null);
    assert.equal(new Headers(requestInit?.headers).get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(String(requestInit?.body)), { name: 'hello_world' });
    assert.deepEqual(projectResult, { projectId: 'proj_created123', name: 'hello_world', owner: null });
    assert.equal(client.projectUrl(projectResult.projectId), 'https://example.test/en/project/proj_created123');
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
