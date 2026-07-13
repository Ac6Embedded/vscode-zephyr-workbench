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

export interface SbomProject {
  projectId: string;
  name: string;
  owner?: string | null;
}

export type SbomReportFormat = 'pdf' | 'docx' | 'md';

export type SbomTotalErrorKind =
  | 'too-large'
  | 'unsupported-type'
  | 'unparseable'
  | 'rate-limited'
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
  private readonly timeoutMs: number;

  constructor(options: SbomTotalClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  permalinkUrl(hash: string): string {
    return `${this.baseUrl}/en/scan/${hash}`;
  }

  projectUrl(projectId: string): string {
    return `${this.baseUrl}/en/project/${projectId}`;
  }

  async createProject(name: string, signal?: AbortSignal): Promise<SbomProject> {
    const result = await this.perform(
      '/api/v1/projects',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      },
      signal,
      'json',
    );
    const project = result.json as Partial<SbomProject> | undefined;
    if (!project || typeof project.projectId !== 'string' || !project.projectId.startsWith('proj_')) {
      throw new SbomTotalError('SBOM Total returned an invalid project identifier.', 'unexpected', result.status);
    }
    return {
      projectId: project.projectId,
      name: typeof project.name === 'string' ? project.name : name,
      owner: project.owner,
    };
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
   * Upload one SBOM and stream the scan (VirusTotal style): the service emits
   * one Server-Sent event per engine as it finishes, then a final result. This
   * both surfaces live progress and keeps the connection alive, so a scan that
   * runs for minutes never trips a fixed total timeout; only a silent
   * connection (no frame within timeoutMs) aborts.
   *
   * Validation failures (415/422/429/...) come back as a normal HTTP status
   * before the stream opens and are mapped identically to the other endpoints.
   */
  async scanSbomStream(
    bytes: Uint8Array,
    fileName: string,
    options?: {
      force?: boolean;
      projectId?: string;
      projectLabel?: string;
      signal?: AbortSignal;
      onPending?: (engineNames: string[]) => void;
      onEngine?: (engine: ScanEngine) => void;
    },
  ): Promise<ScanResult> {
    const form = new FormData();
    // Copy into a plain ArrayBuffer-backed view so Node Buffers pool offsets never leak.
    form.append('file', new Blob([new Uint8Array(bytes)]), fileName);
    if (options?.projectId) {
      form.append('project', options.projectId);
    }
    if (options?.projectLabel) {
      form.append('label', options.projectLabel);
    }
    const query = options?.force ? '?force=true' : '';

    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs);
    };
    const onOuterAbort = () => controller.abort();
    if (options?.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener('abort', onOuterAbort);
      }
    }
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      options?.signal?.removeEventListener('abort', onOuterAbort);
    };
    const abortError = (error: unknown): Error => {
      if (controller.signal.aborted) {
        if (timedOut) {
          return new SbomTotalError(
            `The SBOM Total scan made no progress for ${Math.round(this.timeoutMs / 1000)} seconds. The service may still finish and cache it, so trying again shortly is cheap.`,
            'timeout',
          );
        }
        return error instanceof Error ? error : new Error(String(error));
      }
      return new SbomTotalError(
        `Could not reach the SBOM Total service at ${this.baseUrl}. Check the URL in Settings (zephyr-workbench.sbomTotal.baseUrl) and your network connection.`,
        'network', undefined, error instanceof Error ? error.message : String(error),
      );
    };

    armIdle();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/v1/scan-sbom/stream${query}`, {
        method: 'POST', body: form, redirect: 'error', signal: controller.signal,
      });
    } catch (error) {
      cleanup();
      throw abortError(error);
    }

    if (!response.ok || !response.body) {
      let detail = '';
      try {
        detail = (await response.text()).slice(0, 2000);
      } catch {
        // Keep the status-based message when the body is unreadable.
      }
      cleanup();
      if (!response.ok) {
        throw this.errorFromStatus(response.status, response.headers, detail);
      }
      throw new SbomTotalError('The SBOM Total service did not return a scan stream.', 'unexpected', response.status);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: ScanResult | undefined;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        armIdle();
        buffer += decoder.decode(chunk.value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const parsed = parseSseFrame(frame);
          if (!parsed) {
            continue;
          }
          if (parsed.event === 'pending') {
            const engines = Array.isArray(parsed.data?.engines)
              ? parsed.data.engines.map((e: ScanEngine) => e?.name ?? '').filter((n: string) => n.length > 0)
              : [];
            options?.onPending?.(engines);
          } else if (parsed.event === 'engine') {
            options?.onEngine?.(parsed.data as ScanEngine);
          } else if (parsed.event === 'result') {
            result = parsed.data as ScanResult;
          } else if (parsed.event === 'error') {
            throw new SbomTotalError(
              typeof parsed.data?.detail === 'string' ? parsed.data.detail : 'The SBOM Total scan failed.',
              'server',
            );
          }
        }
      }
    } catch (error) {
      // Map the error BEFORE aborting (abortError classifies by signal state),
      // then close the connection so an abandoned stream (for example after a
      // mid-stream error frame) does not pin the socket.
      const mapped = error instanceof SbomTotalError ? error : abortError(error);
      controller.abort();
      throw mapped;
    } finally {
      cleanup();
      try {
        reader.releaseLock();
      } catch {
        // Reader may already be released after an abort.
      }
    }

    if (!result) {
      throw new SbomTotalError('The SBOM Total scan stream ended without a result.', 'unexpected');
    }
    return result;
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
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${apiPath}`, { ...init, signal: controller.signal });
      } catch (error) {
        throw transportError(error);
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
          'SBOM Total could not parse this SBOM. If it is an SPDX 3.0 document, this service deployment may not support SPDX 3.0 yet; check that the instance at zephyr-workbench.sbomTotal.baseUrl is up to date.',
          'unparseable', status, detail,
        );
      case 429: {
        const retryAfter = headers.get('retry-after');
        const retryHint = retryAfter ? ` Retry after about ${retryAfter} seconds.` : '';
        return new SbomTotalError(
          `SBOM Total rate limit reached (about 30 scans or project creations per hour per IP).${retryHint} Unchanged SBOMs are served from cache, so try again later or use a self-hosted instance.`,
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

/** Parse one Server-Sent-Events frame ("event: x\ndata: {...}"). */
function parseSseFrame(frame: string): { event: string; data: any } | undefined {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) {
    return undefined;
  }
  const raw = dataLines.join('\n');
  try {
    return { event, data: JSON.parse(raw) };
  } catch {
    return { event, data: raw };
  }
}
