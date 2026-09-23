import * as fs from 'fs';
import path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import type { CancellationToken, Disposable } from 'vscode';

export interface Fetcher {
  name: string;
  fetch: typeof fetch;
}

export interface DownloadOptions {
  token?: CancellationToken;
  onProgress?: (receivedBytes: number, totalBytes: number | undefined) => void;
  /** Tried in order until one gets a response. Defaults to getDownloadFetchers(). */
  fetchers?: Fetcher[];
  /** An attempt is aborted when no data arrives for this long. */
  idleTimeoutMs?: number;
  /** Wait before each retry of a transient failure; its length is the number of retries. */
  retryDelaysMs?: number[];
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_DELAYS_MS = [2_000, 5_000];

/** A download failure whose message can be shown to the user as is. */
export class DownloadError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }

  // Some callers show `"Download failed: " + e`: keep the text free of an "Error:" prefix.
  toString(): string {
    return this.message;
  }
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

class InterruptedError extends Error {}

/**
 * Fetchers used for downloads, in the order they are tried.
 *
 * Electron's `net.fetch` goes through Chromium's network stack, so proxies
 * (system settings, PAC, `http.proxy`) and certificate checks behave as in the
 * browser. It is only available in the local extension host. Remote extension
 * hosts (WSL, SSH, containers) use Node's `fetch`, which VS Code extends with
 * its proxy and system certificate support.
 */
export function getDownloadFetchers(): Fetcher[] {
  const fetchers: Fetcher[] = [];
  const electronFetch = getElectronFetch();
  if (electronFetch) {
    fetchers.push({ name: 'electron', fetch: electronFetch });
  }
  fetchers.push({ name: 'node', fetch: (input, init) => fetch(input, init) });
  return fetchers;
}

function getElectronFetch(): typeof fetch | undefined {
  try {
    // Not part of the VS Code API, so resolved at runtime (kept out of the bundle
    // in esbuild.js). The built-in Copilot extension uses it the same way.
    const net = require('electron')?.net;
    return typeof net?.fetch === 'function' ? net.fetch.bind(net) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Downloads `url` to `filePath`, replacing any existing file.
 *
 * Data is written to `<filePath>.part` and renamed once complete, so a
 * truncated file is never left at `filePath`. Server errors and dropped or
 * stalled connections are retried. Cancelling rejects with the
 * `ERR_STREAM_PREMATURE_CLOSE` code the callers check for.
 */
export async function downloadFile(url: string, filePath: string, options: DownloadOptions = {}): Promise<void> {
  const partPath = `${filePath}.part`;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

  for (let attempt = 0; ; attempt++) {
    try {
      await downloadOnce(url, partPath, options);
      await fs.promises.rm(filePath, { force: true });
      await fs.promises.rename(partPath, filePath);
      return;
    } catch (error) {
      await fs.promises.rm(partPath, { force: true }).catch(() => undefined);
      throwIfCancelled(options.token);
      const failure = toDownloadError(url, error);
      if (!failure.retryable || attempt >= retryDelaysMs.length) {
        throw failure;
      }
      await wait(retryDelaysMs[attempt], options.token);
      throwIfCancelled(options.token);
    }
  }
}

async function downloadOnce(url: string, partPath: string, options: DownloadOptions): Promise<void> {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const failures: unknown[] = [];

  for (const fetcher of options.fetchers ?? getDownloadFetchers()) {
    const watchdog = new Watchdog(idleTimeoutMs, options.token);
    let response: Response | undefined;
    try {
      response = await fetcher.fetch(url, { signal: watchdog.signal });
      if (!response.ok || !response.body) {
        throw new HttpStatusError(response.status);
      }
      await writeBody(response, partPath, watchdog, options.onProgress);
      return;
    } catch (error) {
      const failure = watchdog.timedOut
        ? new InterruptedError(`no data received for ${idleTimeoutMs / 1000} s`)
        : error;
      // Only a fetcher that got no response at all is worth replacing by the next one.
      if (response || options.token?.isCancellationRequested) {
        throw failure;
      }
      failures.push(failure);
    } finally {
      watchdog.dispose();
    }
  }
  throw new AggregateError(failures, 'No fetcher got a response');
}

async function writeBody(
  response: Response,
  partPath: string,
  watchdog: Watchdog,
  onProgress: DownloadOptions['onProgress'],
): Promise<void> {
  // Content-Length is the encoded size, so it only matches an uncompressed body.
  const encoding = response.headers.get('content-encoding');
  const length = Number(response.headers.get('content-length'));
  const totalBytes = (!encoding || encoding === 'identity') && length > 0 ? length : undefined;

  let receivedBytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      watchdog.reset();
      receivedBytes += chunk.length;
      onProgress?.(receivedBytes, totalBytes);
      callback(null, chunk);
    },
  });
  const body = Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>);
  await pipeline(body, meter, fs.createWriteStream(partPath));

  if (totalBytes !== undefined && receivedBytes !== totalBytes) {
    throw new InterruptedError(`received ${receivedBytes} of ${totalBytes} bytes`);
  }
}

