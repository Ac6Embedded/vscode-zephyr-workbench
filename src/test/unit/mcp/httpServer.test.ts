import { strict as assert } from 'assert';
import * as http from 'http';
import { startHttpServer, RunningServer } from '../../../mcp/host/httpServer';

interface Reply { status: number; body: string; headers: http.IncomingHttpHeaders }

function request(port: number, options: {
  method?: string; path?: string; host?: string; origin?: string; auth?: string; body?: string;
} = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.host !== undefined) { headers.host = options.host; }
    if (options.origin !== undefined) { headers.origin = options.origin; }
    if (options.auth !== undefined) { headers.authorization = options.auth; }
    const req = http.request({
      host: '127.0.0.1', port, method: options.method ?? 'POST', path: options.path ?? '/mcp', headers,
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    // A GET must not carry a body, or the server has nothing to drain and the
    // socket can hang up before the reply is read.
    req.end((options.method ?? 'POST') === 'GET' ? undefined : (options.body ?? '{}'));
  });
}

describe('mcp/host/httpServer', () => {
  let server: RunningServer;
  const seen: string[] = [];

  beforeEach(async () => {
    seen.length = 0;
    server = await startHttpServer({
      fetch: async () => new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
      health: () => ({ windowId: 'w1' }),
      log: line => seen.push(line),
    });
  });

  afterEach(async () => { await server.close(); });

  it('binds an ephemeral loopback port that appears in no config', () => {
    assert.ok(server.port > 0);
    assert.equal(server.url, `http://127.0.0.1:${server.port}/mcp`);
  });

  it('issues a fresh high-entropy token', () => {
    assert.ok(server.token.length >= 40, 'a 32 byte token base64url encodes to at least 43 characters');
  });

  it('accepts a correctly authenticated POST', async () => {
    const reply = await request(server.port, { auth: `Bearer ${server.token}` });
    assert.equal(reply.status, 200);
    assert.match(reply.body, /"ok":true/);
  });

  it('rejects a missing token with 401 and a challenge', async () => {
    const reply = await request(server.port);
    assert.equal(reply.status, 401);
    assert.equal(reply.headers['www-authenticate'], 'Bearer');
  });

  it('rejects a wrong token', async () => {
    const reply = await request(server.port, { auth: 'Bearer not-the-token' });
    assert.equal(reply.status, 401);
  });

  it('rejects a token of the right length but wrong value', async () => {
    const wrong = 'x'.repeat(server.token.length);
    assert.equal((await request(server.port, { auth: `Bearer ${wrong}` })).status, 401);
  });

  it('rejects a non-loopback Host header, which is the DNS rebinding defence', async () => {
    const reply = await request(server.port, { auth: `Bearer ${server.token}`, host: 'evil.example.com' });
    assert.equal(reply.status, 403);
    assert.ok(seen.some(l => l.includes('Host')), 'the refusal should be logged');
  });

  it('accepts a loopback Host on a different port, so a forwarded port still works', async () => {
    const reply = await request(server.port, { auth: `Bearer ${server.token}`, host: '127.0.0.1:59999' });
    assert.equal(reply.status, 200);
  });

  it('rejects a non-loopback Origin', async () => {
    const reply = await request(server.port, { auth: `Bearer ${server.token}`, origin: 'https://evil.example.com' });
    assert.equal(reply.status, 403);
  });

  it('accepts a loopback Origin, so local inspector tooling works', async () => {
    const reply = await request(server.port, { auth: `Bearer ${server.token}`, origin: 'http://127.0.0.1:6274' });
    assert.equal(reply.status, 200);
  });

  it('checks the Host header before the token, so an unauthenticated probe learns nothing', async () => {
    const reply = await request(server.port, { host: 'evil.example.com' });
    assert.equal(reply.status, 403, 'a bad Host must not reach the token comparison');
  });

  it('answers /health only with a valid token', async () => {
    assert.equal((await request(server.port, { method: 'GET', path: '/health' })).status, 401);
    const reply = await request(server.port, { method: 'GET', path: '/health', auth: `Bearer ${server.token}` });
    assert.equal(reply.status, 200);
    assert.match(reply.body, /"windowId":"w1"/);
  });

  it('404s any other path and 405s a non-POST on /mcp', async () => {
    const auth = `Bearer ${server.token}`;
    assert.equal((await request(server.port, { path: '/anything', auth })).status, 404);
    const notAllowed = await request(server.port, { method: 'GET', auth });
    assert.equal(notAllowed.status, 405);
    assert.equal(notAllowed.headers.allow, 'POST');
  });

  it('never sends CORS headers', async () => {
    const reply = await request(server.port, { auth: `Bearer ${server.token}` });
    assert.equal(reply.headers['access-control-allow-origin'], undefined);
  });

  it('rejects a body over the size cap', async () => {
    const reply = await request(server.port, {
      auth: `Bearer ${server.token}`, body: 'x'.repeat(1024 * 1024 + 10),
    });
    assert.equal(reply.status, 413);
  });

  it('rate limits repeated wrong tokens', async () => {
    for (let i = 0; i < 20; i++) {
      await request(server.port, { auth: 'Bearer wrong' });
    }
    const reply = await request(server.port, { auth: 'Bearer wrong' });
    assert.equal(reply.status, 429, 'a brute force attempt must be throttled');
  });

  it('never locks out the valid token, however many failures came first', async () => {
    // The attack this guards against: anything on the machine, or a browser
    // page probing loopback ports, spraying requests to deny the real bridge.
    for (let i = 0; i < 25; i++) {
      await request(server.port, { auth: 'Bearer wrong' });
      await request(server.port, { method: 'GET', path: '/favicon.ico' });
    }
    assert.equal((await request(server.port, { auth: `Bearer ${server.token}` })).status, 200);
    assert.equal((await request(server.port, { method: 'GET', path: '/health', auth: `Bearer ${server.token}` })).status, 200);
  });

  it('does not count anonymous probes toward the lockout', async () => {
    for (let i = 0; i < 40; i++) {
      await request(server.port, { method: 'GET', path: '/x' });
    }
    assert.equal((await request(server.port, { auth: 'Bearer wrong' })).status, 401, 'probes alone must not trigger 429');
  });
});

describe('mcp/host/httpServer client disconnects', () => {
  it('aborts the request the tool sees when the client goes away, and frees its slot', async () => {
    let aborted = false;
    let calls = 0;
    const server = await startHttpServer({
      fetch: request => {
        calls++;
        if (calls > 1) {
          return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        // A long wait, like build_app waiting on a job.
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('client left'));
          });
        });
      },
      health: () => ({ windowId: 'w1' }),
      log: () => undefined,
    });
    try {
      await new Promise<void>(resolve => {
        const req = http.request({
          host: '127.0.0.1', port: server.port, method: 'POST', path: '/mcp',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
        });
        req.on('error', () => undefined);
        req.end('{}');
        setTimeout(() => { req.destroy(); resolve(); }, 150);
      });
      for (let i = 0; i < 20 && !aborted; i++) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(aborted, true, 'the SDK must learn the call was abandoned');
      const next = await request(server.port, { auth: `Bearer ${server.token}` });
      assert.equal(next.status, 200);
    } finally {
      await server.close();
    }
  });
});
