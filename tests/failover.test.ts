import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCache, type ConfigCache } from '../src/cache';
import { encryptKey, hash } from '../src/crypto';
import { proxy } from '../src/proxy';
import { recordUpstreamFault, snapshot } from '../src/storage';
import type { Env, Snapshot, Upstream } from '../src/types';

vi.mock('../src/storage', async importOriginal => ({...await importOriginal<typeof import('../src/storage')>(), recordUpstreamFault: vi.fn(async () => null)}));
vi.mock('../src/cache', () => ({ getCache: vi.fn() }));
const token = `relay_${'a'.repeat(43)}`;
const env = { UPSTREAM_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString('base64') } as Env;
let upstreams: Upstream[];
let keyHash: string;
let state: Snapshot;
const fetchMock = vi.fn();
function request(options: RequestInit = {}) {
  return new Request('https://relay.example/v1/messages?x=1&x=2', {
    ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers }
  });
}
beforeAll(async () => {
  keyHash = await hash(token);
  upstreams = await Promise.all(['a', 'b', 'c'].map(async id => ({
    id, name: id, baseUrl: `https://${id}.example/gateway`, authType: id === 'b' ? 'x-api-key' as const : 'bearer' as const,
    ...await encryptKey(env, id, `secret-${id}`)
  })));
});
beforeEach(() => {
  env.DB = {} as D1Database;
  state = snapshot(1, { activeUpstreamId: 'c', upstreams, accessKeys: [{ id: 'key', name: 'test', keyPrefix: 'relay_a', createdAt: '', keyHash, upstreamIds: ['a','b','c'], failoverEnabled: true }] });
  vi.mocked(getCache).mockReturnValue({ get: async () => state } as ConfigCache);
  vi.mocked(recordUpstreamFault).mockReset().mockResolvedValue(null);
  fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('key service status', () => {
  it.each([
    {},
    {method:'POST', body:'stream request', headers:{Accept:'text/event-stream'}},
    {headers:{Upgrade:'websocket', Connection:'Upgrade'}}
  ])('rejects stopped keys before routing or contacting any upstream: %j', async options => {
    state.config.accessKeys[0].enabled = false;
    state.config.accessKeys[0].upstreamIds = null;
    state.config.activeUpstreamId = null;
    await expect(proxy(request(options), env)).rejects.toMatchObject({status:403, code:'KEY_DISABLED'});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordUpstreamFault).not.toHaveBeenCalled();
  });

  it('keeps other keys usable and restores access with the same token', async () => {
    const stopped = state.config.accessKeys[0]; stopped.enabled = false;
    const otherToken = 'relay_' + 'b'.repeat(43);
    const otherHash = await hash(otherToken);
    state = snapshot(2, {...state.config, accessKeys:[stopped, {...stopped, id:'other', keyHash:otherHash, enabled:true}]});
    fetchMock.mockImplementation(async () => new Response('ok'));
    await expect(proxy(request(), env)).rejects.toMatchObject({status:403, code:'KEY_DISABLED'});
    expect(await (await proxy(request({headers:{Authorization:'Bearer ' + otherToken}}), env)).text()).toBe('ok');
    stopped.enabled = true;
    expect(await (await proxy(request(), env)).text()).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('ordered upstream cooldown', () => {
  const catalogRequest = () => new Request('https://relay.example/backend-api/codex/models?client_version=test', { headers: { Authorization: `Bearer ${token}` } });
  it('uses each selected upstream catalog and credentials, including bound and default routes', async () => {
    state.config.upstreams = upstreams.map(u => ({ ...u, modelCatalogUrl: `https://catalog-${u.id}.example/list` }));
    fetchMock.mockImplementation(async () => new Response('ok'));
    await proxy(catalogRequest(), env);
    fetchMock.mockResolvedValueOnce(new Response('failed', { status: 503 }));
    await proxy(request(), env); // Conversation failure moves subsequent catalog requests to B.
    await proxy(catalogRequest(), env);
    state.config.accessKeys[0].upstreamIds = ['a'];
    await proxy(catalogRequest(), env);
    state.config.accessKeys[0].upstreamIds = null;
    await proxy(catalogRequest(), env);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      'https://catalog-a.example/list?client_version=test', 'https://a.example/gateway/v1/messages?x=1&x=2',
      'https://catalog-b.example/list?client_version=test', 'https://catalog-a.example/list?client_version=test',
      'https://catalog-c.example/list?client_version=test'
    ]);
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer secret-a');
    const bHeaders = new Headers(fetchMock.mock.calls[2][1].headers);
    expect(bHeaders.get('x-api-key')).toBe('secret-b'); expect(bHeaders.has('Authorization')).toBe(false);
    expect(recordUpstreamFault).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('does not cool conversation routes after catalog HTTP, connection or timeout failures (override=%s)', async override => {
    if (override) state.config.upstreams = upstreams.map(u => ({ ...u, modelCatalogUrl: `https://catalog-${u.id}.example/list` }));
    const response = new Response('catalog unauthorized', { status: 401, headers: { 'X-Catalog': 'original' } });
    fetchMock.mockResolvedValueOnce(response).mockRejectedValueOnce(new Error('connection refused'))
      .mockImplementationOnce((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })).mockResolvedValueOnce(new Response('conversation ok'));
    expect(await proxy(catalogRequest(), env)).toBe(response);
    await expect(proxy(catalogRequest(), env)).rejects.toMatchObject({ status: 502 });
    await expect(proxy(catalogRequest(), { ...env, UPSTREAM_TIMEOUT_SECONDS: '0.01' })).rejects.toMatchObject({ status: 504 });
    expect(await (await proxy(request(), env)).text()).toBe('conversation ok');
    expect(new URL(fetchMock.mock.calls[3][0]).hostname).toBe('a.example');
    expect(fetchMock).toHaveBeenCalledTimes(4); expect(recordUpstreamFault).not.toHaveBeenCalled();
  });
  it('rejects a runtime catalog loop before forwarding credentials', async () => {
    state.config.upstreams = upstreams.map(u => ({ ...u, modelCatalogUrl: 'https://relay.example/backend-api/codex/models' }));
    await expect(proxy(catalogRequest(), env)).rejects.toMatchObject({ status: 502, code: 'PROXY_LOOP' });
    expect(fetchMock).not.toHaveBeenCalled(); expect(recordUpstreamFault).not.toHaveBeenCalled();
  });
  it.each(['single', 'legacy', 'default', 'disabled-multi'] as const)('bypasses persisted faults and never reports direct-route failures: %s', async mode => {
    const key = state.config.accessKeys[0];
    state.config.activeUpstreamId = 'a';
    if (mode === 'legacy') { delete key.upstreamIds; key.upstreamId = 'a'; }
    else key.upstreamIds = mode === 'single' ? ['a'] : mode === 'disabled-multi' ? ['a','b','c'] : null;
    if (mode === 'disabled-multi') key.failoverEnabled = false;
    state.config.upstreams = upstreams.map(u => ({...u, healthRevision: 4, faultUntil: Date.now() + 1_800_000, faultReason: 'HTTP 503'}));
    const before = structuredClone(state.config);
    const waitUntil = vi.fn();
    const response = new Response('original failure', {status:503, headers:{'Retry-After':'7'}});
    fetchMock.mockResolvedValueOnce(response).mockRejectedValueOnce(new Error('connection refused'))
      .mockImplementationOnce((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('aborted')), {once:true});
      })).mockResolvedValueOnce(new Response('ok'));
    // Cooldown configuration is irrelevant to direct routes, including legacy/default bindings.
    const directEnv = {...env, UPSTREAM_COOLDOWN_SECONDS:'unused', UPSTREAM_TIMEOUT_SECONDS:'0.01'};
    expect(await proxy(request(), directEnv, {waitUntil})).toBe(response);
    await expect(proxy(request(), directEnv, {waitUntil})).rejects.toMatchObject({status:502, code:'UPSTREAM_UNAVAILABLE'});
    await expect(proxy(request(), directEnv, {waitUntil})).rejects.toMatchObject({status:504, code:'UPSTREAM_TIMEOUT'});
    expect(await (await proxy(request(), directEnv, {waitUntil})).text()).toBe('ok');
    expect(fetchMock.mock.calls.map(call => new URL(call[0]).hostname)).toEqual(['a.example','a.example','a.example','a.example']);
    expect(recordUpstreamFault).not.toHaveBeenCalled(); expect(waitUntil).not.toHaveBeenCalled();
    expect(state.config).toEqual(before);
  });
  it('preserves failover for older multi-upstream records without the new flag', async () => {
    delete state.config.accessKeys[0].failoverEnabled;
    fetchMock.mockResolvedValueOnce(new Response('failed', {status:503})).mockResolvedValueOnce(new Response('backup'));
    await proxy(request(), env); await proxy(request(), env);
    expect(fetchMock.mock.calls.map(call => new URL(call[0]).hostname)).toEqual(['a.example','b.example']);
    expect(recordUpstreamFault).toHaveBeenCalledTimes(1);
  });
  it('isolates direct requests from local failover health on the same upstream', async () => {
    const orderedKey = state.config.accessKeys[0];
    const directToken = `relay_${'b'.repeat(43)}`;
    const directHash = await hash(directToken);
    const directKey = {...orderedKey, id:'direct', keyHash:directHash, upstreamIds:['a']};
    state.config.accessKeys.push(directKey); state.keysByHash.set(directHash, directKey);
    const directRequest = () => request({headers:{Authorization:`Bearer ${directToken}`}});
    fetchMock.mockResolvedValueOnce(new Response('direct failure', {status:503})).mockResolvedValueOnce(new Response('ok'))
      .mockResolvedValueOnce(new Response('failover failure', {status:503})).mockResolvedValueOnce(new Response('direct success'))
      .mockResolvedValueOnce(new Response('direct failure', {status:429})).mockResolvedValueOnce(new Response('backup'));
    await proxy(directRequest(), env);
    await proxy(request(), env); // A direct failure must not make failover skip A.
    expect(recordUpstreamFault).not.toHaveBeenCalled();
    await proxy(request(), env); // The failover request now marks A locally.
    await proxy(directRequest(), env); // Direct success must not clear that mark.
    await proxy(directRequest(), env); // Direct failure must not report or extend it.
    expect(await (await proxy(request(), env)).text()).toBe('backup');
    expect(fetchMock.mock.calls.map(call => new URL(call[0]).hostname)).toEqual(['a.example','a.example','a.example','a.example','a.example','b.example']);
    expect(recordUpstreamFault).toHaveBeenCalledTimes(1);
  });
  it('coalesces concurrent failure reports and silently ignores zero matched rows', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pending: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => pending.push(resolve)));
    try {
      const requests = [proxy(request(), env), proxy(request(), env)];
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      pending.forEach(resolve => resolve(new Response('original', {status:503})));
      const responses = await Promise.all(requests);
      expect(responses.map(response => response.status)).toEqual([503,503]);
      expect(recordUpstreamFault).toHaveBeenCalledTimes(1);
      expect(recordUpstreamFault).toHaveBeenCalledWith(env, 'a', 0, 1800, 'HTTP 503');
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it('keeps the original error and local cooldown when D1 fails, logging no secrets', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(recordUpstreamFault).mockRejectedValueOnce(new Error('private database details'));
    fetchMock.mockResolvedValueOnce(new Response('original error', {status:429})).mockResolvedValueOnce(new Response('next'));
    try {
      expect(await (await proxy(request(), env)).text()).toBe('original error');
      expect(await (await proxy(request(), env)).text()).toBe('next');
      expect(new URL(fetchMock.mock.calls[1][0]).hostname).toBe('b.example');
      expect(log).toHaveBeenCalledExactlyOnceWith('UPSTREAM_FAULT_PERSIST_FAILED', {upstreamId:'a'});
    } finally { log.mockRestore(); }
  });
  it('uses waitUntil to persist without delaying the upstream response', async () => {
    let complete!: (value: null) => void;
    vi.mocked(recordUpstreamFault).mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    fetchMock.mockResolvedValueOnce(new Response('original', {status:503}));
    const waitUntil = vi.fn();
    const response = await proxy(request(), env, {waitUntil});
    expect(response.status).toBe(503); expect(waitUntil).toHaveBeenCalledTimes(1);
    complete(null); await waitUntil.mock.calls[0][0];
  });
  it('attempts once per request, skips cooling upstreams, and rebuilds URL and credentials for each client retry', async () => {
    const prefixes: Record<string, string> = { a: '/v1', b: '/gateway', c: '/gateway/v1/' };
    state.config.upstreams = upstreams.map(upstream => ({ ...upstream, baseUrl: `https://${upstream.id}.example${prefixes[upstream.id]}` }));
    const calls: string[] = [];
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const id = new URL(url).hostname[0]; calls.push(id);
      expect(url).toBe(`https://${id}.example${id === 'a' ? '' : '/gateway'}/v1/messages?x=1&x=2`);
      const headers = new Headers(init.headers);
      expect(headers.get(id === 'b' ? 'x-api-key' : 'Authorization')).toBe(id === 'b' ? 'secret-b' : `Bearer secret-${id}`);
      expect(headers.has(id === 'b' ? 'Authorization' : 'x-api-key')).toBe(false);
      expect(init.redirect).toBe('manual');
      if (id === 'a') throw new Error('connection refused');
      return new Response(id, {status:id === 'b' ? 503 : 200});
    });
    await expect(proxy(request(), env)).rejects.toMatchObject({status:502});
    expect(await (await proxy(request(), env)).text()).toBe('b');
    expect(await (await proxy(request(), env)).text()).toBe('c');
    expect(await (await proxy(request(), env)).text()).toBe('c');
    expect(calls).toEqual(['a','b','c','c']);
  });
  it.each([401,403,408,429,500,502,503,504,599])('returns status %i unchanged and cools it for the next request', async status => {
    const failed = new Response('original failure', {status,headers:{'Retry-After':'7','X-Upstream':'a'}});
    fetchMock.mockResolvedValueOnce(failed).mockResolvedValueOnce(new Response('next'));
    expect(await proxy(request(), env)).toBe(failed);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await failed.text()).toBe('original failure'); expect(failed.headers.get('Retry-After')).toBe('7');
    expect(await (await proxy(request(), env)).text()).toBe('next');
    expect(fetchMock.mock.calls.map(call => new URL(call[0]).hostname)).toEqual(['a.example','b.example']);
  });
  it.each([200,400,404,422,307])('keeps status %i eligible on subsequent requests', async status => {
    const response = new Response('original', {status}); fetchMock.mockResolvedValue(response);
    expect(await proxy(request(), env)).toBe(response);
    expect(await proxy(request(), env)).toBe(response);
    expect(fetchMock.mock.calls.map(call => new URL(call[0]).hostname)).toEqual(['a.example','a.example']);
  });
  it.each([
    ['application/json', Buffer.from(' { "nested" : [1, null, "中文"] }\n')],
    ['application/octet-stream', Buffer.from([0,255,13,10,128])],
    ['multipart/form-data; boundary=x', Buffer.from('--x\r\nContent-Disposition: form-data; name="a"\r\n\r\nb\r\n--x--\r\n')]
  ])('forwards the original %s stream and preserves failed response bytes', async (contentType, bytes) => {
    const original = request({method:'POST',body:bytes,headers:{'Content-Type':contentType}});
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      expect(init.body).toBe(original.body);
      expect([...new Uint8Array(await new Response(init.body).arrayBuffer())]).toEqual([...bytes]);
      expect(new Headers(init.headers).get('Content-Type')).toBe(contentType);
      return new Response('failed', {status:503});
    });
    expect(await (await proxy(original, env)).text()).toBe('failed'); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, '300'])('waits beyond 90 seconds and aborts at 300 seconds (timeout=%s)', async timeout => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      state.config.accessKeys[0].failoverEnabled = false;
      let started!: () => void;
      const forwarding = new Promise<void>(resolve => { started = resolve; });
      fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        started();
      }));
      const result = proxy(request(), { ...env, UPSTREAM_TIMEOUT_SECONDS: timeout }).catch(error => error);
      await forwarding;
      const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
      await vi.advanceTimersByTimeAsync(90_000);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(209_999);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({ status: 504, code: 'UPSTREAM_TIMEOUT' });
      expect(signal.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(recordUpstreamFault).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it('returns 504 on a header timeout, then selects the next upstream on a new request', async () => {
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise<Response>((_resolve,reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')), {once:true});
    })).mockResolvedValueOnce(new Response('next'));
    const timedEnv = {...env,UPSTREAM_TIMEOUT_SECONDS:'0.01'};
    await expect(proxy(request(), timedEnv)).rejects.toMatchObject({status:504,code:'UPSTREAM_TIMEOUT'});
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(await (await proxy(request(), timedEnv)).text()).toBe('next');
    expect(new URL(fetchMock.mock.calls[1][0]).hostname).toBe('b.example');
  });
  it('returns 502 without exposing connection errors and rejects all-cooling requests without fetching', async () => {
    fetchMock.mockRejectedValue(new Error('secret-a'));
    for (let i = 0; i < 3; i++) await expect(proxy(request(), env)).rejects.toMatchObject({status:502,message:'上游连接失败'});
    await expect(proxy(request(), env)).rejects.toMatchObject({status:503,code:'UPSTREAMS_COOLING_DOWN',headers:{'Retry-After':'1800'}});
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('does not penalize the upstream after client cancellation', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => { controller.abort(); throw new Error('cancelled'); }).mockResolvedValueOnce(new Response('ok'));
    await expect(proxy(request({signal:controller.signal}), env)).rejects.toMatchObject({status:499});
    expect(await (await proxy(request(), env)).text()).toBe('ok');
    expect(fetchMock.mock.calls.map(call => new URL(call[0]).hostname)).toEqual(['a.example','a.example']);
  });
  it('does not restart or cool after an accepted response stream fails or its former header deadline passes', async () => {
    let streamController!: ReadableStreamDefaultController;
    const response = new Response(new ReadableStream({start(controller) {streamController = controller; controller.enqueue(new TextEncoder().encode('data: first\n\n'));}}), {headers:{'Content-Type':'text/event-stream'}});
    fetchMock.mockResolvedValueOnce(response).mockResolvedValueOnce(new Response('ok'));
    const result = await proxy(request(), {...env,UPSTREAM_TIMEOUT_SECONDS:'0.01'});
    const reader = result.body!.getReader(); expect((await reader.read()).done).toBe(false);
    await new Promise(resolve => setTimeout(resolve,25));
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    streamController.error(new Error('stream broken'));
    await expect(reader.read()).rejects.toThrow('stream broken'); expect(fetchMock).toHaveBeenCalledTimes(1);
    await proxy(request(), env); expect(new URL(fetchMock.mock.calls[1][0]).hostname).toBe('a.example');
  });
  it('does not pre-read or cap multi-upstream request streams above 8 MiB', async () => {
    let pulls = 0;
    const size = 9 * 1024 * 1024;
    const source = new ReadableStream({pull(controller) { pulls++; controller.enqueue(new Uint8Array(size)); controller.close(); }}, {highWaterMark:0});
    const original = request({method:'POST',body:source,duplex:'half'} as RequestInit);
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      expect(pulls).toBe(0); expect(init.body).toBe(original.body);
      expect((await new Response(init.body).arrayBuffer()).byteLength).toBe(size);
      return new Response('ok');
    });
    expect(await (await proxy(original,env)).text()).toBe('ok'); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('only uses explicitly selected routes or the configured default', async () => {
    state.config.accessKeys[0].upstreamIds = ['b'];
    fetchMock.mockResolvedValue(new Response('ok'));
    await proxy(request(),env);
    state.config.accessKeys[0].upstreamIds = null;
    await proxy(request(),env);
    expect(fetchMock.mock.calls.map(call => new URL(call[0]).hostname)).toEqual(['b.example','c.example']);
  });
  it('honors the configured cooldown and resumes the first upstream after expiry', async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const configured = {...env,UPSTREAM_COOLDOWN_SECONDS:'300'};
      fetchMock.mockResolvedValueOnce(new Response('failed', {status:503})).mockImplementation(async () => new Response('ok'));
      await proxy(request(),configured);
      now += 180_000; await proxy(request(),configured);
      now += 120_000; await proxy(request(),configured);
      await proxy(request(),configured);
      expect(fetchMock.mock.calls.map(call => new URL(call[0]).hostname)).toEqual(['a.example','b.example','a.example','a.example']);
    } finally { clock.mockRestore(); }
  });
});
