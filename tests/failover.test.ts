import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCache, type ConfigCache } from '../src/cache';
import { encryptKey, hash } from '../src/crypto';
import { proxy } from '../src/proxy';
import { MAX_REPLAY_BYTES, replayBody } from '../src/replay-body';
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
  state = snapshot(1, { activeUpstreamId: 'c', upstreams, accessKeys: [{ id: 'key', name: 'test', keyPrefix: 'relay_a', createdAt: '', keyHash, upstreamIds: ['a','b','c'] }] });
  vi.mocked(getCache).mockReturnValue({ get: async () => state } as ConfigCache);
  fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('ordered upstream failover', () => {
  it('tries each upstream in order, replaces credentials, and restarts from the first on each request', async () => {
    const prefixes: Record<string, string> = { a: '/v1', b: '/gateway', c: '/gateway/v1/' };
    state.config.upstreams = upstreams.map(upstream => ({ ...upstream, baseUrl: `https://${upstream.id}.example${prefixes[upstream.id]}` }));
    const calls: string[] = [];
    const cancelled = vi.fn();
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const id = new URL(url).hostname[0]; calls.push(id);
      expect(url).toBe(`https://${id}.example${id === 'a' ? '' : '/gateway'}/v1/messages?x=1&x=2`);
      const headers = new Headers(init.headers);
      expect(headers.get(id === 'b' ? 'x-api-key' : 'Authorization')).toBe(id === 'b' ? 'secret-b' : `Bearer secret-${id}`);
      expect(headers.has(id === 'b' ? 'Authorization' : 'x-api-key')).toBe(false);
      expect(init.redirect).toBe('manual');
      if (id === 'a') throw new Error('connection refused');
      if (id === 'b') return new Response(new ReadableStream({cancel:cancelled}), {status:503});
      return new Response('ok');
    });
    expect(await (await proxy(request(), env)).text()).toBe('ok');
    expect(await (await proxy(request(), env)).text()).toBe('ok');
    expect(calls).toEqual(['a','b','c','a','b','c']); expect(cancelled).toHaveBeenCalledTimes(2);
  });
  it.each([401,403,408,429,500,502,503,504])('fails over status %i before returning a response', async status => {
    fetchMock.mockResolvedValueOnce(new Response('failure', {status})).mockResolvedValueOnce(new Response('next'));
    expect(await (await proxy(request(), env)).text()).toBe('next'); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([200,400,404,422,307])('returns status %i directly without trying a later upstream', async status => {
    const response = new Response('original', {status}); fetchMock.mockResolvedValue(response);
    expect(await proxy(request(), env)).toBe(response); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['application/json', Buffer.from(' { "nested" : [1, null, "中文"] }\n')],
    ['application/octet-stream', Buffer.from([0,255,13,10,128])],
    ['multipart/form-data; boundary=x', Buffer.from('--x\r\nContent-Disposition: form-data; name="a"\r\n\r\nb\r\n--x--\r\n')]
  ])('replays exactly the same %s bytes after each failure', async (contentType, bytes) => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      expect([...new Uint8Array(await new Response(init.body).arrayBuffer())]).toEqual([...bytes]);
      expect(new Headers(init.headers).get('Content-Type')).toBe(contentType);
      return new Response('failed', {status:503});
    });
    const response = await proxy(request({method:'POST',body:bytes,headers:{'Content-Type':contentType}}), env);
    expect(response.status).toBe(503); expect(await response.text()).toBe('failed'); expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('cancels header timeouts, tries the next upstream, and returns 504 when all time out', async () => {
    const hang = (_url: string, init: RequestInit) => new Promise<Response>((_resolve,reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')), {once:true});
    });
    fetchMock.mockImplementationOnce(hang).mockResolvedValueOnce(new Response('next'));
    const timedEnv = {...env,UPSTREAM_TIMEOUT_SECONDS:'0.01'};
    expect(await (await proxy(request(), timedEnv)).text()).toBe('next');
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    fetchMock.mockReset().mockImplementation(hang);
    await expect(proxy(request(), timedEnv)).rejects.toMatchObject({status:504,code:'UPSTREAM_TIMEOUT'});
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('returns 502 after exhausting connection failures without exposing errors', async () => {
    fetchMock.mockRejectedValue(new Error('secret-a'));
    await expect(proxy(request(), env)).rejects.toMatchObject({status:502,message:'上游连接失败'});
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('never fails over after the client cancels', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => { controller.abort(); throw new Error('cancelled'); });
    await expect(proxy(request({signal:controller.signal}), env)).rejects.toMatchObject({status:499});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('does not restart after an accepted response stream fails or its former header deadline passes', async () => {
    let streamController!: ReadableStreamDefaultController;
    const response = new Response(new ReadableStream({start(controller) {streamController = controller; controller.enqueue(new TextEncoder().encode('data: first\n\n'));}}), {headers:{'Content-Type':'text/event-stream'}});
    fetchMock.mockResolvedValue(response);
    const result = await proxy(request(), {...env,UPSTREAM_TIMEOUT_SECONDS:'0.01'});
    const reader = result.body!.getReader(); expect((await reader.read()).done).toBe(false);
    await new Promise(resolve => setTimeout(resolve,25));
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    streamController.error(new Error('stream broken'));
    await expect(reader.read()).rejects.toThrow('stream broken'); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('only uses explicitly selected routes and keeps single-upstream bodies streaming', async () => {
    state.config.accessKeys[0].upstreamIds = ['b'];
    const original = request({method:'POST',body:new Uint8Array(MAX_REPLAY_BYTES + 1)});
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      expect(init.body).toBe(original.body); return new Response('last', {status:503});
    });
    expect((await proxy(original,env)).status).toBe(503); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized replay bodies before sending to any upstream', async () => {
    await expect(proxy(request({method:'POST',body:new Uint8Array(MAX_REPLAY_BYTES+1)}),env)).rejects.toMatchObject({status:413});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('bounded raw request replay', () => {
  it('accepts the exact limit and reconstructs arbitrarily split bytes', async () => {
    const bytes = new Uint8Array(MAX_REPLAY_BYTES); bytes[0] = 255; bytes[65_535] = 17; bytes[bytes.length-1] = 128;
    const source = new ReadableStream({start(controller) {
      controller.enqueue(bytes.subarray(0,1)); controller.enqueue(new Uint8Array());
      controller.enqueue(bytes.subarray(1,65_538)); controller.enqueue(bytes.subarray(65_538)); controller.close();
    }});
    const incoming = new Request('https://relay.example', {method:'POST',body:source,duplex:'half'} as RequestInit);
    const body = await replayBody(incoming);
    for (let i=0;i<2;i++) expect(Buffer.from(await new Response(body()).arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
  });
  it('cancels a pending body read when the client disconnects', async () => {
    const controller = new AbortController(); const cancel = vi.fn();
    const incoming = new Request('https://relay.example',{method:'POST',body:new ReadableStream({cancel}),signal:controller.signal,duplex:'half'} as RequestInit);
    const pending = replayBody(incoming); controller.abort();
    await expect(pending).rejects.toMatchObject({status:499}); expect(cancel).toHaveBeenCalledTimes(1);
  });
});
