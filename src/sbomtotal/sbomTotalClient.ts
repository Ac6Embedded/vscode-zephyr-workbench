import * as fs from 'fs';
import * as path from 'path';

export type SbomVerdict = 'clean' | 'review' | 'risk';

export interface ScanTriage {
  actionable: number;
  review: number;
  noise: number;
  total: number;
}

export interface ScanEngine {
  name?: string;
  role?: string;
  status?: string;
  detections?: number;
  summary?: string;
  available?: boolean;
}

export interface ScanResult {
  hash: string;
  verdict: SbomVerdict;
  score?: number;
  triage?: ScanTriage;
  format?: string;
  specVersion?: string;
  ntia?: Record<string, boolean>;
  maturity?: { level?: number; label?: string; summary?: string };
  gaps?: string[];
  engines?: ScanEngine[];
  cached?: boolean;
  [key: string]: unknown;
}

export type SbomReportFormat = 'pdf' | 'docx' | 'md';

export type SbomTotalErrorKind =
  | 'too-large'
  | 'unsupported-type'
  | 'unparseable'
  | 'rate-limited'
  | 'auth'
  | 'network'
  | 'timeout'
  | 'server'
  | 'unexpected';

export class SbomTotalError extends Error {
  constructor(
    message: string,
    public readonly kind: SbomTotalErrorKind,
    public readonly status?: number,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'SbomTotalError';
  }
}

export interface SbomTotalClientOptions {
  baseUrl: string;
  token?: string;
  /**
   * When true, a 401/403 response drops the token and retries the request once
   * anonymously (every endpoint the client uses is public; the token only adds
   * account attribution). Meant for the built-in default token, which may have
   * been revoked server side.
   */
  anonymousFallback?: boolean;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;

interface PerformResult {
  status: number;
  json?: unknown;
  buffer?: ArrayBuffer;
}

export class SbomTotalClient {
  private readonly baseUrl: string;
  private token?: string;
  private readonly anonymousFallback: boolean;
  private readonly timeoutMs: number;

  constructor(options: SbomTotalClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.anonymousFallback = options.anonymousFallback ?? false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  permalinkUrl(hash: string): string {
    return `${this.baseUrl}/en/scan/${hash}`;
  }

  /**
   * Look up a stored scan result by the sha256 of the SBOM bytes.
   * Public and not rate limited server side, so probing before uploading is free.
   * Returns undefined when the service has no result for that content.
   */
  async getScanByContent(sha256: string, signal?: AbortSignal): Promise<ScanResult | undefined> {
    const result = await this.perform(`/api/v1/scan/${sha256}`, { method: 'GET' }, signal, 'json', { allow404: true });
    return result.status === 404 ? undefined : (result.json as ScanResult);
  }

  /**
   * Upload one SBOM and wait for the full scan result (the endpoint is synchronous
   * and may take tens of seconds).
   */
  async scanSbom(
    bytes: Uint8Array,
    fileName: string,
    options?: { force?: boolean; signal?: AbortSignal },
  ): Promise<ScanResult> {
    const form = new FormData();
    // Copy into a plain ArrayBuffer-backed view so Node Buffers pool offsets never leak.
    const payload = new Uint8Array(bytes);
    form.append('file', new Blob([payload]), fileName);

    const query = options?.force ? '?force=true' : '';
    // redirect: 'error' because following a redirect would resend the POST as a
    // bodyless GET; a redirecting baseUrl must be fixed in the setting instead.
    const result = await this.perform(
      `/api/v1/scan-sbom${query}`,
      { method: 'POST', body: form, redirect: 'error' },
      options?.signal,
      'json',
    );
    return result.json as ScanResult;
  }

  /** Download a generated report for a stored scan into destPath. */
  async downloadReport(
    hash: string,
    format: SbomReportFormat,
    destPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.perform(`/api/v1/scan/${hash}/report.${format}`, { method: 'GET' }, signal, 'buffer');
    const data = Buffer.from(result.buffer as ArrayBuffer);
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await fs.promises.writeFile(destPath, data);
  }

  /**
   * One full request lifecycle: the timeout and the caller's signal stay armed
   * through the BODY read as well (the synchronous scan endpoint streams its
   * response late), and every failure surfaces as SbomTotalError except a
   * caller-initiated abort, which is rethrown as-is.
   */
  private async perform(
    apiPath: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    read: 'json' | 'buffer',
    options?: { allow404?: boolean },
  ): Promise<PerformResult> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onOuterAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener('abort', onOuterAbort);
      }
    }

