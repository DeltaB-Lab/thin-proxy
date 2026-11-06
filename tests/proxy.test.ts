import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCache, type ConfigCache } from '../src/cache';
import { encryptKey, hash } from '../src/crypto';
import { proxy } from '../src/proxy';
import { snapshot } from '../src/storage';
import type { Env, Snapshot, Upstream } from '../src/types';

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
  env.DB = { prepare: vi.fn(() => { throw new Error('Unexpected database operation'); }) } as unknown as D1Database;
  state = snapshot(1, { activeUpstreamId: 'c', upstreams, accessKeys: [{ id: 'key', name: 'test', keyPrefix: 'relay_a', createdAt: '', keyHash, upstreamId: 'a' }] });
  vi.mocked(getCache).mockReturnValue({ get: async () => state } as ConfigCache);
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
    state.config.accessKeys[0].upstreamId = null;
    state.config.activeUpstreamId = null;
    await expect(proxy(request(options), env)).rejects.toMatchObject({status:403, code:'KEY_DISABLED'});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps other keys usable and restores access with the same token', async () => {
    const stopped = state.config.accessKeys[0]; stopped.enabled = false;
    const otherToken = 'relay_' + 'b'.repeat(43);
    const otherHash = await hash(otherToken);
    state = snapshot(2, {...state.config, accessKeys:[stopped, {...stopped, id:'other', keyHash:otherHash, enabled:true}]});
    fetchMock.mockImplementation(async () => new Response('ok'));
    await expect(proxy(request(), env)).rejects.toMatchObject({status:403, code:'KEY_DISABLED'});
    expect(await (await proxy(request({headers:{Authorization:'Bearer ' + otherToken}}), env)).text()).toBe('ok');
    state.config.accessKeys[0].enabled = true;
    expect(await (await proxy(request(), env)).text()).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('single upstream forwarding', () => {
  it.each([401,403,408,429,500,502,503,504,599])('returns status %i unchanged without changing routes or writing configuration', async status => {
    const failed = new Response('original failure', {status,headers:{'Retry-After':'7','X-Upstream':'a'}});
    fetchMock.mockResolvedValueOnce(failed).mockResolvedValueOnce(new Response('next'));
    expect(await proxy(request(), env)).toBe(failed);
    expect(env.DB.prepare).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await failed.text()).toBe('original failure'); expect(failed.headers.get('Retry-After')).toBe('7');
    expect(await (await proxy(request(), env)).text()).toBe('next');
    expect(fetchMock.mock.calls.map(call => new URL(call[0]).hostname)).toEqual(['a.example','a.example']);
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
    } finally {
      vi.useRealTimers();
    }
  });
  it('returns 504 on a header timeout, then retries only the same upstream on a new request', async () => {
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise<Response>((_resolve,reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')), {once:true});
    })).mockResolvedValueOnce(new Response('next'));
    const timedEnv = {...env,UPSTREAM_TIMEOUT_SECONDS:'0.01'};
    await expect(proxy(request(), timedEnv)).rejects.toMatchObject({status:504,code:'UPSTREAM_TIMEOUT'});
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(await (await proxy(request(), timedEnv)).text()).toBe('next');
    expect(new URL(fetchMock.mock.calls[1][0]).hostname).toBe('a.example');
  });
  it('does not expose connection errors, switch routes or record failures', async () => {
    fetchMock.mockRejectedValue(new Error('secret-a'));
    for (let i = 0; i < 4; i++) await expect(proxy(request(), env)).rejects.toMatchObject({status:502,message:'上游连接失败'});
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.every(call => new URL(call[0]).hostname === 'a.example')).toBe(true);
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });
  it('aborts with the client and keeps later requests independent', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => { controller.abort(); throw new Error('cancelled'); }).mockResolvedValueOnce(new Response('ok'));
    await expect(proxy(request({signal:controller.signal}), env)).rejects.toMatchObject({status:499});
    expect(await (await proxy(request(), env)).text()).toBe('ok');
    expect(fetchMock.mock.calls.map(call => new URL(call[0]).hostname)).toEqual(['a.example','a.example']);
  });
  it('does not restart or time out an accepted response stream', async () => {
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
  it('does not pre-read or cap request streams above 8 MiB', async () => {
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
  it('uses the single binding or the configured default', async () => {
    state.config.accessKeys[0].upstreamId = 'b';
    fetchMock.mockResolvedValue(new Response('ok'));
    await proxy(request(),env);
    state.config.accessKeys[0].upstreamId = null;
    await proxy(request(),env);
    expect(fetchMock.mock.calls.map(call => new URL(call[0]).hostname)).toEqual(['b.example','c.example']);
  });
});
