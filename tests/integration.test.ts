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
  if (url.searchParams.getAll('fail').includes(url.hostname)) {
    await request.arrayBuffer();
    return new Response('failed at ' + url.hostname, {status:Number(url.searchParams.get('status') || '503'),headers:{'X-Upstream':url.hostname}});
  }
  if (url.pathname.endsWith('/models')) {
    const valid = url.hostname === 'a.example' ? request.headers.get('Authorization') === 'Bearer upstream-secret-A' : request.headers.get('x-api-key') === 'upstream-secret-B';
    return valid ? Response.json({data:[{id:'test-model'}]}) : new Response('unauthorized', {status:401});
  }
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
    return new Response(stream, {headers:{'Content-Type':'text/event-stream','X-Upstream':url.hostname}});
  }
  if (url.pathname.endsWith('/redirect')) return new Response('keep redirect', {status:307,headers:{Location:'https://never-follow.example/target'}});
  if (url.pathname.endsWith('/error')) return new Response(' {"error":{"nested":[1,2]}} ', {status:429,headers:{'X-Custom':'preserved'}});
  if (url.pathname.endsWith('/large')) {
    let size = 0; const reader = request.body.getReader();
    while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; }
    return Response.json({size,host:url.hostname});
  }
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
async function waitForFault(id: string) {
  // Fault persistence uses waitUntil and can finish after the client sees the error.
  await expect.poll(async () => (await value(await admin('/upstreams'))).find((u:any) => u.id === id).faultUntil).toBeGreaterThan(Date.now());
}
beforeAll(async () => {
  const bundled = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', target: 'es2022' });
  mf = new Miniflare({
    workers: [{ name: 'relay', modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-08-06', compatibilityFlags: ['enable_request_signal'],
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
    expect((await value(await admin('/config'))).upstreamCooldownSeconds).toBe(1800);
    expect((await proxy('/v1/messages', adminKey)).status).toBe(401);
  });
  it('creates independent forwarding keys without exposing hashes in listings', async () => {
    const a = await value(await admin('/keys', 'POST', { name: 'A' })); keyA = a.key; idA = a.id;
    keyB = (await value(await admin('/keys', 'POST', { name: 'B' }))).key;
    for (const token of [keyA, keyB]) {
      expect(token).toHaveLength(64);
      expect(token).toMatch(/^sk-[A-Za-z0-9_-]{61}$/);
    }
    expect(keyA).not.toBe(keyB);
    expect(a.keyPrefix).toBe(keyA.slice(0, 14));
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
  it('serves a combined management snapshot and leaves D1 unchanged on no-op saves', async () => {
    expect((await admin('/snapshot', 'GET', undefined, false)).status).toBe(401);
    const response = await admin('/snapshot');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const combined = await value(response);
    expect(combined).toEqual({
      config: await value(await admin('/config')),
      upstreams: await value(await admin('/upstreams')),
      keys: await value(await admin('/keys'))
    });
    expect(combined.config.cacheTtlSeconds).toBe(30);
    const db = await mf.getD1Database('DB', 'relay');
    const before = await db.prepare('SELECT version, config_json, updated_at FROM config WHERE id=1').first();
    expect((await admin('/active-upstream', 'PUT', { id: upstreamA })).status).toBe(200);
    expect((await admin(`/upstreams/${upstreamA}`, 'PATCH', {
      name: 'A', baseUrl: 'https://a.example/gateway', authType: 'bearer', key: ''
    })).status).toBe(200);
    expect((await admin(`/keys/${idA}`, 'PATCH', { upstreamIds: null })).status).toBe(200);
    expect(await db.prepare('SELECT version, config_json, updated_at FROM config WHERE id=1').first()).toEqual(before);
    expect(await value(await admin('/snapshot'))).toEqual(combined);
  });
  it('tests a stored upstream key without changing selection or configuration', async () => {
    const before = await value(await admin('/config'));
    const result = await value(await admin('/test-auth', 'POST', {id:upstreamA,baseUrl:'https://a.example/gateway',key:''}));
    expect(result.anonymousStatus).toBe(401);
    expect(result.results.map((r: any) => r.outcome)).toEqual(['available','rejected']);
    expect(JSON.stringify(result)).not.toContain('upstream-secret');
    expect(await value(await admin('/config'))).toEqual(before);
    const b = await value(await admin('/test-auth', 'POST', {baseUrl:'https://b.example',key:'upstream-secret-B'}));
    expect(b.results.map((r: any) => r.outcome)).toEqual(['rejected','available']);
  });
  it('protects auth testing with admin session, same origin and destination validation', async () => {
    expect((await admin('/test-auth','POST',{baseUrl:'https://a.example',key:'secret'},false)).status).toBe(401);
    const cross = await mf.dispatchFetch(origin+'/_relay/api/test-auth', {method:'POST',headers:{Cookie:cookie,Origin:'https://evil.example','Content-Type':'application/json'},body:JSON.stringify({baseUrl:'https://a.example',key:'secret'})});
    expect(cross.status).toBe(403);
    for (const target of ['https://relay.example','https://127.0.0.1','http://a.example']) expect((await admin('/test-auth','POST',{baseUrl:target,key:'secret'})).status).toBe(400);
    expect((await admin('/test-auth','POST',{id:upstreamA,baseUrl:'https://changed.example',key:''})).status).toBe(400);
    expect((await admin('/test-auth','POST',{id:'missing',baseUrl:'https://a.example',key:''})).status).toBe(404);
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
    const before = await value(await admin('/snapshot'));
    const redirect = await proxy('/redirect'); expect(redirect.status).toBe(307); expect(await redirect.text()).toBe('keep redirect');
    const error = await proxy('/error'); expect(error.status).toBe(429); expect(error.headers.get('x-custom')).toBe('preserved');
    expect(await error.text()).toBe(' {"error":{"nested":[1,2]}} ');
    expect((await proxy('/error')).status).toBe(429);
    expect(await value(await admin('/snapshot'))).toEqual(before);
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
    expect((await value(await proxy('/echo', keyB))).url).toBe('https://b.example/echo');
    expect((await value(await admin('/upstreams'))).find((u:any) => u.id === upstreamB).faultUntil).toBe(0);
  });
  it('routes bound keys independently with the correct URL and credentials, even without a default', async () => {
    const pinned = await value(await admin('/keys', 'POST', { name: 'Pinned B', upstreamId: upstreamB }));
    expect(pinned.upstreamIds).toEqual([upstreamB]); expect(pinned.keyHash).toBeUndefined();
    const updated = await value(await admin(`/keys/${idA}`, 'PATCH', { upstreamId: upstreamA }));
    expect(updated.upstreamIds).toEqual([upstreamA]); expect(updated.key).toBeUndefined(); expect(updated.keyHash).toBeUndefined();
    await value(await admin('/active-upstream', 'PUT', { id: null }));
    expect((await proxy('/echo', keyB)).status).toBe(409);
    for (const [token, url, header, credential, removed] of [
      [keyA, 'https://a.example/gateway/echo', 'authorization', 'Bearer upstream-secret-A', 'x-api-key'],
      [pinned.key, 'https://b.example/echo', 'x-api-key', 'upstream-secret-B', 'authorization']
    ]) {
      const echo = await value(await mf.dispatchFetch(`${origin}/echo`, { headers: { 'x-api-key': token } }));
      expect(echo.url).toBe(url); expect(echo.headers[header]).toBe(credential); expect(echo.headers[removed]).toBeUndefined();
    }
    expect((await value(await admin('/keys'))).find((k: any) => k.id === idA).upstreamIds).toEqual([upstreamA]);
    const deletion = await admin(`/upstreams/${upstreamA}`, 'DELETE');
    expect(deletion.status).toBe(409); expect((await deletion.json() as any).error.code).toBe('UPSTREAM_IN_USE');
    await value(await admin('/active-upstream', 'PUT', { id: upstreamB }));
    const stream = await proxy('/sse', keyA);
    expect(stream.headers.get('x-upstream')).toBe('a.example'); await stream.text();
    const socket = await proxy('/ws', keyA, { headers: { Upgrade: 'websocket' } });
    expect(socket.headers.get('x-upstream')).toBe('a.example'); socket.webSocket!.accept();
    await value(await admin(`/keys/${idA}`, 'PATCH', { upstreamId: upstreamB }));
    expect((await value(await proxy('/echo', keyA))).url).toBe('https://b.example/echo');
    const message = new Promise(resolve => socket.webSocket!.addEventListener('message', e => resolve(e.data), { once: true }));
    socket.webSocket!.send('still connected'); expect(await message).toBe('still connected');
    const closed = new Promise(resolve => socket.webSocket!.addEventListener('close', resolve, { once: true }));
    socket.webSocket!.close(1000, 'done'); await closed;
    await value(await admin(`/keys/${idA}`, 'PATCH', { upstreamId: null }));
    await value(await admin('/active-upstream', 'PUT', { id: upstreamA }));
    expect((await value(await proxy('/echo', keyA))).url).toBe('https://a.example/gateway/echo');
    expect((await value(await proxy('/echo', pinned.key))).url).toBe('https://b.example/echo');
    await value(await admin(`/keys/${pinned.id}`, 'DELETE'));
    expect((await proxy('/echo', pinned.key)).status).toBe(401);
    // A binding is the only thing preventing deletion once an upstream is not the default.
    const disposable = await value(await admin('/upstreams', 'POST', { name: 'Temporary', baseUrl: 'https://temp.example', authType: 'bearer', key: 'test-secret' }));
    await value(await admin(`/keys/${idA}`, 'PATCH', { upstreamId: disposable.id }));
    expect((await admin(`/upstreams/${disposable.id}`, 'DELETE')).status).toBe(409);
    await value(await admin(`/keys/${idA}`, 'PATCH', { upstreamId: null }));
    expect((await admin(`/upstreams/${disposable.id}`, 'DELETE')).status).toBe(200);
    await value(await admin('/active-upstream', 'PUT', { id: upstreamB }));
  });
  it('renames keys without changing their credentials or routes and updates name and routes atomically', async () => {
    const record = await value(await admin('/keys', 'POST', { name: 'Before rename', upstreamIds: [upstreamA, upstreamB] }));
    const db = await mf.getD1Database('DB', 'relay');
    const storedKey = async () => {
      const row = await db.prepare('SELECT config_json FROM config WHERE id=1').first<{config_json:string}>();
      return JSON.parse(row!.config_json).accessKeys.find((key: any) => key.id === record.id);
    };
    const before = await storedKey();
    const renamed = await value(await admin(`/keys/${record.id}`, 'PATCH', { name: '  我的电脑  ' }));
    expect(renamed.name).toBe('我的电脑');
    expect(await storedKey()).toEqual({ ...before, name: '我的电脑' });
    expect(await value(await admin(`/keys/${record.id}/reveal`, 'POST'))).toEqual({ key: record.key });
    expect((await value(await proxy('/echo', record.key))).url).toBe('https://a.example/gateway/echo');
    const configBeforeFailures = await value(await admin('/config'));
    for (const name of ['', '   ', 'x'.repeat(101), null, 42]) {
      expect((await admin(`/keys/${record.id}`, 'PATCH', { name, upstreamIds: [upstreamB] })).status).toBe(400);
    }
    expect((await admin(`/keys/${record.id}`, 'PATCH', { name: 'Must not persist', upstreamIds: ['missing'] })).status).toBe(404);
    expect(await value(await admin('/config'))).toEqual(configBeforeFailures);
    expect(await storedKey()).toEqual({ ...before, name: '我的电脑' });
    const updated = await value(await admin(`/keys/${record.id}`, 'PATCH', { name: '服务器', upstreamIds: [upstreamB, upstreamA] }));
    expect(updated).toMatchObject({ name: '服务器', upstreamIds: [upstreamB, upstreamA] });
    expect((await value(await admin('/keys'))).find((key: any) => key.id === record.id)).toEqual(updated);
    expect((await value(await proxy('/echo', record.key))).url).toBe('https://b.example/echo');
    await value(await admin(`/keys/${record.id}`, 'DELETE'));
  });
  it('rejects invalid bindings and unauthorized changes without altering configuration', async () => {
    const before = await value(await admin('/config'));
    const keys = await value(await admin('/keys'));
    for (const upstreamId of ['', 42, false, {}, [], 'missing']) {
      const status = upstreamId === 'missing' ? 404 : 400;
      expect((await admin('/keys', 'POST', { name: 'Invalid', upstreamId })).status).toBe(status);
      expect((await admin(`/keys/${idA}`, 'PATCH', { upstreamId })).status).toBe(status);
    }
    expect((await admin(`/keys/${idA}`, 'PATCH', {})).status).toBe(400);
    expect((await admin('/keys/missing', 'PATCH', { upstreamId: upstreamA })).status).toBe(404);
    expect((await admin(`/keys/${idA}`, 'PATCH', { upstreamId: upstreamA }, false)).status).toBe(401);
    const cross = await mf.dispatchFetch(`${origin}/_relay/api/keys/${idA}`, { method: 'PATCH', headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ upstreamId: upstreamA }) });
    expect(cross.status).toBe(403);
    expect(await value(await admin('/config'))).toEqual(before);
    expect(await value(await admin('/keys'))).toEqual(keys);
  });
  it('saves ordered routes, cools across client retries for HTTP/SSE/WebSocket, and protects referenced upstreams', async () => {
    const record = await value(await admin('/keys', 'POST', { name: 'Ordered', upstreamIds: [upstreamA, upstreamB] }));
    expect(record.upstreamIds).toEqual([upstreamA, upstreamB]);
    expect(record.encryptedKey).toBeUndefined(); expect(record.canReveal).toBe(true);
    expect((await value(await proxy('/echo', record.key))).url).toBe('https://a.example/gateway/echo');
    const bytes = Buffer.from([0, 255, 42, 13, 10, 128]);
    const first = await proxy('/echo?fail=a.example', record.key, {method:'POST',body:bytes});
    expect(first.status).toBe(503); expect(await first.text()).toBe('failed at a.example');
    const echo = await value(await proxy('/echo?fail=a.example', record.key, {method:'POST',body:bytes,headers:{'Content-Type':'application/octet-stream'}}));
    expect(echo.url).toBe('https://b.example/echo?fail=a.example'); expect(echo.bytes).toEqual([...bytes]);
    expect(echo.headers['x-api-key']).toBe('upstream-secret-B'); expect(echo.headers.authorization).toBeUndefined();
    const stream = await proxy('/sse?fail=a.example', record.key);
    expect(stream.headers.get('x-upstream')).toBe('b.example'); expect(await stream.text()).toContain('[DONE]');
    const ws = await proxy('/ws?fail=a.example', record.key, {headers:{Upgrade:'websocket'}});
    expect(ws.status).toBe(101); expect(ws.headers.get('x-upstream')).toBe('b.example'); ws.webSocket!.accept();
    const closed = new Promise(resolve => ws.webSocket!.addEventListener('close', resolve, {once:true}));
    ws.webSocket!.close(1000, 'done'); await closed;
    const last = await proxy('/echo?fail=a.example&fail=b.example', record.key);
    expect(last.status).toBe(503); expect(await last.text()).toBe('failed at b.example');
    await waitForFault(upstreamB);
    await value(await admin(`/keys/${record.id}`, 'PATCH', {upstreamIds:[upstreamB,upstreamA]}));
    const cooling = await proxy('/echo', record.key);
    expect(cooling.status).toBe(503); expect(Number(cooling.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await cooling.json() as any).error.code).toBe('UPSTREAMS_COOLING_DOWN');
    // Route and name edits retain health; new credentials reset only that upstream.
    await value(await admin(`/keys/${record.id}`, 'PATCH', {name:'Renamed while cooling'}));
    expect((await proxy('/echo', record.key)).status).toBe(503);
    await value(await admin(`/upstreams/${upstreamB}`, 'PATCH', {key:'upstream-secret-B'}));
    expect((await value(await proxy('/echo', record.key))).url).toBe('https://b.example/echo');
    await value(await admin(`/upstreams/${upstreamA}`, 'PATCH', {key:'upstream-secret-A'}));
    expect((await admin(`/upstreams/${upstreamA}`, 'DELETE')).status).toBe(409);
    expect((await value(await admin('/keys'))).find((k:any) => k.id === record.id).upstreamIds).toEqual([upstreamB,upstreamA]);
    const before = await value(await admin('/config'));
    for (const upstreamIds of [[], [upstreamA,upstreamA], [42], 'a', false, ['missing'], Array(101).fill(upstreamA)]) {
      const status = Array.isArray(upstreamIds) && upstreamIds[0] === 'missing' ? 404 : 400;
      expect((await admin('/keys','POST',{name:'invalid',upstreamIds})).status).toBe(status);
      expect((await admin(`/keys/${record.id}`,'PATCH',{upstreamIds})).status).toBe(status);
    }
    expect((await admin(`/keys/${record.id}`,'PATCH',{upstreamId:upstreamA,upstreamIds:[upstreamB]})).status).toBe(400);
    expect(await value(await admin('/config'))).toEqual(before);
    await value(await admin(`/keys/${record.id}`, 'DELETE'));
  });
  it('streams requests larger than 8 MiB with multiple configured upstreams', async () => {
    const record = await value(await admin('/keys', 'POST', { name: 'Large upload', upstreamIds: [upstreamA, upstreamB] }));
    const size = 9 * 1024 * 1024 + 17;
    let remaining = size;
    const body = new ReadableStream({pull(controller) {
      const length = Math.min(64 * 1024, remaining);
      controller.enqueue(new Uint8Array(length)); remaining -= length;
      if (!remaining) controller.close();
    }});
    expect(await value(await proxy('/large', record.key, {method:'POST',body,duplex:'half'}))).toEqual({size,host:'a.example'});
    await value(await admin(`/keys/${record.id}`, 'DELETE'));
  });
  it('reveals the same key only to same-origin admins and never exposes ciphertext or plaintext in lists', async () => {
    const before = await value(await admin('/config'));
    for (let i = 0; i < 2; i++) {
      const response = await admin(`/keys/${idA}/reveal`, 'POST');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await value(response)).toEqual({key:keyA});
    }
    expect(await value(await admin('/config'))).toEqual(before);
    const listing = await value(await admin('/keys'));
    expect(listing[0].canReveal).toBe(true);
    for (const record of listing) {
      for (const field of ['key', 'keyHash', 'encryptedKey', 'keyCiphertext', 'keyIv']) expect(record[field]).toBeUndefined();
    }
    expect((await admin(`/keys/${idA}/reveal`, 'POST', undefined, false)).status).toBe(401);
    expect((await admin(`/keys/${idA}/reveal`)).status).toBe(404);
    expect((await admin('/keys/missing/reveal', 'POST')).status).toBe(404);
    const cross = await mf.dispatchFetch(`${origin}/_relay/api/keys/${idA}/reveal`, {method:'POST',headers:{Cookie:cookie,Origin:'https://evil.example'}});
    expect(cross.status).toBe(403);
    const db = await mf.getD1Database('DB', 'relay');
    const row = await db.prepare('SELECT config_json FROM config WHERE id=1').first<{config_json:string}>();
    expect(row!.config_json).not.toContain(keyA);
    const stored = JSON.parse(row!.config_json);
    expect(stored.accessKeys.find((k:any) => k.id === idA).encryptedKey.keyCiphertext).toBeTruthy();
    // A pre-upgrade key has only a digest; its routing still works after upgrade.
    const legacy = stored.accessKeys.find((k:any) => k.id === idA); delete legacy.encryptedKey;
    delete legacy.upstreamIds; legacy.upstreamId = upstreamA;
    // The following management save must make a real change to publish this
    // externally edited fixture; no-op saves no longer refresh proxy caches.
    stored.activeUpstreamId = null;
    await db.prepare('UPDATE config SET config_json=?,version=version+1 WHERE id=1').bind(JSON.stringify(stored)).run();
    expect((await value(await admin('/keys'))).find((k:any) => k.id === idA)).toMatchObject({canReveal:false,upstreamIds:[upstreamA]});
    const unavailable = await admin(`/keys/${idA}/reveal`, 'POST');
    expect(unavailable.status).toBe(409); expect((await unavailable.json() as any).error.code).toBe('KEY_NOT_RECOVERABLE');
    await value(await admin('/active-upstream','PUT',{id:upstreamB}));
    expect((await value(await proxy('/echo',keyA))).url).toBe('https://a.example/gateway/echo');
    await value(await admin(`/keys/${idA}`,'PATCH',{upstreamIds:null}));
  });
  it('unbound keys follow the default; revocation updates this isolate without affecting other keys', async () => {
    for (const token of [keyA, keyB]) {
      const echo = await (await proxy('/v1/messages', token)).json() as any;
      expect(echo.url).toBe('https://b.example/v1/messages'); expect(echo.headers['x-api-key']).toBe('upstream-secret-B'); expect(echo.headers.authorization).toBeUndefined();
    }
    await admin(`/keys/${idA}`, 'DELETE'); expect((await proxy('/v1/messages', keyA)).status).toBe(401);
    expect((await admin(`/keys/${idA}/reveal`, 'POST')).status).toBe(404);
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
  it('persists faults and lets only same-origin admins clear them, including already clear states', async () => {
    const ordered = await value(await admin('/keys', 'POST', {name:'Recovery', upstreamIds:[upstreamB, upstreamA]}));
    const path = `/upstreams/${upstreamB}/clear-fault`;
    expect((await admin(path, 'POST', undefined, false)).status).toBe(401);
    expect((await mf.dispatchFetch(origin + '/_relay/api' + path, {
      method: 'POST', headers: {Cookie: cookie, Origin: 'https://evil.example'}
    })).status).toBe(403);
    expect((await admin(path)).status).toBe(404);
    expect((await admin('/upstreams/missing/clear-fault', 'POST')).status).toBe(404);
    const failed = await proxy('/echo?fail=b.example', ordered.key);
    expect(failed.status).toBe(503); expect(await failed.text()).toBe('failed at b.example');
    const findB = async () => (await value(await admin('/upstreams'))).find((u:any) => u.id === upstreamB);
    await expect.poll(async () => (await findB()).faultUntil).toBeGreaterThan(Date.now());
    const marked = await findB();
    expect(marked.faultUntil - Date.now()).toBeGreaterThan(1_798_000);
    expect(marked.faultReason).toBe('HTTP 503');
    expect((await value(await proxy('/echo', ordered.key))).url).toBe('https://a.example/gateway/echo');
    // The default route bypasses shared faults without clearing or extending them.
    expect((await value(await proxy('/echo', keyB))).url).toBe('https://b.example/echo');
    expect(await (await proxy('/echo?fail=b.example', keyB)).text()).toBe('failed at b.example');
    expect(await findB()).toEqual(marked);
    expect(await value(await admin(`/keys/${ordered.id}`, 'PATCH', {failoverEnabled:false})))
      .toMatchObject({upstreamIds:[upstreamB, upstreamA], failoverEnabled:false});
    expect((await value(await proxy('/echo', ordered.key))).url).toBe('https://b.example/echo');
    expect(await (await proxy('/echo?fail=b.example', ordered.key)).text()).toBe('failed at b.example');
    expect(await findB()).toEqual(marked);
    await value(await admin(`/keys/${ordered.id}`, 'PATCH', {failoverEnabled:true}));
    expect((await value(await proxy('/echo', ordered.key))).url).toBe('https://a.example/gateway/echo');
    const cleared = await value(await admin(path, 'POST'));
    expect(cleared).toMatchObject({healthRevision: marked.healthRevision + 1, faultUntil: 0, faultReason: null});
    expect((await value(await proxy('/echo', ordered.key))).url).toBe('https://b.example/echo');
    const before = await value(await admin('/config'));
    expect((await value(await admin(path, 'POST'))).healthRevision).toBe(cleared.healthRevision + 1);
    expect((await value(await admin('/config'))).version).toBe(before.version + 1);
    await value(await admin(`/keys/${ordered.id}`, 'DELETE'));
  });
  it('optimistic SQL updates reject old versions and logout clears the cookie', async () => {
    const db = await mf.getD1Database('DB', 'relay');
    const row = await db.prepare('SELECT version FROM config WHERE id=1').first<{version:number}>();
    const result = await db.prepare('UPDATE config SET version=version+1 WHERE id=1 AND version=?').bind(row!.version - 1).run();
    expect(result.meta.changes).toBe(0);
    const response = await admin('/session', 'DELETE'); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