    const transportError = (error: unknown): Error => {
      if (controller.signal.aborted) {
        if (timedOut) {
          return new SbomTotalError(
            `The SBOM Total request timed out after ${Math.round(this.timeoutMs / 1000)} seconds. The service may still be processing; a finished scan is cached, so trying again shortly is cheap.`,
            'timeout',
          );
        }
        // Cancelled by the caller: rethrow so the orchestrator treats it as a cancellation.
        return error instanceof Error ? error : new Error(String(error));
      }
      const detail = error instanceof Error ? error.message : String(error);
      if (init.redirect === 'error' && error instanceof TypeError) {
        return new SbomTotalError(
          `The SBOM Total service URL redirected the upload. Set zephyr-workbench.sbomTotal.baseUrl to the final URL (including the right scheme and host).`,
          'network', undefined, detail,
        );
      }
      return new SbomTotalError(
        `Could not reach the SBOM Total service at ${this.baseUrl}. Check the URL in Settings (zephyr-workbench.sbomTotal.baseUrl) and your network connection.`,
        'network', undefined, detail,
      );
    };

    try {
      const headers: Record<string, string> = {};
      if (this.token) {
        headers['Authorization'] = `Bearer ${this.token}`;
      }

      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${apiPath}`, { ...init, headers, signal: controller.signal });
      } catch (error) {
        throw transportError(error);
      }

      if ((response.status === 401 || response.status === 403) && this.anonymousFallback && this.token) {
        // The (built-in) token was rejected, probably revoked. Every endpoint
        // used here is public, so drop it and retry once without credentials.
        this.token = undefined;
        return await this.perform(apiPath, init, signal, read, options);
      }

      if (options?.allow404 && response.status === 404) {
        return { status: 404 };
      }

      if (!response.ok) {
        let detail = '';
        try {
          detail = (await response.text()).slice(0, 2000);
        } catch {
          // Keep the status-based message when the body is unreadable.
        }
        throw this.errorFromStatus(response.status, response.headers, detail);
      }

      try {
        if (read === 'json') {
          return { status: response.status, json: await response.json() };
        }
        return { status: response.status, buffer: await response.arrayBuffer() };
      } catch (error) {
        if (controller.signal.aborted) {
          throw transportError(error);
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new SbomTotalError(
          'The SBOM Total service returned a response that could not be read. Try again, and check that the base URL points at the service API.',
          'unexpected', response.status, detail,
        );
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  private errorFromStatus(status: number, headers: Headers, detail: string): SbomTotalError {
    switch (status) {
      case 401:
      case 403:
        return new SbomTotalError(
          'SBOM Total rejected the API token. Update it with the "Set SBOM Total API Token" command.',
          'auth', status, detail,
        );
      case 413:
        return new SbomTotalError(
          'The SBOM file is larger than 50 MB, which SBOM Total does not accept.',
          'too-large', status, detail,
        );
      case 415:
        return new SbomTotalError(
          'SBOM Total does not accept this file type. Allowed extensions: .json, .xml, .spdx, .cdx, .sbom, .tv.',
          'unsupported-type', status, detail,
        );
      case 422:
        return new SbomTotalError(
          'SBOM Total could not parse this file. Note: SPDX 3.0 JSON-LD is not supported yet; generate SPDX 2.3 documents (Only Build SPDX 2.3) and verify again.',
          'unparseable', status, detail,
        );
      case 429: {
        const retryAfter = headers.get('retry-after');
        const retryHint = retryAfter ? ` Retry after about ${retryAfter} seconds.` : '';
        return new SbomTotalError(
          `SBOM Total rate limit reached (about 30 scans per hour per IP).${retryHint} Unchanged SBOMs are served from cache, so try again later or use a self-hosted instance.`,
          'rate-limited', status, detail,
        );
      }
      default:
        if (status >= 500) {
          return new SbomTotalError(
            `The SBOM Total service returned an error (HTTP ${status}). Try again later.`,
            'server', status, detail,
          );
        }
        return new SbomTotalError(
          `Unexpected response from the SBOM Total service (HTTP ${status}).`,
          'unexpected', status, detail,
        );
    }
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
