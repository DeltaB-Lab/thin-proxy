import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { Miniflare } from 'miniflare';

let mf: Miniflare;
const origin = 'https://relay.example';
const adminKey = 'integration-admin-secret-not-for-production-123456';
let cookie: string;
let keyA: string; let keyB: string; let idA: string; let upstreamA: string; let upstreamB: string;
const upstreamScript = `
export default { async fetch(request) {
  const url = new URL(request.url);
  if (request.headers.get('Upgrade') === 'websocket') {
    if (url.pathname.includes('ws-fail')) return new Response('handshake refused', {status: 403});
    const pair = new WebSocketPair(); pair[1].binaryType = 'arraybuffer'; pair[1].accept();
    pair[1].addEventListener('message', e => pair[1].send(e.data));
    pair[1].addEventListener('close', e => pair[1].close(e.code === 1005 ? 1000 : e.code, e.reason));
    const headers = new Headers();
    if(request.headers.get('Sec-WebSocket-Protocol')) headers.set('Sec-WebSocket-Protocol', 'relay-test');
    headers.set('X-Upstream', url.hostname);
    return new Response(null, {status:101, webSocket:pair[0], headers});
  }
  if (url.pathname.endsWith('/sse')) {
    const stream = new ReadableStream({start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"nested":{"a":1}}\\n\\n'));
      setTimeout(() => {controller.enqueue(new TextEncoder().encode('data: [DONE]\\n\\n'));controller.close();}, 350);
    }});
    return new Response(stream, {headers:{'Content-Type':'text/event-stream'}});
  }
  if (url.pathname.endsWith('/redirect')) return new Response('keep redirect', {status:307,headers:{Location:'https://never-follow.example/target'}});
  if (url.pathname.endsWith('/error')) return new Response(' {"error":{"nested":[1,2]}} ', {status:429,headers:{'X-Custom':'preserved'}});
  const bytes = new Uint8Array(await request.arrayBuffer());
  return Response.json({url:request.url, method:request.method, headers:Object.fromEntries(request.headers), bytes:Array.from(bytes)});
}};`;
async function admin(path: string, method = 'GET', body?: unknown, withCookie = true) {
  return mf.dispatchFetch(`${origin}/_relay/api${path}`, {
    method, headers: { Origin: origin, ...(withCookie && cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}
async function value(response: Awaited<ReturnType<typeof admin>>) {
  const body = await response.json() as any;
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body;
}
async function proxy(path: string, key = keyA, options: Record<string, any> = {}) {
  return mf.dispatchFetch(`${origin}${path}`, { redirect: 'manual', ...options, headers: { Authorization: `Bearer ${key}`, ...options.headers } });
}
beforeAll(async () => {
  const bundled = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', target: 'es2022' });
  mf = new Miniflare({
    workers: [{ name: 'relay', modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-08-06',
      d1Databases: { DB: 'integration-db' },
      bindings: { ADMIN_KEY: adminKey, UPSTREAM_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), CONFIG_CACHE_TTL_SECONDS: '30' },
      outboundService: 'upstream',
      serviceBindings: { ASSETS: async () => new Response('<html>management</html>', { headers: { 'Content-Type': 'text/html' } }) }
    }, { name: 'upstream', modules: true, script: upstreamScript, compatibilityDate: '2026-08-06' }]
  });
  const db = await mf.getD1Database('DB', 'relay');
  const migration = await readFile('migrations/0001_config.sql', 'utf8');
  for (const statement of migration.split(';').filter(s => s.trim())) await db.prepare(statement).run();
}, 60_000);
afterAll(async () => { await mf?.dispose(); });

describe.sequential('real Workers runtime: admin and opaque reverse proxy', () => {
  it('requires admin login and enforces same-origin writes', async () => {
    expect((await admin('/config', 'GET', undefined, false)).status).toBe(401);
    expect((await admin('/session', 'POST', { key: 'wrong' }, false)).status).toBe(401);
    const cross = await mf.dispatchFetch(`${origin}/_relay/api/session`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ key: adminKey }) });
    expect(cross.status).toBe(403);
    const response = await admin('/session', 'POST', { key: adminKey }, false);
    expect(response.status).toBe(200); cookie = response.headers.get('set-cookie')!.split(';')[0];
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect((await admin('/config')).status).toBe(200);
    expect((await proxy('/v1/messages', adminKey)).status).toBe(401);
  });
  it('creates independent forwarding keys without exposing hashes in listings', async () => {
    const a = await value(await admin('/keys', 'POST', { name: 'A' })); keyA = a.key; idA = a.id;
    keyB = (await value(await admin('/keys', 'POST', { name: 'B' }))).key;
    const keys = await value(await admin('/keys'));
    expect(keys).toHaveLength(2); expect(keys[0].keyHash).toBeUndefined(); expect(keys[0].key).toBeUndefined();
    expect((await admin('/session', 'POST', { key: keyA }, false)).status).toBe(401);
    expect((await proxy('/v1/messages')).status).toBe(409);
  });
  it('saves encrypted upstreams and switches one global selection', async () => {
    const a = await value(await admin('/upstreams', 'POST', { name: 'A', baseUrl: 'https://a.example/gateway', authType: 'bearer', key: 'upstream-secret-A' })); upstreamA = a.id;
    upstreamB = (await value(await admin('/upstreams', 'POST', { name: 'B', baseUrl: 'https://b.example', authType: 'x-api-key', key: 'upstream-secret-B' }))).id;
    expect(a.keyCiphertext).toBeUndefined();
    const db = await mf.getD1Database('DB', 'relay');
    const row = await db.prepare('SELECT config_json FROM config WHERE id=1').first<{config_json:string}>();
    expect(row!.config_json).not.toContain('upstream-secret-A'); expect(row!.config_json).not.toContain(keyA);
    expect((await admin('/active-upstream', 'PUT', { id: upstreamA })).status).toBe(200);
    expect((await admin(`/upstreams/${upstreamA}`, 'DELETE')).status).toBe(409);
  });
  it.each([
    ['application/json', Buffer.from(' { "messages" : [{"content":{"nested":[1,null,"中文"]}}], "extra":true }\n')],
    ['application/octet-stream', Buffer.from([0,255,3,128,13,10,0])],
    ['text/plain', Buffer.from('not JSON\r\n { broken')],
    ['multipart/form-data; boundary=x', Buffer.from('--x\r\nContent-Disposition: form-data; name="nested[a]"\r\n\r\nvalue\r\n--x--\r\n')]
  ])('preserves %s bytes, nesting, URL, business headers and swaps only authentication', async (contentType, bytes) => {
    const response = await proxy('/v1/a%2Fb?x=1&x=2', keyA, { method: 'POST', body: bytes, headers: { 'Content-Type': contentType, 'x-business': 'keep', Cookie: `${cookie}; business=keep` } });
    const echo = await response.json() as any;
    expect(echo.bytes).toEqual(Array.from(bytes)); expect(echo.method).toBe('POST');
    expect(echo.url).toBe('https://a.example/gateway/v1/a%2Fb?x=1&x=2');
    expect(echo.headers.authorization).toBe('Bearer upstream-secret-A'); expect(echo.headers['x-api-key']).toBeUndefined();
    expect(echo.headers['x-business']).toBe('keep'); expect(echo.headers.cookie.trim()).toBe('business=keep');
  });
  it('preserves upstream errors and never follows redirects', async () => {
    const error = await proxy('/error'); expect(error.status).toBe(429); expect(error.headers.get('x-custom')).toBe('preserved');
    expect(await error.text()).toBe(' {"error":{"nested":[1,2]}} ');
    const redirect = await proxy('/redirect'); expect(redirect.status).toBe(307); expect(await redirect.text()).toBe('keep redirect');
  });
  it('streams SSE before the upstream closes and preserves event bytes', async () => {
    const response = await proxy('/sse'); expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const first = await reader.read(); expect(new TextDecoder().decode(first.value)).toBe('data: {"nested":{"a":1}}\n\n');
    const second = await reader.read(); expect(new TextDecoder().decode(second.value)).toBe('data: [DONE]\n\n');
    expect((await reader.read()).done).toBe(true);
  });
  it('proxies native WebSocket text/binary, subprotocol, failed handshake and retains existing connections on switch', async () => {
    const response = await proxy('/ws', keyA, { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'relay-test' } });
    expect(response.status).toBe(101); expect(response.headers.get('sec-websocket-protocol')).toBe('relay-test');
    expect(response.headers.get('x-upstream')).toBe('a.example');
    const ws = response.webSocket!; ws.accept();
    const receive = () => new Promise<any>((resolve, reject) => { ws.addEventListener('message', e => resolve(e.data), { once: true }); ws.addEventListener('error', reject, { once: true }); });
    let pending = receive(); ws.send(' {"nested":{"raw":true}} '); expect(await pending).toBe(' {"nested":{"raw":true}} ');
    await admin('/active-upstream', 'PUT', { id: upstreamB });
    // Buffer avoids cross-realm ArrayBuffer detection in the Node-side test client.
    pending = receive(); ws.send(Buffer.from([0,255,128]));
    const binary = await pending;
    expect(typeof binary).not.toBe('string');
    expect(Array.from(new Uint8Array(typeof binary.arrayBuffer === 'function' ? await binary.arrayBuffer() : binary))).toEqual([0,255,128]);
    const next = await proxy('/ws', keyB, { headers: { Upgrade: 'websocket' } }); expect(next.headers.get('x-upstream')).toBe('b.example');
    next.webSocket!.accept();
    const closed = Promise.all([ws, next.webSocket!].map(socket => new Promise<void>(resolve => socket.addEventListener('close', () => resolve(), { once: true }))));
    next.webSocket!.close(1000, 'done'); ws.close(1000, 'done'); await closed;
    // Read a rejected Upgrade as HTTP, without Miniflare's auto-WebSocket client.
    const failed = await new Promise<{ status: number; body: string }>(async (resolve, reject) => {
      const local = new URL('/ws-fail', await mf.ready);
      const req = httpRequest(local, { headers: { Authorization: `Bearer ${keyA}`, Upgrade: 'websocket', Connection: 'Upgrade' } }, res => {
        let body = ''; res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body })); res.on('error', reject);
      });
      req.on('error', reject); req.end();
    });
    expect(failed.status).toBe(403); expect(failed.body).toBe('handshake refused');
  });
  it('all keys share selection; revocation updates this isolate without affecting other keys', async () => {
    for (const token of [keyA, keyB]) {
      const echo = await (await proxy('/v1/messages', token)).json() as any;
      expect(echo.url).toBe('https://b.example/v1/messages'); expect(echo.headers['x-api-key']).toBe('upstream-secret-B'); expect(echo.headers.authorization).toBeUndefined();
    }
    await admin(`/keys/${idA}`, 'DELETE'); expect((await proxy('/v1/messages', keyA)).status).toBe(401);
    expect((await proxy('/v1/messages', keyB)).status).toBe(200);
    expect((await admin('/config')).status).toBe(200);
  });
  it('a cache hit forwards without touching the D1 configuration table', async () => {
    expect((await proxy('/cached', keyB)).status).toBe(200);
    const db = await mf.getD1Database('DB', 'relay');
    await db.prepare('ALTER TABLE config RENAME TO config_offline').run();
    try { expect((await proxy('/cached', keyB)).status).toBe(200); }
    finally { await db.prepare('ALTER TABLE config_offline RENAME TO config').run(); }
  });
  it('optimistic SQL updates reject old versions and logout clears the cookie', async () => {
    const db = await mf.getD1Database('DB', 'relay');
    const row = await db.prepare('SELECT version FROM config WHERE id=1').first<{version:number}>();
    const result = await db.prepare('UPDATE config SET version=version+1 WHERE id=1 AND version=?').bind(row!.version - 1).run();
    expect(result.meta.changes).toBe(0);
    const response = await admin('/session', 'DELETE'); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
