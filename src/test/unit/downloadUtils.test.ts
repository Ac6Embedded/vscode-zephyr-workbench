import { strict as assert } from 'assert';
import * as fs from 'fs';
import os from 'os';
import path from 'path';

import { DownloadError, downloadFile, Fetcher } from '../../utils/downloadUtils';

const ASSET_URL = 'https://example.test/releases/toolchain.7z';

// A body that sends `chunks`, then either ends or stays open until the request
// is aborted, like a real fetch body does.
function bodyResponse(chunks: string[], signal: AbortSignal | undefined, init: ResponseInit & { hang?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      if (init.hang) {
        signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, { status: 200, ...init });
}

// Fetcher double that records its calls and answers from `respond`.
function fakeFetcher(name: string, respond: (call: number, init?: RequestInit) => Promise<Response>): Fetcher & { calls: number } {
  const fetcher = {
    name,
    calls: 0,
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => respond(++fetcher.calls, init)) as typeof fetch,
  };
  return fetcher;
}

function fakeToken() {
  const listeners: ((e: unknown) => unknown)[] = [];
  return {
    isCancellationRequested: false,
    onCancellationRequested(listener: (e: unknown) => unknown) {
      listeners.push(listener);
      return { dispose() {} };
    },
    cancel() {
      this.isCancellationRequested = true;
      listeners.forEach(listener => listener(undefined));
    },
  };
}

describe('downloadFile', () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-download-'));
    target = path.join(dir, 'downloads', 'toolchain.7z');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('replaces the target file and reports progress', async () => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'stale');
    const fetcher = fakeFetcher('node', async (_call, init) =>
      bodyResponse(['abc', 'def'], init?.signal ?? undefined, { headers: { 'content-length': '6' } }));
    const progress: [number, number | undefined][] = [];

    await downloadFile(ASSET_URL, target, { fetchers: [fetcher], onProgress: (received, total) => progress.push([received, total]) });

    assert.equal(fs.readFileSync(target, 'utf8'), 'abcdef');
    assert.deepEqual(progress.at(-1), [6, 6]);
    assert.equal(fs.existsSync(`${target}.part`), false);
  });

  it('falls back to the next fetcher when the first gets no response', async () => {
    const electron = fakeFetcher('electron', async () => { throw new Error('net::ERR_CONNECTION_REFUSED'); });
    const node = fakeFetcher('node', async (_call, init) => bodyResponse(['ok'], init?.signal ?? undefined));

    await downloadFile(ASSET_URL, target, { fetchers: [electron, node], retryDelaysMs: [] });

    assert.equal(fs.readFileSync(target, 'utf8'), 'ok');
    assert.equal(electron.calls, 1);
    assert.equal(node.calls, 1);
  });

  it('reports certificate failures from every fetcher without retrying', async () => {
    const electron = fakeFetcher('electron', async () => { throw new Error('net::ERR_CERT_DATE_INVALID'); });
    const node = fakeFetcher('node', async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }) });
    });

    await assert.rejects(downloadFile(ASSET_URL, target, { fetchers: [electron, node], retryDelaysMs: [0, 0] }), (err: unknown) => {
      assert.ok(err instanceof DownloadError);
      assert.match(err.message, /could not establish a secure connection to example\.test \(net::ERR_CERT_DATE_INVALID, CERT_HAS_EXPIRED\)/);
      assert.equal(String(err), err.message);
      return true;
    });
    assert.equal(electron.calls, 1);
    assert.equal(node.calls, 1);
  });

  it('does not switch fetchers or retry on HTTP 404', async () => {
    const electron = fakeFetcher('electron', async () => new Response('not found', { status: 404 }));
    const node = fakeFetcher('node', async () => new Response('unused'));

    await assert.rejects(downloadFile(ASSET_URL, target, { fetchers: [electron, node], retryDelaysMs: [0, 0] }), /example\.test answered HTTP 404 for toolchain\.7z/);
    assert.equal(electron.calls, 1);
    assert.equal(node.calls, 0);
  });

  it('retries server errors and truncated bodies', async () => {
    const fetcher = fakeFetcher('node', async (call, init) => {
      if (call === 1) {
        return new Response('busy', { status: 503 });
      }
      if (call === 2) {
        return bodyResponse(['abc'], init?.signal ?? undefined, { headers: { 'content-length': '6' } });
      }
      return bodyResponse(['abcdef'], init?.signal ?? undefined, { headers: { 'content-length': '6' } });
    });

    await downloadFile(ASSET_URL, target, { fetchers: [fetcher], retryDelaysMs: [0, 0] });

    assert.equal(fs.readFileSync(target, 'utf8'), 'abcdef');
    assert.equal(fetcher.calls, 3);
  });

  it('gives up on a stalled body after the retries', async () => {
    const fetcher = fakeFetcher('node', async (_call, init) => bodyResponse(['a'], init?.signal ?? undefined, { hang: true }));

    await assert.rejects(downloadFile(ASSET_URL, target, { fetchers: [fetcher], idleTimeoutMs: 50, retryDelaysMs: [0] }), /toolchain\.7z was interrupted \(no data received/);
    assert.equal(fetcher.calls, 2);
    assert.equal(fs.existsSync(`${target}.part`), false);
  });

  it('rejects with the code the callers treat as a cancellation', async () => {
    const token = fakeToken();
    const fetcher = fakeFetcher('node', async (_call, init) =>
      bodyResponse(['a'], init?.signal ?? undefined, { hang: true, headers: { 'content-length': '10' } }));

    await assert.rejects(
      downloadFile(ASSET_URL, target, { fetchers: [fetcher], token, onProgress: () => token.cancel(), retryDelaysMs: [0, 0] }),
      (err: unknown) => (err as { code?: string }).code === 'ERR_STREAM_PREMATURE_CLOSE',
    );
    assert.equal(fetcher.calls, 1);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(`${target}.part`), false);
  });
});