/** Aborts a request when cancelled, or when no data arrives for `timeoutMs`. */
class Watchdog {
  private readonly controller = new AbortController();
  private readonly cancellation: Disposable | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  timedOut = false;

  constructor(private readonly timeoutMs: number, token: CancellationToken | undefined) {
    this.cancellation = token?.onCancellationRequested(() => this.controller.abort());
    if (token?.isCancellationRequested) {
      this.controller.abort();
    }
    this.reset();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  reset(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort();
    }, this.timeoutMs);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.cancellation?.dispose();
  }
}

function toDownloadError(url: string, error: unknown): DownloadError {
  if (error instanceof DownloadError) {
    return error;
  }
  const { host, pathname } = new URL(url);
  const fileName = path.basename(pathname);

  if (error instanceof HttpStatusError) {
    const retryable = error.status >= 500 || error.status === 408 || error.status === 429;
    return new DownloadError(`${host} answered HTTP ${error.status} for ${fileName}`, retryable);
  }
  if (error instanceof InterruptedError) {
    return new DownloadError(`the download of ${fileName} was interrupted (${error.message})`, true);
  }

  const errors = error instanceof AggregateError ? error.errors : [error];
  const codes = [...new Set(errors.map(errorCode).filter((code): code is string => !!code))];
  const detail = codes.length > 0 ? ` (${codes.join(', ')})` : '';

  if (codes.some(code => /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/.test(code))) {
    return new DownloadError(
      `could not establish a secure connection to ${host}${detail}. A proxy or security software inspecting HTTPS traffic is the usual cause.`,
      false,
    );
  }
  if (codes.some(code => /PROXY|TUNNEL/.test(code))) {
    return new DownloadError(`could not connect to ${host} through the proxy${detail}. Check the proxy settings.`, false);
  }
  if (codes.some(code => /NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ENOTFOUND|EAI_AGAIN/.test(code))) {
    return new DownloadError(`could not reach ${host}${detail}. Check the network connection.`, true);
  }
  const message = errorMessage(errors[0]);
  const unmentioned = codes.filter(code => !message.includes(code));
  const extra = unmentioned.length > 0 ? ` (${unmentioned.join(', ')})` : '';
  return new DownloadError(`could not download ${fileName}: ${message}${extra}`, true);
}

// Node's fetch rejects with TypeError('fetch failed') and the system error as
// `cause`. Electron's net.fetch rejects with the Chromium error as message.
function errorCode(error: unknown): string | undefined {
  const { code, cause, message } = (error ?? {}) as { code?: unknown; cause?: { code?: unknown }; message?: unknown };
  if (typeof cause?.code === 'string') {
    return cause.code;
  }
  if (typeof code === 'string') {
    return code;
  }
  return typeof message === 'string' ? /net::ERR_[A-Z0-9_]+/.exec(message)?.[0] : undefined;
}

function errorMessage(error: unknown): string {
  const { cause, message } = (error ?? {}) as { cause?: { message?: unknown }; message?: unknown };
  if (typeof cause?.message === 'string') {
    return cause.message;
  }
  return typeof message === 'string' ? message : String(error);
}

function throwIfCancelled(token: CancellationToken | undefined): void {
  if (token?.isCancellationRequested) {
    throw Object.assign(new Error('Download cancelled'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
  }
}

function wait(ms: number, token: CancellationToken | undefined): Promise<void> {
  return new Promise(resolve => {
    let listener: Disposable | undefined;
    const timer = setTimeout(done, ms);
    listener = token?.onCancellationRequested(done);

    function done() {
      clearTimeout(timer);
      listener?.dispose();
      resolve();
    }
  });
}
