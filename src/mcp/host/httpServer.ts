// The loopback MCP endpoint for one VS Code window.
//
// Security posture, in order of what runs first: the peer must be loopback, the
// Host header must name loopback, any non-loopback Origin is refused, and only
// then is the bearer token compared in constant time. The SDK entry point is
// deliberately validation-free, so these guards belong in front of it.
//
// The port is ephemeral and appears in no configuration file. That is the point:
// a fixed shared port is the most complained-about part of comparable
// implementations, because a second window silently takes over the first.

import { randomBytes, timingSafeEqual } from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';
import { logSafe } from '../core/redact';

export interface HttpServerOptions {
  /** Requested port. 0 means let the OS choose, which is the default. */
  port?: number;
  /** Handles a validated MCP request. */
  fetch(request: Request): Promise<Response>;
  /** Extra health payload merged into the /health response. */
  health(): Record<string, unknown>;
  log(line: string): void;
}

export interface RunningServer {
  port: number;
  token: string;
  url: string;
  healthUrl: string;
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CONCURRENT = 32;
const AUTH_FAILURE_WINDOW_MS = 60_000;
const AUTH_FAILURE_LIMIT = 20;

function isLoopbackPeer(request: http.IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function hostIsLoopback(header: string | undefined): boolean {
  if (!header) {
    return false;
  }
  // Compare the hostname only: a forwarded port differs from ours.
  const host = header.startsWith('[') ? header.slice(0, header.indexOf(']') + 1) : header.split(':')[0];
  return LOOPBACK_HOSTS.has(host);
}

function originIsLoopback(header: string | undefined): boolean {
  if (!header) {
    // CLI clients send no Origin, which is normal and allowed.
    return true;
  }
  try {
    return LOOPBACK_HOSTS.has(new URL(header).hostname) || new URL(header).hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

async function readBody(request: http.IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      return undefined;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function startHttpServer(options: HttpServerOptions): Promise<RunningServer> {
  const token = randomBytes(32).toString('base64url');
  let inFlight = 0;
  let authFailures: number[] = [];

  const deny = (res: http.ServerResponse, status: number, message: string) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (!isLoopbackPeer(req)) {
          return deny(res, 403, 'Only loopback connections are accepted.');
        }
        if (!hostIsLoopback(req.headers.host)) {
          options.log(`refused a request with Host "${logSafe(req.headers.host ?? '', 100)}"`);
          return deny(res, 403, 'Invalid Host header.');
        }
        if (!originIsLoopback(req.headers.origin)) {
          options.log(`refused a request with Origin "${logSafe(req.headers.origin ?? '', 100)}"`);
          return deny(res, 403, 'Invalid Origin header.');
        }

        // The token is checked first, and throttling applies only to requests
        // that fail it. A shared failure counter that ran before the token
        // check let any local process, or a browser page probing loopback
        // ports, lock the real bridge out with twenty anonymous requests.
        const header = req.headers.authorization ?? '';
        const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
        if (!presented || !constantTimeEquals(presented, token)) {
          const now = Date.now();
          authFailures = authFailures.filter(at => now - at < AUTH_FAILURE_WINDOW_MS);
          if (presented && authFailures.length < AUTH_FAILURE_LIMIT) {
            // Only a wrong token is a guess worth counting. A missing header is
            // a probe, not an attack on the token. Past the limit nothing more
            // is recorded, so a flood costs a constant amount of work each.
            authFailures.push(now);
            if (authFailures.length === 1) {
              options.log('refused a request with a wrong bearer token');
            }
          }
          if (authFailures.length >= AUTH_FAILURE_LIMIT) {
            return deny(res, 429, 'Too many failed authentication attempts.');
          }
          res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
          return res.end(JSON.stringify({ error: 'Unauthorized.' }));
        }

        const url = new URL(req.url ?? '/', `http://127.0.0.1`);
        // Anything that is not the MCP POST is answered without reading a body,
        // so drain the stream first or the peer can see the socket hang up.
        if (req.method !== 'POST' || url.pathname !== '/mcp') {
          req.resume();
        }
        if (url.pathname === '/health' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, ...options.health() }));
        }
        if (url.pathname !== '/mcp') {
          return deny(res, 404, 'Not found.');
        }
        if (req.method !== 'POST') {
          // The 2026 protocol has no session GET or DELETE.
          res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
          return res.end(JSON.stringify({ error: 'Method not allowed.' }));
        }
        if (inFlight >= MAX_CONCURRENT) {
          return deny(res, 503, 'Too many concurrent requests.');
        }

        // Counted from before the body is read, so slow senders cannot get
        // past the limit, and released however the request ends.
        inFlight++;
        // Aborted when the client goes away, which is how the MCP SDK learns
        // a call was abandoned: the tool's signal fires, and a long wait ends
        // instead of holding a slot until wait_sec runs out.
        const gone = new AbortController();
        res.on('close', () => {
          if (!res.writableFinished) {
            gone.abort();
          }
        });
        try {
          const body = await readBody(req);
          if (body === undefined) {
            return deny(res, 413, 'Request body too large.');
          }
          const response = await options.fetch(new Request('http://127.0.0.1/mcp', {
            method: 'POST',
            headers: req.headers as Record<string, string>,
            body,
            signal: gone.signal,
          }));
          if (gone.signal.aborted) {
            await response.body?.cancel().catch(() => undefined);
            return;
          }
          res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
          if (response.body) {
            // Stream so SSE progress reaches the client as it happens.
            const reader = response.body.getReader();
            const stop = () => void reader.cancel().catch(() => undefined);
            gone.signal.addEventListener('abort', stop, { once: true });
            try {
              while (!gone.signal.aborted) {
                const { done, value } = await reader.read();
                if (done) {
                  break;
                }
                res.write(Buffer.from(value));
              }
            } finally {
              gone.signal.removeEventListener('abort', stop);
            }
          }
          res.end();
        } catch (error) {
          if (gone.signal.aborted) {
            return; // The client left; there is nobody to answer.
          }
          throw error;
        } finally {
          inFlight--;
        }
      } catch (error) {
        options.log(`request failed: ${logSafe(error instanceof Error ? error.message : String(error))}`);
        if (!res.headersSent) {
          deny(res, 500, 'Internal error.');
        } else {
          res.end();
        }
      }
    })();
  });

  // CORS is never enabled, so no preflight is ever answered.
  server.headersTimeout = 10_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  return {
    port,
    token,
    url: `http://127.0.0.1:${port}/mcp`,
    healthUrl: `http://127.0.0.1:${port}/health`,
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
